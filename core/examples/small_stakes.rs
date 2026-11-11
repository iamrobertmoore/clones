//! Seeds where three small-stake clones play a night with the greedy one going broke.
use clones_core::*;
fn main() {
    for stake in [250u64, 500] {
        let e: Vec<Entrant> = [
            ("clone-1", Temperament::Cautious),
            ("clone-2", Temperament::Greedy),
            ("clone-3", Temperament::Loyal),
        ]
        .iter()
        .map(|(n, t)| Entrant::new(n, *t, stake))
        .collect();
        println!("stake {stake}");
        println!(
            "606: {:?}",
            simulate(606, &e)
                .iter()
                .map(|o| (o.final_cash, o.broke))
                .collect::<Vec<_>>()
        );
        let mut n = 0;
        for seed in 0..3000u64 {
            let o = simulate(seed, &e);
            if o[1].broke && o[0].final_cash > o[0].stake && o[2].final_cash >= o[2].stake {
                println!(
                    "{seed} {:?} {:?}",
                    regime_of(seed),
                    o.iter().map(|x| x.final_cash).collect::<Vec<_>>()
                );
                n += 1;
                if n == 4 {
                    break;
                }
            }
        }
    }
}
