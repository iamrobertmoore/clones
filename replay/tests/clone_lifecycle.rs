//! One clone's whole life on a local NEAR sandbox, with real transactions:
//! the player creates `clone-1.<player>` whose only key can call the market and nothing else,
//! the clone trades, the clone's attempts to move money are refused by the chain, and the player
//! settles and merges the clone back with a real DeleteAccount.

use near_workspaces::network::Sandbox;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::json;

struct Town {
    worker: Worker<Sandbox>,
    market: Contract,
    player: Account,
    clone: Account,
}

async fn town() -> anyhow::Result<Town> {
    let worker = near_workspaces::sandbox().await?;
    let market_wasm = near_workspaces::compile_project("../contracts/market").await?;
    let leash_wasm = near_workspaces::compile_project("../contracts/leash").await?;

    let market = worker.dev_deploy(&market_wasm).await?;
    market
        .call("new")
        .args_json(json!({ "seed": "0" }))
        .transact()
        .await?
        .into_result()?;

    let player = worker
        .root_account()?
        .create_subaccount("player")
        .initial_balance(NearToken::from_near(30))
        .transact()
        .await?
        .into_result()?;

    // The clone: a sub-account of the player whose ONLY key is a function-call key for the market.
    let clone_id: AccountId = format!("clone-1.{}", player.id()).parse()?;
    let clone_key = SecretKey::from_random(KeyType::ED25519);
    let leash_key = AccessKey::function_call_access(
        market.id(),
        &["trade"],
        Some(NearToken::from_millinear(250)),
    );
    player
        .batch(&clone_id)
        .create_account()
        .transfer(NearToken::from_near(3))
        .add_key(clone_key.public_key(), leash_key)
        .deploy(&leash_wasm)
        .transact()
        .await?
        .into_result()?;
    let clone = Account::from_secret_key(clone_id, clone_key, &worker);

    player
        .call(market.id(), "register_clone")
        .args_json(json!({ "clone_id": clone.id(), "temperament": "possessed" }))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?
        .into_result()?;

    // The keeper (the market account) opens the first night; the clone can trade from now.
    market
        .call("open_night")
        .args_json(json!({ "seed": "853", "night": 1 }))
        .transact()
        .await?
        .into_result()?;

    Ok(Town {
        worker,
        market,
        player,
        clone,
    })
}

/// Ring the twelve hours: dawn, when clones can be settled.
async fn dawn(t: &Town) -> anyhow::Result<()> {
    for round in 0..12 {
        t.market
            .call("advance_round")
            .args_json(json!({ "round": round }))
            .transact()
            .await?
            .into_result()?;
    }
    Ok(())
}

#[tokio::test]
async fn the_clone_has_exactly_one_key_and_it_is_a_leash() -> anyhow::Result<()> {
    let t = town().await?;
    let keys = t.worker.view_access_keys(t.clone.id()).await?;
    assert_eq!(keys.len(), 1, "a clone must have exactly one key");
    let perm = format!("{:?}", keys[0].access_key.permission);
    assert!(
        perm.contains("FunctionCall"),
        "the key must be function-call only, got {perm}"
    );
    assert!(
        perm.contains(t.market.id().as_str()),
        "the key must point at the market, got {perm}"
    );

    let player: String = t.clone.view(t.clone.id(), "player").await?.json()?;
    assert_eq!(player, t.player.id().to_string());
    Ok(())
}

#[tokio::test]
async fn the_clone_trades_with_its_key() -> anyhow::Result<()> {
    let t = town().await?;
    let ids: Vec<u32> = t
        .clone
        .call(t.market.id(), "trade")
        .args_json(json!({ "round": 0, "orders": [{ "good": "salt", "side": "buy", "qty": 3, "price": 30 }] }))
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(ids, vec![0]);

    let info: serde_json::Value = t
        .market
        .view("get_clone")
        .args_json(json!({ "clone_id": t.clone.id() }))
        .await?
        .json()?;
    assert_eq!(info["orders_placed"], 1);
    assert_eq!(info["cash"], 2000 - 92);
    Ok(())
}

#[tokio::test]
async fn the_chain_refuses_every_way_a_clone_could_move_money() -> anyhow::Result<()> {
    let t = town().await?;

    // 1a. A small transfer to anyone: refused, the key is not a full-access key.
    let withdraw = t
        .clone
        .transfer_near(t.player.id(), NearToken::from_millinear(100))
        .await;
    let err = format!(
        "{:?}",
        withdraw.expect_err("a clone must not be able to withdraw")
    );
    assert!(
        err.contains("RequiresFullAccess"),
        "unexpected refusal: {err}"
    );

    // 1b. A large transfer is refused too (the chain checks the key's allowance first).
    let withdraw = t
        .clone
        .transfer_near(t.player.id(), NearToken::from_near(1))
        .await;
    let err = format!(
        "{:?}",
        withdraw.expect_err("a clone must not be able to withdraw")
    );
    assert!(
        err.contains("InvalidAccessKeyError"),
        "unexpected refusal: {err}"
    );

    // 2. Attaching a deposit to a market call: refused, function-call keys cannot attach deposits.
    // (Kept small so it fits the key's allowance; a big one is refused earlier, for allowance.)
    let smuggle = t
        .clone
        .call(t.market.id(), "trade")
        .args_json(json!({ "round": 0, "orders": [{ "good": "salt", "side": "buy", "qty": 1, "price": 30 }] }))
        .deposit(NearToken::from_millinear(1))
        .transact()
        .await;
    let err = format!(
        "{:?}",
        smuggle.expect_err("a clone must not attach deposits")
    );
    assert!(
        err.contains("DepositWithFunctionCall"),
        "unexpected refusal: {err}"
    );

    // 3. Calling anything that is not the market, including its own leash: refused.
    let escape = t.clone.call(t.clone.id(), "merge").transact().await;
    let err = format!(
        "{:?}",
        escape.expect_err("a clone must not call its own leash")
    );
    assert!(
        err.contains("ReceiverMismatch"),
        "unexpected refusal: {err}"
    );

    // 4. Settling its own ledger through the market: refused by the contract.
    let settle = t
        .clone
        .call(t.market.id(), "settle")
        .args_json(json!({ "clone_id": t.clone.id() }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await;
    assert!(settle.is_err() || settle.unwrap().is_failure());

    // The clone still holds what it started with, less nothing.
    let bal = t.worker.view_account(t.clone.id()).await?.balance;
    assert!(bal >= NearToken::from_near(2), "clone balance moved: {bal}");
    Ok(())
}

#[tokio::test]
async fn goods_are_nep245_tokens_that_never_leave_the_market() -> anyhow::Result<()> {
    let t = town().await?;
    let out = t
        .clone
        .call(t.market.id(), "trade")
        .args_json(json!({ "round": 0, "orders": [{ "good": "salt", "side": "buy", "qty": 3, "price": 30 }] }))
        .transact()
        .await?
        .into_result()?;
    let mint = out
        .logs()
        .iter()
        .find_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(serde_json::from_str::<serde_json::Value>)
        .ok_or_else(|| anyhow::anyhow!("the buy logged no NEP-245 event"))??;
    assert_eq!(mint["standard"], "nep245");
    assert_eq!(mint["event"], "mt_mint");
    assert_eq!(mint["data"][0]["owner_id"], t.clone.id().as_str());
    assert_eq!(mint["data"][0]["amounts"], json!(["3"]));

    let balance: String = t
        .market
        .view("mt_balance_of")
        .args_json(json!({ "account_id": t.clone.id(), "token_id": "salt" }))
        .await?
        .json()?;
    assert_eq!(balance, "3");
    let held: serde_json::Value = t
        .market
        .view("mt_tokens_for_owner")
        .args_json(json!({ "account_id": t.clone.id() }))
        .await?
        .json()?;
    assert_eq!(held[0]["token_id"], "salt");
    let supply: Option<String> = t
        .market
        .view("mt_supply")
        .args_json(json!({ "token_id": "salt" }))
        .await?
        .json()?;
    assert_eq!(supply.as_deref(), Some("3"));

    // The player calls each transfer the way the standard says, with 1 yoctoNEAR: refused.
    let single = json!({ "receiver_id": t.player.id(), "token_id": "salt", "amount": "3",
        "approval": null, "memo": null, "msg": "" });
    let batch = json!({ "receiver_id": t.player.id(), "token_ids": ["salt"], "amounts": ["3"],
        "approvals": null, "memo": null, "msg": "" });
    for (method, args) in [
        ("mt_transfer", &single),
        ("mt_transfer_call", &single),
        ("mt_batch_transfer", &batch),
        ("mt_batch_transfer_call", &batch),
    ] {
        let out = t
            .player
            .call(t.market.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?;
        let err = format!("{:?}", out.into_result().expect_err(method));
        assert!(
            err.contains("goods stay at the market"),
            "{method}: unexpected refusal: {err}"
        );
    }

    // The clone's own key cannot even ask: it only calls `trade`.
    let out = t
        .clone
        .call(t.market.id(), "mt_transfer")
        .args_json(&single)
        .transact()
        .await;
    let err = format!("{:?}", out.expect_err("a clone must not call mt_transfer"));
    assert!(
        err.contains("MethodNameMismatch"),
        "unexpected refusal: {err}"
    );

    let balance: String = t
        .market
        .view("mt_balance_of")
        .args_json(json!({ "account_id": t.clone.id(), "token_id": "salt" }))
        .await?
        .json()?;
    assert_eq!(balance, "3", "the clone still holds its salt");
    Ok(())
}

#[tokio::test]
async fn a_stranger_cannot_merge_the_clone() -> anyhow::Result<()> {
    let t = town().await?;
    let mallory = t.worker.dev_create_account().await?;
    let out = mallory.call(t.clone.id(), "merge").transact().await?;
    assert!(out.is_failure(), "a stranger merged someone else's clone");
    assert!(t.worker.view_account(t.clone.id()).await.is_ok());
    Ok(())
}

#[tokio::test]
async fn settle_then_merge_brings_everything_home() -> anyhow::Result<()> {
    let t = town().await?;
    dawn(&t).await?;
    let before = t.worker.view_account(t.player.id()).await?.balance;

    // Market pays the clone's 2 NEAR of cash out to the clone account.
    t.player
        .call(t.market.id(), "settle")
        .args_json(json!({ "clone_id": t.clone.id() }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let on_clone = t.worker.view_account(t.clone.id()).await?.balance;
    assert!(
        on_clone >= NearToken::from_near(4),
        "settle did not reach the clone: {on_clone}"
    );

    // Merge: a real DeleteAccount, beneficiary = the player.
    t.player
        .call(t.clone.id(), "merge")
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert!(
        t.worker.view_account(t.clone.id()).await.is_err(),
        "the clone account should be gone"
    );

    let after = t.worker.view_account(t.player.id()).await?.balance;
    let gained = after.saturating_sub(before);
    assert!(
        gained >= NearToken::from_millinear(4900),
        "the player should get the clone's 3 NEAR plus 2 NEAR of cash back, less gas; got {gained}"
    );
    Ok(())
}

#[tokio::test]
async fn settling_after_the_clone_is_gone_still_pays_the_player() -> anyhow::Result<()> {
    let t = town().await?;
    dawn(&t).await?;
    // Merge first: the clone account is deleted while its cash is still in the market.
    t.player
        .call(t.clone.id(), "merge")
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let before = t.worker.view_account(t.player.id()).await?.balance;

    // Then settle: the payout to the deleted clone bounces, and the market sends it to the player.
    t.player
        .call(t.market.id(), "settle")
        .args_json(json!({ "clone_id": t.clone.id() }))
        .gas(near_workspaces::types::Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let after = t.worker.view_account(t.player.id()).await?.balance;
    let gained = after.saturating_sub(before);
    assert!(
        gained >= NearToken::from_millinear(1990),
        "the 2 NEAR of cash should reach the player, got {gained}"
    );
    Ok(())
}
