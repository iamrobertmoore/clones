const test = require("node:test");
const assert = require("node:assert");
const rules = require("./rules.js");
const golden = require("./golden.json");

test("the JavaScript rules play every golden night exactly as the Rust rules did", () => {
  assert.ok(golden.cases.length >= 20);
  for (const c of golden.cases) {
    const night = rules.simulateTown(c.seed, c.stock, c.entrants);
    assert.deepStrictEqual(night, c.night, `seed ${c.seed}`);
  }
});

test("splitmix64 matches the published reference value", () => {
  // First output of splitmix64 seeded with 0 (Vigna's reference implementation).
  assert.strictEqual(rules.mix(0), 0xe220a8397b1dcdafn);
});

test("a big buy is quoted dearer than the board and a big sale cheaper", () => {
  const b = rules.Book.at(7, 0, rules.NORMAL_STOCK);
  assert.ok(b.quote(4, "buy", 50) > b.board()[4]);
  assert.ok(b.quote(4, "sell", 50) < b.board()[4]);
});
