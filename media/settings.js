// LocalPilot settings + first-run setup webview. Vanilla JS; all writes go through the extension host (validated there).
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const LOGO = document.body.dataset.logo;
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };
  const I = {
    server: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.5 4.8h.01M4.5 11.3h.01"/></svg>',
    cpu: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/><rect x="6.5" y="6.5" width="3" height="3"/><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2"/></svg>',
    shield: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5 2v4c0 3-2.2 5.3-5 6.5-2.8-1.2-5-3.5-5-6.5v-4z"/><path d="M5.8 8l1.5 1.5L10.5 6"/></svg>',
    ghost: '<svg viewBox="0 0 16 16"><path d="M3 8a5 5 0 0 1 10 0v6l-1.7-1.3L9.6 14 8 12.7 6.4 14l-1.7-1.3L3 14z"/><path d="M6 7.5h.01M10 7.5h.01"/></svg>',
    globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 2 9.8 0 12M8 2c-2 2.2-2 9.8 0 12"/></svg>',
    brain: '<svg viewBox="0 0 16 16"><path d="M6 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path d="M8 3v10M5 7h6M5 9.5h6"/></svg>',
    plug: '<svg viewBox="0 0 16 16"><path d="M5 2v4M11 2v4M4 6h8v2a4 4 0 0 1-8 0zM8 12v2.5"/></svg>',
    wrench: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5a3.5 3.5 0 0 0 3.8 4.7L8 12.5a1.8 1.8 0 0 1-2.5-2.5l5.3-5.3a3.5 3.5 0 0 0-1.3-2.2z"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    undo: '<svg viewBox="0 0 16 16"><path d="M3 6h7a3 3 0 0 1 0 6H6M3 6l2.5-2.5M3 6l2.5 2.5"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    chat: '<svg viewBox="0 0 16 16"><path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H9l-3 2.5V11H4.5A1.5 1.5 0 0 1 3 9.5z"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9h5.6l.7-9"/></svg>',
    bolt: '<svg viewBox="0 0 16 16"><path d="M9 1.5L3.5 9h4l-.5 5.5L13 7H9z"/></svg>',
    rocket: '<svg viewBox="0 0 16 16"><path d="M8 11c3-2 5-5.5 5-9-3.5 0-7 2-9 5l-2 .5L4.5 10 8 11z"/><path d="M5 11l-1.5 3M6 14l1-2.5"/><circle cx="9.5" cy="6.5" r="1"/></svg>',
    book: '<svg viewBox="0 0 16 16"><path d="M3 3h4a2 2 0 0 1 2 2v9a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H9a2 2 0 0 0-2 2v9a1.5 1.5 0 0 1 1.5-1.5H13z"/></svg>',
    download: '<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 12.5h10"/></svg>',
    play: '<svg viewBox="0 0 16 16"><path d="M5 3l8 5-8 5z"/></svg>',
    star: '<svg viewBox="0 0 16 16"><path d="M8 2l1.8 3.7 4.2.6-3 2.9.7 4.1L8 11.4l-3.7 1.9.7-4.1-3-2.9 4.2-.6z"/></svg>',
    chip: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/><path d="M6 1.5v1.5M10 1.5v1.5M6 13v1.5M10 13v1.5M1.5 6h1.5M1.5 10h1.5M13 6h1.5M13 10h1.5"/><rect x="6" y="6" width="4" height="4"/></svg>',
  };
  const SECTIONS = [
    ['providers', 'Providers', I.server], ['models', 'Models', I.cpu], ['agent', 'Agent & approvals', I.shield], ['completions', 'Inline completions', I.ghost],
    ['web', 'Web search', I.globe], ['memory', 'Memory & skills', I.brain], ['mcp', 'MCP servers', I.plug], ['advanced', 'Advanced', I.wrench],
  ];
  const PRESET_PROVIDERS = [
    { key: 'ollama', label: 'Ollama', sub: 'localhost:11434', cfg: { id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434', displayName: 'Ollama' } },
    { key: 'lmstudio', label: 'LM Studio', sub: 'localhost:1234', cfg: { id: 'lmstudio', type: 'openai', baseUrl: 'http://localhost:1234/v1', displayName: 'LM Studio' } },
    { key: 'llamacpp', label: 'llama.cpp', sub: 'localhost:8080', cfg: { id: 'llamacpp', type: 'openai', baseUrl: 'http://localhost:8080/v1', displayName: 'llama.cpp server' } },
    { key: 'vllm', label: 'vLLM / Unsloth', sub: 'localhost:8000', cfg: { id: 'vllm', type: 'openai', baseUrl: 'http://localhost:8000/v1', displayName: 'vLLM / Unsloth' } },
    { key: 'docker', label: 'Docker Model Runner', sub: 'localhost:12434', cfg: { id: 'docker', type: 'openai', baseUrl: 'http://localhost:12434/engines/v1', displayName: 'Docker Model Runner' } },
    { key: 'jan', label: 'Jan', sub: 'localhost:1337', cfg: { id: 'jan', type: 'openai', baseUrl: 'http://localhost:1337/v1', displayName: 'Jan' } },
    { key: 'localai', label: 'LocalAI', sub: 'localhost:8080', cfg: { id: 'localai', type: 'openai', baseUrl: 'http://localhost:8080/v1', displayName: 'LocalAI' } },
    { key: 'sglang', label: 'SGLang', sub: 'localhost:30000', cfg: { id: 'sglang', type: 'openai', baseUrl: 'http://localhost:30000/v1', displayName: 'SGLang' } },
    { key: 'custom', label: 'Custom endpoint', sub: 'any OpenAI-compatible URL', cfg: { id: 'custom', type: 'openai', baseUrl: 'http://', displayName: 'Custom' } },
  ];
  const APPROVAL = [['ask', 'Ask'], ['always', 'Allow'], ['never', 'Block']];
  const APPROVAL_PRESETS = {
    safe: { title: 'Careful', desc: 'Ask before every command, edit, delete and network call.', v: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask' } },
    balanced: { title: 'Balanced', desc: 'Edits and web are allowed; ask for terminal commands and deletes. (Default)', v: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always' } },
    autonomous: { title: 'Autonomous', desc: 'Let the agent run commands and edit freely; only deletes need approval.', v: { terminal: 'always', write: 'always', delete: 'ask', network: 'always' } },
  };

  const state = { page: 'settings', section: 'providers', scope: 'user', data: null, probe: null, tests: {}, expanded: null, busy: false, setup: { step: 0, model: '', approvals: 'balanced', inline: false, providers: null }, models: null, modelsRequested: false, jobs: [], cat: { filter: 'fits', q: '', open: {} }, installTarget: {}, runtimes: null, starter: null };

  // ------------------------------------------------------------------ helpers
  function toast(text, level) { const t = el('div', `toast ${level || 'info'}`, esc(text)); document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 3000); }
  const S = (key) => (state.data && state.data.settings[key]) || { value: undefined, default: undefined, scope: 'default' };
  const val = (key) => S(key).value;
  function set(key, value) { post({ type: 'set', key, value, scope: state.scope }); }
  function reset(key) { post({ type: 'reset', key, scope: state.scope === 'workspace' ? 'workspace' : 'user' }); }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const scopeBadge = (key) => { const s = S(key).scope; return s === 'default' ? '' : `<span class="badge ${s}" title="Set in ${s} settings">${s}</span>`; };
  const resetBtn = (key) => (S(key).scope === 'default' ? '' : `<button class="reset" data-reset="${esc(key)}" title="Reset to default">${I.undo}</button>`);

  /** Generic setting row. kind: text|number|password|select|toggle|textarea|range|seg */
  function field(key, label, desc, kind, opts = {}) {
    const f = el('div', `field ${opts.wide ? 'wide' : ''}`);
    f.innerHTML = `<div><div class="lbl">${esc(label)}${scopeBadge(key)}${resetBtn(key)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="ctl"></div>`;
    const ctl = f.querySelector('.ctl');
    const v = val(key);
    if (kind === 'toggle') {
      const b = el('button', `toggle ${v ? 'on' : ''}`); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!v)); b.setAttribute('aria-label', label);
      b.onclick = () => { b.classList.toggle('on'); set(key, b.classList.contains('on')); };
      ctl.appendChild(b);
    } else if (kind === 'select') {
      const s = el('select'); s.setAttribute('aria-label', label);
      for (const [ov, ol, od] of opts.options) { const o = el('option'); o.value = ov; o.textContent = ol + (od ? ` — ${od}` : ''); if (String(ov) === String(v)) { o.selected = true; } s.appendChild(o); }
      if (opts.options.every(([ov]) => String(ov) !== String(v)) && v !== undefined && v !== '') { const o = el('option'); o.value = v; o.textContent = `${v} (not available)`; o.selected = true; s.appendChild(o); }
      s.onchange = () => set(key, opts.cast ? opts.cast(s.value) : s.value);
      ctl.appendChild(s);
    } else if (kind === 'seg') {
      const g = el('div', 'seg'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
      for (const [ov, ol] of opts.options) { const b = el('button', String(ov) === String(v) ? 'on' : '', esc(ol)); b.onclick = () => { g.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); set(key, ov); }; g.appendChild(b); }
      ctl.appendChild(g);
    } else if (kind === 'range') {
      const w = el('div', 'range', `<input type="range" min="${opts.min}" max="${opts.max}" step="${opts.step}" value="${esc(v)}" aria-label="${esc(label)}"><output>${esc(opts.fmt ? opts.fmt(v) : v)}</output>`);
      const r = w.querySelector('input');
      r.oninput = () => { w.querySelector('output').textContent = opts.fmt ? opts.fmt(Number(r.value)) : r.value; };
      r.onchange = () => set(key, Number(r.value));
      ctl.appendChild(w);
    } else if (kind === 'textarea') {
      const t = el('textarea'); t.value = v ?? ''; t.placeholder = opts.placeholder || ''; t.setAttribute('aria-label', label);
      t.onchange = () => set(key, t.value);
      ctl.appendChild(t);
    } else {
      const i = el('input'); i.type = kind === 'number' ? 'number' : kind === 'password' ? 'password' : 'text'; i.value = v ?? ''; i.placeholder = opts.placeholder || ''; i.setAttribute('aria-label', label);
      if (kind === 'number') { if (opts.min !== undefined) { i.min = opts.min; } if (opts.max !== undefined) { i.max = opts.max; } if (opts.step) { i.step = opts.step; } }
      const commit = () => {
        if (kind === 'number') {
          const n = Number(i.value);
          if (i.value === '' || Number.isNaN(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) { i.classList.add('invalid'); return; }
          i.classList.remove('invalid'); if (n !== v) { set(key, n); }
        } else if (opts.validate && i.value && !opts.validate(i.value)) { i.classList.add('invalid'); }
        else { i.classList.remove('invalid'); if (i.value !== (v ?? '')) { set(key, i.value); } }
      };
      i.onchange = commit; i.onblur = commit; i.oninput = debounce(commit, 700);
      ctl.appendChild(i);
    }
    if (opts.after) { ctl.appendChild(opts.after); }
    return f;
  }
  const card = (...children) => { const c = el('div', 'card'); children.forEach((x) => x && c.appendChild(x)); return c; };
  const enabledModels = () => (state.data.models || []).filter((m) => !m.disabled);
  const modelOptions = (filter) => enabledModels().filter(filter || (() => true)).map((m) => [m.id, m.name, `${m.providerId} · ${Math.round(m.contextWindow / 1024)}k${m.supportsTools ? ' · tools' : ''}${m.supportsVision ? ' · vision' : ''}${m.supportsFim ? ' · FIM' : ''}`]);
  const shortId = (id) => String(id || '').split('/').pop();

  // ------------------------------------------------------------------ shell
  function render() {
    if (!state.data) { return; }
    app.removeAttribute('aria-busy');
    app.innerHTML = '';
    if (state.page === 'setup') { return renderSetup(); }
    const d = state.data;
    const top = el('header', 'top');
    top.innerHTML = `<div class="brand"><img src="${LOGO}" alt=""><div><b>LocalPilot</b><span>Settings · v${esc(d.version)}</span></div></div><span class="spacer"></span>
      <div class="scope" role="radiogroup" aria-label="Settings scope"><button data-s="user" class="${state.scope === 'user' ? 'on' : ''}">User</button><button data-s="workspace" class="${state.scope === 'workspace' ? 'on' : ''}" ${d.hasWorkspace ? '' : 'disabled title="Open a folder to edit workspace settings"'}>Workspace</button></div>
      <button class="btn" data-cmd="localpilot.openChat">${I.chat}Open chat</button>`;
    top.querySelectorAll('.scope button').forEach((b) => (b.onclick = () => { state.scope = b.dataset.s; render(); }));
    app.appendChild(top);
    const layout = el('div', 'layout');
    const side = el('nav', 'side');
    side.innerHTML = `<div class="grp">Settings</div>${SECTIONS.map(([id, label, icon]) => `<a data-sec="${id}" class="${state.section === id ? 'on' : ''}">${icon}${esc(label)}</a>`).join('')}<div class="grp">Help</div><a data-cmd="localpilot.openWelcome">${I.rocket}Run setup again</a><a data-url="https://isathish.github.io/localpilot/docs/configuration/">${I.book}Documentation</a>`;
    side.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; state.expanded = null; render(); }));
    layout.appendChild(side);
    const main = el('main', 'content');
    const sec = el('section', 'sec');
    ({ providers: secProviders, models: secModels, agent: secAgent, completions: secCompletions, web: secWeb, memory: secMemory, mcp: secMcp, advanced: secAdvanced }[state.section] || secProviders)(sec);
    main.appendChild(sec);
    layout.appendChild(main);
    app.appendChild(layout);
    wireGlobal(app);
  }
  function wireGlobal(root) {
    root.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => post({ type: 'command', id: b.dataset.cmd, args: b.dataset.args ? JSON.parse(b.dataset.args) : undefined })));
    root.querySelectorAll('[data-url]').forEach((b) => (b.onclick = () => post({ type: 'openExternal', url: b.dataset.url })));
    root.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); reset(b.dataset.reset); }));
  }
  const head = (sec, title, lead) => { sec.innerHTML = `<h1>${esc(title)}</h1><p class="lead">${lead}</p>`; };

  // ------------------------------------------------------------------ providers
  function providersList() { const v = val('providers'); return Array.isArray(v) ? v.map((p) => ({ ...p })) : []; }
  function saveProviders(list) { set('providers', list); }
  function secProviders(sec) {
    head(sec, 'Providers', 'Model servers LocalPilot can talk to. Everything runs on the machines you choose — nothing is sent anywhere else.');
    const list = providersList();
    const bar = el('div', 'btnrow');
    bar.innerHTML = `<button class="btn primary" id="probe">${state.busy ? '<span class="spinner"></span>' : I.refresh}Check all connections</button><button class="btn" data-cmd="localpilot.refreshModels">${I.cpu}Refresh model list</button><span class="spacer"></span><span class="muted small">${enabledModels().length} model(s) available</span>`;
    bar.querySelector('#probe').onclick = () => { state.busy = true; render(); post({ type: 'probe' }); };
    sec.appendChild(bar);
    const wrap = el('div');
    wrap.style.marginTop = '14px';
    if (!list.length) { wrap.appendChild(el('div', 'empty', 'No providers configured. Add one below — Ollama is the quickest way to get started.')); }
    for (const p of list) { wrap.appendChild(providerCard(p, list)); }
    sec.appendChild(wrap);
    const add = el('div');
    add.innerHTML = `<h2 class="sub">Add a provider</h2>`;
    const presets = el('div', 'presets');
    for (const pr of PRESET_PROVIDERS) {
      const taken = list.some((p) => p.id === pr.cfg.id);
      const b = el('button', 'preset', `<span class="ic">${esc(pr.label[0])}</span><div><b>${esc(pr.label)}</b><span>${taken ? 'already added' : esc(pr.sub)}</span></div>`);
      b.disabled = taken && pr.key !== 'custom';
      b.onclick = () => {
        const cfg = { ...pr.cfg };
        if (list.some((p) => p.id === cfg.id)) { let n = 2; while (list.some((p) => p.id === `${cfg.id}-${n}`)) { n++; } cfg.id = `${cfg.id}-${n}`; }
        state.expanded = cfg.id;
        saveProviders([...list, cfg]);
      };
      presets.appendChild(b);
    }
    add.appendChild(presets);
    sec.appendChild(add);
    const tip = el('p', 'muted small');
    tip.style.marginTop = '14px';
    tip.innerHTML = 'Tip: <code>ollama</code> uses the native Ollama API (tools, thinking, vision, FIM). Every other server uses the OpenAI-compatible <code>/v1</code> API — LM Studio, llama.cpp, vLLM, SGLang, LocalAI, Jan, OpenRouter, Azure OpenAI…';
    sec.appendChild(tip);
  }
  function providerCard(p, list) {
    const probe = (state.probe || []).find((r) => r.id === p.id) || state.tests[p.id];
    const open = state.expanded === p.id;
    const c = el('div', `prov ${p.enabled === false ? 'off' : ''}`);
    const status = probe ? (probe.ok ? 'ok' : 'err') : state.busy ? 'busy' : '';
    const n = probe && probe.ok ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'} · ${probe.latencyMs} ms` : probe ? 'unreachable' : (state.data.models || []).filter((m) => m.providerId === p.id).length ? `${(state.data.models || []).filter((m) => m.providerId === p.id).length} models` : '';
    c.innerHTML = `<div class="prov-head"><span class="dot ${status}"></span><div class="prov-title"><b>${esc(p.displayName || p.id)}</b><span>${esc(p.baseUrl)}</span></div><div class="prov-meta"><span class="badge">${p.type === 'ollama' ? 'Ollama API' : 'OpenAI API'}</span>${n ? `<span class="badge ${status}">${esc(n)}</span>` : ''}${p.enabled === false ? '<span class="badge">disabled</span>' : ''}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
    c.querySelector('.prov-head').onclick = () => { state.expanded = open ? null : p.id; render(); };
    if (!open) { return c; }
    const body = el('div', 'prov-body');
    const upd = (patch) => { Object.assign(p, patch); saveProviders(list); };
    const row = (label, desc, input) => { const f = el('div', 'field'); f.innerHTML = `<div><div class="lbl">${esc(label)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`; const ctl = el('div', 'ctl'); ctl.appendChild(input); f.appendChild(ctl); return f; };
    const text = (key, placeholder, type = 'text', validate) => {
      const i = el('input'); i.type = type; i.value = p[key] ?? ''; i.placeholder = placeholder;
      const commit = () => { const v = i.value.trim(); if (validate && v && !validate(v)) { i.classList.add('invalid'); return; } i.classList.remove('invalid'); if ((p[key] ?? '') !== v) { upd({ [key]: v || undefined }); } };
      i.onchange = commit; i.onblur = commit;
      return i;
    };
    const typeSel = el('select', '', `<option value="ollama">Ollama (native API)</option><option value="openai">OpenAI-compatible (/v1)</option>`);
    typeSel.value = p.type; typeSel.onchange = () => upd({ type: typeSel.value });
    body.appendChild(row('Display name', '', text('displayName', p.id)));
    body.appendChild(row('ID', 'Used in model ids as <code>id/model</code>. Lowercase letters, digits, - and _.', text('id', 'ollama', 'text', (v) => /^[a-z0-9_-]+$/.test(v) && !list.some((o) => o !== p && o.id === v))));
    body.appendChild(row('API type', '', typeSel));
    body.appendChild(row('Base URL', p.type === 'ollama' ? 'e.g. <code>http://localhost:11434</code>' : 'Include <code>/v1</code>, e.g. <code>http://localhost:1234/v1</code>', text('baseUrl', 'http://localhost:11434', 'url', (v) => /^https?:\/\/.+/.test(v))));
    body.appendChild(row('API key', 'Optional. Sent as a Bearer token. Stored in your settings file.', text('apiKey', 'not required for local servers', 'password')));
    const cw = el('input'); cw.type = 'number'; cw.min = 1024; cw.step = 1024; cw.value = p.contextWindow ?? ''; cw.placeholder = 'auto';
    cw.onchange = () => upd({ contextWindow: cw.value ? Number(cw.value) : undefined });
    body.appendChild(row('Context window', 'Fallback when the server does not report one.', cw));
    const models = el('input'); models.type = 'text'; models.value = (p.models || []).join(', '); models.placeholder = 'auto-discover';
    models.onchange = () => upd({ models: models.value.split(',').map((s) => s.trim()).filter(Boolean) });
    body.appendChild(row('Models', 'Comma-separated list for servers whose <code>/models</code> endpoint is empty (some llama.cpp builds).', models));
    const en = el('button', `toggle ${p.enabled !== false ? 'on' : ''}`); en.setAttribute('role', 'switch');
    en.onclick = () => upd({ enabled: p.enabled === false ? undefined : false });
    body.appendChild(row('Enabled', 'Disabled providers are kept in settings but never contacted.', en));
    const foot = el('div', 'prov-foot');
    foot.innerHTML = `<button class="btn primary" id="test">${I.bolt}Test connection</button><span class="spacer"></span><button class="btn danger" id="rm">${I.trash}Remove</button>`;
    foot.querySelector('#test').onclick = () => { state.tests[p.id] = null; const d = c.querySelector('.dot'); d.className = 'dot busy'; post({ type: 'test', provider: p }); };
    foot.querySelector('#rm').onclick = () => { saveProviders(list.filter((o) => o !== p)); state.expanded = null; };
    body.appendChild(foot);
    if (probe) {
      const r = el('div', `prov-result ${probe.ok ? 'ok' : 'err'}`);
      r.innerHTML = probe.ok ? `${I.check} Connected in ${probe.latencyMs} ms${probe.models.length ? `<div class="models">${probe.models.slice(0, 24).map((m) => `<span title="${esc(m.id)}">${esc(m.name)}</span>`).join('')}${probe.models.length > 24 ? `<span>+${probe.models.length - 24} more</span>` : ''}</div>` : '<div class="models muted">Connected, but the server reported no models. Load a model or list them in the Models field.</div>'}` : `${I.x} ${esc(probe.error || 'Unreachable')}`;
      body.appendChild(r);
    }
    c.appendChild(body);
    return c;
  }

  // ------------------------------------------------------------------ models
  const ROLE_LABEL = { agent: 'agent', completion: 'completions', vision: 'images', reasoning: 'plan' };
  const TARGET_LABEL = { ollama: 'Ollama', docker: 'Docker Model Runner', lmstudio: 'LM Studio' };
  const fitBadge = (fit) => fit === 'ok' ? '<span class="badge ok">fits</span>' : fit === 'tight' ? '<span class="badge warn">tight</span>' : fit === 'over' ? '<span class="badge err">too big</span>' : '';
  const gbText = (gb) => (gb === undefined || gb === null ? '' : gb >= 10 ? `${Math.round(gb)} GB` : `${Number(gb).toFixed(1)} GB`);
  const activeJob = (kind, target, model) => state.jobs.find((j) => j.status === 'running' && j.kind === kind && (!target || j.target === target) && (!model || j.model === model));
  function progressBar(job) {
    const w = el('div', `progress ${job.progress < 0 ? 'indet' : ''}`, `<i style="width:${Math.max(2, Math.round((job.progress < 0 ? 0.3 : job.progress) * 100))}%"></i>`);
    w.title = job.detail || '';
    return w;
  }
  function secModels(sec) {
    head(sec, 'Models', 'Everything about local models in one place: what this machine can run, what is installed, which model answers which task, and a catalog to install more — smallest first.');
    if (!state.models) {
      if (!state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
      sec.appendChild(el('div', 'loading', '<span class="spinner"></span>Checking this machine and the model servers…'));
      return;
    }
    const d = { runtimes: [], installed: [], catalog: [], starter: {}, ...state.models };
    d.system = d.system || { summary: 'Hardware not detected', modelBudgetGb: 0, tier: '' };
    const running = d.runtimes.filter((r) => r.running);
    const anyModels = d.installed.length > 0;
    const setupJob = activeJob('setup') || activeJob('install-runtime') || activeJob('start');

    // --- this machine
    const sys = el('div', 'card sys-card');
    const tierText = { tiny: 'very small models only (≤ 3b)', small: 'small models (up to ~7b)', medium: 'mid-size models (up to ~14b)', large: 'large models (up to ~32b)', xl: 'anything, including 70b+' }[d.system.tier] || '';
    sys.innerHTML = `<div class="sys"><span class="ic">${I.chip}</span><div class="t"><b>${esc(d.system.summary)}</b><span>Comfortable with ${esc(tierText)}. Smaller models answer faster and leave room for completions and vision alongside the agent model.</span></div><div class="budget"><b>${esc(gbText(d.system.modelBudgetGb))}</b><span>model budget</span></div></div>`;
    const rts = el('div', 'rts');
    for (const r of d.runtimes) {
      const row = el('div', 'rt');
      const status = r.running ? '<span class="badge ok">running</span>' : r.installed ? '<span class="badge warn">installed</span>' : '<span class="badge">not found</span>';
      row.innerHTML = `<span class="dot ${r.running ? 'ok' : r.installed ? 'warn' : ''}"></span><div class="t"><b>${esc(r.label)} ${status}</b><span title="${esc(r.hint || r.baseUrl || '')}">${esc(r.running ? r.baseUrl : r.hint || '')}</span></div>`;
      if (!r.running && r.installed && r.target === 'ollama') {
        const b = el('button', 'btn sm', `${I.play}Start`);
        b.disabled = !!activeJob('start');
        b.onclick = () => { b.disabled = true; post({ type: 'startRuntime', target: 'ollama' }); };
        row.appendChild(b);
      } else if (!r.installed && r.target === 'ollama') {
        const b = el('button', 'btn sm', `${I.download}Install`);
        b.onclick = () => post({ type: 'autoSetup', installRuntime: true, target: 'ollama' });
        row.appendChild(b);
      }
      rts.appendChild(row);
    }
    sys.appendChild(rts);
    const auto = el('div', 'sys-foot');
    const starter = d.starter.agent ? `${d.starter.agent}${d.starter.completion ? ` + ${d.starter.completion} for completions` : ''}${d.starter.vision ? ` + ${d.starter.vision} for images` : ''}` : 'a coder model sized for this machine';
    auto.innerHTML = `<button class="btn ${anyModels ? '' : 'brand'}" id="auto" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${anyModels ? 'Install starter set' : 'Set up automatically'}</button><span class="hint">${esc(setupJob ? setupJob.detail : `Picks for this machine: ${starter}. Starts or installs Ollama when needed.`)}</span>`;
    auto.querySelector('#auto').onclick = () => post({ type: 'autoSetup', installRuntime: false });
    sys.appendChild(auto);
    sys.appendChild(field('models.autoSetup', 'Offer automatic setup', 'When LocalPilot starts and finds no local model, offer to install Ollama and a starter model.', 'toggle'));
    sec.appendChild(sys);

    // --- jobs
    const jobs = state.jobs.filter((j) => j.kind !== 'setup' || j.status === 'running');
    if (jobs.length) {
      const h = el('h2', 'sub', `Activity${jobs.some((j) => j.status === 'running') ? '<span class="spinner"></span>' : ''}`);
      const clr = el('button', 'btn ghost sm act', 'Clear finished'); clr.onclick = () => post({ type: 'clearJobs' });
      if (jobs.some((j) => j.status !== 'running')) { h.appendChild(clr); }
      sec.appendChild(h);
      const card = el('div', 'card');
      for (const j of jobs.slice(0, 8)) {
        const row = el('div', 'job');
        const verb = { pull: 'Installing', remove: 'Removing', start: 'Starting', 'install-runtime': 'Installing', setup: 'Setting up' }[j.kind] || j.kind;
        row.innerHTML = `<span class="dot ${j.status === 'running' ? 'busy' : j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : ''}"></span><div class="t"><b>${esc(verb)} ${esc(j.model)} <span class="badge">${esc(TARGET_LABEL[j.target] || j.target)}</span></b><span>${esc(j.status === 'error' ? j.error || 'failed' : j.detail || j.status)}</span></div>`;
        if (j.status === 'running') {
          const grp = el('div', 'prog-grp');
          grp.appendChild(progressBar(j));
          grp.appendChild(el('span', 'pct', j.progress >= 0 ? `${Math.round(j.progress * 100)}%` : ''));
          const c = el('button', 'btn ghost sm', I.x); c.title = 'Cancel'; c.onclick = () => post({ type: 'cancelJob', id: j.id });
          grp.appendChild(c);
          row.appendChild(grp);
        }
        card.appendChild(row);
      }
      sec.appendChild(card);
    }

    // --- installed
    sec.appendChild(el('h2', 'sub', `Installed models<span class="count">${d.installed.filter((m) => !m.disabled).length} enabled · ${d.installed.length} total</span>`));
    const inst = el('div', 'card');
    if (!anyModels) {
      inst.appendChild(el('div', 'empty', running.length ? 'The server is running but has no models yet. Use <b>Set up automatically</b> above or install one from the catalog below.' : 'No model server is running. <b>Set up automatically</b> starts or installs Ollama and downloads a starter model sized for this machine.'));
    }
    const def = val('defaultModel');
    const sorted = [...d.installed].sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name));
    for (const m of sorted) {
      const row = el('div', `mrow ${m.disabled ? 'off' : ''}`);
      const tg = el('button', `toggle ${m.disabled ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.title = m.disabled ? 'Enable' : 'Disable (hidden from pickers and routing; stays installed)';
      tg.onclick = () => { tg.classList.toggle('on'); post({ type: 'toggleModel', id: m.id, enabled: !!m.disabled }); };
      row.appendChild(tg);
      const caps = [m.supportsTools ? 'tools' : 'prompt tools', m.supportsVision ? 'vision' : '', m.supportsFim ? 'FIM' : ''].filter(Boolean).join(' · ');
      const t = el('div', 't', `<b title="${esc(m.id)}">${esc(m.name)}</b><span>${esc(m.providerId)} · ${Math.round(m.contextWindow / 1024)}k context${m.gb ? ` · ${esc(gbText(m.gb))}` : ''}${m.parameterSize ? ` · ${esc(m.parameterSize)}` : ''} · ${esc(caps)}${m.catalog ? ` · ${esc(m.catalog.name)} ${esc(m.catalog.tag)}` : ''}</span>`);
      row.appendChild(t);
      const right = el('div', 'mrow-right');
      const tags = el('div', 'tags');
      if (m.id === def) { tags.innerHTML += '<span class="badge brand">default</span>'; }
      else if (!def && m.autoRoles.includes('agent')) { tags.innerHTML += '<span class="badge brand">auto default</span>'; }
      if (m.id === val('inlineCompletion.model')) { tags.innerHTML += '<span class="badge role">completions</span>'; }
      if (m.id === val('routing.vision')) { tags.innerHTML += '<span class="badge role">images</span>'; }
      if (m.id === val('routing.reasoning')) { tags.innerHTML += '<span class="badge role">plan</span>'; }
      for (const r of m.autoRoles) { if (r !== 'agent' && !tags.innerHTML.includes(`>${ROLE_LABEL[r]}<`)) { tags.innerHTML += `<span class="badge" title="Routing picks this model for ${ROLE_LABEL[r]} unless you choose one">auto · ${ROLE_LABEL[r]}</span>`; } }
      tags.innerHTML += fitBadge(m.fit);
      right.appendChild(tags);
      const acts = el('div', 'acts');
      if (!m.disabled && m.id !== def) {
        const b = el('button', 'btn ghost sm', 'Set default'); b.title = 'Use for new chats'; b.onclick = () => set('defaultModel', m.id);
        acts.appendChild(b);
      }
      if (m.removable) {
        const rj = activeJob('remove', m.removable, m.modelId);
        const b = el('button', 'btn ghost sm danger', rj ? '<span class="spinner"></span>' : I.trash); b.title = `Delete from ${TARGET_LABEL[m.removable]}`; b.disabled = !!rj;
        b.onclick = () => { if (confirm(`Delete ${m.name} from ${TARGET_LABEL[m.removable]}? You can download it again from the catalog.`)) { post({ type: 'removeModel', target: m.removable, model: m.modelId, providerId: m.providerId }); } };
        acts.appendChild(b);
      }
      right.appendChild(acts);
      row.appendChild(right);
      inst.appendChild(row);
    }
    sec.appendChild(inst);

    // --- routing
    sec.appendChild(el('h2', 'sub', 'Routing'));
    const autoFor = (role) => { const m = d.installed.find((x) => !x.disabled && x.autoRoles.includes(role)); return m ? `Auto → ${m.name}` : role === 'vision' ? 'Auto → no vision model installed' : 'Auto → best available'; };
    const opts = modelOptions();
    sec.appendChild(card(
      field('routing.enabled', 'Route automatically', 'Send image turns to a vision model, completions to the smallest FIM model, Plan mode to the reasoning model, and fall back to the best available model when the chosen one is offline or disabled.', 'toggle'),
      field('defaultModel', 'Agent & chat', opts.length ? `New chats and editor actions. ${esc(autoFor('agent'))}.` : 'No models enabled yet.', 'select', { options: [['', 'Auto (best for this machine)', ''], ...opts] }),
      field('inlineCompletion.model', 'Inline completions', `Fill-in-the-middle model for ghost text. ${esc(autoFor('completion'))}.`, 'select', { options: [['', 'Auto (smallest FIM model)', ''], ...(modelOptions((m) => m.supportsFim).length ? modelOptions((m) => m.supportsFim) : opts)] }),
      field('routing.vision', 'Images', `Used when a turn has images and the session model cannot see. ${esc(autoFor('vision'))}.`, 'select', { options: [['', 'Auto (best vision model)', ''], ...(modelOptions((m) => m.supportsVision).length ? modelOptions((m) => m.supportsVision) : opts)] }),
      field('routing.reasoning', 'Plan mode', 'Optional reasoning model for planning (qwen3, deepseek-r1, gpt-oss — pair with Extended thinking below). Empty keeps the session model.', 'select', { options: [['', 'Keep the session model', ''], ...opts] })
    ));

    // --- generation
    sec.appendChild(el('h2', 'sub', 'Generation'));
    sec.appendChild(card(
      field('contextWindow', 'Context window', 'Requested context size in tokens (<code>num_ctx</code> for Ollama). Capped by the model. Larger = more memory and slower prompts.', 'select', { options: [[8192, '8k'], [16384, '16k'], [32768, '32k'], [65536, '64k'], [131072, '128k'], [262144, '256k']], cast: Number }),
      field('maxOutputTokens', 'Max output tokens', 'Upper bound per response.', 'number', { min: 256, max: 65536, step: 256 }),
      field('temperature', 'Temperature', 'Lower is more deterministic. 0.2 is a good default for code.', 'range', { min: 0, max: 1.5, step: 0.05, fmt: (v) => Number(v).toFixed(2) }),
      field('thinking', 'Extended thinking', 'For reasoning models (Ollama <code>think</code>, OpenAI <code>reasoning_effort</code>). Shows a collapsible “Thought for Ns” step.', 'seg', { options: [['off', 'Off'], ['on', 'On'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] }),
      field('keepAlive', 'Keep model loaded', 'How long Ollama keeps the model in memory after a request (e.g. <code>5m</code>, <code>30m</code>, <code>-1</code> = forever).', 'text', { placeholder: '30m', validate: (v) => /^(-1|0|\d+(ms|s|m|h))$/.test(v) })
    ));

    // --- catalog
    sec.appendChild(el('h2', 'sub', 'Model catalog'));
    const chips = el('div', 'chips');
    const filters = [['fits', 'Fits this machine'], ['all', 'All sizes'], ['agent', 'Agent'], ['completion', 'Completions'], ['vision', 'Vision'], ['reasoning', 'Reasoning']];
    for (const [k, l] of filters) { const b = el('button', `chip ${state.cat.filter === k ? 'on' : ''}`, esc(l)); b.onclick = () => { state.cat.filter = k; render(); }; chips.appendChild(b); }
    const q = el('input'); q.type = 'search'; q.placeholder = 'Search models…'; q.value = state.cat.q; q.oninput = debounce(() => { state.cat.q = q.value; render(); }, 250);
    chips.appendChild(q);
    sec.appendChild(chips);
    if (!running.length) { sec.appendChild(el('p', 'muted small', 'Start a runtime to install from here — Ollama, Docker Model Runner (with host access) or LM Studio. Models can still be pulled by hand (<code>ollama pull …</code>) and appear after a refresh.')); }
    const fams = [];
    for (const it of d.catalog) { let f = fams.find((x) => x.key === it.key); if (!f) { f = { key: it.key, name: it.name, vendor: it.vendor, description: it.description, roles: it.roles, items: [] }; fams.push(f); } f.items.push(it); }
    const ql = state.cat.q.trim().toLowerCase();
    let shown = 0;
    for (const f of fams) {
      if (ql && !`${f.name} ${f.vendor} ${f.description} ${f.roles.join(' ')} ${f.items.map((i) => i.tag).join(' ')}`.toLowerCase().includes(ql)) { continue; }
      if (['agent', 'completion', 'vision', 'reasoning'].includes(state.cat.filter) && !f.roles.includes(state.cat.filter)) { continue; }
      const items = state.cat.filter === 'all' || ql ? f.items : f.items.filter((i) => i.fits || i.tight || i.installed.length);
      if (!items.length) { continue; }
      shown++;
      const c = el('div', 'cat');
      const headEl = el('div', 'cat-head', `<span class="ic">${esc(f.name[0])}</span><div class="t"><b>${esc(f.name)}</b><span class="v">${esc(f.vendor)}</span><p>${esc(f.description)}</p></div><div class="tags">${f.roles.map((r) => `<span class="badge role">${esc(ROLE_LABEL[r] || r)}</span>`).join('')}</div>`);
      c.appendChild(headEl);
      const hiddenCount = f.items.length - items.length;
      for (const it of items) {
        const row = el('div', `cat-var ${!it.fits && !it.tight ? 'dim' : ''}`);
        const job = activeJob('pull', null, null) && state.jobs.find((j) => j.status === 'running' && j.kind === 'pull' && it.targets.some((t) => t.id === j.model && t.target === j.target));
        row.innerHTML = `<span class="sz">${esc(it.tag)}</span><span class="gb">${esc(gbText(it.gb))}</span><span class="fit">${it.fits ? '<span class="badge ok">fits</span>' : it.tight ? '<span class="badge warn">tight</span>' : '<span class="badge err">too big</span>'}</span>${it.recommendedFor.length ? `<span class="badge star" title="Best size of this family for this machine">${I.star} recommended</span>` : ''}${it.installed.length ? `<span class="badge ok" title="${esc(it.installed.join(', '))}">${I.check} installed</span>` : ''}<span class="spacer"></span>`;
        const act = el('div', 'cat-act');
        row.appendChild(act);
        if (job) {
          act.classList.add('prog-grp');
          act.appendChild(progressBar(job));
          act.appendChild(el('span', 'pct', job.progress >= 0 ? `${Math.round(job.progress * 100)}%` : ''));
          const cancel = el('button', 'btn ghost sm', I.x); cancel.title = 'Cancel'; cancel.onclick = () => post({ type: 'cancelJob', id: job.id });
          act.appendChild(cancel);
        } else if (it.targets.length) {
          const key = `${it.key}:${it.tag}`;
          let target = state.installTarget[key] || it.targets[0].target;
          if (!it.targets.some((t) => t.target === target)) { target = it.targets[0].target; }
          if (it.targets.length > 1) {
            const sel = el('select'); sel.setAttribute('aria-label', 'Install to');
            for (const t of it.targets) { const o = el('option'); o.value = t.target; o.textContent = TARGET_LABEL[t.target]; o.selected = t.target === target; sel.appendChild(o); }
            sel.onchange = () => { state.installTarget[key] = sel.value; };
            act.appendChild(sel);
          }
          const already = it.installed.some((id) => id.startsWith(`${(d.runtimes.find((r) => r.target === target) || {}).providerId}/`));
          const b = el('button', `btn sm ${it.recommendedFor.length && !already ? 'primary' : ''}`, `${I.download}${already ? 'Reinstall' : it.targets.length > 1 ? 'Install' : `Install to ${TARGET_LABEL[target]}`}`);
          b.title = `${target === 'ollama' ? 'ollama pull' : target === 'docker' ? 'docker model pull' : 'lms get'} ${it.targets.find((t) => t.target === target).id}`;
          b.onclick = () => { const tgt = state.installTarget[key] || target; const t = it.targets.find((x) => x.target === tgt) || it.targets[0]; post({ type: 'installModel', target: t.target, model: t.id }); toast(`Installing ${f.name} ${it.tag} on ${TARGET_LABEL[t.target]}…`); };
          act.appendChild(b);
        } else {
          act.appendChild(el('span', 'note', running.length ? `Not published for ${running.map((r) => r.label).join(' / ')} — pull it by hand` : 'Start a runtime to install'));
        }
        c.appendChild(row);
      }
      if (hiddenCount > 0) {
        const more = el('button', 'cat-more', `${hiddenCount} larger size${hiddenCount === 1 ? '' : 's'} hidden — show all sizes`);
        more.onclick = () => { state.cat.filter = 'all'; render(); };
        c.appendChild(more);
      }
      sec.appendChild(c);
    }
    if (!shown) { sec.appendChild(el('div', 'empty', 'Nothing matches. Clear the search or switch to “All sizes”.')); }
    sec.appendChild(el('p', 'muted small', 'Sizes are approximate Q4 footprints. “Fits” means the model stays within the budget above with room for its context cache; “tight” may still run by offloading layers to RAM, more slowly.'));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }

  // ------------------------------------------------------------------ agent & approvals
  function secAgent(sec) {
    head(sec, 'Agent & approvals', 'Control what the agent may do on its own. “Ask” shows an inline approval card in the chat; “Allow” proceeds silently; “Block” refuses.');
    const cur = { terminal: val('approvals.terminal'), write: val('approvals.write'), delete: val('approvals.delete'), network: val('approvals.network') };
    const presets = el('div', 'approval-presets');
    for (const [k, p] of Object.entries(APPROVAL_PRESETS)) {
      const on = Object.keys(p.v).every((x) => p.v[x] === cur[x]);
      const b = el('button', `ap ${on ? 'on' : ''}`, `<b>${esc(p.title)}</b><span>${esc(p.desc)}</span>`);
      b.onclick = () => { for (const [x, v] of Object.entries(p.v)) { if (cur[x] !== v) { set(`approvals.${x}`, v); } } };
      presets.appendChild(b);
    }
    sec.appendChild(presets);
    sec.appendChild(card(
      field('approvals.terminal', 'Terminal commands', '<code>run_command</code> — shell commands in the workspace.', 'seg', { options: APPROVAL }),
      field('approvals.write', 'File edits', '<code>edit_file</code>, <code>write_file</code>, <code>create_directory</code>. Every edit is tracked and can be undone from the Changes panel either way.', 'seg', { options: APPROVAL }),
      field('approvals.delete', 'Deleting files', '<code>delete_path</code> — moves to the OS trash when possible.', 'seg', { options: APPROVAL }),
      field('approvals.network', 'Network & MCP', '<code>web_search</code>, <code>web_fetch</code> and tools from MCP servers.', 'seg', { options: APPROVAL })
    ));
    sec.appendChild(el('h2', 'sub', 'Terminal'));
    sec.appendChild(card(
      field('terminal.runInIntegratedTerminal', 'Run commands in a visible terminal', 'The agent\'s <code>run_command</code> calls run in a branded <b>LocalPilot Agent</b> terminal through shell integration, so you can watch them live. Falls back to a hidden process when the shell has no integration.', 'toggle'),
      field('terminal.reveal', 'Reveal the terminal when a command runs', 'Shows the panel without stealing focus from the editor.', 'toggle')
    ));
    sec.appendChild(el('h2', 'sub', 'Parallelism & context'));
    sec.appendChild(card(
      field('parallel.maxConcurrency', 'Max concurrent tools / subagents', 'Read-only tools and parallel subagents run concurrently up to this limit.', 'number', { min: 1, max: 16 }),
      field('parallel.maxSubagentDepth', 'Max subagent depth', 'How deeply subagents may spawn further subagents.', 'number', { min: 0, max: 5 }),
      field('compactionThreshold', 'Compact context at', 'When the context reaches this share of the window, older messages are summarised automatically.', 'range', { min: 0.4, max: 0.95, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` }),
      field('maxToolOutputChars', 'Max tool output', 'Longer outputs are truncated (head + tail) before reaching the model.', 'number', { min: 2000, max: 200000, step: 1000 }),
      field('systemPromptAppend', 'Extra instructions', 'Appended to every system prompt — coding conventions, preferred libraries, language. Project rules in <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>.cursorrules</code> and <code>.github/copilot-instructions.md</code> are loaded automatically.', 'textarea', { wide: true, placeholder: 'Always use TypeScript strict mode. Prefer small, pure functions. Reply in English.' })
    ));
  }

  // ------------------------------------------------------------------ completions
  function secCompletions(sec) {
    head(sec, 'Inline completions', 'Ghost-text suggestions from a local fill-in-the-middle model as you type.');
    const fim = modelOptions((m) => m.supportsFim);
    sec.appendChild(card(
      field('inlineCompletion.enabled', 'Enable inline completions', `Works best with small base/FIM models: <code>qwen2.5-coder:1.5b-base</code>, <code>qwen2.5-coder:7b-base</code>, <code>codestral</code>, <code>starcoder2</code>.${fim.length ? '' : ' <span class="err-text">No FIM-capable model found yet.</span>'}`, 'toggle'),
      field('inlineCompletion.model', 'Completion model', 'Empty = the smallest FIM-capable model that fits this machine (see <a data-sec="models">Models → Routing</a>).', 'select', { options: [['', 'Auto (smallest FIM model)', ''], ...(fim.length ? fim : modelOptions())] }),
      field('inlineCompletion.debounceMs', 'Debounce', 'Milliseconds of idle typing before requesting a suggestion.', 'number', { min: 50, max: 2000, step: 50 }),
      field('inlineCompletion.maxTokens', 'Max tokens per suggestion', '', 'number', { min: 16, max: 1024, step: 16 })
    ));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }

  // ------------------------------------------------------------------ web search
  function secWeb(sec) {
    head(sec, 'Web search', 'Optional. The <code>web_search</code> and <code>web_fetch</code> tools are governed by the Network approval policy.');
    const prov = val('webSearch.provider');
    sec.appendChild(card(
      field('webSearch.provider', 'Search provider', '<b>DuckDuckGo</b> needs no key. <b>SearXNG</b> is self-hosted and fully private. <b>Brave</b> and <b>Tavily</b> need an API key.', 'select', { options: [['duckduckgo', 'DuckDuckGo'], ['searxng', 'SearXNG (self-hosted)'], ['brave', 'Brave Search'], ['tavily', 'Tavily']] }),
      prov === 'searxng' ? field('webSearch.searxngUrl', 'SearXNG URL', 'Your instance, e.g. <code>http://localhost:8888</code>.', 'text', { placeholder: 'http://localhost:8888', validate: (v) => /^https?:\/\/.+/.test(v) }) : null,
      prov === 'brave' || prov === 'tavily' ? field('webSearch.apiKey', 'API key', '', 'password') : null,
      field('webSearch.maxResults', 'Max results', '', 'number', { min: 1, max: 20 })
    ));
  }

  // ------------------------------------------------------------------ memory & skills
  function secMemory(sec) {
    const d = state.data;
    head(sec, 'Memory & skills', 'Durable notes the agent keeps between chats, and the skills and subagents it can load.');
    const mem = el('div', 'btnrow');
    mem.innerHTML = `<span class="muted small">${d.memory.project} project note(s) · ${d.memory.global} global note(s)</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.openMemory">${I.book}Open notes</button><button class="btn sm danger" data-cmd="localpilot.clearMemory">${I.trash}Clear…</button>`;
    sec.appendChild(card(
      field('memory.enabled', 'Enable memory', 'The agent can <code>memory_save</code> / <code>memory_read</code> notes in <code>.localpilot/memory/</code> (project, commit-able) and in global storage. A compact index is added to every prompt.', 'toggle', { after: mem })
    ));
    sec.appendChild(el('h2', 'sub', 'Skill folders'));
    const paths = Array.isArray(val('skillsPaths')) ? val('skillsPaths') : [];
    const sp = el('div', 'card');
    const f = el('div', 'field wide');
    f.innerHTML = `<div><div class="lbl">Extra skill folders${scopeBadge('skillsPaths')}${resetBtn('skillsPaths')}</div><div class="desc"><code>.localpilot/skills</code>, <code>.claude/skills</code>, <code>.cursor/rules</code> and <code>.github/skills</code> are scanned automatically. Add more folders here (each skill is a folder with <code>SKILL.md</code>).</div></div>`;
    const ctl = el('div', 'ctl');
    const ul = el('ul', 'list');
    paths.forEach((p, i) => { const li = el('li', '', `<code>${esc(p)}</code><button class="reset x" title="Remove">${I.x}</button>`); li.querySelector('button').onclick = () => set('skillsPaths', paths.filter((_, j) => j !== i)); ul.appendChild(li); });
    const addRow = el('div', 'row', `<input type="text" placeholder="/path/to/skills or ~/skills"><button class="btn sm">${I.plus}Add</button>`);
    addRow.querySelector('button').onclick = () => { const v = addRow.querySelector('input').value.trim(); if (v) { set('skillsPaths', [...paths, v]); } };
    ctl.appendChild(ul); ctl.appendChild(addRow); f.appendChild(ctl); sp.appendChild(f); sec.appendChild(sp);
    const tableFor = (title, rows, empty) => {
      const h = el('h2', 'sub', `${title} (${rows.length})`);
      sec.appendChild(h);
      if (!rows.length) { sec.appendChild(el('div', 'empty', empty)); return; }
      const t = el('table', 'tbl', `<thead><tr><th>Name</th><th>Description</th><th>Source</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td>${esc(r.description)}</td><td><span class="badge">${esc(r.source)}</span></td></tr>`).join('')}</tbody>`);
      sec.appendChild(card(t));
    };
    tableFor('Skills', d.skills, 'No skills found. Create <code>.localpilot/skills/&lt;name&gt;/SKILL.md</code> in your project.');
    tableFor('Subagents', d.agents, 'No subagents found. Create <code>.localpilot/agents/&lt;name&gt;.md</code> with a description and system prompt.');
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" data-cmd="localpilot.reloadSkills">${I.refresh}Reload skills, subagents & MCP</button>`;
    sec.appendChild(bar);
  }

  // ------------------------------------------------------------------ mcp
  function secMcp(sec) {
    head(sec, 'MCP servers', 'Model Context Protocol servers (stdio) whose tools become available to the agent. Governed by the Network approval policy.');
    const servers = val('mcpServers') && typeof val('mcpServers') === 'object' ? { ...val('mcpServers') } : {};
    const status = new Map((state.data.mcp || []).map((s) => [s.name, s]));
    const names = Object.keys(servers);
    const list = el('div');
    if (!names.length) { list.appendChild(el('div', 'empty', 'No MCP servers configured. Add one below — for example the filesystem or GitHub server from <code>@modelcontextprotocol</code>.')); }
    for (const name of names) {
      const s = servers[name] || {};
      const open = state.expanded === `mcp:${name}`;
      const c = el('div', `prov ${s.enabled === false ? 'off' : ''}`);
      const st = status.get(name);
      const tools = st && !st.error ? st.tools : undefined;
      const err = st && st.error;
      c.innerHTML = `<div class="prov-head"><span class="dot ${s.enabled === false ? '' : tools !== undefined ? 'ok' : 'err'}"></span><div class="prov-title"><b>${esc(name)}</b><span>${esc([s.command, ...(s.args || [])].join(' '))}</span></div><div class="prov-meta">${tools !== undefined ? `<span class="badge ok">${tools} tool${tools === 1 ? '' : 's'}</span>` : s.enabled === false ? '<span class="badge">disabled</span>' : `<span class="badge err" title="${esc(err || '')}">${err ? 'failed to start' : 'not connected'}</span>`}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
      if (err && s.enabled !== false) { c.appendChild(el('div', 'prov-result err', `${I.x} ${esc(err)}`)); }
      c.querySelector('.prov-head').onclick = () => { state.expanded = open ? null : `mcp:${name}`; render(); };
      if (open) { c.appendChild(mcpForm(name, s, servers)); }
      list.appendChild(c);
    }
    sec.appendChild(list);
    sec.appendChild(el('h2', 'sub', 'Add a server'));
    const add = el('div', 'card');
    const f = el('div', 'field wide');
    f.innerHTML = `<div><div class="lbl">New MCP server</div><div class="desc">Give it a name and the command to launch it. Example: <code>npx -y @modelcontextprotocol/server-filesystem /path</code></div></div>`;
    const ctl = el('div', 'ctl');
    ctl.innerHTML = `<div class="row"><input type="text" id="mcpName" placeholder="name (e.g. filesystem)" style="max-width:200px"><input type="text" id="mcpCmd" placeholder="command and args"><button class="btn primary sm" id="mcpAdd">${I.plus}Add</button></div>`;
    ctl.querySelector('#mcpAdd').onclick = () => {
      const name = ctl.querySelector('#mcpName').value.trim().replace(/[^\w.-]+/g, '-');
      const parts = ctl.querySelector('#mcpCmd').value.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      if (!name || !parts.length) { toast('Name and command are required', 'error'); return; }
      if (servers[name]) { toast(`“${name}” already exists`, 'error'); return; }
      servers[name] = { command: parts[0].replace(/"/g, ''), args: parts.slice(1).map((a) => a.replace(/"/g, '')) };
      state.expanded = `mcp:${name}`;
      set('mcpServers', servers);
    };
    f.appendChild(ctl); add.appendChild(f); sec.appendChild(add);
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" data-cmd="localpilot.reloadSkills">${I.refresh}Reconnect servers</button><span class="muted small">Servers start when LocalPilot activates and after you reload.</span>`;
    sec.appendChild(bar);
  }
  function mcpForm(name, s, servers) {
    const body = el('div', 'prov-body');
    const upd = (patch) => { servers[name] = { ...s, ...patch }; for (const k of Object.keys(servers[name])) { if (servers[name][k] === undefined) { delete servers[name][k]; } } set('mcpServers', servers); };
    const row = (label, desc, input) => { const f = el('div', 'field'); f.innerHTML = `<div><div class="lbl">${esc(label)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`; const ctl = el('div', 'ctl'); ctl.appendChild(input); f.appendChild(ctl); return f; };
    const cmd = el('input'); cmd.type = 'text'; cmd.value = s.command || ''; cmd.onchange = () => upd({ command: cmd.value.trim() });
    const args = el('input'); args.type = 'text'; args.value = (s.args || []).join(' '); args.placeholder = 'space-separated'; args.onchange = () => upd({ args: args.value.trim() ? args.value.trim().split(/\s+/) : undefined });
    const cwd = el('input'); cwd.type = 'text'; cwd.value = s.cwd || ''; cwd.placeholder = 'workspace root'; cwd.onchange = () => upd({ cwd: cwd.value.trim() || undefined });
    const env = el('textarea'); env.value = s.env ? JSON.stringify(s.env, null, 2) : ''; env.placeholder = '{ "API_KEY": "…" }';
    env.onchange = () => { try { upd({ env: env.value.trim() ? JSON.parse(env.value) : undefined }); env.classList.remove('invalid'); } catch { env.classList.add('invalid'); toast('Environment must be valid JSON', 'error'); } };
    const en = el('button', `toggle ${s.enabled !== false ? 'on' : ''}`); en.onclick = () => upd({ enabled: s.enabled === false ? undefined : false });
    body.appendChild(row('Command', '', cmd));
    body.appendChild(row('Arguments', '', args));
    body.appendChild(row('Working directory', '', cwd));
    body.appendChild(row('Environment', 'JSON object of extra environment variables.', env));
    body.appendChild(row('Enabled', '', en));
    const foot = el('div', 'prov-foot');
    foot.innerHTML = `<span class="spacer"></span><button class="btn danger">${I.trash}Remove</button>`;
    foot.querySelector('button').onclick = () => { delete servers[name]; state.expanded = null; set('mcpServers', servers); };
    body.appendChild(foot);
    return body;
  }

  // ------------------------------------------------------------------ advanced
  function secAdvanced(sec) {
    const d = state.data;
    head(sec, 'Advanced', 'Housekeeping, diagnostics and the raw settings files.');
    sec.appendChild(card(
      field('showWelcomeOnStartup', 'Show setup on first run', 'Open the welcome screen when LocalPilot starts and no model server has been configured yet.', 'toggle')
    ));
    sec.appendChild(el('h2', 'sub', 'Tools'));
    const grid = el('div', 'card');
    const tools = [
      ['Run setup again', 'Detect servers, pick a model and an approval preset.', 'localpilot.openWelcome', I.rocket],
      ['Open a LocalPilot terminal', 'A branded terminal with the <code>localpilot</code> CLI already on PATH — run the agent right there: <code>localpilot "fix the tests"</code>.', 'localpilot.openTerminal', I.bolt],
      ['Install the <code>localpilot</code> CLI', 'Put <code>localpilot</code> on your PATH for every terminal (also outside VS Code).', 'localpilot.installCli', I.wrench],
      ['Open settings.json', 'Edit every <code>localpilot.*</code> key by hand.', state.scope === 'workspace' ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson', I.wrench],
      ['VS Code settings UI', 'The same settings in the built-in editor.', 'workbench.action.openSettings', I.wrench, ['@ext:localpilot.localpilot-agent']],
      ['Show logs', 'Provider requests, tool runs and errors.', 'localpilot.showLogs', I.book],
    ];
    for (const [t, desc, cmdId, icon, args] of tools) {
      const f = el('div', 'field');
      f.innerHTML = `<div><div class="lbl">${t}</div><div class="desc">${desc}</div></div><div class="ctl"><button class="btn" data-cmd="${cmdId}" ${args ? `data-args='${JSON.stringify(args)}'` : ''}>${icon}Open</button></div>`;
      grid.appendChild(f);
    }
    sec.appendChild(grid);
    sec.appendChild(el('h2', 'sub', 'About'));
    const about = el('div', 'card');
    about.innerHTML = `<div class="field wide"><dl class="kv"><dt>Version</dt><dd>${esc(d.version)}</dd><dt>Chats</dt><dd>${d.sessions}</dd><dt>Models</dt><dd>${(d.models || []).length} from ${providersList().filter((p) => p.enabled !== false).length} provider(s)</dd><dt>Privacy</dt><dd>LocalPilot talks only to the servers listed under Providers. No telemetry, no account.</dd><dt>Author</dt><dd><a data-url="https://github.com/isathish">Sathishkumar Nagarajan</a> · <a data-url="https://github.com/isathish">@isathish on GitHub</a></dd><dt>Links</dt><dd><a data-url="https://isathish.github.io/localpilot/">Website</a> · <a data-url="https://isathish.github.io/localpilot/docs/configuration/">Configuration reference</a> · <a data-url="https://github.com/isathish/localpilot/issues">Report an issue</a></dd></dl></div>`;
    sec.appendChild(about);
  }

  // ------------------------------------------------------------------ setup wizard
  function renderSetup() {
    const d = state.data;
    const su = state.setup;
    const wrap = el('div', 'setup');
    wrap.innerHTML = `<div class="hero"><img src="${LOGO}" alt=""><h1>Welcome to LocalPilot</h1><p>A coding agent that runs entirely on your machine. Let's connect a model server — it takes about a minute.</p></div><div class="steps">${[0, 1, 2].map((i) => `<i class="${i <= su.step ? 'on' : ''}"></i>`).join('')}</div>`;
    const c = el('div', 'card');
    if (su.step === 0) {
      c.innerHTML = `<h3>1 · Find your model server</h3><p class="hint">LocalPilot is checking the usual local ports. Start a server if nothing shows up, then check again.</p>`;
      const det = el('div', 'detect');
      const results = state.probe;
      if (!results) { det.innerHTML = `<div class="srv"><span class="spinner"></span><div class="t"><b>Looking for Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner and model containers…</b></div></div>`; }
      else {
        // Configured servers and anything reachable are listed; silent well-known ports stay out of the way.
        for (const r of results.filter((x) => x.ok || x.configured)) {
          const tag = r.source === 'docker' ? '<span class="tag">Docker</span>' : !r.configured ? '<span class="tag">new</span>' : '';
          det.appendChild(el('div', `srv ${r.ok ? 'ok' : ''}`, `<span class="dot ${r.ok ? 'ok' : 'err'}"></span><div class="t"><b>${esc(r.displayName)}${tag}</b><span>${esc(r.baseUrl)}</span></div><span class="n">${r.ok ? `${r.models.length} model${r.models.length === 1 ? '' : 's'}` : 'not running'}</span>`));
        }
        if (state.dmr === 'no-tcp') {
          det.appendChild(el('div', 'srv', `<span class="dot warn"></span><div class="t"><b>Docker Model Runner</b><span>running, but host access is off — run <code>docker desktop enable model-runner --tcp=12434</code> and check again</span></div>`));
        }
      }
      c.appendChild(det);
      const found = (results || []).filter((r) => r.ok);
      if (results && !found.length) {
        const help = el('div');
        help.style.marginTop = '14px';
        const setupJob = state.jobs.find((j) => j.status === 'running' && ['setup', 'pull', 'install-runtime', 'start'].includes(j.kind));
        const ol = (state.runtimes || []).find((r) => r.target === 'ollama');
        const st = state.starter;
        const plan = st ? `${st.agent}${st.completion ? ` + ${st.completion}` : ''} (≈ ${st.gb} GB)` : 'a coder model sized for this machine';
        const label = ol && !ol.installed ? 'Install Ollama & starter model' : ol && !ol.running ? 'Start Ollama & download starter model' : 'Download starter model';
        const sub = ol && !ol.installed ? `Installs Ollama ${st ? st.platformNote : ''} in a terminal, starts it and downloads ${plan}. One click — nothing else to configure.` : ol && !ol.running ? `Ollama is installed but not running. Starts it and downloads ${plan}.` : `Downloads ${plan} into Ollama.`;
        const pct = setupJob && setupJob.progress >= 0 ? ` ${Math.round(setupJob.progress * 100)}%` : '';
        help.innerHTML = `<div class="auto-setup"><button class="btn brand" id="autoSetup" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${esc(setupJob ? 'Setting up…' : label)}</button><div class="auto-sub">${setupJob ? `<b>${esc(setupJob.kind === 'pull' ? `Downloading ${setupJob.model}${pct}` : setupJob.kind === 'install-runtime' ? 'Installing Ollama' : setupJob.kind === 'start' ? 'Starting Ollama' : 'Setting up')}</b><span>${esc(setupJob.detail || '')}</span>${setupJob.progress >= 0 ? `<div class="progress"><i style="width:${Math.max(2, Math.round(setupJob.progress * 100))}%"></i></div>` : ''}` : esc(sub)}</div></div><p class="hint"><b>Or do it yourself</b> — any of these works:</p><ul class="help-list"><li><b>Ollama</b> — install from <a data-url="https://ollama.com">ollama.com</a>, then <code>ollama pull qwen2.5-coder:7b</code>. It starts automatically.</li><li><b>Docker</b> — <code>docker model pull ai/qwen2.5-coder</code> with Docker Desktop's Model Runner (enable host access: <code>docker desktop enable model-runner --tcp=12434</code>), or run any Ollama / vLLM / llama.cpp container with a published port.</li><li><b>LM Studio</b> — open the <i>Developer</i> tab and start the local server (port 1234).</li><li><b>llama.cpp</b> — <code>llama-server -m model.gguf --port 8080</code></li><li><b>vLLM</b> — <code>vllm serve Qwen/Qwen2.5-Coder-7B-Instruct</code></li></ul>`;
        c.appendChild(help);
        help.querySelector('#autoSetup').onclick = () => { state.setup.pendingAuto = true; const ol2 = (state.runtimes || []).find((r) => r.target === 'ollama'); post({ type: 'autoSetup', installRuntime: !!(ol2 && !ol2.installed), target: 'ollama' }); render(); };
      }
      const foot = el('div', 'foot');
      foot.innerHTML = `<button class="btn" id="again">${state.busy ? '<span class="spinner"></span>' : I.refresh}Check again</button><button class="btn link" id="manual">Add a custom endpoint…</button><span class="spacer"></span><button class="btn link" id="skip">Skip setup</button><button class="btn brand" id="next" ${found.length ? '' : 'disabled'}>Continue ${I.chev}</button>`;
      foot.querySelector('#again').onclick = () => { state.busy = true; render(); post({ type: 'probe' }); };
      foot.querySelector('#manual').onclick = () => { state.page = 'settings'; state.section = 'providers'; render(); };
      foot.querySelector('#skip').onclick = () => post({ type: 'finishSetup' });
      foot.querySelector('#next').onclick = () => { su.providers = results.filter((r) => r.ok || r.configured).map((r) => ({ id: r.id, type: r.type, baseUrl: r.baseUrl, displayName: r.displayName })); if (!su.model) { su.model = recommend(found); } su.step = 1; render(); };
      c.appendChild(foot);
    } else if (su.step === 1) {
      const found = (state.probe || []).filter((r) => r.ok);
      const all = found.flatMap((r) => r.models.map((m) => ({ ...m, provider: r.displayName })));
      c.innerHTML = `<h3>2 · Choose a default model</h3><p class="hint">For agent mode pick a tool-capable coder model (qwen2.5-coder 7b–32b, devstral, qwen3, gpt-oss). You can switch per chat at any time.</p>`;
      const list = el('div', 'mdl-list');
      if (!all.length) {
        const e = el('div', 'empty', 'The server is running but has no models yet. <button class="btn brand sm" id="autoSetup2">Download a starter model</button> or pull one by hand (e.g. <code>ollama pull qwen2.5-coder:7b</code>) and go back.');
        e.querySelector('#autoSetup2').onclick = () => { su.pendingAuto = true; post({ type: 'autoSetup', installRuntime: false, target: 'ollama' }); su.step = 0; render(); };
        list.appendChild(e);
      }
      for (const m of all) {
        const b = el('button', `mdl ${su.model === m.id ? 'on' : ''}`, `<div class="t"><b>${esc(m.name)}</b><span>${esc(m.provider)} · ${Math.round(m.contextWindow / 1024)}k context</span></div><div class="tags">${m.id === recommend(found) ? '<span class="badge brand">recommended</span>' : ''}${m.supportsTools ? '<span class="badge ok">tools</span>' : '<span class="badge">prompt tools</span>'}${m.supportsVision ? '<span class="badge">vision</span>' : ''}${m.supportsFim ? '<span class="badge">FIM</span>' : ''}</div>`);
        b.onclick = () => { su.model = m.id; render(); };
        list.appendChild(b);
      }
      c.appendChild(list);
      const foot = el('div', 'foot');
      foot.innerHTML = `<button class="btn link" id="back">Back</button><span class="spacer"></span><button class="btn brand" id="next" ${su.model ? '' : 'disabled'}>Continue ${I.chev}</button>`;
      foot.querySelector('#back').onclick = () => { su.step = 0; render(); };
      foot.querySelector('#next').onclick = () => { su.step = 2; render(); };
      c.appendChild(foot);
    } else {
      c.innerHTML = `<h3>3 · How much freedom should the agent have?</h3><p class="hint">You can change this any time in Settings → Agent &amp; approvals. Every file edit is tracked and can be undone regardless.</p>`;
      const presets = el('div', 'approval-presets');
      for (const [k, p] of Object.entries(APPROVAL_PRESETS)) {
        const b = el('button', `ap ${su.approvals === k ? 'on' : ''}`, `<b>${esc(p.title)}</b><span>${esc(p.desc)}</span>`);
        b.onclick = () => { su.approvals = k; render(); };
        presets.appendChild(b);
      }
      c.appendChild(presets);
      const fim = (state.probe || []).some((r) => r.ok && r.models.some((m) => m.supportsFim));
      const row = el('div', 'field');
      row.style.borderBottom = 'none';
      row.innerHTML = `<div><div class="lbl">Inline completions</div><div class="desc">Ghost-text suggestions while you type.${fim ? '' : ' Needs a small FIM model such as <code>qwen2.5-coder:1.5b-base</code> — you can enable it later.'}</div></div><div class="ctl"><button class="toggle ${su.inline ? 'on' : ''}" role="switch"></button></div>`;
      row.querySelector('.toggle').onclick = (e) => { su.inline = !su.inline; e.target.classList.toggle('on'); };
      c.appendChild(row);
      const foot = el('div', 'foot');
      foot.innerHTML = `<button class="btn link" id="back">Back</button><span class="spacer"></span><button class="btn brand" id="done">${I.check}Finish & open chat</button>`;
      foot.querySelector('#back').onclick = () => { su.step = 1; render(); };
      foot.querySelector('#done').onclick = () => post({ type: 'finishSetup', model: su.model, approvals: su.approvals, inlineCompletion: su.inline, providers: su.providers || undefined });
      c.appendChild(foot);
    }
    wrap.appendChild(c);
    const foot = el('p', 'muted small');
    foot.style.textAlign = 'center'; foot.style.marginTop = '18px';
    foot.innerHTML = `Your code never leaves your machine. <a data-url="https://isathish.github.io/localpilot/docs/getting-started/">Getting started guide</a> · <a id="toSettings">All settings</a>`;
    foot.querySelector('#toSettings').onclick = () => { state.page = 'settings'; render(); };
    wrap.appendChild(foot);
    app.appendChild(wrap);
    wireGlobal(app);
    if (!state.probe && !state.busy) { state.busy = true; post({ type: 'probe' }); }
  }
  function recommend(found) {
    const all = found.flatMap((r) => r.models);
    const score = (m) => { const n = m.name.toLowerCase(); const sz = /(\d+(?:\.\d+)?)b/.exec(n); const b = sz ? parseFloat(sz[1]) : 7; return (m.supportsTools ? 10 : 0) + (/coder|devstral|codestral/.test(n) ? 5 : 0) + (/qwen|llama|mistral|gemma|deepseek|gpt-oss/.test(n) ? 2 : 0) + Math.min(b, 32) / 8 - (b > 40 ? 3 : 0) - (/embed|rerank|vl|llava|whisper/.test(n) ? 20 : 0); };
    return [...all].sort((a, b) => score(b) - score(a))[0]?.id || '';
  }

  // ------------------------------------------------------------------ messaging
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state':
        state.data = m;
        if (m.page) { state.page = m.page; }
        if (m.section) { state.section = m.section; }
        if (m.section === 'models' && state.models && !state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
        render();
        break;
      case 'probe': {
        state.probe = m.results; state.busy = false; state.dmr = m.dockerModelRunner || null; state.runtimes = m.runtimes || state.runtimes; state.starter = m.starter || state.starter;
        for (const r of m.results) { state.tests[r.id] = r; }
        // After a one-click setup from the wizard, jump straight to the model step with the recommendation selected.
        const found = m.results.filter((r) => r.ok && r.models.length);
        if (state.page === 'setup' && state.setup.pendingAuto && found.length) { state.setup.pendingAuto = false; state.setup.providers = m.results.filter((r) => r.ok || r.configured).map((r) => ({ id: r.id, type: r.type, baseUrl: r.baseUrl, displayName: r.displayName })); state.setup.model = recommend(found); state.setup.step = 1; }
        render();
        break;
      }
      case 'testResult':
        state.tests[m.id] = m.result;
        render();
        break;
      case 'models':
        state.models = m.models; state.jobs = m.models.jobs || state.jobs; state.modelsRequested = false;
        if (state.section === 'models' || state.page === 'setup') { render(); }
        break;
      case 'jobs':
        state.jobs = m.jobs || [];
        if ((state.section === 'models' && state.models) || state.page === 'setup') { render(); }
        break;
      case 'busy':
        state.busy = m.busy;
        if (!m.busy) { render(); }
        break;
      case 'toast':
        toast(m.text, m.level);
        break;
    }
  });
  post({ type: 'ready' });
})();
