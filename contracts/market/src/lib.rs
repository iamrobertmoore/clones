//! The market town.
//!
//! A player sends up to three clones (`clone-1.<player>`, `clone-2.<player>`, `clone-3.<player>`)
//! into town. Each clone signs with a function-call key that can only call this contract, and a
//! function-call key can never attach a deposit. So a clone's cash lives here, in this ledger:
//! the player funds it with `register_clone`, the clone trades it with `place_order`, and only the
//! player can `settle` it, which pays the cash out to the clone account just before the merge.
//!
//! Every number lives in this contract. The agents choose orders; the contract decides what they get.

use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

/// The five goods traded in town. Order matters: it is the index used in the ledger.
pub const GOODS: [&str; 5] = ["grain", "salt", "wool", "iron", "amber"];

/// Clone names a player may use. Three clones, no more.
pub const CLONE_NAMES: [&str; 3] = ["clone-1", "clone-2", "clone-3"];

/// Smallest stake a clone can be sent in with.
pub const MIN_STAKE: NearToken = NearToken::from_millinear(100);

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Temperament {
    Cautious,
    Greedy,
    Loyal,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CloneInfo {
    pub player: AccountId,
    pub temperament: Temperament,
    pub cash: NearToken,
    /// Units held of each good, indexed like `GOODS`.
    pub stock: [u32; 5],
    pub orders_placed: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub id: u32,
    pub clone: AccountId,
    pub good: String,
    pub side: Side,
    pub qty: u32,
    /// Limit price per unit.
    pub price: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    clones: LookupMap<AccountId, CloneInfo>,
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
    #[init]
    pub fn new() -> Self {
        Self {
            clones: LookupMap::new(b"c"),
            orders: Vector::new(b"o"),
        }
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
        let stake = env::attached_deposit();
        require!(stake >= MIN_STAKE, "send a clone in with at least 0.1 NEAR");
        self.clones.insert(
            clone_id,
            CloneInfo {
                player,
                temperament,
                cash: stake,
                stock: [0; 5],
                orders_placed: 0,
            },
        );
    }

    /// Called by a clone (with its function-call key). Records the order; clearing comes later.
    pub fn place_order(&mut self, good: String, side: Side, qty: u32, price: NearToken) -> u32 {
        let clone = env::predecessor_account_id();
        let info = self
            .clones
            .get_mut(&clone)
            .unwrap_or_else(|| env::panic_str("only a clone in town can place orders"));
        require!(GOODS.contains(&good.as_str()), "unknown good");
        require!(qty > 0, "quantity must be positive");
        require!(!price.is_zero(), "price must be positive");
        if side == Side::Buy {
            let cost = price.saturating_mul(qty as u128);
            require!(cost <= info.cash, "not enough cash for that order");
        }
        info.orders_placed += 1;
        let id = self.orders.len();
        self.orders.push(Order {
            id,
            clone,
            good,
            side,
            qty,
            price,
        });
        id
    }

    /// Called by the player. Pays the clone's cash out to the clone account and takes it out of
    /// town. The player then merges the clone (see the leash contract).
    pub fn settle(&mut self, clone_id: AccountId) -> Promise {
        let info = self
            .clones
            .get(&clone_id)
            .unwrap_or_else(|| env::panic_str("no such clone in town"));
        require!(
            info.player == env::predecessor_account_id(),
            "only the player who sent this clone can settle it"
        );
        let cash = info.cash;
        self.clones.remove(&clone_id);
        Promise::new(clone_id).transfer(cash)
    }

    pub fn get_clone(&self, clone_id: AccountId) -> Option<CloneInfo> {
        self.clones.get(&clone_id).cloned()
    }

    pub fn get_orders(&self, from: u32, limit: u32) -> Vec<Order> {
        self.orders
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    pub fn goods(&self) -> Vec<String> {
        GOODS.iter().map(|g| g.to_string()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

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

    fn town_with_clone() -> Market {
        as_caller("alice.testnet", NearToken::from_near(2));
        let mut m = Market::new();
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
    fn register_credits_the_stake_to_the_clone() {
        let m = town_with_clone();
        let c = m.get_clone(acc("clone-1.alice.testnet")).unwrap();
        assert_eq!(c.player, acc("alice.testnet"));
        assert_eq!(c.cash, NearToken::from_near(2));
        assert_eq!(c.temperament, Temperament::Greedy);
    }

    #[test]
    #[should_panic(expected = "under the caller's own account")]
    fn cannot_register_someone_elses_clone() {
        as_caller("mallory.testnet", NearToken::from_near(1));
        let mut m = Market::new();
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
        let mut m = Market::new();
        m.register_clone(acc("clone-2.alice.testnet"), Temperament::Cautious);
    }

    #[test]
    fn clone_places_an_order() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(0));
        let id = m.place_order("salt".into(), Side::Buy, 3, NearToken::from_millinear(100));
        assert_eq!(id, 0);
        let orders = m.get_orders(0, 10);
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].clone, acc("clone-1.alice.testnet"));
        assert_eq!(
            m.get_clone(acc("clone-1.alice.testnet"))
                .unwrap()
                .orders_placed,
            1
        );
    }

    #[test]
    #[should_panic(expected = "only a clone in town")]
    fn strangers_cannot_place_orders() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", NearToken::from_yoctonear(0));
        m.place_order("salt".into(), Side::Buy, 1, NearToken::from_millinear(1));
    }

    #[test]
    #[should_panic(expected = "unknown good")]
    fn unknown_goods_are_refused() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(0));
        m.place_order("gold".into(), Side::Buy, 1, NearToken::from_millinear(1));
    }

    #[test]
    #[should_panic(expected = "not enough cash")]
    fn buys_are_capped_by_cash() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(0));
        m.place_order("iron".into(), Side::Buy, 3, NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "only the player who sent this clone")]
    fn only_the_player_can_settle() {
        let mut m = town_with_clone();
        as_caller("clone-1.alice.testnet", NearToken::from_yoctonear(0));
        let _ = m.settle(acc("clone-1.alice.testnet"));
    }

    #[test]
    fn settle_takes_the_clone_out_of_town() {
        let mut m = town_with_clone();
        as_caller("alice.testnet", NearToken::from_yoctonear(0));
        let _ = m.settle(acc("clone-1.alice.testnet"));
        assert!(m.get_clone(acc("clone-1.alice.testnet")).is_none());
    }
}
