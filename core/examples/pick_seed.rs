//! Seeds for a demo night where the greedy clone goes broke and the other two come home ahead.
use clones_core::*;
fn main() {
    for seed in 0..5000u64 {
        let o = simulate(seed, &standard_entrants());
        if o[1].broke && o[0].final_cash > 2150 && o[2].final_cash > 2030 {
            println!(
                "{seed} {:?} {:?}",
                regime_of(seed),
                o.iter().map(|x| x.final_cash).collect::<Vec<_>>()
            );
        }
    }
}
