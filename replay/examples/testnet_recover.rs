//! Bring testnet NEAR home from a night that stopped part way: settle and merge whatever clones
//! are left, send the player's balance back to a funder, and delete the abandoned town.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run -p clones-replay --example testnet_recover -- \
//!         <town account> <player account> <funder account>

use near_workspaces::types::{NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use std::path::PathBuf;

fn load(
    dir: &std::path::Path,
    id: &str,
    worker: &near_workspaces::Worker<impl near_workspaces::Network + 'static>,
) -> anyhow::Result<Account> {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{id}.json")))?)?;
    let sk: SecretKey = v["private_key"].as_str().unwrap_or_default().parse()?;
    Ok(Account::from_secret_key(id.parse()?, sk, worker))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(args.len() == 3, "usage: <town> <player> <funder>");
    let rpc = std::env::var("NEAR_RPC").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;
    let town_id: AccountId = args[0].parse()?;
    let player = load(&dir, &args[1], &worker)?;
    let funder: AccountId = args[2].parse()?;

    for n in 1..=3 {
        let clone: AccountId = format!("clone-{n}.{}", player.id()).parse()?;
        if worker.view_account(&clone).await.is_err() {
            continue;
        }
        let settle = player
            .call(&town_id, "settle")
            .args_json(serde_json::json!({ "clone_id": clone }))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?;
        println!("settle {clone}: {}", settle.is_success());
        let merge = player
            .call(&clone, "merge")
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?;
        println!("merge  {clone}: {}", merge.is_success());
    }

    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let bal = worker.view_account(player.id()).await?.balance;
    let send = bal.saturating_sub(NearToken::from_millinear(50));
    player.transfer_near(&funder, send).await?.into_result()?;
    println!("sent {send} from {} to {funder}", player.id());

    let town = load(&dir, &args[0], &worker)?;
    let name = town.id().clone();
    let out = town.delete_account(&funder).await?;
    println!("deleted {name}: {}", out.is_success());
    Ok(())
}
