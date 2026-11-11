// Send three clones into the hosted town for tonight, with no login.
//
// POST /api/enlist  {"clones": [{"temperament": "greedy", "stake": 500, "nights": 2}, ...]}
//   (or the older {"temperaments": [...]}: 0.5 NEAR, one night each)
//
// Creates a guest player g<id>.<house> and, under it, clone-1..3 whose only key is a function-call
// key for the market's `trade` (it can trade, it can never withdraw), deploys the leash on each,
// and sends each into town with the stake the player chose, for the nights the player chose.
// Testnet only. The house key signs everything; anyone can ring the bell (api/bell.js) to play
// the next night, and a nightly job rings it too. Clones come home at the dawn after their last
// night, or when they go broke.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  connect,
  keyStores,
  KeyPair,
  transactions,
  utils,
} = require("near-api-js");

const TEMPERAMENTS = ["cautious", "greedy", "loyal"];
const STAKES = [250, 500, 1000]; // milliNEAR a player can send a clone in with
const DEFAULT_STAKE = 500;
const CLONE_ACCOUNT = utils.format.parseNearAmount("0.45");
const GAS_FLOAT = utils.format.parseNearAmount("0.3");
const ALLOWANCE = utils.format.parseNearAmount("1");
const MAX_CLONES_TONIGHT = 45; // what the house float can carry
const HOUSE_RESERVE = 2; // NEAR the house always keeps

const leash = fs.readFileSync(path.join(__dirname, "leash.wasm"));

function guestName() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(6);
  return "g" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A brand-new account takes a moment to show up on every RPC node. Before signing, near-api-js
// looks up the signer's key, and if the node it asks hasn't seen the account yet it gives up with
// KeyNotFound. Nothing has been sent at that point, so trying again is safe.
async function whenVisible(fn, tries = 10, waitMs = 1000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const m = String((e && e.message) || "").toLowerCase();
      const rateLimited = (e && e.name === "TooManyRequestsError") || m.includes("rate limits exceeded") || m.includes("429");
      if (e && (e.type === "KeyNotFound" || rateLimited) && attempt < tries) {
        await sleep(rateLimited ? waitMs * attempt : waitMs);
        continue;
      }
      throw e;
    }
  }
}

async function view(account, contractId, methodName, args = {}) {
  return account.viewFunction({ contractId, methodName, args });
}

const milli = (m) => BigInt(m) * 10n ** 21n;

// A token only this sign-up's browser gets, so only it can later claim the guest account.
function claimToken(guest, env = process.env) {
  return crypto.createHmac("sha256", env.HOUSE_KEY.trim()).update(`claim:${guest}`).digest("hex").slice(0, 32);
}

// `opts.guest`: send the clones in under this existing (or new) guest account instead of a fresh
// random one; the town's rival regulars use it.
async function enlist(plan, env = process.env, opts = {}) {
  const temperaments = plan.map((c) => c.temperament);
  const house = env.HOUSE_ACCOUNT;
  const keyPair = KeyPair.fromString(env.HOUSE_KEY.trim());
  const market = env.MARKET_ACCOUNT || `charnel.${house}`;
  const guest = opts.guest || `${guestName()}.${house}`;
  const clones = temperaments.map((_, i) => `clone-${i + 1}.${guest}`);

  const keyStore = new keyStores.InMemoryKeyStore();
  for (const id of [house, guest, ...clones]) {
    await keyStore.setKey("testnet", id, keyPair);
  }
  const near = await connect({
    networkId: "testnet",
    nodeUrl: env.NEAR_RPC || "https://test.rpc.fastnear.com",
    keyStore,
  });
  const houseAccount = await near.account(house);

  const town = await view(houseAccount, market, "get_town");
  if (town.clones_in_town + clones.length > MAX_CLONES_TONIGHT) {
    return {
      status: 409,
      body: { error: "The town is full tonight. Come back tomorrow." },
    };
  }
  // Exactly what the clones need, plus gas: n x account + their stakes + float.
  const guestFund =
    BigInt(clones.length) * BigInt(CLONE_ACCOUNT) +
    plan.reduce((sum, c) => sum + milli(c.stake), 0n) +
    BigInt(GAS_FLOAT);
  const { available } = await houseAccount.getAccountBalance();
  const need =
    guestFund + BigInt(utils.format.parseNearAmount(String(HOUSE_RESERVE)));
  if (BigInt(available) < need) {
    return {
      status: 409,
      body: { error: "The house is out of testnet NEAR tonight." },
    };
  }

  const txs = [];
  const pk = keyPair.getPublicKey();
  let exists = false;
  if (opts.guest) {
    try {
      await (await near.account(guest)).state();
      exists = true;
    } catch {
      exists = false;
    }
  }
  let out = exists
    ? await whenVisible(() => houseAccount.sendMoney(guest, guestFund))
    : await whenVisible(() => houseAccount.signAndSendTransaction({
        receiverId: guest,
        actions: [
          transactions.createAccount(),
          transactions.transfer(guestFund),
          transactions.addKey(pk, transactions.fullAccessKey()),
        ],
      }));
  txs.push({ step: exists ? "guest funded" : "guest created", tx: out.transaction.hash });

  const guestAccount = await near.account(guest);
  const made = [];
  const sentIn = [];
  try {
    for (let i = 0; i < clones.length; i++) {
      out = await whenVisible(() =>
        guestAccount.signAndSendTransaction({
          receiverId: clones[i],
          actions: [
            transactions.createAccount(),
            transactions.transfer(BigInt(CLONE_ACCOUNT)),
            transactions.addKey(
              pk,
              transactions.functionCallAccessKey(
                market,
                ["trade"],
                BigInt(ALLOWANCE),
              ),
            ),
            transactions.deployContract(leash),
          ],
        }),
      );
      made.push(clones[i]);
      txs.push({
        step: `${clones[i].split(".")[0]} created`,
        tx: out.transaction.hash,
      });
      out = await whenVisible(() =>
        guestAccount.functionCall({
          contractId: market,
          methodName: "register_clone",
          args: { clone_id: clones[i], temperament: plan[i].temperament, nights: plan[i].nights },
          gas: BigInt("30000000000000"),
          attachedDeposit: milli(plan[i].stake),
        }),
      );
      sentIn.push(clones[i]);
      txs.push({
        step: `${clones[i].split(".")[0]} sent in`,
        tx: out.transaction.hash,
      });
    }
  } catch (e) {
    // Only an account this sign-up created is deleted; a regular's account stays.
    await rollBack(guestAccount, market, house, made, sentIn, !exists);
    throw e;
  }
  return {
    status: 200,
    body: { guest, market, clones, temperaments, plan, txs, claim: claimToken(guest, env) },
  };
}

// Something failed half way: bring every NEAR back to the house so nothing is stranded.
async function rollBack(guestAccount, market, house, made, sentIn, deleteGuest = true) {
  const attempt = async (what, fn) => {
    try {
      await whenVisible(fn);
    } catch (e) {
      console.error(`roll back: ${what} failed`, e);
    }
  };
  for (const clone of sentIn) {
    await attempt(`settle ${clone}`, () =>
      guestAccount.functionCall({
        contractId: market,
        methodName: "settle",
        args: { clone_id: clone },
        gas: BigInt("100000000000000"),
      }),
    );
  }
  for (const clone of made) {
    await attempt(`merge ${clone}`, () =>
      guestAccount.functionCall({
        contractId: clone,
        methodName: "merge",
        args: {},
        gas: BigInt("100000000000000"),
      }),
    );
  }
  if (deleteGuest) await attempt("delete guest", () => guestAccount.deleteAccount(house));
}

function parseTemperaments(body) {
  const list =
    body && Array.isArray(body.temperaments) ? body.temperaments : TEMPERAMENTS;
  if (
    list.length < 1 ||
    list.length > 3 ||
    !list.every((t) => TEMPERAMENTS.includes(t))
  ) {
    return null;
  }
  return list;
}

// The player's plan: one to three clones, each a temperament, a stake and a number of nights.
function parsePlan(body) {
  if (body && Array.isArray(body.clones)) {
    const list = body.clones;
    if (list.length < 1 || list.length > 3) return null;
    const plan = list.map((c) => ({
      temperament: c && c.temperament,
      stake: c && c.stake === undefined ? DEFAULT_STAKE : Number(c && c.stake),
      nights: c && c.nights === undefined ? 1 : Number(c && c.nights),
    }));
    const ok = plan.every(
      (c) =>
        TEMPERAMENTS.includes(c.temperament) &&
        STAKES.includes(c.stake) &&
        Number.isInteger(c.nights) &&
        c.nights >= 1 &&
        c.nights <= 3,
    );
    return ok ? plan : null;
  }
  const ts = parseTemperaments(body);
  return ts ? ts.map((t) => ({ temperament: t, stake: DEFAULT_STAKE, nights: 1 })) : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const plan = parsePlan(body);
  if (!plan) {
    res.status(400).json({
      error:
        "clones: one to three, each a temperament (cautious, greedy, loyal), a stake (250, 500 or 1000 milliNEAR) and 1 to 3 nights",
    });
    return;
  }
  try {
    const { status, body: out } = await enlist(plan);
    res.status(status).json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "Could not send the clones in. Try again in a minute." });
    console.error(e);
  }
};

module.exports.enlist = enlist;
module.exports.parseTemperaments = parseTemperaments;
module.exports.parsePlan = parsePlan;
module.exports.claimToken = claimToken;
module.exports.whenVisible = whenVisible;
