//! Prints how often each temperament goes broke over many seeds, and the demo seed's night.
use clones_core::*;
fn main() {
    let n = 5000u64;
    let mut broke = [0u32; 3];
    let mut avg = [0i64; 3];
    for seed in 0..n {
        for (i, o) in simulate(seed, &standard_entrants()).iter().enumerate() {
            broke[i] += o.broke as u32;
            avg[i] += o.final_cash as i64 - o.stake as i64;
        }
    }
    for (i, t) in ["cautious", "greedy", "loyal"].iter().enumerate() {
        println!(
            "{t:9} broke {:5.1}%  mean result {:+} mNEAR",
            broke[i] as f64 * 100.0 / n as f64,
            avg[i] / n as i64
        );
    }
    let night = simulate_town(853, NORMAL_STOCK, &standard_entrants());
    for o in &night.outcomes {
        println!(
            "853 {} {:?} {} broke={}",
            o.name, o.temperament, o.final_cash, o.broke
        );
    }
    println!(
        "853 amber by hour {:?}",
        night.prices.iter().map(|p| p[4]).collect::<Vec<_>>()
    );
}
