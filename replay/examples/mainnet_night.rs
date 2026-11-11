//! One real night on NEAR mainnet, in a market nobody can change.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run --release -p clones-replay --example mainnet_night -- \
//!         <funder: an account whose key is in CLONES_KEYS_DIR> <house name, e.g. clones-town.near> [seed]
//!
//! It creates the house (`<house>` through the `near` account registrar), then:
//! - the market `market.<house>`, deployed and initialised in one transaction and given no access
//!   key at all: nobody, the house included, can ever change its code or rules. The house is only
//!   its keeper (it may open nights and ring hours);
//! - a player `you.<house>`, and three clones under it with 0.25 NEAR stakes, each holding one
//!   function-call key for `trade` and bound to the market;
//! - one seeded night with an answer key computed before it starts; the broke clone's withdrawal
//!   is refused by the chain; every clone settles and merges home with DeleteAccount.
//!
//! Real NEAR: about 6 in total. The market keeps about 2.5 NEAR of storage for good (it has no key
//! to close it with); the rest ends on the house and player accounts, whose keys are saved to
//! CLONES_KEYS_DIR. Never commit that folder.

use clones_core::{Entrant, Temperament};
use clones_replay::{contracts, enlist, run_night};
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;
use std::path::PathBuf;

const EXPLORER: &str = "https://nearblocks.io";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() >= 2, "usage: <funder> <house.near> [seed]");
    let seed: u64 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(617);
    let rpc =
        std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://rpc.mainnet.fastnear.com".into());
    let worker = near_workspaces::mainnet().rpc_addr(&rpc).await?;

    let load = |id: &str| -> anyhow::Result<Account> {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{id}.json")))?)?;
        Ok(Account::from_secret_key(
            id.parse()?,
            v["private_key"].as_str().unwrap_or_default().parse()?,
            &worker,
        ))
    };
    let save = |id: &AccountId, key: &SecretKey| -> anyhow::Result<()> {
        let path = dir.join(format!("{id}.json"));
        anyhow::ensure!(
            !path.exists(),
            "{path:?} exists; refusing to overwrite a key"
        );
        std::fs::write(
            path,
            json!({ "account_id": id, "private_key": key.to_string() }).to_string(),
        )?;
        Ok(())
    };

    let funder = load(&args[0])?;
    let house_id: AccountId = args[1].parse()?;
    let have = worker.view_account(funder.id()).await?.balance;
    anyhow::ensure!(
        have >= NearToken::from_millinear(5800),
        "the funder holds {have}; send it about 6 NEAR first"
    );

    // 1. The house, through the `near` registrar.
    let house_key = SecretKey::from_random(KeyType::ED25519);
    save(&house_id, &house_key)?;
    let out = funder
        .call(&"near".parse()?, "create_account")
        .args_json(json!({ "new_account_id": house_id, "new_public_key": house_key.public_key() }))
        .deposit(have.saturating_sub(NearToken::from_millinear(100)))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    anyhow::ensure!(
        out.is_success(),
        "could not create {house_id}: {:?}",
        out.into_result().err()
    );
    let house = Account::from_secret_key(house_id.clone(), house_key, &worker);
    println!("house   {EXPLORER}/address/{house_id}");

    // 2. The market: created, funded, deployed and initialised in one transaction, with no key.
    let (market_wasm, leash_wasm) = contracts().await?;
    let market_id: AccountId = format!("market.{house_id}").parse()?;
    let out = house
        .batch(&market_id)
        .create_account()
        .transfer(NearToken::from_millinear(2600))
        .deploy(&market_wasm)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({ "seed": "0", "guests_under": null, "chain_dice": false })),
        )
        .transact()
        .await?;
    println!(
        "market  {EXPLORER}/txns/{}  (created with no access key)",
        out.outcome().transaction_hash
    );
    out.into_result()?;
    let keys = worker.view_access_keys(&market_id).await?;
    anyhow::ensure!(
        keys.is_empty(),
        "the market has {} keys; it must have none",
        keys.len()
    );
    println!("market  {EXPLORER}/address/{market_id}  keys: 0, nobody can change it");
    // Views only: a contract handle needs a signer, never used here.
    let market = Contract::from_secret_key(
        market_id.clone(),
        SecretKey::from_random(KeyType::ED25519),
        &worker,
    );

    // 3. The player and three clones with 0.25 NEAR stakes.
    let player_key = SecretKey::from_random(KeyType::ED25519);
    let player_id: AccountId = format!("you.{house_id}").parse()?;
    save(&player_id, &player_key)?;
    let player = house
        .create_subaccount("you")
        .initial_balance(NearToken::from_millinear(2700))
        .keys(player_key)
        .transact()
        .await?
        .into_result()?;
    println!("player  {EXPLORER}/address/{}", player.id());
    let entrants: Vec<Entrant> = [
        ("clone-1", Temperament::Cautious),
        ("clone-2", Temperament::Greedy),
        ("clone-3", Temperament::Loyal),
    ]
    .iter()
    .map(|(n, t)| Entrant::new(n, *t, 250))
    .collect();
    let guest = enlist(
        &worker,
        &market,
        player,
        &leash_wasm,
        &entrants,
        NearToken::from_millinear(550),
        None,
    )
    .await?;

    // 4. The night, with the answer key computed first.
    let logs = run_night(
        &worker,
        "mainnet",
        &market,
        &house,
        vec![guest],
        seed,
        true,
        None,
    )
    .await?;
    let log = &logs[0];
    let out_path = std::env::var("OUT").unwrap_or_else(|_| "web/data/night-mainnet.json".into());
    std::fs::write(&out_path, serde_json::to_string_pretty(log)?)?;
    let matched = log.outcomes == log.answer_key;
    println!(
        "night on mainnet: {} events, answer key matched: {matched}, log in {out_path}",
        log.events.len()
    );
    anyhow::ensure!(matched, "the chain disagreed with the answer key");
    Ok(())
}
