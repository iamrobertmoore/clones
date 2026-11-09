//! Play one night in town with real transactions and record everything that happened.
//!
//! The clones decide with the policies in `clones-core`; the market contract clears every order.
//! Before anything runs, `clones_core::simulate` gives the answer key for the seed, and the log
//! carries both, so anyone can check that the chain did exactly what the rules say.

use clones_core::{self as rules, Entrant, Outcome, Temperament, View};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Finality, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Network, Worker};
use serde::Serialize;
use serde_json::json;

/// The seed the README, the tests and the replay page use.
pub const DEMO_SEED: u64 = 853;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    CloneCreated {
        clone: String,
        temperament: Temperament,
        tx: String,
    },
    SentIn {
        clone: String,
        stake: u64,
        tx: String,
    },
    Hour {
        round: u32,
        prices: [u64; 5],
    },
    Bubble {
        round: u32,
        clone: String,
        say: String,
    },
    Order {
        round: u32,
        clone: String,
        good: String,
        side: rules::Side,
        qty: u32,
        price: u64,
        tx: String,
    },
    OrderFailed {
        round: u32,
        clone: String,
        error: String,
    },
    WithdrawRefused {
        clone: String,
        error: String,
    },
    Settled {
        clone: String,
        paid_out: u64,
        broke: bool,
        tx: String,
    },
    Merged {
        clone: String,
        tx: String,
        clone_deleted: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct NightLog {
    pub seed: u64,
    pub network: String,
    pub market: String,
    pub player: String,
    pub rounds: u32,
    pub goods: Vec<String>,
    /// Computed off chain before the night starts.
    pub answer_key: Vec<Outcome>,
    /// What the chain actually did, in the same shape as the answer key.
    pub outcomes: Vec<Outcome>,
    pub events: Vec<Event>,
    /// Player balance before sending the clones and after merging them, in milliNEAR.
    pub player_balance_before: u64,
    pub player_balance_after: u64,
}

const MILLI: u128 = 1_000_000_000_000_000_000_000;

fn milli(t: NearToken) -> u64 {
    (t.as_yoctonear() / MILLI) as u64
}

fn tx_hash(out: &near_workspaces::result::ExecutionFinalResult) -> String {
    out.outcome().transaction_hash.to_string()
}

/// Re-run an RPC call while the node says we are over its rate limit. A rate-limited request is
/// refused before a transaction is accepted, so retrying cannot run a transaction twice.
macro_rules! retry {
    ($e:expr) => {{
        let mut wait = std::time::Duration::from_millis(500);
        let mut attempt = 0;
        loop {
            match $e {
                Err(err)
                    if attempt < 8 && format!("{err:?}").to_lowercase().contains("rate limit") =>
                {
                    attempt += 1;
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(std::time::Duration::from_secs(20));
                }
                other => break other,
            }
        }
    }};
}

async fn account_exists<T: Network + 'static>(
    worker: &Worker<T>,
    id: &AccountId,
) -> anyhow::Result<bool> {
    match retry!(worker.view_account(id).await) {
        Ok(_) => Ok(true),
        Err(e)
            if format!("{e:?}").contains("UnknownAccount")
                || format!("{e:?}").contains("does not exist") =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}

async fn clone_view(market: &Contract, id: &AccountId) -> anyhow::Result<serde_json::Value> {
    Ok(retry!(
        market
            .view("get_clone")
            .args_json(json!({ "clone_id": id }))
            .finality(Finality::Optimistic)
            .await
    )?
    .json()?)
}

/// Read the town, waiting until it reports `round`. RPC nodes can lag a block or two behind the
/// transaction that just rang the hour.
async fn town_at(market: &Contract, round: u32) -> anyhow::Result<serde_json::Value> {
    for _ in 0..40 {
        let town: serde_json::Value =
            retry!(market.view("get_town").finality(Finality::Optimistic).await)?.json()?;
        if town["round"] == round {
            return Ok(town);
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
    anyhow::bail!("the town never reached hour {round}")
}

/// Read a clone, waiting until the chain shows every order we have placed for it.
async fn settled_view(
    market: &Contract,
    id: &AccountId,
    orders_placed: u32,
) -> anyhow::Result<serde_json::Value> {
    for _ in 0..40 {
        let v = clone_view(market, id).await?;
        if v["orders_placed"] == orders_placed {
            return Ok(v);
        }
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
    }
    anyhow::bail!("{id} never showed {orders_placed} orders")
}

fn ledger_of(v: &serde_json::Value) -> anyhow::Result<rules::Ledger> {
    Ok(serde_json::from_value(
        json!({ "cash": v["cash"], "stock": v["stock"] }),
    )?)
}

/// One clone's turn: look, decide, place each order. Returns the events.
async fn take_turn(
    market: &Contract,
    c: &Seat,
    round: u32,
    prices: [u64; 5],
    prev: [u64; 5],
    orders_so_far: u32,
) -> anyhow::Result<Vec<Event>> {
    let name = c.entrant.name.clone();
    let ledger =
        ledger_of(&settled_view(market, c.account.id(), c.orders_before + orders_so_far).await?)?;
    let decision = rules::decide(
        c.entrant.temperament,
        &View {
            round,
            prices,
            prev,
            ledger,
            stake: c.entrant.stake,
        },
    );
    let mut events = vec![Event::Bubble {
        round,
        clone: name.clone(),
        say: decision.say,
    }];
    for i in decision.intents {
        let out = retry!(
            c.account
                .call(market.id(), "place_order")
                .args_json(json!({
                    "good": rules::GOODS[i.good],
                    "side": i.side,
                    "qty": i.qty,
                    "price": i.limit,
                }))
                .gas(Gas::from_tgas(30))
                .transact()
                .await
        );
        match out {
            Ok(o) if o.is_success() => events.push(Event::Order {
                round,
                clone: name.clone(),
                good: rules::GOODS[i.good].to_string(),
                side: i.side,
                qty: i.qty,
                price: prices[i.good],
                tx: tx_hash(&o),
            }),
            Ok(o) => events.push(Event::OrderFailed {
                round,
                clone: name.clone(),
                error: format!("{:?}", o.into_result().err()),
            }),
            Err(e) => events.push(Event::OrderFailed {
                round,
                clone: name.clone(),
                error: format!("{e:?}"),
            }),
        }
    }
    Ok(events)
}

/// Compile both contracts with cargo-near.
pub async fn contracts() -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let market = near_workspaces::compile_project(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contracts/market"
    ))
    .await?;
    let leash = near_workspaces::compile_project(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contracts/leash"
    ))
    .await?;
    Ok((market, leash))
}

/// One clone in town and the key that signs for it (a function-call key for the market only).
pub struct Seat {
    pub entrant: Entrant,
    pub account: Account,
    /// Orders it had already placed when this night started (0 for a fresh clone).
    pub orders_before: u32,
}

/// A player and the clones they sent into town tonight.
pub struct Guest {
    pub player: Account,
    pub seats: Vec<Seat>,
    pub events: Vec<Event>,
    pub balance_before: u64,
}

/// Create one clone per entrant under `player` (its only key: `clone_key`, or a fresh one each)
/// and send it into town with its stake.
pub async fn enlist<T: Network + 'static>(
    worker: &Worker<T>,
    market: &Contract,
    player: Account,
    leash_wasm: &[u8],
    entrants: &[Entrant],
    clone_balance: NearToken,
    clone_key: Option<SecretKey>,
) -> anyhow::Result<Guest> {
    let balance_before = milli(retry!(worker.view_account(player.id()).await)?.balance);
    let mut events = Vec::new();
    let mut seats = Vec::new();
    for e in entrants {
        let id: AccountId = format!("{}.{}", e.name, player.id()).parse()?;
        let key = clone_key
            .clone()
            .unwrap_or_else(|| SecretKey::from_random(KeyType::ED25519));
        let out = retry!(
            player
                .batch(&id)
                .create_account()
                .transfer(clone_balance)
                .add_key(
                    key.public_key(),
                    AccessKey::function_call_access(
                        market.id(),
                        &["place_order"],
                        Some(NearToken::from_near(1)),
                    ),
                )
                .deploy(leash_wasm)
                .transact()
                .await
        )?;
        events.push(Event::CloneCreated {
            clone: e.name.clone(),
            temperament: e.temperament,
            tx: tx_hash(&out),
        });
        out.into_result()?;

        let out = retry!(
            player
                .call(market.id(), "register_clone")
                .args_json(json!({ "clone_id": id, "temperament": e.temperament }))
                .deposit(NearToken::from_millinear(e.stake as u128))
                .transact()
                .await
        )?;
        events.push(Event::SentIn {
            clone: e.name.clone(),
            stake: e.stake,
            tx: tx_hash(&out),
        });
        out.into_result()?;
        seats.push(Seat {
            entrant: e.clone(),
            account: Account::from_secret_key(id, key, worker),
            orders_before: 0,
        });
    }
    Ok(Guest {
        player,
        seats,
        events,
        balance_before,
    })
}

/// Play one whole night on a fresh local sandbox.
pub async fn run_sandbox_night(seed: u64) -> anyhow::Result<NightLog> {
    let worker: Worker<Sandbox> = near_workspaces::sandbox().await?;
    let (market_wasm, leash_wasm) = contracts().await?;
    let market = worker.dev_deploy(&market_wasm).await?;
    market
        .call("new")
        .args_json(json!({ "seed": seed.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let player = worker
        .root_account()?
        .create_subaccount("player")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let keeper = market.as_account().clone();
    play_night(
        &worker,
        "sandbox",
        &market,
        &keeper,
        &player,
        &leash_wasm,
        seed,
        NearToken::from_near(1),
    )
    .await
}

/// One player, the three standard clones, one night (the market must already be at `seed`).
#[allow(clippy::too_many_arguments)]
pub async fn play_night<T: Network + 'static>(
    worker: &Worker<T>,
    network: &str,
    market: &Contract,
    keeper: &Account,
    player: &Account,
    leash_wasm: &[u8],
    seed: u64,
    clone_balance: NearToken,
) -> anyhow::Result<NightLog> {
    let guest = enlist(
        worker,
        market,
        player.clone(),
        leash_wasm,
        &rules::standard_entrants(),
        clone_balance,
        None,
    )
    .await?;
    let mut logs = run_night(
        worker,
        network,
        market,
        keeper,
        vec![guest],
        seed,
        false,
        None,
    )
    .await?;
    Ok(logs.remove(0))
}

/// Play one night for every guest in town at once: twelve hours of trading (all clones act in
/// parallel each hour), then dawn: a broke clone's refused withdrawal, settle, merge. Returns one
/// log per guest. With `open`, the keeper first opens a new night at `seed`. With `sweep_to`,
/// each guest's balance (less 0.05 NEAR) is sent there after the merge.
#[allow(clippy::too_many_arguments)]
pub async fn run_night<T: Network + 'static>(
    worker: &Worker<T>,
    network: &str,
    market: &Contract,
    keeper: &Account,
    mut guests: Vec<Guest>,
    seed: u64,
    open: bool,
    sweep_to: Option<&AccountId>,
) -> anyhow::Result<Vec<NightLog>> {
    if open {
        retry!(
            keeper
                .call(market.id(), "open_night")
                .args_json(json!({ "seed": seed.to_string() }))
                .transact()
                .await
        )?
        .into_result()?;
    }
    let town = town_at(market, 0).await?;
    anyhow::ensure!(
        town["seed"].as_str().and_then(|v| v.parse::<u64>().ok()) == Some(seed),
        "the town is at seed {}, not {seed}",
        town["seed"]
    );

    let seats: Vec<(usize, usize)> = guests
        .iter()
        .enumerate()
        .flat_map(|(g, guest)| (0..guest.seats.len()).map(move |s| (g, s)))
        .collect();
    let mut orders: Vec<Vec<u32>> = guests.iter().map(|g| vec![0; g.seats.len()]).collect();

    let mut prev: Option<[u64; 5]> = None;
    for round in 0..=rules::ROUNDS {
        let town = town_at(market, round).await?;
        let prices: [u64; 5] = serde_json::from_value(town["prices"].clone())?;
        for g in guests.iter_mut() {
            g.events.push(Event::Hour { round, prices });
        }
        if round == rules::ROUNDS {
            break;
        }
        let turns = seats.iter().map(|&(g, s)| {
            let seat = &guests[g].seats[s];
            take_turn(
                market,
                seat,
                round,
                prices,
                prev.unwrap_or(prices),
                orders[g][s],
            )
        });
        let results = futures::future::join_all(turns).await;
        for (&(g, s), turn) in seats.iter().zip(results) {
            let turn = turn?;
            orders[g][s] += turn
                .iter()
                .filter(|e| matches!(e, Event::Order { .. }))
                .count() as u32;
            guests[g].events.extend(turn);
        }
        retry!(keeper.call(market.id(), "advance_round").transact().await)?.into_result()?;
        prev = Some(prices);
    }

    // Dawn. A broke clone tries to take what is left home itself. The chain refuses.
    for &(g, s) in &seats {
        let seat = &guests[g].seats[s];
        let v = settled_view(market, seat.account.id(), seat.orders_before + orders[g][s]).await?;
        if v["broke"] != true {
            continue;
        }
        let name = seat.entrant.name.clone();
        let player_id = guests[g].player.id().clone();
        let attempt = retry!(
            seat.account
                .transfer_near(&player_id, NearToken::from_millinear(100))
                .await
        );
        let error = match attempt {
            Ok(_) => anyhow::bail!("{name} withdrew; the leash failed"),
            Err(e) if !format!("{e:?}").contains("InvalidAccessKeyError") => {
                anyhow::bail!("withdrawal failed for an unexpected reason: {e:?}")
            }
            Err(e) => format!("{e:?}"),
        };
        let ev = &mut guests[g].events;
        ev.push(Event::Bubble {
            round: rules::ROUNDS,
            clone: name.clone(),
            say: "I'm broke. I'll just take what's left on my account and run.".into(),
        });
        ev.push(Event::WithdrawRefused { clone: name, error });
    }

    // Settle and merge, each guest's clones in turn, guests in parallel.
    let homecomings = guests.iter().enumerate().map(|(g, guest)| {
        let orders = orders[g].clone();
        async move {
            let mut events = Vec::new();
            let mut outcomes = Vec::new();
            for (s, seat) in guest.seats.iter().enumerate() {
                let (paid_out, broke, tx) =
                    settle(market, &guest.player, seat.account.id()).await?;
                events.push(Event::Settled {
                    clone: seat.entrant.name.clone(),
                    paid_out,
                    broke,
                    tx,
                });
                outcomes.push(Outcome {
                    name: seat.entrant.name.clone(),
                    temperament: seat.entrant.temperament,
                    stake: seat.entrant.stake,
                    final_cash: paid_out,
                    broke,
                    orders: orders[s],
                });
                let out = retry!(
                    guest
                        .player
                        .call(seat.account.id(), "merge")
                        .gas(Gas::from_tgas(100))
                        .transact()
                        .await
                )?;
                let tx = tx_hash(&out);
                out.into_result()?;
                events.push(Event::Merged {
                    clone: seat.entrant.name.clone(),
                    tx,
                    clone_deleted: !account_exists(worker, seat.account.id()).await?,
                });
            }
            if let Some(to) = sweep_to {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let bal = retry!(worker.view_account(guest.player.id()).await)?.balance;
                let send = bal.saturating_sub(NearToken::from_millinear(50));
                if !send.is_zero() {
                    retry!(guest.player.transfer_near(to, send).await)?.into_result()?;
                }
            }
            let after = milli(retry!(worker.view_account(guest.player.id()).await)?.balance);
            anyhow::Ok((events, outcomes, after))
        }
    });
    let done = futures::future::join_all(homecomings).await;

    let mut logs = Vec::new();
    for (guest, result) in guests.into_iter().zip(done) {
        let (events, outcomes, after) = result?;
        let entrants: Vec<Entrant> = guest.seats.iter().map(|s| s.entrant.clone()).collect();
        let mut all = guest.events;
        all.extend(events);
        logs.push(NightLog {
            seed,
            network: network.into(),
            market: market.id().to_string(),
            player: guest.player.id().to_string(),
            rounds: rules::ROUNDS,
            goods: rules::GOODS.iter().map(|g| g.to_string()).collect(),
            answer_key: rules::simulate(seed, &entrants),
            outcomes,
            events: all,
            player_balance_before: guest.balance_before,
            player_balance_after: after,
        });
    }
    Ok(logs)
}

/// Settle one clone. Returns (paid out in mNEAR, broke, tx hash) read from the market's log line.
async fn settle(
    market: &Contract,
    player: &Account,
    clone: &AccountId,
) -> anyhow::Result<(u64, bool, String)> {
    let out = retry!(
        player
            .call(market.id(), "settle")
            .args_json(json!({ "clone_id": clone }))
            .transact()
            .await
    )?;
    let tx = tx_hash(&out);
    let logs: Vec<String> = out.logs().iter().map(|s| s.to_string()).collect();
    out.into_result()?;
    let line = logs
        .iter()
        .find(|l| l.starts_with("settled"))
        .ok_or_else(|| anyhow::anyhow!("settle did not log"))?;
    let paid_out: u64 = line
        .split("paid out ")
        .nth(1)
        .and_then(|s| s.split(' ').next())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("unreadable settle log: {line}"))?;
    Ok((paid_out, line.ends_with(", broke"), tx))
}
