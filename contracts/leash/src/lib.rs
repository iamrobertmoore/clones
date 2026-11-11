//! The leash, deployed on every clone account.
//!
//! A clone's only key is a function-call key for the market, so it can trade but can never send
//! NEAR anywhere: the chain refuses a transfer signed with that key. This contract adds the one way
//! out: `merge`, which only the clone's parent account (the player), or the market the player bound
//! it to, can call. Either way the beneficiary is always the player. It deletes the clone
//! account and the chain sends everything left on it to the player.

use near_sdk::{env, near, require, AccountId, Promise};

/// The parent of `clone-1.alice.testnet` is `alice.testnet`.
pub fn parent_of(account: &str) -> Option<&str> {
    account
        .split_once('.')
        .map(|(_, parent)| parent)
        .filter(|p| !p.is_empty())
}

#[near(contract_state)]
#[derive(Default)]
pub struct Leash {
    /// The market that may bring this clone home after paying it out. Set once, by the player.
    market: Option<String>,
}

#[near]
impl Leash {
    /// Delete this clone and send its whole balance to the player. Player only.
    pub fn merge(&mut self) -> Promise {
        let me = env::current_account_id();
        let player: AccountId = parent_of(me.as_str())
            .unwrap_or_else(|| env::panic_str("a clone always has a parent account"))
            .parse()
            .unwrap();
        let caller = env::predecessor_account_id();
        require!(
            caller == player || Some(caller.as_str()) == self.market.as_deref(),
            "only the player who made this clone, or its market, can merge it"
        );
        Promise::new(me).delete_account(player)
    }

    /// Bind this clone to the market that may merge it home (it still pays only the player).
    /// Player only, once. The market's account id is the raw call input (not JSON), which keeps
    /// the leash small enough to fit on a cheap clone account.
    pub fn bind(&mut self) {
        let market = String::from_utf8(env::input().unwrap_or_default())
            .unwrap_or_else(|_| env::panic_str("the input is the market's account id"));
        let me = env::current_account_id();
        let player = parent_of(me.as_str()).unwrap_or_default();
        require!(
            env::predecessor_account_id().as_str() == player,
            "only the player who made this clone can bind it"
        );
        require!(
            self.market.is_none(),
            "this clone is already bound to a market"
        );
        self.market = Some(market);
    }

    /// The market this clone is bound to, if any.
    pub fn market(&self) -> Option<String> {
        self.market.clone()
    }

    /// The account this clone merges back into.
    pub fn player(&self) -> String {
        parent_of(env::current_account_id().as_str())
            .unwrap_or_default()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn on_clone_called_by(caller: &str) {
        on_clone_called_with(caller, b"");
    }

    fn on_clone_called_with(caller: &str, input: &[u8]) {
        let mut ctx = VMContextBuilder::new()
            .current_account_id("clone-1.alice.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .build();
        ctx.input = input.into();
        testing_env!(ctx);
    }

    #[test]
    fn parent_is_everything_after_the_first_dot() {
        assert_eq!(parent_of("clone-1.alice.testnet"), Some("alice.testnet"));
        assert_eq!(parent_of("alice"), None);
    }

    #[test]
    fn reports_its_player() {
        on_clone_called_by("anyone.testnet");
        assert_eq!(Leash::default().player(), "alice.testnet");
    }

    #[test]
    fn the_player_can_merge() {
        on_clone_called_by("alice.testnet");
        let _ = Leash::default().merge();
    }

    #[test]
    fn its_market_can_merge_it_home() {
        on_clone_called_with("alice.testnet", b"market.testnet");
        let mut l = Leash::default();
        l.bind();
        assert_eq!(l.market().as_deref(), Some("market.testnet"));
        on_clone_called_by("market.testnet");
        let _ = l.merge();
    }

    #[test]
    #[should_panic(expected = "already bound")]
    fn a_clone_is_bound_once() {
        on_clone_called_with("alice.testnet", b"market.testnet");
        let mut l = Leash::default();
        l.bind();
        on_clone_called_with("alice.testnet", b"thief.testnet");
        l.bind();
    }

    #[test]
    #[should_panic(expected = "only the player who made this clone can bind")]
    fn only_the_player_binds() {
        on_clone_called_with("mallory.testnet", b"mallory.testnet");
        Leash::default().bind();
    }

    #[test]
    #[should_panic(expected = "only the player who made this clone")]
    fn a_stranger_cannot_merge() {
        on_clone_called_by("mallory.testnet");
        let _ = Leash::default().merge();
    }

    #[test]
    #[should_panic(expected = "only the player who made this clone")]
    fn the_clone_cannot_merge_itself() {
        on_clone_called_by("clone-1.alice.testnet");
        let _ = Leash::default().merge();
    }
}
