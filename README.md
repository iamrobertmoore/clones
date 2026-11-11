<!-- GIF goes here once the video is cut -->

# Clones

**A trading game on NEAR where copies of you trade while you sleep. They can trade, but they can never withdraw.**

[Watch one night (60 s)](https://clones-tau-nine.vercel.app) · [Send your own clones in tonight](https://clones-tau-nine.vercel.app/town.html) · [The town on testnet](https://testnet.nearblocks.io/address/crypt.clonestown.testnet)

You go offline. Up to three copies of you walk into a market town and trade five goods with the
town merchant all night. One is cautious, one is greedy, one is loyal. Each copy is a real NEAR
account, `clone-1.<you>`, and its only key can call the market and nothing else. So it can buy and
sell, but if it tries to send money anywhere, the chain refuses.

In the morning you merge them back. Each merge is a real `DeleteAccount` transaction, and whatever
the clone has left lands in your account. A clone that went broke overnight still comes home, just with
less.

I built it because "an agent with your money" is usually a promise in someone's code. Here it's
an access key. The chain enforces it, and you can check it on the explorer.

## Try this, watch what happens

| Try this | Watch what happens |
|---|---|
| [Run one night](https://clones-tau-nine.vercel.app) | 12 hours of trading in 60 seconds. Each clone says why it trades, every order links to its testnet transaction, and at dawn the greedy clone tries to run with what's left. The chain refuses it. |
| [Send your clones in tonight](https://clones-tau-nine.vercel.app/town.html) | No login, no wallet. Pick a temperament for each clone. The night is played around 02:00 UTC, and your page shows what each one brought home. |
| `cargo run -p clones-replay` | The same night on a local NEAR node with real transactions, in about a minute. It ends with "chain matches the answer key: yes". |

## Verify every claim in five minutes

| Claim | Evidence | How to check |
|---|---|---|
| A clone's only key is a function-call key for the market | [clone-2 created](https://testnet.nearblocks.io/txns/AKJEFJD8cbLtHfBiJKm5hYdRjkLj95Cy7ewdZxrMb2xK): one AddKey, FunctionCall permission, receiver the market, method `place_order` | Open the transaction and look at the AddKey action |
| The clone trades with that key | [clone-2 buys amber](https://testnet.nearblocks.io/txns/Ha8nMgPh2TN1eTgibNQDQmQSmjNwMzUgbnuBf1wXMjKJ), signed by `clone-2` | The signer is the clone, the receiver is the market |
| The chain refuses its withdrawal | `InvalidAccessKeyError(RequiresFullAccess)`, in `web/data/night.json` | A refused transaction never reaches a block, so there is no explorer link. `cargo test -p clones-replay` repeats it, plus a refused deposit and a refused call to anything but the market |
| Merge is a real DeleteAccount to the player | [clone-2 merged](https://testnet.nearblocks.io/txns/71cGXBuSD9w3LdLyntd2eKQi9a8YEnnM9MzYqkkh2Gyd) | The clone account no longer exists; its balance went to the player |
| The contract decides every number | `contracts/market` clears each order with the rules in `core`; the same rules run off chain first as an answer key | The demo night matched it exactly, on the sandbox and on testnet |

## How it uses NEAR

1. **Sub-accounts as copies of you.** `clone-N.<player>` can only be created by the player, so the name itself says whose clone it is (`contracts/market/src/lib.rs`, `player_of`).
2. **Function-call access keys as the leash.** The clone's single key may call `place_order` on the market and nothing else. It can't transfer, can't attach a deposit, can't call any other contract.
3. **DeleteAccount as the merge.** The leash contract on each clone has one method, `merge`, which only the parent account may call. It deletes the clone with the player as beneficiary (`contracts/leash/src/lib.rs`).
4. **Contract-held ledger.** Because a function-call key can't attach NEAR, a clone's cash lives in the market's ledger. `settle` sells what it holds and pays out before the merge. If the clone account is already gone, the payout goes to the player instead.
5. **Testnet throughout.** The demo night and the hosted town run on NEAR testnet.

## How a night works

- Prices for the five goods come from the night's seed, hour by hour. Amber moves twice as hard as the others.
- Each hour every clone looks at the board and its purse and decides. Cautious buys what's cheap and takes profit at +10%. Greedy puts everything into whatever rose most. Loyal trades only grain and salt and never risks more than a third.
- Orders fill against the town merchant at that hour's price, with a 2% town fee.
- At dawn anything still held is sold at dawn prices. A clone worth less than a quarter of its stake is broke.

The demo seed (853): cautious 2.000 to 2.502 NEAR, greedy 2.000 to 0.391 (broke), loyal 2.000 to 2.043. Across 5,000 seeds the greedy clone goes broke on 16% of nights.

## The hosted town

`clonestown.testnet` runs a market that only takes its own guests. The sign-up page creates a
guest account and its clones and sends them in. A GitHub Actions job plays the night at 02:00 UTC,
merges everyone home and publishes each guest's night log. The house funds guests with testnet
NEAR and takes it back after the merge, so it can keep running until results.

## What broke while I built it

- The public testnet RPC rate-limited the first testnet night half way. I switched to another public endpoint and wrapped every call in a retry that only fires on rate-limit errors (`replay/src/lib.rs`, `retry!`).
- Reads lagged behind writes. The runner saw the previous hour right after ringing the next one. It now reads at optimistic finality and waits until the town and each clone show what it expects (`town_at`, `settled_view`).
- Merging with maximum gas reserved about 1 NEAR up front, more than a small player holds. Merge now asks for 100 Tgas.
- A review found that anyone could register clones in the hosted market, and that one outside clone could stop the night for everyone. The hosted market now only takes guests of its house, the keeper skips anyone else, and one guest's error no longer stops the others.
- Settling a clone that was already merged would have stranded its cash. The payout now falls back to the player (`after_payout`), with a test.

## Known limits

- Testnet only. No real money moves.
- In the hosted town the house holds the keys of its guest accounts and runs every clone, so you trust the house the way you trust a game server. The clone's own key still can't withdraw.
- The seed is set when the night opens. In a town where players ran their own clones, someone could trade on knowing it; the hosted town avoids that by running every clone itself. Committing a per-hour salt would fix it for open play.
- The clone's shape (one function-call key) is set up by the tools here, not checked by the market.
- Gas a clone spends doesn't come back, and town fees stay with the market.

## Run it yourself

```bash
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh
cargo run -p clones-replay
cargo test --workspace
```

`web/` is the site: the replay page, the town page and the sign-up function. The night logs are in `web/data/`.

## How this maps to the judging criteria

- **Technical:** two contracts and three NEAR mechanics (sub-accounts, function-call keys, DeleteAccount) carry the game, with 39 Rust tests and CI on every push.
- **NEAR integration:** the leash is a NEAR function-call access key. The game's one rule, that a clone can't withdraw, is enforced by the chain when it checks that key.
- **Design and experience:** the replay shows you asleep in a coffin, chained to three corpse-painted copies of yourself trading at a crypt in a frozen forest, so the idea reads in one frame. Every number on screen comes from the night log.
- **Open source and impact:** MIT. The pattern (an agent on a sub-account with a function-call key, merged back by DeleteAccount) works for any agent you want to let act but never let leave.

## Built with

Rust, near-sdk, near-workspaces and cargo-near for the contracts and runner; plain HTML, CSS and JavaScript for the pages; near-api-js for the sign-up function. I built this with Claude Code as my coding assistant during the event (9 to 13 November 2026).
