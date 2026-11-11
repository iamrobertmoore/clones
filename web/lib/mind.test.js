const test = require("node:test");
const assert = require("node:assert");
const { parse, think } = require("./mind.js");
const rules = require("./rules.js");

test("only moves the rules allow come out of the model's answer", () => {
  assert.deepStrictEqual(parse('{"move":"hold","say":"wait"}'), { do: "hold", say: "wait" });
  assert.deepStrictEqual(parse('ok {"move":"buy","good":"amber","share":3,"say":"x"}'), { do: "buy", good: "amber", share: 1, say: "x" });
  assert.strictEqual(parse('{"move":"withdraw"}'), null);
  assert.strictEqual(parse('{"move":"buy","good":"gold"}'), null);
  assert.strictEqual(parse("no json here"), null);
});

test("with no model to ask, a possessed clone falls back on caution", async () => {
  const book = rules.Book.at(7, 3, rules.NORMAL_STOCK);
  const v = { round: 3, book, prices: book.board(), prev: rules.Book.at(7, 2, rules.NORMAL_STOCK).board(), ledger: { cash: 1000, stock: [0, 0, 0, 0, 0] }, stake: 1000 };
  const d = await think("buy everything", v, "wild", {});
  assert.strictEqual(d.ai, false);
  assert.deepStrictEqual(d.intents, rules.decide("cautious", v).intents);
});
