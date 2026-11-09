const test = require("node:test");
const assert = require("node:assert");
const { parseTemperaments } = require("./enlist.js");

test("defaults to one clone of each temperament", () => {
  assert.deepStrictEqual(parseTemperaments({}), ["cautious", "greedy", "loyal"]);
});

test("accepts one to three known temperaments", () => {
  assert.deepStrictEqual(parseTemperaments({ temperaments: ["greedy"] }), ["greedy"]);
  assert.deepStrictEqual(parseTemperaments({ temperaments: ["loyal", "loyal"] }), ["loyal", "loyal"]);
});

test("refuses anything else", () => {
  assert.strictEqual(parseTemperaments({ temperaments: [] }), null);
  assert.strictEqual(parseTemperaments({ temperaments: ["reckless"] }), null);
  assert.strictEqual(parseTemperaments({ temperaments: ["greedy", "greedy", "greedy", "greedy"] }), null);
});
