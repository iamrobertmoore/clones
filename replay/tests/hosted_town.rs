//! The hosted town, on a local sandbox: two guests share one house key (a function-call key on
//! every clone), the keeper opens a new night, everyone trades at once, and at dawn every clone
//! merges home and each guest's balance is swept back to the house.

use clones_core::{Entrant, Temperament};
use clones_replay::{contracts, enlist, run_night};
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use serde_json::json;

fn entrants(ts: &[Temperament]) -> Vec<Entrant> {
    ts.iter()
        .enumerate()
        .map(|(i, t)| Entrant::new(&format!("clone-{}", i + 1), *t, 500))
        .collect()
}

#[tokio::test]
async fn two_guests_one_night_everyone_home() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let (market_wasm, leash_wasm) = contracts().await?;
    let market = worker.dev_deploy(&market_wasm).await?;
    let house_id = format!("house.{}", worker.root_account()?.id());
    market
        .call("new")
        .args_json(json!({ "seed": "0", "guests_under": house_id }))
        .transact()
        .await?
        .into_result()?;
    let keeper = market.as_account().clone();

    let key = SecretKey::from_random(KeyType::ED25519);
    let house = worker
        .root_account()?
        .create_subaccount("house")
        .initial_balance(NearToken::from_near(30))
        .keys(key.clone())
        .transact()
        .await?
        .into_result()?;

    let mut guests = Vec::new();
    for (name, ts) in [
        ("ga", vec![Temperament::Greedy]),
        (
            "gb",
            vec![
                Temperament::Cautious,
                Temperament::Greedy,
                Temperament::Loyal,
            ],
        ),
    ] {
        let player = house
            .create_subaccount(name)
            .initial_balance(NearToken::from_near(3))
            .keys(key.clone())
            .transact()
            .await?
            .into_result()?;
        guests.push(
            enlist(
                &worker,
                &market,
                player,
                &leash_wasm,
                &entrants(&ts),
                NearToken::from_millinear(450),
                Some(key.clone()),
            )
            .await?,
        );
    }

    let seed = 853;
    let logs = run_night(
        &worker,
        "sandbox",
        &market,
        &keeper,
        guests,
        seed,
        true,
        Some(house.id()),
    )
    .await?;

    assert_eq!(logs.len(), 2);
    for log in &logs {
        assert_eq!(log.outcomes, log.answer_key, "{} disagreed", log.player);
        assert!(
            log.player_balance_after <= 60,
            "{} was not swept home",
            log.player
        );
        let results: Vec<serde_json::Value> = market
            .view("get_results")
            .args_json(json!({ "player": log.player }))
            .await?
            .json()?;
        assert_eq!(results.len(), log.outcomes.len());
        assert!(results
            .iter()
            .all(|r| r["night"] == 1 && r["seed"] == "853"));
    }
    let town: serde_json::Value = market.view("get_town").await?.json()?;
    assert_eq!(town["clones_in_town"], 0, "everyone went home");
    Ok(())
}
