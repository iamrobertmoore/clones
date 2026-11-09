# Clones

A small trading game on NEAR where you never play alone. While you are offline, up to three copies of
you trade in a market town. Each copy is a real sub-account, `clone-1.<you>`, whose only key can call
the market and nothing else: it can trade, but it can never withdraw. In the morning you merge the
survivors back and their earnings land in your account.

Work in progress for NEAR HACKATHON (November 2026).

## Run the tests

```bash
rustup target add wasm32-unknown-unknown
cargo test --workspace
```

The sandbox tests start a local NEAR node and run one clone's whole life with real transactions:
create, trade, three refused attempts to move money, settle, merge.

## Layout

- `contracts/market`: the town. Holds every number.
- `contracts/leash`: deployed on each clone. Only the player can merge it.
- `sandbox-tests`: end-to-end tests against a local NEAR sandbox.

## Licence

Code: MIT. The soundtrack is Robert Moore's own music, recorded before the event, and is not covered
by the MIT licence.
