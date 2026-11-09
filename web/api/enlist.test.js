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
