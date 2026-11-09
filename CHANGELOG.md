# Changelog

## Unreleased

- Replay page (`web/`): one night in 60 seconds, played from a night log, with explorer links, the refused withdrawal and a morning ledger. Soundtrack opt-in.
- The demo night (seed 853) played on NEAR testnet; the chain matched the answer key. Log in `web/data/night.json`.
- Runner handles many players in one night, retries rate-limited RPC calls and waits for consistent reads.
- Market lists the clones in town, counts nights and remembers each player's settlements on chain.
- Rules crate shared by the contract and the clones: seeded prices, fill-or-kill trades with a 2% town fee, three temperaments.
- Market clears every order on chain with those rules; the keeper rings twelve hours a night.
- Replay: one seeded night on a local sandbox in about a minute, with an answer key checked against the chain.
- Market contract: clones register with a stake, place orders, and are settled by their player.
- Leash contract: deployed on each clone; only the player can merge the clone back.
- Sandbox tests: a clone with a single function-call key trades, cannot move money, and merges home.
- CI: format, lint, unit tests and sandbox tests on every push.
