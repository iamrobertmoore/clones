// Claim your guest account: add a full-access key that only you hold.
//
// POST /api/claim  {"guest": "g1a2b3c.clonestown.testnet", "claim": "<token from sign-up>", "publicKey": "ed25519:..."}
//
// Your browser makes the key pair and keeps the private key; only the public key comes here. The
// claim token proves this browser made the sign-up. From then on the guest account is yours too:
// the house key stays on it so the town can still run your clones, but your winnings are no
// longer swept back to the house, and you can remove the house key whenever you like.

const { transactions, utils } = require("near-api-js");
const { openTown, patient, message } = require("../lib/night.js");
const { claimToken } = require("./enlist.js");

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
  const guest = String((body && body.guest) || "");
  const token = String((body && body.claim) || "");
  let pk;
  try {
    pk = utils.PublicKey.fromString(String((body && body.publicKey) || ""));
  } catch {
    res.status(400).json({ error: "publicKey must be an ed25519 public key" });
    return;
  }
  try {
    const t = await openTown();
    if (!guest.endsWith(`.${t.house}`) || token !== claimToken(guest)) {
      res.status(403).json({ error: "Only the browser that sent these clones in can claim this account." });
      return;
    }
    const account = await t.as(guest);
    const out = await patient(() =>
      account.signAndSendTransaction({
        receiverId: guest,
        actions: [transactions.addKey(pk, transactions.fullAccessKey())],
      }),
    );
    res.status(200).json({ guest, publicKey: pk.toString(), tx: out.transaction.hash });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not add your key. Try again in a moment.", detail: message(e).slice(0, 200) });
  }
};


