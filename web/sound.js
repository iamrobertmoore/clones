/* Clones: sound. Everything is synthesised in the browser with the Web Audio API: no audio files.
   Off by default; one toggle turns on both the music and the effects, and the choice is kept in
   this browser. Music: a low drone, wind, and a slow bell melody in a dark mode. Effects: the
   church bell for each hour, a gong at dusk, coins for trades, a hiss for whispers, chains and
   thunder when a clone tries to run, and a fanfare for the crown.

   window.ClonesSound.on()          -> is sound on?
   window.ClonesSound.toggle()      -> turn it on or off (call from a click)
   window.ClonesSound.play(name, o) -> 'bell', 'gong', 'coin', 'whisper', 'chains', 'crown', 'tick'
   window.ClonesSound.event(kind, e) -> map a night event (hour, dusk, order, ...) to a sound */
(function () {
  'use strict';

  var KEY = 'clones.sound';
  var ctx = null, master = null, musicBus = null, sfxBus = null, verb = null, enabled = false, musicNodes = null;
  var mineOnly = null; // set by a page: a function (e) -> true when an event is the viewer's own

  function stored() { try { return localStorage.getItem(KEY) === 'on'; } catch (e) { return false; } }
  function store(v) { try { localStorage.setItem(KEY, v ? 'on' : 'off'); } catch (e) { /* storage blocked */ } }

  function init() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.0001; master.connect(ctx.destination);
    // A long dark room: a convolver fed with a decaying noise burst.
    verb = ctx.createConvolver();
    var len = ctx.sampleRate * 4.5, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (var ch = 0; ch < 2; ch++) {
      var d = ir.getChannelData(ch);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    verb.buffer = ir;
    var wet = ctx.createGain(); wet.gain.value = 0.55; verb.connect(wet); wet.connect(master);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.55; musicBus.connect(master); musicBus.connect(verb);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master); sfxBus.connect(verb);
    return ctx;
  }
  function now() { return ctx.currentTime; }
  function env(g, t, a, peak, dec) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }
  function noiseBuffer(sec) {
    var b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /* ---------- effects ---------- */
  // A church bell: inharmonic partials with long, staggered decays.
  function bell(o) {
    var t = now() + 0.01, f = (o && o.f) || 196, vol = (o && o.vol) || 0.22;
    [[0.5, 1, 3.2], [1, 0.9, 2.6], [1.19, 0.55, 2.2], [1.5, 0.45, 1.8], [2, 0.5, 1.5], [2.74, 0.25, 1.0], [3.76, 0.15, 0.7]].forEach(function (p) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f * p[0];
      env(g, t, 0.004, vol * p[1], p[2]);
      osc.connect(g); g.connect(sfxBus); osc.start(t); osc.stop(t + p[2] + 0.1);
    });
  }
  function gong() {
    var t = now() + 0.01;
    [55, 82.4, 110.7, 147].forEach(function (f, i) {
      var osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = i ? 'sine' : 'triangle'; osc.frequency.setValueAtTime(f * 1.02, t); osc.frequency.exponentialRampToValueAtTime(f, t + 1.5);
      env(g, t, 0.05, 0.22 / (i + 1), 5.5 - i);
      osc.connect(g); g.connect(sfxBus); osc.start(t); osc.stop(t + 6);
    });
  }
  function coin(o) {
    var t = now() + 0.01, n = (o && o.n) || 2, vol = (o && o.vol) || 0.12;
    for (var i = 0; i < n; i++) {
      var osc = ctx.createOscillator(), g = ctx.createGain(), at = t + i * 0.06 + Math.random() * 0.02;
      osc.type = 'triangle'; osc.frequency.value = 2400 + Math.random() * 1600;
      env(g, at, 0.002, vol, 0.18);
      osc.connect(g); g.connect(sfxBus); osc.start(at); osc.stop(at + 0.25);
    }
  }
  function whisper() {
    var t = now() + 0.01, src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noiseBuffer(1.4);
    bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(2600, t + 0.6); bp.frequency.exponentialRampToValueAtTime(700, t + 1.2);
    env(g, t, 0.25, 0.16, 1.0);
    src.connect(bp); bp.connect(g); g.connect(sfxBus); src.start(t); src.stop(t + 1.4);
  }
  // A clone pulls against its chain and the chain holds: metal, a heavy thud, distant thunder.
  function chains() {
    var t = now() + 0.01;
    for (var i = 0; i < 7; i++) {
      var at = t + i * 0.07 + Math.random() * 0.03, src = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = noiseBuffer(0.2); hp.type = 'bandpass'; hp.frequency.value = 3000 + Math.random() * 3000; hp.Q.value = 8;
      env(g, at, 0.002, 0.35, 0.12);
      src.connect(hp); hp.connect(g); g.connect(sfxBus); src.start(at); src.stop(at + 0.2);
    }
    var thud = ctx.createOscillator(), tg = ctx.createGain();
    thud.type = 'sine'; thud.frequency.setValueAtTime(90, t + 0.5); thud.frequency.exponentialRampToValueAtTime(38, t + 0.9);
    env(tg, t + 0.5, 0.01, 0.6, 0.6);
    thud.connect(tg); tg.connect(sfxBus); thud.start(t + 0.5); thud.stop(t + 1.3);
    var rum = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), rg = ctx.createGain();
    rum.buffer = noiseBuffer(4); lp.type = 'lowpass'; lp.frequency.value = 160;
    env(rg, t + 0.7, 0.4, 0.5, 3.2);
    rum.connect(lp); lp.connect(rg); rg.connect(sfxBus); rum.start(t + 0.7); rum.stop(t + 4.7);
  }
  // The crown: a slow brass-like swell, minor to major when it is yours.
  function crown(o) {
    var t = now() + 0.02, mine = o && o.mine;
    var chords = mine ? [[110, 130.8, 164.8], [110, 138.6, 164.8, 220]] : [[110, 130.8, 164.8]];
    chords.forEach(function (ch, k) {
      ch.forEach(function (f) {
        var osc = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), at = t + k * 1.1;
        osc.type = 'sawtooth'; osc.frequency.value = f; osc.detune.value = (Math.random() - 0.5) * 12;
        lp.type = 'lowpass'; lp.frequency.setValueAtTime(400, at); lp.frequency.linearRampToValueAtTime(1800, at + 0.6);
        env(g, at, 0.35, 0.07, mine && k ? 2.6 : 1.6);
        osc.connect(lp); lp.connect(g); g.connect(sfxBus); osc.start(at); osc.stop(at + 3.2);
      });
    });
    if (mine) setTimeout(function () { bell({ f: 330, vol: 0.18 }); }, 1100);
  }
  function tick() {
    var t = now() + 0.01, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'square'; osc.frequency.value = 1300; env(g, t, 0.001, 0.03, 0.05);
    osc.connect(g); g.connect(sfxBus); osc.start(t); osc.stop(t + 0.08);
  }
  var FX = { bell: bell, gong: gong, coin: coin, whisper: whisper, chains: chains, crown: crown, tick: tick };

  /* ---------- music ---------- */
  // Phrygian on A, low and slow: the crypt market at night.
  var SCALE = [220, 233.1, 261.6, 293.7, 329.6, 349.2, 392];
  function startMusic() {
    if (musicNodes) return;
    var t = now() + 0.05, nodes = [];
    // the drone: two detuned voices through a breathing lowpass
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 4;
    var lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 0.05; lfoG.gain.value = 140;
    lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start(t);
    var dg = ctx.createGain(); dg.gain.setValueAtTime(0.0001, t); dg.gain.exponentialRampToValueAtTime(0.16, t + 4);
    [[55, 'sawtooth', -7], [55.2, 'sawtooth', 6], [82.4, 'triangle', 0]].forEach(function (v) {
      var o = ctx.createOscillator(); o.type = v[1]; o.frequency.value = v[0]; o.detune.value = v[2];
      o.connect(lp); o.start(t); nodes.push(o);
    });
    lp.connect(dg); dg.connect(musicBus);
    // wind: filtered noise that rises and falls
    var wind = ctx.createBufferSource(); wind.buffer = noiseBuffer(6); wind.loop = true;
    var wbp = ctx.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 500; wbp.Q.value = 0.7;
    var wl = ctx.createOscillator(), wlg = ctx.createGain(); wl.frequency.value = 0.07; wlg.gain.value = 300;
    wl.connect(wlg); wlg.connect(wbp.frequency); wl.start(t);
    var wg = ctx.createGain(); wg.gain.setValueAtTime(0.0001, t); wg.gain.exponentialRampToValueAtTime(0.05, t + 6);
    wind.connect(wbp); wbp.connect(wg); wg.connect(musicBus); wind.start(t);
    nodes.push(lfo, wind, wl);
    // the melody: a soft bell every few seconds, wandering down the scale
    var step = 0, timer = setInterval(function () {
      if (!enabled || !ctx) return;
      var deg = [0, 1, 0, 4, 3, 1, 0, 6, 5, 4, 1, 0][step % 12];
      step += 1;
      var f = SCALE[deg] / (step % 24 < 12 ? 1 : 2), at = now() + 0.02;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      var o2 = ctx.createOscillator(), g2 = ctx.createGain(); o2.type = 'sine'; o2.frequency.value = f * 2.76;
      env(g, at, 0.01, 0.06, 3.5); env(g2, at, 0.005, 0.015, 1.2);
      o.connect(g); g.connect(musicBus); o2.connect(g2); g2.connect(musicBus);
      o.start(at); o.stop(at + 3.7); o2.start(at); o2.stop(at + 1.3);
    }, 2600);
    musicNodes = { nodes: nodes, timer: timer, gains: [dg, wg] };
  }
  function stopMusic() {
    if (!musicNodes) return;
    clearInterval(musicNodes.timer);
    var t = now();
    musicNodes.gains.forEach(function (g) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.4); });
    var old = musicNodes.nodes;
    setTimeout(function () { old.forEach(function (n) { try { n.stop(); } catch (e) { /* already stopped */ } }); }, 2500);
    musicNodes = null;
  }

  /* ---------- switch ---------- */
  function setOn(v) {
    enabled = v;
    store(v);
    if (v) {
      if (!init()) return;
      if (ctx.state === 'suspended') ctx.resume();
      master.gain.setTargetAtTime(0.8, now(), 0.3);
      startMusic();
      setTimeout(function () { bell({ f: 196, vol: 0.18 }); }, 150);
    } else if (ctx) {
      master.gain.setTargetAtTime(0.0001, now(), 0.2);
      stopMusic();
    }
    paint();
  }
  function paint() {
    document.querySelectorAll('[data-sound-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      b.textContent = enabled ? '♪ Sound on' : '♪ Sound off';
    });
  }
  function play(name, o) {
    if (!enabled || !ctx || !FX[name]) return;
    try { FX[name](o); } catch (e) { /* never let sound break the page */ }
  }
  var lastCoin = 0;
  function event(kind, e) {
    if (!enabled) return;
    var mine = !mineOnly || mineOnly(e || {});
    switch (kind) {
      case 'hour': if (e && e.round > 0) play('bell', { f: 196, vol: 0.12 }); break;
      case 'dusk': play('gong'); break;
      case 'order': if (mine && Date.now() - lastCoin > 120) { lastCoin = Date.now(); play('coin', { n: 2 + Math.min(3, Math.floor((e.qty || 1) / 8)) }); } break;
      case 'withdraw_refused': play('chains'); break;
      case 'crowned': play('crown', { mine: !!(e && e.mine) }); break;
      case 'settled': if (mine) play('coin', { n: 5, vol: 0.09 }); break;
      case 'merged': if (mine) play('bell', { f: 392, vol: 0.06 }); break;
      default: break;
    }
  }

  window.ClonesSound = {
    on: function () { return enabled; },
    toggle: function () { setOn(!enabled); },
    play: play,
    event: event,
    mine: function (fn) { mineOnly = fn; }
  };

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-sound-toggle]');
    if (b) { ev.preventDefault(); setOn(!enabled); }
  });
  // Browsers only start audio after a gesture: a returning player who left sound on hears it from
  // their first click or key press on the page.
  function resume(ev) {
    if (ev && ev.target && ev.target.closest && ev.target.closest('[data-sound-toggle]')) return;
    document.removeEventListener('pointerdown', resume); document.removeEventListener('keydown', resume);
    if (stored() && !enabled) setOn(true);
  }
  document.addEventListener('pointerdown', resume); document.addEventListener('keydown', resume);
  document.addEventListener('DOMContentLoaded', paint);
  paint();
})();
