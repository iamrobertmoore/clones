# Changelog

## Unreleased

- New look for both pages: black metal. A frozen pine forest with a ruined keep, fog and falling ash; a crypt market with a hooded merchant; corpse-painted clones in spiked collars on iron chains; you asleep in a coffin; a blood-red dawn and a lightning strike when the chain refuses. Numbers in a monospace face, text kept readable on phones. Shared art lives in `web/art.js`.
- Soundtrack removed.
- The nightly town job runs off the hour (01:37 UTC, with a backstop at 02:41) because GitHub started the 02:00 run hours late.
- Site live on Vercel. Sign-up waits for a brand-new guest account to reach the RPC node before signing as it (the first live sign-up failed on that lag and rolled back cleanly). Test files are no longer deployed as functions.
- Review round 1 (who can call what) fixes: the hosted market only takes guests of its house; the keeper skips anyone else and one guest's error no longer stops the night; settle pays the player if the clone account is already gone; sign-up funds exactly what the clones need, rolls back on failure and caps the town at 15 clones; the town workflow builds without the house key and pins its actions by commit.
- Town page (`web/town.html`): send up to three clones in with no login, watch them wait, read the morning ledger from the chain.
- Hosted town on testnet: `clonestown.testnet` with its market. A sign-up function (`web/api/enlist.js`) sends a guest's clones in with no login; a nightly keeper (`cargo run -p clones-replay --bin keeper`, run by the `town` workflow at 02:00 UTC) plays the night, merges everyone home and publishes each guest's log to the `town-data` branch.
- Testnet tools: house setup, sweep and recovery examples.
- Replay page (`web/`): one night in 60 seconds, played from a night log, with explorer links, the refused withdrawal and a morning ledger.
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
