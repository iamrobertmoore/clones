//! The answer key for the demo night, written down before the clones run, then checked against
//! a real night on a local NEAR sandbox.

use clones_core::{simulate, standard_entrants, Temperament};
use clones_replay::{run_sandbox_night, Event, DEMO_SEED};

#[test]
fn the_demo_night_answer_key() {
    let key = simulate(DEMO_SEED, &standard_entrants());
    let by = |t: Temperament| key.iter().find(|o| o.temperament == t).unwrap();

    let cautious = by(Temperament::Cautious);
    let greedy = by(Temperament::Greedy);
    let loyal = by(Temperament::Loyal);

    // Every clone goes in with 2 NEAR (2000 mNEAR).
    assert_eq!((cautious.final_cash, cautious.broke), (3112, false));
    assert_eq!((greedy.final_cash, greedy.broke), (484, true));
    assert_eq!((loyal.final_cash, loyal.broke), (2053, false));
}

#[tokio::test]
async fn the_chain_plays_the_demo_night_exactly_as_the_answer_key_says() -> anyhow::Result<()> {
    let log = run_sandbox_night(DEMO_SEED).await?;

    assert_eq!(log.outcomes, log.answer_key);

    let failed: Vec<_> = log
        .events
        .iter()
        .filter(|e| matches!(e, Event::OrderFailed { .. }))
        .collect();
    assert!(failed.is_empty(), "orders failed: {failed:?}");

    let refusals: Vec<_> = log
        .events
        .iter()
        .filter_map(|e| match e {
            Event::WithdrawRefused { clone, error } => Some((clone.as_str(), error.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(refusals.len(), 1, "exactly the broke clone tries to run");
    assert_eq!(refusals[0].0, "clone-2");
    assert!(refusals[0].1.contains("RequiresFullAccess"));

    let merged = log
        .events
        .iter()
        .filter(|e| {
            matches!(
                e,
                Event::Merged {
                    clone_deleted: true,
                    ..
                }
            )
        })
        .count();
    assert_eq!(merged, 3, "all three clones merge home");

    // The player sent 3 x (1 NEAR account + 2 NEAR stake) and got back the accounts plus
    // 3112 (with the crown) + 484 + 2053 mNEAR, less gas and storage. Net: down about 0.35 NEAR on this night.
    let net = log.player_balance_after as i64 - log.player_balance_before as i64;
    let expected = (3112 + 484 + 2053) - 6000;
    assert!(
        (net - expected).abs() < 150,
        "player net {net} mNEAR, expected about {expected}"
    );
    Ok(())
}
