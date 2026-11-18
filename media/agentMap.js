// LocalPilot Agent map webview. Vanilla JS. The host (src/ui/agentMap.ts) sends the model built by agentMapData.ts; every
// change is sent back as an action and applied through the same settings and managers Settings uses.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const toasts = document.getElementById('toasts');
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };
  const reduced = () => document.body.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Same inline icon set as the other webviews (16px, stroke-drawn).
  const I = {
    bolt: '<svg viewBox="0 0 16 16"><path d="M9 1.5L3.5 9h4l-.5 5.5L13 7H9z"/></svg>',
    chip: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 1.5v1.5M10 1.5v1.5M6 13v1.5M10 13v1.5M1.5 6h1.5M1.5 10h1.5M13 6h1.5M13 10h1.5"/><rect x="6" y="6" width="4" height="4"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H9l-3 2.5V11H4.5A1.5 1.5 0 0 1 3 9.5z"/></svg>',
    star: '<svg viewBox="0 0 16 16"><path d="M8 2l1.8 3.7 4.2.6-3 2.9.7 4.1L8 11.4l-3.7 1.9.7-4.1-3-2.9 4.2-.6z"/></svg>',
    bot: '<svg viewBox="0 0 16 16"><rect x="2.5" y="5" width="11" height="8.5" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01M1 9v1.5M15 9v1.5"/></svg>',
    book: '<svg viewBox="0 0 16 16"><path d="M3 3h4a2 2 0 0 1 2 2v9a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H9a2 2 0 0 0-2 2v9a1.5 1.5 0 0 1 1.5-1.5H13z"/></svg>',
    wrench: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5a3.5 3.5 0 0 0 3.8 4.7L8 12.5a1.8 1.8 0 0 1-2.5-2.5l5.3-5.3a3.5 3.5 0 0 0-1.3-2.2z"/></svg>',
    plug: '<svg viewBox="0 0 16 16"><path d="M5 2v4M11 2v4M4 6h8v2a4 4 0 0 1-8 0zM8 12v2.5"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
    edit: '<svg viewBox="0 0 16 16"><path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/><path d="M9 4.5l2.5 2.5"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9h5.6l.7-9"/></svg>',
    terminal: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3"/></svg>',
    globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 2 9.8 0 12M8 2c-2 2.2-2 9.8 0 12"/></svg>',
    layers: '<svg viewBox="0 0 16 16"><path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/></svg>',
    gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    minus: '<svg viewBox="0 0 16 16"><path d="M3 8h10"/></svg>',
    fit: '<svg viewBox="0 0 16 16"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    graph: '<svg viewBox="0 0 16 16"><rect x="1.5" y="6" width="4" height="4" rx="1"/><rect x="10.5" y="2" width="4" height="4" rx="1"/><rect x="10.5" y="10" width="4" height="4" rx="1"/><path d="M5.5 8h2.5M8 4v8M8 4h2.5M8 12h2.5"/></svg>',
    list: '<svg viewBox="0 0 16 16"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>',
    route: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="12.5" r="1.5"/><circle cx="12.5" cy="3.5" r="1.5"/><path d="M5 12.5h4.5a2 2 0 0 0 0-4h-3a2 2 0 0 1 0-4H11"/></svg>',
    back: '<svg viewBox="0 0 16 16"><path d="M10 4L6 8l4 4"/></svg>',
    arrow: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/></svg>',
  };
  const KIND_ICON = { auto: I.bolt, role: I.chip, mode: I.chat, specialist: I.star, subagent: I.bot, skill: I.book, tools: I.wrench, mcp: I.plug };
  const GROUP_ICON = { 'tools:read': I.search, 'tools:write': I.edit, 'tools:delete': I.trash, 'tools:terminal': I.terminal, 'tools:network': I.globe, 'tools:delegate': I.layers };
  const KIND_NAME = { auto: 'Auto router', role: 'Model role', mode: 'Mode', specialist: 'Specialist', subagent: 'Subagent', skill: 'Skill', tools: 'Tool group', mcp: 'MCP server' };
  const COLS = ['Auto & models', 'Modes', 'Subagents', 'Skills', 'Tools & MCP'];
  const FILTERS = [['all', 'All'], ['agents', 'Agents'], ['skills', 'Skills'], ['tools', 'Tools']];
  const FILTER_KINDS = { agents: ['auto', 'role', 'mode', 'specialist', 'subagent'], skills: ['skill'], tools: ['tools', 'mcp'] };
  const OUT = { route: 'Auto sends here', 'runs-in': 'Runs in', playbook: 'Playbook', delegate: 'Can start', preload: 'Preloads', skill: 'Can load skills', tool: 'Can use tools', model: 'Model role' };
  const IN = { route: 'Picked by Auto for', 'runs-in': 'Specialists on this mode', playbook: 'Playbook of', delegate: 'Started by', preload: 'Preloaded by', skill: 'Loadable by', tool: 'Used by', model: 'Used by' };
  const NODE_W = 200, NODE_H = 54, GAP_X = 76, GAP_Y = 10, HEAD = 30, PAD = 24;

  const saved = vscode.getState() || {};
  const S = {
    model: null,
    view: saved.view || 'graph',
    userView: !!saved.userView,
    filter: saved.filter || 'all',
    q: saved.q || '',
    sel: saved.sel || '',
    hot: '',
    focusId: saved.focusId || 'auto',
    k: saved.k || 1, tx: saved.tx ?? 0, ty: saved.ty ?? 0,
    fitted: !!saved.fitted,
    route: null,
    narrow: false,
  };
  const save = () => vscode.setState({ view: S.view, userView: S.userView, filter: S.filter, q: S.q, sel: S.sel, focusId: S.focusId, k: S.k, tx: S.tx, ty: S.ty, fitted: S.fitted });

  // ------------------------------------------------------------------ skeleton
  app.removeAttribute('aria-busy');
  app.innerHTML = `
  <header class="bar">
    <div class="row title-row">
      <h1>Agent map</h1>
      <p class="counts" id="counts"></p>
      <span class="spacer"></span>
      <button class="btn" id="newAgent" title="Create a subagent file" aria-label="New subagent">${I.plus}<span class="lbl">Subagent</span><span class="nar" aria-hidden="true">${I.bot}</span></button>
      <button class="btn" id="newSkill" title="Create a skill" aria-label="New skill">${I.plus}<span class="lbl">Skill</span><span class="nar" aria-hidden="true">${I.book}</span></button>
      <button class="icon-btn" id="refresh" title="Refresh" aria-label="Refresh">${I.refresh}</button>
    </div>
    <div class="row ctl-row">
      <label class="search">${I.search}<span class="sr">Filter</span><input id="q" type="search" placeholder="Filter by name, kind or source" autocomplete="off" spellcheck="false" /></label>
      <div class="chips" id="filters"></div>
      <div class="seg" id="views"></div>
    </div>
    <form class="row try" id="try" autocomplete="off">
      <label for="tryIn">${I.route}<span>Try a message</span></label>
      <input id="tryIn" placeholder="Try: the login test fails with a TypeError" spellcheck="false" />
      <button class="icon-btn" type="button" id="tryClear" title="Clear" aria-label="Clear the message">${I.x}</button>
    </form>
    <p class="try-out" id="tryOut" aria-live="polite"></p>
  </header>
  <main class="body" id="body">
    <section class="graph" id="graph" aria-label="Agent map graph">
      <p class="sr" id="graphHelp">Arrow keys move between agents, Enter opens details, plus and minus zoom, 0 fits the map, Shift with arrows pans.</p>
      <div class="world" id="world"><svg class="edges" id="edges" aria-hidden="true"></svg><div id="nodes" role="group" aria-describedby="graphHelp"></div></div>
      <div class="zoom" role="toolbar" aria-label="Zoom">
        <button class="icon-btn" id="zoomOut" title="Zoom out (−)" aria-label="Zoom out">${I.minus}</button>
        <span id="zoomPct" aria-live="off">100%</span>
        <button class="icon-btn" id="zoomIn" title="Zoom in (+)" aria-label="Zoom in">${I.plus}</button>
        <button class="icon-btn" id="zoomFit" title="Fit (0)" aria-label="Fit the map">${I.fit}</button>
      </div>
    </section>
    <section class="list" id="list" aria-label="Agent map list"></section>
    <aside class="insp" id="insp" aria-label="Details" hidden></aside>
  </main>`;
  const $ = (id) => document.getElementById(id);
  const els = { counts: $('counts'), q: $('q'), filters: $('filters'), views: $('views'), tryIn: $('tryIn'), tryOut: $('tryOut'), graph: $('graph'), world: $('world'), edges: $('edges'), nodes: $('nodes'), list: $('list'), insp: $('insp'), zoomPct: $('zoomPct'), body: $('body') };
  els.q.value = S.q;

  /** A strip of one-of-many buttons (radiogroup) with a roving tabindex: arrows move and select. */
  function radioStrip(host, items, cur, label, onPick) {
    host.setAttribute('role', 'radiogroup');
    host.setAttribute('aria-label', label);
    host.innerHTML = '';
    items.forEach(([k, text, icon]) => {
      const b = el('button', k === cur ? 'on' : '', `${icon || ''}<span>${esc(text)}</span>`);
      b.type = 'button'; b.dataset.k = k; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === cur)); b.tabIndex = k === cur ? 0 : -1;
      b.onclick = () => onPick(k);
      host.appendChild(b);
    });
    host.onkeydown = (e) => {
      const bs = [...host.children]; const i = bs.indexOf(document.activeElement);
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d || i < 0) { return; }
      e.preventDefault(); const k = bs[(i + d + bs.length) % bs.length].dataset.k; onPick(k);
      const n = [...host.children].find((b) => b.dataset.k === k); if (n) { n.focus(); }
    };
  }
  function renderControls() {
    radioStrip(els.filters, FILTERS, S.filter, 'Show', (k) => { S.filter = k; save(); renderControls(); applyFilter(); });
    radioStrip(els.views, [['graph', 'Graph', I.graph], ['list', 'List', I.list]], S.view, 'View', (k) => { S.view = k; S.userView = true; save(); renderControls(); renderView(); });
  }

  // ------------------------------------------------------------------ helpers over the model
  const byId = () => new Map(S.model.nodes.map((n) => [n.id, n]));
  const matches = (n) => (S.filter === 'all' || FILTER_KINDS[S.filter].includes(n.kind)) && (!S.q.trim() || S.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => n.search.includes(w)));
  const edgesOf = (id) => S.model.edges.filter((e) => e.from === id || e.to === id);
  const pathSet = () => new Set(S.route ? S.route.path : []);
  /** The edges a tried message follows: Auto → its target, the target's base mode and playbook, and the model role it gets. */
  const onPathEdge = (e) => {
    const p = S.route ? S.route.path : []; if (!p.length) { return false; }
    const target = p[1], role = p[p.length - 1];
    return (e.kind === 'route' && e.from === 'auto' && e.to === target) || ((e.kind === 'runs-in' || e.kind === 'playbook') && e.from === target && p.includes(e.to)) || (e.kind === 'model' && e.from === target && e.to === role);
  };

  /** Deterministic layered layout: one column per layer, nodes stacked in model order under their group headings. */
  function layout() {
    const pos = new Map(); const heads = []; const ys = [PAD, PAD, PAD, PAD, PAD]; const lastGroup = [];
    for (const n of S.model.nodes) {
      const c = n.col; const x = PAD + c * (NODE_W + GAP_X);
      if (lastGroup[c] !== n.group) { if (lastGroup[c] !== undefined) { ys[c] += 8; } heads.push({ x, y: ys[c], text: n.group }); ys[c] += HEAD; lastGroup[c] = n.group; }
      pos.set(n.id, { x, y: ys[c], w: NODE_W, h: NODE_H, col: c });
      ys[c] += NODE_H + GAP_Y;
    }
    return { pos, heads, w: PAD * 2 + 5 * NODE_W + 4 * GAP_X, h: Math.max(...ys) + PAD };
  }
  let L = null;

  // ------------------------------------------------------------------ graph
  function edgePath(a, b) {
    if (a.col === b.col) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, bulge = 36 + Math.min(60, Math.abs(y2 - y1) / 6);
      return `M${x1} ${y1} C${x1 + bulge} ${y1} ${x2 + bulge} ${y2} ${x2} ${y2}`;
    }
    const fwd = b.col > a.col;
    const x1 = fwd ? a.x + a.w : a.x, y1 = a.y + a.h / 2, x2 = fwd ? b.x : b.x + b.w, y2 = b.y + b.h / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
    return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  }
  function renderGraph() {
    const had = document.activeElement && document.activeElement.classList.contains('node') ? document.activeElement.dataset.id : '';
    L = layout();
    els.world.style.width = `${L.w}px`; els.world.style.height = `${L.h}px`;
    els.edges.style.width = `${L.w}px`; els.edges.style.height = `${L.h}px`; els.edges.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
    els.edges.innerHTML = S.model.edges.map((e, i) => {
      const a = L.pos.get(e.from), b = L.pos.get(e.to);
      return a && b ? `<path data-i="${i}" class="e k-${e.kind} t-${e.tier}" d="${edgePath(a, b)}"/>` : '';
    }).join('');
    const ids = byId();
    els.nodes.innerHTML = L.heads.map((h) => `<div class="col-head" style="left:${h.x}px;top:${h.y}px;width:${NODE_W}px" aria-hidden="true">${esc(h.text)}</div>`).join('') +
      S.model.nodes.map((n) => {
        const p = L.pos.get(n.id);
        return `<button type="button" class="node k-${n.kind}${n.status ? ` s-${n.status}` : ''}" data-id="${esc(n.id)}" tabindex="-1" style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px" aria-label="${esc(`${KIND_NAME[n.kind]}: ${n.label}. ${n.sub || ''}${n.status === 'off' ? '. Off' : n.status === 'error' ? '. Error' : ''}`)}">
          <span class="ic" aria-hidden="true">${GROUP_ICON[n.id] || KIND_ICON[n.kind]}</span>
          <span class="tx"><span class="nm">${esc(n.label)}</span><span class="sb">${esc(n.sub || '')}</span></span>
          ${n.status === 'off' ? '<span class="st" aria-hidden="true">off</span>' : n.status === 'error' ? '<span class="st err" aria-hidden="true">error</span>' : n.status === 'warn' ? '<span class="st warn" aria-hidden="true">!</span>' : ''}
        </button>`;
      }).join('');
    if (!ids.has(S.focusId)) { S.focusId = 'auto'; }
    const f = nodeEl(S.focusId); if (f) { f.tabIndex = 0; }
    // A redraw (settings changed) keeps keyboard focus where it was.
    if (had) { const b = nodeEl(had); if (b) { b.focus({ preventScroll: true }); } }
    els.nodes.querySelectorAll('.node').forEach((b) => {
      b.onclick = () => select(b.dataset.id);
      b.onmouseenter = () => setHot(b.dataset.id);
      b.onmouseleave = () => setHot(document.activeElement && document.activeElement.classList.contains('node') ? document.activeElement.dataset.id : '');
      b.onfocus = () => { setRoving(b.dataset.id); setHot(b.dataset.id); reveal(b.dataset.id); };
      b.onblur = () => setTimeout(() => { if (!els.nodes.contains(document.activeElement)) { setHot(''); } }, 0);
    });
    applyFilter(); paintHot();
    if (!S.fitted) { requestAnimationFrame(() => { fit(); S.fitted = true; save(); }); } else { applyTransform(); }
  }
  const nodeEl = (id) => els.nodes.querySelector(`.node[data-id="${CSS.escape(id)}"]`);
  function setRoving(id) {
    S.focusId = id; save();
    els.nodes.querySelectorAll('.node').forEach((b) => { b.tabIndex = b.dataset.id === id ? 0 : -1; });
  }
  function setHot(id) { S.hot = id; paintHot(); }
  /** Highlights the hovered/focused/selected node's edges and neighbours, and the path a tried message takes. */
  function paintHot() {
    if (!S.model || !L) { return; }
    const focus = new Set([S.hot, S.sel].filter(Boolean));
    const near = new Set(); const ps = pathSet();
    els.edges.querySelectorAll('path').forEach((p) => {
      const e = S.model.edges[+p.dataset.i];
      const hot = focus.has(e.from) || focus.has(e.to);
      if (hot) { near.add(e.from); near.add(e.to); }
      p.classList.toggle('hot', hot); p.classList.toggle('path', onPathEdge(e));
    });
    els.graph.classList.toggle('has-hot', focus.size > 0);
    els.nodes.querySelectorAll('.node').forEach((b) => {
      const id = b.dataset.id;
      b.classList.toggle('near', near.has(id) || focus.has(id)); b.classList.toggle('sel', id === S.sel); b.classList.toggle('path', ps.has(id));
      b.setAttribute('aria-pressed', String(id === S.sel));
    });
  }
  function applyFilter() {
    if (!S.model) { return; }
    const ids = new Set(S.model.nodes.filter(matches).map((n) => n.id));
    els.nodes.querySelectorAll('.node').forEach((b) => b.classList.toggle('dim', !ids.has(b.dataset.id)));
    els.edges.querySelectorAll('path').forEach((p) => { const e = S.model.edges[+p.dataset.i]; p.classList.toggle('dim', !(ids.has(e.from) && ids.has(e.to))); });
    if (S.view === 'list') { renderList(); }
  }

  // Pan and zoom: drag the background, wheel pans (pinch or Ctrl/⌘+wheel zooms), keys + − 0 and Shift+arrows.
  function applyTransform() {
    els.world.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.k})`;
    els.zoomPct.textContent = `${Math.round(S.k * 100)}%`;
  }
  function zoomAt(k, cx, cy) {
    const nk = Math.min(2, Math.max(0.25, k));
    const r = els.graph.getBoundingClientRect(); const x = cx ?? r.width / 2, y = cy ?? r.height / 2;
    S.tx = x - ((x - S.tx) * nk) / S.k; S.ty = y - ((y - S.ty) * nk) / S.k; S.k = nk; applyTransform(); save();
  }
  function fit() {
    if (!L) { return; }
    const r = els.graph.getBoundingClientRect(); if (!r.width) { return; }
    S.k = Math.min(1, Math.max(0.25, Math.min(r.width / L.w, (r.height - 8) / L.h)));
    S.tx = Math.max(0, (r.width - L.w * S.k) / 2); S.ty = 0; applyTransform(); save();
  }
  /** Keeps the focused node on screen. */
  function reveal(id) {
    const p = L && L.pos.get(id); if (!p) { return; }
    const r = els.graph.getBoundingClientRect(); const m = 24;
    const x1 = S.tx + p.x * S.k, y1 = S.ty + p.y * S.k, x2 = x1 + p.w * S.k, y2 = y1 + p.h * S.k;
    let dx = 0, dy = 0;
    if (x1 < m) { dx = m - x1; } else if (x2 > r.width - m) { dx = r.width - m - x2; }
    if (y1 < m) { dy = m - y1; } else if (y2 > r.height - m) { dy = r.height - m - y2; }
    if (dx || dy) { S.tx += dx; S.ty += dy; applyTransform(); save(); }
  }
  let drag = null;
  els.graph.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.node, .zoom')) { return; }
    drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty }; els.graph.setPointerCapture(e.pointerId); els.graph.classList.add('dragging');
  });
  els.graph.addEventListener('pointermove', (e) => { if (drag) { S.tx = drag.tx + e.clientX - drag.x; S.ty = drag.ty + e.clientY - drag.y; applyTransform(); } });
  const endDrag = () => { if (drag) { drag = null; els.graph.classList.remove('dragging'); save(); } };
  els.graph.addEventListener('pointerup', endDrag); els.graph.addEventListener('pointercancel', endDrag);
  els.graph.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = els.graph.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) { zoomAt(S.k * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); } else { S.tx -= e.deltaX; S.ty -= e.deltaY; applyTransform(); save(); }
  }, { passive: false });
  $('zoomIn').onclick = () => zoomAt(S.k * 1.2); $('zoomOut').onclick = () => zoomAt(S.k / 1.2); $('zoomFit').onclick = () => fit();

  /** Arrow keys walk the graph: up/down within a column, left/right to the nearest node of the next non-empty column. */
  els.nodes.addEventListener('keydown', (e) => {
    const cur = e.target.closest('.node'); if (!cur) { return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); return zoomAt(S.k * 1.2); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); return zoomAt(S.k / 1.2); }
    if (e.key === '0') { e.preventDefault(); return fit(); }
    if (e.key === 'Escape' && S.sel) { e.preventDefault(); return select(''); }
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (e.shiftKey && arrows[e.key]) { e.preventDefault(); const [dx, dy] = arrows[e.key]; S.tx -= dx * 60; S.ty -= dy * 60; applyTransform(); save(); return; }
    const id = cur.dataset.id; const p = L.pos.get(id);
    const visible = S.model.nodes.filter(matches).map((n) => n.id).concat(id);
    const inCol = (c) => S.model.nodes.filter((n) => n.col === c && visible.includes(n.id)).map((n) => n.id);
    let to;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const col = inCol(p.col); const i = col.indexOf(id); to = col[i + (e.key === 'ArrowDown' ? 1 : -1)]; }
    else if (e.key === 'Home' || e.key === 'End') { const col = inCol(p.col); to = e.key === 'Home' ? col[0] : col[col.length - 1]; }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const d = e.key === 'ArrowRight' ? 1 : -1;
      for (let c = p.col + d; c >= 0 && c < COLS.length && !to; c += d) {
        const col = inCol(c); let best = Infinity;
        col.forEach((n) => { const q = L.pos.get(n); const dist = Math.abs(q.y - p.y); if (dist < best) { best = dist; to = n; } });
      }
    } else { return; }
    e.preventDefault();
    if (to) { const b = nodeEl(to); if (b) { setRoving(to); b.focus(); } }
  });

  // ------------------------------------------------------------------ list
  function renderList() {
    const ps = pathSet(); const shown = S.model.nodes.filter(matches);
    if (!shown.length) { els.list.innerHTML = `<p class="empty">Nothing matches “${esc(S.q)}”.</p>`; return; }
    let html = ''; let col = -1; let group = '';
    for (const n of shown) {
      if (n.col !== col) { if (col >= 0) { html += '</ul></div>'; } col = n.col; group = ''; html += `<div class="lcol"><h2>${esc(COLS[col])}</h2>`; }
      if (n.group !== group) {
        if (group) { html += '</ul>'; } group = n.group; const gid = `g-${col}-${slug(group)}`;
        // A group named like its column ("Modes" under MODES) needs no second heading.
        html += group.toLowerCase() === COLS[col].toLowerCase() ? `<ul aria-label="${esc(group)}">` : `<h3 id="${gid}">${esc(group)}</h3><ul aria-labelledby="${gid}">`;
      }
      html += `<li><button type="button" class="lrow k-${n.kind}${n.status ? ` s-${n.status}` : ''}${n.id === S.sel ? ' sel' : ''}${ps.has(n.id) ? ' path' : ''}" data-id="${esc(n.id)}" aria-pressed="${n.id === S.sel}">
        <span class="ic" aria-hidden="true">${GROUP_ICON[n.id] || KIND_ICON[n.kind]}</span>
        <span class="tx"><span class="nm">${esc(n.label)}<span class="sr">, ${esc(KIND_NAME[n.kind])}</span></span><span class="sb">${esc(n.sub || '')}</span></span>
        ${n.status === 'off' ? '<span class="pill">off</span>' : n.status === 'error' ? '<span class="pill err">error</span>' : n.status === 'warn' ? '<span class="pill warn">attention</span>' : ''}
        ${ps.has(n.id) ? '<span class="pill path">on route</span>' : ''}
      </button></li>`;
    }
    html += '</ul></div>';
    const fid = document.activeElement && document.activeElement.classList.contains('lrow') ? document.activeElement.dataset.id : '';
    els.list.innerHTML = html;
    els.list.querySelectorAll('.lrow').forEach((b) => { b.onclick = () => select(b.dataset.id); });
    if (fid) { const b = els.list.querySelector(`.lrow[data-id="${CSS.escape(fid)}"]`); if (b) { b.focus({ preventScroll: true }); } }
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  function renderView() {
    els.body.dataset.view = S.view;
    els.graph.hidden = S.view !== 'graph'; els.list.hidden = S.view !== 'list';
    if (!S.model) { return; }
    if (S.view === 'graph') { renderGraph(); } else { renderList(); }
  }

  // ------------------------------------------------------------------ inspector
  function select(id) {
    const was = S.sel; S.sel = id; save();
    if (S.view === 'graph') { paintHot(); } else { renderList(); }
    renderInspector(was !== id && !!id);
    if (!id) { const back = S.view === 'graph' ? nodeEl(S.focusId) : els.list.querySelector(`.lrow[data-id="${CSS.escape(was)}"]`); if (back) { back.focus({ preventScroll: true }); } }
  }
  function renderInspector(moveFocus) {
    const n = S.sel && S.model && byId().get(S.sel);
    els.body.classList.toggle('has-insp', !!n);
    if (!n) { els.insp.hidden = true; els.insp.innerHTML = ''; return; }
    els.insp.hidden = false;
    const ids = byId();
    const conn = {};
    for (const e of edgesOf(n.id)) {
      const out = e.from === n.id; const other = ids.get(out ? e.to : e.from); if (!other) { continue; }
      const key = (out ? OUT : IN)[e.kind]; (conn[key] = conn[key] || []).push(other);
    }
    const can = n.can ? `<ul class="can" aria-label="What it may do">${[['Reads', n.can.reads], ['Edits', n.can.edits], ['Runs commands', n.can.runs]].map(([k, v]) => `<li class="${v === 'No' ? 'no' : v === 'Yes' ? 'yes' : 'part'}"><span aria-hidden="true">${v === 'No' ? I.x : I.check}</span>${esc(k)}: <b>${esc(v)}</b></li>`).join('')}</ul>` : '';
    const facts = n.facts.length ? `<dl class="facts">${n.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
    const actions = n.actions.length ? `<div class="actions">${n.actions.map(actionHtml).join('')}</div>` : '';
    const items = n.items ? `<h3>Tools <span class="muted">${n.items.filter((t) => t.on).length}/${n.items.length} on</span></h3><ul class="items">${n.items.map((t) => `<li><div class="tx"><code>${esc(t.name)}</code><span class="sb">${esc(t.desc)}</span></div>${t.action ? switchHtml(t.action, `${t.name}`) : ''}</li>`).join('')}</ul>` : '';
    const conns = Object.entries(conn).map(([k, list]) => `<h3>${esc(k)} <span class="muted">${list.length}</span></h3><div class="links${list.length > 12 ? ' clip' : ''}">${list.map((o) => `<button type="button" class="link k-${o.kind}" data-go="${esc(o.id)}"><span class="ic" aria-hidden="true">${GROUP_ICON[o.id] || KIND_ICON[o.kind]}</span>${esc(o.label)}</button>`).join('')}${list.length > 12 ? `<button type="button" class="more" data-more>Show all ${list.length}</button>` : ''}</div>`).join('');
    els.insp.innerHTML = `
      <div class="ihead">
        <button class="icon-btn back" id="inspClose" title="Close details (Esc)" aria-label="Close details">${S.narrow ? I.back : I.x}</button>
        <span class="ic k-${n.kind}" aria-hidden="true">${GROUP_ICON[n.id] || KIND_ICON[n.kind]}</span>
        <div class="tx"><span class="kind">${esc(KIND_NAME[n.kind])}</span><h2 id="inspTitle" tabindex="-1">${esc(n.label)}</h2></div>
      </div>
      ${n.badges.length ? `<p class="badges">${n.badges.map((b) => `<span class="pill${/disabled|routing off|blocked|error/.test(b) ? ' off' : ''}">${esc(b)}</span>`).join('')}</p>` : ''}
      <p class="desc">${esc(n.desc)}</p>
      ${can}${actions}${facts}${items}${conns}`;
    els.insp.setAttribute('aria-labelledby', 'inspTitle');
    $('inspClose').onclick = () => select('');
    els.insp.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { select(b.dataset.go); if (S.view === 'graph') { const nb = nodeEl(b.dataset.go); if (nb) { setRoving(b.dataset.go); reveal(b.dataset.go); } } }; });
    els.insp.querySelectorAll('[data-more]').forEach((b) => { b.onclick = () => { b.parentElement.classList.remove('clip'); b.remove(); }; });
    wireActions(els.insp, n);
    if (moveFocus) { $('inspTitle').focus({ preventScroll: true }); }
  }
  function switchHtml(a, label) {
    return `<button type="button" class="switch" role="switch" aria-checked="${a.on}" data-act="${esc(a.id)}" data-arg="${esc(a.arg)}" aria-label="${esc(label || a.label)}"${a.locked ? ` aria-disabled="true" title="${esc(a.locked)}"` : ''}><span class="knob" aria-hidden="true"></span><span class="sl" aria-hidden="true">${a.on ? 'On' : 'Off'}</span></button>`;
  }
  function actionHtml(a) {
    if (a.kind === 'select') {
      const id = `sel-${a.id}-${slug(a.arg)}`;
      return `<div class="field"><label for="${id}">${esc(a.label)} <code class="key">localpilot.${esc(a.setting)}</code></label><select id="${id}" data-act="${esc(a.id)}" data-arg="${esc(a.arg)}">${a.options.map((o) => `<option value="${esc(o.value)}"${o.value === a.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}${a.value && !a.options.some((o) => o.value === a.value) ? `<option value="${esc(a.value)}" selected>${esc(a.value)} (not available)</option>` : ''}</select></div>`;
    }
    if (a.kind === 'toggle') {
      return `<div class="field row-field"><span class="flabel" id="lb-${esc(a.id)}-${slug(a.arg)}">${esc(a.label)}${a.locked ? `<span class="sb">${esc(a.locked)}</span>` : ''}</span>${switchHtml(a, `${a.label}: ${a.arg}`)}</div>`;
    }
    return `<button type="button" class="btn" data-act="${esc(a.id)}" data-arg="${esc(a.arg || '')}">${I[a.icon] || ''}<span>${esc(a.label)}</span></button>`;
  }
  function wireActions(root) {
    root.querySelectorAll('select[data-act]').forEach((s) => { s.onchange = () => post({ type: 'action', id: s.dataset.act, arg: s.dataset.arg, value: s.value }); });
    root.querySelectorAll('.switch[data-act]').forEach((b) => {
      b.onclick = () => {
        if (b.getAttribute('aria-disabled') === 'true') { toast(b.title, 'info'); return; }
        const on = b.getAttribute('aria-checked') !== 'true';
        b.setAttribute('aria-checked', String(on)); b.querySelector('.sl').textContent = on ? 'On' : 'Off';
        post({ type: 'action', id: b.dataset.act, arg: b.dataset.arg, value: on });
      };
    });
    root.querySelectorAll('button.btn[data-act]').forEach((b) => { b.onclick = () => post({ type: 'action', id: b.dataset.act, arg: b.dataset.arg || undefined }); });
  }

  // ------------------------------------------------------------------ try a message
  let tryTimer;
  const classify = () => { const t = els.tryIn.value.trim(); if (!t) { S.route = null; els.tryOut.innerHTML = ''; paint(); return; } post({ type: 'classify', text: t }); };
  els.tryIn.addEventListener('input', () => { clearTimeout(tryTimer); tryTimer = setTimeout(classify, 250); });
  $('try').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(tryTimer); classify(); });
  $('tryClear').onclick = () => { els.tryIn.value = ''; classify(); els.tryIn.focus(); };
  function showRoute(m) {
    if (m.text !== els.tryIn.value.trim()) { return; }
    S.route = m;
    const role = S.model && byId().get(`role:${m.route.role}`);
    const model = role && role.model ? ` → ${role.model}` : '';
    els.tryOut.innerHTML = `<span class="hop">Auto</span>${I.arrow.replace('<svg', '<svg class="arr" aria-hidden="true"')}<button type="button" class="hop on" data-go="${esc(m.path[1])}">${esc(m.label)}</button><span class="muted">${m.route.specialist ? `in ${esc(m.route.mode)} mode · ` : ''}${esc(m.route.role)} role${esc(model)}</span><span class="why">— ${esc(m.route.reason)}</span>`;
    els.tryOut.querySelector('[data-go]').onclick = (e) => select(e.currentTarget.dataset.go);
    paint();
  }
  const paint = () => { if (S.view === 'graph') { paintHot(); } else if (S.model) { renderList(); } };

  // ------------------------------------------------------------------ chrome
  function toast(text, level) {
    const t = el('div', `toast ${level || 'info'}`, esc(text)); toasts.appendChild(t);
    setTimeout(() => t.remove(), level === 'error' ? 7000 : 3500);
  }
  els.q.addEventListener('input', () => { S.q = els.q.value; save(); applyFilter(); });
  $('refresh').onclick = () => post({ type: 'refresh' });
  $('newAgent').onclick = () => post({ type: 'action', id: 'newAgent' });
  $('newSkill').onclick = () => post({ type: 'action', id: 'newSkill' });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sel && els.insp.contains(document.activeElement)) { e.preventDefault(); select(''); }
    if ((e.key === 'f' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) { e.preventDefault(); els.q.focus(); els.q.select(); }
  });
  // Narrow (a side bar or a split editor): List reads better than a graph, so it switches unless the user picked a view.
  new ResizeObserver(() => {
    const narrow = document.body.clientWidth < 560;
    if (narrow === S.narrow) { return; }
    S.narrow = narrow; document.body.classList.toggle('narrow', narrow);
    if (!S.userView) { S.view = narrow ? 'list' : 'graph'; renderControls(); renderView(); }
    if (S.sel) { renderInspector(false); }
  }).observe(document.body);

  function counts(c) {
    const part = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    els.counts.innerHTML = [part(c.modes, 'mode'), part(c.specialists, 'specialist'), `${part(c.subagents, 'subagent')}${c.customAgents ? ` (${c.customAgents} yours)` : ''}`, `${c.skillsOn}/${part(c.skills, 'skill')} on`, `${part(c.tools, 'tool')}${c.toolsOff ? ` (${c.toolsOff} off)` : ''}`, `${part(c.mcp, 'MCP server')}${c.mcp ? ` (${c.mcpConnected} connected)` : ''}`].map(esc).join(' · ') +
      `${S.model.localOnly ? ' · <span class="pill">local models only</span>' : ''}${S.model.routingEnabled ? '' : ' · <span class="pill off">routing off</span>'}`;
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'model') {
      S.model = m.model; counts(m.model.counts);
      if (S.sel && !byId().has(S.sel)) { S.sel = ''; }
      renderView(); renderInspector(false);
      if (els.tryIn.value.trim() && S.route) { classify(); }
    } else if (m.type === 'route') { showRoute(m); }
    else if (m.type === 'toast') { toast(m.text, m.level); }
  });
  window.addEventListener('error', (e) => toast(`Agent map error: ${e.message}`, 'error'));
  renderControls(); renderView();
  post({ type: 'ready' });
})();
