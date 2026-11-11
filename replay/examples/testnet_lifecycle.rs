//! The same clone lifecycle as the sandbox tests, on NEAR testnet, printing an explorer link for
//! every transaction. Testnet NEAR only; no real money moves.
//!
//!     CLONES_KEYS_DIR=/some/private/dir cargo run -p sandbox-tests --example testnet_lifecycle
//!
//! Keys for the accounts it creates are written to CLONES_KEYS_DIR (never commit them).

use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::json;
use std::path::{Path, PathBuf};

const EXPLORER: &str = "https://testnet.nearblocks.io";

fn link(label: &str, out: &ExecutionFinalResult) {
    println!(
        "{label:<34} {EXPLORER}/txns/{}",
        out.outcome().transaction_hash
    );
}

fn save_key(dir: &Path, id: &AccountId, sk: &SecretKey) -> anyhow::Result<()> {
    let body = json!({ "account_id": id, "private_key": sk.to_string() });
    std::fs::write(dir.join(format!("{id}.json")), body.to_string())?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let keys_dir: PathBuf = std::env::var("CLONES_KEYS_DIR")
        .map_err(|_| anyhow::anyhow!("set CLONES_KEYS_DIR to a private folder for the keys"))?
        .into();
    std::fs::create_dir_all(&keys_dir)?;

    let worker = near_workspaces::testnet().await?;
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
    save_key(&keys_dir, market.id(), market.as_account().secret_key())?;
    let out = market
        .call("new")
        .args_json(json!({ "seed": "853" }))
        .transact()
        .await?;
    link("market init", &out);
    out.into_result()?;

    let player = worker.dev_create_account().await?;
    save_key(&keys_dir, player.id(), player.secret_key())?;
    println!("market  {EXPLORER}/address/{}", market.id());
    println!("player  {EXPLORER}/address/{}", player.id());

    let clone_id: AccountId = format!("clone-1.{}", player.id()).parse()?;
    let clone_key = SecretKey::from_random(KeyType::ED25519);
    save_key(&keys_dir, &clone_id, &clone_key)?;
    let out = player
        .batch(&clone_id)
        .create_account()
        .transfer(NearToken::from_near(3))
        .add_key(
            clone_key.public_key(),
            AccessKey::function_call_access(
                market.id(),
                &["trade"],
                Some(NearToken::from_millinear(250)),
            ),
        )
        .deploy(&leash_wasm)
        .transact()
        .await?;
    link("create clone-1 (leash key only)", &out);
    out.into_result()?;
    println!("clone   {EXPLORER}/address/{clone_id}");
    let clone = Account::from_secret_key(clone_id, clone_key, &worker);

    let out = player
        .call(market.id(), "register_clone")
        .args_json(json!({ "clone_id": clone.id(), "temperament": "possessed" }))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?;
    link("send clone into town (2 NEAR)", &out);
    out.into_result()?;

    let out = market
        .call("open_night")
        .args_json(json!({ "seed": "853", "night": 1 }))
        .transact()
        .await?;
    link("keeper opens the night", &out);
    out.into_result()?;

    let out = clone
        .call(market.id(), "trade")
        .args_json(json!({ "round": 0, "orders": [{ "good": "salt", "side": "buy", "qty": 3, "price": 30 }] }))
        .transact()
        .await?;
    link("clone trades", &out);
    out.into_result()?;

    match clone
        .transfer_near(player.id(), NearToken::from_millinear(100))
        .await
    {
        Ok(_) => anyhow::bail!("the clone withdrew; the leash failed"),
        Err(e) => println!("clone tries to withdraw          REFUSED by the chain: {e:?}"),
    }

    for round in 0..12u32 {
        market
            .call("advance_round")
            .args_json(json!({ "round": round }))
            .transact()
            .await?
            .into_result()?;
    }
    println!("keeper rang twelve hours: dawn");

    let out = player
        .call(market.id(), "settle")
        .args_json(json!({ "clone_id": clone.id() }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    link("settle clone's cash", &out);
    out.into_result()?;

    let out = player
        .call(clone.id(), "merge")
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?;
    link("merge (DeleteAccount -> player)", &out);
    out.into_result()?;

    let gone = worker.view_account(clone.id()).await.is_err();
    println!("clone account deleted: {gone}");
    anyhow::ensure!(gone, "clone still exists after merge");
    Ok(())
}
