//! The leash, deployed on every clone account.
//!
//! A clone's only key is a function-call key for the market, so it can trade but can never send
//! NEAR anywhere: the chain refuses a transfer signed with that key. This contract adds the one way
//! out: `merge`, which only the clone's parent account (the player) can call. It deletes the clone
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
pub struct Leash {}

#[near]
impl Leash {
    /// Delete this clone and send its whole balance to the player. Player only.
    pub fn merge(&mut self) -> Promise {
        let me = env::current_account_id();
        let player: AccountId = parent_of(me.as_str())
            .unwrap_or_else(|| env::panic_str("a clone always has a parent account"))
            .parse()
            .unwrap();
        require!(
            env::predecessor_account_id() == player,
            "only the player who made this clone can merge it"
        );
        Promise::new(me).delete_account(player)
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
        let ctx = VMContextBuilder::new()
            .current_account_id("clone-1.alice.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .build();
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
