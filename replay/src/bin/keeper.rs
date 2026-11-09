//! The hosted town's nightly keeper. Finds every clone in town, opens a new night, plays it,
//! settles and merges everyone at dawn, sweeps guest balances back to the house, and writes one
//! night log per guest (the same format as the demo replay) plus an index.
//!
//!     HOUSE_ACCOUNT=clonestown.testnet HOUSE_KEY=ed25519:... OUT_DIR=nights \
//!         cargo run -p clones-replay --bin keeper
//!
//! Testnet only. One house key signs for the keeper and every guest; on each clone it is a
//! function-call key for the market, so a clone still cannot withdraw.

use clones_core::{mix, Entrant, Temperament};
use clones_replay::{run_night, Guest, Seat};
use near_workspaces::types::SecretKey;
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let env = |k: &str| std::env::var(k).map_err(|_| anyhow::anyhow!("set {k}"));
    let house_id: AccountId = env("HOUSE_ACCOUNT")?.parse()?;
    let key: SecretKey = env("HOUSE_KEY")?.trim().parse()?;
    let out: PathBuf = std::env::var("OUT_DIR")
        .unwrap_or_else(|_| "nights".into())
        .into();
    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;

    let market_id: AccountId = format!("market.{house_id}").parse()?;
    let market = Contract::from_secret_key(market_id.clone(), key.clone(), &worker);
    let keeper = Account::from_secret_key(market_id, key.clone(), &worker);

    let in_town: Vec<(AccountId, serde_json::Value)> = market
        .view("list_clones")
        .args_json(json!({ "from": 0, "limit": 100 }))
        .await?
        .json()?;
    if in_town.is_empty() {
        println!("The town is empty tonight.");
        return Ok(());
    }

    let mut by_player: BTreeMap<AccountId, Vec<(AccountId, serde_json::Value)>> = BTreeMap::new();
    let suffix = format!(".{house_id}");
    for (id, v) in in_town {
        let player: AccountId = v["player"].as_str().unwrap_or_default().parse()?;
        // The house can only sign for its own guests; anyone else's clone is not ours to run.
        if !player.as_str().ends_with(&suffix) {
            eprintln!("skipping {id}: not a guest of {house_id}");
            continue;
        }
        by_player.entry(player).or_default().push((id, v));
    }

    let mut guests = Vec::new();
    for (player_id, clones) in by_player {
        let seats = clones
            .into_iter()
            .map(|(id, v)| {
                let temperament: Temperament = serde_json::from_value(v["temperament"].clone())?;
                Ok(Seat {
                    entrant: Entrant {
                        name: id
                            .as_str()
                            .split('.')
                            .next()
                            .unwrap_or_default()
                            .to_string(),
                        temperament,
                        stake: v["stake"].as_u64().unwrap_or_default(),
                    },
                    account: Account::from_secret_key(id, key.clone(), &worker),
                    orders_before: v["orders_placed"].as_u64().unwrap_or_default() as u32,
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let Ok(details) = worker.view_account(&player_id).await else {
            eprintln!("skipping {player_id}: account not found");
            continue;
        };
        let balance_before = details.balance.as_millinear() as u64;
        guests.push(Guest {
            player: Account::from_secret_key(player_id, key.clone(), &worker),
            seats,
            events: Vec::new(),
            balance_before,
        });
    }

    let day = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        / 86_400;
    let seed: u64 = match std::env::var("SEED") {
        Ok(s) => s.parse()?,
        Err(_) => mix(day) % 1_000_000,
    };
    if guests.is_empty() {
        println!("No guests of the house tonight.");
        return Ok(());
    }
    println!("Night for {} guests, seed {seed}", guests.len());

    let logs = run_night(
        &worker,
        "testnet",
        &market,
        &keeper,
        guests,
        seed,
        true,
        Some(&house_id),
    )
    .await?;

    std::fs::create_dir_all(&out)?;
    let mut index = Vec::new();
    for log in &logs {
        std::fs::write(
            out.join(format!("{}.json", log.player)),
            serde_json::to_string_pretty(log)?,
        )?;
        index.push(json!({
            "player": log.player,
            "matched": log.outcomes == log.answer_key,
            "outcomes": log.outcomes,
        }));
        println!(
            "{}: {:?}",
            log.player,
            log.outcomes
                .iter()
                .map(|o| (o.name.as_str(), o.final_cash, o.broke))
                .collect::<Vec<_>>()
        );
    }
    let ran_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    std::fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&json!({ "seed": seed, "ran_at": ran_at, "guests": index }))?,
    )?;
    Ok(())
}
