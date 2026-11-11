//! The rules of the town.
//!
//! The market contract runs these functions on chain to clear every trade, and the night runner
//! runs the very same functions off chain to compute the answer key before any clone moves. All
//! amounts are in milliNEAR (1 NEAR = 1000) and all arithmetic is integer.
//!
//! A price has two parts. The night's seed sets each good's usual price for every hour (a random
//! walk). The merchant's stock scales it: when clones buy a good the merchant runs short and
//! charges more; when they sell it the merchant is long and pays less. A big order moves the price
//! against itself (the merchant quotes the price after the trade), so a clone cannot profit from
//! its own buying. Every order in an hour is quoted from the merchant's stock when the hour began,
//! so the order in which clones act never changes the result: a night is fully determined by its
//! seed, the merchant's stock at dusk and the clones in town.

use serde::{Deserialize, Serialize};

/// The five goods. The index is used everywhere a good is stored.
pub const GOODS: [&str; 5] = ["grain", "salt", "wool", "iron", "amber"];

/// Usual prices at dusk, in milliNEAR per unit.
pub const BASE_PRICE: [u64; 5] = [20, 30, 50, 80, 120];

/// How much of each good the merchant keeps when nothing has disturbed the market.
pub const NORMAL_STOCK: [i64; 5] = [1200, 900, 600, 360, 240];

/// The town takes 2% of every trade, at least 1 milliNEAR.
pub const FEE_BPS: u64 = 200;

/// Hours in a night. Clones act once per hour; prices move between hours.
pub const ROUNDS: u32 = 12;

/// A clone whose worth falls below a quarter of its stake is broke.
pub const BROKE_DIVISOR: u64 = 4;

/// Nights a clone may be sent out for before it must come home.
pub const MAX_NIGHTS: u32 = 3;

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

/// One hour's move for one good: a shock between -20% and +20% in whole percent (amber twice as
/// hard), plus a pull back toward the usual price of a fifth of the gap. Prices wander and return,
/// so buying cheap and selling dear pays over a night and chasing a rise usually does not.
fn step(seed: u64, round: u32, good: usize, prev: u64) -> u64 {
    let h = mix(seed ^ ((round as u64) << 8) ^ good as u64);
    let mut pct = (h % 41) as i64 - 20;
    if good == 4 {
        pct *= 2;
    }
    let base = BASE_PRICE[good] as i64;
    pct += (base - prev as i64) * REVERSION_PCT / base;
    let next = prev as i64 * (100 + pct) / 100;
    next.max(1) as u64
}

/// How hard a price is pulled back toward usual each hour, in percent of the gap.
pub const REVERSION_PCT: i64 = 25;

/// The usual price of each good at a given hour, before the merchant's stock counts.
pub fn prices_at(seed: u64, round: u32) -> [u64; 5] {
    let mut p = BASE_PRICE;
    for r in 1..=round {
        for (g, price) in p.iter_mut().enumerate() {
            *price = step(seed, r, g, *price);
        }
    }
    p
}

/// The merchant's stock of each good. Signed, so heavy buying never makes an order fail: the
/// merchant can always find more, at a price.
pub type Stock = [i64; 5];

/// What the merchant charges for a good: the usual price times how short of its normal stock it
/// is. Bounded between a quarter and four times the usual price.
pub fn stocked_price(usual: u64, normal: i64, held: i64) -> u64 {
    let held = held.clamp(normal / 4, normal * 4) as u64;
    (usual * normal as u64 / held).max(1)
}

/// Overnight the merchant restocks halfway back to normal.
pub fn restock(stock: &Stock) -> Stock {
    let mut s = *stock;
    for g in 0..5 {
        s[g] += (NORMAL_STOCK[g] - s[g]) / 2;
    }
    s
}

/// A clone's trade moves the merchant's stock the other way.
pub fn move_stock(stock: &mut Stock, good: usize, side: Side, qty: u32) {
    match side {
        Side::Buy => stock[good] -= qty as i64,
        Side::Sell => stock[good] += qty as i64,
    }
}

/// The merchant as it stands when an hour begins: tonight's usual prices and its stock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Book {
    pub usual: [u64; 5],
    pub stock: Stock,
}

impl Book {
    pub fn at(seed: u64, round: u32, stock: Stock) -> Self {
        Book {
            usual: prices_at(seed, round),
            stock,
        }
    }

    /// The price on the board: what one unit costs right now.
    pub fn board(&self) -> [u64; 5] {
        let mut p = [0; 5];
        for g in 0..5 {
            p[g] = stocked_price(self.usual[g], NORMAL_STOCK[g], self.stock[g]);
        }
        p
    }

    /// The unit price for an order of `qty`: the merchant quotes its price after the trade.
    pub fn quote(&self, good: usize, side: Side, qty: u32) -> u64 {
        let after = match side {
            Side::Buy => self.stock[good] - qty as i64,
            Side::Sell => self.stock[good] + qty as i64,
        };
        stocked_price(self.usual[good], NORMAL_STOCK[good], after)
    }
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
    /// What the clone would have if it sold everything now: its worth, and what it is paid when it
    /// comes home.
    pub fn worth(&self, book: &Book) -> u64 {
        let mut l = *self;
        liquidate(&mut l, book);
        l.cash
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub price: u64,
    pub fee: u64,
}

/// Clear one order against the merchant at the given unit price. Fill or kill.
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

/// Sell everything to the merchant. Returns the fees paid. Each good is quoted on its own from
/// the book, so the result does not depend on the order goods are sold in.
pub fn liquidate(l: &mut Ledger, book: &Book) -> u64 {
    let mut fees = 0;
    for g in 0..5 {
        let q = l.stock[g];
        if q > 0 {
            let price = book.quote(g, Side::Sell, q);
            fees += fill(l, g, Side::Sell, q, price, price)
                .expect("selling held stock at the merchant's quote always fills")
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
    pub book: Book,
    /// The board this hour and last hour.
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

/// How many units of a good a budget buys, fee and the price moving against the order included.
pub fn affordable(budget: u64, book: &Book, good: usize) -> u32 {
    let cost = |q: u32| {
        let n = book.quote(good, Side::Buy, q) * q as u64;
        n + fee(n)
    };
    let mut q = (budget / book.quote(good, Side::Buy, 1)) as u32;
    while q > 0 && cost(q) > budget {
        q -= 1;
    }
    q
}

fn change_pct(v: &View, g: usize) -> i64 {
    (v.prices[g] as i64 - v.prev[g] as i64) * 100 / v.prev[g] as i64
}

fn sell_all(v: &View, g: usize) -> Intent {
    let qty = v.ledger.stock[g];
    Intent {
        good: g,
        side: Side::Sell,
        qty,
        limit: v.book.quote(g, Side::Sell, qty),
    }
}

fn buy(v: &View, g: usize, qty: u32) -> Intent {
    Intent {
        good: g,
        side: Side::Buy,
        qty,
        limit: v.book.quote(g, Side::Buy, qty),
    }
}

/// What selling an intent pays, after the fee.
fn proceeds(i: &Intent) -> u64 {
    let n = i.limit * i.qty as u64;
    n - fee(n).min(n)
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
    let cash = v.ledger.cash + intents.iter().map(proceeds).sum::<u64>();
    let qty = affordable(cash, &v.book, best);
    let up = change_pct(v, best);
    let say = if qty > 0 {
        intents.push(buy(v, best, qty));
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
        let qty = affordable(v.ledger.cash / 4, &v.book, cheapest);
        if qty > 0 {
            intents.push(buy(v, cheapest, qty));
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
            let qty = affordable(v.ledger.cash / 3 / 2, &v.book, g);
            if qty > 0 {
                intents.push(buy(v, g, qty));
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

/// Apply one clone's whole turn, all or nothing (as the contract does): every order must fill.
/// Moves the merchant's stock for each fill. Returns the fills, or the first refusal.
pub fn apply_turn(
    l: &mut Ledger,
    stock: &mut Stock,
    book: &Book,
    intents: &[Intent],
) -> Result<Vec<Fill>, &'static str> {
    let mut nl = *l;
    let mut ns = *stock;
    let mut fills = Vec::new();
    for i in intents {
        if i.good >= GOODS.len() {
            return Err("unknown good");
        }
        let price = book.quote(i.good, i.side, i.qty);
        fills.push(fill(&mut nl, i.good, i.side, i.qty, i.limit, price)?);
        move_stock(&mut ns, i.good, i.side, i.qty);
    }
    *l = nl;
    *stock = ns;
    Ok(fills)
}

fn one() -> u32 {
    1
}

fn yes() -> bool {
    true
}

/// One clone in town for the night.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entrant {
    pub name: String,
    pub temperament: Temperament,
    pub stake: u64,
    /// Nights the player sent it out for (1 to 3). It comes home at the dawn after the last one.
    #[serde(default = "one")]
    pub nights: u32,
    /// Nights it has already played.
    #[serde(default)]
    pub played: u32,
    /// What it holds from earlier nights; `None` for a clone on its first night (cash = stake).
    #[serde(default)]
    pub carried: Option<Ledger>,
}

impl Entrant {
    pub fn new(name: &str, temperament: Temperament, stake: u64) -> Self {
        Entrant {
            name: name.to_string(),
            temperament,
            stake,
            nights: 1,
            played: 0,
            carried: None,
        }
    }

    pub fn start(&self) -> Ledger {
        self.carried.unwrap_or(Ledger {
            cash: self.stake,
            stock: [0; 5],
        })
    }
}

/// The answer key: what each clone ends the night with, computed without touching the chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    pub name: String,
    pub temperament: Temperament,
    pub stake: u64,
    /// Cash after everything it holds is sold at dawn: what it is paid if it comes home.
    pub final_cash: u64,
    pub broke: bool,
    /// Orders placed tonight.
    pub orders: u32,
    /// Whether it comes home at this dawn (its last night, or broke). A clone that stays keeps
    /// its goods and plays the next night.
    #[serde(default = "yes")]
    pub home: bool,
}

/// Whether a clone comes home at this dawn.
pub fn comes_home(e: &Entrant, broke: bool) -> bool {
    broke || e.played + 1 >= e.nights
}

/// A whole night for the town, computed off chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Night {
    pub outcomes: Vec<Outcome>,
    /// The board at every hour, 0 (dusk) to ROUNDS (dawn).
    pub prices: Vec<[u64; 5]>,
    /// The merchant's stock at every hour, 0 (dusk) to ROUNDS (dawn).
    pub stock: Vec<Stock>,
    /// The merchant's stock once the clones that come home have sold up.
    pub stock_end: Stock,
    /// What each clone holds at dawn before anything is sold (what a clone that stays carries).
    pub held: Vec<Ledger>,
}

/// Play a whole night off chain with the same rules the contract uses. `stock` is the merchant's
/// stock at dusk (after the overnight restock).
pub fn simulate_town(seed: u64, stock: Stock, entrants: &[Entrant]) -> Night {
    let mut stock = stock;
    let mut ledgers: Vec<Ledger> = entrants.iter().map(Entrant::start).collect();
    let mut orders = vec![0u32; entrants.len()];
    let mut boards = Vec::new();
    let mut stocks = Vec::new();
    let mut prev = Book::at(seed, 0, stock).board();
    for round in 0..ROUNDS {
        // The book is fixed when the hour begins; trades during it move the stock, which shows in
        // the next hour's prices.
        let book = Book::at(seed, round, stock);
        let prices = book.board();
        boards.push(prices);
        stocks.push(stock);
        let mut moved = stock;
        for (i, e) in entrants.iter().enumerate() {
            let d = decide(
                e.temperament,
                &View {
                    round,
                    book,
                    prices,
                    prev,
                    ledger: ledgers[i],
                    stake: e.stake,
                },
            );
            if d.intents.is_empty() {
                continue;
            }
            if apply_turn(&mut ledgers[i], &mut moved, &book, &d.intents).is_ok() {
                orders[i] += d.intents.len() as u32;
            }
        }
        stock = moved;
        prev = prices;
    }
    let dawn = Book::at(seed, ROUNDS, stock);
    boards.push(dawn.board());
    stocks.push(stock);
    let held = ledgers.clone();
    let mut outcomes = Vec::new();
    for (i, e) in entrants.iter().enumerate() {
        let worth = ledgers[i].worth(&dawn);
        let broke = is_broke(worth, e.stake);
        let home = comes_home(e, broke);
        if home {
            for (g, q) in ledgers[i].stock.iter().enumerate() {
                move_stock(&mut stock, g, Side::Sell, *q);
            }
        }
        outcomes.push(Outcome {
            name: e.name.clone(),
            temperament: e.temperament,
            stake: e.stake,
            final_cash: worth,
            broke,
            orders: orders[i],
            home,
        });
    }
    Night {
        outcomes,
        prices: boards,
        stock: stocks,
        stock_end: stock,
        held,
    }
}

/// One night from a quiet market (the merchant at normal stock).
pub fn simulate(seed: u64, entrants: &[Entrant]) -> Vec<Outcome> {
    simulate_town(seed, NORMAL_STOCK, entrants).outcomes
}

/// The three clones every replay sends in: one of each temperament, 2 NEAR each.
pub fn standard_entrants() -> Vec<Entrant> {
    [
        ("clone-1", Temperament::Cautious),
        ("clone-2", Temperament::Greedy),
        ("clone-3", Temperament::Loyal),
    ]
    .iter()
    .map(|(n, t)| Entrant::new(n, *t, 2000))
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet(seed: u64, round: u32) -> Book {
        Book::at(seed, round, NORMAL_STOCK)
    }

    #[test]
    fn a_quiet_market_shows_the_usual_prices() {
        assert_eq!(quiet(7, 0).board(), BASE_PRICE);
        assert_eq!(prices_at(7, 5), prices_at(7, 5));
        assert_ne!(prices_at(7, 5), prices_at(8, 5));
        for r in 0..=ROUNDS {
            assert!(quiet(7, r).board().iter().all(|p| *p >= 1));
        }
    }

    #[test]
    fn buying_makes_the_merchant_short_and_the_price_rise() {
        let mut stock = NORMAL_STOCK;
        move_stock(&mut stock, 4, Side::Buy, 48);
        let after = Book::at(7, 0, stock).board();
        assert_eq!(
            after[4],
            120 * 240 / 192,
            "48 of 240 amber bought: 25% dearer"
        );
        move_stock(&mut stock, 4, Side::Sell, 168);
        assert_eq!(Book::at(7, 0, stock).board()[4], 120 * 240 / 360);
    }

    #[test]
    fn prices_stay_within_a_quarter_and_four_times_usual() {
        assert_eq!(stocked_price(100, 80, -500), 400);
        assert_eq!(stocked_price(100, 80, 10_000), 25);
    }

    #[test]
    fn a_big_order_moves_the_price_against_itself() {
        let b = quiet(7, 0);
        assert!(b.quote(4, Side::Buy, 20) > b.board()[4]);
        assert!(b.quote(4, Side::Sell, 20) < b.board()[4]);
        assert_eq!(b.quote(0, Side::Buy, 0), b.board()[0]);
    }

    #[test]
    fn buying_and_selling_back_never_pays() {
        // Buy at dusk, let the price rise from your own buying, sell back next hour: a loss.
        for q in [1u32, 5, 20, 60] {
            let mut stock = NORMAL_STOCK;
            let b0 = Book {
                usual: BASE_PRICE,
                stock,
            };
            let mut l = Ledger {
                cash: 100_000,
                stock: [0; 5],
            };
            apply_turn(&mut l, &mut stock, &b0, &[buy_intent(&b0, 4, q)]).unwrap();
            let b1 = Book {
                usual: BASE_PRICE,
                stock,
            };
            assert!(
                l.worth(&b1) < 100_000,
                "q={q} made money from its own buying"
            );
        }
    }

    fn buy_intent(b: &Book, g: usize, q: u32) -> Intent {
        Intent {
            good: g,
            side: Side::Buy,
            qty: q,
            limit: b.quote(g, Side::Buy, q),
        }
    }

    #[test]
    fn restock_moves_halfway_back_to_normal() {
        let s = restock(&[0, 900, 1000, 360, 241]);
        assert_eq!(s, [600, 900, 800, 360, 241]);
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
    fn a_turn_is_all_or_nothing() {
        let b = quiet(7, 0);
        let mut l = Ledger {
            cash: 1000,
            stock: [0; 5],
        };
        let mut s = NORMAL_STOCK;
        let ok = buy_intent(&b, 0, 5);
        let too_big = buy_intent(&b, 4, 50);
        assert!(apply_turn(&mut l, &mut s, &b, &[ok, too_big]).is_err());
        assert_eq!((l.cash, s), (1000, NORMAL_STOCK));
    }

    #[test]
    fn affordable_includes_the_fee_and_the_price_moving() {
        let b = quiet(7, 0);
        let q = affordable(1000, &b, 4);
        let cost = |q: u32| {
            let n = b.quote(4, Side::Buy, q) * q as u64;
            n + fee(n)
        };
        assert!(cost(q) <= 1000 && cost(q + 1) > 1000);
        assert_eq!(affordable(10, &b, 4), 0);
    }

    #[test]
    fn every_policy_only_places_turns_that_fill() {
        for seed in 0..300 {
            let night = simulate_town(seed, NORMAL_STOCK, &standard_entrants());
            // Replay the same night turn by turn and require every turn to clear.
            let entrants = standard_entrants();
            let mut stock = NORMAL_STOCK;
            let mut ledgers: Vec<Ledger> = entrants.iter().map(Entrant::start).collect();
            let mut prev = night.prices[0];
            for round in 0..ROUNDS {
                let book = Book::at(seed, round, stock);
                let mut moved = stock;
                for (i, e) in entrants.iter().enumerate() {
                    let d = decide(
                        e.temperament,
                        &View {
                            round,
                            book,
                            prices: book.board(),
                            prev,
                            ledger: ledgers[i],
                            stake: e.stake,
                        },
                    );
                    if !d.intents.is_empty() {
                        apply_turn(&mut ledgers[i], &mut moved, &book, &d.intents).unwrap_or_else(
                            |err| panic!("seed {seed} round {round} {:?}: {err}", e.temperament),
                        );
                    }
                }
                prev = book.board();
                stock = moved;
            }
        }
    }

    #[test]
    fn the_order_clones_act_in_does_not_matter() {
        let mut town = standard_entrants();
        town.push(Entrant::new("clone-1b", Temperament::Greedy, 1500));
        town.push(Entrant::new("clone-2b", Temperament::Greedy, 900));
        for seed in 0..100 {
            let a = simulate_town(seed, NORMAL_STOCK, &town);
            let mut rev = town.clone();
            rev.reverse();
            let mut b = simulate_town(seed, NORMAL_STOCK, &rev);
            b.outcomes.reverse();
            assert_eq!(a.outcomes, b.outcomes, "seed {seed}");
            assert_eq!(a.stock_end, b.stock_end);
        }
    }

    #[test]
    fn clones_move_each_others_prices() {
        // Three greedy clones in one town end the night differently than one alone would.
        let alone = simulate_town(
            853,
            NORMAL_STOCK,
            &[Entrant::new("a", Temperament::Greedy, 2000)],
        );
        let crowd: Vec<Entrant> = ["a", "b", "c"]
            .iter()
            .map(|n| Entrant::new(n, Temperament::Greedy, 2000))
            .collect();
        let crowded = simulate_town(853, NORMAL_STOCK, &crowd);
        assert_ne!(alone.prices, crowded.prices);
        assert_ne!(alone.outcomes[0].final_cash, crowded.outcomes[0].final_cash);
    }

    #[test]
    fn a_clone_sent_for_two_nights_stays_out_after_the_first() {
        let mut e = Entrant::new("clone-1", Temperament::Loyal, 1000);
        e.nights = 2;
        let n = simulate_town(42, NORMAL_STOCK, std::slice::from_ref(&e));
        assert!(!n.outcomes[0].home || n.outcomes[0].broke);
        e.played = 1;
        e.carried = Some(n.held[0]);
        let n2 = simulate_town(43, restock(&n.stock_end), &[e]);
        assert!(n2.outcomes[0].home);
    }

    #[test]
    fn simulate_is_deterministic() {
        assert_eq!(
            simulate(7, &standard_entrants()),
            simulate(7, &standard_entrants())
        );
    }
}
