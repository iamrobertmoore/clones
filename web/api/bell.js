// Ring the town bell: play the next step of the night (an hour, dawn, or the clones coming home).
//
// POST /api/bell  {"start": true}   ->  {"phase": "dusk" | "hour" | "dawn" | "home" | "waiting" | "empty", ...}
//
// The page calls this once per step and animates what comes back, so a whole night plays out in
// about a minute while you watch. Anyone may ring it; the market contract refuses anything done
// twice.
//
// GET /api/bell?nightly=1 is the nightly bell: Vercel's scheduler calls it at 02:05 UTC
// (vercel.json "crons") and it plays the whole night in one call, then stops when every clone
// that is due is home; a second call the same night finds nothing to do. GitHub's scheduled job
// (scripts/ring.js) started 6 to 8 hours late every day in judging week, so it is now a backstop
// that also publishes the night logs.

const { openTown, ring, message } = require("../lib/night.js");

async function nightly(res) {
  const started = Date.now();
  const steps = [];
  try {
    const t = await openTown();
    let opened = false, out = null;
    for (let i = 0; i < 40 && Date.now() - started < 270e3; i++) {
      // A busy public RPC answers 429 now and then; wait and ring the same step again.
      for (let tries = 1; ; tries++) {
        try { out = await ring(t, { start: !opened }); break; } catch (e) {
          if (tries >= 5 || !/429|rate limit|Rate limits/i.test(message(e)) || Date.now() - started > 250e3) throw e;
          await new Promise((r) => setTimeout(r, 4000 * tries));
        }
      }
      steps.push(out.phase + (out.round != null ? ":" + out.round : ""));
      if (out.phase === "dusk" || out.phase === "hour" || out.phase === "dawn") opened = true;
      if (out.phase === "empty" || out.phase === "waiting" || (out.phase === "home" && !out.next)) break;
    }
    console.log("nightly", JSON.stringify(steps));
    res.status(200).json({ night: out && out.night, phase: out && out.phase, steps, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error("nightly", e);
    res.status(500).json({ error: message(e).slice(0, 300), steps });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === "GET" && req.query && req.query.nightly) return nightly(res);
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
