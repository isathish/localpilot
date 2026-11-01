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
      if (wrap) { wrap.hidden = false; }
      el.title = full ? full.format(target) + ' ' + (kind === 'visitors' ? 'visitors' : 'views') : String(target);
      if (target === from || window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
