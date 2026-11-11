// Ring the town bell: play the next step of the night (an hour, dawn, or the clones coming home).
//
// POST /api/bell  {"start": true}   ->  {"phase": "dusk" | "hour" | "dawn" | "home" | "waiting" | "empty", ...}
//
// The page calls this once per step and animates what comes back, so a whole night plays out in
// about a minute while you watch. Anyone may ring it; the market contract refuses anything done
// twice. A nightly job (scripts/ring.js) rings it too, for guests who sent clones in and left.

const { openTown, ring, message } = require("../lib/night.js");

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
  try {
    const t = await openTown();
    const out = await ring(t, { start: Boolean(body && body.start) });
    res.status(200).json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "The bell jammed. Ring it again in a moment.", detail: message(e).slice(0, 200) });
  }
};
