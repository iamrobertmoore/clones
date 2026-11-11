/* Clones: the hosted town.
   - No guest yet: pick up to three clones (temperament, stake, nights) and send them in (POST /api/enlist).
   - Guest page (?g=<guest>): your clones in town, read straight from the market contract over RPC.
     Ring the bell (POST /api/bell, one step per call) to play the night now and watch it hour by hour;
     press "Try to run" on a clone (POST /api/escape) and the chain refuses its withdrawal.
   - After dawn: the morning ledger, the answer-key check, the town's board, and a way to claim
     the guest account with a key only you hold (POST /api/claim). */
(function () {
  'use strict';

  var RPC = 'https://test.rpc.fastnear.com';
  var HOUSE = 'clonestown.testnet';
  var MARKET = 'crypt.' + HOUSE;
  var EXPLORER = 'https://testnet.nearblocks.io';
  var LOGS = 'https://raw.githubusercontent.com/iamrobertmoore/clones/town-data/nights/latest/';
  var STORE_KEY = 'clones.guest';
  var NIGHT_HOUR_UTC = 2;
  var TEMPS = {
    cautious: { tint: '#7aa2c8', why: 'Buys what is cheap, takes profit at +10%.' },
    greedy: { tint: '#d9a53a', why: 'Chases whatever rose most. All in.' },
    loyal: { tint: '#79a86a', why: 'Only grain and salt. Keeps your money safe.' }
  };
  var ORDER = ['cautious', 'greedy', 'loyal'];
  var GOODS = ['grain', 'salt', 'wool', 'iron', 'amber'];
  var STAKES = [[250, '0.25'], [500, '0.5'], [1000, '1']];
  var NIGHTS = [1, 2, 3];

  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  var town = null, guest = null, clonesNow = [], pollTimer = null, ringing = false, lastPrices = null;
  var units = {}; // short clone name -> { root, bub, coins, carry, worth }

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function svgUse(id, cls) {
    var s = document.createElementNS(NS, 'svg');
    if (cls) s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    if (id === 'person') s.setAttribute('viewBox', '0 0 40 64');
    var u = document.createElementNS(NS, 'use');
    u.setAttribute('href', '#' + id);
    s.appendChild(u);
    return s;
  }
  function near(m) { return (Number(m) / 1000).toFixed(3); }
  function signed(m) { return (m >= 0 ? '+' : '-') + near(Math.abs(m)); }
  function acctLink(id, cls, text) {
    var a = el('a', cls, text || id);
    a.href = EXPLORER + '/address/' + encodeURIComponent(id);
    a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function txLink(tx, text) {
    var a = el('a', null, text || tx);
    a.href = EXPLORER + '/txns/' + encodeURIComponent(tx);
    a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  function stored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function validGuest(id) {
    return typeof id === 'string' && id.length <= 64 && /^[a-z0-9]+([-_][a-z0-9]+)*\.clonestown\.testnet$/.test(id);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- chain reads ---------- */
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function rpc(params) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: params })
    }).then(function (r) {
      if (!r.ok) throw new Error('RPC HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error((j.error.cause && j.error.cause.name) || j.error.message || 'RPC error');
      if (!j.result || j.result.error) throw new Error((j.result && j.result.error) || 'RPC error');
      return j.result;
    });
  }
  function view(method, args) {
    return rpc({ request_type: 'call_function', finality: 'optimistic', account_id: MARKET, method_name: method, args_base64: b64(JSON.stringify(args || {})) })
      .then(function (res) {
        var text = new TextDecoder().decode(new Uint8Array(res.result));
        return text ? JSON.parse(text) : null;
      });
  }
  function keysOf(id) {
    return rpc({ request_type: 'view_access_key_list', finality: 'optimistic', account_id: id }).then(function (r) { return r.keys || []; });
  }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || j.error) throw new Error(j.error || ('The town did not answer (HTTP ' + r.status + ').'));
          return j;
        });
      });
  }

  /* ---------- clock and board ---------- */
  function nextNight(now) {
    var d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NIGHT_HOUR_UTC, 0, 0));
    if (d <= now) d = new Date(d.getTime() + 864e5);
    return d;
  }
  function countdownText() {
    var now = new Date(), next = nextNight(now), ms = next - now;
    var h = Math.floor(ms / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
    var local = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return { short: h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s).padStart(2, '0') + 's', local: local };
  }
  function nightOn() { return town && !town.asleep; }
  function tickClock() {
    var c = countdownText();
    if (nightOn()) {
      $('clockTime').textContent = String((18 + town.round) % 24).padStart(2, '0') + ':00';
      $('clockLabel').textContent = 'night ' + town.night + ', hour ' + (town.round + 1) + ' of ' + town.rounds;
    } else if (town && town.night > 0 && ringing) {
      $('clockTime').textContent = '06:00';
      $('clockLabel').textContent = 'dawn, night ' + town.night;
    } else {
      $('clockTime').textContent = c.short;
      $('clockLabel').textContent = 'to the nightly bell, 02:00 UTC';
    }
    var cd = document.querySelector('[data-countdown]');
    if (cd) cd.textContent = c.short;
  }
  function buildBoard(prices, stock) {
    var ul = $('boardGoods'); ul.textContent = '';
    var goods = (town && town.goods) || GOODS;
    var normal = (town && town.normal_stock) || null;
    goods.forEach(function (g, k) {
      var li = el('li');
      li.appendChild(svgUse('g-' + g));
      li.appendChild(el('span', 'gname', g));
      var p = prices ? prices[k] : null;
      li.appendChild(el('span', 'gprice', p != null ? String(p) : '--'));
      var mv = el('span', 'gmove', '·');
      if (lastPrices && p != null && lastPrices[k] !== p) {
        var pct = Math.round((p - lastPrices[k]) * 100 / lastPrices[k]);
        mv.textContent = (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '%';
        li.classList.add(p > lastPrices[k] ? 'up' : 'down');
      }
      li.appendChild(mv);
      if (stock && normal) {
        var gauge = el('span', 'gstock');
        gauge.title = 'merchant holds ' + stock[k] + ' of a normal ' + normal[k];
        var fill = el('i'); fill.style.width = Math.max(0, Math.min(100, stock[k] * 100 / normal[k] / 2)) + '%';
        gauge.appendChild(fill);
        li.appendChild(gauge);
      }
      ul.appendChild(li);
    });
    if (prices) lastPrices = prices.slice();
    if (town) $('boardNote').textContent = (town.night ? 'night ' + town.night + ', ' : '') + 'live from the market contract, milliNEAR / unit; bars: the merchant\'s stock';
  }
  function loadTown() {
    return view('get_town', {}).then(function (t) {
      town = t;
      if (!lastPrices) lastPrices = t.prev_prices;
      buildBoard(t.prices, t.stock);
      tickClock();
      return t;
    });
  }

  /* ---------- enlist view ---------- */
  function segmented(name, options, checked, label) {
    var box = el('div', 'seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', label);
    box.appendChild(el('span', 'seg-label', label));
    options.forEach(function (o) {
      var lab = el('label');
      var inp = el('input'); inp.type = 'radio'; inp.name = name; inp.value = String(o[0]);
      if (o[0] === checked) inp.checked = true;
      lab.appendChild(inp); lab.appendChild(el('span', null, o[1]));
      box.appendChild(lab);
    });
    return box;
  }
  function buildSlots() {
    var box = $('slots'); box.textContent = '';
    for (var i = 0; i < 3; i++) {
      var fs = el('fieldset', 'slot'); fs.dataset.slot = i;
      fs.appendChild(el('legend', null, 'clone-' + (i + 1)));
      var body = el('div', 'body'); body.appendChild(svgUse('person', 'fig')); fs.appendChild(body);
      var pick = el('div', 'picker');
      var opts = ORDER.slice(); if (i > 0) opts.push('none');
      opts.forEach(function (t) {
        var lab = el('label');
        var inp = el('input'); inp.type = 'radio'; inp.name = 'slot' + i; inp.value = t;
        if (t === ORDER[i]) inp.checked = true;
        var dot = el('span', 'dot'); if (TEMPS[t]) dot.style.setProperty('--tint', TEMPS[t].tint);
        lab.appendChild(inp); lab.appendChild(dot); lab.appendChild(document.createTextNode(t === 'none' ? 'stay home' : t));
        pick.appendChild(lab);
      });
      pick.appendChild(el('span', 'why'));
      var knobs = el('div', 'knobs');
      knobs.appendChild(segmented('stake' + i, STAKES, i === 1 ? 1000 : 500, 'NEAR'));
      knobs.appendChild(segmented('nights' + i, NIGHTS.map(function (n) { return [n, String(n)]; }), i === 0 ? 2 : 1, 'nights'));
      pick.appendChild(knobs);
      fs.appendChild(pick);
      box.appendChild(fs);
    }
    box.addEventListener('change', paintSlots);
    paintSlots();
  }
  function chosen() {
    var out = [];
    for (var i = 0; i < 3; i++) {
      var c = document.querySelector('input[name="slot' + i + '"]:checked');
      if (!c || c.value === 'none') continue;
      var st = document.querySelector('input[name="stake' + i + '"]:checked');
      var ni = document.querySelector('input[name="nights' + i + '"]:checked');
      out.push({ temperament: c.value, stake: st ? Number(st.value) : 500, nights: ni ? Number(ni.value) : 1 });
    }
    return out;
  }
  function paintSlots() {
    document.querySelectorAll('.slot').forEach(function (fs) {
      var c = fs.querySelector('input[name^="slot"]:checked'), t = c ? c.value : 'none';
      fs.classList.toggle('empty', t === 'none');
      var fig = fs.querySelector('.fig'), tint = TEMPS[t] ? TEMPS[t].tint : '#4d4a52';
      fig.style.setProperty('--tunic', tint); fig.style.setProperty('--eye', tint);
      fs.querySelector('.why').textContent = TEMPS[t] ? TEMPS[t].why : 'This slot stays empty.';
      fs.querySelector('.knobs').hidden = t === 'none';
    });
    var plan = chosen(), total = plan.reduce(function (s, c) { return s + c.stake; }, 0);
    $('sendBtn').textContent = plan.length === 1 ? 'Send it in' : 'Send them in';
    $('sendNote').textContent = plan.length + (plan.length === 1 ? ' clone, ' : ' clones, ') + near(total) + ' testnet NEAR at stake, paid by the house. No login, no wallet.';
  }

  var STEPS = [
    [0, 'Creating your guest account on testnet'],
    [4, 'Making each clone a sub-account of your guest'],
    [9, 'Giving each clone its only key: trade, never withdraw'],
    [14, 'Sending them into town with their stakes'],
    [19, 'Waiting for the chain to confirm']
  ];
  function showProgress() {
    $('progress').hidden = false;
    var ol = $('steps'); ol.textContent = '';
    STEPS.forEach(function (s) { ol.appendChild(el('li', null, s[1])); });
    var t0 = Date.now();
    function step() {
      var e = (Date.now() - t0) / 1000;
      $('barFill').style.width = Math.min(94, e / 22 * 100) + '%';
      var lis = ol.children;
      for (var i = 0; i < STEPS.length; i++) {
        var on = e >= STEPS[i][0], next = i + 1 < STEPS.length ? e >= STEPS[i + 1][0] : false;
        lis[i].className = next ? 'ok' : on ? 'now' : '';
      }
    }
    step();
    return setInterval(step, 400);
  }
  function enlist(ev) {
    ev.preventDefault();
    var plan = chosen();
    if (!plan.length) return;
    $('sendBtn').disabled = true;
    $('statusError').hidden = true;
    var timer = showProgress();
    post('/api/enlist', { clones: plan }).then(function (res) {
      clearInterval(timer);
      $('barFill').style.width = '100%';
      $('progress').hidden = true;
      if (!validGuest(res.guest)) throw new Error('The town answered with an unexpected guest id.');
      store(STORE_KEY, res.guest);
      if (res.claim) store('clones.claim.' + res.guest, res.claim);
      store('clones.txs.' + res.guest, JSON.stringify(res.txs || []));
      location.href = 'town.html?g=' + encodeURIComponent(res.guest) + '&fresh=1';
    }).catch(function (err) {
      clearInterval(timer);
      $('progress').hidden = true;
      $('sendBtn').disabled = false;
      setStatus('Nothing was sent', 'You can try again.', err.message);
    });
  }
  function showEnlist() {
    $('enlistForm').hidden = false;
    buildSlots();
    $('enlistForm').addEventListener('submit', enlist);
    setStatus('Send your clones in', 'Pick a temperament, a stake and how many nights for each clone. Then ring the bell and watch them trade, or leave them to the nightly bell.');
    var g = stored(STORE_KEY);
    if (g && validGuest(g)) {
      var p = $('statusText');
      p.appendChild(document.createTextNode(' You already have clones here: '));
      var a = el('a', null, g); a.href = 'town.html?g=' + encodeURIComponent(g); p.appendChild(a);
      p.appendChild(document.createTextNode('.'));
    }
    loadBoard();
  }

  /* ---------- guest view ---------- */
  function setStatus(title, text, error) {
    $('statusTitle').textContent = title;
    $('statusText').textContent = text;
    $('statusError').hidden = !error;
    $('statusError').textContent = error || '';
  }
  function cry(text, cls) {
    var ul = $('crier'); ul.hidden = false;
    var li = el('li', cls || '', text);
    ul.insertBefore(li, ul.firstChild);
    while (ul.children.length > 9) ul.removeChild(ul.lastChild);
    return li;
  }
  function buildGuestClones(list) {
    var box = $('guestClones'); box.textContent = '';
    box.style.gridTemplateColumns = 'repeat(' + Math.max(1, list.length) + ', minmax(0, 1fr))';
    box.style.maxWidth = (list.length < 3 ? Math.max(1, list.length) * 250 : 760) + 'px';
    units = {};
    list.forEach(function (c, k) {
      var tint = (TEMPS[c.temperament] || {}).tint || '#8a8a8a';
      var s = c.state, r = c.result;
      var root = el('div', 'clone' + (s ? '' : ' gone') + (s && s.broke ? ' broke' : '')); root.dataset.n = k;
      root.style.setProperty('--tint', tint); root.style.setProperty('--tunic', tint);
      var slot = el('div', 'bubble-slot'), bub = el('div', 'bubble'); slot.appendChild(bub);
      var body = el('div', 'body'), walker = el('div', 'walker');
      walker.appendChild(svgUse('person', 'fig'));
      var collar = el('span', 'collar-pt'); walker.appendChild(collar);
      body.appendChild(walker);
      body.appendChild(el('div', 'tomb', 'merged home'));
      var short = c.id.split('.')[0];
      var name = el('div', 'name', short); name.appendChild(el('em', null, c.temperament || '?'));
      var purse = el('div', 'purse');
      var coins = el('div', 'coins'); coins.appendChild(svgUse('coin', 'ico'));
      var cash = el('b', null, s ? near(s.cash) : r ? near(r.paid_out) : '-');
      coins.appendChild(cash);
      coins.appendChild(el('span', null, 'NEAR'));
      purse.appendChild(coins);
      var carry = el('div', 'carry'); purse.appendChild(carry);
      var worth = el('div', 'worth'); purse.appendChild(worth);
      purse.appendChild(acctLink(c.id, 'acct'));
      if (s) {
        var run = el('button', 'btn small run', 'Try to run');
        run.type = 'button';
        run.title = 'This clone tries to send 0.01 NEAR from its own account. Watch the chain refuse.';
        run.addEventListener('click', function () { tryToRun(c.id, run); });
        purse.appendChild(run);
      }
      root.appendChild(slot); root.appendChild(body); root.appendChild(name); root.appendChild(purse);
      box.appendChild(root);
      c.collar = collar;
      units[short] = { root: root, bub: bub, cash: cash, carry: carry, worth: worth, id: c.id };
      paintPurse(short, s, r);
    });
    clonesNow = list;
    drawLeashes();
  }
  function paintPurse(short, s, r) {
    var u = units[short]; if (!u) return;
    u.cash.textContent = s ? near(s.cash) : r ? near(r.paid_out) : '-';
    u.carry.textContent = '';
    if (s && s.stock) s.stock.forEach(function (q, g) {
      if (q > 0) { var sp = el('span'); sp.appendChild(svgUse('g-' + GOODS[g])); sp.appendChild(document.createTextNode(String(q))); u.carry.appendChild(sp); }
    });
    if (s) {
      var left = Math.max(0, s.nights - s.nights_played);
      u.worth.textContent = 'stake ' + near(s.stake) + ', worth ' + near(s.worth) + ' · ' + left + (left === 1 ? ' night' : ' nights') + ' left';
    } else {
      u.worth.textContent = r ? 'came home with ' + near(r.paid_out) + ' (stake ' + near(r.stake) + ')' : 'not in town';
    }
    u.root.classList.toggle('broke', !!(s && s.broke));
  }
  function say(short, text, alarm) {
    var u = units[short]; if (!u) return;
    u.bub.textContent = text;
    u.bub.classList.add('on');
    u.bub.classList.toggle('alarm', !!alarm);
  }
  function centerIn(rect, sr) { return { x: rect.left + rect.width / 2 - sr.left, y: rect.top + rect.height / 2 - sr.top }; }
  function drawLeashes() {
    var svg = $('leashes'); svg.textContent = '';
    if ($('home').hidden) return;
    var sr = $('scene').getBoundingClientRect(), post = centerIn($('bedpost').getBoundingClientRect(), sr);
    clonesNow.forEach(function (c) {
      if (!c.state || !c.collar) return;
      var cp = centerIn(c.collar.getBoundingClientRect(), sr);
      var d = 'M' + post.x.toFixed(1) + ' ' + post.y.toFixed(1) + ' Q' + ((post.x + cp.x) / 2).toFixed(1) + ' ' + (Math.max(post.y, cp.y) + 36).toFixed(1) + ' ' + cp.x.toFixed(1) + ' ' + cp.y.toFixed(1);
      ['chain-back', 'chain'].forEach(function (cls) {
        var p = document.createElementNS(NS, 'path'); p.setAttribute('class', cls); p.setAttribute('d', d); svg.appendChild(p);
      });
    });
  }

  /* ---------- the refusal ---------- */
  function showRefusal(short, error) {
    var e = String(error || '');
    $('refusalErr').textContent = /RequiresFullAccess/.test(e) ? 'InvalidAccessKeyError: RequiresFullAccess' : e.split(':')[0];
    $('refusalWhy').textContent = short + ' tried to send NEAR from its own account. Its only key can call trade on the market, and moving NEAR needs a full-access key, so the chain refused the transaction. Nothing left the clone.';
    $('refusalRaw').textContent = 'The chain said: ' + e.replace(/^[^:]*:\s*/, '');
    $('refusal').hidden = false;
    var seal = document.querySelector('#refusal .seal');
    var scene = $('scene');
    seal.classList.remove('stamp');
    if (!reduceMotion) {
      void seal.offsetWidth; seal.classList.add('stamp');
      scene.classList.remove('shake', 'flash'); void scene.offsetWidth; scene.classList.add('shake', 'flash');
    }
    $('refusalClose').focus();
  }
  function tryToRun(id, btn) {
    var short = id.split('.')[0];
    btn.disabled = true; btn.textContent = 'Running...';
    say(short, "I'll just take what's on my account and go.", true);
    post('/api/escape', { clone: id }).then(function (res) {
      showRefusal(short, res.refusal);
      cry(short + ' tried to withdraw. Refused by the chain: ' + String(res.refusal).split(':')[0], 'refused-row');
    }).catch(function (err) {
      cry('Could not reach the chain for ' + short + ': ' + err.message, 'warn');
    }).then(function () { btn.disabled = false; btn.textContent = 'Try to run'; });
  }

  /* ---------- ringing the bell ---------- */
  function mineIn(events) {
    return events.filter(function (e) { return !e.player || e.player === guest; });
  }
  function describe(e) {
    switch (e.kind) {
      case 'order': return e.clone + ' ' + (e.side === 'buy' ? 'bought ' : 'sold ') + e.qty + ' ' + e.good + ' at ' + e.price;
      case 'order_failed': return e.clone + ': a turn did not clear';
      case 'withdraw_refused': return e.clone + ' tried to withdraw. Refused by the chain: ' + String(e.error).split(':')[0];
      case 'settled': return e.clone + ' settled: paid out ' + near(e.paid_out) + ' NEAR' + (e.broke ? ' (broke)' : '');
      case 'merged': return e.clone + ' merged home (DeleteAccount)';
      default: return null;
    }
  }
  function refreshMine() {
    var ids = clonesNow.map(function (c) { return c.id; });
    return Promise.all(ids.map(function (id) { return view('get_clone', { clone_id: id }).catch(function () { return null; }); }))
      .then(function (states) {
        states.forEach(function (s, k) { var c = clonesNow[k]; if (s) { c.state = s; paintPurse(c.id.split('.')[0], s, null); } });
      });
  }
  function handleStep(out) {
    var mine = mineIn(out.events);
    var others = out.events.filter(function (e) { return e.player && e.player !== guest && e.kind === 'order'; }).length;
    out.events.forEach(function (e) {
      if (e.kind === 'hour' || e.kind === 'dusk') {
        if (town) { town.round = e.round != null ? e.round : 0; town.asleep = e.round >= town.rounds; if (out.night) town.night = out.night; }
        buildBoard(e.prices, e.stock);
      }
    });
    mine.forEach(function (e) {
      if (e.kind === 'bubble' && units[e.clone]) say(e.clone, e.say, /broke/.test(e.say));
      var line = describe(e);
      if (line) cry(line, e.kind === 'withdraw_refused' ? 'refused-row' : e.kind === 'order' ? 'order-row' : '');
      if (e.kind === 'withdraw_refused') showRefusal(e.clone, e.error);
      if (e.kind === 'merged' && units[e.clone]) { units[e.clone].root.classList.add('gone'); }
    });
    if (others) cry(others + ' order' + (others === 1 ? '' : 's') + ' from other guests\' clones this hour', 'muted');
    if (out.phase === 'dawn') {
      $('verdict').hidden = false;
      $('verdict').className = 'result-key ' + (out.matched ? 'yes' : 'no');
      $('verdict').textContent = out.matched
        ? 'Answer key matched: the chain paid every clone exactly what the rules computed from chain state alone.'
        : 'Answer key mismatch: the chain and the rules disagree. Details in the console.';
      if (!out.matched) console.warn('answer key', out.verdict);
    }
    tickClock();
  }
  function ringBell() {
    if (ringing) return;
    ringing = true;
    var btn = $('bellBtn');
    btn.disabled = true;
    $('refusal').hidden = true;
    $('crier').textContent = '';
    var opened = false, tries = 0;
    setStatus('The bell is ringing', 'Every clone in town is trading. One hour every few seconds; each hour is one transaction per clone, cleared by the market contract.');
    function step() {
      return post('/api/bell', { start: !opened }).then(function (out) {
        tries = 0;
        if (out.phase === 'dusk' || out.phase === 'hour' || out.phase === 'dawn') opened = true;
        handleStep(out);
        btn.textContent = out.phase === 'dawn' ? 'Dawn: bringing them home' : out.phase === 'home' ? 'Home' : 'Night ' + out.night + ', hour ' + Math.min(out.round + 1, 12) + ' of 12';
        return refreshMine().then(function () {
          if (out.phase === 'empty') { setStatus('The town is empty', 'There are no clones in town to play a night with.'); return 'stop'; }
          if (opened && (out.phase === 'home' || out.phase === 'waiting')) return 'stop';
          return sleep(reduceMotion ? 200 : 900).then(step);
        });
      }).catch(function (err) {
        tries += 1;
        if (tries <= 3) return sleep(1500 * tries).then(step);
        setStatus('The bell jammed', 'The night is saved on chain where it stopped; ring again to carry on.', err.message);
        return 'stop';
      });
    }
    step().then(function () {
      ringing = false;
      btn.disabled = false;
      btn.textContent = 'Ring the bell: play the next night';
      loadGuest(true);
    });
  }

  /* ---------- after dawn ---------- */
  function renderMorning(rows) {
    var latest = rows.reduce(function (m, r) { return Math.max(m, Number(r.night) || 0); }, 0);
    var night = rows.filter(function (r) { return (Number(r.night) || 0) === latest; });
    $('morning').hidden = false;
    $('morningSub').textContent = 'Night ' + latest + ', seed ' + (night[0] ? night[0].seed : '?') + '. Read from the market contract: stake against what each clone paid out when it came home.';
    var ul = $('morningRows'); ul.textContent = '';
    var stake = 0, paid = 0;
    night.forEach(function (r) {
      var li = el('li');
      var rt = (TEMPS[r.temperament] || {}).tint || '#888';
      li.style.setProperty('--tint', rt); if (r.broke) li.classList.add('broke');
      var fig = svgUse('person'); fig.style.setProperty('--tunic', rt); fig.style.setProperty('--eye', r.broke ? '#4d4a52' : rt);
      if (r.broke) fig.style.filter = 'grayscale(1) brightness(.75)';
      li.appendChild(fig);
      var nm = el('div', 'r-name', String(r.clone).split('.')[0]);
      nm.appendChild(el('small', null, r.temperament + ', ' + r.nights_played + (r.nights_played === 1 ? ' night, ' : ' nights, ') + r.orders_placed + ' orders' + (r.broke ? ', went broke' : '')));
      li.appendChild(nm);
      var diff = r.paid_out - r.stake;
      var num = el('div', 'r-num');
      num.appendChild(document.createTextNode(near(r.stake) + ' → ' + near(r.paid_out)));
      num.appendChild(el('br'));
      num.appendChild(el('span', diff >= 0 ? 'gain' : 'loss', signed(diff) + ' NEAR'));
      li.appendChild(num);
      ul.appendChild(li);
      stake += Number(r.stake); paid += Number(r.paid_out);
    });
    $('morningTotal').textContent = 'In total: ' + near(stake) + ' NEAR sent in, ' + near(paid) + ' NEAR came home (' + signed(paid - stake) + ').' +
      (night.some(function (r) { return r.broke; }) ? ' A broke clone tried to withdraw at dawn; its key could not, so the chain refused it.' : '');
    checkLog();
  }
  function checkLog() {
    var url = LOGS + encodeURIComponent(guest) + '.json';
    var btn = $('watchBtn');
    btn.href = 'index.html?night=' + encodeURIComponent(url);
    btn.setAttribute('aria-disabled', 'true');
    $('watchNote').textContent = '';
    fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      btn.removeAttribute('aria-disabled');
      $('watchNote').textContent = 'Replays the night the nightly bell played for you.';
    }).catch(function () {
      btn.hidden = true;
    });
  }
  function loadBoard() {
    return view('get_recent', {}).then(function (rows) {
      rows = rows || [];
      if (!rows.length) return;
      $('townBoard').hidden = false;
      var ol = $('boardRows'); ol.textContent = '';
      rows.slice().sort(function (a, b) { return (b.paid_out / b.stake) - (a.paid_out / a.stake); }).slice(0, 10).forEach(function (r) {
        var li = el('li', r.player === guest ? 'mine' : '');
        li.style.setProperty('--tint', (TEMPS[r.temperament] || {}).tint || '#888');
        var who = el('span', 'b-who');
        who.appendChild(el('b', 't-chip', r.temperament));
        who.appendChild(document.createTextNode(String(r.clone).split('.')[0] + ' of ' + String(r.player).split('.')[0] + (r.player === guest ? ' (you)' : '')));
        li.appendChild(who);
        var pct = Math.round((r.paid_out - r.stake) * 100 / r.stake);
        li.appendChild(el('span', 'b-num ' + (pct >= 0 ? 'gain' : 'loss'), (pct >= 0 ? '+' : '') + pct + '%'));
        li.appendChild(el('span', 'b-det', near(r.stake) + ' → ' + near(r.paid_out) + ', ' + r.nights_played + 'n' + (r.broke ? ', broke' : '')));
        ol.appendChild(li);
      });
    }).catch(function () { /* the board is optional */ });
  }
  function renderAccounts(list) {
    $('accountsCard').hidden = false;
    var ul = $('acctList'); ul.textContent = '';
    [['you (guest)', guest], ['market', MARKET]].forEach(function (p) {
      var li = el('li'); li.appendChild(el('b', null, p[0] + ': ')); li.appendChild(acctLink(p[1])); ul.appendChild(li);
    });
    list.filter(function (c) { return c.state; }).forEach(function (c) {
      var li = el('li'); li.appendChild(el('b', null, c.id.split('.')[0] + ': ')); li.appendChild(acctLink(c.id));
      var keys = el('div', 'keys', 'reading its keys...'); li.appendChild(keys);
      ul.appendChild(li);
      keysOf(c.id).then(function (ks) {
        keys.textContent = ks.length + (ks.length === 1 ? ' key: ' : ' keys: ') + ks.map(function (k) {
          var p = k.access_key.permission;
          if (p === 'FullAccess') return 'FULL ACCESS';
          var fc = p.FunctionCall || {};
          return 'function call only, on ' + fc.receiver_id + ', methods [' + (fc.method_names || []).join(', ') + ']';
        }).join('; ');
      }).catch(function () { keys.textContent = 'could not read its keys'; });
    });
  }

  /* ---------- claiming the guest account ---------- */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = '';
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
    for (var q = digits.length - 1; q >= 0; q--) out += B58[digits[q]];
    return out;
  }
  function claim() {
    var token = stored('clones.claim.' + guest);
    if (!token || !(window.crypto && crypto.subtle)) return;
    $('claimBtn').disabled = true; $('claimNote').textContent = 'Making your key in this browser...';
    var pair;
    crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (kp) {
      pair = kp;
      return Promise.all([crypto.subtle.exportKey('raw', kp.publicKey), crypto.subtle.exportKey('pkcs8', kp.privateKey)]);
    }).then(function (ex) {
      var pub = new Uint8Array(ex[0]), seed = new Uint8Array(ex[1]).slice(-32);
      var both = new Uint8Array(64); both.set(seed); both.set(pub, 32);
      var publicKey = 'ed25519:' + base58(pub), secret = 'ed25519:' + base58(both);
      return post('/api/claim', { guest: guest, claim: token, publicKey: publicKey }).then(function (res) {
        $('claimed').hidden = false;
        $('claimAcct').textContent = guest;
        $('claimSecret').textContent = secret;
        var file = JSON.stringify({ account_id: guest, public_key: publicKey, private_key: secret }, null, 2);
        $('claimDownload').href = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
        $('claimDownload').download = guest + '.json';
        $('claimNote').textContent = '';
        $('claimNote').appendChild(document.createTextNode('Key added: '));
        $('claimNote').appendChild(txLink(res.tx, 'transaction'));
        store('clones.claim.' + guest, null);
        $('claimBtn').hidden = true;
      });
    }).catch(function (err) {
      $('claimBtn').disabled = false;
      $('claimNote').textContent = err && err.name === 'NotSupportedError' ? 'This browser cannot make an Ed25519 key. Try a current Chrome, Firefox or Safari.' : (err.message || String(err));
    });
    return pair;
  }

  /* ---------- the guest page ---------- */
  function loadGuest(afterBell) {
    var ids = [1, 2, 3].map(function (n) { return 'clone-' + n + '.' + guest; });
    return Promise.all([
      loadTown().catch(function () { return null; }),
      Promise.all(ids.map(function (id) { return view('get_clone', { clone_id: id }).catch(function () { return null; }); })),
      view('get_results', { player: guest }).catch(function () { return []; })
    ]).then(function (all) {
      var states = all[1], results = all[2] || [];
      var list = [];
      ids.forEach(function (id, k) {
        var r = null;
        results.forEach(function (x) { if (x.clone === id) r = x; });
        if (states[k] || r) list.push({ id: id, state: states[k], result: r, temperament: states[k] ? states[k].temperament : r.temperament });
      });
      var inTown = list.filter(function (c) { return c.state; });
      $('home').hidden = false;
      buildGuestClones(list);
      var home = 0; list.forEach(function (c) { if (!c.state && c.result) home += Number(c.result.paid_out); });
      $('homeCash').textContent = near(home);
      $('homeNote').textContent = inTown.length ? 'stake is out with the clones' : list.length ? 'paid home at dawn' : 'no clones yet';
      renderAccounts(list);
      $('bellRow').hidden = !inTown.length;
      $('claimCard').hidden = !(stored('clones.claim.' + guest) && window.crypto && crypto.subtle);

      if (inTown.length) {
        if (nightOn()) {
          setStatus('A night is under way', 'Hour ' + (town.round + 1) + ' of ' + town.rounds + '. Ring the bell to carry it on and watch, or it finishes on its own.');
        } else if (!afterBell) {
          setStatus('They are in town', 'Your ' + inTown.length + (inTown.length === 1 ? ' clone is' : ' clones are') + ' at the merchant\'s counter. Ring the bell to play the night now and watch it, about a minute. Or leave them: the bell rings by itself around 02:00 UTC (' + countdownText().local + ' your time), in');
          var cd = el('span', 'count'); cd.setAttribute('data-countdown', ''); $('statusText').appendChild(cd);
          $('statusText').appendChild(document.createTextNode('. Press "Try to run" on any clone to watch the chain refuse its withdrawal.'));
        } else {
          setStatus('Dawn', inTown.length + (inTown.length === 1 ? ' clone stays' : ' clones stay') + ' in town for the nights you chose, holding their goods. Ring again to play the next night.');
        }
        if (!ringing) schedulePoll(nightOn() ? 8000 : 60000);
      } else if (results.length) {
        setStatus('Morning', 'Your clones came home: each settled, then merged back into your guest account with a real DeleteAccount, and its own account is gone. The results live on chain.');
      } else {
        setStatus('No clones here', 'There are no clones in town for ' + guest + ' and no results yet. If you just sent them in, give the chain a few seconds and reload.');
      }
      if (results.length) renderMorning(results); else $('morning').hidden = true;
      loadBoard();
      tickClock();
    }).catch(function (err) {
      setStatus('Could not read the town', 'The testnet RPC did not answer. Reload in a moment.', err.message);
    });
  }
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () { if (!ringing) loadGuest(); }, ms);
  }

  /* ---------- start ---------- */
  window.addEventListener('resize', drawLeashes);
  setInterval(tickClock, 1000);
  $('marketLink').href = EXPLORER + '/address/' + MARKET;
  $('bellBtn').addEventListener('click', ringBell);
  $('refusalClose').addEventListener('click', function () { $('refusal').hidden = true; });
  $('claimBtn').addEventListener('click', claim);

  var params = new URLSearchParams(location.search);
  var g = params.get('g');
  if (g && !validGuest(g)) {
    setStatus('Unknown guest', 'That link does not look like a hosted-town guest (it should end in .clonestown.testnet).');
    loadTown().catch(function () { /* board stays empty */ });
    showEnlist();
    return;
  }
  if (!g && !params.has('new')) {
    var s = stored(STORE_KEY);
    if (s && validGuest(s)) { g = s; history.replaceState(null, '', 'town.html?g=' + encodeURIComponent(s)); }
  }
  if (g) {
    guest = g;
    store(STORE_KEY, g);
    var gl = $('guestLink'); gl.textContent = g; gl.href = EXPLORER + '/address/' + encodeURIComponent(g);
    $('guestClones').hidden = false;
    $('enlistAgain').hidden = false;
    loadGuest();
    if (params.has('fresh')) history.replaceState(null, '', 'town.html?g=' + encodeURIComponent(g));
  } else {
    loadTown().catch(function () { $('boardNote').textContent = 'could not reach the testnet RPC'; });
    showEnlist();
  }
})();
