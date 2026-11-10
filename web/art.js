/* Clones: shared art for both pages. Injects the drawings (one person, five goods, one coin),
   the night landscape behind every .sky, and the logo. Plain SVG, no images. */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  // Deterministic randomness, so the forest is the same on every visit.
  function rng(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  }

  var SPRITES =
    '<defs>' +
    // One person. Every clone is this same person: corpse paint, long hair, a black cloak,
    // a spiked iron collar (the leash hooks to its ring) and a sash in the temperament's colour.
    '<symbol id="person" viewBox="0 0 40 64">' +
    '<ellipse cx="20" cy="62" rx="13" ry="2" fill="rgba(0,0,0,.7)"/>' +
    '<path d="M11.5 27 Q20 23.5 28.5 27 L34.5 61 H5.5 Z" fill="#0d0b11" stroke="var(--rim,#4b4656)" stroke-width="1"/>' +
    '<path d="M15 32 L12.5 60 M25 32 L27.5 60 M20 32 V60" stroke="#221f28" stroke-width="1"/>' +
    '<path d="M11.5 29 L6 45.5 L9.5 46.5 L13.5 35 Z M28.5 29 L34 45.5 L30.5 46.5 L26.5 35 Z" fill="#0d0b11" stroke="var(--rim,#4b4656)" stroke-width=".8"/>' +
    '<path d="M5.6 43.5 L2.5 42.6 L5.6 41.7 Z M34.4 43.5 L37.5 42.6 L34.4 41.7 Z M6.4 46.5 L4.6 49 L8 47 Z M33.6 46.5 L35.4 49 L32 47 Z" fill="#a9a4b0"/>' +
    '<path d="M8.7 43.5 H31.3 L32 47.2 H8 Z" fill="var(--tunic,#777)"/>' +
    '<path d="M12 12.6 Q11.2 4.2 20 3.8 Q28.8 4.2 28 12.6 L30.2 22 L33 34 L30.4 31 L30 36.5 L27.6 31.6 L26.6 27 H13.4 L12.4 31.6 L10 36.5 L9.6 31 L7 34 L9.8 22 Z" fill="#040306" stroke="var(--rim,#4b4656)" stroke-width=".6"/>' +
    '<path d="M14.7 10.6 Q20 8.2 25.3 10.6 L24.9 18.8 Q20 24 15.1 18.8 Z" fill="#e7e1d4"/>' +
    '<path d="M14.9 11.8 L18.9 13.1 L18.3 17.6 L16.1 19.2 L15.2 15.6 Z M25.1 11.8 L21.1 13.1 L21.7 17.6 L23.9 19.2 L24.8 15.6 Z" fill="#040306"/>' +
    '<path d="M20 8.6 L19.3 12 L20 13.3 L20.7 12 Z" fill="#040306"/>' +
    '<circle cx="17" cy="15.2" r="2.6" fill="var(--eye,#d7212b)" opacity=".28"/><circle cx="23" cy="15.2" r="2.6" fill="var(--eye,#d7212b)" opacity=".28"/>' +
    '<circle class="eye" cx="17" cy="15.2" r="1.1" fill="var(--eye,#d7212b)"/>' +
    '<circle class="eye" cx="23" cy="15.2" r="1.1" fill="var(--eye,#d7212b)"/>' +
    '<path d="M17.7 20.2 H22.3 M18.7 20.4 V22.6 M20 20.4 V23.6 M21.3 20.4 V22.6" stroke="#040306" stroke-width=".95" fill="none"/>' +
    '<path d="M14.2 9.6 Q12.8 16 11.6 25 M25.8 9.6 Q27.2 16 28.4 25 M15.5 9 Q14.6 13 14.4 18" stroke="#040306" stroke-width="2" fill="none"/>' +
    '<rect x="12.6" y="25.2" width="14.8" height="3.3" rx="1" fill="#57525e" stroke="#000" stroke-width=".7"/>' +
    '<path d="M14 25.3 L15.1 22.4 L16.2 25.3 Z M18.5 25.3 L20 21.8 L21.5 25.3 Z M23.8 25.3 L24.9 22.4 L26 25.3 Z" fill="#c3bec9"/>' +
    '<circle cx="20" cy="30" r="1.6" fill="none" stroke="#9a95a2" stroke-width="1"/>' +
    '</symbol>' +
    // Goods, drawn like engravings: bone and iron, with amber the one warm thing in the town.
    '<symbol id="g-grain" viewBox="0 0 24 24"><path d="M12 22 V5" stroke="#8d7a4c" stroke-width="1.8"/>' +
    '<g fill="#d8c48e" stroke="#4a3d22" stroke-width=".8"><ellipse cx="12" cy="4.6" rx="2.2" ry="3.3"/>' +
    '<ellipse cx="8.8" cy="9.6" rx="2" ry="3.2" transform="rotate(-32 8.8 9.6)"/><ellipse cx="15.2" cy="9.6" rx="2" ry="3.2" transform="rotate(32 15.2 9.6)"/>' +
    '<ellipse cx="8.8" cy="15" rx="2" ry="3.2" transform="rotate(-32 8.8 15)"/><ellipse cx="15.2" cy="15" rx="2" ry="3.2" transform="rotate(32 15.2 15)"/></g></symbol>' +
    '<symbol id="g-salt" viewBox="0 0 24 24"><path d="M2.5 21 L8 11 L11 14 L14.5 6 L21.5 21 Z" fill="#ecebe6" stroke="#55555c" stroke-width="1.3"/>' +
    '<path d="M14.5 6 L13 21 M8 11 L9.5 21" stroke="#a7a7ae" stroke-width=".9"/></symbol>' +
    '<symbol id="g-wool" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#a39ab0" stroke="#3a3442" stroke-width="1.4"/>' +
    '<path d="M4.6 9 Q12 14.5 19.4 8 M4 14 Q12 19.5 20 13 M9 3.8 Q14.5 12 10 20.6" fill="none" stroke="#3a3442" stroke-width="1.1"/></symbol>' +
    '<symbol id="g-iron" viewBox="0 0 24 24"><path d="M2 18.5 L6 9 H18 L22 18.5 Z" fill="#7d838c" stroke="#16191d" stroke-width="1.4"/>' +
    '<path d="M6 9 L8 12.5 H16 L18 9 M8 12.5 L5 18.5 M16 12.5 L19 18.5" fill="none" stroke="#c4c9cf" stroke-width=".8"/></symbol>' +
    '<symbol id="g-amber" viewBox="0 0 24 24"><path d="M12 2 L20 9 L12 22 L4 9 Z" fill="#e0861b" stroke="#5a2504" stroke-width="1.4"/>' +
    '<path d="M4 9 H20 M12 2 L9 9 L12 22 L15 9 Z" fill="none" stroke="#5a2504" stroke-width=".9"/>' +
    '<path d="M8.2 7 L10 5.2" stroke="#ffd79a" stroke-width="1.3" stroke-linecap="round"/></symbol>' +
    '<symbol id="coin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#b3ada2" stroke="#2b2824" stroke-width="1.8"/>' +
    '<circle cx="12" cy="12" r="6.8" fill="none" stroke="#6f6a61" stroke-width="1.2"/>' +
    '<path d="M8.6 16.4 V7.6 L15.4 16.4 V7.6" fill="none" stroke="#2b2824" stroke-width="1.9" stroke-linejoin="bevel"/></symbol>' +
    '<symbol id="raven" viewBox="0 0 40 16"><path d="M0 7 Q8 0 16 6 L20 4 L24 6 Q32 0 40 7 Q31 4 25 9 L20 12 L15 9 Q9 4 0 7 Z" fill="#020203"/></symbol>' +
    '</defs>';

  function injectSprites() {
    var holder = document.createElementNS(NS, 'svg');
    holder.setAttribute('width', '0'); holder.setAttribute('height', '0');
    holder.setAttribute('aria-hidden', 'true'); holder.setAttribute('focusable', 'false');
    holder.style.position = 'absolute';
    holder.innerHTML = SPRITES;
    document.body.insertBefore(holder, document.body.firstChild);
  }

  // A jagged ridge line from x=0 to x=w.
  function ridge(r, w, base, lo, hi, step) {
    var d = 'M0 ' + base, x = 0;
    while (x < w) {
      x = Math.min(w, x + step * (0.5 + r()));
      d += ' L' + x.toFixed(0) + ' ' + (lo + r() * (hi - lo)).toFixed(0);
    }
    return d + ' L' + w + ' ' + base + ' Z';
  }
  // A black pine: stacked drooping tiers, narrow at the top.
  function pine(x, y, h, r) {
    var tiers = 5 + Math.floor(r() * 3), w = h * 0.32, d = 'M' + x.toFixed(1) + ' ' + (y - h).toFixed(1);
    var right = [], left = [];
    for (var i = 1; i <= tiers; i++) {
      var ty = y - h + (h * 0.92) * (i / tiers), tw = w * (0.25 + 0.75 * i / tiers) * (0.85 + r() * 0.3);
      right.push('L' + (x + tw).toFixed(1) + ' ' + ty.toFixed(1) + ' L' + (x + tw * 0.38).toFixed(1) + ' ' + (ty - h * 0.04).toFixed(1));
      left.unshift('L' + (x - tw * 0.38).toFixed(1) + ' ' + (ty - h * 0.04).toFixed(1) + ' L' + (x - tw).toFixed(1) + ' ' + ty.toFixed(1));
    }
    return d + ' ' + right.join(' ') + ' L' + (x + 2).toFixed(1) + ' ' + y + ' L' + (x - 2).toFixed(1) + ' ' + y + ' ' + left.join(' ') + ' Z';
  }
  function forest(r, n, x0, x1, y, hmin, hmax) {
    var d = '';
    for (var i = 0; i < n; i++) d += pine(x0 + (x1 - x0) * (i + r() * 0.8) / n, y + r() * 6, hmin + r() * (hmax - hmin), r) + ' ';
    return d;
  }
  // The ruined keep on the hill: towers with spires, one broken.
  var KEEP =
    'M700 200 V150 L706 150 V118 L712 96 L718 118 V150 H730 V128 H736 V134 H742 V128 H748 V134 H754 V128 H760 V150 H770 V104 L779 66 L788 104 V150 ' +
    'H798 V136 L803 131 L806 140 L811 128 L814 150 H824 V122 L830 104 L836 122 V200 Z';
  var KEEP_WINDOWS = 'M776 112 h6 v10 h-6 Z M709 128 h5 v8 h-5 Z M827 132 h5 v8 h-5 Z';

  function landscape() {
    var r = rng(666);
    var far = ridge(r, 1000, 300, 70, 150, 34);
    var mid = ridge(r, 1000, 300, 150, 190, 46);
    var snow = '';
    // snow on the far peaks: short strokes just under each high point
    far.replace(/L(\d+) (\d+)/g, function (_, x, y) {
      x = +x; y = +y;
      if (y < 112) snow += 'M' + (x - 9) + ' ' + (y + 12) + ' L' + x + ' ' + y + ' L' + (x + 8) + ' ' + (y + 11) + ' ';
      return _;
    });
    var r2 = rng(13);
    return '<svg class="land" viewBox="0 0 1000 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
      '<path d="' + far + '" fill="var(--far,#151722)"/>' +
      '<path d="' + snow + '" fill="none" stroke="var(--snow,#5a627c)" stroke-width="3" stroke-linejoin="round"/>' +
      '<path d="' + mid + '" fill="var(--mid,#0e0f17)"/>' +
      '<path d="M640 300 Q700 196 772 192 Q850 196 900 300 Z" fill="var(--mid,#0e0f17)"/>' +
      '<path d="' + KEEP + '" fill="#07070b"/>' +
      '<path class="keep-light" d="' + KEEP_WINDOWS + '" fill="var(--window,#b3121b)"/>' +
      '<path d="' + forest(r2, 26, 0, 1000, 262, 40, 90) + '" fill="#08080d"/>' +
      '<path d="' + forest(r2, 9, -20, 170, 300, 110, 210) + forest(r2, 9, 830, 1020, 300, 110, 210) + '" fill="#030305"/>' +
      '<path d="M0 300 V262 Q500 248 1000 262 V300 Z" fill="#030305"/>' +
      '</svg>' +
      '<div class="ravens"><svg class="raven r1"><use href="#raven"/></svg><svg class="raven r2"><use href="#raven"/></svg><svg class="raven r3"><use href="#raven"/></svg></div>' +
      '<div class="fog f1"></div><div class="fog f2"></div><div class="ash"></div><div class="ash a2"></div>';
  }

  function injectSky() {
    var skies = document.querySelectorAll('.sky');
    for (var i = 0; i < skies.length; i++) {
      var old = skies[i].querySelector('.roofs');
      if (old) old.remove();
      skies[i].insertAdjacentHTML('beforeend', landscape());
    }
  }

  // The logo: the word in blackletter, thorns grown out of it, mirrored left to right, on a blade.
  function logoSvg() {
    var r = rng(1349), spikes = '', cx = 260;
    function spike(x, y0, len, lean, w) {
      var tip = y0 + len;
      return 'M' + (x - w).toFixed(1) + ' ' + y0 + ' L' + (x + lean).toFixed(1) + ' ' + tip.toFixed(1) + ' L' + (x + w).toFixed(1) + ' ' + y0 + ' Z ';
    }
    for (var i = 0; i < 12; i++) {
      var dx = 10 + i * 17 + r() * 7, up = -(18 + r() * 34 * (1 - i / 16)), down = 14 + r() * 30 * (1 - i / 18);
      var lean = (r() - 0.3) * 10 + i * 1.2, w = 1.6 + r() * 1.6;
      [-1, 1].forEach(function (s) {
        spikes += spike(cx + s * dx, 46, up, s * lean, w);
        if (i % 3 !== 1) spikes += spike(cx + s * dx, 114, down, s * lean * 0.6, w);
        if (i % 4 === 2) spikes += spike(cx + s * (dx + 4), 46 + up * 0.55, up * 0.45, s * (lean + 9), w * 0.6);
      });
    }
    var blade = 'M30 118 L120 114 L400 114 L490 118 L400 122 L120 122 Z';
    return '<svg class="logo-svg" viewBox="0 0 520 160" aria-hidden="true" focusable="false">' +
      '<defs><filter id="logoRough" x="-5%" y="-5%" width="110%" height="110%">' +
      '<feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="9" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/></filter></defs>' +
      '<g filter="url(#logoRough)">' +
      '<path d="' + blade + '" fill="#6d0a10"/>' +
      '<path d="' + spikes + '" fill="#ece6d9"/>' +
      '<text x="260" y="108" text-anchor="middle" font-family="UnifrakturMaguntia, \'Grenze Gotisch\', serif" font-size="104" fill="#ece6d9" stroke="#000" stroke-width="2" paint-order="stroke">Clones</text>' +
      '</g></svg>';
  }
  function injectLogo() {
    var logos = document.querySelectorAll('.logo');
    for (var i = 0; i < logos.length; i++) {
      if (logos[i].querySelector('svg')) continue;
      logos[i].innerHTML = '<span class="sr-only">Clones</span>' + logoSvg();
    }
  }

  // The merchant: a hood in the crypt's gable, nothing inside but two eyes.
  var HOOD = '<svg class="hood" viewBox="0 0 60 50" aria-hidden="true">' +
    '<path d="M30 1.5 Q13 5 7 50 H53 Q47 5 30 1.5 Z" fill="#060509" stroke="#4b4656" stroke-width="1"/>' +
    '<path d="M30 6 Q18 9 15 50 M30 6 Q42 9 45 50" stroke="#1d1a22" stroke-width="1.2" fill="none"/>' +
    '<ellipse cx="30" cy="27" rx="10.5" ry="14" fill="#000"/>' +
    '<path class="hood-eyes" d="M23.5 24.5 L28 25.6 L27.4 26.8 Z M36.5 24.5 L32 25.6 L32.6 26.8 Z" fill="#ff2a35"/>' +
    '</svg>';
  function injectHood() {
    var spots = document.querySelectorAll('.arch .rose');
    for (var i = 0; i < spots.length; i++) spots[i].outerHTML = HOOD;
  }

  injectSprites();
  injectSky();
  injectLogo();
  injectHood();
})();
