# Clones

A small trading game on NEAR where you never play alone. While you are offline, up to three copies of
you trade in a market town. Each copy is a real sub-account, `clone-1.<you>`, whose only key can call
the market and nothing else: it can trade, but it can never withdraw. In the morning you merge the
survivors back and their earnings land in your account.

Work in progress for NEAR HACKATHON (November 2026).

## Run one night in 60 seconds

```bash
rustup target add wasm32-unknown-unknown
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh
cargo run -p clones-replay
```

This starts a local NEAR node, creates three clones (cautious, greedy, loyal) with real
transactions, plays twelve hours of trading, and shows each clone's reasoning and every order. At
dawn the greedy clone is broke, tries to withdraw, and the chain refuses. Then all three merge
home. Before the night starts, the same rules run off chain to produce an answer key, and the run
checks that the chain matched it exactly. The full log goes to `replay.json`.

`cargo test --workspace` runs every test, including the same night as a test.

## Layout

- `core`: the rules of the town (prices, fills, temperaments), shared by the contract and the clones.
- `contracts/market`: the town. Clears every order and holds every number.
- `contracts/leash`: deployed on each clone. Only the player can merge it.
- `replay`: plays a seeded night on a local sandbox and writes the log.

## Licence

Code: MIT. The soundtrack is Robert Moore's own music, recorded before the event, and is not covered
by the MIT licence.
