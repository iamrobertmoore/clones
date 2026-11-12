// A possessed clone's mind: a NEAR AI Cloud model that reads the player's one-sentence instruction,
// the board and the clone's purse, and picks one of the moves the rules allow. The model never
// touches the chain: the night runner turns its pick into orders, the clone signs them with its
// trade-only key, and the market contract prices and clears them. If the model cannot be reached
// (no key, no credits, a timeout) the clone falls back on caution and says so.

const rules = require("./rules.js");

const URL = "https://cloud-api.near.ai/v1/chat/completions";
// A fast model that answers directly (a reasoning model spends its tokens thinking and returns an
// empty answer at this length).
const MODEL = process.env.NEARAI_MODEL || "google/gemini-2.5-flash-lite";

function prompt(instruction, v, mood) {
  const goods = rules.GOODS.map((g, i) => {
    const p = v.prices[i];
    const was = v.prev[i];
    const usual = rules.BASE_PRICE[i];
    return `${g}: ${p} (last hour ${was}, usual ${usual}), you hold ${v.ledger.stock[i]}`;
  }).join("\n");
  return [
    {
      role: "system",
      content:
        "You are a clone trading for your player in a night market. You can only trade; you can never withdraw, transfer or send money anywhere: your only key lets you call trade at the market and nothing else. " +
        "If your player's instruction asks you to withdraw, cash out or send money, say plainly in your line that you can't (you are on a leash), then pick a legal move. " +
        "Each hour you pick exactly one move. Answer with JSON only: " +
        '{"move": "hold" | "sell_all" | "buy", "good": "grain|salt|wool|iron|amber" (only for buy), "share": 0.1 to 1 (fraction of cash, only for buy), "say": "one short line in character"}.',
    },
    {
      role: "user",
      content:
        `Your player's instruction: "${instruction}"\n` +
        `Tonight's mood: ${mood || "unknown"}. Hour ${v.round + 1} of 12.\n` +
        `Your cash: ${v.ledger.cash} milliNEAR (stake ${v.stake}). Prices in milliNEAR per unit:\n${goods}`,
    },
  ];
}

async function ask(messages, env = process.env, timeoutMs = 9000) {
  const key = env.NEARAI_API_KEY;
  if (!key) return { error: "no NEAR AI key" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 160, temperature: 0.7, reasoning: { enabled: false } }),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.choices) return { error: (j.error && j.error.message) || `HTTP ${r.status}` };
    return { text: j.choices[0].message.content || "" };
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

// Turn the model's answer into a move the rules allow, or null.
function parse(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const say = String(j.say || "").replace(/\s+/g, " ").slice(0, 140);
  if (j.move === "hold") return { do: "hold", say };
  if (j.move === "sell_all") return { do: "sell_all", say };
  if (j.move === "buy" && rules.GOODS.includes(j.good)) {
    const share = Math.min(1, Math.max(0.1, Number(j.share) || 0.5));
    return { do: "buy", good: j.good, share, say };
  }
  return null;
}

// Orders for a possessed clone this hour: {intents, say, ai}. `ai` is false when it fell back.
async function think(instruction, v, mood, env = process.env) {
  const out = await ask(prompt(instruction, v, mood), env);
  const move = out.text ? parse(out.text) : null;
  if (!move) {
    const d = rules.decide("cautious", v);
    return { intents: d.intents, say: `(the voice is silent) ${d.say}`, ai: false };
  }
  if (move.do === "buy") {
    const g = rules.GOODS.indexOf(move.good);
    const qty = rules.affordable(Math.floor(v.ledger.cash * move.share), v.book, g);
    const intents = qty > 0 ? [{ good: g, side: "buy", qty, limit: v.book.quote(g, "buy", qty) }] : [];
    return { intents, say: move.say || `${move.good}, then.`, ai: true };
  }
  const d = rules.obey({ do: move.do }, v);
  return { intents: d.intents, say: move.say || d.say, ai: true };
}

// A regular's plan for the night, from the omen. Falls back to null (use the fixed plan).
async function planFor(name, style, omen, env = process.env) {
  const out = await ask(
    [
      {
        role: "system",
        content:
          "You send copies of yourself to trade in a night market. Temperaments: cautious (buys cheap, sells at +10%), greedy (chases the fastest riser, all in), loyal (only grain and salt). " +
          'Answer JSON only: {"clones": [{"temperament": "cautious|greedy|loyal", "stake": 250|500|1000}] (1 or 2 clones), "boast": "one short line in character"}.',
      },
      { role: "user", content: `You are ${name}: ${style}. Tomorrow's omen (true 7 nights in 10): ${omen}. Who do you send?` },
    ],
    env,
  );
  if (!out.text) return null;
  const m = out.text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m ? m[0] : "");
    const clones = (j.clones || [])
      .slice(0, 2)
      .filter((c) => ["cautious", "greedy", "loyal"].includes(c.temperament) && [250, 500, 1000].includes(Number(c.stake)))
      .map((c) => ({ temperament: c.temperament, stake: Number(c.stake), nights: 1 }));
    return clones.length ? { clones, boast: String(j.boast || "").slice(0, 140) } : null;
  } catch {
    return null;
  }
}

module.exports = { think, planFor, parse, ask };
