//! Play one night in town with real transactions and record everything that happened.
//!
//! The clones decide with the policies in `clones-core`; the market contract clears every order.
//! Before anything runs, `clones_core::simulate` gives the answer key for the seed, and the log
//! carries both, so anyone can check that the chain did exactly what the rules say.

use clones_core::{self as rules, Book, Entrant, Outcome, Stock, Temperament, View};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Finality, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Network, Worker};
use serde::Serialize;
use serde_json::json;

/// The seed the README, the tests and the replay page use.
pub const DEMO_SEED: u64 = 606;

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
    /// The night number and the merchant's stock at dusk (what the answer key starts from).
    pub night: u32,
    pub dusk_stock: Stock,
    /// The merchant's stock as each hour began, 0 (dusk) to ROUNDS (dawn).
    pub stock: Vec<Stock>,
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
                    if attempt < 15 && format!("{err:?}").to_lowercase().contains("rate limit") =>
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

/// One clone's turn: look, decide, send the whole turn as one `trade` call. Returns the events and
/// whether the turn cleared.
async fn take_turn(
    market: &Contract,
    c: &Seat,
    round: u32,
    book: Book,
    prev: [u64; 5],
    orders_so_far: u32,
) -> anyhow::Result<(Vec<Event>, u32)> {
    let name = c.entrant.name.clone();
    let ledger =
        ledger_of(&settled_view(market, c.account.id(), c.orders_before + orders_so_far).await?)?;
    let decision = rules::decide(
        c.entrant.temperament,
        &View {
            round,
            book,
            prices: book.board(),
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
    if decision.intents.is_empty() {
        return Ok((events, 0));
    }
    let orders: Vec<serde_json::Value> = decision
        .intents
        .iter()
        .map(|i| {
            json!({
                "good": rules::GOODS[i.good],
                "side": i.side,
                "qty": i.qty,
                "price": i.limit,
            })
        })
        .collect();
    let out = retry!(
        c.account
            .call(market.id(), "trade")
            .args_json(json!({ "round": round, "orders": orders }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await
    );
    match out {
        Ok(o) if o.is_success() => {
            let tx = tx_hash(&o);
            for i in &decision.intents {
                events.push(Event::Order {
                    round,
                    clone: name.clone(),
                    good: rules::GOODS[i.good].to_string(),
                    side: i.side,
                    qty: i.qty,
                    price: book.quote(i.good, i.side, i.qty),
                    tx: tx.clone(),
                });
            }
            Ok((events, decision.intents.len() as u32))
        }
        Ok(o) => {
            events.push(Event::OrderFailed {
                round,
                clone: name,
                error: format!("{:?}", o.into_result().err()),
            });
            Ok((events, 0))
        }
        Err(e) => {
            events.push(Event::OrderFailed {
                round,
                clone: name,
                error: format!("{e:?}"),
            });
            Ok((events, 0))
        }
    }
}

/// Compile both contracts with cargo-near.
///
/// With `MARKET_WASM` and `LEASH_WASM` set, those files are used instead: the wasm from
/// `cargo near build reproducible-wasm`, which anyone can rebuild and compare with the chain.
pub async fn contracts() -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    if let (Ok(m), Ok(l)) = (std::env::var("MARKET_WASM"), std::env::var("LEASH_WASM")) {
        return Ok((std::fs::read(m)?, std::fs::read(l)?));
    }
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
                        &["trade"],
                        Some(NearToken::from_near(1)),
                    ),
                )
                .deploy(leash_wasm)
                .call(
                    near_workspaces::operations::Function::new("bind")
                        .args(market.id().as_bytes().to_vec()),
                )
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
                .args_json(
                    json!({ "clone_id": id, "temperament": e.temperament, "nights": e.nights })
                )
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
        .args_json(json!({ "seed": "0" }))
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

/// One player, the three standard clones, one night (the keeper opens it at `seed`).
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
        true,
        None,
    )
    .await?;
    Ok(logs.remove(0))
}

/// Play one night for every guest in town at once: twelve hours of trading (all clones act in
/// parallel each hour), then dawn: a broke clone's refused withdrawal, then settle and merge for
/// every clone that is due home (its last night, or broke). Returns one log per guest. With
/// `open`, the keeper first opens the next night at `seed`. With `sweep_to`, each guest's balance
/// (less 0.05 NEAR) is sent there once none of its clones is left in town.
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
        let town: serde_json::Value =
            retry!(market.view("get_town").finality(Finality::Optimistic).await)?.json()?;
        let next = town["night"].as_u64().unwrap_or_default() + 1;
        retry!(
            keeper
                .call(market.id(), "open_night")
                .args_json(json!({ "seed": seed.to_string(), "night": next }))
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
    let night = town["night"].as_u64().unwrap_or_default() as u32;
    let dusk_stock: Stock = serde_json::from_value(town["hour_stock"].clone())?;

    let seats: Vec<(usize, usize)> = guests
        .iter()
        .enumerate()
        .flat_map(|(g, guest)| (0..guest.seats.len()).map(move |s| (g, s)))
        .collect();
    // The answer key is for the whole town: every clone's trades move the merchant for everyone.
    // Named by full account id, so the crown's tie-break matches the contract's.
    let town_entrants: Vec<Entrant> = seats
        .iter()
        .map(|&(g, s)| {
            let seat = &guests[g].seats[s];
            Entrant {
                name: seat.account.id().to_string(),
                ..seat.entrant.clone()
            }
        })
        .collect();
    let key = rules::simulate_town(seed, dusk_stock, &town_entrants);
    let mut orders: Vec<Vec<u32>> = guests.iter().map(|g| vec![0; g.seats.len()]).collect();

    let mut prev: Option<[u64; 5]> = None;
    let mut stocks = Vec::new();
    for round in 0..=rules::ROUNDS {
        let town = town_at(market, round).await?;
        let prices: [u64; 5] = serde_json::from_value(town["prices"].clone())?;
        let hour_stock: Stock = serde_json::from_value(town["hour_stock"].clone())?;
        stocks.push(hour_stock);
        for g in guests.iter_mut() {
            g.events.push(Event::Hour { round, prices });
        }
        if round == rules::ROUNDS {
            break;
        }
        let book = Book::at(seed, round, hour_stock);
        let turns = seats.iter().map(|&(g, s)| {
            let seat = &guests[g].seats[s];
            take_turn(
                market,
                seat,
                round,
                book,
                prev.unwrap_or(prices),
                orders[g][s],
            )
        });
        let results = futures::future::join_all(turns).await;
        for (&(g, s), turn) in seats.iter().zip(results) {
            // One clone's trouble (an RPC error, a stale read) never stops the night for others.
            let (events, placed) = turn.unwrap_or_else(|e| {
                (
                    vec![Event::OrderFailed {
                        round,
                        clone: guests[g].seats[s].entrant.name.clone(),
                        error: format!("{e:#}"),
                    }],
                    0,
                )
            });
            orders[g][s] += placed;
            guests[g].events.extend(events);
        }
        retry!(
            keeper
                .call(market.id(), "advance_round")
                .args_json(json!({ "round": round }))
                .transact()
                .await
        )?
        .into_result()?;
        prev = Some(prices);
    }

    // Dawn. Who won the crown (the night's fees, to the best return)?
    let dawn_town = town_at(market, rules::ROUNDS).await?;
    let crowned: Option<(String, u64)> = dawn_town["crowned"]
        .as_array()
        .filter(|c| c.get(2).and_then(|n| n.as_u64()) == Some(night as u64))
        .map(|c| {
            (
                c[0].as_str().unwrap_or_default().to_string(),
                c[1].as_u64().unwrap_or_default(),
            )
        });
    let crown_of = |id: &AccountId| match &crowned {
        Some((c, pot)) if c == id.as_str() => *pot,
        _ => 0,
    };

    // Read every clone; a broke clone tries to take what is left home itself. The chain refuses.
    let mut views = std::collections::HashMap::new();
    for &(g, s) in &seats {
        let seat = &guests[g].seats[s];
        let v = settled_view(market, seat.account.id(), seat.orders_before + orders[g][s]).await?;
        views.insert((g, s), v.clone());
        if v["broke"] != true {
            continue;
        }
        let name = seat.entrant.name.clone();
        let player_id = guests[g].player.id().clone();
        let attempt = retry!(
            seat.account
                .transfer_near(&player_id, NearToken::from_millinear(10))
                .await
        );
        let error = match attempt {
            Ok(_) => anyhow::bail!("{name} withdrew; the leash failed"),
            Err(e) if !format!("{e:?}").contains("InvalidAccessKeyError") => {
                eprintln!("{name}: withdrawal attempt failed for another reason: {e:?}");
                continue;
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

    // Settle and merge the clones that are due home, each guest's in turn, guests in parallel.
    let homecomings = guests.iter().enumerate().map(|(g, guest)| {
        let orders = orders[g].clone();
        let views = &views;
        let crown_of = &crown_of;
        async move {
            let mut events = Vec::new();
            let mut outcomes = Vec::new();
            let mut stayed = 0;
            for (s, seat) in guest.seats.iter().enumerate() {
                let v = &views[&(g, s)];
                if v["due_home"] != true {
                    stayed += 1;
                    let worth = v["worth"].as_u64().unwrap_or_default();
                    outcomes.push(Outcome {
                        name: seat.entrant.name.clone(),
                        temperament: seat.entrant.temperament,
                        stake: seat.entrant.stake,
                        final_cash: worth,
                        broke: v["broke"] == true,
                        orders: orders[s],
                        home: false,
                        crown: crown_of(seat.account.id()),
                    });
                    continue;
                }
                let (paid_out, broke, tx) =
                    settle(market, &guest.player, seat.account.id()).await?;
                let tx_of_settle = tx.clone();
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
                    home: true,
                    crown: crown_of(seat.account.id()),
                });
                // The market merges a bound clone home right after paying it out; merge here only
                // if it is still there.
                let tx = if account_exists(worker, seat.account.id()).await? {
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
                    tx
                } else {
                    tx_of_settle.clone()
                };
                events.push(Event::Merged {
                    clone: seat.entrant.name.clone(),
                    tx,
                    clone_deleted: !account_exists(worker, seat.account.id()).await?,
                });
            }
            if let (Some(to), 0) = (sweep_to, stayed) {
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
    let mut failures = Vec::new();
    let mut k = 0;
    for (guest, result) in guests.into_iter().zip(done) {
        let n = guest.seats.len();
        let answer_key: Vec<Outcome> = key.outcomes[k..k + n]
            .iter()
            .zip(&guest.seats)
            .map(|(o, seat)| Outcome {
                name: seat.entrant.name.clone(),
                ..o.clone()
            })
            .collect();
        k += n;
        let (events, outcomes, after) = match result {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("{}: {e:#}", guest.player.id()));
                continue;
            }
        };
        let mut all = guest.events;
        all.extend(events);
        logs.push(NightLog {
            seed,
            network: network.into(),
            market: market.id().to_string(),
            player: guest.player.id().to_string(),
            rounds: rules::ROUNDS,
            goods: rules::GOODS.iter().map(|g| g.to_string()).collect(),
            answer_key,
            outcomes,
            events: all,
            player_balance_before: guest.balance_before,
            player_balance_after: after,
            night,
            dusk_stock,
            stock: stocks.clone(),
        });
    }
    for f in &failures {
        eprintln!("could not bring every clone home for {f}");
    }
    anyhow::ensure!(
        !logs.is_empty() || failures.is_empty(),
        "no guest got home: {failures:?}"
    );
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
            .gas(near_workspaces::types::Gas::from_tgas(100))
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
