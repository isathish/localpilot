/*
 * Live page view counts for the LocalPilot site.
 *
 * Every page load adds one view to the page and to the site total, and a browser's first visit adds one visitor.
 * The counters live on Abacus (https://abacus.jasoncameron.dev: free, no account, no cookies). Elements marked
 * `data-pv="page|total|visitors"` show the numbers and keep updating while the tab is visible, so readers see the
 * count move as other people open the page. Browsers that send Global Privacy Control or Do Not Track are shown the
 * numbers without being counted. Numbers rendered at build time from Google Analytics (data-pv-base) are the floor:
 * a live count never makes a number go down.
 */
(function () {
  'use strict';
  var cfg = document.currentScript && document.currentScript.dataset;
  if (!cfg || !cfg.api || !cfg.ns) { return; }
  var API = cfg.api.replace(/\/+$/, '');
  var NS = cfg.ns;
  var BASE = cfg.base || '';
  var els = Array.prototype.slice.call(document.querySelectorAll('[data-pv]'));
  if (!els.length) { return; }

  // Abacus keys: 3-64 of [A-Za-z0-9_-.]. `/localpilot/docs/models/` → `p.docs.models`, the home page → `p.home`.
  function pageKey() {
    var p = location.pathname;
    if (BASE && p.indexOf(BASE) === 0) { p = p.slice(BASE.length); }
    p = p.replace(/index\.html$/, '').replace(/^\/+|\/+$/g, '');
    var key = 'p.' + (p ? p.replace(/[^A-Za-z0-9_.-]+/g, '.') : 'home');
    return key.length > 64 ? 'p.' + key.slice(-62) : key;
  }
  var KEYS = { page: pageKey(), total: 'site.views', visitors: 'site.visitors' };
  var quiet = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
  var compact = typeof Intl !== 'undefined' && Intl.NumberFormat ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }) : null;
  var full = typeof Intl !== 'undefined' && Intl.NumberFormat ? new Intl.NumberFormat('en') : null;
  var shown = {};

  function fmt(n) {
    if (n < 10000) { return full ? full.format(n) : String(n); }
    return compact ? compact.format(n) : String(n);
  }

  /** Shows `value` for one counter on every element bound to it, counting up from what is on screen now. */
  function show(kind, value) {
    if (typeof value !== 'number' || !isFinite(value)) { return; }
    els.forEach(function (el) {
      if (el.getAttribute('data-pv') !== kind) { return; }
      var floor = Number(el.getAttribute('data-pv-base')) || 0;
      var target = Math.max(value, floor);
      var from = shown[kind] !== undefined ? shown[kind] : floor;
      var wrap = el.closest('[data-pv-wrap]');
      if (wrap && wrap.hidden) {
        wrap.hidden = false;
        if (wrap.classList) { wrap.classList.add('pv-in'); }
      }
      el.title = full ? full.format(target) + ' ' + (kind === 'visitors' ? 'visitors' : 'views') : String(target);
      var bumped = shown[kind] !== undefined && target > from;
      if (typeof el.getAttribute('data-pv-odo') === 'string' && document.createElement) {
        // Home page: rolling odometer digits (CSS transitions, so reduced motion simply jumps), plus a "+N" when it moves.
        odometer(el, fmt(target));
        if (bumped) { flash(el, target - from); }
      } else if (target === from || window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = fmt(target);
      } else {
        animate(el, from, target);
        if (shown[kind] !== undefined && target > from) {
          el.classList.remove('pv-bump'); void el.offsetWidth; el.classList.add('pv-bump');
        }
      }
    });
    shown[kind] = Math.max(value, shown[kind] || 0);
  }

  /**
   * Renders `text` as odometer columns: each digit is a strip of 0–9 that slides to its value, columns staggered
   * left to right. The first render starts every column at 0, so the number rolls up into place; later renders
   * move only the columns that changed. A visually hidden copy of the text is what screen readers announce.
   */
  function odometer(el, text) {
    var shape = text.replace(/\d/g, '0');
    var box = el.querySelector('.odo');
    if (!box || box.getAttribute('data-shape') !== shape) {
      var prev = box ? box.textContent : '';
      el.textContent = '';
      var sr = document.createElement('span');
      sr.className = 'odo-sr';
      box = document.createElement('span');
      box.className = 'odo';
      box.setAttribute('aria-hidden', 'true');
      box.setAttribute('data-shape', shape);
      text.split('').forEach(function (ch) {
        var c = document.createElement('span');
        if (/\d/.test(ch)) {
          c.className = 'odo-col';
          var strip = document.createElement('span');
          strip.className = 'odo-strip';
          for (var d = 0; d <= 9; d++) { var n = document.createElement('span'); n.textContent = String(d); strip.appendChild(n); }
          c.appendChild(strip);
        } else {
          c.className = 'odo-sep';
          c.textContent = ch;
        }
        box.appendChild(c);
      });
      el.appendChild(sr);
      el.appendChild(box);
      // A number that grew a digit (999 → 1,000) keeps its old digits right-aligned so only the change rolls.
      var old = prev.replace(/\D/g, '');
      var strips0 = box.querySelectorAll('.odo-strip');
      for (var k = 0; k < strips0.length; k++) {
        var o = old.charAt(old.length - strips0.length + k);
        strips0[k].style.transform = 'translateY(-' + (Number(o) || 0) * 10 + '%)';
      }
      void box.offsetWidth; // start the transition from there
    }
    el.querySelector('.odo-sr').textContent = text;
    var digits = text.replace(/\D/g, '');
    var strips = box.querySelectorAll('.odo-strip');
    for (var i = 0; i < strips.length; i++) {
      strips[i].style.transitionDelay = (i * 80) + 'ms';
      strips[i].style.transform = 'translateY(-' + Number(digits.charAt(i)) * 10 + '%)';
    }
  }

  /** A live increase: the number glows and a "+N" chip floats up beside it. */
  function flash(el, by) {
    el.classList.remove('pv-bump'); void el.offsetWidth; el.classList.add('pv-bump');
    var host = el.closest('.pv-stat') || el.parentNode;
    if (!host) { return; }
    var chip = document.createElement('span');
    chip.className = 'pv-plus';
    chip.setAttribute('aria-hidden', 'true');
    chip.textContent = '+' + (full ? full.format(by) : by);
    chip.addEventListener('animationend', function () { chip.remove(); });
    host.appendChild(chip);
    setTimeout(function () { if (chip.parentNode) { chip.remove(); } }, 2500);
  }

  function animate(el, from, to) {
    var start = performance.now();
    var ms = Math.min(900, 250 + Math.abs(to - from) * 8);
    function step(now) {
      var t = Math.min(1, (now - start) / ms);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(Math.round(from + (to - from) * eased));
      if (t < 1) { requestAnimationFrame(step); }
    }
    requestAnimationFrame(step);
  }

  function call(op, key) {
    return fetch(API + '/' + op + '/' + encodeURIComponent(NS) + '/' + encodeURIComponent(key), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : r.status === 404 ? { value: 0 } : Promise.reject(r.status); })
      .then(function (j) { return j && typeof j.value === 'number' ? j.value : undefined; });
  }

  var wanted = {};
  els.forEach(function (el) { wanted[el.getAttribute('data-pv')] = true; });

  // Count this load: the page and the site total always (they appear on other pages too), a visitor once per browser.
  var firstVisit = false;
  try { firstVisit = !localStorage.getItem('lp-visited'); if (firstVisit) { localStorage.setItem('lp-visited', '1'); } } catch (e) { /* storage off: not a visitor count */ }
  var counted = {
    page: quiet ? call('get', KEYS.page) : call('hit', KEYS.page),
    total: quiet ? call('get', KEYS.total) : call('hit', KEYS.total),
    visitors: firstVisit && !quiet ? call('hit', KEYS.visitors) : call('get', KEYS.visitors),
  };
  Object.keys(wanted).forEach(function (kind) {
    if (counted[kind]) { counted[kind].then(function (v) { show(kind, v); }, function () { /* offline or blocked: keep the build-time number */ }); }
  });

  // Live: one stream per shown counter while the tab is visible; polling when streams are unavailable.
  var streams = [];
  var poll = null;
  function startLive() {
    stopLive();
    var kinds = Object.keys(wanted).filter(function (k) { return KEYS[k]; });
    if (typeof EventSource === 'undefined') { startPolling(kinds); return; }
    kinds.forEach(function (kind) {
      var es = new EventSource(API + '/stream/' + encodeURIComponent(NS) + '/' + encodeURIComponent(KEYS[kind]));
      es.onmessage = function (ev) {
        try { show(kind, JSON.parse(ev.data).value); } catch (e) { /* keep-alive or partial message */ }
      };
      es.onerror = function () {
        // A stream that cannot stay open (proxy, rate limit) falls back to a gentle poll.
        if (es.readyState === EventSource.CLOSED) { stopLive(); startPolling(kinds); }
      };
      streams.push(es);
    });
  }
  function startPolling(kinds) {
    if (poll) { return; }
    poll = setInterval(function () {
      kinds.forEach(function (kind) { call('get', KEYS[kind]).then(function (v) { show(kind, v); }, function () {}); });
    }, 30000);
  }
  function stopLive() {
    streams.forEach(function (es) { es.close(); });
    streams = [];
    if (poll) { clearInterval(poll); poll = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopLive(); } else {
      Object.keys(wanted).forEach(function (kind) { call('get', KEYS[kind]).then(function (v) { show(kind, v); }, function () {}); });
      startLive();
    }
  });
  window.addEventListener('pagehide', stopLive);
  if (!document.hidden) { startLive(); }
})();
