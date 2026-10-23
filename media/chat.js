// LocalPilot chat webview — vanilla JS, no dependencies.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $('messages'), input: $('input'), send: $('btnSend'), stop: $('btnStop'), status: $('status'), statusText: $('statusText'),
    modeBtn: $('modeBtn'), modeLabel: $('modeLabel'), modeIcon: $('modeIcon'), modelBtn: $('modelBtn'), modelLabel: $('modelLabel'), ctx: $('ctxMeter'),
    approvals: $('approvals'), chips: $('chips'), toasts: $('toasts'), box: $('box'), addCtx: $('btnAddCtx'), image: $('btnImage'),
    changes: $('changes'), changesList: $('changesList'), changesLabel: $('changesLabel'), changesToggle: $('changesToggle'),
    tabs: $('tabs'), progress: $('progress'), tasks: $('tasks'), tasksList: $('tasksList'), tasksLabel: $('tasksLabel'), tasksMeter: $('tasksMeter'), tasksToggle: $('tasksToggle'),
    popover: $('popover'), newTab: $('btnNewTab'), history: $('btnHistory'),
  };

  const I = {
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    spin: '<svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-5.2 3"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
    insert: '<svg viewBox="0 0 16 16"><path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10"/></svg>',
    apply: '<svg viewBox="0 0 16 16"><path d="M3 3h7l3 3v7H3z"/><path d="M5 13V9h6v4"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3L7 9"/></svg>',
    undo: '<svg viewBox="0 0 16 16"><path d="M3 7h7a3 3 0 0 1 0 6H8M3 7l3-3M3 7l3 3"/></svg>',
    restore: '<svg viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3l2 1.5"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1" fill="currentColor"/><circle cx="15" cy="9.5" r="1" fill="currentColor"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.8v.2"/></svg>',
    sparkle: '<svg viewBox="0 0 16 16"><path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/></svg>',
    bug: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="4"/><path d="M8 5V3M5 6L3 4M11 6l2-2M3 10H1M15 10h-2M4 13l-2 1M12 13l2 1"/></svg>',
    beaker: '<svg viewBox="0 0 16 16"><path d="M6 2v5l-3.5 6a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L10 7V2"/><path d="M5 2h6"/></svg>',
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M13.5 13.5l-3.3-3.3"/></svg>',
    edit: '<svg viewBox="0 0 16 16"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/></svg>',
    term: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10h3"/></svg>',
    globe: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5a8 8 0 0 1 0 11M8 2.5a8 8 0 0 0 0 11"/></svg>',
    agent: '<svg viewBox="0 0 16 16"><rect x="3" y="4" width="10" height="8" rx="2"/><circle cx="6.5" cy="8" r="1" fill="currentColor"/><circle cx="9.5" cy="8" r="1" fill="currentColor"/><path d="M8 4V2"/></svg>',
    brain: '<svg viewBox="0 0 16 16"><path d="M6 3a2.5 2.5 0 0 0-2.4 3.2A2.5 2.5 0 0 0 4 11a2.5 2.5 0 0 0 4 1.5A2.5 2.5 0 0 0 12 11a2.5 2.5 0 0 0 .4-4.8A2.5 2.5 0 0 0 10 3a2.5 2.5 0 0 0-2 1 2.5 2.5 0 0 0-2-1z"/></svg>',
    git: '<svg viewBox="0 0 16 16"><circle cx="5" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.5v5M11 7.5A3 3 0 0 1 8 10.5H6.5"/></svg>',
    list: '<svg viewBox="0 0 16 16"><path d="M5 4h9M5 8h9M5 12h9M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>',
    camera: '<svg viewBox="0 0 16 16"><path d="M2.5 5.5V4a1.5 1.5 0 0 1 1.5-1.5h1.5M10.5 2.5H12A1.5 1.5 0 0 1 13.5 4v1.5M13.5 10.5V12a1.5 1.5 0 0 1-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 0 1 2.5 12v-1.5"/><circle cx="8" cy="8" r="2"/></svg>',
    image: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M13.5 10.5l-3-3-4 4-1.5-1.5-2.5 2.5"/></svg>',
    region: '<svg viewBox="0 0 16 16"><path d="M2.5 5.5V2.5h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3"/><rect x="5" y="5" width="6" height="6" rx=".5" stroke-dasharray="1.5 1.5"/></svg>',
    window: '<svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11M4.5 4.5h.01M6.5 4.5h.01"/></svg>',
    windows: '<svg viewBox="0 0 16 16"><rect x="1.5" y="4.5" width="9" height="8" rx="1.2"/><path d="M5 4.5v-1A1.2 1.2 0 0 1 6.2 2.3h7.1a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2h-2.8M1.5 7h9"/></svg>',
    screen: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>',
    timer: '<svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="5"/><path d="M8 6.5V9l1.8 1.3M6.5 2h3M12 4l1-1"/></svg>',
    cursor: '<svg viewBox="0 0 16 16"><path d="M3 2l10 6-4.5 1L6 13z"/></svg>',
    memory: '<svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z"/><path d="M6 6h4M6 8h4M6 10h2"/></svg>',
    plan: '<svg viewBox="0 0 16 16"><path d="M4 3h8v10H4z"/><path d="M6 6h4M6 8.5h4M6 11h2"/></svg>',
    ask: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.4-.8.7-.8 1.4M8 11.5h.01"/></svg>',
  };
  const MODES = {
    agent: { label: 'Agent', icon: I.agent, desc: 'Edit files, run commands, verify' },
    ask: { label: 'Ask', icon: I.ask, desc: 'Answer questions, read-only' },
    plan: { label: 'Plan', icon: I.plan, desc: 'Investigate and propose a plan' },
  };
  const READ_TOOLS = new Set(['read_file', 'list_dir', 'file_search', 'grep_search', 'find_symbol', 'find_references', 'get_diagnostics', 'get_editor_state', 'memory_read', 'memory_list', 'load_skill', 'web_search', 'web_fetch']);
  const SLASH = [
    ['/help', 'Show commands'], ['/model ', 'Switch model for this chat'], ['/mode agent', 'Agent mode'], ['/mode ask', 'Ask mode'], ['/mode plan', 'Plan mode'],
    ['/compact', 'Summarise older messages'], ['/clear', 'Clear this chat'], ['/skills', 'List skills'], ['/agents', 'List subagents'], ['/skill ', 'Run a task with a skill'], ['/agent ', 'Delegate to a subagent'], ['/context', 'Context usage'],
  ];
  const MENTIONS = [['workspace', 'Project file tree', I.folder], ['selection', 'Current selection / active file', I.cursor], ['problems', 'Errors & warnings', I.bug], ['git', 'git status + diff', I.git], ['editors', 'Open editors', I.list]];

  const state = {
    session: null, sessions: [], models: [], defaultModel: '', running: new Set(), attachments: [], images: [], skills: [], agents: [], openFiles: [],
    live: new Map(), changes: new Map(), checkpoints: new Map(), history: [], histIdx: -1,
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; }
  function post(m) { vscode.postMessage(m); }
  function toast(text, level) { const t = el('div', `toast ${level || 'info'}`, esc(text)); els.toasts.appendChild(t); setTimeout(() => t.remove(), 3200); }
  function scrollToBottom(force) { const m = els.messages; if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) { m.scrollTop = m.scrollHeight; } }
  function parseArgs(s) { try { return JSON.parse(s) || {}; } catch { return { raw: s }; } }
  function base(p) { return String(p || '').split('/').pop(); }
  function short(v, n = 70) { const t = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return esc(t.length > n ? t.slice(0, n - 1) + '…' : t); }

  // ------------------------------------------------------------------ markdown
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
    const out = []; let i = 0; let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${inline(para.join('\n')).replace(/\n/g, '<br>')}</p>`); para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flush(); const lang = fence[1] || ''; const buf = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; } i++;
        out.push(`<div class="code"><div class="code-head"><span class="lang">${esc(lang || 'text')}</span><button data-code="copy" title="Copy">${I.copy}<span>Copy</span></button><button data-code="insert" title="Insert at cursor">${I.insert}</button><button data-code="apply" title="Apply to active file">${I.apply}</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) { flush(); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`); continue; }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        flush(); const ordered = /^\s*\d+[.)]\s+/.test(line); const items = [];
        while (i < lines.length && (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          if (/^\s*[-*+]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')); } else { items[items.length - 1] += '\n' + lines[i].trim(); }
          i++;
        }
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((it) => `<li>${inline(it).replace(/\n/g, '<br>')}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush(); const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(rows[0]); const body = rows.slice(2).map(cells);
        out.push(`<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      if (!line.trim()) { flush(); i++; continue; }
      para.push(line); i++;
    }
    flush();
    return out.join('');
  }

  // ------------------------------------------------------------------ diff
  function diffLines(a, b) {
    const n = a.length, m = b.length;
    if (n * m > 250000) { return [...a.map((t) => ({ t: 'del', s: t })), ...b.map((t) => ({ t: 'add', s: t }))]; }
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) { for (let j = m - 1; j >= 0; j--) { dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]); } }
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { out.push({ t: 'eq', s: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: a[i++] }); } else { out.push({ t: 'add', s: b[j++] }); } }
    while (i < n) { out.push({ t: 'del', s: a[i++] }); } while (j < m) { out.push({ t: 'add', s: b[j++] }); }
    return out;
  }
  function renderDiff(oldText, newText) {
    const rows = diffLines(String(oldText || '').split('\n'), String(newText || '').split('\n'));
    const add = rows.filter((r) => r.t === 'add').length, del = rows.filter((r) => r.t === 'del').length;
    const html = []; let eqRun = [];
    const flushEq = (last) => {
      if (eqRun.length > 6) { const head = last ? [] : eqRun.slice(0, 3); const tail = html.length ? eqRun.slice(-3) : []; (html.length ? eqRun.slice(0, 3) : []).forEach((r) => html.push(row(r))); html.push(`<div class="ln skip">⋯ ${eqRun.length - (html.length ? 3 : 0) - (last ? 0 : 3)} unchanged lines</div>`); (last ? [] : eqRun.slice(-3)).forEach((r) => html.push(row(r))); void head; void tail; }
      else { eqRun.forEach((r) => html.push(row(r))); }
      eqRun = [];
    };
    const row = (r) => `<div class="ln ${r.t}"><span class="g">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</span><span class="c">${esc(r.s)}</span></div>`;
    for (const r of rows) { if (r.t === 'eq') { eqRun.push(r); } else { flushEq(false); html.push(row(r)); } }
    flushEq(true);
    return { html: html.join(''), add, del };
  }

  // ------------------------------------------------------------------ step/card builders
  function stepEl(cls, label, content, meta) {
    const d = el('details', `step ${cls}`);
    d.innerHTML = `<summary><span class="ico"></span><span class="label">${label}</span><span class="meta">${meta || ''}</span><span class="chev">${I.chev}</span></summary><div class="content"></div>`;
    if (content !== undefined) { d.querySelector('.content').textContent = content; }
    setState(d, cls.includes('running') ? 'running' : cls.includes('error') ? 'error' : 'ok');
    return d;
  }
  function setState(d, st) { d.classList.remove('running', 'ok', 'error'); d.classList.add(st); const ico = d.querySelector('.ico'); if (ico) { ico.innerHTML = st === 'running' ? I.spin : st === 'error' ? I.x : I.check; } }
  function toolLabel(name, a) {
    switch (name) {
      case 'read_file': return `Read <b>${short(base(a.path), 40)}</b>${a.start_line ? ` <i>L${a.start_line}–${a.end_line || ''}</i>` : ''}`;
      case 'list_dir': return `Listed <b>${short(a.path || '.', 40)}</b>`;
      case 'grep_search': return `Searched <b>${short(a.query, 50)}</b>${a.include_pattern ? ` in ${short(a.include_pattern, 24)}` : ''}`;
      case 'file_search': return `Found files <b>${short(a.pattern, 40)}</b>`;
      case 'find_symbol': return `Looked up <b>${short(a.query, 40)}</b>`;
      case 'find_references': return `References to <b>${short(a.symbol, 40)}</b>`;
      case 'get_diagnostics': return `Checked diagnostics${a.path ? ` in <b>${short(base(a.path), 40)}</b>` : ''}`;
      case 'get_editor_state': return 'Read editor state';
      case 'web_search': return `Searched the web <b>${short(a.query, 50)}</b>`;
      case 'web_fetch': return `Fetched <b>${short(a.url, 50)}</b>`;
      case 'load_skill': return `Loaded skill <b>${short(a.name, 30)}</b>`;
      case 'memory_read': return `Recalled <b>${short(a.name, 30)}</b>`;
      case 'memory_list': return 'Listed memory';
      case 'memory_save': return `Saved memory <b>${short(a.name, 30)}</b>`;
      case 'memory_delete': return `Deleted memory <b>${short(a.name, 30)}</b>`;
      case 'manage_todos': return 'Updated plan';
      case 'ask_user': return `Asked: ${short(a.question, 60)}`;
      case 'open_file': return `Opened <b>${short(base(a.path), 40)}</b>`;
      case 'create_directory': return `Created folder <b>${short(a.path, 40)}</b>`;
      case 'delete_path': return `Deleted <b>${short(a.path, 40)}</b>`;
      case 'run_parallel_subagents': return `Ran <b>${(a.tasks || []).length} subagents</b> in parallel`;
      default: return `${esc(name)} ${short(a, 50)}`;
    }
  }
  function toolIcon(name) { return READ_TOOLS.has(name) ? (name.startsWith('web') ? I.globe : I.search) : name.startsWith('memory') ? I.memory : I.sparkle; }

  // Edit card with inline diff (edit_file / write_file)
  function editCard(name, a, result) {
    const card = el('div', `card edit ${result ? (result.isError ? 'error' : 'ok') : 'running'}`);
    const isWrite = name === 'write_file';
    const oldT = isWrite ? '' : (a.old_text || ''); const newT = isWrite ? (a.content || '') : (a.new_text || '');
    const d = renderDiff(oldT, newT);
    const verb = result ? (result.isError ? 'Failed to edit' : isWrite ? 'Created' : 'Edited') : (isWrite ? 'Creating' : 'Editing');
    card.innerHTML = `<div class="card-head"><span class="ico">${result ? (result.isError ? I.x : I.edit) : I.spin}</span><span class="name" title="${esc(a.path || '')}">${esc(a.path || '')}</span><span class="stat"><span class="a">+${d.add}</span> <span class="d">−${d.del}</span></span><span class="acts"><button data-open="${esc(a.path || '')}" title="Open file">${I.open}</button></span></div><div class="diff collapsed">${d.html}</div>`;
    card.querySelector('.card-head').title = `${verb} ${a.path || ''}`;
    card.querySelector('.card-head').onclick = (e) => { if (e.target.closest('[data-open]')) { post({ type: 'openFile', path: e.target.closest('[data-open]').dataset.open }); return; } card.querySelector('.diff').classList.toggle('collapsed'); };
    if (result && result.isError) { const err = el('div', 'term', ''); err.textContent = result.content; card.appendChild(err); }
    return card;
  }
  // Terminal card (run_command)
  function termCard(a, result) {
    const card = el('div', `card term-card ${result ? (result.isError ? 'error' : 'ok') : 'running'}`);
    const exit = result && /\[exit code (\d+|null)\]/.exec(result.content || '');
    const code = exit ? exit[1] : null;
    card.innerHTML = `<div class="card-head"><span class="ico">${result ? I.term : I.spin}</span><span class="name" style="direction:ltr" title="${esc(a.command || '')}">$ ${esc(a.command || '')}</span>${code !== null ? `<span class="exit ${code === '0' ? 'good' : 'bad'}">exit ${code}</span>` : ''}<span class="acts"><button data-copy title="Copy command">${I.copy}</button></span></div><div class="term${result && !result.isError ? ' collapsed' : ''}"></div>`;
    const out = (result ? result.content : 'Running…').replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, '');
    card.querySelector('.term').textContent = out || '(no output)';
    card.querySelector('.card-head').onclick = (e) => { if (e.target.closest('[data-copy]')) { navigator.clipboard.writeText(a.command || '').then(() => toast('Copied')); return; } card.querySelector('.term').classList.toggle('collapsed'); };
    return card;
  }
  function subagentCard(agent, prompt) {
    const d = stepEl('subagent running', `<b>${esc(agent)}</b> subagent · ${short(prompt, 70)}`, '');
    d.querySelector('.ico').innerHTML = I.agent;
    return d;
  }
  // Container that groups consecutive read-only steps: "Explored codebase · 3 files, 2 searches"
  function getGroup(container, create) {
    let g = container.lastElementChild;
    if (g && g.classList.contains('group')) { return g; }
    if (!create) { return null; }
    g = stepEl('step group running', 'Exploring codebase…', undefined);
    g.querySelector('.ico').innerHTML = I.search;
    container.appendChild(g);
    return g;
  }
  function updateGroupLabel(g) {
    const steps = [...g.querySelectorAll('.content > .step')];
    const running = steps.some((s) => s.classList.contains('running'));
    const n = { read: 0, search: 0, web: 0, other: 0 };
    for (const s of steps) { const t = s.dataset.tool; if (t === 'read_file' || t === 'list_dir') { n.read++; } else if (/search|find|symbol/.test(t)) { n.search++; } else if (/^web/.test(t)) { n.web++; } else { n.other++; } }
    const parts = []; if (n.read) { parts.push(`${n.read} file${n.read > 1 ? 's' : ''}`); } if (n.search) { parts.push(`${n.search} search${n.search > 1 ? 'es' : ''}`); } if (n.web) { parts.push(`${n.web} web`); } if (n.other) { parts.push(`${n.other} more`); }
    g.querySelector(':scope > summary .label').innerHTML = `${running ? 'Exploring' : 'Explored'} ${n.web && !n.read && !n.search ? 'the web' : 'codebase'} <b>· ${parts.join(', ')}</b>`;
    setState(g, running ? 'running' : steps.some((s) => s.classList.contains('error')) ? 'ok' : 'ok');
    g.querySelector(':scope > summary .ico').innerHTML = running ? I.spin : I.search;
  }
  function placeTool(container, tc, result) {
    const a = parseArgs(tc.arguments);
    if (tc.name === 'edit_file' || tc.name === 'write_file') { const c = editCard(tc.name, a, result); c.dataset.callId = tc.id; container.appendChild(c); return c; }
    if (tc.name === 'run_command') { const c = termCard(a, result); c.dataset.callId = tc.id; container.appendChild(c); return c; }
    if (tc.name === 'manage_todos') { return null; }
    if (tc.name === 'run_subagent') { const c = subagentCard(a.agent, a.prompt); c.dataset.callId = tc.id; if (result) { setState(c, result.isError ? 'error' : 'ok'); c.querySelector('.content').textContent = result.content; } container.appendChild(c); return c; }
    const s = stepEl(`step ${result ? (result.isError ? 'error' : 'ok') : 'running'}`, toolLabel(tc.name, a), result ? result.content : JSON.stringify(a, null, 2));
    s.dataset.tool = tc.name; s.dataset.callId = tc.id;
    s.querySelector('.ico').innerHTML = result ? (result.isError ? I.x : toolIcon(tc.name)) : I.spin;
    if (READ_TOOLS.has(tc.name)) { const g = getGroup(container, true); g.querySelector(':scope > .content').appendChild(s); updateGroupLabel(g); }
    else { container.appendChild(s); }
    return s;
  }
  function finishTool(node, payload) {
    if (!node) { return; }
    const ok = !payload.isError;
    if (node.classList.contains('card')) {
      node.classList.remove('running'); node.classList.add(ok ? 'ok' : 'error');
      const ico = node.querySelector('.card-head .ico'); if (ico) { ico.innerHTML = ok ? (node.classList.contains('edit') ? I.edit : I.term) : I.x; }
      const term = node.querySelector('.term'); if (term) { const out = (payload.content || '').replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, ''); term.textContent = out || '(no output)'; if (ok) { term.classList.add('collapsed'); } const m = /\[exit code (\d+|null)\]/.exec(payload.content || ''); if (m) { const head = node.querySelector('.card-head'); let ex = head.querySelector('.exit'); if (!ex) { ex = el('span', 'exit'); head.insertBefore(ex, head.querySelector('.acts')); } ex.textContent = `exit ${m[1]}`; ex.className = `exit ${m[1] === '0' ? 'good' : 'bad'}`; } }
      if (!ok && node.classList.contains('edit')) { const err = el('div', 'term', ''); err.textContent = payload.content || ''; node.appendChild(err); }
      return;
    }
    setState(node, ok ? 'error'.replace('error', 'ok') : 'error');
    node.querySelector('.content').textContent = payload.content || '';
    if (node.dataset.tool) { node.querySelector('.ico').innerHTML = ok ? toolIcon(node.dataset.tool) : I.x; }
    const meta = node.querySelector(':scope > summary .meta');
    if (meta) { meta.textContent = payload.cached ? 'cached' : payload.durationMs > 800 ? `${(payload.durationMs / 1000).toFixed(1)}s` : ''; }
    const g = node.closest('.group'); if (g) { updateGroupLabel(g); }
  }

  // ------------------------------------------------------------------ transcript rendering
  function userTurn(m, index) {
    const d = el('div', 'turn user');
    d.dataset.index = index;
    const atts = [];
    const text = m.content
      .replace(/<attachment[^>]*path="([^"]+)"[^>]*>[\s\S]*?<\/attachment>\s*/g, (_, p) => { atts.push(p); return ''; })
      .replace(/<(workspace_tree|problems|git|open_editors|directory)[^>]*>[\s\S]*?<\/\1>\s*/g, (_, t) => { atts.push('@' + (t === 'workspace_tree' ? 'workspace' : t === 'open_editors' ? 'editors' : t)); return ''; })
      .replace(/\n\n\[\d+ images? attached\]$/, '');
    const act = el('div', 'actions', `<button data-act="copy" title="Copy">${I.copy}</button>${index !== undefined ? `<button data-act="restore" title="Restore checkpoint: revert files changed since this message and edit it">${I.restore}<span>Restore checkpoint</span></button>` : ''}`);
    act.onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) { return; } if (b.dataset.act === 'copy') { navigator.clipboard.writeText(text).then(() => toast('Copied')); } if (b.dataset.act === 'restore' && state.session) { post({ type: 'restoreCheckpoint', sessionId: state.session.id, messageIndex: index }); } };
    d.appendChild(act);
    if (atts.length) { d.appendChild(el('div', 'att', atts.map((a) => `<span class="chip">${I.file}<span>${esc(a)}</span></span>`).join(''))); }
    if (m.images && m.images.length) { d.appendChild(el('div', 'imgs', m.images.map((b64) => `<img src="data:image/png;base64,${b64}" alt="attached image">`).join(''))); }
    d.appendChild(document.createTextNode(text));
    return d;
  }
  function assistantTurn(m, results) {
    const d = el('div', 'turn assistant');
    const steps = el('div', 'steps');
    if (m.thinking) { const t = stepEl('thinking ok', 'Thought', m.thinking); t.querySelector('.ico').innerHTML = I.brain; steps.appendChild(t); }
    for (const tc of m.toolCalls || []) { placeTool(steps, tc, results.get(tc.id) || { content: '(no result)', isError: false }); }
    if (steps.children.length) { d.appendChild(steps); }
    if (m.content && m.content.trim()) {
      const body = el('div', 'body', renderMarkdown(m.content)); d.appendChild(body);
      const act = el('div', 'actions', `<button data-act="copy" title="Copy response">${I.copy}</button>`);
      act.onclick = () => navigator.clipboard.writeText(m.content).then(() => toast('Copied'));
      d.appendChild(act);
    }
    return d.children.length ? d : null;
  }
  function renderSession() {
    const s = state.session;
    els.messages.innerHTML = '';
    if (!s) { return; }
    syncMode(); syncModel(); updateCtx();
    if (!s.messages.length) { renderEmpty(); }
    const results = new Map();
    for (const m of s.messages) { if (m.role === 'tool' && m.toolCallId) { results.set(m.toolCallId, { content: m.content, isError: /^(Tool .* failed|User declined|Error|Cancelled|old_text not found)/i.test(m.content) || /\[exit code [1-9]/.test(m.content) }); } }
    s.messages.forEach((m, i) => {
      if (m.role === 'tool') { return; }
      if (m.meta && m.meta.summary) { const n = el('div', 'turn'); const det = stepEl('ok', 'Conversation compacted to free context', m.content.replace(/<\/?conversation_summary>/g, '').replace(/Continue from here.*$/s, '').trim()); det.querySelector('.ico').innerHTML = I.list; n.appendChild(det); els.messages.appendChild(n); return; }
      const node = m.role === 'user' ? userTurn(m, i) : assistantTurn(m, results);
      if (node) { els.messages.appendChild(node); }
    });
    const live = state.live.get(s.id);
    if (live) { els.messages.appendChild(live.root); }
    setRunning(state.running.has(s.id));
    scrollToBottom(true);
  }
  function renderEmpty() {
    const wrap = el('div', 'empty');
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    wrap.innerHTML = `<div class="logo">${I.bot}</div><h2>${greet}. What are we building?</h2><p>Agent mode edits files and runs commands. Ask answers questions. Plan designs before coding.</p>`;
    const sug = el('div', 'suggestions');
    for (const [icon, label, prompt, mode] of [
      [I.file, 'Explain the active file', 'Explain what the active file does and how it fits into the codebase.', 'ask'],
      [I.bug, 'Find and fix errors in this file', 'Run get_diagnostics for the active file and fix every error.', 'agent'],
      [I.beaker, 'Write tests for my selection', "Write unit tests for the selected code using the project's existing test framework.", 'agent'],
      [I.sparkle, 'Give me an overview of this project', 'Explore the workspace structure and summarise what this project does, its main modules and how to build/run it.', 'ask'],
    ]) {
      const b = el('button', 'suggestion', `${icon}<span>${esc(label)}</span>`);
      b.onclick = () => { setMode(mode); els.input.value = prompt; sendCurrent(true); };
      sug.appendChild(b);
    }
    wrap.appendChild(sug);
    if (!state.models.length) {
      const n = el('div', 'notice', `<b>No local models found.</b><br>Start <b>Ollama</b> (<code>ollama serve</code>), <b>LM Studio</b>'s server, <b>llama.cpp</b> or <b>vLLM</b>, then refresh. Custom endpoints go in settings.<div class="row"><button class="btn primary" data-a="refresh">Refresh models</button><button class="btn" data-a="settings">Open settings</button></div>`);
      n.onclick = (e) => { const a = e.target.dataset.a; if (a === 'refresh') { post({ type: 'refreshModels' }); toast('Looking for model servers…'); } if (a === 'settings') { post({ type: 'openSettings' }); } };
      wrap.appendChild(n);
    }
    els.messages.appendChild(wrap);
  }

  // ------------------------------------------------------------------ live streaming
  function ensureLive(sessionId) {
    let live = state.live.get(sessionId);
    if (!live) {
      const root = el('div', 'turn assistant live');
      const steps = el('div', 'steps');
      const body = el('div', 'body', '<span class="typing"><i></i><i></i><i></i></span>');
      root.appendChild(steps); root.appendChild(body);
      live = { root, steps, body, text: '', thinking: '', thinkingEl: null, thinkStart: 0, tools: new Map(), subs: new Map(), timer: 0 };
      state.live.set(sessionId, live);
      if (state.session && state.session.id === sessionId) { els.messages.appendChild(root); }
    }
    return live;
  }
  function clearTyping(live) { const t = live.body.querySelector('.typing'); if (t) { live.body.innerHTML = ''; } }
  function rotateBody(live) {
    // Text that streamed before a tool call stays above the next steps block, in order.
    clearTyping(live);
    if (live.text.trim()) {
      live.body.innerHTML = renderMarkdown(live.text);
      live.steps = el('div', 'steps'); live.root.appendChild(live.steps);
      live.body = el('div', 'body'); live.root.appendChild(live.body);
      live.text = '';
    }
  }
  function finishThinking(live) {
    if (!live.thinkingEl) { return; }
    setState(live.thinkingEl, 'ok'); live.thinkingEl.querySelector('.ico').innerHTML = I.brain;
    live.thinkingEl.querySelector('.label').textContent = `Thought for ${Math.max(1, Math.round((Date.now() - live.thinkStart) / 1000))}s`;
    live.thinkingEl.querySelector('.meta').textContent = '';
    live.thinkingEl = null;
  }
  function scheduleRender(live) {
    if (live.timer) { return; }
    live.timer = setTimeout(() => { live.timer = 0; finishThinking(live); live.body.innerHTML = renderMarkdown(live.text) + '<span class="caret"></span>'; scrollToBottom(false); }, 50);
  }
  function finishLive(sessionId) {
    const live = state.live.get(sessionId);
    if (!live) { return; }
    clearTimeout(live.timer);
    clearTyping(live);
    live.body.innerHTML = renderMarkdown(live.text);
    live.root.classList.remove('live');
    for (const node of live.tools.values()) { if (node.classList.contains('running')) { finishTool(node, { isError: true, content: 'Cancelled' }); } }
    finishThinking(live);
    state.live.delete(sessionId);
  }
  function handleEvent(e) {
    const sid = e.sessionId; const live = ensureLive(sid); const visible = state.session && state.session.id === sid;
    switch (e.type) {
      case 'assistant_delta': live.text += e.payload; scheduleRender(live); break;
      case 'thinking_delta':
        live.thinking += e.payload; clearTyping(live);
        if (!live.thinkingEl) { live.thinkStart = Date.now(); live.thinkingEl = stepEl('thinking running', 'Thinking…', ''); live.steps.appendChild(live.thinkingEl); }
        live.thinkingEl.querySelector('.content').textContent = live.thinking;
        live.thinkingEl.querySelector('.meta').textContent = `${Math.round((Date.now() - live.thinkStart) / 1000)}s`;
        break;
      case 'status':
        if (!visible) { break; }
        if (e.payload && typeof e.payload === 'object' && e.payload.childId) {
          const d = e.payload.data; const sub = live.subs.get(e.payload.childId);
          if (e.payload.inner === 'status' && typeof d === 'string') { setStatus(`${e.payload.agent}: ${d}`); }
          else if (e.payload.inner === 'tool_start' && d) { setStatus(`${e.payload.agent}: ${d.name}`); if (sub) { sub.querySelector('.content').textContent += `· ${d.name} ${JSON.stringify(d.args || {}).slice(0, 100)}\n`; } }
        } else { setStatus(typeof e.payload === 'string' ? e.payload : ''); }
        break;
      case 'tool_start': {
        finishThinking(live); rotateBody(live);
        if (e.payload && e.payload.childId) { break; }
        const node = placeTool(live.steps, { id: e.payload.id, name: e.payload.name, arguments: JSON.stringify(e.payload.args || {}) }, null);
        if (node) { live.tools.set(e.payload.id, node); }
        scrollToBottom(false);
        break;
      }
      case 'tool_end': if (e.payload && e.payload.childId) { break; } finishTool(live.tools.get(e.payload.id), e.payload); break;
      case 'subagent_start': { rotateBody(live); const c = subagentCard(e.payload.agent, e.payload.prompt); live.subs.set(e.payload.childId, c); live.steps.appendChild(c); break; }
      case 'subagent_end': { const c = live.subs.get(e.payload.childId); if (c) { setState(c, e.payload.error ? 'error' : 'ok'); c.querySelector('.ico').innerHTML = e.payload.error ? I.x : I.agent; c.querySelector('.content').textContent += e.payload.error ? `\nError: ${e.payload.error}` : `\n\n${(e.payload.result || '').slice(0, 4000)}`; } break; }
      case 'todos': if (state.session && state.session.id === sid) { state.session.todos = e.payload || []; renderTasks(); } break;
      case 'compaction': rotateBody(live); live.root.insertBefore(el('div', 'note', `Context compacted: ${e.payload.before.toLocaleString()} → ${e.payload.after.toLocaleString()} tokens (${e.payload.removed} messages summarised)`), live.body); break;
      case 'error': rotateBody(live); live.root.insertBefore(el('div', 'error-box', esc(String(e.payload))), live.body); break;
      case 'turn_end': if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); } break;
    }
  }

  // ------------------------------------------------------------------ composer state
  function setStatus(text) { els.statusText.textContent = text || ''; els.status.classList.toggle('hidden', !text); }
  function setRunning(running) { els.send.classList.toggle('hidden', running); els.stop.classList.toggle('hidden', !running); els.progress.classList.toggle('hidden', !running); if (!running) { setStatus(''); } updateSendEnabled(); }
  function updateSendEnabled() { els.send.disabled = !els.input.value.trim() && !state.images.length; }
  function updateCtx() {
    const s = state.session; if (!s) { return; }
    const model = state.models.find((m) => m.id === s.model) || state.models.find((m) => m.id === state.defaultModel) || state.models[0];
    const win = model ? model.contextWindow : 32768; const used = s.contextTokens || 0; const pct = Math.min(100, Math.round((used / win) * 100));
    els.ctx.style.setProperty('--pct', pct); els.ctx.querySelector('.txt').textContent = `${pct}%`;
    els.ctx.title = `Context: ${used.toLocaleString()} / ${win.toLocaleString()} tokens${s.compactions ? ` · compacted ${s.compactions}×` : ''}\nClick to compact now`;
    els.ctx.className = `ctx ${pct > 85 ? 'danger' : pct > 65 ? 'warn' : ''}`;
  }
  function syncMode() { const m = MODES[(state.session && state.session.mode) || 'agent']; els.modeLabel.textContent = m.label; els.modeIcon.innerHTML = m.icon; }
  function setMode(mode) { if (!state.session || state.session.mode === mode) { return; } state.session.mode = mode; syncMode(); post({ type: 'setMode', sessionId: state.session.id, mode }); }
  function currentModel() { const s = state.session; const want = (s && s.model) || state.defaultModel; return state.models.find((m) => m.id === want) || null; }
  function syncModel() {
    els.modelBtn.classList.toggle('warn', !state.models.length);
    if (!state.models.length) { els.modelLabel.textContent = 'No models'; return; }
    const s = state.session; const explicit = s && s.model; const m = currentModel();
    const name = m ? m.name.replace(/-instruct|-chat/i, '') : explicit ? explicit.split('/').pop() : 'Auto';
    els.modelLabel.textContent = m ? (explicit ? name : `Auto · ${name}`) : name;
    els.modelBtn.title = m ? `${m.id} · ${(m.contextWindow / 1024).toFixed(0)}k context${m.supportsTools ? ' · tools' : ' · prompt-based tools'}${m.supportsVision ? ' · vision' : ''}` : 'Model';
  }
  function timeAgo(ts) { const d = Date.now() - ts; if (d < 60e3) { return 'now'; } if (d < 3600e3) { return `${Math.floor(d / 60e3)}m`; } if (d < 86400e3) { return `${Math.floor(d / 3600e3)}h`; } return `${Math.floor(d / 86400e3)}d`; }
  // Chat tabs: always visible; running agents first, then the active chat, then recent ones.
  function renderTabs() {
    const active = state.session && state.session.id;
    const list = state.sessions.slice().sort((a, b) => (state.running.has(b.id) - state.running.has(a.id)) || ((b.id === active) - (a.id === active)) || (b.updatedAt - a.updatedAt));
    els.tabs.innerHTML = '';
    if (!list.length && state.session) { list.push({ id: state.session.id, title: state.session.title || 'New chat', mode: state.session.mode, messageCount: state.session.messages.length, updatedAt: Date.now() }); }
    for (const s of list.slice(0, 10)) {
      const running = state.running.has(s.id);
      const b = el('button', `tab ${s.id === active ? 'active' : ''}`, `${running ? '<span class="spin"></span>' : ''}<span class="t">${esc(s.title || 'New chat')}</span>`);
      b.title = `${s.title}\n${s.mode} · ${s.messageCount} messages${running ? ' · running' : ''}`;
      b.onclick = () => post({ type: 'selectSession', id: s.id });
      els.tabs.appendChild(b);
    }
    els.history.dataset.n = String(state.running.size);
    els.history.title = state.running.size ? `All chats · ${state.running.size} running` : 'All chats';
    const act = els.tabs.querySelector('.tab.active'); if (act) { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function openHistory() {
    const active = state.session && state.session.id;
    const list = state.sessions.slice().sort((a, b) => (state.running.has(b.id) - state.running.has(a.id)) || (b.updatedAt - a.updatedAt));
    const items = [
      { label: 'New chat', desc: 'Starts another agent in parallel', icon: I.sparkle, onPick: () => post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' }) },
      { label: 'Run tasks in parallel…', desc: 'One agent per task', icon: I.agent, onPick: () => post({ type: 'runParallelPrompt' }) },
      { hr: true },
      ...list.map((s) => ({ group: state.running.has(s.id) ? 'Running' : 'Chats', label: s.title || 'New chat', desc: `${s.mode} · ${s.messageCount} msgs · ${timeAgo(s.updatedAt)}`, icon: state.running.has(s.id) ? I.spin : s.pinned ? I.check : I.file, selected: s.id === active, tag: state.running.has(s.id) ? 'running' : undefined, onPick: () => post({ type: 'selectSession', id: s.id }) })),
    ];
    openMenu(els.history, items, { search: 'Search chats…' });
  }
  els.newTab.onclick = () => post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' });
  els.history.onclick = openHistory;
  // Placeholder adapts to the composer width.
  const PLACEHOLDERS = [[0, 'Ask anything…'], [300, 'Ask, plan or build… (@ context)'], [420, 'Plan, build, fix anything… (@ context, / commands)']];
  new ResizeObserver(() => { const w = els.box.clientWidth; let p = PLACEHOLDERS[0][1]; for (const [min, t] of PLACEHOLDERS) { if (w >= min) { p = t; } } els.input.placeholder = p; }).observe(els.box);
  function renderTasks() {
    const todos = (state.session && state.session.todos) || [];
    els.tasks.classList.toggle('hidden', !todos.length); if (!todos.length) { return; }
    const done = todos.filter((t) => t.status === 'done').length;
    els.tasksLabel.textContent = `Tasks ${done}/${todos.length}`;
    els.tasksMeter.firstElementChild.style.width = `${Math.round((done / todos.length) * 100)}%`;
    els.tasksList.innerHTML = '';
    for (const t of todos) { els.tasksList.appendChild(el('li', `todo ${t.status}`, `<span class="box">${t.status === 'done' ? I.check : t.status === 'in_progress' ? I.spin : ''}</span><span class="title">${esc(t.title)}</span>`)); }
  }
  function renderChanges() {
    const s = state.session; const files = s ? state.changes.get(s.id) || [] : [];
    els.changes.classList.toggle('hidden', !files.length); if (!files.length) { return; }
    els.changesLabel.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed`;
    els.changesList.innerHTML = '';
    for (const f of files) {
      const li = el('li', 'change', `<span class="kind ${f.kind}">${f.kind === 'create' ? 'A' : 'M'}</span><span class="name" title="${esc(f.path)}">${esc(f.path)}</span><span class="acts"><button data-a="undo" title="Reject">${I.undo}</button><button data-a="keep" title="Accept">${I.check}</button></span>`);
      li.onclick = (e) => { const a = e.target.closest('[data-a]'); if (a) { post({ type: a.dataset.a === 'undo' ? 'undoChanges' : 'keepChanges', sessionId: s.id, fsPath: f.fsPath }); return; } post({ type: 'showDiff', sessionId: s.id, fsPath: f.fsPath }); };
      els.changesList.appendChild(li);
    }
  }
  function renderChips() {
    els.chips.innerHTML = '';
    state.attachments.forEach((a, i) => { const c = el('span', 'chip', `${a.startsWith('@') || MENTIONS.some(([n]) => n === a) ? I.list : I.file}<span title="${esc(a)}">${esc(a.replace(/^@/, ''))}</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { state.attachments.splice(i, 1); renderChips(); }; els.chips.appendChild(c); });
    state.images.forEach((img, i) => { const c = el('span', 'chip img', `<img src="data:${img.mime};base64,${img.data}" alt=""><span title="${esc(img.name)}">${esc(img.name)}</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { state.images.splice(i, 1); renderChips(); updateSendEnabled(); }; els.chips.appendChild(c); });
  }
  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { return; }
    if (state.images.length >= 4) { toast('Up to 4 images per message', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => { const img = new Image(); img.onload = () => { const MAX = 1568; const k = Math.min(1, MAX / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); state.images.push({ name: file.name || `pasted-${Date.now().toString(36)}.png`, data: c.toDataURL('image/png').split(',')[1], mime: 'image/png' }); renderChips(); updateSendEnabled(); els.input.focus(); }; img.src = reader.result; };
    reader.readAsDataURL(file);
  }
  function addAttachment(ref) { if (!state.attachments.includes(ref)) { state.attachments.push(ref); renderChips(); } els.input.focus(); }

  // ------------------------------------------------------------------ popover menus
  let menuState = null;
  function closeMenu() { els.popover.classList.add('hidden'); els.popover.innerHTML = ''; menuState = null; }
  function openMenu(anchor, items, opts = {}) {
    const p = els.popover; p.innerHTML = ''; p.classList.remove('hidden');
    menuState = { items: [], sel: 0, onPick: opts.onPick };
    let search = null;
    if (opts.search) { search = el('input', 'search'); search.placeholder = opts.search; p.appendChild(search); }
    const list = el('div', 'list'); p.appendChild(list);
    const render = (q) => {
      list.innerHTML = ''; menuState.items = [];
      const ql = (q || '').toLowerCase(); let lastGroup = null;
      for (const it of items) {
        if (it.hr) { if (!ql) { list.appendChild(el('hr')); } continue; }
        if (ql && !(`${it.label} ${it.desc || ''} ${it.group || ''}`.toLowerCase().includes(ql))) { continue; }
        if (it.group && it.group !== lastGroup && !ql) { list.appendChild(el('div', 'grp', esc(it.group))); lastGroup = it.group; }
        const row = el('div', 'item', `<span class="ico">${it.icon || ''}</span><span class="txt"><span class="lbl">${esc(it.label)}</span>${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}</span>${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}<span class="check">${it.selected ? I.check : ''}</span>`);
        row.onmousedown = (e) => { e.preventDefault(); pick(it); };
        menuState.items.push({ it, row }); list.appendChild(row);
      }
      if (!menuState.items.length) { list.appendChild(el('div', 'empty-i', 'No matches')); }
      menuState.sel = Math.max(0, menuState.items.findIndex((x) => x.it.selected)); highlight();
    };
    const highlight = () => menuState.items.forEach((x, i) => x.row.classList.toggle('sel', i === menuState.sel));
    const pick = (it) => { closeMenu(); it.onPick && it.onPick(); };
    render('');
    // Position above the anchor; fall back below when there is no room.
    const r = anchor.getBoundingClientRect(); const pw = Math.min(360, window.innerWidth - 20);
    p.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - pw - 10))}px`;
    const ph = p.offsetHeight; const above = r.top - 8;
    if (above >= Math.min(ph, 200)) { p.style.top = `${Math.max(8, r.top - 6 - ph)}px`; } else { p.style.top = `${r.bottom + 6}px`; }
    const key = (e) => {
      if (!menuState) { return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); menuState.sel = (menuState.sel + 1) % menuState.items.length; highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); menuState.sel = (menuState.sel - 1 + menuState.items.length) % menuState.items.length; highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); const x = menuState.items[menuState.sel]; if (x) { pick(x.it); } }
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); els.input.focus(); }
    };
    p.onkeydown = key;
    if (search) { search.oninput = () => render(search.value); search.onkeydown = key; search.focus(); } else { p.tabIndex = -1; p.focus(); }
  }
  document.addEventListener('mousedown', (e) => { if (menuState && !els.popover.contains(e.target) && !e.target.closest('.pick, .ctxbtn, #btnHistory')) { closeMenu(); } });

  els.modeBtn.onclick = () => openMenu(els.modeBtn, Object.entries(MODES).map(([k, m]) => ({ label: m.label, desc: m.desc, icon: m.icon, selected: (state.session && state.session.mode) === k, onPick: () => setMode(k) })));
  els.modelBtn.onclick = () => {
    const s = state.session; const cur = (s && s.model) || '';
    const items = [{ label: 'Auto', desc: state.defaultModel ? `Default: ${state.defaultModel.split('/').pop()}` : 'Best available tool-capable model', icon: I.sparkle, selected: !cur, onPick: () => chooseModel('') }];
    for (const m of state.models) { items.push({ group: m.providerId, label: m.name, desc: `${(m.contextWindow / 1024).toFixed(0)}k ctx${m.supportsTools ? ' · tools' : ' · text tools'}${m.supportsVision ? ' · vision' : ''}`, tag: m.supportsVision ? 'vision' : undefined, icon: I.bot, selected: m.id === cur, onPick: () => chooseModel(m.id) }); }
    items.push({ hr: true }, { label: 'Refresh models', icon: I.spin, onPick: () => { post({ type: 'refreshModels' }); toast('Refreshing models…'); } }, { label: 'Configure providers…', icon: I.list, onPick: () => post({ type: 'openSettings' }) });
    openMenu(els.modelBtn, items, { search: 'Search models…' });
  };
  function chooseModel(id) { if (!state.session) { return; } state.session.model = id; syncModel(); updateCtx(); post({ type: 'setModel', sessionId: state.session.id, model: id, makeDefault: false }); }
  function openContextMenu() {
    post({ type: 'requestOpenFiles' });
    const items = [
      { label: 'Files…', desc: 'Pick files to attach', icon: I.folder, onPick: () => post({ type: 'pickAttachment' }) },
      { label: 'Active file / selection', desc: 'What you are looking at now', icon: I.cursor, onPick: () => post({ type: 'attachActive' }) },
      ...MENTIONS.map(([n, d, ic]) => ({ label: `@${n}`, desc: d, icon: ic, onPick: () => addAttachment(n) })),
      { hr: true },
      { label: 'Image…', desc: 'Attach an image file', icon: I.image, onPick: () => post({ type: 'pickImage' }) },
      ...screenshotItems(),
    ];
    if (state.openFiles.length) { items.push({ hr: true }); for (const f of state.openFiles.slice(0, 12)) { items.push({ group: 'Open editors', label: f.split('/').pop(), desc: f, icon: I.file, onPick: () => addAttachment(f) }); } }
    openMenu(els.addCtx, items, { search: 'Add files, folders, docs…' });
  }
  els.addCtx.onclick = openContextMenu;
  // Screenshot capture options (like a native screenshot tool): area, this window, another window, full screen, timed.
  function shot(mode, delayMs, msg) { return () => { if (msg) { toast(msg); } post({ type: 'captureScreenshot', mode, delayMs }); }; }
  function screenshotItems() {
    const WIN = state.platform === 'win32';
    return [
      { group: 'Screenshot', label: 'Selection area', desc: 'Drag to select a region · Esc to cancel', icon: I.region, onPick: shot('region', 0, 'Drag to select a region…') },
      { group: 'Screenshot', label: 'This VS Code window', desc: 'Captured immediately', icon: I.window, onPick: shot('vscode', 0) },
      { group: 'Screenshot', label: 'Pick a window', desc: WIN ? 'Switch to the window — captured in 3 s' : 'Click a window to capture it', icon: I.windows, onPick: shot('window', WIN ? 3000 : 0, WIN ? 'Switch to the window to capture — 3 s' : 'Click a window to capture it…') },
      { group: 'Screenshot', label: 'Full screen', desc: 'Captured immediately', icon: I.screen, onPick: shot('screen', 0) },
      { group: 'Screenshot', label: 'Full screen in 5 s', desc: 'Time to switch windows or open a menu', icon: I.timer, onPick: shot('screen', 5000, 'Capturing the screen in 5 s…') },
    ];
  }
  els.image.onclick = () => openMenu(els.image, [
    { label: 'Image file…', desc: 'PNG, JPEG, GIF or WebP · or paste / drop onto the composer', icon: I.image, onPick: () => post({ type: 'pickImage' }) },
    { hr: true },
    ...screenshotItems(),
  ]);
  els.ctx.onclick = () => state.session && post({ type: 'compactNow', sessionId: state.session.id });

  // inline '/' and '@' autocomplete reuse the popover
  function tokenAt() { const v = els.input.value.slice(0, els.input.selectionStart); const at = /(?:^|\s)@([\w./-]*)$/.exec(v); if (at) { return { kind: '@', tok: at[1] }; } if (/^\/\S*$/.test(v) && !v.includes('\n')) { return { kind: '/', tok: v }; } return null; }
  function showInlineMenu(t) {
    if (t.kind === '/') {
      const items = SLASH.filter(([c]) => c.startsWith(t.tok) || (c.endsWith(' ') && t.tok.startsWith(c.trim() + ' '))).map(([c, d]) => ({ label: c.trim(), desc: d, icon: I.sparkle, onPick: () => { els.input.value = c; els.input.focus(); updateSendEnabled(); } }))
        .concat(t.tok.startsWith('/skill ') ? state.skills.filter((s) => `/skill ${s.name}`.startsWith(t.tok.trimEnd())).map((s) => ({ label: `/skill ${s.name}`, desc: s.description, icon: I.sparkle, onPick: () => { els.input.value = `/skill ${s.name} `; els.input.focus(); } })) : [])
        .concat(t.tok.startsWith('/agent ') ? state.agents.filter((a) => `/agent ${a.name}`.startsWith(t.tok.trimEnd())).map((a) => ({ label: `/agent ${a.name}`, desc: a.description, icon: I.agent, onPick: () => { els.input.value = `/agent ${a.name} `; els.input.focus(); } })) : []);
      if (!items.length) { return closeMenu(); }
      openMenu(els.box, items); els.input.focus();
    } else {
      if (!state.openFiles.length) { post({ type: 'requestOpenFiles' }); }
      const q = t.tok.toLowerCase();
      const items = MENTIONS.filter(([n]) => n.startsWith(q)).map(([n, d, ic]) => ({ label: `@${n}`, desc: d, icon: ic, onPick: () => applyMention(n) }))
        .concat(state.openFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f.split('/').pop(), desc: f, icon: I.file, onPick: () => applyMention(f) })));
      if (!items.length) { return closeMenu(); }
      openMenu(els.box, items); els.input.focus();
    }
  }
  function applyMention(name) { const pos = els.input.selectionStart; const before = els.input.value.slice(0, pos).replace(/@[\w./-]*$/, ''); els.input.value = `${before}@${name} ${els.input.value.slice(pos)}`; els.input.selectionStart = els.input.selectionEnd = before.length + name.length + 2; closeMenu(); els.input.focus(); updateSendEnabled(); }

  // ------------------------------------------------------------------ input handling
  function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = Math.min(240, els.input.scrollHeight) + 'px'; }
  function sendCurrent(fromSuggestion) {
    const text = els.input.value.trim();
    if ((!text && !state.images.length) || !state.session) { return; }
    if (state.running.has(state.session.id)) { toast('Still responding — stop it first or start a new chat', 'error'); return; }
    const atRefs = [...text.matchAll(/(?:^|\s)@([\w./-]+(?:#L\d+(?:-L?\d+)?)?)/g)].map((m) => m[1]);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    const images = state.images.map((i) => i.data);
    const finalText = text || 'Describe what you see in the attached image(s).';
    post({ type: 'send', sessionId: state.session.id, text: finalText, attachments, images: images.length ? images : undefined });
    state.history.unshift(finalText); state.history = state.history.slice(0, 50); state.histIdx = -1;
    const empty = els.messages.querySelector('.empty'); if (empty) { empty.remove(); }
    if (!finalText.startsWith('/')) {
      const u = userTurn({ content: finalText, images }, undefined);
      if (attachments.length) { u.insertBefore(el('div', 'att', attachments.map((a) => `<span class="chip">${I.file}<span>${esc(a)}</span></span>`).join('')), u.firstChild.nextSibling); }
      els.messages.appendChild(u); ensureLive(state.session.id); setStatus('Sending…');
    }
    els.input.value = ''; state.attachments = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); scrollToBottom(true);
    if (!fromSuggestion) { els.input.focus(); }
  }
  els.input.addEventListener('input', () => { autoGrow(); updateSendEnabled(); const t = tokenAt(); if (t) { showInlineMenu(t); } else if (menuState && !els.popover.querySelector('.search')) { closeMenu(); } });
  els.input.addEventListener('keydown', (e) => {
    if (menuState && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !els.popover.querySelector('.search')) {
      if (e.key === 'Tab') { e.preventDefault(); const x = menuState.items[menuState.sel]; if (x) { closeMenu(); x.it.onPick && x.it.onPick(); } return; }
      if (e.key === 'Enter') { const x = menuState.items[menuState.sel]; if (x && x.it.label !== els.input.value.trim()) { e.preventDefault(); closeMenu(); x.it.onPick && x.it.onPick(); return; } closeMenu(); }
      else { els.popover.onkeydown(e); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); return; }
    if (e.key === 'Escape' && state.session && state.running.has(state.session.id)) { post({ type: 'stop', sessionId: state.session.id }); return; }
    if (e.key === 'ArrowUp' && !els.input.value && state.history.length) { e.preventDefault(); state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1); els.input.value = state.history[state.histIdx]; autoGrow(); updateSendEnabled(); }
    if (e.key === 'ArrowDown' && state.histIdx >= 0 && els.input.value === state.history[state.histIdx]) { e.preventDefault(); state.histIdx--; els.input.value = state.histIdx >= 0 ? state.history[state.histIdx] : ''; autoGrow(); updateSendEnabled(); }
  });
  els.input.addEventListener('paste', (e) => { const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => /^image\//.test(it.type)); if (items.length) { e.preventDefault(); items.forEach((it) => addImageFile(it.getAsFile())); } });
  els.send.onclick = () => sendCurrent();
  els.stop.onclick = () => state.session && post({ type: 'stop', sessionId: state.session.id });
  els.tasksToggle.onclick = () => { els.tasks.classList.toggle('open'); els.tasksList.classList.toggle('hidden'); };
  els.tasks.classList.add('open');
  els.changesToggle.onclick = () => { els.changes.classList.toggle('open'); els.changesList.classList.toggle('hidden'); };
  els.changes.querySelector('.panel-head').onclick = (e) => { const a = e.target.closest('[data-a]'); if (!a || !state.session) { return; } post({ type: a.dataset.a === 'undoAll' ? 'undoChanges' : 'keepChanges', sessionId: state.session.id }); };
  els.box.addEventListener('dragover', (e) => { e.preventDefault(); els.box.classList.add('drop'); });
  els.box.addEventListener('dragleave', () => els.box.classList.remove('drop'));
  els.box.addEventListener('drop', (e) => { e.preventDefault(); els.box.classList.remove('drop'); const files = [...(e.dataTransfer.files || [])]; const imgs = files.filter((f) => /^image\//.test(f.type)); imgs.forEach(addImageFile); if (!imgs.length) { for (const u of (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter(Boolean)) { post({ type: 'attachUri', uri: u }); } } });
  els.messages.addEventListener('click', (e) => {
    const code = e.target.closest('[data-code]');
    if (code) { const pre = code.closest('.code').querySelector('pre'); const text = pre ? pre.textContent : ''; const act = code.dataset.code; if (act === 'copy') { navigator.clipboard.writeText(text).then(() => toast('Copied')); } if (act === 'insert') { post({ type: 'insertCode', code: text }); } if (act === 'apply') { post({ type: 'applyCodeToFile', code: text }); } return; }
    const link = e.target.closest('.path-link'); if (link) { post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined }); return; }
    const img = e.target.closest('.imgs img'); if (img) { img.classList.toggle('zoom'); return; }
    const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); post({ type: 'openExternal', url: a.getAttribute('href') }); }
  });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); els.input.focus(); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); openContextMenu(); } });

  // ------------------------------------------------------------------ messages from the extension
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init': state.sessions = m.sessions || []; state.models = m.models; state.defaultModel = m.defaultModel; state.skills = m.skills; state.agents = m.agents; state.running = new Set(m.running); state.platform = m.platform || ''; syncModel(); renderTabs(); break;
      case 'sessions': state.sessions = m.sessions || []; renderTabs(); break;
      case 'session': state.session = m.session; renderSession(); renderChanges(); renderTasks(); renderTabs(); els.input.focus(); break;
      case 'changes': state.changes.set(m.sessionId, m.files); state.checkpoints.set(m.sessionId, m.checkpoints || []); if (state.session && state.session.id === m.sessionId) { renderChanges(); } break;
      case 'models': { const hadNone = !state.models.length; state.models = m.models; state.defaultModel = m.defaultModel; syncModel(); updateCtx(); if (hadNone && m.models.length) { toast(`${m.models.length} model(s) found`); if (state.session && !state.session.messages.length) { renderSession(); } } break; }
      case 'event': handleEvent(m.event); break;
      case 'running': if (m.running) { state.running.add(m.sessionId); } else { state.running.delete(m.sessionId); finishLive(m.sessionId); } if (state.session && state.session.id === m.sessionId) { setRunning(m.running); if (!m.running) { post({ type: 'selectSession', id: m.sessionId }); } } renderTabs(); break;
      case 'approval': renderApproval(m); if (!state.session || state.session.id !== m.sessionId) { toast('Approval needed in another chat'); } break;
      case 'approvalResolved': { const d = els.approvals.querySelector(`[data-id="${CSS.escape(m.id)}"]`); if (d) { d.remove(); } break; }
      case 'toast': if (m.text.startsWith('attach:')) { addAttachment(m.text.slice(7)); } else { toast(m.text, m.level); } break;
      case 'draft': els.input.value = m.text || ''; autoGrow(); updateSendEnabled(); els.input.focus(); break;
      case 'focusInput': els.input.focus(); post({ type: 'requestOpenFiles' }); break;
      case 'openFiles': state.openFiles = m.files || []; break;
      case 'image': if (state.images.length >= 4) { toast('Up to 4 images per message', 'error'); break; } state.images.push(m.image); renderChips(); updateSendEnabled(); els.input.focus(); break;
    }
  });

  // Permission prompt (Claude Code style): Allow once / Allow for session / Deny, with keyboard shortcuts.
  function renderApproval(a) {
    const d = el('div', 'approval'); d.dataset.id = a.id;
    const kind = { terminal: 'Run command', write: 'Edit file', delete: 'Delete', network: 'Network' }[a.kind] || a.kind;
    d.innerHTML = `<div class="head">${I.warn}<span>${esc(a.title)}</span>${kind.toLowerCase() === String(a.title).toLowerCase() ? '' : `<span class="kind">${esc(kind)}</span>`}</div><pre></pre><div class="actions"><button class="btn ghost" data-a="deny" title="Deny (N)">Deny <kbd>N</kbd></button><button class="btn" data-a="session" title="Allow for this session (A)"><span class="long">Allow for session</span><span class="short">Session</span> <kbd>A</kbd></button><button class="btn primary" data-a="allow" title="Allow once (Y)"><span class="long">Allow once</span><span class="short">Once</span> <kbd>Y</kbd></button></div>`;
    d.querySelector('pre').textContent = a.detail;
    const answer = (act) => { post({ type: 'approval', id: a.id, approved: act !== 'deny', remember: act === 'session' }); d.remove(); document.removeEventListener('keydown', key, true); els.input.focus(); };
    const key = (e) => { if (e.target === els.input && els.input.value) { return; } const k = e.key.toLowerCase(); if (k === 'y') { answer('allow'); } else if (k === 'a') { answer('session'); } else if (k === 'n' || k === 'escape') { answer('deny'); } else { return; } e.preventDefault(); };
    d.onclick = (ev) => { const b = ev.target.closest('[data-a]'); if (b) { answer(b.dataset.a); } };
    document.addEventListener('keydown', key, true);
    els.approvals.appendChild(d); scrollToBottom(true);
  }

  updateSendEnabled();
  post({ type: 'ready' });
})();
