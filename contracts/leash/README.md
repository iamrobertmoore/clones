# clones-leash

A leash for software agents on NEAR. Give an agent its own account and money to work with, and
it can do its job but can never walk off with the money.

It is about 70 lines of Rust and builds to a 43 KB wasm. Clones uses it for every clone in its
market town, on testnet and mainnet.

## The pattern

1. **The agent is a sub-account of its owner.** `agent-1.alice.near` belongs to `alice.near`.
   NEAR only lets `alice.near` create it, and the leash reads the parent from the account id, so
   it needs no stored owner.
2. **Its only key is a function-call key.** The key may call named methods on one contract (here,
   `trade` on a market) and nothing else. A function-call key cannot attach a deposit or send a
   transfer, and the chain enforces that, not the contract. The agent can act, but it cannot pay
   anyone.
3. **It is bound to one market.** `bind` stores the one contract that may send the agent home.
   Only the parent can bind, and only once.
4. **It merges home with DeleteAccount.** `merge` deletes the agent's account, and NEAR sends
   everything left on it to the beneficiary. The beneficiary is always the parent. The parent
   and the bound market may call `merge`. The agent may not, and nobody can redirect the money.

So the worst a stolen agent key can do is make bad trades inside the rules of the one contract
it is allowed to call. It cannot withdraw. In the Clones town, press "Try to run" on any clone
and the chain refuses the transfer with `RequiresFullAccess`.

## Methods

| method | who may call | what it does |
| --- | --- | --- |
| `bind()` | the parent, once | stores the market account id (the raw call input, not JSON, to keep the wasm small) |
| `merge()` | the parent, or the bound market | deletes this account; the balance goes to the parent |
| `market()` | anyone (view) | the bound market, if any |
| `player()` | anyone (view) | the parent account it merges into |

## Use it in your project

Build it:

```bash
cargo near build non-reproducible-wasm --manifest-path contracts/leash/Cargo.toml
```

Then make an agent in one transaction from the owner's account. With near-api-js:

```js
const { transactions, utils } = require("near-api-js");
const agent = `agent-1.${owner.accountId}`;
await owner.signAndSendTransaction({
  receiverId: agent,
  actions: [
    transactions.createAccount(),
    transactions.transfer(utils.format.parseNearAmount("0.6")), // storage for the 43 KB wasm, plus gas
    // The agent's only key: it may call `trade` on the market and nothing else.
    transactions.addKey(agentPublicKey, transactions.functionCallAccessKey(market, ["trade"], allowance)),
    transactions.deployContract(leashWasm),
    transactions.functionCall("bind", Buffer.from(market), 10_000_000_000_000n, 0n),
  ],
});
```

Give the agent's private key to the agent (a bot, a model, a server). Hold its money in the
contract it trades with, not on the agent account. Clones keeps each clone's cash in the market's
ledger, and the market pays it out to the clone just before it calls `merge`.

To bring it home yourself:

```js
await owner.functionCall({ contractId: agent, methodName: "merge", args: {}, gas: 30_000_000_000_000n });
```

To let your contract bring it home, as the Clones market does at dawn, call it from the bound
contract:

```rust
Promise::new(agent).function_call("merge".into(), vec![], NearToken::from_yoctonear(0), Gas::from_tgas(20));
```

## What it does not protect

- The agent's actions inside the contract it may call. Make that contract enforce its own rules.
  The Clones market refuses any turn that breaks the clone's temperament or its player's
  whisper.
- The NEAR left on the agent account for gas. It can spend that on gas for calls to the market,
  up to the key's allowance, and nothing else.
- An owner key that is stolen. The owner can always merge, so whoever holds the owner key holds
  the agent.

## Tests

```bash
cargo test -p clones-leash
```

8 unit tests cover who may bind and merge. The sandbox tests in `replay/tests` run the whole
lifecycle on a local NEAR node: create, bind, trade, a refused withdrawal, settle, and merge.

MIT licence.
