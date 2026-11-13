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
    var li = document.getElementById('sCrowns'); if (li && li.nextSibling) li.nextSibling.textContent = 'season crowns won so far, ' + guests + ' of them by guest accounts';
  }).catch(function () { set('sCrowns', '?'); });
  Promise.all([keys(TESTNET, MARKET), keys(MAINNET, MAIN)]).then(function (k) { set('sKeys', k[0] + ' · ' + k[1]); }).catch(function () { set('sKeys', '?'); });
})();
