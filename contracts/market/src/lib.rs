//! The market town.
//!
//! A player sends up to three clones (`clone-1.<player>`, `clone-2.<player>`, `clone-3.<player>`)
//! into town. Each clone signs with a function-call key that can only call this contract, and a
//! function-call key can never attach a deposit. So a clone's cash lives here, in this ledger:
//! the player funds it with `register_clone`, the clone trades it with `place_order`, and only the
//! player can `settle` it, which sells what it holds and pays the cash out to the clone account
//! just before the merge.
//!
//! Every number lives here. The clones choose orders; this contract decides what they get, using
//! the rules in `clones-core`. Amounts inside the town are in milliNEAR.

use clones_core as rules;
use near_sdk::json_types::U64;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// Clone names a player may use. Three clones, no more.
pub const CLONE_NAMES: [&str; 3] = ["clone-1", "clone-2", "clone-3"];

/// Smallest stake a clone can be sent in with, in milliNEAR.
pub const MIN_STAKE_MILLI: u64 = 100;

const YOCTO_PER_MILLI: u128 = 1_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Temperament {
    Cautious,
    Greedy,
    Loyal,
}

impl From<Temperament> for rules::Temperament {
    fn from(t: Temperament) -> Self {
        match t {
            Temperament::Cautious => rules::Temperament::Cautious,
            Temperament::Greedy => rules::Temperament::Greedy,
            Temperament::Loyal => rules::Temperament::Loyal,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl From<Side> for rules::Side {
    fn from(s: Side) -> Self {
        match s {
            Side::Buy => rules::Side::Buy,
            Side::Sell => rules::Side::Sell,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneRecord {
    pub player: AccountId,
    pub temperament: Temperament,
    pub stake: u64,
    pub cash: u64,
    pub stock: [u32; 5],
    pub orders_placed: u32,
}

impl CloneRecord {
    fn ledger(&self) -> rules::Ledger {
        rules::Ledger {
            cash: self.cash,
            stock: self.stock,
        }
    }
}

/// A clone as the outside world sees it. Amounts in milliNEAR.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneView {
    pub player: AccountId,
    pub temperament: Temperament,
    pub stake: u64,
    pub cash: u64,
    pub stock: [u32; 5],
    pub orders_placed: u32,
    /// Cash plus stock at the merchant's current prices.
    pub worth: u64,
    pub broke: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u32,
    pub round: u32,
    pub clone: AccountId,
    pub good: String,
    pub side: Side,
    pub qty: u32,
    pub price: u64,
    pub fee: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TownView {
    pub keeper: AccountId,
    pub seed: U64,
    pub round: u32,
    pub rounds: u32,
    pub goods: Vec<String>,
    pub prices: [u64; 5],
    pub fees_collected: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    keeper: AccountId,
    seed: u64,
    round: u32,
    fees: u64,
    clones: LookupMap<AccountId, CloneRecord>,
    orders: Vector<Order>,
}

/// If `clone` is `clone-N.<player>` with N in 1..=3, return the player.
pub fn player_of(clone: &str) -> Option<&str> {
    let (name, parent) = clone.split_once('.')?;
    if CLONE_NAMES.contains(&name) && !parent.is_empty() {
        Some(parent)
    } else {
        None
    }
}

#[near]
impl Market {
    /// The caller becomes the town keeper, who opens nights and rings the hours.
    #[init]
    pub fn new(seed: U64) -> Self {
        Self {
            keeper: env::predecessor_account_id(),
            seed: seed.0,
            round: 0,
            fees: 0,
            clones: LookupMap::new(b"c"),
            orders: Vector::new(b"o"),
        }
    }

    fn only_keeper(&self) {
        require!(
            env::predecessor_account_id() == self.keeper,
            "only the town keeper can do that"
        );
    }

    fn prices(&self) -> [u64; 5] {
        rules::prices_at(self.seed, self.round)
    }

    /// Start a new night with a new seed. Prices go back to their usual levels.
    pub fn open_night(&mut self, seed: U64) {
        self.only_keeper();
        self.seed = seed.0;
        self.round = 0;
    }

    /// Ring the next hour. Prices move.
    pub fn advance_round(&mut self) -> u32 {
        self.only_keeper();
        require!(self.round < rules::ROUNDS, "the night is over");
        self.round += 1;
        self.round
    }

    /// Called by the player with the clone's stake attached. The clone account must be a direct
    /// sub-account of the caller named `clone-1`, `clone-2` or `clone-3`.
    #[payable]
    pub fn register_clone(&mut self, clone_id: AccountId, temperament: Temperament) {
        let player = env::predecessor_account_id();
        require!(
            player_of(clone_id.as_str()) == Some(player.as_str()),
            "a clone must be clone-1, clone-2 or clone-3 under the caller's own account"
        );
        require!(
            !self.clones.contains_key(&clone_id),
            "that clone is already in town"
        );
        let stake = (env::attached_deposit().as_yoctonear() / YOCTO_PER_MILLI) as u64;
        require!(
            stake >= MIN_STAKE_MILLI,
            "send a clone in with at least 0.1 NEAR"
        );
        self.clones.insert(
            clone_id,
            CloneRecord {
                player,
                temperament,
                stake,
                cash: stake,
                stock: [0; 5],
                orders_placed: 0,
            },
        );
    }

    /// Called by a clone (with its function-call key). Clears at once against the town merchant
    /// at this hour's price, or fails. `price` is the clone's limit in milliNEAR.
    pub fn place_order(&mut self, good: String, side: Side, qty: u32, price: u64) -> u32 {
        require!(self.round < rules::ROUNDS, "the night is over");
        let prices = self.prices();
        let round = self.round;
        let clone = env::predecessor_account_id();
        let rec = self
            .clones
            .get_mut(&clone)
            .unwrap_or_else(|| env::panic_str("only a clone in town can place orders"));
        let g = rules::good_index(&good).unwrap_or_else(|| env::panic_str("unknown good"));
        let mut ledger = rec.ledger();
        let fill = rules::fill(&mut ledger, g, side.into(), qty, price, prices[g])
            .unwrap_or_else(|e| env::panic_str(e));
        rec.cash = ledger.cash;
        rec.stock = ledger.stock;
        rec.orders_placed += 1;
        self.fees += fill.fee;
        let id = self.orders.len();
        self.orders.push(Order {
            id,
            round,
            clone,
            good,
            side,
            qty,
            price: fill.price,
            fee: fill.fee,
        });
        id
    }

    /// Called by the player. Sells everything the clone holds at this hour's prices, pays the cash
    /// out to the clone account and takes the clone out of town. The player then merges the clone
    /// (see the leash contract).
    pub fn settle(&mut self, clone_id: AccountId) -> Promise {
        let rec = self
            .clones
            .get(&clone_id)
            .unwrap_or_else(|| env::panic_str("no such clone in town"))
            .clone();
        require!(
            rec.player == env::predecessor_account_id(),
            "only the player who sent this clone can settle it"
        );
        let mut ledger = rec.ledger();
        self.fees += rules::liquidate(&mut ledger, &self.prices());
        env::log_str(&format!(
            "settled {clone_id}: staked {} mNEAR, paid out {} mNEAR{}",
            rec.stake,
            ledger.cash,
            if rules::is_broke(ledger.cash, rec.stake) {
                ", broke"
            } else {
                ""
            }
        ));
        self.clones.remove(&clone_id);
        Promise::new(clone_id).transfer(NearToken::from_yoctonear(
            ledger.cash as u128 * YOCTO_PER_MILLI,
        ))
    }

    pub fn get_clone(&self, clone_id: AccountId) -> Option<CloneView> {
        let prices = self.prices();
        self.clones.get(&clone_id).map(|r| {
            let worth = r.ledger().worth(&prices);
            CloneView {
                player: r.player.clone(),
                temperament: r.temperament,
                stake: r.stake,
                cash: r.cash,
                stock: r.stock,
                orders_placed: r.orders_placed,
                worth,
                broke: rules::is_broke(worth, r.stake),
            }
        })
    }

    pub fn get_town(&self) -> TownView {
        TownView {
            keeper: self.keeper.clone(),
            seed: U64(self.seed),
            round: self.round,
            rounds: rules::ROUNDS,
            goods: rules::GOODS.iter().map(|g| g.to_string()).collect(),
            prices: self.prices(),
            fees_collected: self.fees,
        }
    }

    pub fn get_orders(&self, from: u32, limit: u32) -> Vec<Order> {
        self.orders
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const SEED: u64 = 853;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn as_caller(who: &str, deposit: NearToken) {
        let ctx = VMContextBuilder::new()
            .predecessor_account_id(acc(who))
            .attached_deposit(deposit)
            .build();
        testing_env!(ctx);
    }

    fn zero() -> NearToken {
        NearToken::from_yoctonear(0)
    }

    fn town_with_clone() -> Market {
        as_caller("keeper.testnet", zero());
        let mut m = Market::new(U64(SEED));
        as_caller("alice.testnet", NearToken::from_near(2));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Greedy);
        m
    }

    #[test]
    fn player_of_accepts_only_the_three_clone_names() {
        assert_eq!(player_of("clone-1.alice.testnet"), Some("alice.testnet"));
        assert_eq!(player_of("clone-3.bob.near"), Some("bob.near"));
        assert_eq!(player_of("clone-4.alice.testnet"), None);
        assert_eq!(player_of("thief.alice.testnet"), None);
        assert_eq!(player_of("clone-1"), None);
    }

    #[test]
    fn register_credits_the_stake_in_millinear() {
        let m = town_with_clone();
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.player, acc("alice.testnet"));
        assert_eq!(c.cash, 2000);
        assert_eq!(c.stake, 2000);
        assert_eq!(c.temperament, Temperament::Greedy);
        assert!(!c.broke);
    }

    #[test]
    #[should_panic(expected = "under the caller's own account")]
    fn cannot_register_someone_elses_clone() {
        as_caller("mallory.testnet", NearToken::from_near(1));
        let mut m = Market::new(U64(SEED));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal);
    }

    #[test]
    #[should_panic(expected = "already in town")]
    fn cannot_register_twice() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", NearToken::from_near(1));
        m.register_clone(acc("clone-1.alice.testnet"), Temperament::Loyal);
    }

    #[test]
    #[should_panic(expected = "at least 0.1 NEAR")]
    fn stake_has_a_floor() {
        as_caller("alice.testnet", NearToken::from_millinear(10));
        let mut m = Market::new(U64(SEED));
        m.register_clone(acc("clone-2.alice.testnet"), Temperament::Cautious);
    }

    #[test]
    fn an_order_clears_at_the_merchant_price() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        // Salt is 30 mNEAR at hour 0; 3 units cost 90 plus a 2 mNEAR fee.
        let id = m.place_order("salt".into(), Side::Buy, 3, 30);
        assert_eq!(id, 0);
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.cash, 2000 - 92);
        assert_eq!(c.stock, [0, 3, 0, 0, 0]);
        assert_eq!(m.get_town().fees_collected, 2);
        let o = &m.get_orders(0, 10)[0];
        assert_eq!((o.price, o.fee, o.round), (30, 2, 0));
    }

    #[test]
    fn prices_move_when_the_keeper_rings_the_hour() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        assert_eq!(m.get_town().prices, rules::BASE_PRICE);
        m.advance_round();
        assert_eq!(m.get_town().prices, rules::prices_at(SEED, 1));
        assert_ne!(m.get_town().prices, rules::BASE_PRICE);
    }

    #[test]
    #[should_panic(expected = "only the town keeper")]
    fn only_the_keeper_rings_the_hour() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.advance_round();
    }

    #[test]
    #[should_panic(expected = "the night is over")]
    fn no_trading_after_the_last_hour() {
        let mut m = town_with_clone();
        as_caller("keeper.testnet", zero());
        for _ in 0..rules::ROUNDS {
            m.advance_round();
        }
        as_caller("clone-1.alice.testnet", zero());
        m.place_order("salt".into(), Side::Buy, 1, 1000);
    }

    #[test]
    #[should_panic(expected = "only a clone in town")]
    fn strangers_cannot_place_orders() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", zero());
        m.place_order("salt".into(), Side::Buy, 1, 30);
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn unknown_goods_are_refused() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        m.place_order("gold".into(), Side::Buy, 1, 30);
    }

    #[test]
    #[should_panic(expected = "not enough cash")]
    fn buys_are_capped_by_cash() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        m.place_order("amber".into(), Side::Buy, 20, 120);
    }

    #[test]
    #[should_panic(expected = "below the merchant's price")]
    fn a_low_limit_does_not_fill() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        m.place_order("salt".into(), Side::Buy, 1, 29);
    }

    #[test]
    #[should_panic(expected = "only the player who sent this clone")]
    fn only_the_player_can_settle() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
    }

    #[test]
    fn settle_sells_everything_and_takes_the_clone_out_of_town() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", zero());
        m.place_order("salt".into(), Side::Buy, 3, 30);
        as_caller("alice.testnet", zero());
        let _ = m.settle(acc("clone-1.alice.testnet"));
        assert!(m.get_clone(acc("clone-1.alice.testnet")).is_none());
        // Bought 3 salt at 30 (fee 2), sold at 30 (fee 2).
        assert_eq!(m.get_town().fees_collected, 4);
    }
}
