<!-- GIF goes here once the video is cut -->

# Clones

**A trading game on NEAR where copies of you trade while you sleep. They can trade, but they can never withdraw.**

[Play the hosted town](https://clones-tau-nine.vercel.app/town.html) · [Watch a recorded night (60 s)](https://clones-tau-nine.vercel.app) · [The market on testnet](https://testnet.nearblocks.io/address/barrow.clonestown.testnet)

You send up to three copies of yourself into a market town. You choose each one's temperament
(cautious, greedy or loyal), how much NEAR it carries and how many nights it stays out. Each copy is
a real NEAR account, `clone-1.<you>`, and its only key can call `trade` on the market and nothing
else. So it can buy and sell, but if it tries to send money anywhere, the chain refuses.

Every night has a mood (boom, slump, blight or wild), and each mood favours a different
temperament. Tomorrow's mood is posted tonight as an omen, drawn by the market contract from the
chain's own randomness, and omens lie three nights in ten, so who you send is a judgement call.
You are never alone at the merchant: three regulars (the Widow, the Abbot and the Hound) send
clones in every night, and at dawn the night's fees, the crown, go to whichever clone made the best
return. Then you ring the bell. Every clone in
town trades twelve hours against one merchant, one transaction per clone per hour, and you watch it
happen in about a minute. Once a night you can whisper to each clone: hold, sell everything, or buy
a good, and it obeys for one hour. The merchant's stock is shared: when clones buy a good the
merchant runs short and its price rises for everyone, so other players' clones move your prices and
yours move theirs. At dawn a clone that has done its nights, or gone broke, comes home with a real
`DeleteAccount`, and what it made lands in your account. A clone with nights left stays out, and
you can retrain it or bring it home early.

I built it for anyone who has handed a trading bot the keys to their money. That trust is usually a
promise in someone's code; in December 2022 leaked trading-bot API keys cost 44 verified victims
$14.8 million between them ([Unchained](https://unchainedcrypto.com/3commas-users-plan-class-action-lawsuit-after-losing-14m/)).
Here the promise is an access key, and the chain checks it on every transaction.

## Try this, watch what happens

| Try this | Watch what happens |
|---|---|
| [Open the town](https://clones-tau-nine.vercel.app/town.html) and press **Send them in** | No login, no wallet. About 20 seconds later you have a guest account on testnet with up to three clones in town, each holding the stake you chose. |
| Press **Try to run** on any clone | The clone signs a transfer from its own account with its own key. The chain refuses it with `InvalidAccessKeyError: RequiresFullAccess`, and the page shows the chain's words. |
| Read the omen (top right), then press **Ring the bell** | The whole town trades a night, hour by hour, in about a minute: speech bubbles, orders, prices moving with the merchant's stock. At dawn the page audits the night from chain state alone, then the clones that are due merge home. |
| Watch dawn | The contract hands the crown (every fee the merchant took that night) to the clone with the best return, yours or a rival's. The standings rank every player. |
| During the night, pick **whisper...** under a clone | Your order is stored on chain (one per clone per night). The clone obeys it for the next hour, and the dawn audit checks it did. |
| Between nights, **retrain** or **Bring home now** | Change a clone's temperament for the nights it has left, or settle and merge it early. |
| [Watch a recorded night](https://clones-tau-nine.vercel.app) | The demo night on testnet in 60 seconds, every order linked to its transaction. The greedy clone goes broke and tries to run; the chain refuses. |
| `cargo run -p clones-replay` | The same night on a local NEAR node with real transactions. It ends with "chain matches the answer key: yes". |

## Verify every claim in five minutes

| Claim | Evidence | How to check |
|---|---|---|
| A clone's only key is a function-call key for `trade` | [clone-2 created](https://testnet.nearblocks.io/txns/8nDyqWbaeoRthRgiE3Gy2ZsKUtmiDSCdGd7HxuxtS5jB): one AddKey, FunctionCall permission, receiver the market, method `trade`. The town page lists every live clone's keys, read from the chain | Open the transaction, or the "On the explorer, with their keys" panel on your guest page |
| The clone trades with that key | [clone-2 buys 15 amber](https://testnet.nearblocks.io/txns/CWXUWXqtQ3uwSggiiEcwNFrngfHfqqzxf5PGYwri4J2m), signed by `clone-2` | The signer is the clone, the receiver is the market |
| The chain refuses its withdrawal | `InvalidAccessKeyError(RequiresFullAccess)`, live from **Try to run**, and in `web/data/night.json` | A refused transaction never reaches a block, so there is no explorer link. Press the button, or run `cargo test -p clones-replay` (also a refused deposit and a refused call to anything but the market) |
| Merge is a real DeleteAccount to the player | [clone-2 merged](https://testnet.nearblocks.io/txns/3gdn6QfmuqsZJnfHUaS515jkvg1zNvZKzJgha2rdLCPS) | The clone account no longer exists; its balance went to the player |
| The contract decides every number | `contracts/market` quotes, clears and charges every order with the rules in `core`, and keeps each hour's prices and every order | Every night in the town ends with an audit: from the dusk state and the orders on chain, it replays the night and checks each clone did what its temperament or your whisper said, at the merchant's quote (`web/lib/night.js`, `audit`; tested in `web/lib/night.test.js`). The recorded demo night also matches an answer key computed before it ran |
| The crown goes to the best return | `crown()` in `contracts/market/src/lib.rs` runs at dawn; `get_town` shows `crowned` | The dawn audit recomputes the pot and the winner from the orders on chain and checks the contract agrees; contract test `the_nights_fees_crown_the_best_return` |
| Nobody can see the next hour's prices | In the hosted town each hour's prices, and tomorrow's mood, are drawn from NEAR's block randomness (`env::random_seed`) as the keeper rings the hour | `get_town` shows `chain_dice: true` and the prices drawn so far (`hours`); contract test `a_hosted_town_draws_prices_and_tomorrows_omen_from_the_chain` |
| Clones move each other's prices | The merchant's stock is stored in the contract (`get_town`: `stock`, `hour_stock`) | Watch the stock bars under the board while the bell rings; `core` test `clones_move_each_others_prices` |

## How it uses NEAR

1. **Sub-accounts as copies of you.** Only the player can create `clone-N.<player>`, so the name itself says whose clone it is (`contracts/market/src/lib.rs`, `player_of`).
2. **Function-call access keys as the leash.** The clone's single key may call `trade` on the market and nothing else. It can't transfer, can't attach a deposit and can't call any other contract.
3. **DeleteAccount as the merge.** The leash contract on each clone has one method, `merge`, which only the parent account may call. It deletes the clone with the player as beneficiary (`contracts/leash/src/lib.rs`).
4. **A contract-held ledger and market.** A function-call key can't attach NEAR, so a clone's cash lives in the market's ledger, next to the merchant's stock. `settle` sells what a clone holds and pays out before the merge; if the clone account is already gone, the payout goes to the player.
5. **Block randomness for prices and moods.** The hosted market draws each hour's price moves and tomorrow's mood from `env::random_seed()` when the hour is rung, so not even the house knows the next hour; whispers can't be played with foresight.
6. **Anyone can ring the bell.** The contract refuses anything done twice (an hour rung twice, a clone trading twice in an hour, a night opened twice), so a night can be driven from the page, by the nightly job, or by two people at once without spoiling it.

## How a night works

- **Moods.** Each night is a boom (prices climb), a slump (prices sink, then rebound before dawn), a blight (the luxuries rot while grain and salt hold) or wild (big swings both ways). The next night's mood is posted in advance; in the hosted town the omen comes true seven nights in ten.
- **The crown.** Every fee the merchant takes during a night goes, at dawn, to the clone with the best return on its stake (ties to the lower account id). The contract picks it and adds it to that clone's cash.
- **The regulars.** The Widow reads the omen and sends what it favours; the Abbot sends a careful clone; the Hound sends a greedy one. They play every night someone rings the bell.
- **Prices.** Each good's usual price moves hour by hour with the mood. The merchant scales it by its stock: short of a good, it charges more. A big order is quoted at the price after the trade, so a clone can't profit from its own buying.
- **Turns.** Each hour every clone reads the board and its purse and decides. Cautious buys what's cheap and takes profit at +10%. Greedy puts everything into whatever is rising fastest, and only switches when something else is rising clearly faster. Loyal trades only grain and salt and never risks more than a third. A whisper replaces that decision for one hour. Every order in an hour is quoted from the merchant's stock when the hour began, so the order clones act in never changes the result.
- **Dawn.** A clone worth less than a quarter of its stake is broke. Broke clones try to run off with what's on their account, and the chain refuses. Clones that are broke or have done their nights settle and merge home. The rest keep their goods for the next night, and the merchant restocks halfway overnight.

Over 20,000 simulated nights, about 5,000 of each mood (`cargo run -p clones-core --example balance`), each mood has a different winner:

| Mood | Cautious | Greedy | Loyal |
|---|---|---|---|
| Boom | +4% | **+19%** | +1% |
| Slump | **+10%** | -10% | +1% |
| Blight | -18% | -43% | **+1%** |
| Wild | **+9%** | -59%, broke 1 night in 4 | +1% |

Those figures leave the crown out. Sent blind, no temperament dominates (cautious +2%, loyal +1%, greedy -23% on average); read the omen and the best choice changes every night, and because the omen lies three nights in ten and the crown goes to one clone in the whole town, reading it well is not enough on its own.

The demo night (seed 606, a wild night): cautious 2.000 to 3.112 NEAR (2.613 plus the crown), greedy 2.000 to 0.484 (broke), loyal 2.000 to 2.053.

## The hosted town

`clonestown.testnet` runs a market, `barrow.clonestown.testnet`, that only takes its own guests and draws its prices from block randomness. The
sign-up function creates a guest account and its clones and sends them in, funded with testnet NEAR
by the house. The bell (`web/api/bell.js`) plays one step of the night per call; the town page
calls it until dawn. If nobody rings it, a GitHub Actions job rings the same code around 02:00 UTC
and publishes each guest's night log. When a guest's clones are all home, the house sweeps its
testnet NEAR back, so the town can keep running until results. The town holds up to 45 clones a
night.

**Make the account yours.** On your guest page, **Add my own key** makes an Ed25519 key in your
browser and adds it to your guest account as a full-access key. The private key never leaves the
page. From then on your winnings stay with you, and you can remove the house key.

## What broke while I built it

- The third review said my own table now solved the choice (read the omen, look it up) and the town felt empty. Omens now lie three nights in ten, the night's fees go to the best clone in town, and three regulars play every night.
- With eleven clones in town the public RPC rate-limited some turns; the audit flagged the missing orders at dawn. The runner now sends at most four turns at once, backs off longer, resends any turn that didn't land before ringing the hour, and spreads accounts across two RPC hostnames.
- The second review said the game had a dominant strategy, by my own published numbers: cautious never lost, so the one choice had an obvious answer. Each night now has a mood that favours a different temperament, posted a night ahead, and you can whisper, retrain and recall. A greedy clone that switched goods every hour paid fees and slippage each time and lost even in a boom; it now holds unless something is clearly rising faster.
- Whispers would have been gameable: the seed set every hour's price, so anyone could compute the night in advance and whisper with foresight. The hosted market now draws each hour from block randomness as it is rung, and the night is checked by an audit of the orders on chain rather than an answer key computed in advance.
- A first review against the field said the market ignored the players: prices came from the seed alone. I gave the merchant a real stock in the contract, so trades move prices for everyone (`core/src/lib.rs`, `Book`).
- My first version of that let a clone make free money: buy, watch its own buying raise the price, sell. The merchant now quotes a big order at the price after the trade, and a test proves buying and selling back never pays (`buying_and_selling_back_never_pays`).
- GitHub's scheduler started the nightly job seven hours late and skipped the backstop. A judge's clones could have sat unplayed all morning, so the night now runs whenever anyone rings the bell, and the schedule is only a fallback.
- A lagging RPC node made the runner replay an hour. The contract already refused the duplicate trades; the runner now also waits until a node shows the new hour before it returns.
- NEAR wouldn't delete the old market account, which held a lot of state, so the new market lives at `barrow.clonestown.testnet`.
- Earlier: the public RPC rate-limited the first testnet night (calls now retry on rate limits only), merging with maximum gas reserved more than a small player held (merge asks for 100 Tgas), and settling an already merged clone would have stranded its cash (`after_payout` pays the player instead).

## Known limits

- Testnet only. No real money moves.
- In the hosted town the house holds a key to every guest account and runs every clone, so you trust the house the way you trust a game server, until you add your own key. The clone's own key still can't withdraw.
- Block randomness is produced by NEAR's validators; a validator could in principle bias it. Fine for a testnet game, not for real stakes. The recorded demo night and the tests use a seed so their answer key can be worked out in advance.
- The market doesn't check a clone's shape (one function-call key); the sign-up function sets it up, and the page shows it live.
- Gas a clone spends doesn't come back, and town fees stay with the market.

## Run it yourself

```bash
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh
cargo run -p clones-replay
cargo test --workspace
cd web && npm ci && node --test api/*.test.js lib/*.test.js
```

`web/` is the site: the replay page, the town page, the sign-up, bell, whisper, retrain, recall, escape and claim functions,
and `lib/` (the night runner and a JavaScript copy of the rules). The recorded nights are in
`web/data/`.

## How this maps to the judging criteria

- **Game loop:** read the omen (and doubt it), choose temperament, stake and nights for each clone, ring the bell, whisper once a night to each clone, fight the regulars and other guests for the crown, see who comes home, retrain or recall the ones still out, ring again. Your clones share one merchant with everyone else's.
- **Technical:** two contracts and three NEAR mechanics (sub-accounts, function-call keys, DeleteAccount) carry the game. 70 Rust tests, including three suites that play real nights on a local NEAR node, and 16 web tests (the night audit among them) run in CI on every push.
- **NEAR integration:** the leash is a NEAR function-call access key, and every price, fill and payout is computed by the market contract.
- **Design:** you lie asleep in a coffin, chained to three corpse-painted copies of yourself trading at a crypt in a frozen forest, so the idea reads in one frame. Every number on screen comes from the chain or a night log.
- **Open source and impact:** MIT. The pattern (an agent on a sub-account with a function-call key, merged back by DeleteAccount) works for any agent you want to let act but never let leave.

## Built with

Rust, near-sdk, near-workspaces and cargo-near for the contracts and the reference runner; plain
HTML, CSS and JavaScript for the pages; near-api-js for the functions and the night runner. I
built this with Claude Code as my coding assistant during the event (9 to 13 November 2026).
