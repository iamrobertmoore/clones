// The holder of the merchant's deed names one good the merchant restocks in full at the next dusk.
//
// POST /api/restock {"guest", "token", "good"}

const { openTown, patient, message } = require("../lib/night.js");
const { authorise } = require("../lib/player.js");
const rules = require("../lib/rules.js");

module.exports = async function handler(req, res) {
  try {
    const who = authorise(req, res, process.env.HOUSE_ACCOUNT);
    if (!who) return;
    const good = String(who.body.good || "");
    if (!rules.GOODS.includes(good)) {
      res.status(400).json({ error: "good: grain, salt, wool, iron or amber" });
      return;
    }
    const t = await openTown();
    const guest = await t.as(who.guest);
    const out = await patient(() =>
      guest.functionCall({ contractId: t.market, methodName: "order_restock", args: { good }, gas: 30_000_000_000_000n }),
    );
    res.status(200).json({ good, tx: out.transaction.hash });
  } catch (e) {
    const m = message(e);
    const known = m.match(/only the holder of the merchant's deed[^"]*|order the restock between nights/);
    res.status(known ? 409 : 500).json({ error: known ? known[0] : "Could not reach the chain. Try again." });
  }
};
