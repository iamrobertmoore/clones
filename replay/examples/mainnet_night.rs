//! One real night on NEAR mainnet, in a market nobody can change.
//!
//!     CLONES_KEYS_DIR=/private/keys cargo run --release -p clones-replay --example mainnet_night -- \
//!         <funder: an account whose key is in CLONES_KEYS_DIR, or "-" if the house exists> <house name, e.g. clones-town.near> \
//!         [return-to: your own account, for what is left at the end] [seed]
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
//! Real NEAR: send the funder 5.3. The market keeps 2.9 NEAR of storage for good (it has no key
//! to close it with, which is the point), gas is a few hundredths, and the clones' stakes come back
//! with their profit or loss. With `return-to`, everything left on the house and player accounts
//! (about 1.8 NEAR) is sent there at the end. Keys are saved to CLONES_KEYS_DIR; never commit it.

use clones_core::{Entrant, Temperament};
use clones_replay::{account_exists, contracts, enlist, retry, run_night, Guest, Seat};
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract};
use serde_json::json;
use std::path::PathBuf;

const EXPLORER: &str = "https://nearblocks.io";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let dir: PathBuf = std::env::var("CLONES_KEYS_DIR")?.into();
    let args: Vec<String> = std::env::args().skip(1).collect();
    anyhow::ensure!(
        args.len() >= 2,
        "usage: <funder> <house.near> [return-to] [seed]"
    );
    let return_to: Option<AccountId> = args.get(2).map(|s| s.parse()).transpose()?;
    let seed: u64 = args.get(3).map(|s| s.parse()).transpose()?.unwrap_or(617);
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

    let house_id: AccountId = args[1].parse()?;
    // 1. The house. Either it already exists (created from a wallet with the key in
    // CLONES_KEYS_DIR, funder "-"), or the funder creates it through the `near` registrar.
    let house = if args[0] == "-" {
        let house = load(house_id.as_str())?;
        let have = retry!(worker.view_account(&house_id).await)?.balance;
        let resuming = account_exists(&worker, &format!("market.{house_id}").parse()?).await?;
        anyhow::ensure!(
            resuming || have >= NearToken::from_millinear(5200),
            "the house holds {have}; it needs 5.2 NEAR"
        );
        house
    } else {
        let funder = load(&args[0])?;
        let have = worker.view_account(funder.id()).await?.balance;
        anyhow::ensure!(
            have >= NearToken::from_millinear(5250),
            "the funder holds {have}; send it 5.3 NEAR first"
        );
        let house_key = SecretKey::from_random(KeyType::ED25519);
        save(&house_id, &house_key)?;
        let out = funder
            .call(&"near".parse()?, "create_account")
            .args_json(
                json!({ "new_account_id": house_id, "new_public_key": house_key.public_key() }),
            )
            .deposit(have.saturating_sub(NearToken::from_millinear(50)))
            .gas(near_workspaces::types::Gas::from_tgas(100))
            .transact()
            .await?;
        anyhow::ensure!(
            out.is_success(),
            "could not create {house_id}: {:?}",
            out.into_result().err()
        );
        Account::from_secret_key(house_id.clone(), house_key, &worker)
    };
    println!("house   {EXPLORER}/address/{house_id}");

    // 2. The market: created, funded, deployed and initialised in one transaction, with no key.
    let (market_wasm, leash_wasm) = contracts().await?;
    let market_id: AccountId = format!("market.{house_id}").parse()?;
    if !account_exists(&worker, &market_id).await? {
        let out = house
            .batch(&market_id)
            .create_account()
            .transfer(NearToken::from_millinear(2900))
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
    }
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

    // 3. The player and three clones with 0.25 NEAR stakes. The clones' trade-only key is saved
    // before they exist, so a run that stops at the start of a night can pick the night up.
    let entrants: Vec<Entrant> = [
        ("clone-1", Temperament::Cautious),
        ("clone-2", Temperament::Greedy),
        ("clone-3", Temperament::Loyal),
    ]
    .iter()
    .map(|(n, t)| Entrant::new(n, *t, 250))
    .collect();
    let trade_key_path = dir.join("trade-key.json");
    let trade_key: SecretKey = if trade_key_path.exists() {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&trade_key_path)?)?;
        v["private_key"].as_str().unwrap_or_default().parse()?
    } else {
        let k = SecretKey::from_random(KeyType::ED25519);
        std::fs::write(
            &trade_key_path,
            json!({ "private_key": k.to_string() }).to_string(),
        )?;
        k
    };
    let player_id: AccountId = format!("you.{house_id}").parse()?;
    let mut resume: Option<Vec<Seat>> = None;
    let mut played = false;
    let player = if account_exists(&worker, &player_id).await? {
        // A run that stopped part way: bring home any clones it left in town (their trade keys
        // were only in memory), so their stakes and balances return to the player.
        let player = load(player_id.as_str())?;
        // A night that stopped before its first hour, with our three clones holding the saved
        // key: play it from the start.
        let state: serde_json::Value = retry!(market.view("get_state").await)?.json()?;
        let ours: Vec<String> = state[1]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c[1]["player"] == player_id.as_str())
            .filter_map(|c| c[0].as_str().map(String::from))
            .collect();
        if state[0]["round"] == 0 && state[0]["night"].as_u64().unwrap_or(0) >= 1 && ours.len() == 3
        {
            let mut seats = Vec::new();
            for e in &entrants {
                let id: AccountId = format!("{}.{player_id}", e.name).parse()?;
                let keys = retry!(worker.view_access_keys(&id).await)?;
                if keys.iter().any(|k| k.public_key == trade_key.public_key()) {
                    seats.push(Seat {
                        entrant: e.clone(),
                        account: Account::from_secret_key(id, trade_key.clone(), &worker),
                        orders_before: 0,
                    });
                }
            }
            if seats.len() == 3 {
                println!("picking up night {} at its first hour", state[0]["night"]);
                resume = Some(seats);
            }
        }
        // A night left open by a crash: the house is its keeper and rings it through to dawn
        // (nobody trades), so its clones can settle for what they hold.
        while resume.is_none() {
            let town: serde_json::Value = retry!(
                market
                    .view("get_town")
                    .finality(near_workspaces::types::Finality::Optimistic)
                    .await
            )?
            .json()?;
            let round = town["round"].as_u64().unwrap_or(12);
            if town["night"].as_u64().unwrap_or(0) == 0 || round >= 12 {
                break;
            }
            retry!(
                house
                    .call(&market_id, "advance_round")
                    .args_json(json!({ "round": round }))
                    .transact()
                    .await
            )?
            .into_result()?;
            println!("rang hour {} of the unfinished night", round + 1);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        let town: serde_json::Value = retry!(market.view("get_state").await)?.json()?;
        // A night our clones played to dawn: that is the night; bring them home and stop.
        played = resume.is_none()
            && town[0]["night"].as_u64().unwrap_or(0) >= 1
            && town[1].as_array().into_iter().flatten().any(|c| {
                c[1]["player"] == player_id.as_str()
                    && c[1]["orders_placed"].as_u64().unwrap_or(0) > 0
            });
        if played {
            for c in town[1].as_array().into_iter().flatten() {
                if c[1]["player"] != player_id.as_str() || c[1]["broke"] != true {
                    continue;
                }
                let id: AccountId = c[0].as_str().unwrap_or_default().parse()?;
                let clone = Account::from_secret_key(id.clone(), trade_key.clone(), &worker);
                match retry!(clone.transfer_near(&player_id, NearToken::from_millinear(10)).await) {
                    Ok(_) => anyhow::bail!("{id} withdrew; the leash failed"),
                    Err(e) => println!(
                        "{id} is broke and tried to take its balance home itself; the chain refused: {}",
                        if format!("{e:?}").contains("InvalidAccessKeyError") {
                            "its only key may call `trade` on the market, nothing else".to_string()
                        } else {
                            format!("{e}")
                        }
                    ),
                }
            }
        }
        let left: Vec<String> = if resume.is_some() {
            Vec::new()
        } else {
            town[1]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c[1]["player"] == player_id.as_str())
                .filter_map(|c| c[0].as_str().map(String::from))
                .collect()
        };
        // Settling (60 Tgas) holds 0.06 NEAR of gas up front; earlier stopped runs may have spent the
        // player below that, so the house lends it the difference (it comes back with the rest).
        let have = retry!(worker.view_account(&player_id).await)?.balance;
        let floor = NearToken::from_millinear(70);
        if !left.is_empty() && have < floor {
            let lend = NearToken::from_yoctonear(
                floor.as_yoctonear() - have.as_yoctonear()
                    + NearToken::from_millinear(5).as_yoctonear(),
            );
            retry!(house.transfer_near(&player_id, lend).await)?.into_result()?;
            println!("the house lent the player {lend} for gas");
        }
        for clone in &left {
            retry!(
                player
                    .call(&market_id, "settle")
                    .args_json(json!({ "clone_id": clone }))
                    .gas(near_workspaces::types::Gas::from_tgas(60))
                    .transact()
                    .await
            )?
            .into_result()?;
            let clone_id: AccountId = clone.parse()?;
            for _ in 0..30 {
                if !account_exists(&worker, &clone_id).await? {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            println!("brought {clone} home before the night");
        }
        if played {
            let results: serde_json::Value = retry!(
                market
                    .view("get_results")
                    .args_json(json!({ "player": player_id }))
                    .await
            )?
            .json()?;
            let night = town[0]["night"].clone();
            for r in results.as_array().into_iter().flatten() {
                if r["night"] == night {
                    println!(
                        "settled {}: staked {} mNEAR, paid out {} mNEAR{}",
                        r["clone"].as_str().unwrap_or_default(),
                        r["stake"],
                        r["paid_out"],
                        if r["broke"] == true { ", broke" } else { "" }
                    );
                }
            }
        }
        // Pay the house back for the bell if lending left it short.
        if !left.is_empty()
            && retry!(worker.view_account(&house_id).await)?.balance < NearToken::from_millinear(50)
        {
            retry!(
                player
                    .transfer_near(&house_id, NearToken::from_millinear(30))
                    .await
            )?
            .into_result()?;
            println!("the player paid the house back 0.03 NEAR");
        }
        // A clone account created but never registered: its leash lets the parent merge it.
        for name in [
            "clone-1", "clone-2", "clone-3", "cautious", "greedy", "loyal",
        ] {
            let clone_id: AccountId = format!("{name}.{player_id}").parse()?;
            if resume.is_some() || !account_exists(&worker, &clone_id).await? {
                continue;
            }
            retry!(
                player
                    .call(&clone_id, "merge")
                    .gas(near_workspaces::types::Gas::from_tgas(50))
                    .transact()
                    .await
            )?
            .into_result()?;
            for _ in 0..30 {
                if !account_exists(&worker, &clone_id).await? {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            println!("merged {clone_id} home (it was never registered)");
        }
        let have = retry!(worker.view_account(&player_id).await)?.balance;
        let need = NearToken::from_millinear(2200);
        anyhow::ensure!(
            played || resume.is_some() || have >= need,
            "the player holds {have}; send {} more NEAR to {player_id}",
            NearToken::from_yoctonear(need.as_yoctonear() - have.as_yoctonear())
        );
        player
    } else {
        let player_key = SecretKey::from_random(KeyType::ED25519);
        save(&player_id, &player_key)?;
        house
            .create_subaccount("you")
            .initial_balance(NearToken::from_millinear(2250))
            .keys(player_key)
            .transact()
            .await?
            .into_result()?
    };
    println!("player  {EXPLORER}/address/{}", player.id());
    if !played {
        let open = resume.is_none();
        let guest = match resume {
            Some(seats) => {
                let bal = retry!(worker.view_account(player.id()).await)?.balance;
                Guest {
                    player,
                    seats,
                    events: Vec::new(),
                    balance_before: (bal.as_yoctonear() / 1_000_000_000_000_000_000_000) as u64,
                }
            }
            None => {
                enlist(
                    &worker,
                    &market,
                    player,
                    &leash_wasm,
                    &entrants,
                    NearToken::from_millinear(470),
                    Some(trade_key.clone()),
                )
                .await?
            }
        };

        // 4. The night, with the answer key computed first.
        let logs = run_night(
            &worker,
            "mainnet",
            &market,
            &house,
            vec![guest],
            seed,
            open,
            None,
        )
        .await?;
        let log = &logs[0];
        let out_path =
            std::env::var("OUT").unwrap_or_else(|_| "web/data/night-mainnet.json".into());
        std::fs::write(&out_path, serde_json::to_string_pretty(log)?)?;
        let matched = log.outcomes == log.answer_key;
        println!(
            "night on mainnet: {} events, answer key matched: {matched}, log in {out_path}",
            log.events.len()
        );
        anyhow::ensure!(matched, "the chain disagreed with the answer key");
    }

    // 5. Send what is left on the player and house accounts back to the owner.
    if let Some(to) = return_to {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let you = load(player_id.as_str())?;
        for acc in [&you, &house] {
            let bal = retry!(worker.view_account(acc.id()).await)?.balance;
            let send = bal.saturating_sub(NearToken::from_millinear(20));
            if !send.is_zero() {
                retry!(acc.transfer_near(&to, send).await)?.into_result()?;
                println!("returned {send} from {} to {to}", acc.id());
            }
        }
    }
    Ok(())
}
