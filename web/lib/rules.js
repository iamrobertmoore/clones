// The rules of the town, in JavaScript, for the hosted town's night runner.
//
// This is a line-for-line copy of core/src/lib.rs (the rules the market contract runs on chain).
// The clones decide with these functions; the contract still clears every order with the Rust
// rules, and rules.test.js checks this copy against golden nights the Rust rules wrote
// (web/lib/golden.json), so the two can never drift apart unnoticed.
//
// All amounts are integer milliNEAR; every number here stays far below 2^53. Rust's integer
// division truncates toward zero, hence Math.trunc.

const GOODS = ["grain", "salt", "wool", "iron", "amber"];
const BASE_PRICE = [20, 30, 50, 80, 120];
const NORMAL_STOCK = [1200, 900, 600, 360, 240];
const FEE_BPS = 200;
// The range the deed holder may set the next night's fee in.
const MIN_FEE_BPS = 50;
const MAX_FEE_BPS = 300;
const ROUNDS = 12;
const BROKE_DIVISOR = 4;
const MAX_NIGHTS = 3;
const REGIMES = ["blight", "boom", "slump", "wild"];
// Mirrors the constants in core/src/lib.rs.
const C = {
  BLIGHT_AMP: 8, BLIGHT_STAPLE_PUSH: 2, BLIGHT_PULL: 40, BLIGHT_ROT: 5,
  BOOM_AMP: 14, BOOM_PUSH: 6, BOOM_PULL: 0,
  SLUMP_AMP: 12, SLUMP_DOWN: 5, SLUMP_UP: 12, SLUMP_TURN: 6, SLUMP_PULL: 0,
  WILD_AMP: 20, WILD_PULL: 25,
  GREEDY_SWITCH: 12,
};

const div = (a, b) => Math.trunc(a / b);

// splitmix64, as in the Rust rules.
const M64 = (1n << 64n) - 1n;
function mix(z) {
  z = (BigInt(z) + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return z ^ (z >> 31n);
}

function regimeOf(x) {
  return REGIMES[Number(mix(BigInt(x) ^ 0x6f6d656en) % 4n)];
}

function shape(regime, round, good) {
  switch (regime) {
    case "blight":
      return good < 2 ? [C.BLIGHT_AMP, C.BLIGHT_STAPLE_PUSH, C.BLIGHT_PULL] : [C.BLIGHT_AMP, -C.BLIGHT_ROT, 0];
    case "boom":
      return [C.BOOM_AMP, C.BOOM_PUSH, C.BOOM_PULL];
    case "slump":
      return [C.SLUMP_AMP, round <= C.SLUMP_TURN ? -C.SLUMP_DOWN : C.SLUMP_UP, C.SLUMP_PULL];
    default:
      return [C.WILD_AMP, 0, C.WILD_PULL];
  }
}

// One hour's move for one good from a random draw h (a BigInt).
function stepWith(h, regime, round, good, prev) {
  const [amp, push, pull] = shape(regime, round, good);
  let pct = Number(BigInt(h) % BigInt(2 * amp + 1)) - amp;
  if (good === 4) pct *= 2;
  pct += push;
  const base = BASE_PRICE[good];
  pct += div((base - prev) * pull, base);
  const next = div(prev * (100 + pct), 100);
  return Math.max(next, 1);
}

const seededDraw = (seed, round, good) => mix(BigInt(seed) ^ (BigInt(round) << 8n) ^ BigInt(good));

function pricesAt(seed, round) {
  const regime = regimeOf(seed);
  const p = BASE_PRICE.slice();
  for (let r = 1; r <= round; r++) {
    for (let g = 0; g < 5; g++) p[g] = stepWith(seededDraw(seed, r, g), regime, r, g, p[g]);
  }
  return p;
}

function stockedPrice(usual, normal, held) {
  const h = Math.min(Math.max(held, div(normal, 4)), normal * 4);
  return Math.max(Math.floor((usual * normal) / h), 1);
}

function restock(stock) {
  return stock.map((s, g) => s + div(NORMAL_STOCK[g] - s, 2));
}

function moveStock(stock, good, side, qty) {
  stock[good] += side === "buy" ? -qty : qty;
}

class Book {
  constructor(usual, stock, feeBps = FEE_BPS) {
    this.usual = usual;
    this.stock = stock.slice();
    this.feeBps = feeBps;
  }
  static at(seed, round, stock, feeBps = FEE_BPS) {
    return new Book(pricesAt(seed, round), stock, feeBps);
  }
  fee(notional) {
    return fee(notional, this.feeBps);
  }
  board() {
    return this.usual.map((u, g) => stockedPrice(u, NORMAL_STOCK[g], this.stock[g]));
  }
  quote(good, side, qty) {
    const after = this.stock[good] + (side === "buy" ? -qty : qty);
    return stockedPrice(this.usual[good], NORMAL_STOCK[good], after);
  }
}

function fee(notional, feeBps = FEE_BPS) {
  return Math.max(Math.floor((notional * feeBps + 9999) / 10000), 1);
}

function fill(l, good, side, qty, limit, price, feeBps = FEE_BPS) {
  if (good < 0 || good >= GOODS.length) throw new Error("unknown good");
  if (qty === 0) throw new Error("quantity must be positive");
  const notional = price * qty;
  if (side === "buy") {
    if (limit < price) throw new Error("limit is below the merchant's price");
    const f = fee(notional, feeBps);
    if (notional + f > l.cash) throw new Error("not enough cash for that order");
    l.cash -= notional + f;
    l.stock[good] += qty;
    return { price, fee: f };
  }
  if (limit > price) throw new Error("limit is above the merchant's price");
  if (l.stock[good] < qty) throw new Error("not enough stock to sell");
  const f = Math.min(fee(notional, feeBps), notional);
  l.stock[good] -= qty;
  l.cash += notional - f;
  return { price, fee: f };
}

const copyLedger = (l) => ({ cash: l.cash, stock: l.stock.slice() });

function liquidate(l, book) {
  let fees = 0;
  for (let g = 0; g < 5; g++) {
    const q = l.stock[g];
    if (q > 0) {
      const price = book.quote(g, "sell", q);
      fees += fill(l, g, "sell", q, price, price, book.feeBps).fee;
    }
  }
  return fees;
}

function worth(l, book) {
  const c = copyLedger(l);
  liquidate(c, book);
  return c.cash;
}

const isBroke = (w, stake) => w < Math.floor(stake / BROKE_DIVISOR);

function affordable(budget, book, good) {
  const cost = (q) => {
    const n = book.quote(good, "buy", q) * q;
    return n + book.fee(n);
  };
  let q = Math.floor(budget / book.quote(good, "buy", 1));
  while (q > 0 && cost(q) > budget) q -= 1;
  return q;
}

const changePct = (v, g) => div((v.prices[g] - v.prev[g]) * 100, v.prev[g]);

const sellAll = (v, g) => {
  const qty = v.ledger.stock[g];
  return { good: g, side: "sell", qty, limit: v.book.quote(g, "sell", qty) };
};
const buy = (v, g, qty) => ({ good: g, side: "buy", qty, limit: v.book.quote(g, "buy", qty) });
const proceeds = (i, book) => {
  const n = i.limit * i.qty;
  return n - Math.min(book.fee(n), n);
};

function greedy(v) {
  let best = 0;
  for (let g = 1; g < 5; g++) {
    // max by (change, index): a later good wins a tie.
    if (changePct(v, g) >= changePct(v, best)) best = g;
  }
  let holding = -1;
  for (let g = 0; g < 5; g++) if (v.ledger.stock[g] > 0) { holding = g; break; }
  if (holding >= 0 && holding !== best && changePct(v, best) - changePct(v, holding) < C.GREEDY_SWITCH) {
    return { intents: [], say: `${GOODS[holding]} will do. Holding.` };
  }
  const intents = [];
  for (let g = 0; g < 5; g++) if (g !== best && v.ledger.stock[g] > 0) intents.push(sellAll(v, g));
  const cash = v.ledger.cash + intents.reduce((s, i) => s + proceeds(i, v.book), 0);
  const qty = affordable(cash, v.book, best);
  const up = changePct(v, best);
  let say;
  if (qty > 0) {
    intents.push(buy(v, best, qty));
    say = up > 0 ? `${GOODS[best]} is up ${up}%. Everything in.` : `Nothing's rising, so ${GOODS[best]} it is. All of it.`;
  } else if (v.ledger.stock[best] > 0) {
    say = `All in on ${GOODS[best]} already. Hold.`;
  } else {
    say = "Out of cash. Need a way out of this town.";
  }
  return { intents, say };
}

function cautious(v) {
  const intents = [];
  const said = [];
  for (let g = 0; g < 5; g++) {
    if (v.ledger.stock[g] > 0 && v.prices[g] * 10 >= BASE_PRICE[g] * 11) {
      intents.push(sellAll(v, g));
      said.push(`${GOODS[g]} is 10% over usual, taking profit`);
    }
  }
  let cheapest = 0;
  const ratio = (g) => Math.floor((v.prices[g] * 1000) / BASE_PRICE[g]);
  for (let g = 1; g < 5; g++) if (ratio(g) < ratio(cheapest)) cheapest = g;
  if (v.prices[cheapest] * 10 <= BASE_PRICE[cheapest] * 9 && v.ledger.stock[cheapest] === 0) {
    const qty = affordable(Math.floor(v.ledger.cash / 4), v.book, cheapest);
    if (qty > 0) {
      intents.push(buy(v, cheapest, qty));
      said.push(`${GOODS[cheapest]} is cheap, buying a little`);
    }
  }
  return { intents, say: said.length ? said.join("; ") + "." : "Nothing worth the risk this hour." };
}

function loyal(v) {
  const intents = [];
  const said = [];
  for (let g = 0; g < 2; g++) {
    if (v.ledger.stock[g] > 0 && v.prices[g] > BASE_PRICE[g]) {
      intents.push(sellAll(v, g));
      said.push(`selling ${GOODS[g]} above its usual price`);
    } else if (v.ledger.stock[g] === 0 && v.prices[g] < BASE_PRICE[g]) {
      const qty = affordable(Math.floor(Math.floor(v.ledger.cash / 3) / 2), v.book, g);
      if (qty > 0) {
        intents.push(buy(v, g, qty));
        said.push(`${GOODS[g]} is below usual, a small buy`);
      }
    }
  }
  return { intents, say: said.length ? said.join("; ") + "." : "Keeping your money safe. Staples only." };
}

function decide(temperament, v) {
  // possessed clones are driven by a model (lib/mind.js); in simulations they trade as cautious.
  const d = { greedy, cautious, loyal, possessed: cautious }[temperament](v);
  d.say = d.say.charAt(0).toUpperCase() + d.say.slice(1);
  return d;
}

// One clone's turn, all or nothing. Mutates ledger and stock only if every order fills.
function applyTurn(ledger, stock, book, intents) {
  const l = copyLedger(ledger);
  const s = stock.slice();
  const fills = [];
  for (const i of intents) {
    const price = book.quote(i.good, i.side, i.qty);
    fills.push(fill(l, i.good, i.side, i.qty, i.limit, price, book.feeBps));
    moveStock(s, i.good, i.side, i.qty);
  }
  ledger.cash = l.cash;
  ledger.stock = l.stock;
  for (let g = 0; g < 5; g++) stock[g] = s[g];
  return fills;
}

// The crown: the night's pot goes to the clone with the biggest profit (worth less stake); ties to
// the lower account id. entries: [{name, worth, stake}]. Returns the winner's index or -1.
function crownWinner(entries) {
  let best = -1;
  entries.forEach((e, i) => {
    if (best < 0) return void (best = i);
    const p = e.worth - e.stake;
    const b = entries[best];
    const bp = b.worth - b.stake;
    if (p > bp || (p === bp && e.name < b.name)) best = i;
  });
  return best;
}

const startOf = (e) => (e.carried ? copyLedger(e.carried) : { cash: e.stake, stock: [0, 0, 0, 0, 0] });
const comesHome = (e, broke) => broke || (e.played || 0) + 1 >= (e.nights || 1);

function simulateTown(seed, dusk, entrants, feeBps = FEE_BPS) {
  let stock = dusk.slice();
  const ledgers = entrants.map(startOf);
  const orders = entrants.map(() => 0);
  const prices = [];
  const stocks = [];
  let prev = Book.at(seed, 0, stock).board();
  let pot = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const book = Book.at(seed, round, stock, feeBps);
    const board = book.board();
    prices.push(board);
    stocks.push(stock.slice());
    const moved = stock.slice();
    entrants.forEach((e, i) => {
      const d = decide(e.temperament, { round, book, prices: board, prev, ledger: ledgers[i], stake: e.stake });
      if (!d.intents.length) return;
      try {
        const fills = applyTurn(ledgers[i], moved, book, d.intents);
        orders[i] += d.intents.length;
        pot += fills.reduce((t, f) => t + f.fee, 0);
      } catch (_) {
        // a refused turn changes nothing, as on chain
      }
    });
    stock = moved;
    prev = board;
  }
  const dawn = Book.at(seed, ROUNDS, stock, feeBps);
  prices.push(dawn.board());
  stocks.push(stock.slice());
  const crowned = pot > 0 ? crownWinner(entrants.map((e, i) => ({ name: e.name, worth: worth(ledgers[i], dawn), stake: e.stake }))) : -1;
  if (crowned >= 0) ledgers[crowned].cash += pot;
  const held = ledgers.map(copyLedger);
  const outcomes = entrants.map((e, i) => {
    const w = worth(ledgers[i], dawn);
    const broke = isBroke(w, e.stake);
    const home = comesHome(e, broke);
    if (home) ledgers[i].stock.forEach((q, g) => moveStock(stock, g, "sell", q));
    return { name: e.name, temperament: e.temperament, stake: e.stake, final_cash: w, broke, orders: orders[i], home, crown: i === crowned ? pot : 0 };
  });
  return { outcomes, prices, stock: stocks, stock_end: stock, held };
}

// What a clone does with a whisper from its player instead of its temperament for one hour.
function obey(whisper, v) {
  const w = whisper || {};
  if (w.do === "sell_all") {
    const intents = [];
    for (let g = 0; g < 5; g++) if (v.ledger.stock[g] > 0) intents.push(sellAll(v, g));
    return { intents, say: intents.length ? "You said sell. Selling everything." : "You said sell, but I hold nothing." };
  }
  if (w.do === "buy") {
    const g = GOODS.indexOf(w.good);
    const qty = g < 0 ? 0 : affordable(Math.floor(v.ledger.cash / 2), v.book, g);
    return qty > 0
      ? { intents: [buy(v, g, qty)], say: `You said ${w.good}. Half my cash on it.` }
      : { intents: [], say: `You said ${w.good}, but I can't afford any.` };
  }
  return { intents: [], say: "You said hold. Holding." };
}

module.exports = {
  GOODS,
  BASE_PRICE,
  NORMAL_STOCK,
  ROUNDS,
  MAX_NIGHTS,
  mix,
  REGIMES,
  regimeOf,
  stepWith,
  seededDraw,
  pricesAt,
  stockedPrice,
  restock,
  FEE_BPS,
  MIN_FEE_BPS,
  MAX_FEE_BPS,
  Book,
  fee,
  fill,
  liquidate,
  worth,
  isBroke,
  affordable,
  decide,
  obey,
  applyTurn,
  crownWinner,
  simulateTown,
  comesHome,
};
