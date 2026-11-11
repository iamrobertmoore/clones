//! Set up the hosted town on testnet: a house account (via testnet's account registrar) and the
//! market as its sub-account. One house key signs for the house, the market keeper, every guest
//! player and, as a function-call key for the market only, every guest clone.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run -p clones-replay --example testnet_house -- \
//!         <funder account> <house name, e.g. clonestown.testnet> <NEAR to fund it with | new-market>
//!
//! `new-market` keeps the house and deploys a fresh market as `<MARKET_NAME>.<house>` (default
//! `cairn`), for when the market's stored state changes shape. NEAR refuses to delete an account
//! holding a lot of state, so an old market is left where it is rather than deleted.

use clones_replay::contracts;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 3, "usage: <funder> <house> <near>");
    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;

    let fv: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        dir.join(format!("{}.json", args[0])),
    )?)?;
    let funder = Account::from_secret_key(
        args[0].parse()?,
        fv["private_key"].as_str().unwrap_or_default().parse()?,
        &worker,
    );
    let house_id: AccountId = args[1].parse()?;
    let key_file = dir.join(format!("{house_id}.json"));

    let market_name = std::env::var("MARKET_NAME").unwrap_or_else(|_| "cairn".into());
    let house = if args[2] == "new-market" {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&key_file)?)?;
        let key: SecretKey = v["private_key"].as_str().unwrap_or_default().parse()?;
        Account::from_secret_key(house_id.clone(), key, &worker)
    } else {
        let fund = NearToken::from_millinear((args[2].parse::<f64>()? * 1000.0) as u128);
        anyhow::ensure!(
            !key_file.exists(),
            "{key_file:?} exists; refusing to overwrite a key"
        );
        let key = SecretKey::from_random(KeyType::ED25519);
        std::fs::write(
            &key_file,
            json!({ "account_id": house_id, "private_key": key.to_string() }).to_string(),
        )?;
        funder
            .call(&"testnet".parse()?, "create_account")
            .args_json(json!({ "new_account_id": house_id, "new_public_key": key.public_key() }))
            .deposit(fund)
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        println!("house   https://testnet.nearblocks.io/address/{house_id}");
        Account::from_secret_key(house_id.clone(), key, &worker)
    };
    let key = house.secret_key().clone();

    let (market_wasm, _) = contracts().await?;
    let market = house
        .create_subaccount(&market_name)
        .initial_balance(NearToken::from_near(5))
        .keys(key)
        .transact()
        .await?
        .into_result()?
        .deploy(&market_wasm)
        .await?
        .into_result()?;
    market
        .call("new")
        // The hosted town draws every hour's prices and tomorrow's mood from block randomness.
        .args_json(json!({ "seed": "0", "guests_under": house_id, "chain_dice": true }))
        .transact()
        .await?
        .into_result()?;
    println!(
        "market  https://testnet.nearblocks.io/address/{}",
        market.id()
    );
    Ok(())
}
