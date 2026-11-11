//! Top up a testnet account from testnet's faucet: create `n` dev accounts (the faucet funds each
//! one) and sweep each into `to`, keeping 0.05 NEAR. Testnet NEAR only. Keys are saved to
//! CLONES_KEYS_DIR; never commit that folder.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run -p clones-replay --example testnet_faucet -- <to> <n>

use near_workspaces::types::NearToken;
use serde_json::json;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 2, "usage: <to> <n>");
    let to: near_workspaces::AccountId = args[0].parse()?;
    let n: u32 = args[1].parse()?;
    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;
    let mut total = NearToken::from_near(0);
    for _ in 0..n {
        let dev = worker.dev_create_account().await?;
        std::fs::write(
            dir.join(format!("{}.json", dev.id())),
            json!({ "account_id": dev.id(), "private_key": dev.secret_key().to_string() })
                .to_string(),
        )?;
        let bal = worker.view_account(dev.id()).await?.balance;
        let send = bal.saturating_sub(NearToken::from_millinear(50));
        dev.transfer_near(&to, send).await?.into_result()?;
        total = total.saturating_add(send);
        println!("{} sent {send} to {to}", dev.id());
    }
    println!("total {total}");
    Ok(())
}
