// Replay the hosted town's last finished night from chain state alone, with the same audit the
// bell runs at dawn, and fail if the chain and the rules disagree. Read-only: public RPC views, no
// keys. CI runs it every six hours (.github/workflows/verify.yml).
//
//     MARKET_ACCOUNT=shroud.clonestown.testnet node scripts/verify-night.js

const { audit, playedFrom } = require("../lib/night.js");

const MARKET = process.env.MARKET_ACCOUNT || "shroud.clonestown.testnet";
const RPCS = (process.env.NEAR_RPCS || "https://rpc.testnet.fastnear.com,https://test.rpc.fastnear.com").split(",");

async function view(methodName, args = {}) {
  let last;
  for (let i = 0; i < 8; i++) {
    const url = RPCS[i % RPCS.length];
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "verify",
          method: "query",
          params: {
            request_type: "call_function",
            finality: "final",
            account_id: MARKET,
            method_name: methodName,
            args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
          },
        }),
      });
      const j = await r.json();
      if (j.result && j.result.result) return JSON.parse(Buffer.from(j.result.result).toString());
      last = JSON.stringify(j.error || j.result);
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
  }
  throw new Error(`${methodName}: ${last}`);
}

async function main() {
  const [town, raw] = await view("get_state");
  const clones = raw.map(([id, v]) => ({ id, ...v }));
  console.log(`market ${MARKET}: night ${town.night}, ${town.asleep ? "asleep" : `hour ${town.round + 1}`}, fee ${town.fee_bps} bps`);
  if (!town.asleep) {
    console.log("A night is under way; the last finished night's dusk state has been replaced. Nothing to audit now.");
    return;
  }
  if (!town.night) {
    console.log("No night has been played yet.");
    return;
  }
  const orders = [];
  for (let at = town.dusk_order; ; at += 100) {
    const page = await view("get_orders", { from: at, limit: 100 });
    orders.push(...page);
    if (page.length < 100) break;
  }
  const settlements = await view("get_recent");
  const played = playedFrom(clones, settlements, town.night);
  const a = audit(town, played, orders);
  console.log(`night ${town.night}: ${played.length} clones, ${a.orders} orders replayed, crown ${a.crown ? a.crown.clone : "none"}`);
  if (a.problems.length) {
    console.error(`AUDIT FAILED (${a.problems.length}):\n  ${a.problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log("Audit passed: every order, price, fee, crown and payout is what the rules say.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
