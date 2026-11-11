// Ring the town bell until tonight's night is over and every clone that is due is home, then
// write one night log per guest (and an index) to OUT_DIR. The nightly job runs this; it is the
// same code the page's "Ring the bell" button runs, one step at a time.
//
//     HOUSE_ACCOUNT=clonestown.testnet HOUSE_KEY=ed25519:... OUT_DIR=nights node scripts/ring.js

const fs = require("fs");
const path = require("path");
const { openTown, ring } = require("../lib/night.js");
const rules = require("../lib/rules.js");

function logsFrom(t, steps) {
  const events = steps.flatMap((s) => s.events);
  const dawn = steps.find((s) => s.phase === "dawn");
  if (!dawn) return [];
  const players = [...new Set(dawn.verdict.map((v) => v.player))];
  return players.map((player) => {
    const mine = dawn.verdict.filter((v) => v.player === player);
    const outcome = (v, o) => ({
      name: v.clone,
      temperament: v.temperament,
      stake: v.stake,
      final_cash: o.final_cash,
      broke: o.broke,
      orders: o.orders,
      home: o.home,
    });
    return {
      seed: dawn.seed,
      night: dawn.night,
      network: "testnet",
      market: t.market,
      player,
      rounds: rules.ROUNDS,
      goods: rules.GOODS,
      answer_key: mine.map((v) => outcome(v, v.expected)),
      outcomes: mine.map((v) => outcome(v, v.chain)),
      events: events
        .filter((e) => !e.player || e.player === player)
        .map(({ player: _p, ...e }) => e),
    };
  });
}

async function main() {
  const t = await openTown();
  const steps = [];
  let opened = false;
  for (let i = 0; i < 40; i++) {
    const out = await ring(t, { start: !opened });
    steps.push(out);
    console.log(
      `${out.phase.padEnd(7)} night ${out.night} hour ${out.round}: ${out.events.length} events` +
        (out.phase === "dawn" ? `, answer key matched: ${out.matched}` : ""),
    );
    if (out.phase === "dusk" || out.phase === "hour" || out.phase === "dawn") opened = true;
    if (out.phase === "empty" || out.phase === "waiting" || (out.phase === "home" && !out.next)) break;
  }
  const logs = logsFrom(t, steps);
  const out = process.env.OUT_DIR;
  if (out && logs.length) {
    fs.mkdirSync(out, { recursive: true });
    for (const log of logs) fs.writeFileSync(path.join(out, `${log.player}.json`), JSON.stringify(log, null, 1));
    fs.writeFileSync(
      path.join(out, "index.json"),
      JSON.stringify({ ran_at: Math.floor(Date.now() / 1000), guests: logs.map((l) => ({ player: l.player, matched: l.outcomes.every((o, i) => JSON.stringify(o) === JSON.stringify(l.answer_key[i])) })) }, null, 1),
    );
  }
  const dawn = steps.find((s) => s.phase === "dawn");
  if (dawn && !dawn.matched) {
    console.error("the chain disagreed with the answer key:", JSON.stringify(dawn.verdict.filter((v) => !v.matched)));
    process.exitCode = 1;
  }
  return { steps, logs };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, logsFrom };
