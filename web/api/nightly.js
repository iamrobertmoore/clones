// The nightly bell, rung by Vercel's scheduler at 02:05 UTC (vercel.json "crons").
// GitHub's scheduled jobs started 6 to 8 hours late every day in judging week, so the 02:00 bell
// rang mid-morning; Vercel fires within the hour it is set for. It plays the whole night, step by
// step, exactly as the page's "Ring the bell" does, and stops when every clone that is due is home.
// A second call the same night finds nothing to do. The GitHub job (town.yml) stays as a backstop
// and publishes the night logs.
//
// GET /api/nightly  ->  {"steps": [...phases], "night", "phase"}

const { openTown, ring } = require("../lib/night.js");

module.exports = async function handler(req, res) {
  const started = Date.now();
  const phases = [];
  try {
    const t = await openTown();
    let opened = false, out = null;
    for (let i = 0; i < 40 && Date.now() - started < 270e3; i++) {
      out = await ring(t, { start: !opened });
      phases.push(out.phase + (out.round != null ? ":" + out.round : ""));
      if (out.phase === "dusk" || out.phase === "hour" || out.phase === "dawn") opened = true;
      if (out.phase === "empty" || out.phase === "waiting" || (out.phase === "home" && !out.next)) break;
    }
    console.log("nightly", JSON.stringify(phases));
    res.status(200).json({ night: out && out.night, phase: out && out.phase, steps: phases, seconds: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    console.error("nightly", e);
    res.status(500).json({ error: String(e && e.message || e).slice(0, 300), steps: phases });
  }
};
