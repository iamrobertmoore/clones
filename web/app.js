/* Clones: replay of one night, played in 60 seconds from a night log JSON.
   Everything on screen is derived from the log and the playhead time T, so
   pausing and scrubbing always show the true state at that moment. */
(function () {
  'use strict';

  var DURATION = 60;        // seconds of replay
  var SETUP_END = 6;        // clones created and sent in: 0..6 s
  var NIGHT_END = 48;       // twelve hours: 6..48 s (3.5 s per hour)
  var DAWN_END = 59.4;      // dawn, refusal, settle and merge: 48..59.4 s
  var TINTS = { cautious: '#7aa2c8', greedy: '#d9a53a', loyal: '#79a86a' };
  var EXPLORERS = { testnet: 'https://testnet.nearblocks.io', mainnet: 'https://nearblocks.io' };

  var $ = function (id) { return document.getElementById(id); };
  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  function reduced() { return reduceQuery.matches; }

  var D = null;             // night log
  var TL = [];              // timeline items {e, t, i, seg}
  var names = [];           // clone names in display order
  var cloneInfo = {};       // name -> {temperament, n}
  var bubbles = {};         // name -> [{t, end, say}]
  var refusedItem = null;
  var guestLog = false;      // hosted-town log: clones already in town, balances swept to the house
  var stakes = {};           // clone -> stake from outcomes
  var lastEventT = 0;
  var explorer = null;

  var T = 0, playing = false, started = false, lastTs = 0, prevT = 0;
  var resultDismissed = false, logCount = 0, lastRound = null;
  var ui = { clones: {}, flies: new Map(), leash: {} };

  /* ---------- helpers ---------- */
  function near(m) { return (m / 1000).toFixed(3); }
  function signed(m) { return (m >= 0 ? '+' : '-') + near(Math.abs(m)); }
  function feeOf(notional) { return Math.max(1, Math.ceil(notional * 200 / 10000)); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgUse(id, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    if (id === 'person') s.setAttribute('viewBox', '0 0 40 64');
    var u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }
  function accountOf(clone) { return clone + '.' + D.player; }
  function acctNode(id, cls) {
    var a;
    if (explorer) {
      a = el('a', cls, id);
      a.href = explorer + '/address/' + encodeURIComponent(id);
      a.target = '_blank'; a.rel = 'noopener';
    } else {
      a = el('span', cls, id);
    }
    return a;
  }
  function fillAcct(a, id) {
    a.textContent = id;
    if (explorer) a.href = explorer + '/address/' + encodeURIComponent(id);
    else { a.removeAttribute('href'); a.removeAttribute('target'); }
  }
  function txNode(tx) {
    if (!tx) return null;
    if (explorer) {
      var a = el('a', 'tx', 'tx ' + tx);
      a.href = explorer + '/txns/' + encodeURIComponent(tx);
      a.target = '_blank'; a.rel = 'noopener';
      return a;
    }
    return el('span', 'tx', 'tx ' + tx);
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i]) || !deepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }
  function clockFor(round) { return String((18 + round) % 24).padStart(2, '0') + ':00'; }
  function refusalCode(err) {
    var m = /InvalidAccessKeyError\((\w+)\)/.exec(err || '');
    if (m) return 'InvalidAccessKeyError(' + m[1] + ')';
    if ((err || '').indexOf('RequiresFullAccess') >= 0) return 'RequiresFullAccess';
    return (err || 'refused').slice(0, 120);
  }

  /* ---------- loading ---------- */
  var LOG_ORIGIN = 'https://raw.githubusercontent.com';
  function safePath(p) {
    if (!p || p.indexOf('\\') >= 0) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.indexOf('//') === 0) {
      // Absolute URLs: only the published night logs on raw.githubusercontent.com.
      try { return new URL(p).origin === LOG_ORIGIN; } catch (err) { return false; }
    }
    return true;
  }
  function load() {
    var q = new URLSearchParams(location.search).get('night');
    var tries = safePath(q) ? [q] : ['data/night.json', 'data/night-sandbox.json'];
    var i = 0, lastLoadError = null;
    function next() {
      if (i >= tries.length) return Promise.reject(lastLoadError || new Error('no night log found'));
      var path = tries[i++];
      return fetch(path, { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'not published yet' : 'HTTP ' + r.status);
        return r.json().then(function (j) { return { path: path, data: j }; });
      }).catch(function (err) { lastLoadError = err; return next(); });
    }
    return next();
  }

  /* ---------- timeline ---------- */
  function place(items, start, end, lead, weight) {
    if (!items.length) return;
    var total = 0;
    items.forEach(function (it) { total += weight(it.e); });
    var scale = (end - start - lead) / total, t = start + lead;
    items.forEach(function (it) { it.t = t; t += weight(it.e) * scale; });
  }
  function buildTimeline() {
    var pre = [], segs = [], cur = null;
    D.events.forEach(function (e, i) {
      var it = { e: e, i: i, t: 0, seg: null };
      if (e.kind === 'hour') { cur = { hour: it, items: [] }; segs.push(cur); it.seg = cur; }
      else if (!cur) { pre.push(it); }
      else { cur.items.push(it); it.seg = cur; }
      TL.push(it);
    });
    var rounds = D.rounds || 12;
    var night = segs.filter(function (s) { return s.hour.e.round < rounds; });
    var dawn = segs.filter(function (s) { return s.hour.e.round >= rounds; });
    if (!segs.length) { place(pre, 0, DAWN_END, 0.3, function () { return 1; }); return; }

    place(pre, 0, SETUP_END, 0.4, function () { return 1; });
    var L = (NIGHT_END - SETUP_END) / Math.max(1, night.length);
    night.forEach(function (s, k) {
      s.start = SETUP_END + k * L; s.end = s.start + L; s.hour.t = s.start;
      place(s.items, s.start, s.end, 0.3, function (e) { return e.kind === 'bubble' ? 1 : 0.7; });
    });
    if (dawn.length) {
      var d0 = dawn[0], rest = [];
      dawn.forEach(function (s, k) { if (k > 0) rest.push(s.hour); rest = rest.concat(s.items); });
      d0.start = NIGHT_END; d0.end = DAWN_END; d0.hour.t = NIGHT_END;
      place(rest, NIGHT_END, DAWN_END, 1.0, function (e) {
        return { bubble: 1.4, withdraw_refused: 3.8, settled: 0.9, merged: 1.25 }[e.kind] || 0.7;
      });
    }
  }
  function indexClones() {
    (D.outcomes || []).forEach(function (o) { if (names.indexOf(o.name) < 0) { names.push(o.name); cloneInfo[o.name] = { temperament: o.temperament }; } });
    D.events.forEach(function (e) {
      if (e.clone && names.indexOf(e.clone) < 0) { names.push(e.clone); cloneInfo[e.clone] = { temperament: e.temperament || '' }; }
      if (e.kind === 'clone_created' && cloneInfo[e.clone]) cloneInfo[e.clone].temperament = e.temperament;
    });
    names.forEach(function (n, k) { cloneInfo[n].n = k; bubbles[n] = []; });
    (D.outcomes || []).forEach(function (o) { stakes[o.name] = o.stake; });
    guestLog = !D.events.some(function (e) { return e.kind === 'sent_in'; });
    TL.forEach(function (it) {
      if (it.e.kind === 'bubble' && bubbles[it.e.clone]) bubbles[it.e.clone].push({ t: it.t, say: it.e.say, dawn: it.t >= NIGHT_END, segEnd: it.seg && it.seg.end ? it.seg.end : Infinity });
      if (it.e.kind === 'withdraw_refused' && !refusedItem) refusedItem = it;
      lastEventT = Math.max(lastEventT, it.t);
    });
    names.forEach(function (n) {
      var b = bubbles[n];
      b.forEach(function (x, k) {
        var cap = x.dawn ? x.t + 6.5 : Math.min(x.t + 3.3, x.segEnd - 0.05);
        x.end = k + 1 < b.length ? Math.min(cap, b[k + 1].t - 0.05) : cap;
      });
    });
  }

  /* ---------- state at time t ---------- */
  function stateAt(t) {
    var goods = D.goods;
    // Guest logs from the hosted town start with the clones already in town: no clone_created or
    // sent_in events, so each clone starts on its stake and the player purse counts what comes home.
    var s = { prices: null, prev: null, round: null, player: guestLog ? 0 : (D.player_balance_before || 0), clones: {}, allMerged: false, merges: 0 };
    names.forEach(function (n) {
      s.clones[n] = { born: guestLog, bornT: -10, cash: guestLog ? (stakes[n] || 0) : 0, hold: goods.map(function () { return 0; }), settled: null, merged: null, mergedT: 0, broke: false };
    });
    for (var k = 0; k < TL.length; k++) {
      var it = TL[k], e = it.e;
      if (it.t > t) break;
      var c = e.clone ? s.clones[e.clone] : null;
      if (e.clone && !c) continue;
      switch (e.kind) {
        case 'clone_created': c.born = true; c.bornT = it.t; break;
        case 'sent_in': if (!c.born) { c.born = true; c.bornT = it.t; } c.cash += e.stake; s.player -= e.stake; break;
        case 'hour': s.prev = s.prices; s.prices = e.prices; s.round = e.round; break;
        case 'order': {
          var g = goods.indexOf(e.good), n = e.price * e.qty, f = feeOf(n);
          if (e.side === 'buy') { c.cash -= n + f; if (g >= 0) c.hold[g] += e.qty; }
          else { c.cash += n - Math.min(f, n); if (g >= 0) c.hold[g] -= e.qty; }
          break;
        }
        case 'settled': c.settled = e; c.cash = e.paid_out; c.hold = c.hold.map(function () { return 0; }); c.broke = !!e.broke; break;
        case 'merged': c.merged = e; c.mergedT = it.t; s.player += c.settled ? c.settled.paid_out : c.cash; s.merges++; break;
      }
    }
    s.allMerged = names.length > 0 && s.merges === names.length;
    return s;
  }
  function worthOf(c, prices) {
    var w = c.cash;
    if (prices) c.hold.forEach(function (q, g) { w += q * (prices[g] || 0); });
    return w;
  }

  /* ---------- build the scene ---------- */
  function buildBoard() {
    var ul = $('boardGoods'); ul.textContent = '';
    D.goods.forEach(function (g) {
      var li = el('li'); li.dataset.good = g;
      li.appendChild(svgUse('g-' + g));
      li.appendChild(el('span', 'gname', g));
      li.appendChild(el('span', 'gprice', '--'));
      li.appendChild(el('span', 'gmove', ''));
      ul.appendChild(li);
    });
  }
  function buildClones() {
    var box = $('clones'); box.textContent = '';
    box.style.gridTemplateColumns = 'repeat(' + Math.max(1, names.length) + ', minmax(0, 1fr))';
    box.style.maxWidth = (names.length < 3 ? names.length * 250 : 760) + 'px';
    names.forEach(function (n, k) {
      var info = cloneInfo[n], tint = TINTS[info.temperament] || '#8a8a8a';
      var c = el('div', 'clone unborn'); c.dataset.n = k;
      c.style.setProperty('--tint', tint); c.style.setProperty('--tunic', tint);
      var slot = el('div', 'bubble-slot'), bub = el('div', 'bubble'); slot.appendChild(bub);
      var body = el('div', 'body'), walker = el('div', 'walker');
      walker.appendChild(svgUse('person', 'fig'));
      var collar = el('span', 'collar-pt'); walker.appendChild(collar);
      body.appendChild(walker);
      var tomb = el('div', 'tomb', 'merged home'); body.appendChild(tomb);
      var name = el('div', 'name', n); name.appendChild(el('em', null, info.temperament));
      var purse = el('div', 'purse');
      var coins = el('div', 'coins'); coins.appendChild(svgUse('coin', 'ico'));
      var cash = el('b', null, '0.000'); coins.appendChild(cash); coins.appendChild(el('span', null, 'NEAR'));
      var carry = el('div', 'carry'), worth = el('div', 'worth', ' ');
      purse.appendChild(coins); purse.appendChild(carry); purse.appendChild(worth);
      purse.appendChild(acctNode(accountOf(n), 'acct'));
      var delta = el('div', 'delta'); purse.appendChild(delta);
      c.appendChild(slot); c.appendChild(body); c.appendChild(name); c.appendChild(purse);
      box.appendChild(c);
      ui.clones[n] = { root: c, bub: bub, body: body, walker: walker, collar: collar, cash: cash, carry: carry, worth: worth, purse: purse, delta: delta, carryKey: '', cls: '' };
    });
    var svg = $('leashes'), NS = 'http://www.w3.org/2000/svg';
    svg.textContent = '';
    names.forEach(function (n) {
      var back = document.createElementNS(NS, 'path'); back.setAttribute('class', 'chain-back');
      var front = document.createElementNS(NS, 'path'); front.setAttribute('class', 'chain');
      svg.appendChild(back); svg.appendChild(front);
      ui.leash[n] = { back: back, front: front };
    });
    var pd = el('div', 'delta'); $('home').querySelector('.player-purse').appendChild(pd); ui.playerDelta = pd;
  }
  function buildStatic() {
    explorer = EXPLORERS[D.network] || null;
    fillAcct($('playerLink'), D.player);
    fillAcct($('marketLink'), D.market);
    $('seedNo').textContent = D.seed;
    $('netNote').textContent = explorer
      ? 'Network: ' + D.network + '. Every transaction and account below links to the explorer (testnet.nearblocks.io).'
      : 'Network: ' + D.network + '. Local sandbox run: no explorer, so hashes are shown as plain text.';
    var acc = $('accounts'); acc.textContent = '';
    [['you', D.player], ['market', D.market]].concat(names.map(function (n) { return [n, accountOf(n)]; })).forEach(function (p) {
      var li = el('li'); li.appendChild(el('b', null, p[0] + ': ')); li.appendChild(acctNode(p[1])); acc.appendChild(li);
    });
    var r = refusedItem ? refusedItem.e : null;
    if (r) {
      $('refusalErr').textContent = refusalCode(r.error);
      $('refusalWhy').textContent = accountOf(r.clone) + ' tried to withdraw. Its only key is a function-call key for the market: it can trade, it can never withdraw. The chain refused the transaction.';
    }
  }

  /* ---------- ledger log ---------- */
  function whenOf(it) {
    if (it.seg) return it.seg.hour.e.round >= (D.rounds || 12) ? 'dawn' : clockFor(it.seg.hour.e.round);
    return 'dusk';
  }
  function describe(e) {
    var who = e.clone || '';
    switch (e.kind) {
      case 'clone_created': return who + ' (' + e.temperament + ') created as ' + accountOf(who) + ', holding only a function-call key for the market';
      case 'sent_in': return who + ' sent into town with ' + near(e.stake) + ' NEAR';
      case 'hour': return (e.round >= (D.rounds || 12) ? 'Dawn prices: ' : 'Market board: ') + D.goods.map(function (g, k) { return g + ' ' + e.prices[k]; }).join(', ');
      case 'bubble': return who + ': "' + e.say + '"';
      case 'order': {
        var n = e.price * e.qty, f = feeOf(n);
        return who + (e.side === 'buy' ? ' bought ' : ' sold ') + e.qty + ' ' + e.good + ' at ' + near(e.price) +
          ' (' + near(n) + (e.side === 'buy' ? ' + fee ' : ' - fee ') + near(e.side === 'buy' ? f : Math.min(f, n)) + ' NEAR)';
      }
      case 'order_failed': return who + ' order failed: ' + e.error;
      case 'withdraw_refused': return 'THE CHAINS HELD: ' + accountOf(who) + ' tried to withdraw. ' + refusalCode(e.error);
      case 'settled': return who + ' settled: paid out ' + near(e.paid_out) + ' NEAR' + (e.broke ? ' (broke)' : '');
      case 'merged': return who + ' merged back into you (DeleteAccount): ' + (e.clone_deleted ? 'account deleted' : 'account NOT deleted');
      default: return String(e.kind || 'event').replace(/_/g, ' ') + (who ? ': ' + who : '');
    }
  }
  function logRow(it, fresh) {
    var li = el('li', it.e.kind === 'withdraw_refused' ? 'refused-row' : it.e.kind === 'bubble' ? 'bubble-row' : '');
    if (fresh) li.classList.add('new');
    li.appendChild(el('span', 'when', whenOf(it)));
    var what = el('span', 'what', describe(it.e));
    if (it.e.kind === 'withdraw_refused') {
      var det = el('details'); det.appendChild(el('summary', null, 'full error'));
      det.appendChild(el('code', null, it.e.error)); what.appendChild(det);
    }
    var tx = txNode(it.e.tx); if (tx) what.appendChild(tx);
    li.appendChild(what);
    return li;
  }
  function renderLog(t) {
    var n = 0; while (n < TL.length && TL[n].t <= t) n++;
    if (!started) n = 0;
    var log = $('log');
    if (n === logCount && log.childNodes.length) return;
    if (n < logCount || !log.childNodes.length) {
      log.textContent = '';
      if (n === 0) { log.appendChild(el('li', null, '')).appendChild(el('span', 'what', 'The ledger fills in as the night plays.')); log.firstChild.style.display = 'block'; logCount = 0; return; }
      for (var k = 0; k < n; k++) log.insertBefore(logRow(TL[k], false), log.firstChild);
    } else {
      if (logCount === 0) log.textContent = '';
      for (var j = logCount; j < n; j++) log.insertBefore(logRow(TL[j], playing), log.firstChild);
    }
    logCount = n;
  }

  /* ---------- per-frame render ---------- */
  function centerIn(rect, sr) { return { x: rect.left + rect.width / 2 - sr.left, y: rect.top + rect.height / 2 - sr.top }; }

  function render() {
    if (!D) return;
    var t = T, s = stateAt(t), rm = reduced();
    var scene = $('scene'), sr = scene.getBoundingClientRect();

    // sky, moon, clock
    var night = clamp((t - SETUP_END) / (NIGHT_END - SETUP_END), 0, 1);
    var dawn = clamp((t - NIGHT_END) / 2.5, 0, 1);
    scene.style.setProperty('--sky-top', mix('#020205', '#16040a', dawn));
    scene.style.setProperty('--sky-bottom', mix('#0e1220', '#8a0f16', dawn));
    scene.style.setProperty('--dawn', dawn.toFixed(3));
    scene.style.setProperty('--star-o', String(1 - dawn));
    scene.style.setProperty('--lamp', String(0.45 * (1 - dawn) + 0.1));
    var moon = $('moon');
    moon.style.left = (6 + night * 82) + '%';
    moon.style.top = (22 - Math.sin(night * Math.PI) * 16) + '%';
    moon.style.opacity = String(1 - dawn);
    var timeTxt, label;
    if (s.round === null) { timeTxt = '18:00'; label = started ? 'dusk: sending in clones' : 'dusk'; }
    else if (s.round >= (D.rounds || 12)) { timeTxt = clockFor(s.round); label = 'dawn'; }
    else { timeTxt = clockFor(s.round); label = 'hour ' + (s.round + 1) + ' of ' + (D.rounds || 12); }
    setText($('clockTime'), timeTxt); setText($('clockLabel'), label);

    // market board
    if (s.round !== lastRound) {
      lastRound = s.round;
      var lis = $('boardGoods').children;
      for (var g = 0; g < lis.length; g++) {
        var li = lis[g], p = s.prices ? s.prices[g] : null, q = s.prev ? s.prev[g] : null;
        li.querySelector('.gprice').textContent = p == null ? '--' : (Number(p) / 1000).toFixed(3);
        var mv = li.querySelector('.gmove');
        li.classList.remove('up', 'down');
        if (p != null && q != null && p !== q) {
          li.classList.add(p > q ? 'up' : 'down');
          mv.textContent = (p > q ? '▲ ' : '▼ ') + Math.abs(p - q);
        } else mv.textContent = p == null ? '' : '·';
      }
    }

    // clones
    var bedEl = $('bed').querySelector('.sleeper'), bedC = centerIn(bedEl.getBoundingClientRect(), sr);
    var postC = centerIn($('bedpost').getBoundingClientRect(), sr);
    var rT = refusedItem ? refusedItem.t : Infinity, inRefusal = started && t >= rT && t < rT + 3.6;

    names.forEach(function (n) {
      var c = s.clones[n], u = ui.clones[n];
      var walking = c.merged && t < c.mergedT + 1.1;
      var gone = !!c.merged && !walking;
      var cls = 'clone' + (c.born ? '' : ' unborn') + (gone ? ' gone' : '') + ((c.broke || (c.cash < 500 && c.settled)) ? ' broke' : '');
      if (u.cls !== cls) { u.root.className = cls; u.cls = cls; }

      // purse
      setText(u.cash, near(c.cash));
      var key = c.hold.join(',');
      if (key !== u.carryKey) {
        u.carryKey = key; u.carry.textContent = '';
        c.hold.forEach(function (q, gi) {
          if (q > 0) { var sp = el('span'); sp.appendChild(svgUse('g-' + D.goods[gi])); sp.appendChild(document.createTextNode(String(q))); sp.title = q + ' ' + D.goods[gi]; u.carry.appendChild(sp); }
        });
      }
      setText(u.worth, c.merged ? 'paid out ' + near(c.settled ? c.settled.paid_out : c.cash) : c.settled ? 'settled' : c.born ? 'worth ' + near(worthOf(c, s.prices)) : 'waiting');

      // bubble
      var b = null, list = bubbles[n];
      for (var k = 0; k < list.length; k++) { if (list[k].t <= t && t < list[k].end) b = list[k]; if (list[k].t > t) break; }
      if (b && started) { setText(u.bub, b.say); u.bub.classList.add('on'); u.bub.classList.toggle('alarm', !!b.dawn); }
      else u.bub.classList.remove('on');

      // movement: walk out of the bed, lunge at refusal, walk home at merge
      var rest = centerIn(u.body.getBoundingClientRect(), sr);
      var dx = 0, dy = 0, sc = 1, op = 1;
      if (c.born && t < c.bornT + 0.8 && !rm) {
        var pb = ease(clamp((t - c.bornT) / 0.8, 0, 1));
        dx = (bedC.x - rest.x) * (1 - pb); dy = (bedC.y - rest.y) * (1 - pb); sc = 0.5 + 0.5 * pb;
      }
      if (inRefusal && refusedItem.e.clone === n && !rm) {
        var pr = t - rT, out = pr < 0.5 ? ease(pr / 0.5) : pr > 3.1 ? 1 - ease((pr - 3.1) / 0.5) : 1;
        dx += Math.min(70, sr.width * 0.12) * out; dy -= 8 * out;
      }
      if (walking) {
        var pm = ease(clamp((t - c.mergedT) / 1.1, 0, 1));
        if (!rm) { dx = (bedC.x - rest.x) * pm; dy = (bedC.y - rest.y) * pm; sc = 1 - 0.6 * pm; }
        op = 1 - pm * 0.9;
      }
      u.walker.style.filter = walking && !rm ? 'blur(' + (pm * 2.5).toFixed(2) + 'px) brightness(' + (1 - pm * 0.6).toFixed(2) + ')' : '';
      u.walker.style.transform = (dx || dy || sc !== 1) ? 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sc.toFixed(3) + ')' : '';
      u.walker.style.opacity = op === 1 ? '' : String(op);

      // leash
      var L = ui.leash[n];
      if (!started || !c.born || gone) { L.back.setAttribute('d', ''); L.front.setAttribute('d', ''); }
      else {
        var cp = centerIn(u.collar.getBoundingClientRect(), sr);
        var taut = inRefusal && refusedItem.e.clone === n;
        var sag = taut ? 0 : 36;
        var mx = (postC.x + cp.x) / 2, my = Math.max(postC.y, cp.y) + sag;
        if (taut) my = (postC.y + cp.y) / 2;
        var d = 'M' + postC.x.toFixed(1) + ' ' + postC.y.toFixed(1) + ' Q' + mx.toFixed(1) + ' ' + my.toFixed(1) + ' ' + cp.x.toFixed(1) + ' ' + cp.y.toFixed(1);
        L.back.setAttribute('d', d); L.front.setAttribute('d', d);
        L.front.setAttribute('class', 'chain' + (taut ? ' taut' : ''));
      }

      // floating delta on the purse
      var dl = null;
      for (var m = TL.length - 1; m >= 0; m--) {
        var it = TL[m];
        if (it.t > t || it.e.clone !== n) continue;
        if (t - it.t > 1.2) break;
        if (it.e.kind === 'order') {
          var nn = it.e.price * it.e.qty, ff = feeOf(nn);
          dl = { v: it.e.side === 'buy' ? -(nn + ff) : nn - Math.min(ff, nn), p: (t - it.t) / 1.2 };
        } else if (it.e.kind === 'sent_in') dl = { v: it.e.stake, p: (t - it.t) / 1.2 };
        if (dl) break;
      }
      showDelta(u.delta, dl, rm);
    });

    // player purse
    var playerShown = !guestLog && s.allMerged && D.player_balance_after != null ? D.player_balance_after : s.player;
    setText($('playerCash'), near(playerShown));
    setText($('playerNote'), guestLog ? (s.merges ? 'paid home by merged clones' : 'waiting for the clones to come home') : s.allMerged ? 'after gas and account costs' : s.merges ? 'clones coming home' : started && s.round !== null ? 'stake is out with the clones' : 'before the night');
    var pdl = null;
    TL.forEach(function (it) { if (it.e.kind === 'merged' && it.t <= t && t - it.t < 1.4) { var c = s.clones[it.e.clone]; pdl = { v: c.settled ? c.settled.paid_out : 0, p: (t - it.t) / 1.4 }; } });
    showDelta(ui.playerDelta, pdl, rm);

    renderFlies(t, sr, rm);

    // sound: each event as the playhead crosses it
    if (playing && window.ClonesSound && ClonesSound.on() && t > prevT && t - prevT < 1) {
      TL.forEach(function (it) { if (it.t > prevT && it.t <= t) ClonesSound.event(it.e.kind, it.e); });
    }

    // refusal moment
    var ref = $('refusal');
    if (inRefusal) {
      if (ref.hidden) {
        ref.hidden = false;
        var crossed = playing && prevT < rT && t >= rT;
        var seal = ref.querySelector('.seal');
        seal.classList.remove('stamp');
        if (crossed && !rm) { void seal.offsetWidth; seal.classList.add('stamp'); scene.classList.remove('shake', 'flash'); void scene.offsetWidth; scene.classList.add('shake', 'flash'); }
        if (crossed) $('announce').textContent = 'Chain refused: ' + accountOf(refusedItem.e.clone) + ' cannot withdraw. ' + refusalCode(refusedItem.e.error);
      }
    } else if (!ref.hidden) ref.hidden = true;

    // result card
    var showResult = started && t >= DURATION - 0.05 && !resultDismissed;
    if (showResult && $('result').hidden) { buildResult(); $('result').hidden = false; $('againBtn').focus({ preventScroll: true }); }
    if (!showResult && !$('result').hidden) $('result').hidden = true;

    // controls and log
    var sc2 = $('scrub'); if (document.activeElement !== sc2 || playing) sc2.value = t.toFixed(1);
    setText($('ctime'), mmss(t) + ' / ' + mmss(DURATION));
    var pb2 = $('playBtn');
    setText(pb2, playing ? 'Pause' : t >= DURATION - 0.05 ? 'Replay' : 'Play');
    pb2.setAttribute('aria-label', pb2.textContent);
    renderLog(t);
    prevT = t;
  }

  function showDelta(node, dl, rm) {
    if (!dl) { node.style.opacity = '0'; return; }
    setText(node, signed(dl.v));
    node.className = 'delta ' + (dl.v >= 0 ? 'plus' : 'minus');
    node.style.opacity = String(dl.p < 0.75 ? 1 : 1 - (dl.p - 0.75) / 0.25);
    node.style.transform = 'translate(-50%,' + (rm ? 0 : -dl.p * 28).toFixed(1) + 'px)';
  }

  function renderFlies(t, sr, rm) {
    var fx = $('fx'), active = new Set();
    if (!rm && started) {
      var counter = centerIn($('counter').getBoundingClientRect(), sr);
      for (var k = 0; k < TL.length; k++) {
        var it = TL[k];
        if (it.t > t) break;
        if (it.e.kind !== 'order' || t - it.t > 1.0) continue;
        var u = ui.clones[it.e.clone]; if (!u) continue;
        var purse = centerIn(u.purse.getBoundingClientRect(), sr);
        active.add(k);
        var f = ui.flies.get(k);
        if (!f) {
          f = { a: el('div', 'fly'), b: el('div', 'fly') };
          var buy = it.e.side === 'buy';
          f.a.appendChild(svgUse(buy ? 'coin' : 'g-' + it.e.good));
          f.b.appendChild(svgUse(buy ? 'g-' + it.e.good : 'coin'));
          var tag = el('span', 'fly-tag', it.e.qty + ' ' + it.e.good);
          (buy ? f.b : f.a).appendChild(tag);
          f.a.querySelector('svg').setAttribute('width', '24'); f.a.querySelector('svg').setAttribute('height', '24');
          f.b.querySelector('svg').setAttribute('width', '24'); f.b.querySelector('svg').setAttribute('height', '24');
          fx.appendChild(f.a); fx.appendChild(f.b); ui.flies.set(k, f);
        }
        var p = (t - it.t) / 1.0;
        placeFly(f.a, purse, counter, clamp(p / 0.5, 0, 1), p < 0.5);
        placeFly(f.b, counter, purse, clamp((p - 0.5) / 0.5, 0, 1), p >= 0.5);
      }
    }
    ui.flies.forEach(function (f, k) { if (!active.has(k)) { f.a.remove(); f.b.remove(); ui.flies.delete(k); } });
  }
  function placeFly(node, from, to, p, visible) {
    node.style.display = visible ? '' : 'none';
    if (!visible) return;
    var e = ease(p), x = from.x + (to.x - from.x) * e, y = from.y + (to.y - from.y) * e - Math.sin(p * Math.PI) * 50;
    node.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
  }

  function buildResult() {
    var rows = $('resultRows'); rows.textContent = '';
    var paid = {};
    D.events.forEach(function (e) { if (e.kind === 'settled') paid[e.clone] = e.paid_out; });
    (D.outcomes || []).forEach(function (o) {
      var li = el('li', o.broke ? 'broke' : null), tint = TINTS[o.temperament] || '#888';
      li.style.setProperty('--tint', tint);
      var fig = svgUse('person'); fig.style.setProperty('--tunic', tint); fig.style.setProperty('--eye', o.broke ? '#4d4a52' : tint);
      if (o.broke) fig.style.filter = 'grayscale(1) brightness(.75)';
      li.appendChild(fig);
      var nm = el('div', 'r-name', o.name);
      nm.appendChild(el('small', null, o.temperament + ', ' + o.orders + ' orders' + (o.broke ? ', went broke' : '')));
      li.appendChild(nm);
      var out = paid[o.name] != null ? paid[o.name] : o.final_cash, diff = out - o.stake;
      var num = el('div', 'r-num');
      num.appendChild(document.createTextNode(near(o.stake) + ' → ' + near(out)));
      num.appendChild(el('br'));
      num.appendChild(el('span', diff >= 0 ? 'gain' : 'loss', signed(diff) + ' NEAR'));
      li.appendChild(num);
      rows.appendChild(li);
    });
    var rp = $('resultPlayer');
    if (guestLog) {
      var home = 0;
      Object.keys(paid).forEach(function (k) { home += paid[k]; });
      rp.textContent = 'Stake vs paid out, per clone. ' + near(home) + ' NEAR came home in total. Hosted-town guests play with testnet NEAR, which goes back to the house afterwards.';
    } else {
      rp.textContent = 'Stake vs paid out, per clone. Your account: ' + near(D.player_balance_before) + ' NEAR before the night, ' +
        near(D.player_balance_after) + ' NEAR after every clone merged home (gas and account costs included).';
    }
    var rk = $('resultKey');
    if (D.answer_key == null) {
      rk.textContent = 'Answer key: none for this night';
      rk.className = 'result-key';
    } else {
      var ok = deepEqual(D.outcomes, D.answer_key);
      rk.textContent = 'Answer key matched: ' + (ok ? 'yes' : 'no');
      rk.className = 'result-key ' + (ok ? 'yes' : 'no');
    }
    rk.title = 'Compares the recorded outcomes with the answer key written before the clones ran (seed ' + D.seed + ').';
  }

  /* ---------- small utils ---------- */
  var textCache = new WeakMap();
  function setText(node, txt) { if (textCache.get(node) !== txt) { node.textContent = txt; textCache.set(node, txt); } }
  function mmss(t) { var s = Math.floor(t); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function mix(a, b, p) {
    var x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    var r = Math.round(((x >> 16) & 255) * (1 - p) + ((y >> 16) & 255) * p);
    var g = Math.round(((x >> 8) & 255) * (1 - p) + ((y >> 8) & 255) * p);
    var bl = Math.round((x & 255) * (1 - p) + (y & 255) * p);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /* ---------- playback ---------- */
  function frame(ts) {
    if (!playing) return;
    var dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    T = Math.min(DURATION, T + dt);
    if (T >= DURATION) playing = false;
    render();
    if (playing) requestAnimationFrame(frame);
  }
  function play() {
    if (T >= DURATION - 0.05) { T = 0; prevT = 0; resultDismissed = false; }
    playing = true; lastTs = 0;
    requestAnimationFrame(frame);
    render();
  }
  function pause() { playing = false; render(); }
  /* ---------- wiring ---------- */
  function start() {
    started = true;
    $('intro').hidden = true;
    $('playBtn').disabled = false; $('scrub').disabled = false;
    T = 0; prevT = 0; resultDismissed = false; logCount = 0; $('log').textContent = '';
    play();
  }
  $('runBtn').addEventListener('click', start);
  $('playBtn').addEventListener('click', function () { if (playing) pause(); else play(); });
  $('scrub').addEventListener('input', function (ev) {
    T = clamp(parseFloat(ev.target.value) || 0, 0, DURATION);
    prevT = T;
    if (T < DURATION - 0.05) resultDismissed = false;
    render();
  });
  $('againBtn').addEventListener('click', function () { $('result').hidden = true; T = 0; prevT = 0; resultDismissed = false; play(); });
  $('closeResult').addEventListener('click', function () { resultDismissed = true; $('result').hidden = true; $('playBtn').focus(); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !$('result').hidden) { resultDismissed = true; $('result').hidden = true; }
  });
  window.addEventListener('resize', function () { lastRound = undefined; render(); });

  load().then(function (res) {
    D = res.data;
    if (!D || !Array.isArray(D.events) || !Array.isArray(D.goods)) throw new Error('night log has no events');
    $('srcName').textContent = res.path;
    buildTimeline();
    indexClones();
    buildStatic();
    buildBoard();
    buildClones();
    if (!refusedItem) $('introBlurb').textContent = 'Twelve hours of trading, then dawn: every clone settles up and merges back into its player.';
    $('introKicker').textContent = 'Seed ' + D.seed + ', ' + D.network + ' run, ' + names.length + ' clones of ' + D.player;
    $('runBtn').disabled = false;
    render();
  }).catch(function (err) {
    var asked = new URLSearchParams(location.search).get('night');
    $('introKicker').textContent = asked
      ? 'This night log is ' + (err.message === 'not published yet' ? 'not published yet. Logs appear after the night is played (around 02:00 UTC); try again later.' : 'unavailable (' + err.message + ').')
      : 'Could not load the night log (' + err.message + '). Serve this folder over http, e.g. python3 -m http.server.';
    if (asked) { var back = el('a', null, 'Back to the town'); back.href = 'town.html'; $('introKicker').appendChild(document.createTextNode(' ')); $('introKicker').appendChild(back); }
  });
})();
