// LocalPilot chat webview — vanilla JS, no dependencies.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $('messages'), input: $('input'), send: $('btnSend'), stop: $('btnStop'), status: $('status'),
    statusText: $('statusText'), mode: $('mode'), model: $('model'), modelPicker: $('modelPicker'), ctx: $('ctxMeter'),
    approvals: $('approvals'), chips: $('chips'), toasts: $('toasts'), box: $('box'),
    changes: $('changes'), changesList: $('changesList'), changesLabel: $('changesLabel'), changesToggle: $('changesToggle'),
  };

  const ICON = {
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    spin: '<svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-5.2 3"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
    insert: '<svg viewBox="0 0 16 16"><path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10"/></svg>',
    apply: '<svg viewBox="0 0 16 16"><path d="M3 3h7l3 3v7H3z"/><path d="M5 13V9h6v4"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1" fill="currentColor"/><circle cx="15" cy="9.5" r="1" fill="currentColor"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.8v.2"/></svg>',
    sparkle: '<svg viewBox="0 0 16 16"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
    bug: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="4"/><path d="M8 5V3M5 6L3 4M11 6l2-2M3 10H1M15 10h-2M4 13l-2 1M12 13l2 1"/></svg>',
    beaker: '<svg viewBox="0 0 16 16"><path d="M6 2v5l-3.5 6a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L10 7V2"/><path d="M5 2h6"/></svg>',
  };

  const state = { session: null, models: [], defaultModel: '', running: new Set(), attachments: [], images: [], skills: [], agents: [], openFiles: [], live: new Map(), changes: new Map() };
  const MENTIONS = [
    ['workspace', 'Project file tree'], ['selection', 'Current selection / active file'], ['problems', 'Errors & warnings'], ['git', 'git status + diff'], ['editors', 'List of open editors'],
  ];

  // ------------------------------------------------------------------ markdown
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(md) {
    let s = esc(md);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" title="$2">$1</a>');
    s = s.replace(/(^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,8})(?::(\d+))?(?=[\s).,;:]|$)/g, (m, pre, p, line) => `${pre}<span class="path-link" data-path="${p}" data-line="${line || ''}">${p}${line ? ':' + line : ''}</span>`);
    return s;
  }

  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushPara();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<div class="codebar"><span class="lang">${esc(lang || 'text')}</span><button data-code-action="copy" title="Copy">${ICON.copy}</button><button data-code-action="insert" title="Insert at cursor">${ICON.insert}</button><button data-code-action="apply" title="Apply to active file">${ICON.apply}</button></div><pre><code class="lang-${esc(lang)}">${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          if (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')); }
          else { items[items.length - 1] += '\n' + lines[i].trim(); }
          i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
    return out.join('');
  }

  // ------------------------------------------------------------------ rendering
  function scrollToBottom(force) {
    const m = els.messages;
    if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 140) { m.scrollTop = m.scrollHeight; }
  }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (html !== undefined) { e.innerHTML = html; }
    return e;
  }

  function toolLabel(name, args) {
    const a = args || {};
    const s = (v, n = 70) => { const t = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return esc(t.length > n ? t.slice(0, n - 1) + '…' : t); };
    switch (name) {
      case 'read_file': return `Read <b>${s(a.path)}</b>${a.start_line ? ` <i>lines ${a.start_line}–${a.end_line || ''}</i>` : ''}`;
      case 'edit_file': return `Edited <b>${s(a.path)}</b>`;
      case 'write_file': return `Wrote <b>${s(a.path)}</b>`;
      case 'list_dir': return `Listed <b>${s(a.path || '.')}</b>`;
      case 'create_directory': return `Created folder <b>${s(a.path)}</b>`;
      case 'delete_path': return `Deleted <b>${s(a.path)}</b>`;
      case 'grep_search': return `Searched for <b>${s(a.query)}</b>`;
      case 'file_search': return `Found files <b>${s(a.pattern)}</b>`;
      case 'find_symbol': return `Looked up symbol <b>${s(a.query)}</b>`;
      case 'find_references': return `Found references to <b>${s(a.symbol)}</b>`;
      case 'run_command': return `Ran <b>${s(a.command)}</b>`;
      case 'get_diagnostics': return `Checked diagnostics${a.path ? ` in <b>${s(a.path)}</b>` : ''}`;
      case 'web_search': return `Searched the web for <b>${s(a.query)}</b>`;
      case 'web_fetch': return `Fetched <b>${s(a.url)}</b>`;
      case 'run_subagent': return `Delegated to <b>${s(a.agent)}</b> · ${s(a.prompt, 60)}`;
      case 'run_parallel_subagents': return `Ran <b>${(a.tasks || []).length} subagents</b> in parallel`;
      case 'load_skill': return `Loaded skill <b>${s(a.name)}</b>`;
      case 'ask_user': return `Asked: ${s(a.question)}`;
      case 'get_editor_state': return 'Read editor state';
      case 'open_file': return `Opened <b>${s(a.path)}</b>`;
      default: return `${esc(name)} ${s(a, 60)}`;
    }
  }

  function stepEl(cls, label, contentText) {
    const d = el('details', `step ${cls}`);
    d.innerHTML = `<summary><span class="ico"></span><span class="label">${label}</span><span class="dur"></span><span class="chev">${ICON.chev}</span></summary><div class="content"></div>`;
    d.querySelector('.content').textContent = contentText || '';
    setStepState(d, cls.includes('running') ? 'running' : cls.includes('error') ? 'error' : 'ok');
    return d;
  }
  function setStepState(d, st) {
    d.classList.remove('running', 'ok', 'error');
    d.classList.add(st);
    d.querySelector('.ico').innerHTML = st === 'running' ? ICON.spin : st === 'error' ? ICON.x : ICON.check;
  }
  function toolStep(tc, result) {
    let args = {};
    try { args = JSON.parse(tc.arguments); } catch { args = { raw: tc.arguments }; }
    const d = stepEl(result ? (result.isError ? 'tool error' : 'tool ok') : 'tool running', toolLabel(tc.name, args), result ? result.content : JSON.stringify(args, null, 2));
    d.dataset.callId = tc.id;
    return d;
  }
  function stepsContainer(parent) {
    let c = parent.lastElementChild;
    if (!c || !c.classList.contains('steps')) { c = el('div', 'steps'); parent.appendChild(c); }
    return c;
  }

  function renderMessage(m) {
    if (m.role === 'tool') { return null; }
    if (m.meta && m.meta.summary) {
      const d = el('div', 'note');
      const det = stepEl('ok', 'Conversation summarised to free context', m.content.replace(/<\/?conversation_summary>/g, '').replace(/Continue from here.*$/s, '').trim());
      det.classList.add('subagent');
      d.appendChild(det);
      return d;
    }
    if (m.role === 'user') {
      const d = el('div', 'msg user');
      const atts = [];
      const text = m.content
        .replace(/<attachment[^>]*path="([^"]+)"[^>]*>[\s\S]*?<\/attachment>\s*/g, (_, p) => { atts.push(p); return ''; })
        .replace(/<(workspace_tree|problems|git|open_editors|directory)[^>]*>[\s\S]*?<\/\1>\s*/g, (_, t) => { atts.push('@' + (t === 'workspace_tree' ? 'workspace' : t === 'open_editors' ? 'editors' : t)); return ''; })
        .replace(/\n\n\[\d+ images? attached\]$/, '');
      if (atts.length) { d.appendChild(el('div', 'att', atts.map((a) => `<span class="chip">${ICON.file}<span>${esc(a)}</span></span>`).join(''))); }
      if (m.images && m.images.length) { d.appendChild(el('div', 'imgs', m.images.map((b64) => `<img src="data:image/png;base64,${b64}" alt="attached image">`).join(''))); }
      d.appendChild(document.createTextNode(text));
      return d;
    }
    const d = el('div', 'msg assistant');
    if (m.thinking) { stepsContainer(d).appendChild(stepEl('thinking ok', 'Thought', m.thinking)); }
    return d;
  }

  function renderSession() {
    const s = state.session;
    els.messages.innerHTML = '';
    if (!s) { return; }
    els.mode.value = s.mode;
    syncModelSelect();
    updateCtx();
    if (!s.messages.length) { renderEmpty(); }
    const results = new Map();
    for (const m of s.messages) { if (m.role === 'tool' && m.toolCallId) { results.set(m.toolCallId, { content: m.content, isError: /^(Tool .* failed|User declined|Error|Cancelled)/i.test(m.content) }); } }
    for (const m of s.messages) {
      const node = renderMessage(m);
      if (!node) { continue; }
      if (m.role === 'assistant') {
        if (m.toolCalls && m.toolCalls.length) {
          const c = stepsContainer(node);
          for (const tc of m.toolCalls) { c.appendChild(toolStep(tc, results.get(tc.id) || { content: '(no result)', isError: false })); }
        }
        if (m.content && m.content.trim()) { node.appendChild(el('div', 'body', renderMarkdown(m.content))); }
        if (!node.children.length) { continue; }
      }
      els.messages.appendChild(node);
    }
    const live = state.live.get(s.id);
    if (live) { els.messages.appendChild(live.root); }
    setRunning(state.running.has(s.id));
    scrollToBottom(true);
  }

  function renderEmpty() {
    const noModels = !state.models.length;
    const wrap = el('div', 'empty');
    wrap.innerHTML = `<div class="logo">${ICON.bot}</div><h2>LocalPilot</h2><p>Your local-first coding agent. Ask anything about this workspace, or let the agent edit files and run commands.</p>`;
    const sug = el('div', 'suggestions');
    for (const [icon, label, prompt, mode] of [
      [ICON.file, 'Explain the active file', 'Explain what the active file does and how it fits into the codebase.', 'ask'],
      [ICON.bug, 'Find and fix errors in this file', 'Run get_diagnostics for the active file and fix every error.', 'agent'],
      [ICON.beaker, 'Write tests for my selection', 'Write unit tests for the selected code using the project\'s existing test framework.', 'agent'],
      [ICON.sparkle, 'Give me an overview of this project', 'Explore the workspace structure and summarise what this project does, its main modules and how to build/run it.', 'ask'],
    ]) {
      const b = el('button', 'suggestion', `${icon}<span>${esc(label)}</span>`);
      b.onclick = () => { if (mode !== els.mode.value) { els.mode.value = mode; els.mode.onchange(); } els.input.value = prompt; sendCurrent(true); };
      sug.appendChild(b);
    }
    wrap.appendChild(sug);
    if (noModels) {
      const n = el('div', 'notice', `<b>No local models found.</b><br>Start <b>Ollama</b> (<code>ollama serve</code>), <b>LM Studio</b>'s server, <b>llama.cpp</b> or <b>vLLM</b>, then refresh. Custom endpoints go in settings.<div class="row"><button class="btn primary" data-a="refresh">Refresh models</button><button class="btn" data-a="settings">Open settings</button></div>`);
      n.onclick = (e) => { const a = e.target.dataset.a; if (a === 'refresh') { post({ type: 'refreshModels' }); toast('Looking for model servers…'); } if (a === 'settings') { post({ type: 'openSettings' }); } };
      wrap.appendChild(n);
    }
    els.messages.appendChild(wrap);
  }

  function ensureLive(sessionId) {
    let live = state.live.get(sessionId);
    if (!live) {
      const root = el('div', 'msg assistant live');
      const body = el('div', 'body');
      root.appendChild(body);
      live = { root, body, text: '', thinking: '', thinkingEl: null, tools: new Map(), subagents: new Map(), renderTimer: 0 };
      state.live.set(sessionId, live);
      if (state.session && state.session.id === sessionId) { els.messages.appendChild(root); }
    }
    return live;
  }
  function scheduleRender(live) {
    if (live.renderTimer) { return; }
    live.renderTimer = setTimeout(() => { live.renderTimer = 0; live.body.innerHTML = renderMarkdown(live.text); scrollToBottom(false); }, 50);
  }
  // Steps for the live turn go into a steps container placed before the current text body.
  function liveSteps(live) {
    let c = live.body.previousElementSibling;
    if (!c || !c.classList.contains('steps')) { c = el('div', 'steps'); live.root.insertBefore(c, live.body); }
    return c;
  }
  function rotateBody(live) {
    if (live.text.trim()) {
      live.body.innerHTML = renderMarkdown(live.text);
      live.body = el('div', 'body');
      live.root.appendChild(live.body);
      live.text = '';
    }
  }

  function handleEvent(e) {
    const sid = e.sessionId;
    const live = ensureLive(sid);
    const visible = state.session && state.session.id === sid;
    switch (e.type) {
      case 'assistant_delta':
        live.text += e.payload;
        scheduleRender(live);
        break;
      case 'thinking_delta':
        live.thinking += e.payload;
        if (!live.thinkingEl) { live.thinkingEl = stepEl('thinking running', 'Thinking…', ''); liveSteps(live).appendChild(live.thinkingEl); }
        live.thinkingEl.querySelector('.content').textContent = live.thinking;
        break;
      case 'status':
        if (!visible) { break; }
        if (e.payload && typeof e.payload === 'object' && e.payload.childId) {
          const d = e.payload.data;
          if (e.payload.inner === 'status' && typeof d === 'string') { setStatus(`${e.payload.agent}: ${d}`); }
          else if (e.payload.inner === 'tool_start' && d) { setStatus(`${e.payload.agent}: ${d.name}`); appendSubagentLine(live, e.payload.childId, `- ${d.name} ${JSON.stringify(d.args || {}).slice(0, 100)}`); }
        } else { setStatus(typeof e.payload === 'string' ? e.payload : ''); }
        break;
      case 'tool_start': {
        if (live.thinkingEl) { setStepState(live.thinkingEl, 'ok'); live.thinkingEl.querySelector('.label').textContent = 'Thought'; live.thinkingEl = null; }
        rotateBody(live);
        if (e.payload && e.payload.childId) { break; }
        const node = toolStep({ id: e.payload.id, name: e.payload.name, arguments: JSON.stringify(e.payload.args || {}) }, null);
        live.tools.set(e.payload.id, node);
        liveSteps(live).appendChild(node);
        scrollToBottom(false);
        break;
      }
      case 'tool_end': {
        if (e.payload && e.payload.childId) { break; }
        const node = live.tools.get(e.payload.id);
        if (node) {
          setStepState(node, e.payload.isError ? 'error' : 'ok');
          node.querySelector('.content').textContent = e.payload.content || '';
          if (e.payload.durationMs > 800) { node.querySelector('.dur').textContent = `${(e.payload.durationMs / 1000).toFixed(1)}s`; }
        }
        break;
      }
      case 'subagent_start': {
        rotateBody(live);
        const d = stepEl('subagent running', `Subagent <b>${esc(e.payload.agent)}</b> · ${esc(e.payload.prompt.slice(0, 80))}`, '');
        live.subagents.set(e.payload.childId, d);
        liveSteps(live).appendChild(d);
        break;
      }
      case 'subagent_end': {
        const d = live.subagents.get(e.payload.childId);
        if (d) {
          setStepState(d, e.payload.error ? 'error' : 'ok');
          d.querySelector('.content').textContent += e.payload.error ? `\nError: ${e.payload.error}` : `\n\n${(e.payload.result || '').slice(0, 4000)}`;
        }
        break;
      }
      case 'compaction':
        rotateBody(live);
        live.root.insertBefore(el('div', 'note', `Context compacted: ${e.payload.before.toLocaleString()} → ${e.payload.after.toLocaleString()} tokens (${e.payload.removed} messages summarised)`), live.body);
        break;
      case 'error':
        rotateBody(live);
        live.root.insertBefore(el('div', 'error-box', esc(String(e.payload))), live.body);
        break;
      case 'turn_end':
        if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); }
        break;
    }
  }
  function appendSubagentLine(live, childId, line) {
    const d = live.subagents.get(childId);
    if (d) { d.querySelector('.content').textContent += line + '\n'; }
  }
  function finishLive(sessionId) {
    const live = state.live.get(sessionId);
    if (!live) { return; }
    clearTimeout(live.renderTimer);
    live.body.innerHTML = renderMarkdown(live.text);
    live.root.classList.remove('live');
    for (const node of live.tools.values()) { if (node.classList.contains('running')) { setStepState(node, 'error'); } }
    if (live.thinkingEl) { setStepState(live.thinkingEl, 'ok'); live.thinkingEl.querySelector('.label').textContent = 'Thought'; }
    state.live.delete(sessionId);
  }

  // ------------------------------------------------------------------ ui state
  function setStatus(text) {
    els.statusText.textContent = text || '';
    els.status.classList.toggle('hidden', !text);
  }
  function setRunning(running) {
    els.send.classList.toggle('hidden', running);
    els.stop.classList.toggle('hidden', !running);
    if (!running) { setStatus(''); }
    updateSendEnabled();
  }
  function updateSendEnabled() { els.send.disabled = !els.input.value.trim(); }

  function updateCtx() {
    const s = state.session;
    if (!s) { return; }
    const model = state.models.find((m) => m.id === s.model) || state.models.find((m) => m.id === state.defaultModel) || state.models[0];
    const win = model ? model.contextWindow : 32768;
    const used = s.contextTokens || 0;
    const pct = Math.min(100, Math.round((used / win) * 100));
    els.ctx.style.setProperty('--pct', pct);
    els.ctx.querySelector('.txt').textContent = `${pct}%`;
    els.ctx.title = `Context: ${used.toLocaleString()} / ${win.toLocaleString()} tokens${s.compactions ? ` · compacted ${s.compactions}×` : ''}\nClick to compact now`;
    els.ctx.className = `ctx ${pct > 85 ? 'danger' : pct > 65 ? 'warn' : ''}`;
  }

  function syncModelSelect() {
    const s = state.session;
    els.model.innerHTML = '';
    els.modelPicker.classList.toggle('warn', !state.models.length);
    if (!state.models.length) {
      const o = document.createElement('option'); o.value = ''; o.textContent = 'No models'; els.model.appendChild(o);
      return;
    }
    const byProvider = new Map();
    for (const m of state.models) { if (!byProvider.has(m.providerId)) { byProvider.set(m.providerId, []); } byProvider.get(m.providerId).push(m); }
    for (const [pid, list] of byProvider) {
      const g = document.createElement('optgroup'); g.label = pid;
      for (const m of list) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name + (m.supportsTools ? '' : ' (no tools)'); g.appendChild(o); }
      els.model.appendChild(g);
    }
    const want = (s && s.model) || state.defaultModel || state.models[0].id;
    if ([...els.model.options].some((o) => o.value === want)) { els.model.value = want; }
    else { const o = document.createElement('option'); o.value = want; o.textContent = want.split('/').pop(); els.model.appendChild(o); els.model.value = want; }
  }

  function renderChips() {
    els.chips.innerHTML = '';
    state.attachments.forEach((a, i) => {
      const c = el('span', 'chip', `${ICON.file}<span title="${esc(a)}">${esc(a)}</span><button title="Remove">${ICON.x}</button>`);
      c.querySelector('button').onclick = () => { state.attachments.splice(i, 1); renderChips(); };
      els.chips.appendChild(c);
    });
    state.images.forEach((img, i) => {
      const c = el('span', 'chip img', `<img src="data:${img.mime};base64,${img.data}" alt=""><span title="${esc(img.name)}">${esc(img.name)}</span><button title="Remove">${ICON.x}</button>`);
      c.querySelector('button').onclick = () => { state.images.splice(i, 1); renderChips(); };
      els.chips.appendChild(c);
    });
  }

  // Downscale large images client-side so they fit the model's vision budget.
  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { return; }
    if (state.images.length >= 4) { toast('Up to 4 images per message', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1568;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/png').split(',')[1];
        state.images.push({ name: file.name || `pasted-${Date.now().toString(36)}.png`, data, mime: 'image/png' });
        renderChips();
        els.input.focus();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function toast(text, level) {
    const t = el('div', `toast ${level || 'info'}`, esc(text));
    els.toasts.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function renderChanges() {
    const s = state.session;
    const files = s ? state.changes.get(s.id) || [] : [];
    els.changes.classList.toggle('hidden', !files.length);
    if (!files.length) { return; }
    els.changesLabel.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
    els.changesList.innerHTML = '';
    for (const f of files) {
      const li = el('li', '', `<span class="kind ${f.kind}">${f.kind === 'create' ? 'A' : 'M'}</span><span class="name" title="${esc(f.path)}">${esc(f.path)}</span><span class="acts"><button data-a="undo" title="Undo">${ICON.x}</button><button data-a="keep" title="Keep">${ICON.check}</button></span>`);
      li.onclick = (e) => {
        const a = e.target.closest('[data-a]');
        if (a) { post({ type: a.dataset.a === 'undo' ? 'undoChanges' : 'keepChanges', sessionId: s.id, fsPath: f.fsPath }); return; }
        post({ type: 'showDiff', sessionId: s.id, fsPath: f.fsPath });
      };
      els.changesList.appendChild(li);
    }
  }
  els.changesToggle.onclick = () => els.changesList.classList.toggle('hidden');
  els.changes.querySelector('.changes-head').onclick = (e) => {
    const a = e.target.closest('[data-a]');
    if (!a || !state.session) { return; }
    post({ type: a.dataset.a === 'undoAll' ? 'undoChanges' : 'keepChanges', sessionId: state.session.id });
  };

  function renderApproval(a) {
    const d = el('div', 'approval');
    d.dataset.id = a.id;
    d.innerHTML = `<div class="title">${ICON.warn}<span>${esc(a.title)}</span></div><pre></pre><div class="actions"><button class="btn" data-a="deny">Deny</button><button class="btn" data-a="session">Allow for session</button><button class="btn primary" data-a="allow">Allow</button></div>`;
    d.querySelector('pre').textContent = a.detail;
    d.onclick = (ev) => {
      const act = ev.target.closest('[data-a]');
      if (!act) { return; }
      post({ type: 'approval', id: a.id, approved: act.dataset.a !== 'deny', remember: act.dataset.a === 'session' });
      d.remove();
    };
    els.approvals.appendChild(d);
  }

  // ------------------------------------------------------------------ composer
  function autoGrow() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(240, els.input.scrollHeight) + 'px';
  }

  function sendCurrent(fromSuggestion) {
    const text = els.input.value.trim();
    if (!text || !state.session) { return; }
    if (state.running.has(state.session.id)) { toast('Still responding — stop it first or start a new chat', 'error'); return; }
    const atRefs = [...text.matchAll(/(?:^|\s)@([\w./-]+(?:#L\d+(?:-L?\d+)?)?)/g)].map((m) => m[1]);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    const images = state.images.map((i) => i.data);
    post({ type: 'send', sessionId: state.session.id, text, attachments, images: images.length ? images : undefined });
    const empty = els.messages.querySelector('.empty');
    if (empty) { empty.remove(); }
    if (!text.startsWith('/')) {
      const u = el('div', 'msg user');
      if (attachments.length) { u.appendChild(el('div', 'att', attachments.map((a) => `<span class="chip">${ICON.file}<span>${esc(a)}</span></span>`).join(''))); }
      if (images.length) { u.appendChild(el('div', 'imgs', state.images.map((i) => `<img src="data:${i.mime};base64,${i.data}" alt="">`).join(''))); }
      u.appendChild(document.createTextNode(text));
      els.messages.appendChild(u);
      ensureLive(state.session.id);
      setStatus('Sending…');
    }
    els.input.value = '';
    state.attachments = [];
    state.images = [];
    renderChips();
    autoGrow();
    hideSlash();
    updateSendEnabled();
    scrollToBottom(true);
    if (!fromSuggestion) { els.input.focus(); }
  }

  const SLASH = [
    ['/help', 'Show commands'], ['/model ', 'Switch model for this chat'], ['/mode agent', 'Agent: edit files & run commands'], ['/mode ask', 'Ask: read-only answers'], ['/mode plan', 'Plan: design before coding'],
    ['/compact', 'Summarise older messages'], ['/clear', 'Clear this chat'], ['/skills', 'List skills'], ['/agents', 'List subagents'], ['/skill ', 'Run a task with a skill'], ['/agent ', 'Delegate to a subagent'], ['/context', 'Context usage'],
  ];
  let slashEl = null;
  let slashSel = 0;
  function showSlash(prefix) {
    const items = SLASH.filter(([c]) => c.startsWith(prefix) || prefix.startsWith(c.trim() + ' ') && c.endsWith(' ')).concat(
      prefix.startsWith('/skill ') ? state.skills.filter((s) => (`/skill ${s.name}`).startsWith(prefix.trimEnd())).map((s) => [`/skill ${s.name} `, s.description]) : [],
      prefix.startsWith('/agent ') ? state.agents.filter((a) => (`/agent ${a.name}`).startsWith(prefix.trimEnd())).map((a) => [`/agent ${a.name} `, a.description]) : []
    ).filter(([c]) => c.trim() !== prefix.trim() || c.endsWith(' '));
    if (!items.length) { return hideSlash(); }
    if (!slashEl) { slashEl = el('div', 'slash'); els.box.appendChild(slashEl); }
    slashSel = Math.min(slashSel, items.length - 1);
    slashEl.innerHTML = items.slice(0, 12).map(([c, d], i) => `<div data-c="${esc(c)}" class="${i === slashSel ? 'sel' : ''}"><b>${esc(c.trim())}</b><span>${esc(d || '')}</span></div>`).join('');
    slashEl.onmousedown = (ev) => { ev.preventDefault(); const t = ev.target.closest('[data-c]'); if (t) { els.input.value = t.dataset.c; hideSlash(); els.input.focus(); updateSendEnabled(); } };
  }
  function hideSlash() { if (slashEl) { slashEl.remove(); slashEl = null; slashSel = 0; } }

  // @-mention popup: special contexts + open editors, filtered by the token after the last '@'.
  function mentionToken() {
    const v = els.input.value.slice(0, els.input.selectionStart);
    const m = /(?:^|\s)@([\w./-]*)$/.exec(v);
    return m ? m[1] : null;
  }
  function showMentions(tok) {
    const q = tok.toLowerCase();
    const items = MENTIONS.filter(([n]) => n.startsWith(q)).map(([n, d]) => [n, d])
      .concat(state.openFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => [f, 'open editor']));
    if (!items.length) { return hideSlash(); }
    if (!slashEl) { slashEl = el('div', 'slash'); els.box.appendChild(slashEl); }
    slashSel = Math.min(slashSel, items.length - 1);
    slashEl.innerHTML = items.slice(0, 12).map(([c, d], i) => `<div data-m="${esc(c)}" class="${i === slashSel ? 'sel' : ''}"><b>@${esc(c)}</b><span>${esc(d)}</span></div>`).join('');
    slashEl.onmousedown = (ev) => { ev.preventDefault(); const t = ev.target.closest('[data-m]'); if (t) { applyMention(t.dataset.m); } };
  }
  function applyMention(name) {
    const pos = els.input.selectionStart;
    const before = els.input.value.slice(0, pos).replace(/@[\w./-]*$/, '');
    els.input.value = `${before}@${name} ${els.input.value.slice(pos)}`;
    els.input.selectionStart = els.input.selectionEnd = before.length + name.length + 2;
    hideSlash();
    els.input.focus();
    updateSendEnabled();
  }

  els.input.addEventListener('input', () => {
    autoGrow();
    updateSendEnabled();
    const v = els.input.value;
    const tok = mentionToken();
    if (v.startsWith('/') && !v.includes('\n')) { showSlash(v); }
    else if (tok !== null) { if (!state.openFiles.length) { post({ type: 'requestOpenFiles' }); } showMentions(tok); }
    else { hideSlash(); }
  });
  els.input.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData && e.clipboardData.items || [])].filter((it) => /^image\//.test(it.type));
    if (items.length) { e.preventDefault(); items.forEach((it) => addImageFile(it.getAsFile())); }
  });
  els.input.addEventListener('keydown', (e) => {
    if (slashEl) {
      const n = slashEl.children.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % n; refreshPopup(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + n) % n; refreshPopup(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const sel = slashEl.querySelector('.sel');
        if (sel && sel.dataset.m) { e.preventDefault(); applyMention(sel.dataset.m); return; }
        if (sel && sel.dataset.c.trim() !== els.input.value.trim()) { e.preventDefault(); els.input.value = sel.dataset.c; hideSlash(); updateSendEnabled(); return; }
      }
      if (e.key === 'Escape') { hideSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  els.input.addEventListener('blur', () => setTimeout(hideSlash, 150));
  function refreshPopup() { const tok = mentionToken(); if (els.input.value.startsWith('/')) { showSlash(els.input.value); } else if (tok !== null) { showMentions(tok); } }
  $('btnImage').onclick = () => post({ type: 'pickImage' });
  $('btnShot').onclick = () => { toast('Select a screen region…'); post({ type: 'captureScreenshot', mode: 'region' }); };
  els.send.onclick = () => sendCurrent();
  els.stop.onclick = () => state.session && post({ type: 'stop', sessionId: state.session.id });
  els.mode.onchange = () => state.session && post({ type: 'setMode', sessionId: state.session.id, mode: els.mode.value });
  els.model.onchange = () => { if (state.session && els.model.value) { post({ type: 'setModel', sessionId: state.session.id, model: els.model.value, makeDefault: !state.defaultModel }); } };
  els.ctx.onclick = () => state.session && post({ type: 'compactNow', sessionId: state.session.id });
  $('btnAttach').onclick = () => post({ type: 'attachActive' });
  $('btnAttachPick').onclick = () => post({ type: 'pickAttachment' });

  els.messages.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-code-action]');
    if (btn) {
      const pre = btn.parentElement.nextElementSibling;
      const code = pre ? pre.textContent : '';
      const act = btn.dataset.codeAction;
      if (act === 'copy') { navigator.clipboard.writeText(code).then(() => toast('Copied')); }
      if (act === 'insert') { post({ type: 'insertCode', code }); }
      if (act === 'apply') { post({ type: 'applyCodeToFile', code }); }
      return;
    }
    const link = e.target.closest('.path-link');
    if (link) { post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined }); return; }
    const img = e.target.closest('.imgs img');
    if (img) { img.classList.toggle('zoom'); return; }
    const a = e.target.closest('a[href]');
    if (a) { e.preventDefault(); post({ type: 'openExternal', url: a.getAttribute('href') }); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); els.input.focus(); }
  });
  // Drag & drop files from the explorer onto the composer.
  els.box.addEventListener('dragover', (e) => { e.preventDefault(); });
  els.box.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])];
    const imgs = files.filter((f) => /^image\//.test(f.type));
    imgs.forEach(addImageFile);
    const uris = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter(Boolean);
    for (const u of uris) { if (!imgs.length) { post({ type: 'attachUri', uri: u }); } }
  });

  // ------------------------------------------------------------------ messaging
  function post(m) { vscode.postMessage(m); }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        state.models = m.models; state.defaultModel = m.defaultModel; state.skills = m.skills; state.agents = m.agents; state.running = new Set(m.running);
        syncModelSelect();
        break;
      case 'sessions':
        break;
      case 'session':
        state.session = m.session; renderSession(); renderChanges(); els.input.focus();
        break;
      case 'changes':
        state.changes.set(m.sessionId, m.files);
        if (state.session && state.session.id === m.sessionId) { renderChanges(); }
        break;
      case 'models': {
        const hadNone = !state.models.length;
        state.models = m.models; state.defaultModel = m.defaultModel; syncModelSelect(); updateCtx();
        if (hadNone && m.models.length) { toast(`${m.models.length} model(s) found`); if (state.session && !state.session.messages.length) { renderSession(); } }
        break;
      }
      case 'event':
        handleEvent(m.event);
        break;
      case 'running':
        if (m.running) { state.running.add(m.sessionId); } else { state.running.delete(m.sessionId); finishLive(m.sessionId); }
        if (state.session && state.session.id === m.sessionId) { setRunning(m.running); if (!m.running) { post({ type: 'selectSession', id: m.sessionId }); } }
        break;
      case 'approval':
        renderApproval(m);
        if (!state.session || state.session.id !== m.sessionId) { toast('Approval needed in another chat'); }
        break;
      case 'approvalResolved': {
        const d = els.approvals.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
        if (d) { d.remove(); }
        break;
      }
      case 'toast':
        if (m.text.startsWith('attach:')) { const ref = m.text.slice(7); if (!state.attachments.includes(ref)) { state.attachments.push(ref); renderChips(); } els.input.focus(); }
        else { toast(m.text, m.level); }
        break;
      case 'focusInput':
        els.input.focus();
        post({ type: 'requestOpenFiles' });
        break;
      case 'openFiles':
        state.openFiles = m.files || [];
        break;
      case 'image':
        if (state.images.length >= 4) { toast('Up to 4 images per message', 'error'); break; }
        state.images.push(m.image);
        renderChips();
        els.input.focus();
        break;
    }
  });

  updateSendEnabled();
  post({ type: 'ready' });
})();
