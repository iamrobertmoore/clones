// Let a clone try to run off with the NEAR on its own account. The chain refuses: the clone's only
// key is a function-call key for the market's `trade`, and a transfer needs a full-access key.
//
// POST /api/escape  {"clone": "clone-2.g1a2b3c.clonestown.testnet"}  ->  {"refused": true, "refusal": "..."}
//
// This sends a real transaction signed with the clone's own key, so the refusal is the chain's,
// not ours. Testnet only, and only for clones of the house's guests.

const { openTown, readState, tryToRun, message } = require("../lib/night.js");

const CLONE = /^clone-[123]\.g[a-z0-9]{6}\.([a-z0-9_-]+\.)*testnet$/;

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
  const clone = body && String(body.clone || "");
  try {
    const t = await openTown();
    if (!CLONE.test(clone) || !clone.endsWith(`.${t.house}`)) {
      res.status(400).json({ error: "That is not one of the town's clones." });
      return;
    }
    const player = clone.slice(clone.indexOf(".") + 1);
    const { clones } = await readState(t);
    if (!clones.some((c) => c.id === clone)) {
      res.status(404).json({ error: "That clone is not in town (it may have merged home already)." });
      return;
    }
    const error = await tryToRun(t, clone, player);
    res.status(200).json({ refused: true, clone, refusal: error });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not reach the chain. Try again in a moment.", detail: message(e).slice(0, 200) });
  }
};
