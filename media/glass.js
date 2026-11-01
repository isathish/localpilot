// @ts-check
/* LocalPilot liquid glass: the behaviour behind the glass look, shared by the chat, settings and Markdown webviews.
 *  1. Lens: an SVG displacement filter that bends whatever is behind a glass layer near its edges (with a faint
 *     colour split), used by the CSS as `backdrop-filter: url(#lp-lens) …` once <html> carries .lg-lens.
 *  2. Light: the pointer position is written to --mx / --my on the glass element under it, so the specular
 *     highlight (a radial gradient in the CSS) follows the pointer and fades in and out.
 *  3. Liquid selection: a glass pill sits behind the selected item of tab strips, segmented controls and the
 *     settings nav. When the selection moves it stretches toward the new item and settles with a spring.
 * Everything is decoration: if any part fails, the page keeps working with the plain glass styles. */
(function () {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduceGlass = window.matchMedia('(prefers-reduced-transparency: reduce)');
  const highContrast = () => /vscode-high-contrast/.test(doc.body ? doc.body.className : '');

  // ------------------------------------------------------------------ 1. lens filter
  // The displacement map is computed inside the filter, from the filter region itself: a white flood inset by a few
  // pixels and blurred falls off smoothly toward every edge; its left-right and up-down differences become the red
  // and green channels. Content near the rim is sampled from further inside, like light bending through the rounded
  // edge of a lens; the middle (flat 50% grey) is left untouched. (Chromium ignores feImage maps and maps derived
  // from SourceAlpha inside backdrop-filter, which is why the map is built from feFlood.)
  function lens(id, o) {
    const d = o.scale;
    return `
      <filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feFlood flood-color="#fff" result="fl"/>
        <feOffset in="fl" dx="2" result="a1"/><feOffset in="fl" dx="-2" result="a2"/>
        <feOffset in="fl" dy="2" result="a3"/><feOffset in="fl" dy="-2" result="a4"/>
        <feComposite in="a1" in2="a2" operator="in" result="a12"/><feComposite in="a3" in2="a4" operator="in" result="a34"/>
        <feComposite in="a12" in2="a34" operator="in" result="inner"/>
        <feGaussianBlur in="inner" stdDeviation="${o.soft}" result="b"/>
        <feOffset in="b" dx="-${o.reach}" result="bl"/><feOffset in="b" dx="${o.reach}" result="br"/>
        <feOffset in="b" dy="-${o.reach}" result="bt"/><feOffset in="b" dy="${o.reach}" result="bb"/>
        <feComposite in="bl" in2="br" operator="arithmetic" k2="2.5" k3="-2.5" k4="0.5" result="dx"/>
        <feComposite in="bt" in2="bb" operator="arithmetic" k2="2.5" k3="-2.5" k4="0.5" result="dy"/>
        <feColorMatrix in="dx" type="matrix" values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1" result="rx"/>
        <feColorMatrix in="dy" type="matrix" values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1" result="gy"/>
        <feComposite in="rx" in2="gy" operator="arithmetic" k2="1" k3="1" result="map"/>
        <feDisplacementMap in="SourceGraphic" in2="map" scale="${d}" xChannelSelector="R" yChannelSelector="G" result="d1"/>
        <feDisplacementMap in="SourceGraphic" in2="map" scale="${(d * 1.04).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="d2"/>
        <feColorMatrix in="d1" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="c1"/>
        <feColorMatrix in="d2" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="c2"/>
        <feBlend in="c1" in2="c2" mode="screen"/>
      </filter>`;
  }
  function installLens() {
    if (doc.getElementById('lp-glass-defs')) { return; }
    const holder = doc.createElement('div');
    holder.id = 'lp-glass-defs';
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    holder.innerHTML = `<svg width="0" height="0" focusable="false"><defs>${lens('lp-lens', { scale: 30, soft: 8, reach: 6 })}${lens('lp-lens-sm', { scale: 16, soft: 5, reach: 4 })}</defs></svg>`;
    doc.body.appendChild(holder);
  }
  // The lens is Chromium-only (SVG filters in backdrop-filter) and is skipped when the user asked for less
  // transparency or a high-contrast theme is active; the CSS only references #lp-lens under .lg-lens.
  function syncLens() {
    const on = !reduceGlass.matches && !highContrast() && CSS.supports('backdrop-filter', 'url(#lp-lens)');
    root.classList.toggle('lg-lens', on);
  }

  // ------------------------------------------------------------------ 2. pointer light
  // Elements that catch the light; the CSS paints `radial-gradient(… at var(--mx) var(--my) …)` on them.
  const LIT = '.lg-lit, .btn, .card, .panel, .approval, .plan, .suggestion, .idea, .par-card, .popover, #box, .prov, .preset, .kpi, .gal-tab, .ap, .srv, .mdl, .find-box, .recent-row, .afoot .acts button, .tab, .ib, .send';
  let lit = null; let px = 0; let py = 0; let lightQueued = false;
  function paintLight() {
    lightQueued = false;
    const t = doc.elementFromPoint(px, py);
    const hit = t && t.closest ? t.closest(LIT) : null;
    if (lit && lit !== hit) { lit.classList.remove('lg-on'); }
    lit = hit;
    if (!hit) { return; }
    const r = hit.getBoundingClientRect();
    hit.style.setProperty('--mx', `${(((px - r.left) / Math.max(1, r.width)) * 100).toFixed(1)}%`);
    hit.style.setProperty('--my', `${(((py - r.top) / Math.max(1, r.height)) * 100).toFixed(1)}%`);
    hit.classList.add('lg-on');
  }
  function onPointer(e) {
    if (e.pointerType === 'touch') { return; }
    px = e.clientX; py = e.clientY;
    if (!lightQueued) { lightQueued = true; requestAnimationFrame(paintLight); }
  }

  // ------------------------------------------------------------------ 3. liquid selection
  /** Groups: where the indicator lives, which child is selected, and the root whose changes may move it. */
  const GROUPS = [
    { box: '#tabs', on: '.tab.active', watch: '#tabbar' },
    { box: '.top .scope', on: 'button.on', watch: '#app' },
    { box: '.seg', on: 'button.on', watch: '#app' },
    { box: '.side', on: 'a[data-sec].on', watch: '#app' },
  ];
  /** Last indicator geometry and the move in flight, per control. Keyed by a stable identity (id or accessible
   *  label) rather than the element: a settings field is rebuilt right after you pick an option, and the new
   *  indicator has to carry on the move the old one started instead of snapping. */
  const last = new Map();
  const moving = new Map();
  const ids = new WeakMap(); let nextId = 0;
  const keyOf = (grp, box) => `${grp.box}|${box.id || box.getAttribute('aria-label') || (ids.has(box) ? ids.get(box) : (ids.set(box, `#${++nextId}`), ids.get(box)))}`;
  const DURATION = 460;
  const EASE = 'cubic-bezier(.3,1.35,.5,1)';
  let queued = false;
  function schedule() { if (!queued) { queued = true; requestAnimationFrame(update); } }
  function rectIn(box, item) {
    const b = box.getBoundingClientRect(); const r = item.getBoundingClientRect();
    return { x: r.left - b.left + box.scrollLeft - box.clientLeft, y: r.top - b.top + box.scrollTop - box.clientTop, w: r.width, h: r.height };
  }
  function place(ind, g) { ind.style.transform = `translate(${g.x}px, ${g.y}px)`; ind.style.width = `${g.w}px`; ind.style.height = `${g.h}px`; }
  function update() {
    queued = false;
    for (const grp of GROUPS) {
      for (const box of doc.querySelectorAll(grp.box)) {
        const on = box.querySelector(grp.on);
        let ind = box.querySelector(':scope > .lg-ind');
        if (!on || !on.offsetParent) { if (ind) { ind.style.opacity = '0'; } continue; }
        const key = keyOf(grp, box);
        const fresh = !ind;
        if (!ind) { ind = doc.createElement('span'); ind.className = 'lg-ind'; ind.setAttribute('aria-hidden', 'true'); box.prepend(ind); }
        box.classList.add('lg-has-ind');
        const to = rectIn(box, on);
        const from = last.get(key);
        last.set(key, to);
        // A rebuilt control: resume the move its predecessor was making, at the same point in time.
        const flight = moving.get(key);
        if (fresh && flight && !reduceMotion.matches && ind.animate && performance.now() - flight.start < DURATION && Math.abs(flight.to.x - to.x) < 2 && Math.abs(flight.to.y - to.y) < 2) {
          place(ind, to);
          ind._anim = ind.animate(flight.frames, { duration: DURATION, easing: EASE });
          ind._anim.currentTime = performance.now() - flight.start;
          continue;
        }
        ind.style.opacity = '1';
        const moved = from && (Math.abs(from.x - to.x) > 1 || Math.abs(from.y - to.y) > 1);
        // Nothing moved: leave a move in flight alone (unrelated changes elsewhere also land here) and keep the size current.
        if (!moved) { place(ind, to); continue; }
        if (reduceMotion.matches || !ind.animate) { if (ind._anim) { ind._anim.cancel(); } place(ind, to); continue; }
        // The liquid move: the pill first stretches to cover both items, then lets go of the old one and settles
        // with a small overshoot, like a drop of liquid flowing to the new spot.
        const span = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.max(from.x + from.w, to.x + to.w) - Math.min(from.x, to.x), h: Math.max(from.y + from.h, to.y + to.h) - Math.min(from.y, to.y) };
        const k = (g) => ({ transform: `translate(${g.x}px, ${g.y}px)`, width: `${g.w}px`, height: `${g.h}px` });
        if (ind._anim) { ind._anim.cancel(); }
        place(ind, to);
        const frames = [k(from), { ...k(span), offset: 0.42 }, k(to)];
        ind._anim = ind.animate(frames, { duration: DURATION, easing: EASE });
        moving.set(key, { frames, to, start: performance.now() });
      }
    }
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    try { installLens(); } catch { /* decoration only */ }
    syncLens();
    reduceGlass.addEventListener?.('change', syncLens);
    doc.addEventListener('pointermove', onPointer, { passive: true });
    doc.addEventListener('pointerleave', () => { if (lit) { lit.classList.remove('lg-on'); lit = null; } });
    // Watch only the roots that can move a selection; the chat transcript (which streams) is never observed.
    const mo = new MutationObserver(schedule);
    const watched = new Set();
    const watch = () => {
      for (const sel of new Set(GROUPS.map((g) => g.watch))) {
        const el = doc.querySelector(sel);
        if (el && !watched.has(el)) { watched.add(el); mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); }
      }
    };
    watch();
    // Pages build their shell after load (settings), and the high-contrast class lands on <body> late.
    new MutationObserver(() => { watch(); syncLens(); schedule(); }).observe(doc.body, { childList: true, attributes: true, attributeFilter: ['class'] });
    // No scroll listener: indicators live inside their scrolling containers and move with them, and listening to
    // scroll would run layout reads on every frame of the chat's auto-scroll while a reply streams.
    window.addEventListener('resize', schedule);
    schedule();
  }
  if (doc.readyState === 'loading') { doc.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
