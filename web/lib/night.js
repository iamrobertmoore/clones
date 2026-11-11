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
const { connect, keyStores, KeyPair, utils, transactions } = require("near-api-js");
const rules = require("./rules.js");

const TGAS = 1_000_000_000_000n;
const short = (id) => id.split(".")[0];

async function openTown(env = process.env) {
  const house = env.HOUSE_ACCOUNT;
  const keyPair = KeyPair.fromString(env.HOUSE_KEY.trim());
  const market = env.MARKET_ACCOUNT || `charnel.${house}`;
  const keyStore = new keyStores.InMemoryKeyStore();
  // Accounts are spread across public RPC endpoints, so a busy town does not trip one node's
  // rate limit. Views go to the first.
  const urls = (env.NEAR_RPCS || env.NEAR_RPC || "https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com").split(",");
  const nears = await Promise.all(urls.map((nodeUrl) => connect({ networkId: "testnet", nodeUrl, keyStore })));
  const near = nears[0];
  const accounts = new Map();
  const spread = (id) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % nears.length;
  const as = async (id) => {
    if (!accounts.has(id)) {
      await keyStore.setKey("testnet", id, keyPair);
      accounts.set(id, await nears[spread(id)].account(id));
    }
    return accounts.get(id);
  };
  const houseAccount = await as(house);
  const view = (methodName, args = {}) =>
    houseAccount.viewFunction({ contractId: market, methodName, args });
  return { near, house, market, keyPair, as, view, houseAccount };
}

const message = (e) => String((e && (e.message || e.type)) || e);

// Retry a call the RPC node turned away for load; such a call never reached the chain.
async function patient(fn, tries = 10) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const m = message(e).toLowerCase();
      const busy =
        m.includes("429") || m.includes("rate") || m.includes("too many") || (e && (e.type === "KeyNotFound" || e.name === "TooManyRequestsError"));
      if (!busy || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, Math.min(4000, 300 * 2 ** Math.min(i, 4)) + Math.random() * 400));
    }
  }
}

// Run async jobs with at most `n` at a time, so a busy town does not trip the RPC's rate limit.
async function pool(items, n, job) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await job(items[i], i);
      }
    }),
  );
  return out;
}

async function readState(t) {
  const [town, clones] = await patient(() => t.view("get_state"));
  town.seed = Number(town.seed);
  return { town, clones: clones.map(([id, v]) => ({ id, ...v })) };
}

// Play hour `town.round`: every clone in tonight takes its turn, then the keeper rings the hour.
async function playHour(t, town, clones) {
  const round = town.round;
  // The usual prices come from the chain (in the hosted town, drawn from block randomness as the
  // hour was rung), never from the seed.
  const book = new rules.Book(town.hours[round], town.hour_stock);
  const events = [{ kind: "hour", round, prices: town.prices, stock: town.hour_stock }];
  const playing = clones.filter((c) => c.from_night <= town.night);
  const missed = [];
  await pool(playing, 4, async (c) => {
      if (c.last_turn && c.last_turn[0] === town.night && c.last_turn[1] === round) return;
      const view = {
        round,
        book,
        prices: town.prices,
        prev: town.prev_prices,
        ledger: { cash: c.cash, stock: c.stock.slice() },
        stake: c.stake,
      };
      const whispered = whisperFor(c, town.night, round);
      const d = whispered ? rules.obey(whispered, view) : rules.decide(c.temperament, view);
      const who = { clone: short(c.id), player: c.player };
      events.push({ kind: "bubble", round, ...who, say: d.say, whispered: Boolean(whispered) });
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
        if (!m.includes("already traded this hour") && !m.includes("that hour is over")) missed.push({ c, d, orders, who, m });
      }
  });
  // A turn the RPC turned away is sent once more, alone, before the hour is rung.
  for (const x of missed) {
    try {
      const account = await t.as(x.c.id);
      const out = await patient(
        () => account.functionCall({ contractId: t.market, methodName: "trade", args: { round, orders: x.orders }, gas: 50n * TGAS }),
        14,
      );
      for (const i of x.d.intents) {
        events.push({ kind: "order", round, ...x.who, good: rules.GOODS[i.good], side: i.side, qty: i.qty, price: book.quote(i.good, i.side, i.qty), tx: out.transaction.hash });
      }
    } catch (e) {
      const m = message(e);
      if (!m.includes("already traded this hour")) events.push({ kind: "order_failed", round, ...x.who, error: m.slice(0, 300) });
    }
  }
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

// The whisper a clone obeys in this hour, if its player sent one for it.
function whisperFor(c, night, round) {
  return c.whisper && c.whisper[0] === night && c.whisper[1] === round ? c.whisper[2] : null;
}

// All of tonight's orders, from the market's order book.
async function ordersTonight(t, from) {
  const out = [];
  for (let at = from; ; at += 100) {
    const page = await patient(() => t.view("get_orders", { from: at, limit: 100 }));
    out.push(...page);
    if (page.length < 100) return out;
  }
}

// Audit a finished night from chain state alone: start from every clone's holdings and the
// merchant's stock at dusk, replay every recorded order through the rules at the hour's recorded
// prices, and check (a) each clone's turn is what its temperament, or its player's whisper, says
// it should be, (b) every fill price is the merchant's quote, and (c) what each clone is worth at
// dawn is what the chain says.
function audit(town, clones, orders) {
  const played = clones.filter((c) => c.from_night <= town.night);
  const ledgers = new Map(played.map((c) => [c.id, { cash: c.dusk_cash, stock: c.dusk_stock.slice() }]));
  const turns = new Map();
  for (const o of orders) {
    if (o.night !== town.night) continue;
    const k = `${o.round}|${o.clone}`;
    turns.set(k, [...(turns.get(k) || []), o]);
  }
  const problems = [];
  const counted = new Map(played.map((c) => [c.id, 0]));
  let stock = town.dusk_stock.slice();
  let prev = new rules.Book(town.hours[0], stock).board();
  let pot = 0;
  for (let round = 0; round < rules.ROUNDS; round++) {
    const book = new rules.Book(town.hours[round], stock);
    const board = book.board();
    const moved = stock.slice();
    for (const c of played) {
      const l = ledgers.get(c.id);
      const view = { round, book, prices: board, prev, ledger: { cash: l.cash, stock: l.stock.slice() }, stake: c.stake };
      const w = whisperFor(c, town.night, round);
      const want = (w ? rules.obey(w, view) : rules.decide(c.temperament, view)).intents;
      const got = turns.get(`${round}|${c.id}`) || [];
      const same =
        want.length === got.length &&
        want.every((i, k) => rules.GOODS[i.good] === got[k].good && i.side === got[k].side && i.qty === got[k].qty);
      if (!same) problems.push(`${short(c.id)} hour ${round}: expected ${JSON.stringify(want)}, chain has ${JSON.stringify(got)}`);
      if (!got.length) continue;
      const intents = got.map((o) => ({ good: rules.GOODS.indexOf(o.good), side: o.side, qty: o.qty, limit: o.price }));
      try {
        const fills = rules.applyTurn(l, moved, book, intents);
        fills.forEach((f, k) => {
          if (f.price !== got[k].price || f.fee !== got[k].fee) problems.push(`${short(c.id)} hour ${round}: price or fee differs`);
          pot += f.fee;
        });
        counted.set(c.id, counted.get(c.id) + got.length);
      } catch (e) {
        problems.push(`${short(c.id)} hour ${round}: ${e.message}`);
      }
    }
    stock = moved;
    prev = board;
  }
  const dawn = new rules.Book(town.hours[rules.ROUNDS], stock);
  // The crown: tonight's fees to the best return on stake.
  const w = pot > 0 ? rules.crownWinner(played.map((c) => ({ name: c.id, worth: rules.worth(ledgers.get(c.id), dawn), stake: c.stake }))) : -1;
  const crown = w >= 0 ? { clone: played[w].id, pot } : null;
  if (crown) ledgers.get(crown.clone).cash += pot;
  const onChain = town.crowned && town.crowned[2] === town.night ? { clone: town.crowned[0], pot: town.crowned[1] } : null;
  if (JSON.stringify(crown) !== JSON.stringify(onChain)) problems.push(`crown: expected ${JSON.stringify(crown)}, chain has ${JSON.stringify(onChain)}`);
  const verdict = played.map((c) => {
    const w = rules.worth(ledgers.get(c.id), dawn);
    const broke = rules.isBroke(w, c.stake);
    const expected = {
      final_cash: w,
      broke,
      home: broke || c.nights_played >= c.nights,
      orders: counted.get(c.id),
    };
    const chain = { final_cash: c.worth, broke: c.broke, home: c.due_home, orders: c.orders_placed - c.dusk_orders };
    const matched = JSON.stringify(expected) === JSON.stringify(chain);
    if (!matched) problems.push(`${short(c.id)} at dawn: expected ${JSON.stringify(expected)}, chain has ${JSON.stringify(chain)}`);
    return { clone: short(c.id), player: c.player, temperament: c.temperament, stake: c.stake, expected, chain, matched };
  });
  return { verdict, problems, crown, orders: orders.filter((o) => o.night === town.night).length };
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
  const { verdict, problems, orders, crown } = audit(town, clones, await ordersTonight(t, town.dusk_order));
  if (problems.length) console.error("audit:", problems.slice(0, 10));
  const events = [{ kind: "hour", round: rules.ROUNDS, prices: town.prices, stock: town.hour_stock }];
  if (crown) {
    const c = played.find((x) => x.id === crown.clone);
    events.push({ kind: "crowned", clone: short(crown.clone), player: c ? c.player : null, pot: crown.pot });
  }
  for (const c of played.filter((x) => x.broke)) {
    const who = { clone: short(c.id), player: c.player };
    events.push({ kind: "bubble", round: rules.ROUNDS, ...who, say: "I'm broke. I'll just take what's left on my account and run." });
    events.push({ kind: "withdraw_refused", ...who, error: await tryToRun(t, c.id, c.player) });
  }
  return {
    events,
    verdict,
    matched: problems.length === 0,
    audited: orders,
    problems: problems.slice(0, 10),
    seed: town.seed,
    night: town.night,
    mood: town.mood,
    omen: town.omen,
  };
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
      // A house guest whose account went missing (a failed sign-up rolled it back) is made again,
      // so its clones can still settle and merge home.
      if (player.endsWith(`.${t.house}`) && !(await exists(t, player))) await recreate(t, player).catch((e) => console.error(`recreate ${player}:`, message(e)));
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
          const m = await patient(
            () => guest.functionCall({ contractId: c.id, methodName: "merge", args: {}, gas: 100n * TGAS }),
            14,
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

// The town's regulars: three house players who send clones in every night someone rings the
// bell, so a guest is never alone at the merchant and the crown is always contested. Each has a
// style; the Widow reads the omen (and, given a NEAR AI key, asks a model what to send).
const RIVALS = [
  { name: "widow", title: "the Widow", plan: (omen) => widowPlan(omen) },
  { name: "abbot", title: "the Abbot", plan: () => [{ temperament: "cautious", stake: 500, nights: 1 }] },
  { name: "hound", title: "the Hound", plan: () => [{ temperament: "greedy", stake: 1000, nights: 1 }] },
];
const FAVOURS = { boom: "greedy", slump: "cautious", blight: "loyal", wild: "cautious" };
function widowPlan(omen) {
  const t = FAVOURS[omen] || "cautious";
  return [
    { temperament: t, stake: 1000, nights: 1 },
    { temperament: t === "loyal" ? "cautious" : "loyal", stake: 250, nights: 1 },
  ];
}
const rivalId = (t, r) => `${r.name}.${t.house}`;
const isRival = (t, player) => RIVALS.some((r) => rivalId(t, r) === player);

// Send in every regular who has no clones in town. Runs before a night opens.
async function ensureRivals(t, town, clones, env = process.env) {
  const { enlist } = require("../api/enlist.js");
  const here = new Set(clones.map((c) => c.player));
  const missing = RIVALS.filter((r) => !here.has(rivalId(t, r)));
  const results = await Promise.all(
    missing.map(async (r) => {
      try {
        await tidyRival(t, rivalId(t, r));
        const out = await enlist(r.plan(town.omen), env, { guest: rivalId(t, r) });
        return out.status === 200 ? r.title : null;
      } catch (e) {
        console.error(`rival ${r.name}:`, message(e));
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

const exists = async (t, id) => {
  try {
    await (await t.as(id)).state();
    return true;
  } catch {
    return false;
  }
};

async function recreate(t, id) {
  const house = await t.as(t.house);
  await patient(() =>
    house.signAndSendTransaction({
      receiverId: id,
      actions: [
        transactions.createAccount(),
        transactions.transfer(BigInt(utils.format.parseNearAmount("0.2"))),
        transactions.addKey(t.keyPair.getPublicKey(), transactions.fullAccessKey()),
      ],
    }),
  );
}

// Before a regular comes back: make sure its account exists, and merge any clone of its that a
// busy RPC left behind (settled, but not yet merged home).
async function tidyRival(t, id) {
  if (!(await exists(t, id))) await recreate(t, id);
  const rival = await t.as(id);
  for (const n of [1, 2, 3]) {
    const clone = `clone-${n}.${id}`;
    if (await exists(t, clone)) {
      await patient(() => rival.functionCall({ contractId: clone, methodName: "merge", args: {}, gas: 100n * TGAS })).catch((e) =>
        console.error(`tidy ${clone}:`, message(e)),
      );
    }
  }
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
        audited: dawn.audited,
        problems: dawn.problems,
        mood: dawn.mood,
        omen: dawn.omen,
      };
    }
    return { phase: "hour", night: town.night, seed: town.seed, round: town.round + 1, events };
  }
  // Dawn chores first: bring home every clone that is due. A clone that cannot come home now
  // (a busy RPC) never blocks the next night; it is tried again at the next ring.
  const home = clones.some((c) => c.due_home) ? await bringHome(t, clones) : [];
  const after = home.length ? await readState(t) : { town, clones };
  if (start && after.clones.some((c) => !isRival(t, c.player) && !c.due_home)) {
    const arrived = await ensureRivals(t, after.town, after.clones);
    await openNight(t, after.town);
    const dusk = await readState(t);
    return {
      phase: "dusk",
      night: dusk.town.night,
      round: dusk.town.round,
      mood: dusk.town.mood,
      omen: dusk.town.omen,
      events: [
        ...home,
        ...arrived.map((title) => ({ kind: "rival", title })),
        {
          kind: "dusk",
          night: dusk.town.night,
          mood: dusk.town.mood,
          omen: dusk.town.omen,
          prices: dusk.town.prices,
          stock: dusk.town.hour_stock,
        },
      ],
    };
  }
  if (home.length) return { phase: "home", night: town.night, round: town.round, events: home };
  return {
    phase: clones.some((c) => !isRival(t, c.player)) ? "waiting" : "empty",
    night: town.night,
    round: town.round,
    events: [],
  };
}

module.exports = { openTown, ring, readState, tryToRun, bringHome, patient, message, audit, RIVALS, isRival };
