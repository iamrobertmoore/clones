const test = require("node:test");
const assert = require("node:assert");
const { parseTemperaments } = require("./enlist.js");

test("defaults to one clone of each temperament", () => {
  assert.deepStrictEqual(parseTemperaments({}), [
    "cautious",
    "greedy",
    "loyal",
  ]);
});

test("accepts one to three known temperaments", () => {
  assert.deepStrictEqual(parseTemperaments({ temperaments: ["greedy"] }), [
    "greedy",
  ]);
  assert.deepStrictEqual(
    parseTemperaments({ temperaments: ["loyal", "loyal"] }),
    ["loyal", "loyal"],
  );
});

test("refuses anything else", () => {
  assert.strictEqual(parseTemperaments({ temperaments: [] }), null);
  assert.strictEqual(parseTemperaments({ temperaments: ["reckless"] }), null);
  assert.strictEqual(
    parseTemperaments({
      temperaments: ["greedy", "greedy", "greedy", "greedy"],
    }),
    null,
  );
});

const { whenVisible } = require("./enlist.js");
const notYet = () =>
  Object.assign(new Error("no matching key pair"), { type: "KeyNotFound" });

test("waits for a new account to show up before signing", async () => {
  let calls = 0;
  const out = await whenVisible(
    async () => {
      calls++;
      if (calls < 3) throw notYet();
      return "sent";
    },
    5,
    1,
  );
  assert.strictEqual(out, "sent");
  assert.strictEqual(calls, 3);
});

test("does not retry anything that may have been sent", async () => {
  let calls = 0;
  await assert.rejects(
    whenVisible(
      async () => {
        calls++;
        throw new Error("AccountAlreadyExists");
      },
      5,
      1,
    ),
    /AccountAlreadyExists/,
  );
  assert.strictEqual(calls, 1);
});

test("gives up after the last try", async () => {
  let calls = 0;
  await assert.rejects(
    whenVisible(
      async () => {
        calls++;
        throw notYet();
      },
      4,
      1,
    ),
    /no matching key pair/,
  );
  assert.strictEqual(calls, 4);
});

const { parsePlan, claimToken } = require("./enlist.js");

test("a plan is one to three clones with a temperament, a stake and 1 to 3 nights", () => {
  assert.deepStrictEqual(
    parsePlan({ clones: [{ temperament: "greedy", stake: 1000, nights: 3 }] }),
    [{ temperament: "greedy", stake: 1000, nights: 3 }],
  );
  assert.deepStrictEqual(parsePlan({ clones: [{ temperament: "loyal" }] }), [
    { temperament: "loyal", stake: 500, nights: 1 },
  ]);
  assert.deepStrictEqual(parsePlan({ temperaments: ["cautious"] }), [
    { temperament: "cautious", stake: 500, nights: 1 },
  ]);
  assert.strictEqual(parsePlan({ clones: [{ temperament: "greedy", stake: 5000 }] }), null);
  assert.strictEqual(parsePlan({ clones: [{ temperament: "greedy", nights: 4 }] }), null);
  assert.strictEqual(parsePlan({ clones: [null] }), null);
  assert.strictEqual(parsePlan({ clones: [] }), null);
});

test("a claim token is tied to one guest and the house key", () => {
  const env = { HOUSE_KEY: "ed25519:secret" };
  const a = claimToken("ga.house.testnet", env);
  assert.strictEqual(a, claimToken("ga.house.testnet", env));
  assert.notStrictEqual(a, claimToken("gb.house.testnet", env));
  assert.notStrictEqual(a, claimToken("ga.house.testnet", { HOUSE_KEY: "ed25519:other" }));
});

test("waits out the RPC's rate limit, which never lets a call through", async () => {
  let calls = 0;
  const out = await whenVisible(
    async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("Rate limits exceeded"), { name: "TooManyRequestsError" });
      return "sent";
    },
    5,
    1,
  );
  assert.strictEqual(out, "sent");
  assert.strictEqual(calls, 3);
});

test("a possessed clone carries a short instruction", () => {
  const [c] = parsePlan({ clones: [{ temperament: "possessed", instruction: "  Buy   amber  " + "x".repeat(300) }] });
  assert.strictEqual(c.temperament, "possessed");
  assert.ok(c.instruction.startsWith("Buy amber"));
  assert.strictEqual(c.instruction.length, 160);
});
