// Between nights: change the temperament of one of your clones for the nights it has left.
//
// POST /api/retrain {"guest", "token", "clone", "temperament": "cautious" | "greedy" | "loyal"}

const { openTown, patient, message } = require("../lib/night.js");
const { authorise } = require("../lib/player.js");

module.exports = async function handler(req, res) {
  try {
    const who = authorise(req, res, process.env.HOUSE_ACCOUNT);
    if (!who) return;
    const temperament = String(who.body.temperament || "");
    if (!["cautious", "greedy", "loyal"].includes(temperament)) {
      res.status(400).json({ error: "temperament: cautious, greedy or loyal" });
      return;
    }
    const t = await openTown();
    const guest = await t.as(who.guest);
    const out = await patient(() =>
      guest.functionCall({ contractId: t.market, methodName: "retrain", args: { clone_id: who.clone, temperament }, gas: 30_000_000_000_000n }),
    );
    res.status(200).json({ clone: who.clone, temperament, tx: out.transaction.hash });
  } catch (e) {
    const m = message(e);
    const known = m.match(/retrain between nights[^"]*|no such clone in town/);
    res.status(known ? 409 : 500).json({ error: known ? known[0] : "Could not reach the chain. Try again." });
  }
};
