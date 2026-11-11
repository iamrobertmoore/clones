//! Writes the golden nights that the JavaScript copy of these rules (web/lib/rules.js) must
//! reproduce exactly. Run after any rule change:
//!
//!     cargo run -p clones-core --example golden > web/lib/golden.json
use clones_core::*;
use serde_json::json;

fn main() {
    print!("{}", golden());
}

pub fn golden() -> String {
    let mut cases = Vec::new();
    for seed in [0u64, 1, 7, 42, 99, 853, 1349, 4242, 65_537, 999_983] {
        let mut late = Entrant::new("clone-2", Temperament::Greedy, 700);
        late.nights = 3;
        late.played = 1;
        late.carried = Some(Ledger {
            cash: 300,
            stock: [0, 4, 0, 0, 3],
        });
        let sets = vec![
            standard_entrants(),
            vec![
                Entrant::new("clone-1", Temperament::Greedy, 1000),
                late,
                Entrant::new("clone-3", Temperament::Greedy, 250),
                Entrant::new("clone-1", Temperament::Cautious, 500),
                Entrant::new("clone-2", Temperament::Loyal, 2000),
            ],
        ];
        let stocks = [NORMAL_STOCK, [700, 1500, 590, 101, 400]];
        for (i, entrants) in sets.into_iter().enumerate() {
            let stock = stocks[i];
            let night = simulate_town(seed, stock, &entrants);
            cases.push(
                json!({ "seed": seed, "stock": stock, "entrants": entrants, "night": night }),
            );
        }
    }
    serde_json::to_string(&json!({ "cases": cases })).unwrap()
}
