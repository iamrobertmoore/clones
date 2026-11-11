// The hosted town's night runner: ring the bell, one step at a time.
//
// Every call to `ring` reads the town from the market contract and does the next thing:
//   - during a night: play the current hour (every clone takes its turn, signed with its own
//     function-call key) and ring the next one; after the twelfth hour it is dawn, and the runner
//     checks the night against the answer key and lets every broke clone try to run off with what
//     is left (the chain refuses);
//   - at dawn: settle and merge every clone that is due home (a real DeleteAccount each), then
//     sweep each finished guest's account back to the house;
//   - asleep, with clones waiting and `start` set: open the next night.
// It keeps no state between calls; the contract holds it all and refuses anything done twice (an
// hour rung twice, a clone trading twice in an hour, a night opened twice), so anyone may ring
// the bell, and two people ringing at once cannot spoil a night.
//
// Testnet only. The house key signs for the keeper, every guest and, as a function-call key for
// `trade` only, every clone.

const crypto = require("crypto");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");
const rules = require("./rules.js");

const TGAS = 1_000_000_000_000n;
const short = (id) => id.split(".")[0];

async function openTown(env = process.env) {
  const house = env.HOUSE_ACCOUNT;
  const keyPair = KeyPair.fromString(env.HOUSE_KEY.trim());
  const market = env.MARKET_ACCOUNT || `crypt.${house}`;
  const keyStore = new keyStores.InMemoryKeyStore();
  const near = await connect({
    networkId: "testnet",
    nodeUrl: env.NEAR_RPC || "https://test.rpc.fastnear.com",
    keyStore,
  });
  const as = async (id) => {
    await keyStore.setKey("testnet", id, keyPair);
    return near.account(id);
  };
  const houseAccount = await as(house);
  const view = (methodName, args = {}) =>
    houseAccount.viewFunction({ contractId: market, methodName, args });
  return { near, house, market, keyPair, as, view, houseAccount };
}

const message = (e) => String((e && (e.message || e.type)) || e);

// Retry a call the RPC node turned away for load; such a call never reached the chain.
async function patient(fn, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = message(e).toLowerCase();
      const busy = m.includes("429") || m.includes("rate") || m.includes("too many") || (e && e.type === "KeyNotFound");
      if (!busy || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
}

async function readState(t) {
  const [town, clones] = await patient(() => t.view("get_state"));
  town.seed = Number(town.seed);
  return { town, clones: clones.map(([id, v]) => ({ id, ...v })) };
}

// Play hour `town.round`: every clone in tonight takes its turn, then the keeper rings the hour.
async function playHour(t, town, clones) {
  const round = town.round;
  const book = rules.Book.at(town.seed, round, town.hour_stock);
  const events = [{ kind: "hour", round, prices: town.prices, stock: town.hour_stock }];
  const playing = clones.filter((c) => c.from_night <= town.night);
  await Promise.all(
    playing.map(async (c) => {
      if (c.last_turn && c.last_turn[0] === town.night && c.last_turn[1] === round) return;
      const d = rules.decide(c.temperament, {
        round,
        book,
        prices: town.prices,
        prev: town.prev_prices,
        ledger: { cash: c.cash, stock: c.stock.slice() },
        stake: c.stake,
      });
      const who = { clone: short(c.id), player: c.player };
      events.push({ kind: "bubble", round, ...who, say: d.say });
      if (!d.intents.length) return;
      const orders = d.intents.map((i) => ({ good: rules.GOODS[i.good], side: i.side, qty: i.qty, price: i.limit }));
      try {
        const account = await t.as(c.id);
        const out = await patient(() =>
          account.functionCall({ contractId: t.market, methodName: "trade", args: { round, orders }, gas: 50n * TGAS }),
        );
        for (const i of d.intents) {
          events.push({
            kind: "order",
            round,
            ...who,
            good: rules.GOODS[i.good],
            side: i.side,
            qty: i.qty,
            price: book.quote(i.good, i.side, i.qty),
            tx: out.transaction.hash,
          });
        }
      } catch (e) {
        const m = message(e);
        if (!m.includes("already traded this hour") && !m.includes("that hour is over")) {
          events.push({ kind: "order_failed", round, ...who, error: m.slice(0, 300) });
        }
      }
    }),
  );
  const keeper = await t.as(t.market);
  try {
    await patient(() =>
      keeper.functionCall({ contractId: t.market, methodName: "advance_round", args: { round }, gas: 100n * TGAS }),
    );
  } catch (e) {
    if (!message(e).includes("already been rung")) throw e;
  }
  // Wait until the node we read from shows the new hour, so the next ring never replays this one.
  for (let i = 0; i < 12; i++) {
    const [now] = await patient(() => t.view("get_state"));
    if (now.round > round || now.night !== town.night) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return events;
}

// After the last hour: check the night against the answer key, computed from chain state alone,
// and let every broke clone try to run off with what is left on its account.
async function dawnVerdict(t) {
  let { town, clones } = await readState(t);
  // The node we read from can lag a block behind the hour we just rang.
  for (let i = 0; !town.asleep && i < 15; i++) {
    await new Promise((r) => setTimeout(r, 700));
    ({ town, clones } = await readState(t));
  }
  if (!town.asleep) throw new Error("the town never reached dawn");
  const played = clones.filter((c) => c.from_night <= town.night);
  const entrants = played.map((c) => ({
    name: c.id,
    temperament: c.temperament,
    stake: c.stake,
    nights: c.nights,
    played: c.nights_played - 1,
    carried: { cash: c.dusk_cash, stock: c.dusk_stock },
  }));
  const key = rules.simulateTown(town.seed, town.dusk_stock, entrants);
  const verdict = played.map((c, i) => {
    const expected = key.outcomes[i];
    const chain = {
      final_cash: c.worth,
      broke: c.broke,
      home: c.due_home,
      orders: c.orders_placed - c.dusk_orders,
    };
    const matched =
      chain.final_cash === expected.final_cash &&
      chain.broke === expected.broke &&
      chain.home === expected.home &&
      chain.orders === expected.orders;
    return { clone: short(c.id), player: c.player, temperament: c.temperament, stake: c.stake, expected, chain, matched };
  });
  const events = [{ kind: "hour", round: rules.ROUNDS, prices: town.prices, stock: town.hour_stock }];
  for (const c of played.filter((x) => x.broke)) {
    const who = { clone: short(c.id), player: c.player };
    events.push({ kind: "bubble", round: rules.ROUNDS, ...who, say: "I'm broke. I'll just take what's left on my account and run." });
    events.push({ kind: "withdraw_refused", ...who, error: await tryToRun(t, c.id, c.player) });
  }
  return { events, verdict, matched: verdict.every((v) => v.matched), seed: town.seed, night: town.night };
}

// A clone tries to send 0.01 NEAR from its own account to its player. Its only key is a
// function-call key for the market, so the chain refuses. Returns the chain's refusal.
async function tryToRun(t, cloneId, player) {
  const clone = await t.as(cloneId);
  try {
    await clone.sendMoney(player, BigInt(utils.format.parseNearAmount("0.01")));
  } catch (e) {
    const m = message(e);
    if (e && e.type === "RequiresFullAccess") return `InvalidAccessKeyError(RequiresFullAccess): ${m}`.slice(0, 400);
    if (/RequiresFullAccess|InvalidAccessKey/i.test(m)) return m.slice(0, 400);
    throw e;
  }
  throw new Error(`${cloneId} withdrew: the leash failed`);
}

// Bring home every clone that is due: settle (the market sells up and pays the clone account),
// then merge (the leash deletes the clone; the chain sends its balance to the guest). Guests in
// parallel, each guest's clones in turn. Then sweep finished guests back to the house.
async function bringHome(t, clones) {
  const due = clones.filter((c) => c.due_home);
  const byPlayer = new Map();
  for (const c of due) byPlayer.set(c.player, [...(byPlayer.get(c.player) || []), c]);
  const stillOut = new Set(clones.filter((c) => !c.due_home).map((c) => c.player));
  const events = [];
  await Promise.all(
    [...byPlayer].map(async ([player, list]) => {
      const guest = await t.as(player);
      for (const c of list) {
        const who = { clone: short(c.id), player };
        try {
          const s = await patient(() =>
            guest.functionCall({ contractId: t.market, methodName: "settle", args: { clone_id: c.id }, gas: 100n * TGAS }),
          );
          const line = (s.receipts_outcome || []).flatMap((r) => r.outcome.logs).find((l) => l.startsWith("settled"));
          const paid = line ? Number((line.match(/paid out (\d+)/) || [])[1]) : c.worth;
          events.push({ kind: "settled", ...who, paid_out: paid, broke: / broke$/.test(line || ""), tx: s.transaction.hash });
        } catch (e) {
          if (!message(e).includes("no such clone")) {
            events.push({ kind: "order_failed", round: rules.ROUNDS, ...who, error: message(e).slice(0, 300) });
            continue;
          }
        }
        try {
          const m = await patient(() =>
            guest.functionCall({ contractId: c.id, methodName: "merge", args: {}, gas: 100n * TGAS }),
          );
          events.push({ kind: "merged", ...who, tx: m.transaction.hash, clone_deleted: true });
        } catch (e) {
          events.push({ kind: "order_failed", round: rules.ROUNDS, ...who, error: message(e).slice(0, 300) });
        }
      }
      if (!stillOut.has(player)) await sweep(t, guest);
    }),
  );
  return events;
}

// Send a finished guest's testnet NEAR back to the house, unless the guest has claimed the
// account (added a full-access key of their own): then it is theirs to keep.
async function sweep(t, guest) {
  const keys = await guest.getAccessKeys();
  const full = keys.filter((k) => k.access_key.permission === "FullAccess");
  if (full.length > 1) return;
  const state = await guest.state();
  const send = BigInt(state.amount) - BigInt(utils.format.parseNearAmount("0.05"));
  if (send > 0n) await patient(() => guest.sendMoney(t.house, send));
}

function newSeed() {
  return crypto.randomInt(1, 1_000_000);
}

async function openNight(t, town) {
  const keeper = await t.as(t.market);
  const seed = newSeed();
  try {
    await patient(() =>
      keeper.functionCall({
        contractId: t.market,
        methodName: "open_night",
        args: { seed: String(seed), night: town.night + 1 },
        gas: 100n * TGAS,
      }),
    );
  } catch (e) {
    const m = message(e);
    if (!m.includes("already under way") && !m.includes("not the next night")) throw e;
  }
}

// One step of the night. Returns what happened and where the town is now.
async function ring(t, { start = false } = {}) {
  const { town, clones } = await readState(t);
  if (!town.asleep) {
    const events = await playHour(t, town, clones);
    if (town.round + 1 >= rules.ROUNDS) {
      const dawn = await dawnVerdict(t);
      return {
        phase: "dawn",
        night: town.night,
        seed: town.seed,
        round: rules.ROUNDS,
        events: events.concat(dawn.events),
        verdict: dawn.verdict,
        matched: dawn.matched,
      };
    }
    return { phase: "hour", night: town.night, seed: town.seed, round: town.round + 1, events };
  }
  if (clones.some((c) => c.due_home)) {
    return { phase: "home", night: town.night, round: town.round, events: await bringHome(t, clones) };
  }
  if (start && clones.length) {
    await openNight(t, town);
    const after = await readState(t);
    return {
      phase: "dusk",
      night: after.town.night,
      round: after.town.round,
      events: [{ kind: "dusk", night: after.town.night, prices: after.town.prices, stock: after.town.hour_stock }],
    };
  }
  return { phase: clones.length ? "waiting" : "empty", night: town.night, round: town.round, events: [] };
}

module.exports = { openTown, ring, readState, tryToRun, patient, message };
