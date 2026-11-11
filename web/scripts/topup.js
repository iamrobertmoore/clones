// Keep the hosted town's house funded with testnet NEAR during judging: if the house holds less
// than MIN_NEAR, create up to N fresh accounts through testnet's faucet (it funds each one) and
// sweep each into the house. Testnet only. The nightly job runs this before ringing the bell.
//
//     HOUSE_ACCOUNT=clonestown.testnet node scripts/topup.js

const crypto = require("crypto");
const { connect, keyStores, KeyPair, utils } = require("near-api-js");

const HELPER = "https://helper.testnet.near.org/account";
const MIN_NEAR = Number(process.env.MIN_NEAR || 25);
const N = Number(process.env.TOPUPS || 3);

async function main() {
  const house = process.env.HOUSE_ACCOUNT;
  const keyStore = new keyStores.InMemoryKeyStore();
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC || "https://test.rpc.fastnear.com", keyStore });
  const have = Number(BigInt((await (await near.account(house)).state()).amount) / 10n ** 21n) / 1000;
  console.log(`house holds ${have.toFixed(2)} NEAR`);
  if (have >= MIN_NEAR) return;
  for (let i = 0; i < N; i++) {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `clonestop${crypto.randomBytes(5).toString("hex")}.testnet`;
    const r = await fetch(HELPER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
    });
    if (!r.ok) {
      console.log(`faucet said ${r.status}; stopping`);
      break;
    }
    await keyStore.setKey("testnet", id, kp);
    await new Promise((res) => setTimeout(res, 3000));
    const acc = await near.account(id);
    const amount = BigInt((await acc.state()).amount) - BigInt(utils.format.parseNearAmount("0.05"));
    await acc.sendMoney(house, amount);
    console.log(`${id} sent ${utils.format.formatNearAmount(amount.toString(), 2)} NEAR to ${house}`);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 0; // a dry faucet never stops the night
});
