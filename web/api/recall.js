// Between nights: bring one of your clones home now, before its nights are up. It settles (the
// market sells what it holds and pays its account) and merges into your guest account with a real
// DeleteAccount.
//
// POST /api/recall {"guest", "token", "clone"}

const { openTown, readState, bringHome, message } = require("../lib/night.js");
const { authorise } = require("../lib/player.js");

module.exports = async function handler(req, res) {
  try {
    const who = authorise(req, res, process.env.HOUSE_ACCOUNT);
    if (!who) return;
    const t = await openTown();
    const { town, clones } = await readState(t);
    if (!town.asleep) {
      res.status(409).json({ error: "Clones come home between nights. Wait for dawn." });
      return;
    }
    const c = clones.find((x) => x.id === who.clone);
    if (!c) {
      res.status(404).json({ error: "That clone is not in town." });
      return;
    }
    const events = await bringHome(t, clones.map((x) => (x.id === c.id ? { ...x, due_home: true } : { ...x, due_home: false })));
    res.status(200).json({ clone: who.clone, events });
  } catch (e) {
    res.status(500).json({ error: "Could not bring it home. Try again.", detail: message(e).slice(0, 200) });
  }
};
