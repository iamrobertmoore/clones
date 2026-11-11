//! Play the seeded night on NEAR testnet, so every transaction has a public explorer link.
//! Testnet NEAR only.
//!
//!     CLONES_KEYS_DIR=/private/keys TOWN_FUNDER=a.testnet PLAYER_FUNDER=b.testnet \
//!         cargo run -p clones-replay --example testnet_night -- 606 night.json
//!
//! The funders are existing testnet accounts whose keys are in CLONES_KEYS_DIR as
//! `<account>.json` ({"account_id", "private_key"}). A fresh town and a fresh player are created
//! as their sub-accounts, and the new keys are saved to the same folder. Never commit that folder.

use clones_replay::{contracts, play_night, DEMO_SEED};
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;
use std::path::{Path, PathBuf};

fn load(
    dir: &Path,
    id: &str,
    worker: &near_workspaces::Worker<impl near_workspaces::Network + 'static>,
) -> anyhow::Result<Account> {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{id}.json")))?)?;
    let sk: SecretKey = v["private_key"].as_str().unwrap_or_default().parse()?;
    Ok(Account::from_secret_key(id.parse()?, sk, worker))
}

fn save(dir: &Path, id: &AccountId, sk: &SecretKey) -> anyhow::Result<()> {
    let body = json!({ "account_id": id, "private_key": sk.to_string() });
    std::fs::write(dir.join(format!("{id}.json")), body.to_string())?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let env = |k: &str| std::env::var(k).map_err(|_| anyhow::anyhow!("set {k}"));
    let dir: PathBuf = env("CLONES_KEYS_DIR")?.into();
    let mut args = std::env::args().skip(1);
    let seed: u64 = args
        .next()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(DEMO_SEED);
    let out = args.next().unwrap_or_else(|| "night.json".into());

    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;
    let town_funder = load(&dir, &env("TOWN_FUNDER")?, &worker)?;
    let player_funder = load(&dir, &env("PLAYER_FUNDER")?, &worker)?;
    let (market_wasm, leash_wasm) = contracts().await?;
    let tag = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs()
        % 1_000_000;

    let town_key = SecretKey::from_random(KeyType::ED25519);
    let town = town_funder
        .create_subaccount(&format!("town{tag}"))
        .initial_balance(NearToken::from_millinear(2500))
        .keys(town_key.clone())
        .transact()
        .await?
        .into_result()?;
    save(&dir, town.id(), &town_key)?;
    let market = town.deploy(&market_wasm).await?.into_result()?;
    market
        .call("new")
        .args_json(json!({ "seed": seed.to_string() }))
        .transact()
        .await?
        .into_result()?;
    println!(
        "town    https://testnet.nearblocks.io/address/{}",
        market.id()
    );

    let player_key = SecretKey::from_random(KeyType::ED25519);
    let player = player_funder
        .create_subaccount(&format!("p{tag}"))
        .initial_balance(NearToken::from_millinear(8200))
        .keys(player_key.clone())
        .transact()
        .await?
        .into_result()?;
    save(&dir, player.id(), &player_key)?;
    println!(
        "player  https://testnet.nearblocks.io/address/{}",
        player.id()
    );

    let log = play_night(
        &worker,
        "testnet",
        &market,
        &town,
        &player,
        &leash_wasm,
        seed,
        NearToken::from_millinear(500),
    )
    .await?;
    std::fs::write(&out, serde_json::to_string_pretty(&log)?)?;
    let matched = log.outcomes == log.answer_key;
    println!(
        "events {}, answer key matched: {matched}, log written to {out}",
        log.events.len()
    );
    anyhow::ensure!(matched, "the chain disagreed with the answer key");
    Ok(())
}
