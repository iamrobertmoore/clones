//! Send an account's testnet NEAR, less what it must keep, to another account.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run -p clones-replay --example testnet_sweep -- \
//!         <from> <to> <NEAR to keep>

use near_workspaces::types::NearToken;
use near_workspaces::Account;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 3, "usage: <from> <to> <keep>");
    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(
        dir.join(format!("{}.json", args[0])),
    )?)?;
    let from = Account::from_secret_key(
        args[0].parse()?,
        v["private_key"].as_str().unwrap_or_default().parse()?,
        &worker,
    );
    let keep = NearToken::from_millinear((args[2].parse::<f64>()? * 1000.0) as u128);
    let bal = worker.view_account(from.id()).await?.balance;
    let send = bal.saturating_sub(keep);
    from.transfer_near(&args[1].parse()?, send)
        .await?
        .into_result()?;
    println!("sent {send} from {} to {}", from.id(), args[1]);
    Ok(())
}
