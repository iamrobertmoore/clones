//! How each temperament does in each mood of market, over many seeded nights.
//!
//!     cargo run -p clones-core --example balance
use clones_core::*;
const DEMO: u64 = 606;
fn main() {
    let n = 20_000u64;
    let mut stats = std::collections::BTreeMap::new();
    for seed in 0..n {
        let r = regime_of(seed);
        let e = stats
            .entry(format!("{r:?}"))
            .or_insert(([0i64; 3], [0u32; 3], 0u32));
        e.2 += 1;
        for (i, o) in simulate(seed, &standard_entrants()).iter().enumerate() {
            e.0[i] += o.final_cash as i64 - o.stake as i64;
            e.1[i] += o.broke as u32;
        }
    }
    let mut all = ([0i64; 3], [0u32; 3], 0u32);
    for (r, (sum, broke, k)) in &stats {
        print!("{r:6} ({k:5} nights) ");
        for (i, t) in ["cautious", "greedy", "loyal"].iter().enumerate() {
            print!(
                " {t} {:+5.1}% broke {:4.1}% |",
                sum[i] as f64 / *k as f64 / 20.0,
                broke[i] as f64 * 100.0 / *k as f64
            );
            all.0[i] += sum[i];
            all.1[i] += broke[i];
        }
        all.2 += k;
        println!();
    }
    print!("all    ({:5} nights) ", all.2);
    for (i, t) in ["cautious", "greedy", "loyal"].iter().enumerate() {
        print!(
            " {t} {:+5.1}% broke {:4.1}% |",
            all.0[i] as f64 / all.2 as f64 / 20.0,
            all.1[i] as f64 * 100.0 / all.2 as f64
        );
    }
    println!();
    let night = simulate(DEMO, &standard_entrants());
    println!(
        "seed {DEMO} is {:?}: {:?}",
        regime_of(DEMO),
        night
            .iter()
            .map(|o| (o.final_cash, o.broke))
            .collect::<Vec<_>>()
    );
}
