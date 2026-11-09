//! The rules of the town.
//!
//! The market contract runs these functions on chain to clear every trade, and the replay runs the
//! very same functions off chain to compute the answer key before any clone moves. All amounts are
//! in milliNEAR (1 NEAR = 1000), all arithmetic is integer, and every price comes from the night's
//! seed, so a night is fully determined by its seed and the clones' orders.

use serde::{Deserialize, Serialize};

/// The five goods. The index is used everywhere a good is stored.
pub const GOODS: [&str; 5] = ["grain", "salt", "wool", "iron", "amber"];

/// Merchant prices at the start of every night, in milliNEAR per unit.
pub const BASE_PRICE: [u64; 5] = [20, 30, 50, 80, 120];

/// The town takes 2% of every trade, at least 1 milliNEAR.
pub const FEE_BPS: u64 = 200;

/// Hours in a night. Clones act once per hour; prices move between hours.
pub const ROUNDS: u32 = 12;

/// A clone whose worth falls below a quarter of its stake is broke.
pub const BROKE_DIVISOR: u64 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Temperament {
    Cautious,
    Greedy,
    Loyal,
}

pub fn good_index(name: &str) -> Option<usize> {
    GOODS.iter().position(|g| *g == name)
}

/// splitmix64: a small, well-known mixing function. Same input, same output, on any machine.
pub fn mix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// One hour's move for one good: between -20% and +20% in whole percent; amber moves twice as hard.
fn step(seed: u64, round: u32, good: usize, prev: u64) -> u64 {
    let h = mix(seed ^ ((round as u64) << 8) ^ good as u64);
    let mut pct = (h % 41) as i64 - 20;
    if good == 4 {
        pct *= 2;
    }
    let next = prev as i64 * (100 + pct) / 100;
    next.max(1) as u64
}

/// Merchant prices at a given hour of the night.
pub fn prices_at(seed: u64, round: u32) -> [u64; 5] {
    let mut p = BASE_PRICE;
    for r in 1..=round {
        for (g, price) in p.iter_mut().enumerate() {
            *price = step(seed, r, g, *price);
        }
    }
    p
}

pub fn fee(notional: u64) -> u64 {
    (notional * FEE_BPS).div_ceil(10_000).max(1)
}

/// What a clone holds in town.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    pub cash: u64,
    pub stock: [u32; 5],
}

impl Ledger {
    pub fn worth(&self, prices: &[u64; 5]) -> u64 {
        self.cash
            + self
                .stock
                .iter()
                .zip(prices)
                .map(|(q, p)| *q as u64 * p)
                .sum::<u64>()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub price: u64,
    pub fee: u64,
}

/// Clear one order against the town merchant at the current price. Fill or kill.
pub fn fill(
    l: &mut Ledger,
    good: usize,
    side: Side,
    qty: u32,
    limit: u64,
    price: u64,
) -> Result<Fill, &'static str> {
    if good >= GOODS.len() {
        return Err("unknown good");
    }
    if qty == 0 {
        return Err("quantity must be positive");
    }
    let notional = price * qty as u64;
    match side {
        Side::Buy => {
            if limit < price {
                return Err("limit is below the merchant's price");
            }
            let f = fee(notional);
            if notional + f > l.cash {
                return Err("not enough cash for that order");
            }
            l.cash -= notional + f;
            l.stock[good] += qty;
            Ok(Fill { price, fee: f })
        }
        Side::Sell => {
            if limit > price {
                return Err("limit is above the merchant's price");
            }
            if l.stock[good] < qty {
                return Err("not enough stock to sell");
            }
            let f = fee(notional).min(notional);
            l.stock[good] -= qty;
            l.cash += notional - f;
            Ok(Fill { price, fee: f })
        }
    }
}

/// Sell everything at the given prices. Returns the fees paid.
pub fn liquidate(l: &mut Ledger, prices: &[u64; 5]) -> u64 {
    let mut fees = 0;
    for (g, &price) in prices.iter().enumerate() {
        let q = l.stock[g];
        if q > 0 {
            fees += fill(l, g, Side::Sell, q, price, price)
                .expect("selling held stock at the merchant price always fills")
                .fee;
        }
    }
    fees
}

pub fn is_broke(worth: u64, stake: u64) -> bool {
    worth < stake / BROKE_DIVISOR
}

/// What a clone sees when it is its turn.
#[derive(Clone, Copy, Debug)]
pub struct View {
    pub round: u32,
    pub prices: [u64; 5],
    pub prev: [u64; 5],
    pub ledger: Ledger,
    pub stake: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Intent {
    pub good: usize,
    pub side: Side,
    pub qty: u32,
    pub limit: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub intents: Vec<Intent>,
    /// The clone's reasoning, shown in its speech bubble.
    pub say: String,
}

/// How many units a budget buys at a price, fee included.
pub fn affordable(budget: u64, price: u64) -> u32 {
    let mut q = (budget / price) as u32;
    while q > 0 && price * q as u64 + fee(price * q as u64) > budget {
        q -= 1;
    }
    q
}

fn change_pct(v: &View, g: usize) -> i64 {
    (v.prices[g] as i64 - v.prev[g] as i64) * 100 / v.prev[g] as i64
}

fn sell_all(v: &View, g: usize) -> Intent {
    Intent {
        good: g,
        side: Side::Sell,
        qty: v.ledger.stock[g],
        limit: v.prices[g],
    }
}

/// Each temperament is a fixed policy, so a seeded night always plays out the same way.
pub fn decide(t: Temperament, v: &View) -> Decision {
    let mut d = match t {
        Temperament::Greedy => greedy(v),
        Temperament::Cautious => cautious(v),
        Temperament::Loyal => loyal(v),
    };
    if let Some(first) = d.say.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    d
}

/// Chases whatever rose most this hour, with everything it has.
fn greedy(v: &View) -> Decision {
    let best = (0..5).max_by_key(|g| (change_pct(v, *g), *g)).unwrap();
    let mut intents: Vec<Intent> = (0..5)
        .filter(|g| *g != best && v.ledger.stock[*g] > 0)
        .map(|g| sell_all(v, g))
        .collect();
    let mut cash = v.ledger.cash;
    for i in &intents {
        let n = v.prices[i.good] * i.qty as u64;
        cash += n - fee(n).min(n);
    }
    let qty = affordable(cash, v.prices[best]);
    let up = change_pct(v, best);
    let say = if qty > 0 {
        intents.push(Intent {
            good: best,
            side: Side::Buy,
            qty,
            limit: v.prices[best],
        });
        if up > 0 {
            format!("{} is up {}%. Everything in.", GOODS[best], up)
        } else {
            format!("Nothing's rising, so {} it is. All of it.", GOODS[best])
        }
    } else if v.ledger.stock[best] > 0 {
        format!("All in on {} already. Hold.", GOODS[best])
    } else {
        "Out of cash. Need a way out of this town.".to_string()
    };
    Decision { intents, say }
}

/// Buys only what is cheap against its usual price, a quarter of its cash at a time, and takes
/// profit at +10%.
fn cautious(v: &View) -> Decision {
    let mut intents = Vec::new();
    let mut said = Vec::new();
    for g in 0..5 {
        if v.ledger.stock[g] > 0 && v.prices[g] * 10 >= BASE_PRICE[g] * 11 {
            intents.push(sell_all(v, g));
            said.push(format!("{} is 10% over usual, taking profit", GOODS[g]));
        }
    }
    let cheapest = (0..5)
        .min_by_key(|g| (v.prices[*g] * 1000 / BASE_PRICE[*g], *g))
        .unwrap();
    if v.prices[cheapest] * 10 <= BASE_PRICE[cheapest] * 9 && v.ledger.stock[cheapest] == 0 {
        let qty = affordable(v.ledger.cash / 4, v.prices[cheapest]);
        if qty > 0 {
            intents.push(Intent {
                good: cheapest,
                side: Side::Buy,
                qty,
                limit: v.prices[cheapest],
            });
            said.push(format!("{} is cheap, buying a little", GOODS[cheapest]));
        }
    }
    let say = if said.is_empty() {
        "Nothing worth the risk this hour.".to_string()
    } else {
        said.join("; ") + "."
    };
    Decision { intents, say }
}

/// Trades only the staples (grain and salt), never risks more than a third of its cash, and keeps
/// your money safe above all.
fn loyal(v: &View) -> Decision {
    let mut intents = Vec::new();
    let mut said = Vec::new();
    for g in 0..2 {
        if v.ledger.stock[g] > 0 && v.prices[g] > BASE_PRICE[g] {
            intents.push(sell_all(v, g));
            said.push(format!("selling {} above its usual price", GOODS[g]));
        } else if v.ledger.stock[g] == 0 && v.prices[g] < BASE_PRICE[g] {
            let qty = affordable(v.ledger.cash / 3 / 2, v.prices[g]);
            if qty > 0 {
                intents.push(Intent {
                    good: g,
                    side: Side::Buy,
                    qty,
                    limit: v.prices[g],
                });
                said.push(format!("{} is below usual, a small buy", GOODS[g]));
            }
        }
    }
    let say = if said.is_empty() {
        "Keeping your money safe. Staples only.".to_string()
    } else {
        said.join("; ") + "."
    };
    Decision { intents, say }
}

/// One clone sent into town for the night.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entrant {
    pub name: String,
    pub temperament: Temperament,
    pub stake: u64,
}

/// The answer key: what each clone ends the night with, computed without touching the chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub name: String,
    pub temperament: Temperament,
    pub stake: u64,
    /// Cash after everything is sold at the final prices.
    pub final_cash: u64,
    pub broke: bool,
    pub orders: u32,
}

/// Play a whole night off chain with the same rules the contract uses.
pub fn simulate(seed: u64, entrants: &[Entrant]) -> Vec<Outcome> {
    let mut ledgers: Vec<Ledger> = entrants
        .iter()
        .map(|e| Ledger {
            cash: e.stake,
            stock: [0; 5],
        })
        .collect();
    let mut orders = vec![0u32; entrants.len()];
    for round in 0..ROUNDS {
        let prices = prices_at(seed, round);
        let prev = if round == 0 {
            prices
        } else {
            prices_at(seed, round - 1)
        };
        for (i, e) in entrants.iter().enumerate() {
            let view = View {
                round,
                prices,
                prev,
                ledger: ledgers[i],
                stake: e.stake,
            };
            for intent in decide(e.temperament, &view).intents {
                if fill(
                    &mut ledgers[i],
                    intent.good,
                    intent.side,
                    intent.qty,
                    intent.limit,
                    prices[intent.good],
                )
                .is_ok()
                {
                    orders[i] += 1;
                }
            }
        }
    }
    let last = prices_at(seed, ROUNDS);
    entrants
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let mut l = ledgers[i];
            liquidate(&mut l, &last);
            Outcome {
                name: e.name.clone(),
                temperament: e.temperament,
                stake: e.stake,
                final_cash: l.cash,
                broke: is_broke(l.cash, e.stake),
                orders: orders[i],
            }
        })
        .collect()
}

/// The three clones every replay sends in: one of each temperament, 2 NEAR each.
pub fn standard_entrants() -> Vec<Entrant> {
    [
        ("clone-1", Temperament::Cautious),
        ("clone-2", Temperament::Greedy),
        ("clone-3", Temperament::Loyal),
    ]
    .iter()
    .map(|(n, t)| Entrant {
        name: n.to_string(),
        temperament: *t,
        stake: 2000,
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prices_are_a_pure_function_of_seed_and_hour() {
        assert_eq!(prices_at(7, 0), BASE_PRICE);
        assert_eq!(prices_at(7, 5), prices_at(7, 5));
        assert_ne!(prices_at(7, 5), prices_at(8, 5));
        for r in 0..=ROUNDS {
            assert!(prices_at(7, r).iter().all(|p| *p >= 1));
        }
    }

    #[test]
    fn buy_then_sell_costs_two_fees() {
        let mut l = Ledger {
            cash: 1000,
            stock: [0; 5],
        };
        let f = fill(&mut l, 0, Side::Buy, 10, 20, 20).unwrap();
        assert_eq!(f.fee, 4);
        assert_eq!(l.cash, 1000 - 200 - 4);
        assert_eq!(l.stock[0], 10);
        fill(&mut l, 0, Side::Sell, 10, 20, 20).unwrap();
        assert_eq!(l.cash, 1000 - 8);
    }

    #[test]
    fn fills_refuse_bad_orders() {
        let mut l = Ledger {
            cash: 100,
            stock: [0; 5],
        };
        assert!(fill(&mut l, 0, Side::Buy, 10, 20, 20).is_err(), "too poor");
        assert!(
            fill(&mut l, 0, Side::Buy, 1, 19, 20).is_err(),
            "limit too low"
        );
        assert!(fill(&mut l, 0, Side::Sell, 1, 20, 20).is_err(), "no stock");
        assert!(
            fill(&mut l, 9, Side::Buy, 1, 20, 20).is_err(),
            "no such good"
        );
        assert_eq!(l.cash, 100, "a refused order changes nothing");
    }

    #[test]
    fn affordable_includes_the_fee() {
        assert_eq!(affordable(1000, 100), 9);
        assert_eq!(affordable(99, 100), 0);
    }

    #[test]
    fn every_policy_only_places_orders_that_fill() {
        for seed in 0..200 {
            for e in standard_entrants() {
                let mut l = Ledger {
                    cash: e.stake,
                    stock: [0; 5],
                };
                for round in 0..ROUNDS {
                    let prices = prices_at(seed, round);
                    let prev = prices_at(seed, round.saturating_sub(1));
                    let v = View {
                        round,
                        prices,
                        prev,
                        ledger: l,
                        stake: e.stake,
                    };
                    for i in decide(e.temperament, &v).intents {
                        fill(&mut l, i.good, i.side, i.qty, i.limit, prices[i.good])
                            .unwrap_or_else(|err| panic!("seed {seed} {:?}: {err}", e.temperament));
                    }
                }
            }
        }
    }

    #[test]
    fn simulate_is_deterministic() {
        assert_eq!(
            simulate(7, &standard_entrants()),
            simulate(7, &standard_entrants())
        );
    }
}
