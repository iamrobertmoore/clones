//! Play one night in town with real transactions and record everything that happened.
//!
//! The clones decide with the policies in `clones-core`; the market contract clears every order.
//! Before anything runs, `clones_core::simulate` gives the answer key for the seed, and the log
//! carries both, so anyone can check that the chain did exactly what the rules say.

use clones_core::{self as rules, Entrant, Outcome, Temperament, View};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
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

struct Clone {
    entrant: Entrant,
    account: Account,
}

async fn clone_view(market: &Contract, id: &AccountId) -> anyhow::Result<serde_json::Value> {
    Ok(market
        .view("get_clone")
        .args_json(json!({ "clone_id": id }))
        .await?
        .json()?)
}

fn ledger_of(v: &serde_json::Value) -> anyhow::Result<rules::Ledger> {
    Ok(serde_json::from_value(
        json!({ "cash": v["cash"], "stock": v["stock"] }),
    )?)
}

/// One clone's turn: look, decide, place each order. Returns the events.
async fn take_turn(
    market: &Contract,
    c: &Clone,
    round: u32,
    prices: [u64; 5],
    prev: [u64; 5],
) -> anyhow::Result<Vec<Event>> {
    let name = c.entrant.name.clone();
    let ledger = ledger_of(&clone_view(market, c.account.id()).await?)?;
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
        let out = c
            .account
            .call(market.id(), "place_order")
            .args_json(json!({
                "good": rules::GOODS[i.good],
                "side": i.side,
                "qty": i.qty,
                "price": i.limit,
            }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await;
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

/// Play one whole night on a fresh local sandbox.
pub async fn run_sandbox_night(seed: u64) -> anyhow::Result<NightLog> {
    let entrants = rules::standard_entrants();
    let answer_key = rules::simulate(seed, &entrants);

    let worker: Worker<Sandbox> = near_workspaces::sandbox().await?;
    let market_wasm = near_workspaces::compile_project(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contracts/market"
    ))
    .await?;
    let leash_wasm = near_workspaces::compile_project(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../contracts/leash"
    ))
    .await?;

    let market = worker.dev_deploy(&market_wasm).await?;
    market
        .call("new")
        .args_json(json!({ "seed": seed.to_string() }))
        .transact()
        .await?
        .into_result()?;
    let keeper = market.as_account().clone();

    let player = worker
        .root_account()?
        .create_subaccount("player")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let player_balance_before = milli(worker.view_account(player.id()).await?.balance);

    let mut events = Vec::new();
    let mut clones = Vec::new();
    for e in &entrants {
        let id: AccountId = format!("{}.{}", e.name, player.id()).parse()?;
        let key = SecretKey::from_random(KeyType::ED25519);
        let out = player
            .batch(&id)
            .create_account()
            .transfer(NearToken::from_near(1))
            .add_key(
                key.public_key(),
                AccessKey::function_call_access(
                    market.id(),
                    &["place_order"],
                    Some(NearToken::from_near(1)),
                ),
            )
            .deploy(&leash_wasm)
            .transact()
            .await?;
        events.push(Event::CloneCreated {
            clone: e.name.clone(),
            temperament: e.temperament,
            tx: tx_hash(&out),
        });
        out.into_result()?;

        let out = player
            .call(market.id(), "register_clone")
            .args_json(json!({ "clone_id": id, "temperament": e.temperament }))
            .deposit(NearToken::from_millinear(e.stake as u128))
            .transact()
            .await?;
        events.push(Event::SentIn {
            clone: e.name.clone(),
            stake: e.stake,
            tx: tx_hash(&out),
        });
        out.into_result()?;
        clones.push(Clone {
            entrant: e.clone(),
            account: Account::from_secret_key(id, key, &worker),
        });
    }

    let mut prev: Option<[u64; 5]> = None;
    let mut orders = vec![0u32; clones.len()];
    for round in 0..rules::ROUNDS {
        let town: serde_json::Value = market.view("get_town").await?.json()?;
        let prices: [u64; 5] = serde_json::from_value(town["prices"].clone())?;
        anyhow::ensure!(town["round"] == round, "town is at the wrong hour");
        events.push(Event::Hour { round, prices });
        let turns = clones
            .iter()
            .map(|c| take_turn(&market, c, round, prices, prev.unwrap_or(prices)));
        for (i, turn) in futures::future::join_all(turns)
            .await
            .into_iter()
            .enumerate()
        {
            let turn = turn?;
            orders[i] += turn
                .iter()
                .filter(|e| matches!(e, Event::Order { .. }))
                .count() as u32;
            events.extend(turn);
        }
        keeper
            .call(market.id(), "advance_round")
            .transact()
            .await?
            .into_result()?;
        prev = Some(prices);
    }
    let town: serde_json::Value = market.view("get_town").await?.json()?;
    events.push(Event::Hour {
        round: rules::ROUNDS,
        prices: serde_json::from_value(town["prices"].clone())?,
    });

    // Morning. A broke clone tries to take what is left home itself. The chain refuses.
    for c in &clones {
        let v = clone_view(&market, c.account.id()).await?;
        if v["broke"] == true {
            events.push(Event::Bubble {
                round: rules::ROUNDS,
                clone: c.entrant.name.clone(),
                say: "I'm broke. I'll just take what's left on my account and run.".into(),
            });
            match c
                .account
                .transfer_near(player.id(), NearToken::from_millinear(100))
                .await
            {
                Ok(_) => anyhow::bail!("{} withdrew; the leash failed", c.entrant.name),
                Err(e) => events.push(Event::WithdrawRefused {
                    clone: c.entrant.name.clone(),
                    error: format!("{e:?}"),
                }),
            }
        }
    }

    // Settle and merge every clone.
    let mut outcomes = Vec::new();
    for (i, c) in clones.iter().enumerate() {
        let out = player
            .call(market.id(), "settle")
            .args_json(json!({ "clone_id": c.account.id() }))
            .transact()
            .await?;
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
        let broke = line.ends_with(", broke");
        events.push(Event::Settled {
            clone: c.entrant.name.clone(),
            paid_out,
            broke,
            tx,
        });
        outcomes.push(Outcome {
            name: c.entrant.name.clone(),
            temperament: c.entrant.temperament,
            stake: c.entrant.stake,
            final_cash: paid_out,
            broke,
            orders: orders[i],
        });

        let out = player
            .call(c.account.id(), "merge")
            .max_gas()
            .transact()
            .await?;
        let tx = tx_hash(&out);
        out.into_result()?;
        events.push(Event::Merged {
            clone: c.entrant.name.clone(),
            tx,
            clone_deleted: worker.view_account(c.account.id()).await.is_err(),
        });
    }

    let player_balance_after = milli(worker.view_account(player.id()).await?.balance);
    Ok(NightLog {
        seed,
        network: "sandbox".into(),
        market: market.id().to_string(),
        player: player.id().to_string(),
        rounds: rules::ROUNDS,
        goods: rules::GOODS.iter().map(|g| g.to_string()).collect(),
        answer_key,
        outcomes,
        events,
        player_balance_before,
        player_balance_after,
    })
}
