// What each of a guest's clones plans to do in the coming hour, worked out with the same rules the
// night runner uses. Read-only: nothing is signed or sent.
//
// POST /api/peek {"guest": "g1a2b3c.clonestown.testnet"} -> {"round": 4, "plans": [{"clone", "say", "orders"}]}

const { openTown, readState, message } = require("../lib/night.js");
const rules = require("../lib/rules.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      b = {};
    }
  }
  const guest = String((b && b.guest) || "");
  try {
    const t = await openTown();
    const { town, clones } = await readState(t);
    if (town.asleep) {
      res.status(200).json({ round: town.round, plans: [] });
      return;
    }
    const book = new rules.Book(town.hours[town.round], town.hour_stock, town.fee_bps || rules.FEE_BPS);
    const plans = clones
      .filter((c) => c.player === guest && c.from_night <= town.night)
      .map((c) => {
        const short = c.id.split(".")[0];
        if (c.temperament === "possessed") return { clone: short, say: "The voice will decide.", orders: [] };
        const v = { round: town.round, book, prices: town.prices, prev: town.prev_prices, ledger: { cash: c.cash, stock: c.stock.slice() }, stake: c.stake };
        const d = rules.decide(c.temperament, v);
        return {
          clone: short,
          say: d.say,
          orders: d.intents.map((i) => `${i.side} ${i.qty} ${rules.GOODS[i.good]} at ${book.quote(i.good, i.side, i.qty)}`),
        };
      });
    res.status(200).json({ round: town.round, plans });
  } catch (e) {
    res.status(500).json({ error: "Could not read the town.", detail: message(e).slice(0, 200) });
  }
};
