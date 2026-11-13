// The landing page's live numbers, read from the chain in the visitor's browser.
(function () {
  var TESTNET = ['https://rpc.testnet.fastnear.com', 'https://test.rpc.fastnear.com'];
  var MAINNET = ['https://rpc.mainnet.fastnear.com', 'https://archival-rpc.mainnet.fastnear.com'];
  var MARKET = 'pyre.clonestown.testnet', FIRST = 'shroud.clonestown.testnet', MAIN = 'market.clones-town.near';
  function rpc(hosts, params, i) {
    i = i || 0;
    return fetch(hosts[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: params }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.error || !j.result) throw new Error('rpc'); return j.result; })
      .catch(function (e) { if (i + 1 < hosts.length) return rpc(hosts, params, i + 1); throw e; });
  }
  function view(hosts, account, method, args) {
    var b64 = btoa(JSON.stringify(args || {}));
    return rpc(hosts, { request_type: 'call_function', finality: 'optimistic', account_id: account, method_name: method, args_base64: b64 })
      .then(function (r) { return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))); });
  }
  function keys(hosts, account) {
    return rpc(hosts, { request_type: 'view_access_key_list', finality: 'final', account_id: account }).then(function (r) { return (r.keys || []).length; });
  }
  function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
  view(TESTNET, MARKET, 'get_town').then(function (t) { set('sNights', t.night); }).catch(function () { set('sNights', '?'); });
  view(TESTNET, MARKET, 'get_state').then(function (s) { set('sTown', (s && s[1] ? s[1].length : 0)); }).catch(function () { set('sTown', '?'); });
  Promise.all([view(TESTNET, MARKET, 'get_season', { from: 0, limit: 1 }), view(TESTNET, FIRST, 'get_season', { from: 0, limit: 1 })]).then(function (r) {
    var all = (r[0].champions || []).concat(r[1].champions || []);
    var guests = all.filter(function (c) { return /^g[a-z0-9]{6}\./.test(c.player); }).length;
    set('sCrowns', all.length);
    set('sCrownsLabel', 'season crowns won, ' + guests + ' by guest accounts');
  }).catch(function () { set('sCrowns', '?'); });
  Promise.all([keys(TESTNET, MARKET), keys(MAINNET, MAIN)]).then(function (k) { set('sKeys', k[0] + ' · ' + k[1]); }).catch(function () { set('sKeys', '?'); });

  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Sections fade up as they scroll in.
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: 0.15 }) : null;
  Array.prototype.forEach.call(document.querySelectorAll('.reveal'), function (n) { if (io && !still) io.observe(n); else n.classList.add('in'); });

  // The omen keeps changing its mind.
  var MOODS = [['Boom', 'Prices climb all night.'], ['Slump', 'Prices sink, then rebound before dawn.'], ['Blight', 'The luxuries rot; the staples hold.'], ['Wild', 'Big swings both ways.']];
  var omen = document.querySelector('.omen-art'), mi = 0;
  if (omen && !still) setInterval(function () {
    omen.classList.add('out');
    setTimeout(function () { mi = (mi + 1) % MOODS.length; set('omenWord', MOODS[mi][0]); set('omenWhy', MOODS[mi][1]); omen.classList.remove('out'); }, 500);
  }, 3200);

  // The market board: five goods whose prices move as clones trade.
  var board = document.getElementById('miniBoard');
  var GOODS = [['grain', 19], ['salt', 29], ['wool', 49], ['iron', 79], ['amber', 119]];
  if (board) {
    var cells = GOODS.map(function (g) {
      var d = document.createElement('div');
      d.innerHTML = '<svg><use href="#g-' + g[0] + '"/></svg><b>' + (g[1] / 1000).toFixed(3) + '</b><i>' + g[0] + '</i>';
      board.appendChild(d); return { el: d, b: d.querySelector('b'), p: g[1] };
    });
    if (!still) setInterval(function () {
      cells.forEach(function (c) {
        var m = 1 + (Math.random() - 0.48) * 0.16, n = Math.max(5, Math.round(c.p * m));
        c.el.className = n > c.p ? 'up' : n < c.p ? 'down' : '';
        c.p = n; c.b.textContent = (n / 1000).toFixed(3);
      });
    }, 1400);
  }

  // A clone lunges for the coins; the chain holds.
  var stage = document.getElementById('runStage');
  if (stage && !still) {
    var cycle = function () {
      stage.className = 'run-stage reveal in lunge';
      setTimeout(function () { stage.className = 'run-stage reveal in snap'; }, 700);
      setTimeout(function () { stage.className = 'run-stage reveal in hold'; }, 1200);
      setTimeout(function () { stage.className = 'run-stage reveal in'; }, 3600);
    };
    setTimeout(cycle, 1200); setInterval(cycle, 5200);
  } else if (stage) stage.classList.add('hold');
})();
