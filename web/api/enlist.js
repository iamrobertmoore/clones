// Send three clones into the hosted town for tonight, with no login.
//
// POST /api/enlist  {"temperaments": ["cautious", "greedy", "loyal"]}
//
// Creates a guest player g<id>.<house> and, under it, clone-1..3 whose only key is a function-call
// key for the market's place_order (it can trade, it can never withdraw), deploys the leash on
// each, and sends each into town with its stake. Testnet only. The house key signs everything;
// the nightly keeper plays the night and merges every clone home at dawn.

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
const STAKE = utils.format.parseNearAmount("0.5");
const CLONE_ACCOUNT = utils.format.parseNearAmount("0.45");
const GAS_FLOAT = utils.format.parseNearAmount("0.15");
const ALLOWANCE = utils.format.parseNearAmount("1");
const MAX_CLONES_TONIGHT = 15; // what the house float can carry
const HOUSE_RESERVE = 2; // NEAR the house always keeps

const leash = fs.readFileSync(path.join(__dirname, "leash.wasm"));

function guestName() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(6);
  return "g" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function view(account, contractId, methodName, args = {}) {
  return account.viewFunction({ contractId, methodName, args });
}

async function enlist(temperaments, env = process.env) {
  const house = env.HOUSE_ACCOUNT;
  const keyPair = KeyPair.fromString(env.HOUSE_KEY.trim());
  const market = `market.${house}`;
  const guest = `${guestName()}.${house}`;
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
  // Exactly what the clones need, plus gas: n x (account + stake) + float.
  const guestFund =
    BigInt(clones.length) * (BigInt(CLONE_ACCOUNT) + BigInt(STAKE)) +
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
  let out = await houseAccount.signAndSendTransaction({
    receiverId: guest,
    actions: [
      transactions.createAccount(),
      transactions.transfer(guestFund),
      transactions.addKey(pk, transactions.fullAccessKey()),
    ],
  });
  txs.push({ step: "guest created", tx: out.transaction.hash });

  const guestAccount = await near.account(guest);
  const made = [];
  const sentIn = [];
  try {
    for (let i = 0; i < clones.length; i++) {
      out = await guestAccount.signAndSendTransaction({
        receiverId: clones[i],
        actions: [
          transactions.createAccount(),
          transactions.transfer(BigInt(CLONE_ACCOUNT)),
          transactions.addKey(
            pk,
            transactions.functionCallAccessKey(
              market,
              ["place_order"],
              BigInt(ALLOWANCE),
            ),
          ),
          transactions.deployContract(leash),
        ],
      });
      made.push(clones[i]);
      txs.push({
        step: `${clones[i].split(".")[0]} created`,
        tx: out.transaction.hash,
      });
      out = await guestAccount.functionCall({
        contractId: market,
        methodName: "register_clone",
        args: { clone_id: clones[i], temperament: temperaments[i] },
        gas: BigInt("30000000000000"),
        attachedDeposit: BigInt(STAKE),
      });
      sentIn.push(clones[i]);
      txs.push({
        step: `${clones[i].split(".")[0]} sent in`,
        tx: out.transaction.hash,
      });
    }
  } catch (e) {
    await rollBack(guestAccount, market, house, made, sentIn);
    throw e;
  }
  return { status: 200, body: { guest, market, clones, temperaments, txs } };
}

// Something failed half way: bring every NEAR back to the house so nothing is stranded.
async function rollBack(guestAccount, market, house, made, sentIn) {
  const attempt = async (what, fn) => {
    try {
      await fn();
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
  await attempt("delete guest", () => guestAccount.deleteAccount(house));
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
  const temperaments = parseTemperaments(body);
  if (!temperaments) {
    res
      .status(400)
      .json({ error: "temperaments: one to three of cautious, greedy, loyal" });
    return;
  }
  try {
    const { status, body: out } = await enlist(temperaments);
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
