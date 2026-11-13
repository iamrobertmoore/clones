/* Clones: the hosted town.
   - No guest yet: pick up to three clones (temperament, stake, nights) and send them in (POST /api/enlist).
   - Guest page (?g=<guest>): your clones in town, read straight from the market contract over RPC.
     Ring the bell (POST /api/bell, one step per call) to play the night now and watch it hour by hour;
     press "Try to run" on a clone (POST /api/escape) and the chain refuses its withdrawal.
   - After dawn: the morning ledger, the answer-key check, the town's board, and a way to claim
     the guest account with a key only you hold (POST /api/claim). */
(function () {
  'use strict';

  var RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com'];
  var rpcAt = 0; // the host that answered last
  var HOUSE = 'clonestown.testnet';
  var MARKET = 'pyre.' + HOUSE;
  var EXPLORER = 'https://testnet.nearblocks.io';
  var LOGS = 'https://raw.githubusercontent.com/iamrobertmoore/clones/town-data/nights/latest/';
  var STORE_KEY = 'clones.guest';
  var NIGHT_HOUR_UTC = 2;
  var TEMPS = {
    cautious: { tint: '#7aa2c8', why: 'Buys what is cheap, takes profit at +10%.' },
    greedy: { tint: '#d9a53a', why: 'Chases whatever rose most. All in.' },
    loyal: { tint: '#79a86a', why: 'Only grain and salt. Keeps your money safe.' },
    possessed: { tint: '#b48ad8', why: 'An AI trades on your instruction (edit it below). It still can\'t run off with your money.' }
  };
  var ORDER = ['cautious', 'greedy', 'loyal'];
  var GOODS = ['grain', 'salt', 'wool', 'iron', 'amber'];
  var STAKES = [[250, '0.25'], [500, '0.5'], [1000, '1']];
  var MOODS = {
    blight: { name: 'Blight', why: 'The luxuries rot all night; the staples hold.' },
    boom: { name: 'Boom', why: 'Prices climb all night.' },
    slump: { name: 'Slump', why: 'Prices sink, then rebound before dawn.' },
    wild: { name: 'Wild', why: 'Big swings both ways.' }
  };
  var NIGHTS = [1, 2, 3];
  // Which temperament each mood favours (20,000 simulated nights; see the temperaments drawer).
  var FAVOURS = {
    boom: 'A boom favours greedy: it chases whatever rises.',
    slump: 'A slump favours cautious: it buys cheap and sells on the rebound.',
    blight: 'A blight favours loyal: only the staples hold.',
    wild: 'A wild night favours cautious; greedy goes broke one wild night in four.'
  };
  var GUIDE_KEY = 'clones.guide.done';
  var GUIDE = ['Read the omen', 'Pick your clones', 'Ring the bell', 'Make your calls', 'Dawn: the crown'];

  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  var town = null, guest = null, clonesNow = [], pollTimer = null, ringing = false, lastPrices = null;
  var units = {}; // short clone name -> { root, bub, coins, carry, worth }
  // Your calls tonight and what came of them: each whisper, the orders your clones placed, and the
  // dawn prices, so dawn can say what each call made or saved against holding to dawn.
  var callsTonight = [], myOrders = [], dawnPrices = null;
  // A whisper is for the hour the contract plays next: the pause's own hour, or, while this tab
  // rings, the hour after the last one it saw played.
  var pauseRound = null;
  function noteCall(cloneShort, w, label) {
    var r = pauseRound != null ? pauseRound : town ? (ringing ? town.round + 1 : town.round) : null;
    callsTonight.push({ clone: cloneShort, w: w, label: label, round: r });
  }
  function callsAtDawn() {
    var ul = $('callsNote'); ul.textContent = '';
    if (!callsTonight.length || !dawnPrices) { ul.hidden = true; return; }
    callsTonight.forEach(function (c) {
      var orders = myOrders.filter(function (o) { return o.clone === c.clone && o.round === c.round; });
      var line = 'Hour ' + (c.round + 1) + ', you told ' + c.clone + ' to ' + c.label + ': ';
      if (!c.w || !orders.length) {
        line += !c.w ? 'it did as it planned.' : c.w.do === 'buy' ? 'it could not afford any.' : c.w.do === 'sell_all' ? 'it held nothing to sell.' : 'it held, as told.';
      } else {
        var value = 0, what = orders.map(function (o) {
          var g = GOODS.indexOf(o.good), close = dawnPrices[g];
          value += o.side === 'sell' ? o.qty * (o.price - close) : o.qty * (close - o.price);
          return (o.side === 'sell' ? 'sold ' : 'bought ') + o.qty + ' ' + o.good + ' at ' + near(o.price) + ' NEAR (dawn: ' + near(close) + ')';
        }).join(', ');
        line += what + '. Against holding to dawn, that call ' + (value >= 0 ? 'made ' : 'cost ') + near(Math.abs(value)) + ' NEAR.';
      }
      ul.appendChild(el('li', null, line));
      cry(line, 'order-row');
    });
    ul.hidden = false;
  }
  var othersInTown = false; // other players' clones (not the regulars') in town: the bell can open a night
  var omenBefore = null, omenVerdict = ''; // the omen posted before this ring, and whether it came true
  var lastDusk = null; // {night, mood, verdict}: the night the verdict belongs to, so the omen box never mixes two nights

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
  // The pause between hours is only for the eye. In a hidden tab the browser may hold timers for up
  // to a minute each, which made a night rung from a background tab take a quarter of an hour, so
  // a hidden tab rings straight on.
  function beat(ms) { return document.hidden ? Promise.resolve() : sleep(ms); }
  var nudge = null; // wakes a watching tab at once when it is shown again
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- chain reads ---------- */
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function rpc(params, tried) {
    var host = RPCS[rpcAt % RPCS.length];
    return rpcOnce(host, params).catch(function (err) {
      if ((tried || 0) + 1 >= RPCS.length || /UNKNOWN|does not exist|MethodNotFound/i.test(String(err.message))) throw err;
      rpcAt += 1;
      return rpc(params, (tried || 0) + 1);
    });
  }
  function rpcOnce(host, params) {
    return fetch(host, {
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
  function viewAt(account, method, args) {
    return rpc({ request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64: b64(JSON.stringify(args || {})) })
      .then(function (res) { var text = new TextDecoder().decode(new Uint8Array(res.result)); return text ? JSON.parse(text) : null; });
  }
  // The town moved to this market on 13 November; seasons 1 to 3 were played at the first one.
  // Read its crowns and players live, so the page shows the town's whole history.
  var FIRST_MARKET = 'shroud.' + HOUSE;
  function loadHistory(nowRecent, nowSeason) {
    return Promise.all([viewAt(FIRST_MARKET, 'get_season', { from: 0, limit: 200 }), viewAt(FIRST_MARKET, 'get_recent', {})]).then(function (r) {
      var sz = r[0], recent = r[1] || [], first = {}, here = {};
      if (!sz) return;
      function isGuest(p) { var s = String(p).split('.')[0]; return !RIVAL_TITLES[s] && /^g[a-z0-9]{6}$/.test(s); }
      recent.forEach(function (x) { if (isGuest(x.player)) first[x.player] = 1; });
      (nowRecent || []).forEach(function (x) { if (isGuest(x.player) && !first[x.player]) here[x.player] = 1; });
      ((nowSeason && nowSeason.rows) || []).forEach(function (x) { if (isGuest(x[0]) && !first[x[0]]) here[x[0]] = 1; });
      function list(ch) { return (ch || []).slice().reverse().map(function (c) { return 'season ' + c.season + ', ' + nameOf(c.player) + ' (' + signed(c.net) + ')'; }).join('; '); }
      var nf = Object.keys(first).length, nh = Object.keys(here).length;
      var hereCrowns = list(nowSeason && nowSeason.champions);
      $('historyNote').textContent = '\u265B Season crowns. This market, since 13 November: ' + (hereCrowns || 'none yet') + '. The first market, 11 to 13 November: ' + list(sz.champions) + '. Its last six nights had ' + nf + ' guest accounts' + (nh ? ', and ' + nh + ' more ' + (nh === 1 ? 'has' : 'have') + ' played here since' : '') + '.';
      $('historyNote').hidden = false;
    }).catch(function () { /* the history line is optional */ });
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
      $('clockLabel').textContent = 'to the 02:00 UTC bell, or ring it now';
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
      li.appendChild(el('span', 'gprice', p != null ? near(p) : '--'));
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
    if (town) $('boardNote').textContent = (town.night ? (town.asleep ? 'after night ' : 'night ') + town.night + ', ' : '') + 'price per unit in NEAR, ' + (town.asleep ? 'next night\'s fee ' + pctOf(town.next_fee_bps || 200) + (town.next_fee_bps ? '' : ' unless the deed holder sets it') : 'fee ' + pctOf(town.fee_bps)) + '; arrows: change since the hour before; bars: the merchant\'s stock';
  }
  function pctOf(bps) { return ((Number(bps) || 200) / 100).toFixed(1).replace(/\.0$/, '') + '%'; }

  /* ---------- the guide: five steps through a first night ---------- */
  function guide(step, text, target) {
    var box = $('coach');
    if (stored(GUIDE_KEY) && step < 4) { box.hidden = true; return; }
    box.hidden = false;
    var ol = $('coachSteps'); ol.textContent = '';
    GUIDE.forEach(function (g, i) { ol.appendChild(el('li', i < step ? 'done' : i === step ? 'now' : '', (i + 1) + '. ' + g)); });
    $('coachText').textContent = text;
    document.querySelectorAll('.lit').forEach(function (n) { n.classList.remove('lit'); });
    if (target && $(target)) $(target).classList.add('lit');
  }
  function omenAdvice() {
    if (!town || !MOODS[town.omen]) return 'Each night has a mood, posted in advance as the omen.';
    var when = nightOn() ? 'A night is under way, so clones you send now play the one after. Its omen: ' : 'The omen for the coming night (the one the bell plays next): ';
    return when + MOODS[town.omen].name + '. ' + MOODS[town.omen].why + ' ' + FAVOURS[town.omen] + ' Omens lie three nights in ten.';
  }

  /* ---------- the race for the crown: every clone in play, by profit so far ---------- */
  function playerOfClone(id) { var s = String(id); return s.slice(s.indexOf('.') + 1); }
  function loadRace() {
    return view('get_state', {}).then(function (st) {
      var t = st[0], night = t.night;
      return st[1].filter(function (c) { return c[1].from_night <= night; }).map(function (c) {
        return { id: c[0], player: c[1].player || playerOfClone(c[0]), profit: c[1].worth - c[1].stake, broke: c[1].broke };
      }).sort(function (a, b) { return b.profit - a.profit || (a.id < b.id ? -1 : 1); });
    });
  }
  function paintRace(ol, rows) {
    ol.textContent = '';
    if (!rows.length) { ol.appendChild(el('li', 'muted', 'Nobody is trading yet.')); return; }
    var mineAt = -1; rows.forEach(function (r, i) { if (mineAt < 0 && r.player === guest) mineAt = i; });
    rows.forEach(function (r, i) {
      if (i > 2 && r.player !== guest) return;
      var li = el('li', r.player === guest ? 'mine' : '');
      li.appendChild(el('span', 'r-rank', (i === 0 ? '\u265B ' : '') + (i + 1) + '.'));
      li.appendChild(el('span', 'b-who', r.id.split('.')[0] + ' of ' + nameOf(r.player) + (r.broke ? ' (broke)' : '')));
      li.appendChild(el('span', 'b-num ' + (r.profit >= 0 ? 'gain' : 'loss'), signed(r.profit)));
      ol.appendChild(li);
    });
    if (mineAt > 0) ol.appendChild(el('li', 'muted', 'Yours is ' + ordinal(mineAt + 1) + ' of ' + rows.length + ', ' + near(rows[0].profit - rows[mineAt].profit) + ' NEAR behind the leader.'));
    else if (mineAt === 0) ol.appendChild(el('li', 'muted', 'You are leading for the crown.'));
  }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  var raceAt = 0;
  var raceOver = false;
  function refreshRace(force) {
    if (raceOver) return;
    if (!force && Date.now() - raceAt < 2500) return;
    raceAt = Date.now();
    loadRace().then(function (rows) { $('raceBox').hidden = false; paintRace($('raceRows'), rows); }).catch(function () { /* the race is optional */ });
  }
  function showOmen() {
    if (!town || !MOODS[town.omen]) return;
    var on = !town.asleep;
    var m = MOODS[on ? town.mood : town.omen];
    var past = lastDusk && lastDusk.night === town.night && MOODS[lastDusk.mood] ? lastDusk : null;
    $('omen').hidden = false;
    $('omenWhen').textContent = on ? 'night ' + town.night + '\'s mood (the omen for the night after: ' + MOODS[town.omen].name.toLowerCase() + ')' : 'the omen for night ' + (town.night + 1) + ', the one the bell plays next (omens lie three nights in ten)';
    $('omenMood').textContent = m.name;
    $('omenWhy').textContent = m.why + (on
      ? (past && past.verdict ? ' ' + past.verdict : '')
      : (past ? ' Night ' + past.night + ', just played, was ' + MOODS[past.mood].name.toLowerCase() + '.' : ''));
  }
  function loadTown() {
    return view('get_town', {}).then(function (t) {
      town = t;
      showOmen();
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
      var opts = ORDER.concat(['possessed']); if (i > 0) opts.push('none');
      opts.forEach(function (t) {
        var lab = el('label');
        var inp = el('input'); inp.type = 'radio'; inp.name = 'slot' + i; inp.value = t;
        if (t === (i === 2 ? 'possessed' : ORDER[i])) inp.checked = true;
        var dot = el('span', 'dot'); if (TEMPS[t]) dot.style.setProperty('--tint', TEMPS[t].tint);
        lab.appendChild(inp); lab.appendChild(dot); lab.appendChild(document.createTextNode(t === 'none' ? 'stay home' : t));
        pick.appendChild(lab);
      });
      pick.appendChild(el('span', 'why'));
      var knobs = el('div', 'knobs');
      knobs.appendChild(segmented('stake' + i, STAKES, 250, 'NEAR'));
      knobs.appendChild(segmented('nights' + i, NIGHTS.map(function (n) { return [n, String(n)]; }), 1, 'nights'));
      var ins = el('textarea', 'instr'); ins.rows = 2; ins.setAttribute('autocomplete', 'off'); ins.name = 'instr' + i; ins.maxLength = 160;
      ins.placeholder = 'Your instruction, e.g. buy amber when it falls, never all in';
      ins.value = 'Trade carefully and never risk more than half.';
      ins.setAttribute('aria-label', 'Instruction for clone-' + (i + 1));
      knobs.appendChild(ins);
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
      var item = { temperament: c.value, stake: st ? Number(st.value) : 500, nights: ni ? Number(ni.value) : 1 };
      if (c.value === 'possessed') item.instruction = (document.querySelector('[name="instr' + i + '"]') || {}).value || '';
      out.push(item);
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
      fs.querySelector('.instr').hidden = t !== 'possessed';
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
  /* ---------- Sign in with Google: one account on every device ---------- */
  var GOOGLE_KEY = 'clones.google';
  function googleSession() { try { return JSON.parse(stored(GOOGLE_KEY) || 'null'); } catch (e) { return null; } }
  // Signed in: a chip in the header on every town page, and on the send-in screen a line saying
  // where the clones will go. Sign out forgets the Google session and this browser's link to the
  // account; the account and its clones stay on chain, and signing in again finds them.
  function paintGoogle() {
    var g = googleSession();
    $('whoChip').hidden = !g;
    if ($('googleIn')) { $('googleIn').hidden = !g; $('googleOut').hidden = !!g; }
    if (!g) return;
    $('whoName').textContent = (g.name || 'Signed in') + ' \u00b7 ';
    $('whoChip').title = 'Signed in with Google: account ' + g.guest;
    $('googleWho').textContent = 'Signed in' + (g.name ? ' as ' + g.name : '') + ' with Google';
    $('googleNote').textContent = 'Your clones go into your own account, ' + g.guest.split('.')[0] + ', the same on every device. Sign out from the top of the page.';
  }
  function signOut() {
    var g = googleSession();
    store(GOOGLE_KEY, null);
    if (g && stored(STORE_KEY) === g.guest) store(STORE_KEY, null);
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ }
    location.href = 'town.html?new=1';
  }
  function onGoogle(resp) {
    $('googleOutNote').textContent = 'Checking your Google sign-in...';
    post('/api/google', { credential: resp.credential }).then(function (g) {
      store(GOOGLE_KEY, JSON.stringify({ guest: g.guest, token: g.token, name: g.name }));
      store('clones.token.' + g.guest, g.token);
      store(STORE_KEY, g.guest);
      if (g.inTown) { location.href = 'town.html?g=' + encodeURIComponent(g.guest); return; }
      paintGoogle();
      if (window.ClonesSound) ClonesSound.play('bell', { f: 262, vol: 0.12 });
    }).catch(function (err) { $('googleOutNote').textContent = err.message; });
  }
  function setupGoogle() {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (!cfg || !cfg.googleClientId) return;
      $('googleRow').hidden = false;
      paintGoogle();
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = function () {
        window.google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogle });
        window.google.accounts.id.renderButton($('googleBtn'), { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', logo_alignment: 'left', width: 260 });
      };
      document.head.appendChild(sc);
    }).catch(function () { /* no Google sign-in here */ });
  }
  function enlist(ev) {
    ev.preventDefault();
    var plan = chosen();
    if (!plan.length) return;
    $('sendBtn').disabled = true;
    $('statusError').hidden = true;
    var timer = showProgress();
    var gs = googleSession();
    (gs ? Promise.resolve(null) : makeKey().catch(function () { return null; })).then(function (key) {
      var req = gs ? { clones: plan, google: { guest: gs.guest, token: gs.token } } : key ? { clones: plan, publicKey: key.publicKey } : { clones: plan };
      return post('/api/enlist', req).then(function (res) {
        if (key && res.custody) store('clones.secret.' + res.guest, JSON.stringify({ account_id: res.guest, public_key: key.publicKey, private_key: key.secret }));
        return res;
      });
    }).then(function (res) {
      clearInterval(timer);
      $('barFill').style.width = '100%';
      $('progress').hidden = true;
      if (!validGuest(res.guest)) throw new Error('The town answered with an unexpected guest id.');
      store(STORE_KEY, res.guest);
      if (window.ClonesSound) ClonesSound.play('bell', { f: 196, vol: 0.2 });
      if (res.claim) { store('clones.claim.' + res.guest, res.claim); store('clones.token.' + res.guest, res.claim); }
      store('clones.txs.' + res.guest, JSON.stringify(res.txs || []));
      location.href = 'town.html?g=' + encodeURIComponent(res.guest) + '&fresh=1';
    }).catch(function (err) {
      clearInterval(timer);
      $('progress').hidden = true;
      $('sendBtn').disabled = false;
      if (/HTTP 50[234]|did not answer/.test(err.message)) setStatus('The town is busy', 'Lots of people are signing up at once and the test network is slow to answer. Wait a minute, then press Send again.', err.message);
      else setStatus('Nothing was sent', 'You can try again.', err.message);
    });
  }
  function showEnlist() {
    $('enlistForm').hidden = false;
    buildSlots();
    $('enlistForm').addEventListener('submit', enlist);
    setupGoogle();
    setStatus('Send your clones in', 'Pick a temperament, a stake and how many nights for each clone. Then ring the bell and watch them trade, or leave them to the nightly bell.');
    (town ? Promise.resolve(town) : loadTown()).then(function () { guide(0, omenAdvice(), 'omen'); }).catch(function () { /* no omen yet */ });
    $('slots').addEventListener('change', function () { guide(1, 'Each clone gets a temperament, a stake and a number of nights. When you are happy, send them in.', 'sendBtn'); });
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
      if (s) purse.appendChild(actsFor(c));
      if (s) {
        var run = el('button', 'btn small run', 'Try to run');
        run.type = 'button';
        run.title = 'This clone tries to run off with the NEAR on its own account.';
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
  function token() { return stored('clones.token.' + guest) || stored('clones.claim.' + guest); }
  function actsFor(c) {
    var box = el('div', 'acts'), s = c.state, short = c.id.split('.')[0];
    if (!token()) return box;
    var during = town && !town.asleep;
    if (during) {
      if (s.whispers_left === 0) {
        box.appendChild(el('div', 'whisper-note', 'no whispers left tonight'));
        return box;
      }
      var sel = el('select'); sel.setAttribute('aria-label', 'Whisper to ' + short);
      [['', 'whisper, next hour only (' + (s.whispers_left != null ? s.whispers_left : 3) + ' left)'], ['hold', 'hold this hour'], ['sell_all', 'sell everything']].concat(GOODS.map(function (g) { return ['buy:' + g, 'buy ' + g]; }))
        .forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; sel.appendChild(op); });
      sel.addEventListener('change', function () {
        if (!sel.value) return;
        var parts = sel.value.split(':'), w = parts[0] === 'buy' ? { do: 'buy', good: parts[1] } : { do: parts[0] };
        sel.disabled = true;
        post('/api/whisper', { guest: guest, token: token(), clone: c.id, whisper: w }).then(function () {
          cry('You whispered to ' + short + ': ' + sel.options[sel.selectedIndex].text + '. It obeys in the coming hour.', 'order-row');
          noteCall(short, w, sel.options[sel.selectedIndex].text);
          if (window.ClonesSound) ClonesSound.play('whisper');
          var left = (s.whispers_left != null ? s.whispers_left : 3) - 1; s.whispers_left = left;
          var said = sel.options[sel.selectedIndex].text;
          var fresh = actsFor(c); box.replaceWith(fresh);
          fresh.insertBefore(el('div', 'whisper-note', 'sent: ' + said), fresh.firstChild);
        }).catch(function (err) { sel.disabled = false; cry(short + ': ' + err.message, 'warn'); });
      });
      box.appendChild(sel);
    } else if (s.from_night <= (town ? town.night : 0) && !s.due_home) {
      var rt = el('select'); rt.setAttribute('aria-label', 'Retrain ' + short);
      [['', 'retrain...']].concat(ORDER.filter(function (t) { return t !== s.temperament; }).map(function (t) { return [t, 'make it ' + t]; }))
        .forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; rt.appendChild(op); });
      rt.addEventListener('change', function () {
        if (!rt.value) return;
        rt.disabled = true;
        post('/api/retrain', { guest: guest, token: token(), clone: c.id, temperament: rt.value }).then(function () {
          cry(short + ' is ' + rt.value + ' from the next night.', 'order-row'); loadGuest(true);
        }).catch(function (err) { rt.disabled = false; cry(short + ': ' + err.message, 'warn'); });
      });
      box.appendChild(rt);
      var home = el('button', 'btn small', 'Bring home now'); home.type = 'button';
      home.addEventListener('click', function () {
        home.disabled = true; home.textContent = 'Coming home...';
        post('/api/recall', { guest: guest, token: token(), clone: c.id }).then(function (res) {
          (res.events || []).forEach(function (e) { var line = describe(e); if (line) cry(line); });
          loadGuest(true);
        }).catch(function (err) { home.disabled = false; home.textContent = 'Bring home now'; cry(short + ': ' + err.message, 'warn'); });
      });
      box.appendChild(home);
    }
    return box;
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
      u.worth.textContent = 'stake ' + near(s.stake) + ', worth ' + near(s.worth) + ' · ' + (s.due_home || !left ? 'coming home' : left + (left === 1 ? ' night' : ' nights') + ' left');
    } else {
      u.worth.textContent = r ? 'came home with ' + near(r.paid_out) + ' (stake ' + near(r.stake) + ')' : 'not in town';
    }
    u.root.classList.toggle('broke', !!(s && s.broke));
  }
  function say(short, text, alarm, whispered) {
    var u = units[short]; if (!u) return;
    u.bub.textContent = text;
    u.bub.classList.add('on');
    u.bub.classList.toggle('alarm', !!alarm);
    u.bub.classList.toggle('whispered', !!whispered);
  }
  function sayAi(short, on) { var u = units[short]; if (u) u.bub.classList.toggle('ai', !!on); }
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
    if (window.ClonesSound) ClonesSound.play('chains');
    $('refusalErr').textContent = 'the leash held';
    $('refusalWhy').textContent = short + ' tried to run off with its purse. It can trade at the market and do nothing else, so it went nowhere. Not a coin left it.';
    $('refusalRaw').textContent = 'Not our code: NEAR itself refused. The clone\'s only key can call "trade" at the market, so the chain rejects any transfer before it reaches a block (' + (/RequiresFullAccess/.test(e) ? 'InvalidAccessKeyError: RequiresFullAccess' : e.split(':')[0]) + ').';
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
      say(short, 'The leash held. Back to the counter, then.', false);
      cry(short + ' tried to run with its purse. The leash held.', 'refused-row');
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
      case 'order': return e.clone + ' ' + (e.side === 'buy' ? 'bought ' : 'sold ') + e.qty + ' ' + e.good + ' at ' + near(e.price) + ' NEAR';
      case 'order_failed': return e.clone + ': a turn did not clear';
      case 'withdraw_refused': return e.clone + ' went broke and tried to run with what was left. The leash held.';
      case 'settled': return e.clone + ' settled: paid out ' + near(e.paid_out) + ' NEAR' + (e.broke ? ' (broke)' : '');
      case 'merged': return e.clone + ' came home and handed over everything it had';
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
        if (town) {
          town.round = e.round != null ? e.round : 0; town.asleep = e.round >= town.rounds; if (out.night) town.night = out.night;
          if (e.mood) { town.mood = e.mood; town.omen = e.omen; }
          showOmen();
        }
        buildBoard(e.prices, e.stock);
        if (e.kind === 'dusk' && MOODS[e.mood]) {
          if (e.omen_was) omenBefore = e.omen_was;
          omenVerdict = omenBefore && MOODS[omenBefore] ? 'The omen for night ' + e.night + ' said ' + MOODS[omenBefore].name.toLowerCase() + (omenBefore === e.mood ? ', and it came true.' : ', but it lied: night ' + e.night + ' was ' + MOODS[e.mood].name.toLowerCase() + '.') : '';
          lastDusk = { night: e.night, mood: e.mood, verdict: omenVerdict };
          var said = omenBefore && MOODS[omenBefore] ? (omenBefore === e.mood ? ' The omen said ' + MOODS[omenBefore].name.toLowerCase() + ', and it came true.' : ' The omen said ' + MOODS[omenBefore].name.toLowerCase() + ': it lied.') : '';
          showOmen();
          cry('Dusk, night ' + e.night + '. The mood tonight: ' + MOODS[e.mood].name + '. ' + MOODS[e.mood].why + said, said && omenBefore !== e.mood ? 'refused-row' : '');
          omenBefore = null; // used once: a later night must bring its own
        }
        if (e.kind === 'dusk' && e.night > 1 && (e.night - 1) % 7 === 0) {
          view('get_season', { from: 0, limit: 1 }).then(function (sz) {
            var ch = (sz && sz.champions || []).slice(-1)[0];
            if (!ch) return;
            var li = cry('\u265B Season ' + ch.season + ' is over. The season crown goes to ' + nameOf(ch.player) + ', ' + signed(ch.net) + ' NEAR over seven nights. Season ' + sz.season + ' starts tonight.', ch.player === guest ? 'order-row season-row' : 'season-row');
            guide(3, 'Season ' + ch.season + ' is over: ' + nameOf(ch.player) + ' takes the season crown. A new season starts tonight, and everyone starts level.', 'raceBox');
            return li;
          }).catch(function () { /* the season line is optional */ });
        }
        if (e.kind === 'dusk' && e.fee_bps) { if (town) town.fee_bps = e.fee_bps; cry('The merchant takes ' + pctOf(e.fee_bps) + ' of every trade tonight' + (e.fee_bps === 200 ? '.' : ', as the deed holder set it.'), 'muted'); }
      }
    });
    if (window.ClonesSound) out.events.forEach(function (e) {
      if (e.kind === 'crowned') ClonesSound.event('crowned', { mine: e.player === guest });
      else if (e.kind !== 'withdraw_refused') ClonesSound.event(e.kind, e);
    });
    out.events.forEach(function (e) {
      if (e.kind === 'rival') cry(cap(e.title) + ' sends clones into town.', 'muted');
      if (e.kind === 'fee') cry(cap(e.title) + ' holds the merchant\'s deed and sets tonight\'s fee at ' + pctOf(e.bps) + '.', 'muted');
      if (e.kind === 'deed') cry('Dawn: the merchant\'s deed pays ' + (e.player === guest ? 'you' : nameOf(e.player)) + ' a quarter of the night\'s fees: ' + near(e.share) + ' NEAR.', e.player === guest ? 'order-row' : 'muted');
      if (e.kind === 'crowned') {
        var whose = e.player === guest ? 'yours' : nameOf(e.player);
        if (omenVerdict) cry('Dawn. ' + omenVerdict, 'muted');
        raceOver = true;
        Array.prototype.forEach.call($('raceRows').querySelectorAll('li.muted'), function (n) { n.remove(); });
        // The list is the race as of the last hour; the contract crowns on dawn's prices, so name the
        // winner at the top and take the crown mark off whoever was leading an hour ago.
        $('raceRows').textContent = ''; // the hour-by-hour race is over; the ledger below has each clone's result
        var top = el('li', e.player === guest ? 'mine crowned' : 'crowned');
        top.appendChild(el('span', 'r-rank', '\u265B'));
        top.appendChild(el('span', 'b-who', e.clone + ' of ' + nameOf(e.player) + ': the crown, on dawn\'s prices'));
        top.appendChild(el('span', 'b-num gain', '+' + near(e.pot) + ' fees'));
        $('raceRows').insertBefore(top, $('raceRows').firstChild);
        $('raceRows').appendChild(el('li', 'muted', 'Dawn: the contract valued every clone at dawn\'s prices and crowned ' + e.clone + ' of ' + nameOf(e.player) + ', with the night\'s fees on top. Each of your clones\' result is in the morning ledger.'));
        $('crownNote').textContent = 'Last crown: ' + e.clone + ' of ' + nameOf(e.player) + ', night ' + (town ? town.night : '') + ', ' + near(e.pot) + ' NEAR of fees.';
        $('deedNote').textContent = 'The merchant\'s deed: ' + nameOf(e.player) + ' for the next night.';
        guide(4, (omenVerdict ? omenVerdict + ' ' : '') + (e.player === guest
          ? 'Dawn, and the crown is yours: ' + e.clone + ' made the biggest profit in NEAR of any clone in town and takes the night\'s fees. You hold the merchant\'s deed: set the next night\'s fee and name a good to restock.'
          : 'Dawn. The crown (the night\'s fees, to the one clone with the biggest profit in NEAR) went to ' + e.clone + ' of ' + nameOf(e.player) + ', who now holds the merchant\'s deed: the next night\'s fee and a restock. Ring again for the next night.'), e.player === guest ? 'deedCard' : 'morning');
        store(GUIDE_KEY, '1');
        cry('Dawn: ' + e.clone + ' (' + whose + ') takes the crown: the night\'s fees after the deed\'s quarter, ' + near(e.pot) + ' NEAR.', e.player === guest ? 'order-row' : 'muted');
      }
    });
    out.events.forEach(function (e) { if (e.kind === 'hour' && town && e.round >= town.rounds) dawnPrices = e.prices; });
    mine.forEach(function (e) {
      if (e.kind === 'order') myOrders.push({ clone: e.clone, round: e.round, side: e.side, qty: e.qty, good: e.good, price: e.price });
      if (e.kind === 'bubble' && units[e.clone]) { say(e.clone, e.say, /broke/.test(e.say), e.whispered); sayAi(e.clone, e.ai); }
      var line = describe(e);
      if (line) cry(line, e.kind === 'withdraw_refused' ? 'refused-row' : e.kind === 'order' ? 'order-row' : '');
      if (e.kind === 'withdraw_refused') showRefusal(e.clone, e.error);
      if (e.kind === 'merged' && units[e.clone]) { units[e.clone].root.classList.add('gone'); }
    });
    if (others) cry(others + ' order' + (others === 1 ? '' : 's') + ' from other guests\' clones this hour', 'muted');
    if (out.phase === 'dawn') {
      if (!dawnPrices && town && town.prices) dawnPrices = town.prices;
      callsAtDawn();
      $('verdict').hidden = false;
      $('verdict').className = 'result-key ' + (out.matched ? 'yes' : 'no');
      $('verdict').textContent = out.matched
        ? 'Audit passed: ' + (out.audited || 0) + ' orders replayed from chain state. Every clone did what its temperament or your whisper said, and every price, fee and payout is what the rules say.'
        : 'Audit failed: the chain and the rules disagree. Details in the console.';
      if (!out.matched) console.warn('audit', out.problems, out.verdict);
      var more = el('a', null, ' What it checked');
      more.href = '#proof'; $('verdict').appendChild(more);
      $('auditHint').textContent = out.matched ? 'tonight: passed, ' + (out.audited || 0) + ' orders' : 'tonight: FAILED';
      $('auditLast').textContent = out.matched
        ? 'Tonight (night ' + (town ? town.night : '?') + '): passed. ' + (out.audited || 0) + ' orders replayed, no differences.'
        : 'Tonight: failed. ' + (out.problems || []).slice(0, 5).join('; ');
    }
    tickClock();
  }
  // Someone else is ringing this night: follow it from the chain instead of driving it too (many
  // bells at once slow the night down and race each other). Resolves 'done' at dawn, or 'stalled'
  // if no hour has been rung for 60 seconds (longer than any call), so this tab can carry the night on itself.
  function followNight() {
    var seen = town ? town.round : -1, at = Date.now();
    setStatus('A night is under way', 'Another player is ringing it, so you are watching it from the chain. Whisper under a clone\'s purse to steer it: a whisper is for the next hour only.');
    guide(2, 'Someone else rang the bell, so you are watching this night from the chain. Whisper under your clones to steer them, for the next hour only.', 'raceBox');
    return new Promise(function (resolve) {
      var timer = null;
      (function tick() {
        nudge = function () { clearTimeout(timer); tick(); };
        loadTown().then(function (t) {
          if (t.round !== seen) {
            if (t.round > seen && seen >= 0) cry('Hour ' + Math.min(t.round + 1, t.rounds) + ' rings (another player\'s bell).', 'muted');
            seen = t.round; at = Date.now();
            refreshMine(); refreshRace(true);
            if (window.ClonesSound) ClonesSound.event('hour', { round: t.round });
          }
          $('bellBtn').textContent = 'Watching: night ' + t.night + ', hour ' + Math.min(t.round + 1, t.rounds) + ' of ' + t.rounds;
          if (t.asleep) { nudge = null; return resolve('done'); }
          if (Date.now() - at > 60000 && !document.hidden) { nudge = null; return resolve('stalled'); }
          timer = setTimeout(tick, document.hidden ? 6000 : 2000);
        }).catch(function () { timer = setTimeout(tick, 4000); });
      })();
    });
  }
  function ringBell() {
    if (ringing) return;
    ringing = true;
    var btn0 = $('bellBtn');
    btn0.disabled = true;
    loadTown().catch(function () { return null; }).then(function () {
      if (!nightOn()) return 'drive';
      return followNight().then(function (how) { return how === 'stalled' ? 'drive' : 'done'; });
    }).then(function (how) {
      if (how === 'drive') return driveBell();
      ringing = false;
      btn0.disabled = false;
      btn0.textContent = 'Ring the bell: play the next night';
      loadGuest(true);
      setTimeout(function () { if (!ringing) loadGuest(true); }, 4000);
    });
  }
  function driveBell() {
    var btn = $('bellBtn');
    btn.disabled = true;
    $('refusal').hidden = true;
    $('crier').textContent = '';
    $('crier').hidden = false;
    var opened = false, tries = 0, paused = {};
    omenBefore = town && town.asleep ? town.omen : null; omenVerdict = ''; raceOver = false;
    callsTonight = []; myOrders = []; dawnPrices = null;
    cry('The bell rings. Clones that are due come home first, then the regulars arrive; the first hour starts in a few seconds.', 'muted');
    btn.textContent = 'Ringing...';
    setStatus('The bell is ringing', 'Bringing home any clones that are due, then letting the regulars in. The first hour starts in a few seconds; after that, one hour every few seconds.');
    guide(2, 'The night is on. Watch the race for the crown: the bell holds for your call every two hours, and you can whisper under a clone at any hour (three whispers per clone a night).', 'raceBox');
    function step() {
      return post('/api/bell', { start: !opened }).then(function (out) {
        tries = 0;
        if (out.phase === 'dusk' || out.phase === 'hour' || out.phase === 'dawn') opened = true;
        handleStep(out);
        if (out.phase === 'hour' || out.phase === 'dusk') refreshRace(out.phase === 'dusk');
        if (out.phase === 'dusk') loadGuest(true);
        btn.textContent = out.phase === 'dawn' ? 'Dawn: bringing them home' : out.phase === 'home' ? 'Home' : 'Night ' + out.night + ', hour ' + Math.min(out.round + 1, 12) + ' of 12';
        return refreshMine().then(function () {
          if (out.phase === 'empty') { setStatus('The town is empty', 'There are no clones in town to play a night with.'); return 'stop'; }
          if (out.phase === 'waiting' || (out.phase === 'home' && !out.next)) return 'stop';
          var playing = clonesNow.some(function (c) { return c.state && c.state.from_night <= (town ? town.night : 0); });
          if (out.phase === 'hour' && out.round > 0 && out.round % 2 === 0 && out.round < 12 && !paused[out.round] && playing && token()) {
            paused[out.round] = true;
            return waitForPlayer(out.round).then(step);
          }
          if (out.phase === 'home') setStatus('The regulars are coming', 'Last night\'s clones are home. The Widow, the Abbot and the Hound are sending clones in; the night opens in a few seconds.');
          return beat(reduceMotion ? 200 : 900).then(step);
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
      // RPC nodes lag a few blocks behind the dawn transactions: read again so the crown, the
      // deed and the morning ledger show this night, not the last.
      setTimeout(function () { if (!ringing) loadGuest(true); }, 4000);
      setTimeout(function () { if (!ringing) loadGuest(true); }, 12000);
    });
  }

  var RIVAL_TITLES = { widow: 'the Widow', abbot: 'the Abbot', hound: 'the Hound' };
  function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
  function nameOf(player) {
    var short = String(player).split('.')[0];
    return player === guest ? 'you' : RIVAL_TITLES[short] || short;
  }

  // Every two hours (five times a night) the bell waits for your call: the race for the crown, and each of
  // your clones' plan for the coming hour, with a whisper to change it. Each clone has three whispers a night,
  // so when to spend them is the choice. It rings on by itself after 25 seconds; any choice buys a little more time.
  function whisperTo(cloneShort, w, label, li) {
    var c = clonesNow.filter(function (x) { return x.id.split('.')[0] === cloneShort; })[0];
    if (!c || !token()) return Promise.resolve();
    li.querySelectorAll('button, select').forEach(function (b) { b.disabled = true; });
    var note = el('div', 'whisper-note', 'Telling ' + cloneShort + ': ' + label + '...');
    li.appendChild(note);
    return post('/api/whisper', { guest: guest, token: token(), clone: c.id, whisper: w }).then(function () {
      if (c.state && c.state.whispers_left != null) c.state.whispers_left -= 1;
      var wl = li.querySelector('.whisper-left');
      if (wl && c.state) wl.textContent = 'next hour only · ' + c.state.whispers_left + (c.state.whispers_left === 1 ? ' whisper' : ' whispers') + ' left tonight';
      li.classList.add('decided');
      if (window.ClonesSound) ClonesSound.play('whisper');
      noteCall(cloneShort, w, label);
      note.textContent = 'You told ' + cloneShort + ': ' + label + '. It obeys this hour; after that it goes back to its own way.';
      var u = units[cloneShort], old = u && u.root.querySelector('.acts');
      if (old) old.replaceWith(actsFor(c));
      decidedOne();
      cry('You whispered to ' + cloneShort + ': ' + label + '.', 'order-row');
    }).catch(function (err) {
      li.querySelectorAll('button, select').forEach(function (b) { b.disabled = false; });
      note.textContent = err.message;
    });
  }
  var decidedOne = function () {};
  function waitForPlayer(round) {
    pauseRound = round;
    var card = $('pauseCard'), list = $('planList');
    list.textContent = '';
    list.appendChild(el('li', null, 'Reading the board...'));
    $('pauseTitle').textContent = 'Your call: hour ' + (round + 1) + ' of 12';
    if (window.ClonesSound) ClonesSound.play('bell', { f: 147, vol: 0.2 });
    card.hidden = false;
    guide(3, 'The bell holds for your call. Check the race; whisper to a clone to change its next move, or let it be.', 'pauseCard');
    if (!reduceMotion) card.scrollIntoView({ block: 'center' });
    loadRace().then(function (rows) { paintRace($('pauseRace'), rows); }).catch(function () { $('pauseRace').textContent = ''; });
    var left = 25, tick;
    post('/api/peek', { guest: guest }).then(function (res) {
      list.textContent = '';
      (res.plans || []).forEach(function (p) {
        var li = el('li');
        li.appendChild(el('b', null, p.clone + ': '));
        li.appendChild(document.createTextNode(p.say + ' '));
        var c = clonesNow.filter(function (x) { return x.id.split('.')[0] === p.clone; })[0];
        if (p.orders && p.orders.length) li.appendChild(el('code', null, p.orders.join('; ')));
        else if (c && c.state && c.state.temperament === 'possessed') li.appendChild(el('code', null, 'its AI decides when the hour rings: it may buy, sell or hold'));
        else if (c && c.state) {
          var held = (c.state.stock || []).map(function (q, g) { return q ? q + ' ' + GOODS[g] : null; }).filter(Boolean);
          li.appendChild(el('code', null, 'no order this hour; it holds ' + near(c.state.cash) + ' NEAR in cash' + (held.length ? ' and ' + held.join(', ') : '')));
        }
        var wl = c && c.state && c.state.whispers_left != null ? c.state.whispers_left : 3;
        if (token() && wl > 0) {
          var row = el('div', 'choices');
          [['Let it', null], ['Hold', { do: 'hold' }], ['Sell all', { do: 'sell_all' }]].forEach(function (o) {
            var b = el('button', 'btn small' + (o[1] ? '' : ' ghost'), o[0]); b.type = 'button';
            b.addEventListener('click', function () {
              left = Math.max(left, 15);
              if (!o[1]) {
                li.classList.add('decided'); row.querySelectorAll('button, select').forEach(function (x) { x.disabled = true; });
                li.appendChild(el('div', 'whisper-note', p.clone + ' does what it planned.'));
                noteCall(p.clone, null, 'carry on');
                decidedOne(); return;
              }
              whisperTo(p.clone, o[1], o[0].toLowerCase(), li);
            });
            row.appendChild(b);
          });
          var buy = el('select'); buy.setAttribute('aria-label', 'Tell ' + p.clone + ' to buy');
          [['', 'Buy...']].concat(GOODS.map(function (g) { return [g, 'buy ' + g]; })).forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; buy.appendChild(op); });
          buy.addEventListener('change', function () { if (buy.value) { left = Math.max(left, 15); buy.disabled = true; whisperTo(p.clone, { do: 'buy', good: buy.value }, 'buy ' + buy.value, li); } });
          row.appendChild(buy);
          row.appendChild(el('span', 'whisper-left', 'next hour only · ' + wl + (wl === 1 ? ' whisper' : ' whispers') + ' left tonight'));
          li.appendChild(row);
        } else if (wl === 0) {
          li.appendChild(el('div', 'whisper-note', 'no whispers left tonight'));
        }
        list.appendChild(li);
      });
      if (!res.plans || !res.plans.length) list.appendChild(el('li', null, 'None of your clones is trading tonight.'));
      decidedOne = function () {
        var open = Array.prototype.filter.call(list.children, function (li) { return li.querySelector('.choices') && !li.classList.contains('decided'); });
        if (!open.length) { left = Math.min(left, 2); $('pauseCount').textContent = 'every clone has its call; ringing on'; }
      };
    }).catch(function () { list.textContent = ''; list.appendChild(el('li', null, 'Could not read the plans; ring on, or whisper under a clone.')); });
    return new Promise(function (resolve) {
      var go = function () { decidedOne = function () {}; pauseRound = null; card.hidden = true; $('carryOn').removeEventListener('click', go); clearInterval(tick); if (!reduceMotion) $('guestClones').scrollIntoView({ block: 'nearest' }); guide(3, 'The night rings on. Every two hours the bell holds for your call, and each clone has three whispers a night.', 'raceBox'); resolve(); };
      $('pauseCount').textContent = 'rings on in ' + left + 's';
      // Count real seconds, not ticks: a hidden tab's timer may fire once a minute.
      var last = Date.now();
      tick = setInterval(function () { var now = Date.now(); left -= Math.max(1, Math.round((now - last) / 1000)); last = now; $('pauseCount').textContent = 'rings on in ' + Math.max(0, left) + 's'; if (left <= 0) go(); }, 1000);
      $('carryOn').addEventListener('click', go);
    });
  }

  /* ---------- after dawn ---------- */
  function renderMorning(rows) {
    var latest = rows.reduce(function (m, r) { return Math.max(m, Number(r.night) || 0); }, 0);
    var night = rows.filter(function (r) { return (Number(r.night) || 0) === latest; });
    $('morning').hidden = false;
    var moodNote = town && town.chain_dice ? '' : ', seed ' + (night[0] ? night[0].seed : '?');
    $('morningSub').textContent = 'Night ' + latest + moodNote + '. Read from the market contract: stake against what each clone paid out when it came home.';
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
      if (town && town.crowned && town.crowned[0] === r.clone && Number(town.crowned[2]) === Number(r.night)) {
        num.appendChild(el('br'));
        num.appendChild(el('small', null, 'trading ' + signed(diff - town.crowned[1]) + ', crown ' + signed(town.crowned[1])));
      }
      li.appendChild(num);
      ul.appendChild(li);
      stake += Number(r.stake); paid += Number(r.paid_out);
    });
    var still = clonesNow.filter(function (c) { return c.state; }).length;
    $('morningTotal').textContent = 'Clones that came home: ' + near(stake) + ' NEAR sent in, ' + near(paid) + ' NEAR came home (' + signed(paid - stake) + ').' +
      (still ? ' ' + still + (still === 1 ? ' clone is' : ' clones are') + ' still in town and not counted yet.' : '') +
      (night.some(function (r) { return r.broke; }) ? ' A broke clone tried to run with what was left at dawn. The leash held.' : '');
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
  // The season: every player's net over the clones they settled this season, and past champions.
  function loadSeason() {
    return Promise.all([view('get_season', { from: 0, limit: 200 }), town ? Promise.resolve(town) : loadTown(), view('get_state', {}).catch(function () { return null; })]).then(function (both) {
      var sz = both[0], open = {};
      if (both[2]) both[2][1].forEach(function (c) { var pl = c[1].player || playerOfClone(c[0]); open[pl] = (open[pl] || 0) + (c[1].worth - c[1].stake); });
      if (!sz) return;
      $('townBoard').hidden = false;
      var left = Math.max(0, sz.ends_night - (town ? town.night : 0));
      $('seasonTitle').textContent = 'Season ' + sz.season + ' at this market: standings';
      $('seasonNote').textContent = 'Nights ' + sz.started_night + ' to ' + sz.ends_night + (left ? ', ' + left + (left === 1 ? ' night' : ' nights') + ' left' : ', the last night') + '. Net is what came home less what was staked, over every clone that has come home this season; "out now" is how the clones still in town stand. At the first dusk after the last night, the best net takes the season crown.';
      var st = $('standRows'); st.textContent = '';
      var listed = {}; sz.rows.forEach(function (r) { listed[r[0]] = true; });
      Object.keys(open).forEach(function (pl) { if (!listed[pl]) sz.rows.push([pl, { net: 0, staked: 0, clones: 0, crowns: 0, fresh: true }]); });
      sz.rows.map(function (r) { return { player: r[0], row: r[1] }; })
        .sort(function (a, b) { return b.row.net - a.row.net || b.row.crowns - a.row.crowns; })
        .slice(0, 15).forEach(function (p, i) {
          var li = el('li', p.player === guest ? 'mine' : '');
          li.appendChild(el('span', 'b-who', (i === 0 && !p.row.fresh ? '\u265B ' : '') + cap(nameOf(p.player)) + (p.row.fresh || !p.row.clones ? ' (' + (p.row.crowns ? p.row.crowns + (p.row.crowns === 1 ? ' crown, ' : ' crowns, ') : '') + 'clones still in town)' : ' (' + p.row.clones + (p.row.clones === 1 ? ' clone' : ' clones') + ' home' + (p.row.crowns ? ', ' + p.row.crowns + (p.row.crowns === 1 ? ' crown' : ' crowns') : '') + ')')));
          li.appendChild(el('span', 'b-num ' + (p.row.net >= 0 ? 'gain' : 'loss'), signed(p.row.net)));
          li.appendChild(el('span', 'b-det', (p.row.staked ? near(p.row.staked) + ' staked' : '') + (open[p.player] != null ? (p.row.staked ? ', ' : '') + 'out now ' + signed(open[p.player]) : '')));
          st.appendChild(li);
        });
      if (!sz.rows.length) st.appendChild(el('li', 'muted', 'Nobody has come home yet this season.'));
      // This market's season crowns go in the one history line at the top of the board (loadHistory).
      $('champNote').textContent = '';
      return view('get_recent', {}).then(function (rows) { return loadHistory(rows, sz); });
    }).catch(function () { /* older markets have no season */ });
  }
  function loadBoard() {
    loadSeason();
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
        who.appendChild(document.createTextNode(String(r.clone).split('.')[0] + ' of ' + nameOf(r.player)));
        li.appendChild(who);
        var pct = Math.round((r.paid_out - r.stake) * 100 / r.stake);
        li.appendChild(el('span', 'b-num ' + (pct >= 0 ? 'gain' : 'loss'), (pct >= 0 ? '+' : '') + pct + '%'));
        li.appendChild(el('span', 'b-det', near(r.stake) + ' → ' + near(r.paid_out) + ', ' + r.nights_played + 'n' + (r.broke ? ', broke' : '')));
        ol.appendChild(li);
      });
      if (town && town.deed) $('deedNote').textContent = 'The merchant\'s deed: ' + nameOf(town.deed) + ' (a quarter of tonight\'s fees at dawn' + (town.restock_order ? '; ordered a full restock of ' + town.restock_order : '') + (town.next_fee_bps ? '; set the next night\'s fee at ' + pctOf(town.next_fee_bps) : '') + ').';
      showDeed();
      if (town && town.crowned) {
        $('crownNote').textContent = 'Last crown: ' + String(town.crowned[0]).split('.')[0] + ' of ' + nameOf(String(town.crowned[0]).slice(String(town.crowned[0]).indexOf('.') + 1)) + ', night ' + town.crowned[2] + ', ' + near(town.crowned[1]) + ' NEAR of fees.';
      }
    }).catch(function () { /* the board is optional */ });
  }
  // The deed holder's moment: set the next night's fee and name a restock.
  var FEES = [[50, '0.5%'], [100, '1%'], [150, '1.5%'], [200, '2%'], [250, '2.5%'], [300, '3%']];
  function showDeed() {
    var holder = !!(town && guest && town.deed === guest && town.asleep && token());
    $('deedCard').hidden = !holder;
    if (!holder) return;
    var box = $('feeButtons'); box.textContent = '';
    var current = Number(town.next_fee_bps) || 0;
    FEES.forEach(function (f) {
      var b = el('button', 'btn small' + (f[0] === current ? ' picked' : ' ghost'), f[1] + (f[0] === 200 ? ' (usual)' : '') + (f[0] === current ? ' \u2713 set' : '')); b.type = 'button';
      b.addEventListener('click', function () {
        box.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
        post('/api/setfee', { guest: guest, token: token(), bps: f[0] }).then(function () {
          town.next_fee_bps = f[0];
          cry('You set the next night\'s fee at ' + f[1] + '.', 'order-row');
          if (window.ClonesSound) ClonesSound.play('coin', { n: 4 });
          showDeed();
        }).catch(function (err) { box.querySelectorAll('button').forEach(function (x) { x.disabled = false; }); $('deedDone').textContent = err.message; });
      });
      box.appendChild(b);
    });
    if (town.restock_order) { $('restockSel').value = town.restock_order; }
    var done = [];
    if (current) done.push('The merchant takes ' + pctOf(current) + ' of every trade next night, and a quarter of it is yours at dawn.');
    if (town.restock_order) done.push('He restocks ' + town.restock_order + ' in full at dusk.');
    $('deedDone').textContent = done.length ? 'Set: ' + done.join(' ') : '';
    var someoneIn = othersInTown || clonesNow.some(function (c) { return c.state; });
    if (!someoneIn) $('deedDone').textContent += (done.length ? ' ' : '') + 'Nobody has clones in town yet, so your choices wait for the next night: it opens when anyone sends clones in and rings. To play it yourself, send in a new set.';
    guide(4, 'You took the crown. You hold the merchant\'s deed: set the next night\'s fee and name a restock. They apply when the next night opens.', 'deedCard');
  }
  // Try to break the leash: six ways out, each a real transaction the chain refuses.
  var BREAK_WAYS = [
    ['transfer', 'Send its NEAR to you', 'a transfer needs a full-access key'],
    ['deposit', 'Attach NEAR to its trade', 'a function-call key may not attach a deposit'],
    ['other_contract', 'Call a different contract', 'the key names one contract: the market'],
    ['other_method', 'Call settle instead of trade', 'the key names one method: trade'],
    ['add_key', 'Give itself a full-access key', 'adding a key needs a full-access key'],
    ['delete_to_stranger', 'Delete itself, everything to a stranger', 'deleting an account needs a full-access key']
  ];
  function renderBreak(list) {
    var mine = list.filter(function (c) { return c.state; });
    var sel = $('breakClone'), box = $('breakButtons');
    sel.textContent = ''; box.textContent = '';
    if (!mine.length) {
      // No clones of your own in town: try it on another player's. Every way out is refused by NEAR
      // before it reaches a block, so it changes nothing for them and costs nothing.
      sel.disabled = true;
      box.appendChild(el('p', 'sub', 'Reading the town for a clone to try...'));
      view('get_state', {}).then(function (st) {
        var others = ((st && st[1]) || []).filter(function (c) { return /^clone-[123]\.g[a-z0-9]{6}\./.test(c[0]) && c[0].indexOf('.' + guest) < 0; });
        if (!others.length) { box.textContent = ''; box.appendChild(el('p', 'sub', guest ? 'None of your clones is in town right now. Send some in to try this.' : 'Send clones in, then try this.')); return; }
        renderBreak(others.map(function (c) { return { id: c[0], temperament: c[1].temperament, state: c[1], other: true }; }));
      }).catch(function () { box.textContent = ''; box.appendChild(el('p', 'sub', 'Send clones in, then try this.')); });
      return;
    }
    sel.disabled = false;
    if (mine[0].other) box.appendChild(el('p', 'sub', 'None of your clones is in town, so try it on another player\'s: every way out is refused before it reaches a block, so it changes nothing for them.'));
    mine.forEach(function (c) { var o = el('option', null, c.id.split('.')[0] + (c.other ? ' of ' + c.id.split('.')[1] : '') + ' (' + c.temperament + ')'); o.value = c.id; sel.appendChild(o); });
    BREAK_WAYS.forEach(function (w) {
      var b = el('button', 'btn small', w[1]); b.type = 'button';
      b.addEventListener('click', function () {
        b.disabled = true;
        var li = el('li', null, sel.options[sel.selectedIndex].text + ': ' + w[1].toLowerCase() + '...');
        $('breakResults').insertBefore(li, $('breakResults').firstChild);
        post('/api/escape', { clone: sel.value, kind: w[0] }).then(function (res) {
          var type = String(res.refusal || '').split(':')[0];
          li.className = 'refused';
          li.textContent = '';
          li.appendChild(el('b', null, 'Refused by NEAR: ' + type));
          li.appendChild(document.createTextNode(' ' + sel.options[sel.selectedIndex].text.split(' ')[0] + ' tried to ' + w[1].toLowerCase() + '; ' + w[2] + '.'));
          if (window.ClonesSound) ClonesSound.play('chains');
        }).catch(function (err) { li.className = 'warn'; li.textContent = w[1] + ': ' + err.message; })
          .then(function () { b.disabled = false; });
      });
      box.appendChild(b);
    });
  }
  function renderAccounts(list) {
    $('accountsCard').hidden = false;
    var ul = $('acctList'); ul.textContent = '';
    function describeKeys(ks) {
      var house = 0;
      return ks.length + (ks.length === 1 ? ' key: ' : ' keys: ') + ks.map(function (k) {
        var p = k.access_key.permission;
        if (p === 'FullAccess') return 'FULL ACCESS ' + k.public_key.slice(0, 16) + '...';
        var fc = p.FunctionCall || {};
        return 'function call only, on ' + fc.receiver_id + ', methods [' + (fc.method_names || []).join(', ') + ']';
      }).join('; ');
    }
    var gs = googleSession();
    if (gs && gs.guest === guest) ul.appendChild(el('li', 'muted', 'Signed in with Google: the house holds a full key to this account, like an exchange holds one for you, so you can play from any device. Your clones are on exactly the same leash: they can never withdraw. To hold the account yourself, play without signing in: your browser then makes its only full key.'));
    [['you (guest)', guest], ['market', MARKET]].forEach(function (p) {
      var li = el('li'); li.appendChild(el('b', null, p[0] + ': ')); li.appendChild(acctLink(p[1]));
      if (p[1] === guest) {
        var gk = el('div', 'keys', 'reading its keys...'); li.appendChild(gk);
        keysOf(guest).then(function (ks) { gk.textContent = describeKeys(ks); }).catch(function () { gk.textContent = ''; });
      }
      ul.appendChild(li);
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
  // An Ed25519 key made in this browser; only the public half leaves the page.
  function makeKey() {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('no WebCrypto'));
    return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (kp) {
      return Promise.all([crypto.subtle.exportKey('raw', kp.publicKey), crypto.subtle.exportKey('pkcs8', kp.privateKey)]);
    }).then(function (ex) {
      var pub = new Uint8Array(ex[0]), seed = new Uint8Array(ex[1]).slice(-32);
      var both = new Uint8Array(64); both.set(seed); both.set(pub, 32);
      return { publicKey: 'ed25519:' + base58(pub), secret: 'ed25519:' + base58(both) };
    });
  }
  function showMyKey() {
    var raw = stored('clones.secret.' + guest);
    if (!raw) return false;
    var k; try { k = JSON.parse(raw); } catch (e) { return false; }
    $('claimCard').hidden = false;
    $('claimTitle').textContent = 'Your key to this account';
    $('claimIntro').textContent = 'Your browser made this key when you sent your clones in, and it is the only full-access key on ' + guest + '. The house holds a key that can only whisper, retrain, settle and use the deed at the market: it can run your clones but can never move your NEAR. Save the key file; it lives only in this browser.';
    $('claimBtn').hidden = true;
    $('claimed').hidden = false;
    $('claimed').firstElementChild.textContent = 'Your full-access key for ' + guest + '. It is kept in this browser only; download the key file to keep it safe.';
    $('claimSecret').textContent = k.private_key;
    $('claimDownload').href = URL.createObjectURL(new Blob([JSON.stringify(k, null, 2)], { type: 'application/json' }));
    $('claimDownload').download = guest + '.json';
    return true;
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
      view('get_results', { player: guest }).catch(function () { return []; }),
      view('get_state', {}).catch(function () { return null; })
    ]).then(function (all) {
      if (!all[0]) {
        setStatus('Can\'t reach the chain', 'The test network is not answering right now. Your clones are safe in town and nothing is lost; this page tries again every few seconds.');
        $('boardNote').textContent = 'waiting for the test network...';
        schedulePoll(10000);
        return;
      }
      var states = all[1], results = all[2] || [];
      othersInTown = !!(all[3] && all[3][1].some(function (c) { var pl = c[1].player || playerOfClone(c[0]); return pl !== guest && !RIVAL_TITLES[String(pl).split('.')[0]] && !c[1].due_home; }));
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
      $('homeNote').textContent = inTown.length && home ? 'home so far; ' + inTown.length + (inTown.length === 1 ? ' clone is' : ' clones are') + ' still out' : inTown.length ? 'stake is out with the clones' : list.length ? 'paid home at dawn' : 'no clones yet';
      renderAccounts(list);
      renderBreak(list);
      $('bellRow').hidden = !inTown.length && !othersInTown;
      if (!inTown.length && othersInTown) $('bellNote').textContent = 'Your clones are home, but other players have clones in town: ring the bell to play the next night for them and watch.';
      if (!showMyKey()) $('claimCard').hidden = !(stored('clones.claim.' + guest) && window.crypto && crypto.subtle);

      if (inTown.length) {
        if (ringing) {
          setStatus('The bell is ringing', 'Every clone in town is trading. Whisper to a clone with the box under its purse: it obeys in the next hour.');
        } else if (nightOn()) {
          setStatus('A night is under way', 'Hour ' + (town.round + 1) + ' of ' + town.rounds + '. Someone else is ringing it: whisper under a clone\'s purse to steer it, or ring on to carry the night yourself and get the bell\'s calls.');
          $('bellBtn').textContent = 'Ring on from hour ' + (town.round + 1);
        } else if (inTown.every(function (c) { return c.state.due_home; })) {
          setStatus('Coming home', 'Your clones have played their nights. They settle and merge home, handing over what they made, the next time anyone rings the bell, or on their own around 02:00 UTC. Ring it now to bring them home yourself.');
          $('bellBtn').textContent = 'Ring the bell: bring them home';
        } else if (!afterBell) {
          $('bellBtn').textContent = 'Ring the bell: play the night now';
          setStatus('They are in town', 'Your ' + inTown.length + (inTown.length === 1 ? ' clone is' : ' clones are') + ' at the merchant\'s counter. Ring the bell to play the night now: a few minutes, with a stop for your call every two hours. Or leave them: the bell rings by itself around 02:00 UTC (' + countdownText().local + ' your time). And press "Try to run" on any clone, to see whether it can.');
          guide(2, 'Your clones are in town. Ring the bell to play the night: they trade twelve hours against everyone else\'s. The bell is shared, so if someone else rings first your clones still play, and you see how they did here.', 'bellBtn');
        } else {
          setStatus('Dawn', inTown.length + (inTown.length === 1 ? ' clone stays' : ' clones stay') + ' in town for the nights you chose, holding their goods. Ring again to play the next night.');
        }
        if (!ringing) schedulePoll(nightOn() ? 8000 : 20000);
      } else if (results.length) {
        setStatus('Morning', 'Your clones came home and handed over what they made. Look in the Proof drawers for how each step happened on chain, or ');
        var again = el('a', null, 'send in a new set'); again.href = 'town.html?new=1'; $('statusText').appendChild(again); $('statusText').appendChild(document.createTextNode('.'));
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
    if (document.hidden) ms *= 4;
    pollTimer = setTimeout(function () { if (!ringing) loadGuest(); }, ms);
  }

  /* ---------- start ---------- */
  // The proof drawers stay shut unless someone asks for them with #proof.
  function openProof() {
    if (location.hash !== '#proof') return;
    Array.prototype.forEach.call(document.querySelectorAll('#proof details'), function (d) { d.open = true; });
  }
  window.addEventListener('hashchange', openProof);
  openProof();
  window.addEventListener('resize', drawLeashes);
  if (window.ClonesSound) ClonesSound.mine(function (e) { return !e.player || e.player === guest; });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (nudge) nudge();
    else if (guest && !ringing) loadGuest(true);
  });
  setInterval(tickClock, 1000);
  $('marketLink').href = EXPLORER + '/address/' + MARKET;
  $('bellBtn').addEventListener('click', ringBell);
  $('refusalClose').addEventListener('click', function () { $('refusal').hidden = true; });
  $('claimBtn').addEventListener('click', claim);
  $('whoOut').addEventListener('click', signOut);
  paintGoogle();
  $('coachHide').addEventListener('click', function () { store(GUIDE_KEY, '1'); $('coach').hidden = true; document.querySelectorAll('.lit').forEach(function (n) { n.classList.remove('lit'); }); });
  $('restockSel').addEventListener('change', function () {
    var g = $('restockSel').value; if (!g) return;
    $('restockSel').disabled = true;
    post('/api/restock', { guest: guest, token: token(), good: g }).then(function () {
      $('restockSel').disabled = false;
      if (town) town.restock_order = g;
      cry('You ordered a full restock of ' + g + ' for the next night.', 'order-row');
      showDeed();
    }).catch(function (err) { $('restockSel').disabled = false; cry(err.message, 'warn'); });
  });

  // A slow testnet RPC: say so, and offer the recorded night meanwhile.
  setTimeout(function () {
    if ($('statusTitle').textContent !== 'Loading') return;
    setStatus('The town is slow to answer', 'The test network is busy. Give it a few seconds, or watch a recorded night meanwhile.');
    var a = el('a', null, ' Watch a recorded night'); a.href = 'index.html'; $('statusText').appendChild(a);
  }, 9000);
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
    loadGuest().then(function () { if (params.has('fresh') && !reduceMotion) $('bellRow').scrollIntoView({ block: 'center' }); });
    if (params.has('fresh')) history.replaceState(null, '', 'town.html?g=' + encodeURIComponent(g));
  } else {
    loadTown().catch(function () { $('boardNote').textContent = 'could not reach the testnet RPC'; });
    showEnlist();
  }
})();
