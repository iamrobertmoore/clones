// Whisper to one of your clones during a night: one order for its next hour, once a night.
//
// POST /api/whisper {"guest", "token", "clone", "whisper": {"do": "hold" | "sell_all" | "buy", "good"?}}
//
// The whisper is stored on chain by the market contract (`whisper`), which allows one per clone
// per night; the night runner obeys it instead of the clone's temperament for that hour, and the
// dawn audit checks it did.

const { openTown, patient, message } = require("../lib/night.js");
const { authorise } = require("../lib/player.js");
const rules = require("../lib/rules.js");

module.exports = async function handler(req, res) {
  try {
    const house = process.env.HOUSE_ACCOUNT;
    const who = authorise(req, res, house);
    if (!who) return;
    const w = who.body.whisper || {};
    let whisper;
    if (w.do === "hold") whisper = "Hold";
    else if (w.do === "sell_all") whisper = "SellAll";
    else if (w.do === "buy" && rules.GOODS.includes(w.good)) whisper = { Buy: { good: w.good } };
    else {
      res.status(400).json({ error: "whisper: hold, sell_all, or buy with a good" });
      return;
    }
    const t = await openTown();
    const guest = await t.as(who.guest);
    const out = await patient(() =>
      guest.functionCall({
        contractId: t.market,
        methodName: "whisper",
        args: { clone_id: who.clone, whisper: toJson(whisper) },
        gas: 30_000_000_000_000n,
      }),
    );
    res.status(200).json({ clone: who.clone, tx: out.transaction.hash });
  } catch (e) {
    const m = message(e);
    const known = m.match(/already whispered[^"]*|too late tonight[^"]*|whisper while the night is on|starts trading next night|no such clone in town/);
    res.status(known ? 409 : 500).json({ error: known ? known[0] : "Could not reach the chain. Try again." });
  }
};

// The contract's Whisper is tagged by "do" in snake_case.
function toJson(w) {
  if (w === "Hold") return { do: "hold" };
  if (w === "SellAll") return { do: "sell_all" };
  return { do: "buy", good: w.Buy.good };
}
