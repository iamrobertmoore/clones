const test = require("node:test");
const assert = require("node:assert");
const rules = require("./rules.js");
const { audit, playedFrom } = require("./night.js");

// Play a seeded night the way the runner does, recording orders as the chain would, with an
// optional whisper {clone, round, whisper}. Returns what the audit reads from chain state.
function playNight(seed, whispers = [], feeBps = rules.FEE_BPS) {
  const names = ["clone-1.p.testnet", "clone-2.p.testnet", "clone-3.p.testnet"];
  const temps = ["cautious", "greedy", "loyal"];
  const hours = [];
  for (let r = 0; r <= rules.ROUNDS; r++) hours.push(rules.pricesAt(seed, r));
  let stock = rules.NORMAL_STOCK.slice();
  const ledgers = names.map(() => ({ cash: 2000, stock: [0, 0, 0, 0, 0] }));
  const orders = [];
  let prev = new rules.Book(hours[0], stock, feeBps).board();
  for (let round = 0; round < rules.ROUNDS; round++) {
    const book = new rules.Book(hours[round], stock, feeBps);
    const board = book.board();
    const moved = stock.slice();
    names.forEach((id, i) => {
      const view = { round, book, prices: board, prev, ledger: { cash: ledgers[i].cash, stock: ledgers[i].stock.slice() }, stake: 2000 };
      const w = whispers.find((x) => x.clone === id && x.round === round);
      const d = w ? rules.obey(w.whisper, view) : rules.decide(temps[i], view);
      if (!d.intents.length) return;
      const fills = rules.applyTurn(ledgers[i], moved, book, d.intents);
      d.intents.forEach((it, k) =>
        orders.push({ night: 1, round, clone: id, good: rules.GOODS[it.good], side: it.side, qty: it.qty, price: fills[k].price, fee: fills[k].fee }),
      );
    });
    stock = moved;
    prev = board;
  }
  const dawn = new rules.Book(hours[rules.ROUNDS], stock, feeBps);
  const pot = orders.reduce((t, o) => t + o.fee, 0);
  const win = rules.crownWinner(names.map((id, i) => ({ name: id, worth: rules.worth(ledgers[i], dawn), stake: 2000 })));
  ledgers[win].cash += pot;
  const crowned = [names[win], pot, 1];
  const clones = names.map((id, i) => {
    const worth = rules.worth(ledgers[i], dawn);
    const broke = rules.isBroke(worth, 2000);
    const w = whispers.find((x) => x.clone === id);
    return {
      id,
      player: "p.testnet",
      temperament: temps[i],
      stake: 2000,
      from_night: 1,
      nights: 1,
      nights_played: 1,
      dusk_cash: 2000,
      dusk_stock: [0, 0, 0, 0, 0],
      dusk_orders: 0,
      orders_placed: orders.filter((o) => o.clone === id).length,
      worth,
      broke,
      due_home: true,
      whisper: w ? [1, w.round, w.whisper] : null,
      whispers_tonight: whispers.filter((x) => x.clone === id).map((x) => [1, x.round, x.whisper]),
    };
  });
  return { town: { night: 1, dusk_stock: rules.NORMAL_STOCK.slice(), hours, crowned, fee_bps: feeBps }, clones, orders };
}

test("the audit passes a fair night and agrees with the off-chain simulation", () => {
  const { town, clones, orders } = playNight(606);
  const a = audit(town, clones, orders);
  assert.deepStrictEqual(a.problems, []);
  const sim = rules.simulateTown(606, rules.NORMAL_STOCK, [
    { name: "clone-1.p.testnet", temperament: "cautious", stake: 2000 },
    { name: "clone-2.p.testnet", temperament: "greedy", stake: 2000 },
    { name: "clone-3.p.testnet", temperament: "loyal", stake: 2000 },
  ]);
  assert.deepStrictEqual(a.verdict.map((v) => v.expected.final_cash), sim.outcomes.map((o) => o.final_cash));
  assert.ok(a.verdict[1].expected.broke, "the demo night's greedy clone goes broke");
});

test("the audit checks the crown went to the best return", () => {
  const { town, clones, orders } = playNight(606);
  town.crowned = [clones[2].id, town.crowned[1], 1];
  assert.ok(audit(town, clones, orders).problems.some((p) => p.startsWith("crown")));
});

test("the audit catches a fill at the wrong price", () => {
  const { town, clones, orders } = playNight(606);
  orders[2].price += 1;
  assert.ok(audit(town, clones, orders).problems.length > 0);
});

test("a whispered hour is checked against the whisper, not the temperament", () => {
  const whispers = [{ clone: "clone-2.p.testnet", round: 5, whisper: { do: "sell_all" } }];
  const { town, clones, orders } = playNight(606, whispers);
  assert.deepStrictEqual(audit(town, clones, orders).problems, []);
  // The same orders without the whisper on record look like a clone ignoring its temperament.
  clones[1].whisper = null;
  clones[1].whispers_tonight = [];
  assert.ok(audit(town, clones, orders).problems.some((p) => p.includes("hour 5")));
});

test("the audit replays a night at the fee the deed holder set", () => {
  const { town, clones, orders } = playNight(606, [], rules.MAX_FEE_BPS);
  assert.deepStrictEqual(audit(town, clones, orders).problems, []);
  // The same night read as if the standard fee applied: every fee looks wrong.
  town.fee_bps = rules.FEE_BPS;
  assert.ok(audit(town, clones, orders).problems.some((p) => p.includes("price or fee")));
});

test("two whispers in a night are both checked, from the whisper log", () => {
  const whispers = [
    { clone: "clone-2.p.testnet", round: 3, whisper: { do: "hold" } },
    { clone: "clone-2.p.testnet", round: 7, whisper: { do: "sell_all" } },
  ];
  const { town, clones, orders } = playNight(606, whispers);
  assert.deepStrictEqual(audit(town, clones, orders).problems, []);
});

test("a finished night is audited after its clones came home, from their settlements", () => {
  const { town, clones, orders } = playNight(606);
  // Two clones settled and left town; their settlements keep their dusk ledger.
  const settlements = clones.slice(0, 2).map((c) => ({
    player: c.player, clone: c.id, temperament: c.temperament, night: 1, stake: c.stake, paid_out: c.worth, broke: c.broke,
    orders_placed: c.orders_placed, nights_played: 1, from_night: 1, nights: 1, dusk_cash: c.dusk_cash, dusk_stock: c.dusk_stock,
    dusk_orders: 0, whispers: [],
  }));
  const played = playedFrom(clones.slice(2), settlements, 1);
  assert.strictEqual(played.length, 3);
  assert.deepStrictEqual(audit(town, played, orders).problems, []);
  // Without the settled clones the crown looks wrong: they matter.
  assert.ok(audit(town, clones.slice(2), orders).problems.length > 0);
});
