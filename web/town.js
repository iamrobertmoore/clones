/* Clones: the hosted town. Enlist up to three clones (POST /api/enlist), then watch them on chain
   from the guest page (?g=<guest>): waiting in town, trading during the night, and the morning
   ledger once they have merged home. All reads go straight to the market contract over RPC. */
(function () {
  'use strict';

  var RPC = 'https://test.rpc.fastnear.com';
  var HOUSE = 'clonestown.testnet';
  var MARKET = 'market.' + HOUSE;
  var EXPLORER = 'https://testnet.nearblocks.io';
  var LOGS = 'https://raw.githubusercontent.com/iamrobertmoore/clones/town-data/nights/latest/';
  var STORE_KEY = 'clones.guest';
  var NIGHT_HOUR_UTC = 2;
  var TEMPS = {
    cautious: { tint: '#5b84b1', why: 'Buys what is cheap, takes profit at +10%.' },
    greedy: { tint: '#d39a2a', why: 'Chases whatever rose most. All in.' },
    loyal: { tint: '#4e9a5f', why: 'Only grain and salt. Keeps your money safe.' }
  };
  var ORDER = ['cautious', 'greedy', 'loyal'];
  var GOODS = ['grain', 'salt', 'wool', 'iron', 'amber'];

  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';
  var town = null, guest = null, clonesNow = [], pollTimer = null;

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
  function acctLink(id, cls) {
    var a = el('a', cls, id);
    a.href = EXPLORER + '/address/' + encodeURIComponent(id);
    a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function txLink(tx) {
    var a = el('a', null, tx);
    a.href = EXPLORER + '/txns/' + encodeURIComponent(tx);
    a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function store(v) { try { if (v) localStorage.setItem(STORE_KEY, v); else localStorage.removeItem(STORE_KEY); } catch (e) { /* storage blocked */ } }
  function stored() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function validGuest(id) {
    return typeof id === 'string' && id.length <= 64 && /^[a-z0-9]+([-_][a-z0-9]+)*\.clonestown\.testnet$/.test(id);
  }

  /* ---------- chain reads ---------- */
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function view(method, args) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'query',
        params: { request_type: 'call_function', finality: 'optimistic', account_id: MARKET, method_name: method, args_base64: b64(JSON.stringify(args || {})) }
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('RPC HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error((j.error.cause && j.error.cause.name) || j.error.message || 'RPC error');
      if (!j.result || j.result.error) throw new Error((j.result && j.result.error) || 'RPC error');
      var text = new TextDecoder().decode(new Uint8Array(j.result.result));
      return text ? JSON.parse(text) : null;
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
  function nightInProgress() { return town && town.round > 0 && town.round < town.rounds && town.clones_in_town > 0; }
  function tickClock() {
    var c = countdownText();
    if (nightInProgress()) {
      $('clockTime').textContent = String((18 + town.round) % 24).padStart(2, '0') + ':00';
      $('clockLabel').textContent = 'the night is on: hour ' + (town.round + 1) + ' of ' + town.rounds;
    } else {
      $('clockTime').textContent = c.short;
      $('clockLabel').textContent = 'to the night, 02:00 UTC';
    }
    var cd = document.querySelector('[data-countdown]');
    if (cd) cd.textContent = c.short;
  }
  function buildBoard() {
    var ul = $('boardGoods'); ul.textContent = '';
    var goods = (town && town.goods) || GOODS;
    goods.forEach(function (g, k) {
      var li = el('li');
      li.appendChild(svgUse('g-' + g));
      li.appendChild(el('span', 'gname', g));
      li.appendChild(el('span', 'gprice', town && town.prices ? String(town.prices[k]) : '--'));
      li.appendChild(el('span', 'gmove', '·'));
      ul.appendChild(li);
    });
    if (town) $('boardNote').textContent = 'night ' + town.night + ', live from the market contract, milliNEAR / unit';
  }
  function loadTown() {
    return view('get_town', {}).then(function (t) { town = t; buildBoard(); tickClock(); return t; });
  }

  /* ---------- enlist view ---------- */
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
      if (c && c.value !== 'none') out.push(c.value);
    }
    return out;
  }
  function paintSlots() {
    document.querySelectorAll('.slot').forEach(function (fs) {
      var c = fs.querySelector('input:checked'), t = c ? c.value : 'none';
      fs.classList.toggle('empty', t === 'none');
      fs.querySelector('.fig').style.setProperty('--tunic', TEMPS[t] ? TEMPS[t].tint : '#6d6875');
      fs.querySelector('.why').textContent = TEMPS[t] ? TEMPS[t].why : 'This slot stays empty.';
    });
    var n = chosen().length;
    $('sendBtn').textContent = n === 1 ? 'Send it in tonight' : 'Send them in tonight';
    $('sendNote').textContent = n + (n === 1 ? ' clone goes' : ' clones go') + ' in with 0.5 testnet NEAR each from the house. No login, no wallet.';
  }

  var STEPS = [
    [0, 'Creating your guest account on testnet'],
    [4, 'Making each clone a sub-account of your guest'],
    [9, 'Giving each clone its only key: trade, never withdraw'],
    [14, 'Sending them into town with 0.5 NEAR each'],
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
    var temps = chosen();
    if (!temps.length) return;
    $('sendBtn').disabled = true;
    $('statusError').hidden = true;
    var timer = showProgress();
    fetch('/api/enlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ temperaments: temps })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || ('The town did not answer (HTTP ' + r.status + ').'));
        return j;
      });
    }).then(function (res) {
      clearInterval(timer);
      $('barFill').style.width = '100%';
      $('progress').hidden = true;
      if (!validGuest(res.guest)) throw new Error('The town answered with an unexpected guest id.');
      store(res.guest);
      var url = location.origin + location.pathname + '?g=' + encodeURIComponent(res.guest);
      $('guestUrl').textContent = url; $('guestUrl').href = url;
      $('goGuest').href = url;
      var tl = $('txList'); tl.textContent = '';
      (res.txs || []).forEach(function (t) {
        if (!t || !t.tx) return;
        var li = el('li'); li.appendChild(document.createTextNode((t.step || 'tx') + ': ')); li.appendChild(txLink(t.tx)); tl.appendChild(li);
      });
      $('done').hidden = false;
      $('goGuest').focus();
      setStatus('Your clones are in town', 'Guest ' + res.guest + ' with ' + (res.clones || []).length + ' clone(s). The night is played at 02:00 UTC.');
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
    setStatus('Send your clones in', 'Pick a temperament for each clone. They trade the whole night while you sleep, then merge back into you at dawn.');
    var g = stored();
    if (g && validGuest(g)) {
      var p = $('statusText');
      p.appendChild(document.createTextNode(' You already have clones here: '));
      var a = el('a', null, g); a.href = 'town.html?g=' + encodeURIComponent(g); p.appendChild(a);
      p.appendChild(document.createTextNode('.'));
    }
  }

  /* ---------- guest view ---------- */
  function setStatus(title, text, error) {
    $('statusTitle').textContent = title;
    $('statusText').textContent = text;
    $('statusError').hidden = !error;
    $('statusError').textContent = error || '';
  }
  function buildGuestClones(list) {
    var box = $('guestClones'); box.textContent = '';
    box.style.gridTemplateColumns = 'repeat(' + Math.max(1, list.length) + ', minmax(0, 1fr))';
    box.style.maxWidth = (list.length < 3 ? Math.max(1, list.length) * 250 : 760) + 'px';
    list.forEach(function (c, k) {
      var tint = (TEMPS[c.temperament] || {}).tint || '#8a8a8a';
      var root = el('div', 'clone' + (c.state ? '' : ' gone') + (c.state && c.state.broke ? ' broke' : '')); root.dataset.n = k;
      root.style.setProperty('--tint', tint); root.style.setProperty('--tunic', tint);
      var body = el('div', 'body'), walker = el('div', 'walker');
      walker.appendChild(svgUse('person', 'fig'));
      var collar = el('span', 'collar-pt'); walker.appendChild(collar);
      body.appendChild(walker);
      body.appendChild(el('div', 'tomb', 'merged home'));
      var short = c.id.split('.')[0];
      var name = el('div', 'name', short); name.appendChild(el('em', null, c.temperament || '?'));
      var purse = el('div', 'purse');
      var coins = el('div', 'coins'); coins.appendChild(svgUse('coin', 'ico'));
      var s = c.state, r = c.result;
      coins.appendChild(el('b', null, s ? near(s.cash) : r ? near(r.paid_out) : '-'));
      coins.appendChild(el('span', null, 'NEAR'));
      purse.appendChild(coins);
      var carry = el('div', 'carry');
      if (s && s.stock) s.stock.forEach(function (q, g) {
        if (q > 0) { var sp = el('span'); sp.appendChild(svgUse('g-' + ((town && town.goods) || GOODS)[g])); sp.appendChild(document.createTextNode(String(q))); carry.appendChild(sp); }
      });
      purse.appendChild(carry);
      purse.appendChild(el('div', 'worth', s ? 'stake ' + near(s.stake) + ', worth ' + near(s.worth) : r ? 'paid out, stake was ' + near(r.stake) : 'not in town'));
      purse.appendChild(acctLink(c.id, 'acct'));
      root.appendChild(body); root.appendChild(name); root.appendChild(purse);
      box.appendChild(root);
      c.collar = collar;
    });
    clonesNow = list;
    drawLeashes();
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
  function renderMorning(rows) {
    var latest = rows.reduce(function (m, r) { return Math.max(m, Number(r.night) || 0); }, 0);
    var night = rows.filter(function (r) { return (Number(r.night) || 0) === latest; });
    $('morning').hidden = false;
    $('morningSub').textContent = 'Night ' + latest + ', seed ' + (night[0] ? night[0].seed : '?') + '. Read from the market contract: stake against what each clone paid out at dawn.';
    var ul = $('morningRows'); ul.textContent = '';
    var stake = 0, paid = 0;
    night.forEach(function (r) {
      var li = el('li');
      var fig = svgUse('person'); fig.style.setProperty('--tunic', (TEMPS[r.temperament] || {}).tint || '#888');
      if (r.broke) fig.style.filter = 'saturate(.25)';
      li.appendChild(fig);
      var nm = el('div', 'r-name', String(r.clone).split('.')[0]);
      nm.appendChild(el('small', null, r.temperament + ', ' + r.orders_placed + ' orders' + (r.broke ? ', went broke' : '')));
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
    $('watchNote').textContent = 'Checking for your night log...';
    fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status);
      btn.removeAttribute('aria-disabled');
      $('watchNote').textContent = 'Replays your whole night in 60 seconds.';
    }).catch(function () {
      $('watchNote').textContent = 'Your night log is not published yet. It appears a little after the night is played; check back later.';
    });
  }
  function renderAccounts(ids) {
    $('accountsCard').hidden = false;
    var ul = $('acctList'); ul.textContent = '';
    ids.forEach(function (p) {
      var li = el('li'); li.appendChild(el('b', null, p[0] + ': ')); li.appendChild(acctLink(p[1])); ul.appendChild(li);
    });
  }
  function loadGuest() {
    var ids = [1, 2, 3].map(function (n) { return 'clone-' + n + '.' + guest; });
    return Promise.all([
      loadTown().catch(function () { return null; }),
      Promise.all(ids.map(function (id) { return view('get_clone', { clone_id: id }).catch(function () { return null; }); })),
      view('get_results', { player: guest }).catch(function () { return []; })
    ]).then(function (all) {
      var states = all[1], results = all[2] || [];
      var latest = results.reduce(function (m, r) { return Math.max(m, Number(r.night) || 0); }, 0);
      var list = [];
      ids.forEach(function (id, k) {
        var r = null;
        results.forEach(function (x) { if (x.clone === id && (Number(x.night) || 0) === latest) r = x; });
        if (states[k] || r) list.push({ id: id, state: states[k], result: r, temperament: states[k] ? states[k].temperament : r.temperament });
      });
      var inTown = list.filter(function (c) { return c.state; });
      $('home').hidden = false;
      buildGuestClones(list);
      var home = 0; list.forEach(function (c) { if (!c.state && c.result) home += Number(c.result.paid_out); });
      $('homeCash').textContent = near(home);
      $('homeNote').textContent = inTown.length ? 'stake is out with the clones' : list.length ? 'paid home at dawn' : 'no clones yet';
      renderAccounts([['you (guest)', guest], ['market', MARKET]].concat(list.map(function (c) { return [c.id.split('.')[0], c.id]; })));

      if (inTown.length) {
        if (nightInProgress()) {
          setStatus('The night is on', 'Your ' + inTown.length + (inTown.length === 1 ? ' clone is' : ' clones are') + ' trading right now: hour ' + (town.round + 1) + ' of ' + town.rounds + '. Purses update live from the chain.');
        } else {
          setStatus('Waiting in town', 'Your ' + inTown.length + (inTown.length === 1 ? ' clone is' : ' clones are') + ' at the merchant\'s counter. The night is played at 02:00 UTC (' + countdownText().local + ' your time), in');
          var cd = el('span', 'count'); cd.setAttribute('data-countdown', ''); $('statusText').appendChild(cd);
          $('statusText').appendChild(document.createTextNode(' Come back after dawn: this browser remembers your clones.'));
        }
        schedulePoll(nightInProgress() ? 10000 : 60000);
      } else if (results.length) {
        setStatus('Morning', 'Your clones came home at dawn: each merged back into your guest account and its own account was deleted. The results below live on chain.');
      } else {
        setStatus('No clones here', 'There are no clones in town for ' + guest + ' and no results yet. If you just enlisted, give the chain a few seconds and reload.');
      }
      if (results.length) renderMorning(results); else $('morning').hidden = true;
      tickClock();
    }).catch(function (err) {
      setStatus('Could not read the town', 'The testnet RPC did not answer. Reload in a moment.', err.message);
    });
  }
  function schedulePoll(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadGuest, ms);
  }

  /* ---------- start ---------- */
  window.addEventListener('resize', drawLeashes);
  setInterval(tickClock, 1000);
  $('copyUrl').addEventListener('click', function () {
    var u = $('guestUrl').href;
    if (navigator.clipboard) navigator.clipboard.writeText(u).then(function () { $('copyUrl').textContent = 'Copied'; }, function () { /* ignore */ });
  });
  $('marketLink').href = EXPLORER + '/address/' + MARKET;

  var params = new URLSearchParams(location.search);
  var g = params.get('g');
  if (g && !validGuest(g)) {
    setStatus('Unknown guest', 'That link does not look like a hosted-town guest (it should end in .clonestown.testnet).');
    loadTown().catch(function () { /* board stays empty */ });
    showEnlist();
    return;
  }
  if (!g && !params.has('new')) {
    var s = stored();
    if (s && validGuest(s)) { g = s; history.replaceState(null, '', 'town.html?g=' + encodeURIComponent(s)); }
  }
  if (g) {
    guest = g;
    store(g);
    var gl = $('guestLink'); gl.textContent = g; gl.href = EXPLORER + '/address/' + encodeURIComponent(g);
    $('guestClones').hidden = false;
    $('enlistAgain').hidden = false;
    loadGuest();
  } else {
    loadTown().catch(function () { $('boardNote').textContent = 'could not reach the testnet RPC'; });
    showEnlist();
  }
})();
