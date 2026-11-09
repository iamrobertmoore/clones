//! One night in 60 seconds, headless.
//!
//!     cargo run -p clones-replay                 # seed 853, writes replay.json
//!     cargo run -p clones-replay -- 42 out.json  # another seed, another file

use clones_replay::{run_sandbox_night, Event, DEMO_SEED};

fn nears(milli: u64) -> String {
    format!("{}.{:03} NEAR", milli / 1000, milli % 1000)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let seed: u64 = args
        .next()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(DEMO_SEED);
    let out = args.next().unwrap_or_else(|| "replay.json".into());

    println!("Night {seed}: starting a local NEAR node and sending three clones into town...");
    let log = run_sandbox_night(seed).await?;

    for e in &log.events {
        match e {
            Event::CloneCreated {
                clone, temperament, ..
            } => println!("  {clone} created ({temperament:?}), its only key can call the market"),
            Event::SentIn { clone, stake, .. } => {
                println!("  {clone} sent in with {}", nears(*stake))
            }
            Event::Hour { round, prices } => println!("hour {round:>2}  prices {prices:?}"),
            Event::Bubble { clone, say, .. } => println!("  {clone}: \"{say}\""),
            Event::Order {
                clone,
                side,
                qty,
                good,
                price,
                ..
            } => println!("    {clone} {side:?} {qty} {good} @ {price}"),
            Event::OrderFailed { clone, error, .. } => {
                println!("    {clone} order failed: {error}")
            }
            Event::WithdrawRefused { clone, error } => {
                let why = if error.contains("RequiresFullAccess") {
                    "RequiresFullAccess"
                } else {
                    "refused"
                };
                println!("  CHAIN REFUSED {clone}'s withdrawal: {why}")
            }
            Event::Settled {
                clone,
                paid_out,
                broke,
                ..
            } => println!(
                "  {clone} settled: {}{}",
                nears(*paid_out),
                if *broke { " (broke)" } else { "" }
            ),
            Event::Merged {
                clone,
                clone_deleted,
                ..
            } => println!("  {clone} merged home, account deleted: {clone_deleted}"),
        }
    }

    let matches = log.outcomes == log.answer_key;
    println!(
        "player balance {} -> {}",
        nears(log.player_balance_before),
        nears(log.player_balance_after)
    );
    println!(
        "chain matches the answer key: {}",
        if matches { "yes" } else { "NO" }
    );
    std::fs::write(&out, serde_json::to_string_pretty(&log)?)?;
    println!("log written to {out}");
    anyhow::ensure!(matches, "the chain disagreed with the answer key");
    Ok(())
}
