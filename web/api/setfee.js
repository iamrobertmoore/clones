// The holder of the merchant's deed sets the fee on every trade for the next night: 50 to 300
// basis points (0.5% to 3%). A quarter of the fees is theirs at dawn, but a dear market costs their
// own clones too.
//
// POST /api/setfee {"guest", "token", "bps"}

const { openTown, patient, message } = require("../lib/night.js");
const { authorise } = require("../lib/player.js");
const rules = require("../lib/rules.js");

module.exports = async function handler(req, res) {
  try {
    const who = authorise(req, res, process.env.HOUSE_ACCOUNT);
    if (!who) return;
    const bps = Number(who.body.bps);
    if (!Number.isInteger(bps) || bps < rules.MIN_FEE_BPS || bps > rules.MAX_FEE_BPS) {
      res.status(400).json({ error: `bps: a whole number from ${rules.MIN_FEE_BPS} to ${rules.MAX_FEE_BPS}` });
      return;
    }
    const t = await openTown();
    const guest = await t.as(who.guest);
    const out = await patient(() =>
      guest.functionCall({ contractId: t.market, methodName: "set_fee", args: { bps }, gas: 30_000_000_000_000n }),
    );
    res.status(200).json({ bps, tx: out.transaction.hash });
  } catch (e) {
    const m = message(e);
    const known = m.match(/only the holder of the merchant's deed[^"]*|set the fee between nights|the fee is 50 to 300 basis points/);
    res.status(known ? 409 : 500).json({ error: known ? known[0] : "Could not reach the chain. Try again." });
  }
};
