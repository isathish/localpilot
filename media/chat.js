// LocalPilot chat webview — vanilla JS, no dependencies.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const els = {
    messages: $('messages'), input: $('input'), send: $('btnSend'), stop: $('btnStop'), pause: $('btnPause'), status: $('status'), statusText: $('statusText'),
    modeBtn: $('modeBtn'), modeLabel: $('modeLabel'), modeIcon: $('modeIcon'), modelBtn: $('modelBtn'), modelLabel: $('modelLabel'), skillsBtn: $('skillsBtn'), skillsLabel: $('skillsLabel'), ctx: $('ctxMeter'),
    approvals: $('approvals'), chips: $('chips'), toasts: $('toasts'), box: $('box'), addCtx: $('btnAddCtx'), image: $('btnImage'),
    changes: $('changes'), changesList: $('changesList'), changesLabel: $('changesLabel'), changesToggle: $('changesToggle'),
    tabs: $('tabs'), progress: $('progress'), tasks: $('tasks'), tasksList: $('tasksList'), tasksLabel: $('tasksLabel'), tasksMeter: $('tasksMeter'), tasksToggle: $('tasksToggle'),
    popover: $('popover'), newTab: $('btnNewTab'), history: $('btnHistory'), bgruns: $('bgruns'),
  };
  // Webview state survives the view being hidden/restored: which chats are open as tabs.
  const persisted = (typeof vscode.getState === 'function' && vscode.getState()) || {};
  function saveState() { if (typeof vscode.setState === 'function') { vscode.setState({ openTabs: state.openTabs ? [...state.openTabs] : undefined }); } }

  const I = {
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    spin: '<svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-5.2 3"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
    download: '<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 12.5h10"/></svg>',
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
    stop: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9" stroke-width="2.2"/></svg>',
    play: '<svg viewBox="0 0 16 16"><path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor" stroke="none"/></svg>',
    bug: '<svg viewBox="0 0 16 16"><path d="M6 4.5a2 2 0 0 1 4 0v.5H6z"/><rect x="4.5" y="5" width="7" height="7.5" rx="3.5"/><path d="M8 5v7.5M2.5 8.5h2M11.5 8.5h2M3 12l1.8-1M13 12l-1.8-1M3 5l1.8 1M13 5l-1.8 1"/></svg>',
    reply: '<svg viewBox="0 0 16 16"><path d="M6.5 4.5L3 8l3.5 3.5M3 8h6a4 4 0 0 1 4 4v.5"/></svg>',
    pin: '<svg viewBox="0 0 16 16"><path d="M9.5 2.5l4 4-2 1-2 2.5V13L8 11.5 4.5 15 1 11.5 4.5 8h3l2.5-2 1-2z"/></svg>',
    fork: '<svg viewBox="0 0 16 16"><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4 5.5v1A2.5 2.5 0 0 0 6.5 9h3A2.5 2.5 0 0 0 12 6.5v-1M8 9v2"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8"/></svg>',
    export: '<svg viewBox="0 0 16 16"><path d="M8 10V3M5 6l3-3 3 3M3 10v2.5a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10"/></svg>',
    rename: '<svg viewBox="0 0 16 16"><path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/><path d="M3 14h10"/></svg>',
    layers: '<svg viewBox="0 0 16 16"><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z"/><path d="M2.5 8.5L8 11.5l5.5-3M2.5 11L8 14l5.5-3"/></svg>',
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
  /** The one quiet "running" marker used wherever a spinner would only add noise: tabs, background rows, worker lanes. */
  const LIVE_DOT = '<span class="dot live" aria-label="Running"></span>';
  const MODES = {
    agent: { label: 'Agent', icon: I.agent, desc: 'Edit files, run commands, verify', placeholder: 'Plan, build, fix anything… (@ context, / commands)' },
    multitask: { label: 'Multitask', icon: I.layers, desc: 'Splits the work across background workers that run at the same time', placeholder: 'Coordinate parallel tasks… describe the outcome you want' },
    debug: { label: 'Debug', icon: I.bug, desc: 'Reproduce the problem, find the cause, fix and verify', placeholder: 'Paste the error or describe what goes wrong…' },
    plan: { label: 'Plan', icon: I.plan, desc: 'Investigate and prepare a plan you can build with one click', placeholder: 'Describe what you want; I will prepare a plan first' },
    ask: { label: 'Ask', icon: I.ask, desc: 'Answer questions, read-only', placeholder: 'Ask anything about this code…' },
  };
  const READ_TOOLS = new Set(['read_file', 'list_dir', 'file_search', 'grep_search', 'find_symbol', 'find_references', 'get_diagnostics', 'get_editor_state', 'memory_read', 'memory_list', 'load_skill', 'web_search', 'web_fetch']);
  const SLASH = [
    ['/help', 'Show commands'], ['/model ', 'Switch model for this chat'], ['/mode agent', 'Agent mode'], ['/mode ask', 'Ask mode'], ['/mode plan', 'Plan mode'],
    ['/compact', 'Summarise older messages'], ['/clear', 'Clear this chat'], ['/skills', 'List skills'], ['/agents', 'List subagents'], ['/skill ', 'Run a task with a skill'], ['/skill install ', 'Install a skill from GitHub, a URL or a folder'], ['/skill browse ', 'Search and install from the skill catalog'], ['/agent ', 'Delegate to a subagent'], ['/context', 'Context usage'],
  ];
  const MENTIONS = [['workspace', 'Project file tree', I.folder], ['selection', 'Current selection / active file', I.cursor], ['problems', 'Errors & warnings', I.bug], ['git', 'git status + diff', I.git], ['editors', 'Open editors', I.list], ['terminal', 'Last terminal command & output', I.term]];

  const state = {
    session: null, sessions: [], models: [], defaultModel: '', running: new Set(), attachments: [], images: [], skills: [], agents: [], openFiles: [],
    live: new Map(), changes: new Map(), checkpoints: new Map(), history: [], histIdx: -1,
    // Multi-tab bookkeeping: which chats are shown as tabs, the tab we are switching to, live status per running chat,
    // chats that finished while in the background (unread) and chats waiting on an approval (attention).
    openTabs: Array.isArray(persisted.openTabs) ? new Set(persisted.openTabs) : null, loadingTab: null, activeHint: null,
    status: new Map(), unread: new Set(), attention: new Set(), approvalSid: new Map(),
    // Per-tab isolation: composer draft + attachments, scroll offset and the model each agent is talking to.
    selected: new Set(), drafts: new Map(), scroll: new Map(), modelOf: new Map(), dismissed: new Set(),
    // Sends the host has not acknowledged with `running` yet (sessionId → watchdog timer).
    pendingSend: new Map(),
    /** sid → { paused, holding }: Pause was requested / the loop is actually holding at a step boundary. */
    paused: new Map(),
    /** sid → { path, applied, conflicts } when the session's changes live in an isolated worktree. */
    worktree: new Map(),
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; }
  function post(m) { vscode.postMessage(m); }
  function toast(text, level) { const t = el('div', `toast ${level || 'info'}`, esc(text)); els.toasts.appendChild(t); setTimeout(() => t.remove(), 3200); }
  // "Stick to bottom" is decided from scroll events (layout is already clean there) instead of forcing a layout on every
  // call — followLive runs once per frame while streaming and that read was the single biggest CPU cost of a long reply.
  let stickToBottom = true;
  function scrollToBottom(force) { const m = els.messages; if (force || stickToBottom) { m.scrollTop = m.scrollHeight; stickToBottom = true; } }
  function noteScroll() { const m = els.messages; stickToBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 160; }
  function parseArgs(s) { try { return JSON.parse(s) || {}; } catch { return { raw: s }; } }
  function base(p) { return String(p || '').split('/').pop(); }
  function short(v, n = 70) { const t = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return esc(t.length > n ? t.slice(0, n - 1) + '…' : t); }

  // ------------------------------------------------------------------ syntax highlighting
  // Small tokenizer-based highlighter: comments, strings, numbers, keywords, types, calls, properties. Theme colours come
  // from VS Code token CSS variables so blocks match the editor in light and dark themes.
  const KW = {
    js: 'const let var function return if else for while do switch case break continue new delete typeof instanceof in of class extends super this import export from default as async await yield try catch finally throw void with static get set null undefined true false',
    ts: 'interface type enum namespace declare implements readonly public private protected abstract keyof infer is satisfies override never unknown any string number boolean object symbol bigint',
    py: 'def class return if elif else for while in not and or is None True False import from as with pass break continue lambda try except finally raise yield global nonlocal assert del async await match case self',
    sh: 'if then else elif fi for while do done case esac in function return exit export local readonly set unset echo cd ls cat grep sed awk curl git npm npx node python pip docker ollama sudo mkdir rm cp mv chmod source alias',
    go: 'package import func return if else for range switch case default break continue go defer chan select struct interface map type var const nil true false make new len cap append error string int int64 float64 bool byte rune',
    rust: 'fn let mut pub use mod struct enum impl trait for in if else match while loop return break continue self Self super crate as where type const static ref move async await dyn unsafe true false Some None Ok Err String Vec Option Result',
    c: 'int char long short float double void unsigned signed struct union enum typedef const static extern return if else for while do switch case break continue default sizeof goto include define ifdef ifndef endif pragma class public private protected virtual override template typename namespace using new delete this nullptr true false bool auto',
    java: 'public private protected class interface enum extends implements import package static final abstract void int long short byte char float double boolean return if else for while do switch case break continue new this super throw throws try catch finally instanceof null true false var record sealed permits fun val when object data override suspend let',
    sql: 'select from where insert into values update set delete create table index view drop alter add primary key foreign references join left right inner outer on group by order having limit offset as and or not null is in like between exists union all distinct case when then else end count sum avg min max',
    ruby: 'def end class module if elsif else unless while until for in do return yield begin rescue ensure raise require include extend attr_accessor self nil true false puts',
    php: 'function class return if else elseif for foreach while do switch case break continue new echo public private protected static namespace use extends implements try catch finally throw null true false array',
  };
  const LANG_ALIAS = { javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', tsx: 'ts', python: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', shellscript: 'sh', golang: 'go', rs: 'rust', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cs: 'java', csharp: 'java', kotlin: 'java', kt: 'java', swift: 'java', scala: 'java', jsonc: 'json', json5: 'json', yml: 'yaml', htm: 'html', xml: 'html', svg: 'html', vue: 'html', svelte: 'html', scss: 'css', less: 'css', markdown: 'md', mdx: 'md', patch: 'diff', rb: 'ruby', ini: 'toml', cfg: 'toml', dockerfile: 'sh', makefile: 'sh' };
  const EXT_LANG = { js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'ts', tsx: 'ts', py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', cs: 'java', java: 'java', kt: 'java', swift: 'java', scala: 'java', sql: 'sql', rb: 'ruby', php: 'php', json: 'json', yaml: 'yaml', yml: 'yaml', html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', css: 'css', scss: 'css', less: 'css', md: 'md', mdx: 'md', toml: 'toml', ini: 'toml', diff: 'diff', patch: 'diff' };
  const kwSets = {};
  function kwSet(lang) { if (!kwSets[lang]) { const base = lang === 'ts' ? `${KW.js} ${KW.ts}` : KW[lang] || ''; kwSets[lang] = new Set(base.split(/\s+/).filter(Boolean)); } return kwSets[lang]; }
  function normLang(l) { l = String(l || '').toLowerCase().trim(); return LANG_ALIAS[l] || l; }
  function langForPath(p) { const m = /\.([a-z0-9]+)$/i.exec(String(p || '')); return m ? EXT_LANG[m[1].toLowerCase()] || '' : /dockerfile|makefile/i.test(p) ? 'sh' : ''; }
  const tok = (cls, text) => `<span class="tk-${cls}">${esc(text)}</span>`;
  // Streaming re-renders the whole answer up to 20×/s; finished code blocks are identical each time, so remember them.
  const hlCache = new Map();
  function highlight(code, lang) {
    const key = `${lang}\u0000${code}`;
    const hit = hlCache.get(key);
    if (hit !== undefined) { return hit; }
    const out = highlightRaw(code, lang);
    if (hlCache.size > 300) { hlCache.delete(hlCache.keys().next().value); }
    hlCache.set(key, out);
    return out;
  }
  function highlightRaw(code, lang) {
    lang = normLang(lang);
    if (!code || code.length > 60000) { return esc(code); }
    if (lang === 'diff') { return code.split('\n').map((l) => (/^\+/.test(l) ? tok('add', l) : /^-/.test(l) ? tok('del', l) : /^@@/.test(l) ? tok('meta', l) : esc(l))).join('\n'); }
    if (lang === 'md') { return code.split('\n').map((l) => (/^#{1,6}\s/.test(l) ? tok('k', l) : /^\s*[-*+]\s|^\s*\d+\.\s/.test(l) ? esc(l).replace(/^(\s*(?:[-*+]|\d+\.))/, (m) => `<span class="tk-n">${m}</span>`) : esc(l).replace(/`[^`]+`/g, (m) => `<span class="tk-s">${m}</span>`).replace(/\*\*[^*]+\*\*/g, (m) => `<span class="tk-t">${m}</span>`))).join('\n'); }
    if (lang === 'html') { return esc(code).replace(/(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([\w:-]+)([^&]*?)(\/?&gt;)/g, (m, c, open, name, attrs, close) => (c ? `<span class="tk-c">${c}</span>` : `<span class="tk-o">${open}</span><span class="tk-k">${name}</span>${attrs.replace(/([\w:-]+)(=)(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)?/g, (a, n, eq, v) => `<span class="tk-p">${n}</span>${eq}${v ? `<span class="tk-s">${v}</span>` : ''}`)}<span class="tk-o">${close}</span>`)); }
    if (lang === 'css') { return esc(code).replace(/(\/\*[\s\S]*?\*\/)|([^{}\n;]+)(?=\s*\{)|([\w-]+)(\s*:\s*)([^;}\n]+)/g, (m, c, sel, prop, colon, val) => (c ? `<span class="tk-c">${c}</span>` : sel !== undefined ? `<span class="tk-t">${sel}</span>` : `<span class="tk-p">${prop}</span>${colon}<span class="tk-s">${val}</span>`)); }
    if (lang === 'json') { return esc(code).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b/g, (m, str, colon, num, lit) => (str ? (colon ? `<span class="tk-p">${str}</span>${colon}` : `<span class="tk-s">${str}</span>`) : num ? `<span class="tk-n">${num}</span>` : `<span class="tk-k">${lit}</span>`)); }
    if (lang === 'yaml' || lang === 'toml') { return code.split('\n').map((l) => { const m = /^(\s*)(#.*)$/.exec(l); if (m) { return esc(m[1]) + tok('c', m[2]); } const kv = /^(\s*(?:- )?)([\w.-]+|"[^"]*"|\[[^\]]*\])(\s*[:=]\s*)(.*)$/.exec(l); if (kv) { const v = kv[4]; const val = /^(['"]).*\1$/.test(v) ? tok('s', v) : /^(true|false|null|~|yes|no|on|off)$/i.test(v) ? tok('k', v) : /^-?\d+(\.\d+)?$/.test(v) ? tok('n', v) : esc(v).replace(/(#.*)$/, (c) => `<span class="tk-c">${c}</span>`); return esc(kv[1]) + tok('p', kv[2]) + esc(kv[3]) + val; } return esc(l).replace(/^(\s*-\s)/, (d) => `<span class="tk-o">${d}</span>`); }).join('\n'); }
    const kws = kwSet(lang);
    const lineC = lang === 'py' || lang === 'sh' || lang === 'ruby' ? '#' : lang === 'sql' ? '--' : '//';
    const TRIPLE = ['"""', "'''"];
    const out = []; let i = 0; const n = code.length;
    const push = (cls, t) => out.push(cls ? tok(cls, t) : esc(t));
    while (i < n) {
      const ch = code[i]; const two = code.slice(i, i + 2);
      if (two === '/*' && lang !== 'py' && lang !== 'sh') { const e = code.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; push('c', code.slice(i, end)); i = end; continue; }
      if (code.startsWith(lineC, i)) { const e = code.indexOf('\n', i); const end = e < 0 ? n : e; push('c', code.slice(i, end)); i = end; continue; }
      if (lang === 'c' && ch === '#' && (i === 0 || code[i - 1] === '\n')) { const e = code.indexOf('\n', i); const end = e < 0 ? n : e; push('meta', code.slice(i, end)); i = end; continue; }
      if (lang === 'py' && TRIPLE.some((q) => code.startsWith(q, i))) { const q = code.slice(i, i + 3); const e = code.indexOf(q, i + 3); const end = e < 0 ? n : e + 3; push('s', code.slice(i, end)); i = end; continue; }
      if (ch === '"' || ch === "'" || (ch === '`' && (lang === 'js' || lang === 'ts' || lang === 'sh'))) {
        let j = i + 1; while (j < n && code[j] !== ch) { if (code[j] === '\\') { j++; } if (ch !== '`' && code[j] === '\n') { break; } j++; }
        push('s', code.slice(i, j + 1)); i = j + 1; continue;
      }
      if (/[0-9]/.test(ch) && !/[\w$]/.test(code[i - 1] || ' ')) { let j = i; while (j < n && /[0-9a-fA-FxX._]/.test(code[j])) { j++; } push('n', code.slice(i, j)); i = j; continue; }
      if (lang === 'sh' && ch === '$') { const m = /^\$(?:\{[^}]*\}|[\w@#?*!$-]+)/.exec(code.slice(i)); if (m) { push('v', m[0]); i += m[0].length; continue; } }
      if (lang === 'sh' && ch === '-' && (i === 0 || /\s/.test(code[i - 1]))) { const m = /^-{1,2}[\w-]+/.exec(code.slice(i)); if (m) { push('p', m[0]); i += m[0].length; continue; } }
      if (/[A-Za-z_$@]/.test(ch)) {
        let j = i; while (j < n && /[\w$]/.test(code[j])) { j++; }
        const w = code.slice(i, j); let k = j; while (k < n && code[k] === ' ') { k++; }
        const prev = code.slice(0, i).replace(/\s+$/, '').slice(-1);
        if (kws.has(w)) { push('k', w); }
        else if (prev === '.' && code[k] !== '(') { push('p', w); }
        else if (code[k] === '(') { push('f', w); }
        else if (/^[A-Z][\w$]*$/.test(w) && w.length > 1 && !/^[A-Z_0-9]+$/.test(w)) { push('t', w); }
        else { push('', w); }
        i = j; continue;
      }
      if (/[{}()[\];,.]/.test(ch)) { push('o', ch); i++; continue; }
      if (/[=+\-*/%<>!&|^~?:]/.test(ch)) { let j = i; while (j < n && /[=+\-*/%<>!&|^~?:]/.test(code[j]) && j - i < 3) { j++; } push('op', code.slice(i, j)); i = j; continue; }
      let j = i; while (j < n && !/[\w$"'`#/{}()[\];,.=+\-*%<>!&|^~?:@]/.test(code[j])) { j++; } if (j === i) { j++; }
      push('', code.slice(i, j)); i = j;
    }
    return out.join('');
  }
  /** Fenced block with header actions. `info` is the fence info string: `ts`, `ts path/to/file.ts`, `json title="x"`. */
  function codeBlock(code, info) {
    const parts = String(info || '').trim().split(/\s+/);
    const lang = parts[0] && !/[./]/.test(parts[0]) ? parts[0] : '';
    const titleM = /(?:title|file|path)=("?)([^"\s]+)\1/.exec(info || '');
    const file = titleM ? titleM[2] : parts.find((p) => /[\w-]+\.[a-z0-9]+$/i.test(p) && !p.includes('=')) || '';
    const lines = code.split('\n').length;
    const head = file ? `<span class="lang path-link" data-path="${esc(file)}" title="Open ${esc(file)}">${esc(file)}</span>` : `<span class="lang">${esc(lang || 'text')}</span>`;
    return `<div class="code" data-lang="${esc(normLang(lang))}"><div class="code-head">${head}<span class="meta">${lines > 1 ? `${lines} lines` : ''}</span><button data-code="copy" title="Copy">${I.copy}<span>Copy</span></button><button data-code="insert" title="Insert at cursor">${I.insert}</button><button data-code="apply" title="Apply to active file">${I.apply}</button></div><pre><code>${highlight(code, lang || langForPath(file))}</code></pre></div>`;
  }
  /** `NNN | text` lines from read_file → numbered, highlighted listing. */
  function numberedListing(text, lang) {
    const rows = [];
    for (const l of String(text).split('\n')) { const m = /^\s*(\d+) \| ?(.*)$/.exec(l); if (m) { rows.push([m[1], m[2]]); } else if (rows.length) { rows[rows.length - 1][1] += `\n${l}`; } }
    if (!rows.length) { return null; }
    const body = highlight(rows.map((r) => r[1]).join('\n'), lang).split('\n');
    return `<pre class="numbered"><code>${rows.map((r, i) => `<span class="l"><span class="n">${r[0]}</span><span class="t">${body[i] ?? ''}</span></span>`).join('')}</code></pre>`;
  }
  /** Escapes text and turns `path/to/file.ext:12` and URLs into links. */
  function linkify(text) {
    let s = esc(text);
    s = s.replace(/(https?:\/\/[^\s<>"')\]]+)/g, (u) => `<a href="${u}">${u}</a>`);
    s = s.replace(/(^|[\s(\[])((?:[\w.@-]+\/)*[\w.@-]+\.[a-zA-Z]{1,8})(?::(\d+)(?::\d+)?)?(?=[\s).,;:\]]|$)/gm, (m, pre, p, line) => (/^(https?|www)\b/.test(p) || (/\.(com|org|net|io|dev|ai)$/.test(p) && !p.includes('/')) ? m : `${pre}<span class="path-link" data-path="${p}" data-line="${line || ''}">${p}${line ? ':' + line : ''}</span>`));
    return s;
  }
  /** ANSI SGR colours/bold/dim/underline → spans; every other escape sequence is dropped. */
  function ansiToHtml(text) {
    const parts = String(text).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[\?[\d;]*[a-zA-Z]|\x1b\[[\d;]*[A-Za-ln-z]|\r(?!\n)/g, '').split(/(\x1b\[[\d;]*m)/);
    let open = []; let out = '';
    for (const part of parts) {
      const m = /^\x1b\[([\d;]*)m$/.exec(part);
      if (!m) { out += open.length ? `<span class="${open.join(' ')}">${linkify(part)}</span>` : linkify(part); continue; }
      for (const c of (m[1] || '0').split(';').map(Number)) {
        if (c === 0) { open = []; }
        else if (c === 1 || c === 2 || c === 3 || c === 4 || (c >= 30 && c <= 37) || (c >= 90 && c <= 97) || (c >= 40 && c <= 47)) { open.push(`a${c}`); }
        else if (c === 39) { open = open.filter((x) => !/^a(3\d|9\d)$/.test(x)); }
        else if (c === 22) { open = open.filter((x) => x !== 'a1' && x !== 'a2'); }
        else if (c === 24) { open = open.filter((x) => x !== 'a4'); }
        else if (c === 23) { open = open.filter((x) => x !== 'a3'); }
      }
    }
    return out;
  }
  function openLightbox(src, alt) {
    let lb = document.getElementById('lightbox');
    if (!lb) {
      lb = el('div', 'lightbox hidden'); lb.id = 'lightbox';
      lb.innerHTML = `<img alt=""><div class="lb-bar"><span class="lb-cap"></span><button class="lb-copy" title="Copy image">${I.copy}</button><button class="lb-close" title="Close (Esc)">${I.x}</button></div>`;
      document.body.appendChild(lb);
      lb.onclick = (e) => { if (e.target.closest('.lb-copy')) { fetch(lb.querySelector('img').src).then((r) => r.blob()).then((b) => navigator.clipboard.write([new ClipboardItem({ [b.type]: b })])).then(() => toast('Image copied')).catch(() => toast('Copy failed', 'error')); return; } lb.classList.add('hidden'); };
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lb.classList.contains('hidden')) { lb.classList.add('hidden'); } });
    }
    lb.querySelector('img').src = src; lb.querySelector('img').alt = alt || ''; lb.querySelector('.lb-cap').textContent = alt || ''; lb.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ markdown
  function inline(md) {
    // Protect code spans, images and links from the other substitutions, then restore them.
    const keep = []; const hold = (html) => { keep.push(html); return `\u0000${keep.length - 1}\u0000`; };
    let s = esc(md);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
    s = s.replace(/!\[([^\]]*)\]\(((?:https?:|data:image\/)[^)\s]+)\)/g, (_, alt, src) => hold(`<img class="md-img" src="${src}" alt="${alt}" title="${alt}">`));
    s = s.replace(/\[([^\]]+)\]\(((?:https?:|vscode:|command:)[^)\s]+)\)/g, (_, t, u) => hold(`<a href="${u}" title="${u}">${t}</a>`));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')\]]+?)(?=[.,;:!?]?(?:[\s)]|$))/g, (m, pre, u) => `${pre}${hold(`<a href="${u}">${u}</a>`)}`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, '$1<em>$2</em>').replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z]{1,8})(?::(\d+))?(?=[\s).,;:]|$)/g, (m, pre, p, line) => `${pre}<span class="path-link" data-path="${p}" data-line="${line || ''}">${p}${line ? ':' + line : ''}</span>`);
    s = s.replace(/^\[([ xX])\]\s/, (_, c) => `<span class="task ${c.trim() ? 'done' : ''}">${c.trim() ? I.check : ''}</span>`);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
  }
  function renderMarkdown(md) {
    const lines = String(md || '').replace(/\r/g, '').split('\n');
    const out = []; let i = 0; let para = [];
    const flush = () => {
      if (!para.length) { return; }
      const html = inline(para.join('\n')).replace(/\n/g, '<br>');
      // "Understood as: …" is the agent restating an ambiguous request; set it apart as a quiet kicker instead of body text.
      const u = /^(?:<strong>)?Understood as:?(?:<\/strong>)?:?\s*/i.exec(html);
      out.push(u ? `<p class="understood"><span class="k">Understood as</span>${html.slice(u[0].length)}</p>` : `<p>${html}</p>`);
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
      if (fence) {
        flush(); const info = fence[2] || ''; const buf = []; const close = new RegExp(`^\\s*\\${fence[1][0]}{${fence[1].length},}\\s*$`); i++;
        while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; } i++;
        out.push(codeBlock(buf.join('\n'), info));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) { flush(); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`); continue; }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        flush(); const items = [];
        while (i < lines.length && (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s+\S/.test(lines[i]) && items.length) || (lines[i].trim() === '' && i + 1 < lines.length && /^\s+(?:[-*+]|\d+[.)])\s+/.test(lines[i + 1])))) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) { items.push({ depth: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] }); } else if (lines[i].trim()) { items[items.length - 1].text += '\n' + lines[i].trim(); }
          i++;
        }
        out.push(renderList(items));
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

  /** Builds nested <ul>/<ol> from flat list items with indentation depths. */
  function renderList(items) {
    let pos = 0;
    const build = (depth) => {
      const ordered = items[pos].ordered; let html = '';
      while (pos < items.length && items[pos].depth >= depth) {
        if (items[pos].depth > depth) { html = html.replace(/<\/li>$/, '') + build(items[pos].depth) + '</li>'; continue; }
        const it = items[pos++];
        html += `<li class="${/^\[[ xX]\]\s/.test(it.text) ? 'task-item' : ''}">${inline(it.text).replace(/\n/g, '<br>')}</li>`;
      }
      return `<${ordered ? 'ol' : 'ul'}>${html}</${ordered ? 'ol' : 'ul'}>`;
    };
    return build(items[0].depth);
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
  /** Renders a tool's result (or its pending arguments) as something readable instead of a raw text dump. */
  function toolContent(node, tool, args, content, pending, extra) {
    const c = node.querySelector(':scope > .content'); if (!c) { return; }
    c.className = 'content';
    const img = extra && (extra.image || (extra.data && extra.data.image));
    // Images are placed eagerly (the row opens itself to show them); text bodies wait until the row is expanded.
    if (tool === 'browser_inspect' && !pending) {
      c.classList.add('inspect');
      c.innerHTML = `${img && img.data ? `<img class="shot-img" src="data:${img.mime || 'image/png'};base64,${img.data}" alt="${esc((args && args.url) || 'screenshot')}" title="Click to enlarge">` : ''}${inspectReport(String(content || ''))}`;
      return;
    }
    if (img && img.data) {
      const src = `data:${img.mime || 'image/png'};base64,${img.data}`;
      const cap = (extra.data && extra.data.caption) || (args && args.url) || tool;
      c.classList.add('shot'); c.innerHTML = `<img src="${src}" alt="${esc(cap)}" title="Click to enlarge"><div class="shot-cap">${linkify(String(content || cap))}</div>`;
      return;
    }
    if (pending) {
      c.classList.add('args');
      lazyFill(node, () => { const entries = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== ''); c.innerHTML = entries.length ? `<dl>${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')}</dl>` : '<span class="muted">Running…</span>'; });
      return;
    }
    const text = String(content || '');
    const isDoc = tool === 'web_fetch' || tool === 'web_search' || tool === 'memory_read' || tool === 'load_skill' || tool === 'run_parallel_subagents' || tool === 'run_subagent';
    if (tool === 'read_file') { c.classList.add('file'); } else if (isDoc) { c.classList.add('doc'); }
    lazyFill(node, () => {
      if (tool === 'read_file') {
        const head = /^File: (.+?) \((\d+) lines total, showing (\d+)-(\d+)\)\n?/.exec(text);
        const listing = numberedListing(head ? text.slice(head[0].length) : text, langForPath(head ? head[1] : args.path));
        if (listing) { c.innerHTML = `${head ? `<div class="file-head"><span class="path-link" data-path="${esc(head[1])}" data-line="${head[3]}">${esc(head[1])}</span><span class="meta">lines ${head[3]}–${head[4]} of ${head[2]}</span></div>` : ''}${listing}`; return; }
        c.classList.remove('file');
      }
      if (isDoc) {
        const src = /^Source: (\S+)\n\n?/.exec(text);
        c.innerHTML = `${src ? `<div class="file-head"><a href="${esc(src[1])}">${esc(src[1])}</a></div>` : ''}<div class="doc-body">${renderMarkdown(src ? text.slice(src[0].length) : text)}</div>`;
        return;
      }
      c.innerHTML = linkify(text);
    });
  }
  /** Turns the stable text report of browser_inspect into sections: summary chips, console entries, failed requests, metrics, layout. */
  function inspectReport(text) {
    const lines = String(text).replace(/\n\nThe screenshot is attached to the next message\.?\s*$/, '').split('\n');
    const sec = {}; let cur = null;
    for (const l of lines) {
      const m = /^(Page|Actions|Console|Network|Performance|Layout|Text):\s?(.*)$/.exec(l);
      if (m) { cur = m[1]; sec[cur] = { head: m[2], items: [] }; continue; }
      if (cur && l.trim()) { sec[cur].items.push(l.replace(/^\s{2}/, '')); }
    }
    if (!sec.Page) { return linkify(text); }
    const out = [];
    const pm = /^(.*?) — (\S+)(?: \(HTTP (\d+)\))? · (\d+×\d+)(.*)$/.exec(sec.Page.head) || [];
    const status = pm[3] ? Number(pm[3]) : 0;
    out.push(`<div class="ins-head"><span class="ins-title">${esc(pm[1] || sec.Page.head)}</span><a href="${esc(pm[2] || '')}">${esc(pm[2] || '')}</a>${status ? `<span class="badge ${status >= 400 ? 'err' : 'ok'}">HTTP ${status}</span>` : ''}<span class="badge">${esc(pm[4] || '')}</span></div>`);
    if (sec.Actions) { out.push(`<div class="ins-row muted">${I.cursor} ${esc(sec.Actions.head)}</div>`); }
    const chips = [];
    const cm = /^(\d+) errors?, (\d+) warnings?/.exec((sec.Console || {}).head || '');
    const nm = /^(\d+) requests? · (\d+) failed · ([^·]+)/.exec((sec.Network || {}).head || '');
    if (cm) { chips.push(`<span class="chip ${Number(cm[1]) ? 'err' : 'ok'}">${cm[1]} console error${cm[1] === '1' ? '' : 's'}</span><span class="chip ${Number(cm[2]) ? 'warn' : ''}">${cm[2]} warning${cm[2] === '1' ? '' : 's'}</span>`); }
    if (nm) { chips.push(`<span class="chip ${Number(nm[2]) ? 'err' : 'ok'}">${nm[2]} failed of ${nm[1]} request${nm[1] === '1' ? '' : 's'}</span><span class="chip">${esc(nm[3].trim())}</span>`); }
    if (sec.Layout) { const n = /^no issues/.test(sec.Layout.head) ? 0 : sec.Layout.head.split('; ').length; chips.push(`<span class="chip ${n ? 'warn' : 'ok'}">${n} layout issue${n === 1 ? '' : 's'}</span>`); }
    if (chips.length) { out.push(`<div class="ins-chips">${chips.join('')}</div>`); }
    const section = (title, body, open) => { const [t, ...rest] = title.split(' · '); return `<details class="ins-sec" ${open ? 'open' : ''}><summary><b>${esc(t)}</b>${rest.length ? `<span>${esc(rest.join(' · '))}</span>` : ''}</summary>${body}</details>`; };
    if (sec.Console && sec.Console.items.length) {
      const rows = sec.Console.items.map((it) => { const m = /^\[(\w+)\](?: \(([^)]+)\))? (.*?)(?: — (\S+))?$/.exec(it); if (!m) { return `<div class="ins-log">${linkify(it)}</div>`; } return `<div class="ins-log lv-${m[1]}"><span class="lv">${m[1]}</span>${m[2] ? `<span class="src">${esc(m[2])}</span>` : ''}<span class="msg">${linkify(m[3])}</span>${m[4] ? `<span class="at">${linkify(m[4])}</span>` : ''}</div>`; });
      out.push(section(`Console · ${sec.Console.head}`, rows.join(''), cm && Number(cm[1]) > 0));
    }
    if (sec.Network) {
      const failed = sec.Network.items.filter((it) => it.startsWith('✗')).map((it) => { const m = /^✗ (\w+) (\S+) → (.*?)(?: \((\d+) ms\))?$/.exec(it); return m ? `<div class="ins-req"><span class="m">${esc(m[1])}</span><span class="u">${linkify(m[2])}</span><span class="st err">${esc(m[3])}</span>${m[4] ? `<span class="ms">${m[4]} ms</span>` : ''}</div>` : `<div class="ins-req">${linkify(it)}</div>`; });
      const types = sec.Network.items.find((it) => it.startsWith('by type:'));
      out.push(section(`Network · ${sec.Network.head}`, `${failed.join('')}${types ? `<div class="ins-row muted">${esc(types)}</div>` : ''}`, failed.length > 0));
    }
    if (sec.Performance) { out.push(`<div class="ins-perf">${sec.Performance.head.split(' · ').map((p) => `<span>${esc(p)}</span>`).join('')}</div>`); }
    if (sec.Layout && !/^no issues/.test(sec.Layout.head)) { out.push(section('Layout checks', sec.Layout.head.split('; ').map((l) => `<div class="ins-row warn">${I.warn} ${esc(l)}</div>`).join(''), true)); }
    if (sec.Text && sec.Text.items.length) { out.push(section('Page text', `<pre class="ins-text">${esc(sec.Text.items.join('\n'))}</pre>`, false)); }
    return `<div class="ins">${out.join('')}</div>`;
  }
  // ------------------------------------------------------------------ step timeline (VS Code-style agent transcript)
  // One concise row per step: <verb> <detail>, past tense once done, present tense while running. Rows expand for details.
  function stepEl(cls, label, content, meta) {
    const d = el('details', `step ${cls}`);
    d.innerHTML = `<summary><span class="ico"></span><span class="label">${label}</span><span class="meta">${meta || ''}</span><span class="chev">${I.chev}</span></summary><div class="content"></div>`;
    if (content !== undefined) { d.querySelector('.content').textContent = content; }
    setState(d, cls.includes('running') ? 'running' : cls.includes('error') ? 'error' : 'ok');
    return d;
  }
  /**
   * Defers building a collapsed row's body until it is first expanded. A long transcript has hundreds of tool
   * results (file listings, test output, diffs) that nobody opens; materialising them eagerly cost ~400k DOM nodes
   * and made every render, scroll and tab switch pay for it. Open rows (and re-fills of open rows) render at once.
   */
  function lazyFill(node, fill) {
    node.__fill = fill;
    if (node.open) { node.__fill = null; fill(); return; }
    if (!node.__lazy) {
      node.__lazy = true;
      node.addEventListener('toggle', () => { if (node.open && node.__fill) { const f = node.__fill; node.__fill = null; f(); } });
    }
  }
  /** Settled rows keep their tool icon (muted) instead of a check mark; errors get ✕, running a spinner. Subagent lanes keep
   *  their agent glyph while running (the Workers card above them carries the one spinner) so a batch of workers is not a wall of spinners. */
  function setState(d, st) { d.classList.remove('running', 'ok', 'error'); d.classList.add(st); const ico = d.querySelector(':scope > summary .ico'); if (ico) { ico.innerHTML = st === 'running' ? (d.classList.contains('subagent') ? LIVE_DOT : I.spin) : st === 'error' ? I.x : d.__ico || I.check; } }
  const LANG_EXT = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', md: 'md', css: 'css', scss: 'css', html: 'html', py: 'py', go: 'go', rs: 'rs', java: 'java', cs: 'cs', rb: 'rb', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'yml', yaml: 'yml', toml: 'toml', sql: 'sql', svg: 'svg', vue: 'vue', swift: 'swift', kt: 'kt' };
  /** File / folder / URL chip, like the resource pills in VS Code chat. Files open on click; URLs open externally. */
  function fchip(path, kind = 'file', extra) {
    const p = String(path || ''); if (!p) { return ''; }
    const name = kind === 'url' ? p.replace(/^https?:\/\//, '').replace(/\/$/, '') : base(p) || p;
    const ext = kind === 'file' ? (p.split('.').pop() || '').toLowerCase() : '';
    const tag = kind === 'url' ? I.globe : kind === 'folder' ? I.folder : LANG_EXT[ext] ? `<i class="lang l-${LANG_EXT[ext]}">${LANG_EXT[ext]}</i>` : I.file;
    return `<span class="fchip${kind === 'url' ? '' : ' path-link'}" ${kind === 'url' ? `data-url="${esc(p)}"` : `data-path="${esc(p)}"`}${extra && extra.line ? ` data-line="${extra.line}"` : ''} title="${esc(p)}">${tag}<span>${esc(short(name, 48))}</span></span>`;
  }
  const code = (t, n = 60) => `<code>${short(String(t ?? ''), n)}</code>`;
  function toolLabel(name, a, running) {
    a = a || {};
    const v = (past, now) => `<b>${running ? now : past}</b>`;
    switch (name) {
      case 'read_file': return `${v('Read', 'Reading')} ${fchip(a.path, 'file', { line: a.start_line })}${a.start_line ? `, lines ${a.start_line} to ${a.end_line || '…'}` : ''}`;
      case 'list_dir': return `${v('Listed', 'Listing')} ${fchip(a.path || '.', 'folder')}`;
      case 'grep_search': return `${v('Searched', 'Searching')} for ${code(a.query)}${a.include_pattern ? ` in ${code(a.include_pattern, 24)}` : ''}`;
      case 'file_search': return `${v('Searched', 'Searching')} for files matching ${code(a.pattern)}`;
      case 'find_symbol': return `${v('Looked up', 'Looking up')} ${code(a.query)}`;
      case 'find_references': return `${v('Found', 'Finding')} references to ${code(a.symbol)}`;
      case 'get_diagnostics': return `${v('Checked', 'Checking')} ${a.path ? `errors in ${fchip(a.path)}` : 'workspace errors'}`;
      case 'get_editor_state': return `${v('Read', 'Reading')} editor state`;
      case 'gather_context': return `${v('Gathered', 'Gathering')} context${a.query ? ` for ${code(a.query)}` : ''}`;
      case 'web_search': return `${v('Searched', 'Searching')} the web for ${code(a.query)}`;
      case 'web_fetch': return `${v('Fetched', 'Fetching')} ${fchip(a.url, 'url')}`;
      case 'browser_screenshot': return `${v('Captured', 'Capturing')} screenshot of ${fchip(a.url, 'url')}${a.mobile ? ' (phone)' : ''}${a.full_page ? ' (full page)' : ''}`;
      case 'open_browser': return `${v('Opened', 'Opening')} ${fchip(a.url, 'url')}`;
      case 'browser_inspect': return `${v('Inspected', 'Inspecting')} ${fchip(a.url, 'url')}${Array.isArray(a.actions) && a.actions.length ? ` after ${a.actions.length} action${a.actions.length === 1 ? '' : 's'}` : ''}`;
      case 'load_skill': return `${v('Loaded', 'Loading')} skill ${code(a.name, 30)}`;
      case 'memory_read': return `${v('Recalled', 'Recalling')} ${code(a.name, 30)} from memory`;
      case 'memory_list': return `${v('Listed', 'Listing')} memory notes`;
      case 'memory_save': return `${v('Saved', 'Saving')} ${code(a.name, 30)} to memory`;
      case 'memory_delete': return `${v('Deleted', 'Deleting')} memory note ${code(a.name, 30)}`;
      case 'manage_todos': return `${v('Updated', 'Updating')} the plan`;
      case 'ask_user': return `${v('Asked', 'Asking')} ${short(a.question, 70)}`;
      case 'open_file': return `${v('Opened', 'Opening')} ${fchip(a.path, 'file', { line: a.line })}`;
      case 'create_directory': return `${v('Created', 'Creating')} folder ${fchip(a.path, 'folder')}`;
      case 'delete_path': return `${v('Deleted', 'Deleting')} ${fchip(a.path)}`;
      case 'run_command': return `${v('Ran', 'Running')} <code class="cmd">${highlight(String(a.command || ''), 'sh')}</code>`;
      case 'edit_file': return `${v('Edited', 'Editing')} ${fchip(a.path)}`;
      case 'write_file': return `${v('Created', 'Creating')} ${fchip(a.path)}`;
      case 'run_subagent': return `${v('Delegated', 'Delegating')} to <b>${esc(a.agent || 'subagent')}</b>`;
      case 'run_parallel_subagents': return `${v('Ran', 'Running')} <b>${(a.tasks || []).length} subagents</b> in parallel`;
      default: return `${v('Ran', 'Running')} ${code(name, 40)} ${short(a, 50)}`;
    }
  }
  function toolIcon(name) {
    if (name === 'read_file' || name === 'get_editor_state') { return I.file; }
    if (name === 'list_dir' || name === 'create_directory') { return I.folder; }
    if (/search|find_|gather/.test(name)) { return I.search; }
    if (/^web|^open_browser|^browser_screenshot$/.test(name)) { return name === 'browser_screenshot' ? I.camera : I.globe; }
    if (name === 'browser_inspect' || name === 'get_diagnostics') { return I.bug; }
    if (name === 'run_command') { return I.term; }
    if (name === 'edit_file' || name === 'write_file') { return I.edit; }
    if (name === 'open_file') { return I.open; }
    if (name.startsWith('memory')) { return I.memory; }
    if (name === 'manage_todos') { return I.plan; }
    if (name === 'ask_user') { return I.ask; }
    if (name === 'delete_path') { return I.trash; }
    if (name.includes('subagent')) { return I.agent; }
    return I.sparkle;
  }
  /** "Thought" rows summarise the reasoning in one line (first sentence), like the verb phrases in VS Code's transcript. */
  function thinkSummary(text) {
    const line = String(text || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find((l) => l.length > 8) || '';
    const sent = (line.match(/^.*?[.!?](\s|$)/) || [line])[0].trim();
    return short(sent, 110);
  }
  function thinkingRow(text, secs, running) {
    const t = stepEl(`thinking ${running ? 'running' : 'ok'}`, running ? '<b>Thinking</b>…' : `<b>Thought</b> ${thinkSummary(text)}`, text, running ? '' : secs ? `${secs}s` : '');
    t.__ico = I.brain; setState(t, running ? 'running' : 'ok');
    return t;
  }

  // Edit cards (inline diff) grouped into one row: "Edited settings.js, 2 other steps +4 −2"
  function editCard(name, a, result) {
    const card = el('div', `card edit ${result ? (result.isError ? 'error' : 'ok') : 'running'}`);
    const isWrite = name === 'write_file';
    const oldT = isWrite ? '' : (a.old_text || ''); const newT = isWrite ? (a.content || '') : (a.new_text || '');
    const d = renderDiff(oldT, newT);
    card.dataset.path = a.path || ''; card.dataset.add = String(d.add); card.dataset.del = String(d.del); card.dataset.write = isWrite ? '1' : '0';
    // The diff body is parsed into the DOM only when the card is expanded (most edits in a long transcript never are).
    card.innerHTML = `<div class="card-head"><span class="ico">${result ? (result.isError ? I.x : I.edit) : I.spin}</span><span class="name" title="${esc(a.path || '')}">${esc(a.path || '')}</span><span class="stat"><span class="a">+${d.add}</span> <span class="d">−${d.del}</span></span><span class="acts"><button data-open="${esc(a.path || '')}" title="Open file">${I.open}</button></span></div><div class="diff collapsed"></div>`;
    card.__diff = d.html;
    card.querySelector('.card-head').onclick = (e) => { if (e.target.closest('[data-open]')) { post({ type: 'openFile', path: e.target.closest('[data-open]').dataset.open }); return; } const diff = card.querySelector('.diff'); if (card.__diff !== undefined) { diff.innerHTML = card.__diff; card.__diff = undefined; } diff.classList.toggle('collapsed'); };
    if (result && result.isError) { const err = el('div', 'term', ''); err.textContent = result.content; card.appendChild(err); }
    return card;
  }
  function editGroup(container, create) {
    let g = container.lastElementChild;
    if (g && g.classList.contains('editgroup')) { return g; }
    if (!create) { return null; }
    g = stepEl('step editgroup running', '<b>Editing</b>…'); g.__ico = I.edit;
    const c = g.querySelector(':scope > .content'); c.className = 'content edits'; c.innerHTML = '';
    container.appendChild(g);
    return g;
  }
  function updateEditGroup(g) {
    const cards = [...g.querySelectorAll(':scope > .content > .card.edit')]; if (!cards.length) { return; }
    const running = cards.some((c) => c.classList.contains('running')); const errs = cards.filter((c) => c.classList.contains('error')).length;
    let add = 0, del = 0; const files = new Set();
    for (const c of cards) { add += Number(c.dataset.add || 0); del += Number(c.dataset.del || 0); files.add(c.dataset.path); }
    const shown = running ? cards.filter((c) => c.classList.contains('running')).pop() : cards[0];
    const verb = running ? (shown.dataset.write === '1' ? 'Creating' : 'Editing') : errs === cards.length ? 'Failed to edit' : shown.dataset.write === '1' && cards.length === 1 ? 'Created' : 'Edited';
    const others = cards.length - 1;
    g.querySelector(':scope > summary .label').innerHTML = `<b>${verb}</b> ${fchip(shown.dataset.path)}${others > 0 ? `, ${others} other step${others > 1 ? 's' : ''}` : ''} <span class="stat"><span class="a">+${add}</span> <span class="d">−${del}</span></span>`;
    g.querySelector(':scope > summary').title = [...files].join('\n');
    setState(g, running ? 'running' : errs ? 'error' : 'ok');
  }

  // Terminal row (run_command): "Ran `cmd`" with exit badge; output expands below.
  function termRow(a, result) {
    const s = stepEl(`step term ${result ? (result.isError ? 'error' : 'ok') : 'running'}`, toolLabel('run_command', a, !result));
    s.__ico = I.term; s.dataset.tool = 'run_command'; s.dataset.args = JSON.stringify(a || {});
    const c = s.querySelector(':scope > .content'); c.className = 'content termout';
    c.innerHTML = `<div class="term-acts"><button data-copy title="Copy command">${I.copy}<span>Command</span></button><button data-copyout title="Copy output">${I.term}<span>Output</span></button></div><pre class="term"></pre>`;
    c.onclick = (e) => { const b = e.target.closest('button'); if (!b) { return; } e.preventDefault(); if (b.hasAttribute('data-copy')) { navigator.clipboard.writeText(a.command || '').then(() => toast('Command copied')); } else { navigator.clipboard.writeText(c.querySelector('.term').textContent).then(() => toast('Output copied')); } };
    setTermRow(s, result ? result.content : '', !result);
    setState(s, result ? (result.isError ? 'error' : 'ok') : 'running');
    return s;
  }
  function setTermRow(node, content, running) {
    const out = String(content || '').replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, '');
    const pre = node.querySelector('.term');
    lazyFill(node, () => { pre.innerHTML = running ? '<span class="muted">Running…</span>' : out ? ansiToHtml(out) : '<span class="muted">(no output)</span>'; });
    const m = /\[exit code (\d+|null)\]/.exec(String(content || ''));
    let n = 0; if (out) { for (let i = -1; (i = out.indexOf('\n', i + 1)) >= 0;) { n++; } n++; }
    const meta = node.querySelector(':scope > summary .meta');
    meta.innerHTML = running ? '' : `${n > 1 ? `<span class="lines">${n} lines</span>` : ''}${m ? `<span class="exit ${m[1] === '0' ? 'good' : 'bad'}">exit ${m[1]}</span>` : ''}`;
  }

  // Subagent pill: "agent · task · model" with its own nested step rows streaming underneath.
  function modelName(ref) { const m = state.models.find((x) => x.id === ref); const n = m ? m.name : ref ? String(ref).split('/').pop() : ''; return n.replace(/[-_:]?(instruct|chat)\b/i, ''); }
  function subagentCard(agent, prompt, model, label) {
    const d = stepEl('subagent running', '');
    d.__ico = I.agent; d.dataset.calls = '0'; d.dataset.pending = '1'; d.dataset.agent = agent || ''; d.dataset.label = label || '';
    const mdl = modelName(model) || (model === null ? '' : currentModel() ? modelName(currentModel().id) : '');
    // Who (agent · model) and what (task) are separate cells so a narrow sidebar can put the task on its own line
    // instead of squeezing it to nothing.
    d.querySelector(':scope > summary .label').innerHTML = `<span class="pill"><span class="pico">${I.agent}</span><b>${esc(agent || 'subagent')}</b>${mdl ? `<i>·</i><span class="model">${esc(mdl)}</span>` : ''}</span>`;
    const task = el('span', 'lane-task', short(label || prompt, 120)); task.title = `${prompt || label || ''}${mdl ? `\nModel: ${mdl}` : ''}`;
    d.querySelector(':scope > summary .label').after(task);
    const c = d.querySelector(':scope > .content'); c.className = 'content subbody'; c.innerHTML = '<div class="subrows"></div>';
    // Per-lane controls: pause/resume or stop just this subagent; the parent keeps going with a "stopped" report.
    const ctl = el('span', 'lanectl', `<button data-c="pause" title="Pause this subagent after its current step">${I.pause}</button><button data-c="stop" title="Stop this subagent">${I.stop}</button>`);
    ctl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) { return; }
      e.preventDefault(); e.stopPropagation();
      const sid = state.session && state.session.id; const childId = d.dataset.childId;
      if (!sid || !childId) { toast('The subagent is still starting — try again in a moment'); return; }
      if (b.dataset.c === 'stop') { post({ type: 'stopChild', sessionId: sid, childId }); return; }
      post({ type: d.classList.contains('paused') ? 'resumeChild' : 'pauseChild', sessionId: sid, childId });
    };
    d.querySelector(':scope > summary .chev').before(ctl);
    d.open = true;
    return d;
  }
  /** Reflects a subagent's pause state on its lane (icon, badge, controls). */
  function laneSetPaused(sid, childId, paused, holding) {
    const live = state.live.get(sid); const d = live && live.subs.get(childId);
    if (!d) { return; }
    d.classList.toggle('paused', paused);
    const b = d.querySelector(':scope > summary .lanectl [data-c="pause"]');
    if (b) { b.innerHTML = paused ? I.play : I.pause; b.title = paused ? (holding ? 'Resume this subagent' : 'Pausing after its current step… click to cancel') : 'Pause this subagent after its current step'; }
    const ico = d.querySelector(':scope > summary .ico'); if (ico && d.classList.contains('running')) { ico.innerHTML = paused ? I.pause : LIVE_DOT; }
    if (state.session && state.session.id === sid) { noteStatus(sid, paused ? `${d.dataset.agent || 'subagent'} ${holding ? 'paused' : 'pausing'}` : `${d.dataset.agent || 'subagent'} resumed`); setStatus(state.status.get(sid)); }
  }
  /** Called when a child agent reports back: fold its rows into "Finished with N steps" and attach the report. */
  function finishSubagent(d, result, error) {
    setState(d, error ? 'error' : 'ok');
    const rows = d.querySelector(':scope > .content > .subrows'); const n = rows ? rows.children.length : 0;
    const body = d.querySelector(':scope > .content');
    const steps = n ? ` ${error ? 'after' : 'with'} ${n} step${n === 1 ? '' : 's'}` : '';
    const fin = stepEl(`step finished ${error ? 'error' : 'ok'}`, `<b>${error ? 'Failed' : 'Finished'}</b>${steps}`); fin.__ico = I.check; setState(fin, error ? 'error' : 'ok');
    const finBody = fin.querySelector(':scope > .content'); finBody.className = 'content subrows-wrap'; finBody.innerHTML = '';
    if (rows && n) { finBody.appendChild(rows); } else { fin.classList.add('nosteps'); }
    body.innerHTML = ''; body.appendChild(fin);
    const text = error || result || '';
    if (text) { const rep = el('details', 'report'); rep.innerHTML = `<summary>${error ? 'Error' : 'Report'}<span class="n">${text.length > 1200 ? `${(text.length / 1000).toFixed(1)}k chars` : ''}</span></summary><div class="doc-body"></div>`; lazyFill(rep, () => { rep.querySelector('.doc-body').innerHTML = error ? `<div class="error-box">${esc(error)}</div>` : renderMarkdown(String(result).slice(0, 12000)); }); body.appendChild(rep); }
    d.querySelector(':scope > summary .meta').textContent = '';
    const ctl = d.querySelector(':scope > summary .lanectl'); if (ctl) { ctl.remove(); }
    d.classList.remove('paused');
    delete d.dataset.pending;
  }
  /** Host step for run_parallel_subagents while live: a queued lane per task becomes the child's pill as it starts. */
  /** Workers card ("4 Working · Stop All"): one row per background worker with its current step; rows expand to the full trace. */
  function subHost(name, a, tasks) {
    const list = tasks || a.tasks || [];
    const n = list.length;
    const d = stepEl('step subhost workers running', `<b>${n} Working</b>`, undefined, '');
    d.__ico = I.layers; d.dataset.total = String(n); d.dataset.done = '0'; d.dataset.tool = name; d.dataset.args = JSON.stringify(a || {});
    const ctl = el('span', 'lanectl host', `<button data-c="stopall" title="Stop every worker in this batch">${I.stop}<span>Stop All</span></button>`);
    ctl.onclick = (e) => { const b = e.target.closest('button'); if (!b) { return; } e.preventDefault(); e.stopPropagation(); const sid = state.session && state.session.id; const live = sid && state.live.get(sid); if (!live) { return; } for (const [childId, node] of live.subs) { if (d.contains(node) && node.classList.contains('running')) { post({ type: 'stopChild', sessionId: sid, childId }); } } };
    d.querySelector(':scope > summary .chev').before(ctl);
    const c = d.querySelector(':scope > .content'); c.className = 'content subs'; c.innerHTML = '';
    for (const t of list) { const lane = el('div', 'lane pending', `<span class="ico">${I.agent}</span><span class="who">${esc(t.agent || 'explore')}</span><span class="what">${short(t.prompt, 90)}</span>`); lane.dataset.what = String(t.prompt || ''); lane.title = String(t.prompt || ''); c.appendChild(lane); }
    d.open = true;
    return d;
  }
  /**
   * Settled Workers card for a fan-out that already finished (transcript rebuild, reopening a chat): the tool's report is
   * split back into one collapsed lane per worker, so the card looks the same as it did live instead of degrading to a
   * plain "Ran 2 subagents in parallel" row. Returns null when the report has no per-worker sections (e.g. an argument error).
   */
  function subHostSettled(name, a, result) {
    const text = String(result.content || '');
    const sections = [];
    for (const chunk of text.split(/\n(?=## )/)) {
      const head = /^## (?:Task \d+ \(([^)]+)\): ?(.*)|\S+\. (.*?) \(([^)]+)\)( — FAILED)?)\s*$/m.exec(chunk);
      if (!head) { continue; }
      const body = chunk.slice(head.index + head[0].length).trim();
      const agent = head[1] || head[4] || 'subagent'; const label = head[2] || head[3] || '';
      const failed = !!head[5] || /^FAILED:|^Subagent failed|^Not run/i.test(body) || /stopped by the user before it finished/i.test(body);
      sections.push({ agent, label, body, failed });
    }
    if (!sections.length) { return null; }
    const failed = sections.filter((s) => s.failed).length;
    const d = stepEl(`step subhost workers ${failed === sections.length ? 'error' : 'ok'}`, `<b>${sections.length} Done</b>${failed ? `<span class="muted"> · ${failed} failed</span>` : ''}`, undefined, '');
    d.__ico = I.layers; setState(d, failed === sections.length ? 'error' : 'ok'); d.dataset.total = String(sections.length); d.dataset.done = String(sections.length); d.dataset.tool = name; d.dataset.args = JSON.stringify(a || {});
    const c = d.querySelector(':scope > .content'); c.className = 'content subs'; c.innerHTML = '';
    for (const s of sections) {
      const card = subagentCard(s.agent, s.label, null, s.label);
      finishSubagent(card, s.failed ? '' : s.body, s.failed ? s.body : '');
      card.open = false; c.appendChild(card);
    }
    const summary = text.split('\n')[0];
    if (/^\d+\/\d+ items completed/.test(summary)) { d.querySelector(':scope > summary .meta').textContent = summary.replace(/\..*$/, ''); }
    d.open = true;
    return d;
  }
  function hostFor(live) { const hosts = [...live.tools.values()].filter((n) => n.classList.contains('subhost') && n.classList.contains('running')); return hosts[hosts.length - 1] || null; }
  function hostProgress(host) {
    const total = Number(host.dataset.total || 1); const done = Number(host.dataset.done || 0);
    const label = host.querySelector(':scope > summary .label'); const meta = host.querySelector(':scope > summary .meta');
    if (host.classList.contains('running')) { if (label) { label.innerHTML = `<b>${Math.max(0, total - done)} Working</b>${done ? `<span class="muted"> · ${done} done</span>` : ''}`; } if (meta) { meta.textContent = ''; } }
  }
  /** Tool label as plain text: drops the language badge inside file chips, then all markup. */
  function plainLabel(html) { return String(html).replace(/<i class="lang[^"]*">[^<]*<\/i>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
  /** Current step of a worker, shown on its row like Cursor's "Exploring challenge codebase structure". */
  function laneNow(sub, text) { const m = sub.querySelector(':scope > summary .meta'); if (!m) { return; } const steps = Number(sub.dataset.calls || 0); m.innerHTML = `<span class="now">${esc(text)}</span>${steps ? `<span class="muted"> · ${steps} step${steps === 1 ? '' : 's'}</span>` : ''}`; }
  /** "2 workers running · 1 done" for the status line while a Workers card is live — the lanes carry each worker's own step. */
  function workersSummary(host) { const total = Number(host.dataset.total || 0); const done = Number(host.dataset.done || 0); const n = Math.max(0, total - done); return `${n} worker${n === 1 ? '' : 's'} running${done ? ` · ${done} done` : ''}`; }
  /** A child agent reported progress: its lane shows the step; the status line shows it directly only when there is no Workers card to show it in. */
  function childStatus(live, sid, childId, agent, text, visible) {
    const sub = live.subs.get(childId);
    if (sub && sub.classList.contains('running') && !sub.classList.contains('paused')) { laneNow(sub, text); }
    const host = sub && sub.closest('.subhost.workers');
    const t = host ? workersSummary(host) : `${agent}: ${text}`;
    noteStatus(sid, t); if (visible) { setStatus(t); }
  }

  function placeTool(container, tc, result) {
    const a = parseArgs(tc.arguments);
    if (tc.name === 'manage_todos') { return null; }
    if (tc.name === 'edit_file' || tc.name === 'write_file') { const g = editGroup(container, true); const c = editCard(tc.name, a, result); c.dataset.callId = tc.id; g.querySelector(':scope > .content').appendChild(c); updateEditGroup(g); return c; }
    if (tc.name === 'run_command') { const s = termRow(a, result); s.dataset.callId = tc.id; container.appendChild(s); return s; }
    if (tc.name === 'run_parallel_subagents' && !result) { const h = subHost(tc.name, a); h.dataset.callId = tc.id; container.appendChild(h); return h; }
    if ((tc.name === 'run_parallel_subagents' || tc.name === 'run_todos_parallel') && result) { const h = subHostSettled(tc.name, a, result); if (h) { h.dataset.callId = tc.id; container.appendChild(h); return h; } }
    if (tc.name === 'run_todos_parallel' && !result) {
      const wanted = Array.isArray(a.ids) ? new Set(a.ids.map(String)) : null;
      const tasks = ((state.session && state.session.todos) || []).filter((t) => t.agent && t.status !== 'done' && (!wanted || wanted.has(String(t.id)))).map((t) => ({ agent: t.agent, prompt: t.title }));
      const h = subHost(tc.name, a, tasks); h.dataset.callId = tc.id; container.appendChild(h); return h;
    }
    if (tc.name === 'run_subagent') { const c = subagentCard(a.agent, a.prompt, a.model); c.dataset.callId = tc.id; if (result) { finishSubagent(c, result.isError ? '' : result.content, result.isError ? result.content : ''); c.open = false; } container.appendChild(c); return c; }
    const s = stepEl(`step ${result ? (result.isError ? 'error' : 'ok') : 'running'}`, toolLabel(tc.name, a, !result));
    s.__ico = toolIcon(tc.name); s.dataset.tool = tc.name; s.dataset.callId = tc.id; s.dataset.args = tc.arguments || '{}';
    toolContent(s, tc.name, a, result ? result.content : '', !result, result);
    if (result && result.image) { s.open = true; }
    setState(s, result ? (result.isError ? 'error' : 'ok') : 'running');
    container.appendChild(s);
    return s;
  }
  function finishTool(node, payload) {
    if (!node) { return; }
    const ok = !payload.isError;
    const secs = payload.cached ? 'cached' : payload.durationMs > 800 ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
    if (node.classList.contains('subhost')) {
      setState(node, ok ? 'ok' : 'error');
      const total = Number(node.dataset.total || 0); const failed = node.querySelectorAll(':scope > .content > .step.subagent.error').length;
      node.querySelector(':scope > summary .label').innerHTML = total ? `<b>${total} Done</b>${failed ? `<span class="muted"> · ${failed} failed</span>` : ''}` : toolLabel(node.dataset.tool, parseArgs(node.dataset.args || '{}'), false);
      node.querySelector(':scope > summary .meta').textContent = secs;
      const ctl = node.querySelector(':scope > summary .lanectl.host'); if (ctl) { ctl.remove(); }
      for (const lane of node.querySelectorAll(':scope > .content > .lane.pending')) { lane.className = 'lane ' + (ok ? 'skipped' : 'error'); }
      for (const sub of node.querySelectorAll(':scope > .content > .step.subagent.running')) { finishSubagent(sub, '', 'Cancelled'); }
      if (payload.content && !node.querySelector(':scope > .content > .step')) { const c = node.querySelector(':scope > .content'); c.className = 'content doc'; c.innerHTML = `<div class="doc-body">${renderMarkdown(String(payload.content).slice(0, 8000))}</div>`; }
      return;
    }
    if (node.classList.contains('subagent')) {
      // Normally subagent_end already folded the rows; this covers cancellation and history replay.
      if (node.classList.contains('running')) { finishSubagent(node, ok ? payload.content : '', ok ? '' : payload.content || 'Failed'); }
      return;
    }
    if (node.classList.contains('card')) {
      node.classList.remove('running'); node.classList.add(ok ? 'ok' : 'error');
      const ico = node.querySelector('.card-head .ico'); if (ico) { ico.innerHTML = ok ? I.edit : I.x; }
      if (!ok) { const err = el('div', 'term', ''); err.textContent = payload.content || ''; node.appendChild(err); }
      const g = node.closest('.editgroup'); if (g) { updateEditGroup(g); }
      return;
    }
    setState(node, ok ? 'ok' : 'error');
    const args = parseArgs(node.dataset.args || '{}');
    node.querySelector(':scope > summary .label').innerHTML = toolLabel(node.dataset.tool, args, false);
    if (node.dataset.tool === 'run_command') { setTermRow(node, payload.content || '', false); if (!ok) { node.open = true; } return; }
    toolContent(node, node.dataset.tool, args, payload.content || '', false, payload);
    if (payload.data && payload.data.image) { node.open = true; }
    node.querySelector(':scope > summary .meta').textContent = secs;
  }

  // ------------------------------------------------------------------ transcript rendering
  function userTurn(m, index) {
    const d = el('div', 'turn user');
    d.dataset.index = index;
    const atts = [];
    const text = m.content
      .replace(/<attachment[^>]*path="([^"]+)"[^>]*>[\s\S]*?<\/attachment>\s*/g, (_, p) => { atts.push(p); return ''; })
      .replace(/<(workspace_tree|problems|git|open_editors|directory|terminal_output)[^>]*>[\s\S]*?<\/\1>\s*/g, (_, t) => { atts.push('@' + (t === 'workspace_tree' ? 'workspace' : t === 'open_editors' ? 'editors' : t === 'terminal_output' ? 'terminal' : t)); return ''; })
      .replace(/\n\n\[\d+ images? attached\]$/, '');
    const act = el('div', 'actions', `<button data-act="copy" title="Copy">${I.copy}</button>${index !== undefined ? `<button data-act="restore" title="Restore checkpoint: revert files changed since this message and edit it">${I.restore}<span>Restore checkpoint</span></button>` : ''}`);
    act.onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) { return; } if (b.dataset.act === 'copy') { navigator.clipboard.writeText(text).then(() => toast('Copied')); } if (b.dataset.act === 'restore' && state.session) { post({ type: 'restoreCheckpoint', sessionId: state.session.id, messageIndex: index }); } };
    d.appendChild(act);
    if (atts.length) { d.appendChild(el('div', 'att', atts.map((a) => `<span class="chip">${I.file}<span>${esc(a)}</span></span>`).join(''))); }
    if (m.images && m.images.length) { d.appendChild(el('div', 'imgs', m.images.map((b64, k) => `<img src="data:image/png;base64,${b64}" alt="Image ${k + 1} of ${m.images.length}" title="Click to enlarge">`).join(''))); }
    d.appendChild(el('div', 'utext', inline(text)));
    return d;
  }
  function assistantTurn(m, results) {
    const d = el('div', 'turn assistant');
    const steps = el('div', 'steps');
    if (m.thinking) { steps.appendChild(thinkingRow(m.thinking, 0, false)); }
    for (const tc of m.toolCalls || []) { placeTool(steps, tc, results.get(tc.id) || { content: '(no result)', isError: false }); }
    if (steps.children.length) { d.appendChild(steps); }
    if (m.content && m.content.trim()) {
      const body = el('div', 'body', renderMarkdown(m.content)); d.appendChild(body);
      // Long or structured answers read better in the dedicated Markdown reader.
      const long = m.content.length > 600 || /^#{1,3}\s/m.test(m.content) || /^\|.*\|$/m.test(m.content);
      const act = el('div', 'actions', `<button data-act="copy" title="Copy response">${I.copy}</button>${long ? `<button data-act="doc" title="Open as document in the Markdown reader">${I.open}<span>Open as document</span></button>` : ''}`);
      act.onclick = (e) => { const b = e.target.closest('[data-act]'); if (!b) { return; } if (b.dataset.act === 'doc') { post({ type: 'openMarkdown', text: m.content, title: state.session && state.session.title }); return; } navigator.clipboard.writeText(m.content).then(() => toast('Copied')); };
      d.appendChild(act);
    }
    return d.children.length ? d : null;
  }
  function renderSession() {
    const s = state.session;
    // Same-session refreshes (mode/model change, compaction, restore) must not lose the reader's place.
    const same = s && els.messages.dataset.sid === s.id;
    const m = els.messages;
    const stick = !same || m.scrollHeight - m.scrollTop - m.clientHeight < 160;
    const y = m.scrollTop;
    const open = same ? [...m.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0) : [];
    els.messages.innerHTML = '';
    els.messages.dataset.sid = s ? s.id : '';
    if (!s) { return; }
    syncMode(); syncModel(); syncSkills(); updateCtx();
    if (!s.messages.length) { renderEmpty(); }
    const results = new Map();
    for (const m of s.messages) {
      if (m.role === 'tool' && m.toolCallId) { results.set(m.toolCallId, { content: m.content, isError: /^(Tool .* failed|User declined|Error|Cancelled|old_text not found)/i.test(m.content) || /\[exit code [1-9]/.test(m.content) }); }
      // Images captured by tools travel in a user-role carrier message; attach them to the originating step instead of showing a bubble.
      if (m.role === 'user' && m.meta && m.meta.toolImages && m.images) { m.meta.toolImages.forEach((id, k) => { const r = results.get(id) || { content: '', isError: false }; r.image = { data: m.images[k], mime: 'image/png' }; results.set(id, r); }); }
    }
    s.messages.forEach((m, i) => {
      if (m.role === 'user' && m.meta && m.meta.hidden && m.meta.nudge) {
        // Replay of a nudge: the previous reply is kept but marked as retracted, exactly as it looked live.
        const prev = els.messages.lastElementChild;
        if (prev && prev.classList.contains('assistant')) { const bodies = prev.querySelectorAll(':scope > .body'); const last = bodies[bodies.length - 1]; if (last) { last.classList.add('retracted'); } prev.appendChild(nudgeNote(m.meta.nudge)); }
        return;
      }
      if (m.role === 'tool' || (m.role === 'user' && m.meta && (m.meta.toolImages || m.meta.hidden))) { return; }
      if (m.meta && m.meta.summary) { const n = el('div', 'turn'); const det = stepEl('ok', 'Conversation compacted to free context', m.content.replace(/<\/?conversation_summary>/g, '').replace(/Continue from here.*$/s, '').trim()); det.querySelector('.ico').innerHTML = I.list; n.appendChild(det); els.messages.appendChild(n); return; }
      if (m.role === 'user' && m.meta && m.meta.steer) {
        const prev = els.messages.lastElementChild;
        const row = steerRow(m.content, m.images, m.meta.steerId, false);
        if (prev && prev.classList.contains('assistant')) { prev.appendChild(row); } else { const t = el('div', 'turn assistant'); t.appendChild(row); els.messages.appendChild(t); }
        return;
      }
      const node = m.role === 'user' ? userTurn(m, i) : assistantTurn(m, results);
      if (!node) { return; }
      // Consecutive assistant messages (tool calls, then the answer) form one turn, exactly as they streamed live —
      // so settling the transcript at the end of a turn does not shift the layout.
      const prev = els.messages.lastElementChild;
      if (m.role !== 'user' && prev && prev.classList.contains('assistant')) {
        const act = node.querySelector(':scope > .actions');
        if (act) { for (const old of prev.querySelectorAll(':scope > .actions')) { old.remove(); } }
        while (node.firstChild) { prev.appendChild(node.firstChild); }
        return;
      }
      els.messages.appendChild(node);
    });
    // Plan mode finished with a checklist: the "Prepared plan" card — title, summary, todos and one-click Build.
    if (s.mode === 'plan' && s.plan && (s.todos || []).length && !state.running.has(s.id)) { els.messages.appendChild(planCard(s)); }
    const live = state.live.get(s.id);
    if (live) { els.messages.appendChild(live.root); if (live.dirty) { scheduleRender(live); } }
    setRunning(state.running.has(s.id) || state.pendingSend.has(s.id));
    if (state.running.has(s.id)) { setStatus(state.status.get(s.id) || 'Working…'); } else if (state.pendingSend.has(s.id)) { setStatus('Sending…'); }
    if (open.length) { const all = m.querySelectorAll('details'); for (const i of open) { if (all[i]) { all[i].open = true; } } }
    if (stick) { scrollToBottom(true); } else { m.scrollTop = y; }
    updateJump();
  }
  function planCard(s) {
    const todos = s.todos || [];
    const d = el('div', 'turn assistant plancard');
    const file = s.plan.file ? s.plan.file.split('/').pop() : '';
    d.innerHTML = `<div class="plan-kicker">Prepared plan</div>
      <div class="plan">
        <div class="plan-file">${I.plan}<span class="name" title="${esc(s.plan.file || '')}">${esc(file || 'plan')}</span><span class="spacer"></span>${s.plan.file ? `<button data-a="open" title="Open the plan file">${I.open}</button>` : ''}<button data-a="copy" title="Copy the checklist">${I.copy}</button></div>
        <h3>${esc(s.plan.title)}</h3>
        ${s.plan.summary ? `<p>${esc(s.plan.summary)}</p>` : ''}
        <button class="link" data-a="detail">Read detailed plan</button>
        <div class="plan-todos"><div class="n">${todos.length} todo${todos.length === 1 ? '' : 's'}</div>${todos.map((t) => `<div class="todo ${t.status}"><i></i><span>${esc(t.title)}</span>${t.agent ? `<em>${esc(t.agent)}</em>` : ''}</div>`).join('')}</div>
        <div class="plan-foot"><span class="hint">Build switches to Agent mode and runs the checklist — independent items in parallel.</span><button class="btn build" data-a="build">Build <kbd>⌘↩</kbd></button></div>
      </div>`;
    d.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) { return; }
      if (b.dataset.a === 'build') { post({ type: 'buildPlan', sessionId: s.id }); b.disabled = true; b.textContent = 'Building…'; }
      else if (b.dataset.a === 'open' && s.plan.file) { post({ type: 'openFile', path: s.plan.file }); }
      else if (b.dataset.a === 'copy') { navigator.clipboard.writeText(todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')).then(() => toast('Checklist copied')); }
      else if (b.dataset.a === 'detail') { const prev = d.previousElementSibling; if (prev && prev.classList.contains('assistant')) { prev.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }
    };
    return d;
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
    if (!state.models.length && !state.modelsLoading) {
      const n = el('div', 'notice', `<b>No local models found.</b><br>LocalPilot can start or install <b>Ollama</b> and download a starter coder model sized for this machine. Or start <b>LM Studio</b>, <b>llama.cpp</b> or <b>vLLM</b> yourself and refresh.<div class="row"><button class="btn primary" data-a="setup">Set up automatically</button><button class="btn" data-a="refresh">Refresh models</button><button class="btn" data-a="settings">Manage models</button></div>`);
      n.onclick = (e) => { const a = e.target.dataset.a; if (a === 'setup') { state.modelsRequested = true; post({ type: 'autoSetupModels' }); toast('Setting up models…'); } if (a === 'refresh') { state.modelsRequested = true; post({ type: 'refreshModels' }); toast('Looking for model servers…'); } if (a === 'settings') { post({ type: 'openSettings', section: 'models' }); } };
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
      live = { sid: sessionId, root, steps, body, text: '', thinking: '', thinkingEl: null, thinkStart: 0, tools: new Map(), subs: new Map(), subTools: new Map(), timer: 0 };
      state.live.set(sessionId, live);
      if (state.session && state.session.id === sessionId) { els.messages.appendChild(root); }
    }
    return live;
  }
  function clearTyping(live) { const t = live.body.querySelector('.typing'); if (t) { live.body.innerHTML = ''; } }
  // Between the last tool result and the model's next token nothing moves; show the typing dots again so the
  // turn never looks stalled.
  function showTyping(live) {
    if (live.text.trim() || live.thinkingEl) { return; }
    for (const n of live.tools.values()) { if (n.classList.contains('running')) { return; } }
    for (const c of live.subs.values()) { if (c.classList.contains('running')) { return; } }
    if (!live.body.querySelector('.typing')) { live.body.innerHTML = '<span class="typing" title="Thinking…"><i></i><i></i><i></i></span>'; }
  }
  function rotateBody(live) {
    // Text that streamed before a tool call stays above the next steps block, in order.
    clearTyping(live);
    if (live.text.trim()) {
      live.body.innerHTML = renderMarkdown(live.text);
      live.steps = el('div', 'steps'); live.root.appendChild(live.steps);
      live.body = el('div', 'body'); live.root.appendChild(live.body);
      live.text = ''; live.settled = null; live.dirty = false;
    }
  }
  function finishThinking(live) {
    if (!live.thinkingEl) { return; }
    const secs = Math.max(1, Math.round((Date.now() - live.thinkStart) / 1000));
    setState(live.thinkingEl, 'ok');
    live.thinkingEl.querySelector(':scope > summary .label').innerHTML = `<b>Thought</b> ${thinkSummary(live.thinking)}`;
    live.thinkingEl.querySelector(':scope > summary .meta').textContent = `${secs}s`;
    live.thinkingEl = null;
  }
  /** Inline note under a retracted reply: why the model is being asked to act instead of the turn ending. */
  function nudgeNote(reason) {
    const why = {
      claimed: 'The reply said this was done, but no tool ran — asking the model to actually do it.',
      announced: 'The reply announced an action without taking it — asking the model to do it.',
      shown: 'The tool call was written as text instead of being made — asking the model to call it.',
      stale: 'The workers already finished — asking the model to report their results instead of re-announcing the hand-off.',
      malformed: 'The tool call could not be parsed — asking the model to resend it.',
    }[reason] || 'Nothing was executed — asking the model to act or explain.';
    return el('div', 'note nudge', `${I.warn}<span>${esc(why)}</span>`);
  }
  // Scrolls only when the event belongs to the transcript on screen — background agents must not move it.
  // Coalesced to one layout read per frame: a worker batch can emit hundreds of events in a burst, and a forced
  // layout per event against a long transcript is what froze the view for seconds.
  let followPending = false;
  const followLive = (live) => {
    if (!(state.session && state.session.id === live.sid) || followPending) { return; }
    followPending = true;
    requestAnimationFrame(() => { followPending = false; scrollToBottom(false); updateJump(); });
  };
  // "Jump to latest": shown when the reader has scrolled up while the active agent is still producing output.
  const jump = el('button', 'jump hidden', `${I.chev}<span>Jump to latest</span>`);
  jump.title = 'Scroll to the newest message'; jump.type = 'button';
  $('app').appendChild(jump);
  jump.onclick = () => { scrollToBottom(true); updateJump(); els.input.focus(); };
  function updateJump() {
    const m = els.messages;
    const away = !stickToBottom;
    const busy = state.session && (state.running.has(state.session.id) || state.live.has(state.session.id));
    const show = !!(away && busy);
    jump.classList.toggle('hidden', !show);
    if (show) { jump.style.top = `${Math.round(m.getBoundingClientRect().bottom - 40)}px`; }
  }
  els.messages.addEventListener('scroll', () => { noteScroll(); updateJump(); }, { passive: true });
  window.addEventListener('resize', () => { noteScroll(); updateJump(); });
  function scheduleRender(live) {
    // Agents streaming in other tabs render nothing until their tab is shown — a live turn is marked dirty instead.
    if (!state.session || state.session.id !== live.sid) { live.dirty = true; return; }
    if (live.timer) { return; }
    live.timer = setTimeout(() => {
      live.timer = 0; finishThinking(live);
      const t0 = performance.now();
      renderStream(live);
      // Long answers re-render slower; back off so the webview never spends most of its time re-rendering.
      live.interval = Math.min(400, Math.max(50, Math.round((performance.now() - t0) * 4)));
      live.dirty = false; followLive(live);
    }, live.interval || 50);
  }
  /** Index just past the last block boundary (blank line outside a code fence, next line not indented) — text before it is final. */
  function settledCut(text) {
    const lines = text.split('\n'); let fence = null; let pos = 0; let cut = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      const f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) { if (!fence) { fence = f[1]; } else if (f[1][0] === fence[0] && f[1].length >= fence.length) { fence = null; } }
      pos += line.length + 1;
      if (!fence && line.trim() === '' && i + 1 < lines.length - 1 && !/^\s/.test(lines[i + 1])) { cut = pos; }
    }
    return cut;
  }
  /**
   * Streaming markdown: blocks that can no longer change are rendered once and *stay in the DOM*; each tick only
   * re-renders the open tail. (Rebuilding the whole reply's HTML every tick made a long answer re-parse hundreds of
   * kilobytes of markup several times a second — the stream dropped to a few frames per second.)
   */
  function renderStream(live) {
    const text = live.text;
    const reset = !live.settled || live.settled.len > text.length || !text.startsWith(live.settled.text);
    if (reset) { live.settled = { len: 0, text: '', html: '' }; }
    if (reset || !live.tailEl || live.tailEl.parentNode !== live.body) {
      // (Re)build the two-part body; anything else in it (typing dots) goes.
      live.body.innerHTML = '<div class="settled"></div><div class="tail"></div>';
      live.settledEl = live.body.firstElementChild; live.tailEl = live.body.lastElementChild;
      if (live.settled.html) { live.settledEl.innerHTML = live.settled.html; }
    }
    const cut = settledCut(text);
    if (cut > live.settled.len) {
      const html = renderMarkdown(text.slice(live.settled.len, cut));
      live.settled.html += html; live.settled.len = cut; live.settled.text = text.slice(0, cut);
      live.settledEl.insertAdjacentHTML('beforeend', html);
    }
    live.tailEl.innerHTML = renderMarkdown(text.slice(live.settled.len)) + '<span class="caret"></span>';
  }
  function finishLive(sessionId) {
    const live = state.live.get(sessionId);
    if (!live) { return; }
    clearTimeout(live.timer);
    clearTyping(live);
    live.body.innerHTML = renderMarkdown(live.text);
    live.root.classList.remove('live');
    for (const node of [...live.subTools.values(), ...live.tools.values()]) { if (node.classList.contains('running')) { finishTool(node, { isError: true, content: 'Cancelled' }); } }
    for (const c of live.subs.values()) { if (c.classList.contains('running')) { finishSubagent(c, '', 'Cancelled'); } }
    finishThinking(live);
    state.live.delete(sessionId);
  }
  function handleEvent(e) {
    const sid = e.sessionId; const live = ensureLive(sid); const visible = state.session && state.session.id === sid;
    switch (e.type) {
      case 'assistant_delta': live.text += e.payload; scheduleRender(live); break;
      case 'steer': {
        // Queued rows become part of the transcript; what streams next belongs after them.
        rotateBody(live);
        for (const id of (e.payload && e.payload.ids) || []) { const row = live.root.querySelector(`.steer[data-steer-id="${CSS.escape(id)}"]`); if (row) { row.classList.remove('queued'); row.querySelector('.badge').textContent = 'added'; live.root.appendChild(row); } }
        if (live.root.lastElementChild !== live.body) { live.steps = el('div', 'steps'); live.root.appendChild(live.steps); live.body = el('div', 'body'); live.root.appendChild(live.body); }
        showTyping(live); break;
      }
      case 'thinking_delta':
        live.thinking += e.payload; clearTyping(live);
        if (!live.thinkingEl) { live.thinkStart = Date.now(); live.thinkingEl = thinkingRow('', 0, true); live.steps.appendChild(live.thinkingEl); }
        live.thinkingEl.querySelector(':scope > .content').textContent = live.thinking;
        live.thinkingEl.querySelector(':scope > summary .meta').textContent = `${Math.round((Date.now() - live.thinkStart) / 1000)}s`;
        break;
      case 'status':
        if (e.payload && typeof e.payload === 'object' && e.payload.childId) {
          const d = e.payload.data;
          const t = e.payload.inner === 'status' && typeof d === 'string' ? d : e.payload.inner === 'tool_start' && d ? d.name : '';
          if (t) { childStatus(live, sid, e.payload.childId, e.payload.agent, t, visible); }
        } else { const t = typeof e.payload === 'string' ? e.payload : ''; noteStatus(sid, t); if (visible) { setStatus(t); } }
        break;
      case 'tool_start': {
        finishThinking(live);
        if (e.payload && e.payload.childId) {
          // A subagent's tool call: render it as a nested row under that agent's pill.
          const d = e.payload.data || {}; const sub = live.subs.get(e.payload.childId);
          if (sub && d.name !== 'manage_todos') {
            const rows = sub.querySelector(':scope > .content > .subrows') || sub.querySelector('.subrows');
            if (rows) { const node = placeTool(rows, { id: d.id, name: d.name, arguments: JSON.stringify(d.args || {}) }, null); if (node) { live.subTools.set(`${e.payload.childId}:${d.id}`, node); } sub.dataset.calls = String(Number(sub.dataset.calls || 0) + 1); }
          }
          childStatus(live, sid, e.payload.childId, e.payload.agent, plainLabel(toolLabel(d.name, d.args || {}, true)), visible);
          followLive(live);
          break;
        }
        rotateBody(live);
        const node = placeTool(live.steps, { id: e.payload.id, name: e.payload.name, arguments: JSON.stringify(e.payload.args || {}) }, null);
        if (node) { live.tools.set(e.payload.id, node); }
        noteStatus(sid, toolLabel(e.payload.name, e.payload.args || {}, true).replace(/<[^>]+>/g, ''));
        followLive(live);
        break;
      }
      case 'tool_end':
        if (e.payload && e.payload.childId) { const d = e.payload.data || {}; finishTool(live.subTools.get(`${e.payload.childId}:${d.id}`), d); break; }
        finishTool(live.tools.get(e.payload.id), e.payload); showTyping(live); break;
      case 'subagent_start': {
        rotateBody(live);
        // Prefer the pill created at run_subagent's tool_start (same agent, not yet claimed), else a lane in a parallel host, else a new pill.
        let c = [...live.tools.values()].find((n) => n.classList.contains('subagent') && n.dataset.pending === '1' && !n.dataset.childId && n.dataset.agent === e.payload.agent);
        if (c) { if (e.payload.model) { const m = c.querySelector('.pill .model'); const name = modelName(e.payload.model); if (m) { m.textContent = name; } else if (name) { c.querySelector('.pill').insertAdjacentHTML('beforeend', `<i>·</i><span class="model">${esc(name)}</span>`); } } }
        else {
          c = subagentCard(e.payload.agent, e.payload.prompt, e.payload.model, e.payload.label);
          const host = hostFor(live);
          if (host) {
            // Claim the queued lane for this exact checklist item first, then any lane of the same agent, then the next free one.
            const lanes = [...host.querySelectorAll(':scope > .content > .lane.pending')];
            const byLabel = e.payload.label && lanes.find((l) => l.dataset.what === e.payload.label);
            const lane = byLabel || lanes.find((l) => l.querySelector('.who').textContent === e.payload.agent) || lanes[0];
            if (lane) { lane.replaceWith(c); } else { host.querySelector(':scope > .content').appendChild(c); }
          } else { live.steps.appendChild(c); }
        }
        c.dataset.childId = e.payload.childId; live.subs.set(e.payload.childId, c);
        if (c.closest('.subhost.workers')) { c.open = false; }
        childStatus(live, sid, e.payload.childId, e.payload.agent, 'starting…', visible);
        followLive(live);
        break;
      }
      case 'subagent_end': {
        const c = live.subs.get(e.payload.childId);
        if (c) {
          for (const [k, n] of live.subTools) { if (k.startsWith(`${e.payload.childId}:`) && n.classList.contains('running')) { finishTool(n, { isError: true, content: 'Cancelled' }); } }
          finishSubagent(c, e.payload.result || '', e.payload.error || '');
          const host = c.parentElement && c.parentElement.closest('.subhost'); if (host) { host.dataset.done = String(Number(host.dataset.done || 0) + 1); hostProgress(host); }
          const t = host && host.classList.contains('running') && Number(host.dataset.done) < Number(host.dataset.total) ? workersSummary(host) : 'Thinking…';
          noteStatus(sid, t); if (visible) { setStatus(t); }
        }
        showTyping(live); break;
      }
      case 'model_request': state.modelOf.set(sid, e.payload.model); if (e.payload.queued) { noteStatus(sid, `Waiting for ${e.payload.name} — busy with ${e.payload.queued} other chat${e.payload.queued === 1 ? '' : 's'}…`); } scheduleBg(); break;
      case 'todos': if (state.session && state.session.id === sid) { state.session.todos = e.payload || []; renderTasks(); } break;
      case 'nudge': {
        // The reply so far claimed or announced an action that never happened. It stays, dimmed and labelled, and whatever
        // the model streams next starts in a fresh body — never glued onto the retracted sentence.
        const prev = live.text.trim() ? live.body : null;
        rotateBody(live);
        if (prev) { prev.classList.add('retracted'); }
        live.root.insertBefore(nudgeNote(e.payload && e.payload.reason), live.body);
        const st = 'Nothing ran yet — asking the model to act…'; noteStatus(sid, st); if (visible) { setStatus(st); }
        showTyping(live); followLive(live);
        break;
      }
      case 'compaction': rotateBody(live); live.root.insertBefore(el('div', 'note', `Context compacted: ${e.payload.before.toLocaleString()} → ${e.payload.after.toLocaleString()} tokens (${e.payload.removed} messages summarised)`), live.body); break;
      case 'skill_suggestions': { rotateBody(live); const n = skillSuggestionNote(e.payload || {}); if (n) { live.root.insertBefore(n, live.body); } break; }
      case 'clarify': rotateBody(live); live.root.insertBefore(el('div', 'note', `Request looks ambiguous (${esc((e.payload && e.payload.reasons || []).join('; '))}) — interpreting it from the editor, open files, errors and git changes.`), live.body); break;
      case 'retry': { rotateBody(live); const why = { empty: 'the model returned nothing', stall: 'the model stopped responding', network: 'the connection to the model server dropped', server: 'the model server returned an error', ratelimit: 'the server is rate limiting' }[e.payload && e.payload.reason] || 'a transient error'; live.root.insertBefore(el('div', 'note retry', `${I.spin} Retrying (${esc(e.payload.attempt)}/${esc(e.payload.max)}) — ${esc(why)}.`), live.body); noteStatus(sid, `Retrying (${e.payload.attempt}/${e.payload.max})…`); if (visible) { setStatus(`Retrying (${e.payload.attempt}/${e.payload.max})…`); } break; }
      case 'error': { rotateBody(live); const box = el('div', 'error-box', `<span class="msg">${esc(String(e.payload))}</span>`); const b = el('button', 'btn ghost sm retry-btn', `${I.spin}Retry`); b.title = 'Send the last message again'; b.onclick = () => { if (state.running.has(sid)) { return; } post({ type: 'retry', sessionId: sid }); }; box.appendChild(b); live.root.insertBefore(box, live.body); break; }
      case 'turn_end': noteStatus(sid, 'Finishing…'); if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); } break;
    }
  }

  /** Chips for skills matching the request (click → prefill `/skill name`), a catalog skill installed/offered for it, and a recurring request type worth saving as a skill. */
  function skillSuggestionNote(p) {
    const skills = p.skills || []; const preloaded = p.preloaded || []; const create = p.create; const installed = p.installed; const available = p.available;
    if (!skills.length && !preloaded.length && !create && !installed && !available) { return null; }
    const n = el('div', 'note skills');
    if (installed) {
      const row = el('div', 'learn');
      row.appendChild(el('span', 'lbl', `${I.download || ''}Installed “${esc(installed.name)}” from ${esc(installed.repo)} for this request.`));
      n.appendChild(row);
    }
    if (preloaded.length) {
      const REASON = { forced: 'you asked for it', pinned: 'pinned to this chat', installed: 'just installed', match: 'matches the request' };
      n.appendChild(el('span', 'lbl', `Using skill${preloaded.length === 1 ? '' : 's'}:`));
      for (const s of preloaded) {
        const chip = el('span', 'chip on', `${I.check || ''}${esc(s.name)}${s.reason && s.reason !== 'match' ? `<small> · ${esc(REASON[s.reason] || s.reason)}</small>` : ''}`);
        chip.title = `The full instructions of “${s.name}” were loaded into this request (${REASON[s.reason] || s.reason}). Change how this chat uses skills with the Skills button below the composer.`;
        n.appendChild(chip);
      }
    }
    if (skills.length) {
      n.appendChild(el('span', 'lbl', preloaded.length ? 'May also apply:' : 'Skills that may apply:'));
      for (const s of skills) {
        const chip = el('button', 'chip', `${I.book || ''}${esc(s.name)}`); chip.title = `${s.description || ''}\n\nThe agent decides whether to load this skill. Click to force it: /skill ${s.name} <task>`;
        chip.onclick = () => { els.input.value = `/skill ${s.name} ${els.input.value.replace(/^\/skill \S+\s*/, '')}`; autoGrow(); updateSendEnabled(); els.input.focus(); };
        n.appendChild(chip);
      }
    }
    if (available) {
      const wrap = el('div', 'learn');
      wrap.appendChild(el('span', 'lbl', `The “${esc(available.name)}” skill from ${esc(available.repo)} matches this request but is not installed.`));
      const get = el('button', 'chip brand', `${I.download || ''}Install “${esc(available.name)}”`); get.title = `${available.description || ''}\n\nDownloads the skill into your skills folder (localpilot.skills.autoInstallScope). Switch this chat to “Auto” in the Skills menu to skip this step.`;
      get.onclick = () => { post({ type: 'installCatalogSkill', name: available.name, repo: available.repo }); get.disabled = true; get.textContent = 'Installing…'; };
      const no = el('button', 'chip', 'Not now'); no.title = 'Do not offer this skill again'; no.onclick = () => { post({ type: 'dismissCatalogSkill', name: available.name }); wrap.remove(); if (!skills.length && !create && !installed) { n.remove(); } };
      wrap.appendChild(get); wrap.appendChild(no); n.appendChild(wrap);
    }
    if (create) {
      const wrap = el('div', 'learn');
      wrap.appendChild(el('span', 'lbl', `Requests like this have come up ${create.count}× with no skill covering them.`));
      const mk = el('button', 'chip brand', `${I.plus || ''}Create “${esc(create.slug)}” skill`); mk.title = 'Prefills a prompt asking the agent to write .localpilot/skills/' + create.slug + '/SKILL.md from what worked here';
      mk.onclick = () => { els.input.value = `Create a reusable skill at .localpilot/skills/${create.slug}/SKILL.md for requests like: ${(create.samples || []).map((x) => `"${x}"`).join(', ')}. Use front-matter (name, description with quoted trigger phrases) and a step-by-step body based on how we handled it in this project, then reload skills.`; autoGrow(); updateSendEnabled(); els.input.focus(); };
      const no = el('button', 'chip', 'Not now'); no.onclick = () => { post({ type: 'dismissSkillTopic', topic: create.topic }); wrap.remove(); if (!skills.length) { n.remove(); } };
      wrap.appendChild(mk); wrap.appendChild(no); n.appendChild(wrap);
    }
    return n;
  }

  // ------------------------------------------------------------------ composer state
  function setStatus(text) { els.statusText.textContent = text || ''; els.status.classList.toggle('hidden', !text); }
  function setRunning(running) { els.send.classList.toggle('hidden', running); els.stop.classList.toggle('hidden', !running); els.pause.classList.toggle('hidden', !running); els.progress.classList.toggle('hidden', !running); if (!running) { setStatus(''); } syncPause(); updateSendEnabled(); updateJump(); }
  function updateSendEnabled() { els.send.disabled = !els.input.value.trim() && !state.images.length; }
  /** Pause button, progress bar and placeholder follow the active session's pause state. */
  function syncPause() {
    const sid = state.session && state.session.id; const p = (sid && state.paused.get(sid)) || { paused: false, holding: false };
    els.pause.classList.toggle('on', p.paused);
    els.pause.innerHTML = p.paused ? I.play : I.pause;
    els.pause.title = p.paused ? (p.holding ? 'Resume (⌥Esc)' : 'Pausing after the current step… click to cancel') : 'Pause after the current step (⌥Esc)';
    els.progress.classList.toggle('paused', p.paused);
    document.body.classList.toggle('paused', !!(sid && state.running.has(sid) && p.paused));
    syncPlaceholder();
  }
  function togglePause() { if (!state.session || !state.running.has(state.session.id)) { return; } const p = state.paused.get(state.session.id); post({ type: p && p.paused ? 'resume' : 'pause', sessionId: state.session.id }); }
  function updateCtx() {
    const s = state.session; if (!s) { return; }
    const model = state.models.find((m) => m.id === s.model) || state.models.find((m) => m.id === state.defaultModel) || state.models[0];
    const win = model ? model.contextWindow : 32768; const used = s.contextTokens || 0; const pct = Math.min(100, Math.round((used / win) * 100));
    els.ctx.style.setProperty('--pct', pct); els.ctx.querySelector('.txt').textContent = `${pct}%`;
    els.ctx.title = `Context: ${used.toLocaleString()} / ${win.toLocaleString()} tokens${s.compactions ? ` · compacted ${s.compactions}×` : ''}\nClick to compact now`;
    els.ctx.className = `ctx ${pct > 85 ? 'danger' : pct > 65 ? 'warn' : ''}`;
  }
  function syncMode() { syncPlaceholder(); const m = MODES[(state.session && state.session.mode) || 'agent']; els.modeLabel.textContent = m.label; els.modeIcon.innerHTML = m.icon; }
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
  // ------------------------------------------------------------------ chat tabs (multitasking)
  // Every chat is an independent agent. Tabs keep a stable, browser-like order (pinned first, then creation order) so
  // nothing jumps around while agents start and finish; running chats are always kept open as tabs.
  const MAX_TABS = 12;
  function summaryOf(s) { return { id: s.id, title: s.title || 'New chat', mode: s.mode, messageCount: s.messages ? s.messages.length : 0, updatedAt: s.updatedAt || Date.now(), createdAt: s.createdAt || 0, pinned: s.pinned }; }
  function activeId() { return state.loadingTab || (state.session && state.session.id) || state.activeHint; }
  function tabList() {
    const active = activeId();
    const all = state.sessions.slice();
    if (state.session && !all.some((s) => s.id === state.session.id)) { all.push(summaryOf(state.session)); }
    // Until 'init' arrives every chat is a tab; afterwards the open set is explicit (and persisted across view reloads).
    const open = state.openTabs || new Set(all.map((s) => s.id));
    for (const s of all) { if (s.id === active || state.running.has(s.id) || state.attention.has(s.id) || state.unread.has(s.id)) { open.add(s.id); } }
    const list = all.filter((s) => open.has(s.id)).sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((a.createdAt || 0) - (b.createdAt || 0)) || a.id.localeCompare(b.id));
    if (list.length > MAX_TABS) {
      // Too many open: keep pinned, running and the active chat; drop the oldest idle ones from the bar (still in "All chats").
      const keep = new Set(list.filter((s) => s.pinned || s.id === active || state.running.has(s.id)).map((s) => s.id));
      for (const s of list.slice().sort((a, b) => b.updatedAt - a.updatedAt)) { if (keep.size >= MAX_TABS) { break; } keep.add(s.id); }
      for (const s of list) { if (!keep.has(s.id)) { open.delete(s.id); } }
      state.openTabs = open;
      return tabList();
    }
    return { list, active, hidden: all.length - list.length, all };
  }
  function tabTitle(s) {
    const running = state.running.has(s.id); const st = state.status.get(s.id);
    const lines = [s.title || 'New chat', `${MODES[s.mode] ? MODES[s.mode].label : s.mode} · ${s.messageCount} message${s.messageCount === 1 ? '' : 's'} · ${tabModel(s)}`];
    if (running) { lines.push(state.paused.get(s.id) && state.paused.get(s.id).paused ? `Paused${st ? ` — ${st}` : ''}` : `Running${st ? ` — ${st}` : '…'}`); }
    if (state.selected.size > 1 && state.selected.has(s.id)) { lines.push(`${state.selected.size} tabs selected — ✕ or Delete closes them all`); }
    if (state.attention.has(s.id)) { lines.push('Waiting for your approval'); }
    if (state.unread.has(s.id)) { lines.push('Finished — new results'); }
    if (s.id === activeId()) { lines.push('Double-click to rename · right-click for actions'); }
    return lines.join('\n');
  }
  /** Model this chat talks to: the one it last requested, else its configured model, else the default. */
  function tabModel(s) { return modelName(state.modelOf.get(s.id) || s.model || state.defaultModel) || 'auto'; }
  function tabIndicator(s) {
    if (state.running.has(s.id) && state.paused.get(s.id) && state.paused.get(s.id).paused) { return `<span class="pausedind" aria-label="Paused">${I.pause}</span>`; }
    if (state.running.has(s.id)) { return LIVE_DOT; }
    if (state.attention.has(s.id)) { return I.warn; }
    if (state.unread.has(s.id)) { return '<span class="dot" aria-label="Finished"></span>'; }
    if (s.pinned) { return I.pin; }
    return (MODES[s.mode] || MODES.agent).icon;
  }
  let tabSig = '';
  function renderTabs() {
    const { list, active, hidden } = tabList();
    // The store broadcasts on every save while agents stream; only rebuild the DOM when something visible changed.
    if (els.tabs.querySelector('.rename')) { renderTabs.pending = true; return; }
    const sig = list.map((s) => [s.id, s.title, s.pinned ? 1 : 0, s.id === active ? 1 : 0, state.running.has(s.id) ? 1 : 0, state.paused.get(s.id) && state.paused.get(s.id).paused ? 1 : 0, state.loadingTab === s.id ? 1 : 0, state.unread.has(s.id) ? 1 : 0, state.attention.has(s.id) ? 1 : 0, state.selected.has(s.id) ? 1 : 0].join(':')).join('|') + `#${hidden}#${state.running.size}`;
    if (sig === tabSig) { for (const tab of els.tabs.querySelectorAll('.tab[data-id]')) { const s = list.find((x) => x.id === tab.dataset.id); if (s) { tab.title = tabTitle(s); } } renderBgRuns(); return; }
    tabSig = sig;
    els.tabs.innerHTML = '';
    for (const s of list) {
      const running = state.running.has(s.id); const isActive = s.id === active;
      const cls = ['tab', isActive && 'active', running && 'running', state.loadingTab === s.id && 'loading', state.unread.has(s.id) && 'unread', state.attention.has(s.id) && 'attention', s.pinned && 'pinned', state.selected.has(s.id) && 'selected'].filter(Boolean).join(' ');
      const b = el('button', cls, `<span class="ind">${tabIndicator(s)}</span><span class="t">${esc(s.title || 'New chat')}</span><span class="close" role="button" title="${running ? 'Stop this agent' : s.pinned ? 'Pinned — unpin to close' : 'Close tab'}" aria-label="${running ? 'Stop' : 'Close'}">${running ? I.stop : I.x}</span>`);
      b.dataset.id = s.id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(isActive)); b.tabIndex = isActive ? 0 : -1;
      if (state.loadingTab === s.id) { b.setAttribute('aria-busy', 'true'); }
      b.title = tabTitle(s);
      b.onclick = (e) => {
        if (e.target.closest('.close')) { e.stopPropagation(); if (state.selected.size > 1 && state.selected.has(s.id)) { closeSelected(); } else if (running) { post({ type: 'stop', sessionId: s.id }); } else if (s.pinned) { toast('Unpin the chat to close its tab'); } else { closeTab(s.id); } return; }
        // ⌘/Ctrl-click toggles a tab in the selection, Shift-click selects a range; plain click switches and clears the selection.
        if (e.metaKey || e.ctrlKey) { toggleSelect(s.id); return; }
        if (e.shiftKey) { selectRange(s.id); return; }
        if (state.selected.size) { state.selected.clear(); tabSig = ''; }
        if (e.detail < 2) { selectTab(s.id); }
      };
      b.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); if (state.selected.size > 1 && state.selected.has(s.id)) { closeSelected(); } else if (!running && !s.pinned) { closeTab(s.id); } } };
      b.oncontextmenu = (e) => { e.preventDefault(); openTabMenu(b, s); };
      b.ondblclick = (e) => { if (!e.target.closest('.close')) { startRename(b, s); } };
      els.tabs.appendChild(b);
    }
    if (hidden > 0) {
      const more = el('button', 'tab more', `<span class="t">+${hidden}</span>`);
      more.title = `${hidden} more chat${hidden === 1 ? '' : 's'} — open All chats`; more.tabIndex = -1;
      more.onclick = openHistory;
      els.tabs.appendChild(more);
    }
    els.history.dataset.n = String(state.running.size);
    els.history.title = state.running.size ? `All chats · ${state.running.size} agent${state.running.size === 1 ? '' : 's'} running` : 'All chats';
    const act = els.tabs.querySelector('.tab.active'); if (act) { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    renderBgRuns();
    saveState();
  }
  // Composer isolation: each tab keeps its own draft, attachments, images and scroll offset while you switch around.
  function saveDraft(sid) {
    if (!sid) { return; }
    if (els.input.value || state.attachments.length || state.images.length) { state.drafts.set(sid, { text: els.input.value, attachments: [...state.attachments], images: [...state.images] }); } else { state.drafts.delete(sid); }
    state.scroll.set(sid, els.messages.scrollTop);
  }
  function restoreDraft(sid) {
    const d = state.drafts.get(sid);
    els.input.value = d ? d.text : ''; state.attachments = d ? [...d.attachments] : []; state.images = d ? [...d.images] : [];
    renderChips(); autoGrow(); updateSendEnabled();
  }
  /** Optimistic switch: the clicked tab is selected and marked busy right away; the extension answers with the session. */
  function selectTab(id) {
    if (!id || id === activeId()) { return; }
    closeMenu();
    saveDraft(state.session && state.session.id);
    state.loadingTab = id; state.unread.delete(id);
    if (state.openTabs) { state.openTabs.add(id); }
    renderTabs();
    post({ type: 'selectSession', id });
    clearTimeout(selectTab.timer);
    selectTab.timer = setTimeout(() => { if (state.loadingTab === id) { state.loadingTab = null; renderTabs(); toast('Could not open that chat', 'error'); } }, 8000);
  }
  function closeTab(id) { closeTabs([id]); }
  /** Closes several tabs at once. Running tabs are skipped unless `stop` is set (then the agent is stopped first); pinned ones are kept. */
  function closeTabs(ids, opts = {}) {
    const { list } = tabList(); const active = activeId();
    if (!state.openTabs) { state.openTabs = new Set(list.map((s) => s.id)); }
    const closing = new Set(); let skipped = 0;
    for (const id of ids) {
      const s = list.find((x) => x.id === id); if (!s) { continue; }
      if (s.pinned) { skipped++; continue; }
      if (state.running.has(id)) { if (opts.stop) { state.dismissed.add(id); post({ type: 'stop', sessionId: id }); } else { skipped++; continue; } }
      closing.add(id);
    }
    for (const id of closing) { state.openTabs.delete(id); state.unread.delete(id); state.selected.delete(id); state.drafts.delete(id); state.scroll.delete(id); }
    if (closing.has(active)) {
      const remaining = list.filter((s) => !closing.has(s.id)); const idx = list.findIndex((s) => s.id === active);
      const next = list.slice(idx + 1).find((s) => !closing.has(s.id)) || list.slice(0, idx).reverse().find((s) => !closing.has(s.id)) || remaining[0];
      if (next) { selectTab(next.id); } else { post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' }); }
    }
    tabSig = ''; renderTabs();
    if (ids.length > 1) { toast(`Closed ${closing.size} tab${closing.size === 1 ? '' : 's'}${skipped ? ` · kept ${skipped} running/pinned` : ''}`); }
    return closing.size;
  }
  function toggleSelect(id) { const a = activeId(); if (!state.selected.size && a) { state.selected.add(a); } if (state.selected.has(id)) { state.selected.delete(id); } else { state.selected.add(id); } if (state.selected.size === 1 && state.selected.has(a)) { state.selected.clear(); } tabSig = ''; renderTabs(); }
  function selectRange(id) { const { list } = tabList(); const a = [...state.selected].pop() || activeId(); const i = list.findIndex((s) => s.id === a); const j = list.findIndex((s) => s.id === id); if (i < 0 || j < 0) { return toggleSelect(id); } for (const s of list.slice(Math.min(i, j), Math.max(i, j) + 1)) { state.selected.add(s.id); } tabSig = ''; renderTabs(); }
  function closeSelected(opts) { const ids = [...state.selected]; state.selected.clear(); closeTabs(ids, opts); }
  function clearSelection() { if (state.selected.size) { state.selected.clear(); tabSig = ''; renderTabs(); } }
  function startRename(tab, s) {
    const t = tab.querySelector('.t'); if (!t || tab.querySelector('.rename')) { return; }
    const input = el('input', 'rename'); input.value = s.title || ''; input.setAttribute('aria-label', 'Chat title'); input.maxLength = 80;
    t.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (commit) => { if (done) { return; } done = true; const v = input.value.trim(); if (commit && v && v !== s.title) { s.title = v; if (state.session && state.session.id === s.id) { state.session.title = v; } post({ type: 'renameSession', id: s.id, title: v }); } input.replaceWith(t); renderTabs.pending = false; tabSig = ''; renderTabs(); els.input.focus(); };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    input.onblur = () => finish(true);
    input.onclick = (e) => e.stopPropagation(); input.ondblclick = (e) => e.stopPropagation();
  }
  function openTabMenu(anchor, s) {
    const running = state.running.has(s.id);
    const { list } = tabList(); const idx = list.findIndex((x) => x.id === s.id);
    const right = list.slice(idx + 1).filter((x) => !x.pinned).map((x) => x.id);
    const finished = list.filter((x) => state.unread.has(x.id) && !x.pinned).map((x) => x.id);
    const idle = list.filter((x) => !state.running.has(x.id) && !x.pinned && x.id !== s.id).map((x) => x.id);
    const runningIds = list.filter((x) => state.running.has(x.id)).map((x) => x.id);
    if (state.selected.size > 1 && state.selected.has(s.id)) {
      const sel = [...state.selected]; const nRun = sel.filter((id) => state.running.has(id)).length;
      return openMenu(anchor, [
        { label: `Close ${sel.length} selected tabs`, desc: nRun ? `${nRun} running will stay open` : 'Chats stay in All chats', icon: I.x, onPick: () => closeSelected() },
        ...(nRun ? [{ label: `Stop and close all ${sel.length}`, desc: `Stops ${nRun} running agent${nRun === 1 ? '' : 's'} first`, icon: I.stop, onPick: () => closeSelected({ stop: true }) }] : []),
        { label: 'Delete selected chats…', desc: 'Cannot be undone', icon: I.trash, onPick: () => openMenu(anchor, [{ label: `Delete ${sel.length} chats`, icon: I.trash, onPick: () => { closeSelected({ stop: true }); post({ type: 'deleteSessions', ids: sel }); } }, { label: 'Cancel', icon: I.x }]) },
        { hr: true },
        { label: 'Clear selection', icon: I.check, onPick: clearSelection },
      ]);
    }
    const items = [
      { label: 'Rename', desc: 'Double-click the tab also works', icon: I.rename, onPick: () => startRename(anchor, s) },
      { label: s.pinned ? 'Unpin' : 'Pin', desc: s.pinned ? 'Allow closing this tab' : 'Keep this tab first and open', icon: I.pin, onPick: () => post({ type: 'pinSession', id: s.id }) },
      { label: 'Fork', desc: 'Branch into a new tab from here', icon: I.fork, onPick: () => post({ type: 'forkSession', id: s.id }) },
      { label: 'Export as Markdown', icon: I.export, onPick: () => post({ type: 'exportSession', id: s.id }) },
      { hr: true },
      ...(running ? [(state.paused.get(s.id) && state.paused.get(s.id).paused) ? { label: 'Resume agent', desc: 'Continue from where it paused', icon: I.play, onPick: () => post({ type: 'resume', sessionId: s.id }) } : { label: 'Pause agent', desc: 'Holds after the current step; type to add instructions', icon: I.pause, onPick: () => post({ type: 'pause', sessionId: s.id }) }] : []),
      ...(running ? [{ label: 'Stop agent', desc: state.status.get(s.id) || 'Running', icon: I.stop, onPick: () => post({ type: 'stop', sessionId: s.id }) }] : [{ label: 'Clear messages', icon: I.list, onPick: () => post({ type: 'clearSession', sessionId: s.id }) }]),
      ...(running || s.pinned ? [] : [{ label: 'Close tab', desc: 'Keeps the chat in All chats', icon: I.x, onPick: () => closeTab(s.id) }]),
      ...(running ? [{ label: 'Stop and close', desc: 'Cancels the agent and closes this tab', icon: I.x, onPick: () => closeTabs([s.id], { stop: true }) }] : []),
      ...(idle.length ? [{ group: 'Close many', label: 'Close other tabs', desc: `${idle.length} idle tab${idle.length === 1 ? '' : 's'} · running and pinned stay`, icon: I.x, onPick: () => closeTabs(idle) }] : []),
      ...(right.length ? [{ group: 'Close many', label: 'Close tabs to the right', desc: `${right.length} tab${right.length === 1 ? '' : 's'}`, icon: I.chev, onPick: () => closeTabs(right) }] : []),
      ...(finished.length ? [{ group: 'Close many', label: 'Close finished tabs', desc: `${finished.length} with unread results`, icon: I.check, onPick: () => closeTabs(finished) }] : []),
      ...(runningIds.length > 1 ? [{ group: 'Close many', label: `Stop all ${runningIds.length} agents`, desc: 'Tabs stay open', icon: I.stop, onPick: () => { for (const id of runningIds) { post({ type: 'stop', sessionId: id }); } } }] : []),
      { label: 'Delete chat…', desc: running ? 'Stops the agent and deletes everything' : 'Cannot be undone', icon: I.trash, onPick: () => openMenu(anchor, [{ label: `Delete “${short(s.title || 'New chat', 32)}”`, desc: 'Permanently removes this chat', icon: I.trash, onPick: () => { if (state.openTabs) { state.openTabs.delete(s.id); } post({ type: 'deleteSession', id: s.id }); } }, { label: 'Cancel', icon: I.x }]) },
    ];
    openMenu(anchor, items);
  }
  // Roving focus inside the tab list (WAI-ARIA tabs) plus global shortcuts: Alt+↑/↓ cycle, Alt+1…9 jump, Delete closes.
  function cycleTab(delta) { const { list, active } = tabList(); if (!list.length) { return; } const i = list.findIndex((s) => s.id === active); selectTab(list[(Math.max(0, i) + delta + list.length) % list.length].id); }
  els.tabs.setAttribute('role', 'tablist');
  els.tabs.addEventListener('keydown', (e) => {
    const tabs = [...els.tabs.querySelectorAll('.tab:not(.more)')]; const i = tabs.indexOf(document.activeElement);
    if (i < 0 || e.target.classList.contains('rename')) { return; }
    const go = (j) => { e.preventDefault(); const t = tabs[(j + tabs.length) % tabs.length]; t.focus(); selectTab(t.dataset.id); };
    if (e.key === 'ArrowRight') { go(i + 1); } else if (e.key === 'ArrowLeft') { go(i - 1); } else if (e.key === 'Home') { go(0); } else if (e.key === 'End') { go(tabs.length - 1); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (state.selected.size > 1) { closeSelected(); } else { const id = tabs[i].dataset.id; if (!state.running.has(id)) { closeTab(id); } } }
    else if (e.key === 'Escape') { clearSelection(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); for (const t of tabs) { state.selected.add(t.dataset.id); } tabSig = ''; renderTabs(); }
    else if (e.key === 'F2') { e.preventDefault(); const s = tabList().list.find((x) => x.id === tabs[i].dataset.id); if (s) { startRename(tabs[i], s); } }
  });
  // Strip under the tab bar: agents working in *other* tabs, with their live step. Click to switch, ■ to stop.
  let bgTimer = 0;
  let bgSig = '';
  function renderBgRuns() {
    if (!els.bgruns) { return; }
    const active = activeId();
    const runs = tabList().all.filter((s) => state.running.has(s.id) && s.id !== active);
    els.bgruns.classList.toggle('hidden', !runs.length);
    // Rebuilding identical rows restarts their spinners on every store broadcast; skip when nothing visible changed.
    const sig = runs.map((s) => `${s.id}:${s.title}:${state.status.get(s.id) || ''}:${tabModel(s)}:${state.paused.get(s.id) && state.paused.get(s.id).paused ? 'p' : ''}`).join('|');
    if (sig === bgSig) { return; }
    bgSig = sig;
    els.bgruns.innerHTML = '';
    if (!runs.length) { return; }
    for (const s of runs.slice(0, 3)) {
      const paused = state.paused.get(s.id) && state.paused.get(s.id).paused;
      const row = el('div', `bgrun ${paused ? 'paused' : ''}`, `${paused ? `<span class="pausedind">${I.pause}</span>` : LIVE_DOT}<span class="t">${esc(s.title || 'New chat')}</span><span class="st">${esc(state.status.get(s.id) || 'Working…')}</span><span class="mdl" title="Model">${esc(tabModel(s))}</span><button class="stop pausebtn" title="${paused ? 'Resume this agent' : 'Pause this agent after its current step'}">${paused ? I.play : I.pause}</button><button class="stop" title="Stop this agent">${I.stop}</button>`);
      row.title = `${s.title}\n${state.status.get(s.id) || 'Working…'}\nModel: ${tabModel(s)}\nClick to open`;
      row.onclick = (e) => { if (e.target.closest('.pausebtn')) { post({ type: paused ? 'resume' : 'pause', sessionId: s.id }); return; } if (e.target.closest('.stop')) { post({ type: 'stop', sessionId: s.id }); return; } selectTab(s.id); };
      els.bgruns.appendChild(row);
    }
    if (runs.length > 3) { const more = el('button', 'bgrun more', `<span class="st">+${runs.length - 3} more running</span>`); more.onclick = openHistory; els.bgruns.appendChild(more); }
  }
  function scheduleBg() { if (bgTimer) { return; } bgTimer = setTimeout(() => { bgTimer = 0; renderBgRuns(); const t = els.tabs.querySelector('.tab.running'); if (t) { for (const tab of els.tabs.querySelectorAll('.tab.running')) { const s = tabList().all.find((x) => x.id === tab.dataset.id); if (s) { tab.title = tabTitle(s); } } } }, 120); }
  function noteStatus(sid, text) { if (text) { state.status.set(sid, text); } else { state.status.delete(sid); } scheduleBg(); }
  function openHistory() {
    const active = activeId();
    const list = state.sessions.slice().sort((a, b) => (state.running.has(b.id) - state.running.has(a.id)) || (b.updatedAt - a.updatedAt));
    const items = [
      { label: 'New chat', desc: 'Starts another agent in parallel', icon: I.sparkle, onPick: () => post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' }) },
      { label: 'Multitask…', desc: 'Several agents at once — split the work, or try one task on several models. Comes with ideas for this project.', icon: I.layers, onPick: () => openParallelComposer() },
      ...(state.running.size > 1 ? [{ label: `Stop all ${state.running.size} agents`, icon: I.stop, onPick: () => { for (const id of state.running) { post({ type: 'stop', sessionId: id }); } } }] : []),
      { hr: true },
      ...list.map((s) => ({ group: state.running.has(s.id) ? 'Running' : 'Chats', label: s.title || 'New chat', desc: state.running.has(s.id) ? (state.status.get(s.id) || 'Working…') : `${s.mode} · ${s.messageCount} msgs · ${timeAgo(s.updatedAt)}${state.openTabs && !state.openTabs.has(s.id) ? ' · not in tab bar' : ''}`, icon: state.running.has(s.id) ? I.spin : s.pinned ? I.pin : I.file, selected: s.id === active, tag: state.running.has(s.id) ? 'running' : state.unread.has(s.id) ? 'new' : undefined, onPick: () => selectTab(s.id) })),
      { hr: true },
      { group: 'Manage', label: 'Close other tabs', desc: 'Keeps running and pinned chats open', icon: I.x, onPick: closeOtherTabs },
      { group: 'Manage', label: 'Clear chat history…', desc: `Deletes idle chats in this workspace${state.running.size ? ' · running agents keep going' : ''}`, icon: I.trash, onPick: confirmClearHistory },
      { group: 'Manage', label: 'Memory & history settings', desc: 'Retention, storage, memory notes', icon: I.memory, onPick: () => post({ type: 'openSettings', section: 'memory' }) },
    ];
    openMenu(els.history, items, { search: 'Search chats…' });
  }
  function closeOtherTabs() {
    const active = activeId(); const { list } = tabList();
    let n = 0;
    if (!state.openTabs) { state.openTabs = new Set(list.map((s) => s.id)); }
    for (const s of list) { if (s.id !== active && !state.running.has(s.id) && !s.pinned) { state.openTabs.delete(s.id); state.unread.delete(s.id); n++; } }
    renderTabs(); toast(n ? `Closed ${n} tab${n === 1 ? '' : 's'}` : 'Nothing to close');
  }
  function confirmClearHistory() {
    const idle = state.sessions.filter((s) => !state.running.has(s.id)); const pinned = idle.filter((s) => s.pinned).length;
    if (!idle.length) { toast(state.running.size ? 'Only running chats are open — stop them first' : 'No chat history to clear'); return; }
    const items = [
      { label: pinned ? `Delete ${idle.length - pinned} chat${idle.length - pinned === 1 ? '' : 's'}, keep ${pinned} pinned` : `Delete ${idle.length} chat${idle.length === 1 ? '' : 's'}`, desc: 'Cannot be undone — file changes already accepted stay on disk', icon: I.trash, onPick: () => post({ type: 'clearHistory', keepPinned: true }) },
      ...(pinned ? [{ label: `Delete everything (${idle.length})`, desc: 'Including pinned chats', icon: I.trash, onPick: () => post({ type: 'clearHistory', keepPinned: false }) }] : []),
      { label: 'Cancel', icon: I.x },
    ];
    openMenu(els.history, items);
  }
  /** In-webview launcher for several agents at once: one task per line, each becomes its own tab. */
  // Multitask launcher: several agents at once — each with its own task, or all on one task with different models.
  // Built for people who do not want to think in "prompts": ready-made ideas for this project, autocomplete while
  // typing, one row per task, and a plain-language summary of what will happen.
  const launcher = { pool: [], recent: [], loadingMore: false, box: null };
  function openParallelComposer(kindArg) {
    const p = els.popover; p.innerHTML = ''; p.classList.remove('hidden');
    menuState = { items: [], sel: 0 };
    const draft = els.input.value.trim();
    const seeded = draft.includes('|') ? draft.split('|').map((t) => t.trim()).filter(Boolean) : draft.includes('\n') ? draft.split('\n').map((t) => t.trim()).filter(Boolean) : draft ? [draft] : [];
    const mode = (state.session && state.session.mode) || 'agent';
    const toolModels = state.models.filter((m) => m.supportsTools);
    let kind = kindArg === 'bestof' ? 'bestof' : 'tasks';
    const box = el('div', 'par', `
      <div class="par-head">${I.layers}<div><b>Multitask</b><span>Start several agents at once. Each works in its own copy of your project, so nothing collides — you review and apply what you like.</span></div></div>
      <div class="par-cards" role="radiogroup">
        <button class="par-card ${kind === 'tasks' ? 'on' : ''}" data-m="tasks" role="radio" aria-checked="${kind === 'tasks'}">${I.list}<b>Split the work</b><span>Give each agent its own task; they run at the same time.</span></button>
        <button class="par-card ${kind === 'bestof' ? 'on' : ''}" data-m="bestof" role="radio" aria-checked="${kind === 'bestof'}">${I.sparkle}<b>Try several models</b><span>One task, several models — keep the result you like best.</span></button>
      </div>
      <div class="par-tasks"><div class="rows"></div><button class="btn ghost add" data-a="add">${I.plus}<span>Add another task</span></button></div>
      <div class="par-models ${kind === 'bestof' ? '' : 'hidden'}" aria-label="Models"><div class="lbl">Which models should try it? <i>pick 2 to 8</i></div><div class="chips">${toolModels.map((m) => `<label class="chip"><input type="checkbox" value="${esc(m.id)}"><span title="${esc(m.id)}">${esc(m.name)}</span></label>`).join('') || '<span class="muted">No tool-capable models found yet — add one in Settings → Models.</span>'}</div></div>
      <div class="par-ideas"><div class="lbl"><span>Ideas for this project</span><button class="btn ghost more" data-a="more" title="Ask the model for ideas tailored to this project">${I.sparkle}<span>More ideas</span></button></div><div class="chips"><span class="muted">Looking at your project…</span></div></div>
      <div class="par-foot"><span class="n"></span><span class="spacer"></span><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="run" disabled>${I.agent}<span>Start</span></button></div>`);
    launcher.box = box;
    const rows = box.querySelector('.rows'); const n = box.querySelector('.n'); const run = box.querySelector('[data-a="run"]'); const modelsBox = box.querySelector('.par-models'); const addBtn = box.querySelector('[data-a="add"]'); const ideas = box.querySelector('.par-ideas .chips');
    // Pre-select the two most capable-looking models so Best of N works with one click.
    [...modelsBox.querySelectorAll('input')].slice(0, 2).forEach((i) => { i.checked = true; });
    const values = () => [...rows.querySelectorAll('input.task')].map((i) => i.value.trim()).filter(Boolean);
    const pickedModels = () => [...modelsBox.querySelectorAll('input:checked')].map((i) => i.value).slice(0, 8);
    function addRow(text, focus) {
      if (kind === 'bestof' && rows.children.length >= 1) { const first = rows.querySelector('input.task'); if (text) { first.value = text; } update(); return first; }
      const row = el('div', 'task-row', `<span class="num">${rows.children.length + 1}</span><input class="task" type="text" placeholder="${kind === 'bestof' ? 'Describe the task, e.g. "Make the sign-up form easier to use"' : rows.children.length ? 'Another task…' : 'What should this agent do? e.g. "Add a dark mode"'}" aria-label="Task"><button class="rm" title="Remove this task">${I.x}</button><div class="ac hidden" role="listbox"></div>`);
      const input = row.querySelector('input'); const ac = row.querySelector('.ac');
      input.value = text || '';
      let acItems = []; let acSel = -1;
      const hideAc = () => { ac.classList.add('hidden'); ac.innerHTML = ''; acItems = []; acSel = -1; };
      const showAc = () => {
        acItems = completeTask(input.value, launcher.pool, launcher.recent).filter((t) => t.toLowerCase() !== input.value.trim().toLowerCase());
        if (!acItems.length) { hideAc(); return; }
        acSel = -1; ac.innerHTML = acItems.map((t, i) => `<div class="opt" data-i="${i}">${esc(t)}</div>`).join(''); ac.classList.remove('hidden');
      };
      const accept = (i) => { if (acItems[i] !== undefined) { input.value = acItems[i]; } hideAc(); update(); };
      input.oninput = () => { update(); showAc(); };
      input.onfocus = () => { if (input.value.trim().length >= 2) { showAc(); } };
      input.onblur = () => setTimeout(hideAc, 120);
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (!ac.classList.contains('hidden') && acItems.length) {
          if (e.key === 'ArrowDown') { e.preventDefault(); acSel = (acSel + 1) % acItems.length; paint(); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; paint(); return; }
          if (e.key === 'Tab' || (e.key === 'Enter' && acSel >= 0)) { e.preventDefault(); accept(acSel >= 0 ? acSel : 0); return; }
          if (e.key === 'Escape') { e.preventDefault(); hideAc(); return; }
        }
        if (e.key === 'Escape') { closeMenu(); els.input.focus(); return; }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); return; }
        if (e.key === 'Enter' && kind === 'tasks') { e.preventDefault(); if (input.value.trim()) { const next = row.nextElementSibling ? row.nextElementSibling.querySelector('input') : addRow('', true); if (next) { next.focus(); } } return; }
        if (e.key === 'Backspace' && !input.value && rows.children.length > 1) { e.preventDefault(); const prev = row.previousElementSibling; row.remove(); renumber(); update(); if (prev) { prev.querySelector('input').focus(); } }
      };
      function paint() { [...ac.children].forEach((c, i) => c.classList.toggle('sel', i === acSel)); }
      ac.onmousedown = (e) => { const o = e.target.closest('.opt'); if (o) { e.preventDefault(); accept(Number(o.dataset.i)); } };
      // Pasting several lines fills several rows.
      input.onpaste = (e) => { const t = (e.clipboardData || {}).getData ? e.clipboardData.getData('text') : ''; if (kind === 'tasks' && /\n|\|/.test(t)) { e.preventDefault(); const parts = t.split(/\n|\|/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean); if (!parts.length) { return; } input.value = parts[0]; for (const extra of parts.slice(1)) { addRow(extra, false); } update(); } };
      row.querySelector('.rm').onclick = () => { if (rows.children.length > 1) { row.remove(); } else { input.value = ''; } renumber(); update(); };
      rows.appendChild(row); renumber();
      if (focus) { input.focus(); }
      return input;
    }
    function renumber() { [...rows.children].forEach((r, i) => { r.querySelector('.num').textContent = String(i + 1); }); addBtn.classList.toggle('hidden', kind === 'bestof'); }
    function update() {
      const v = values();
      if (kind === 'bestof') {
        const k = pickedModels().length; const ok = k >= 2 && v.length >= 1;
        n.textContent = ok ? `${k} agents will try the same task — one per model. You pick the result you like.` : k < 2 ? 'Pick at least two models.' : 'Describe the task first.';
        run.disabled = !ok; run.querySelector('span').textContent = ok ? `Start ${k} agents` : 'Start'; return;
      }
      n.textContent = v.length ? `${v.length} agent${v.length === 1 ? '' : 's'} will start, each in its own copy of your project.` : 'Add at least one task — or pick an idea below.';
      run.disabled = !v.length; run.querySelector('span').textContent = v.length > 1 ? `Start ${v.length} agents` : 'Start';
    }
    function go() {
      const v = values();
      if (kind === 'bestof') { const models = pickedModels(); if (models.length < 2 || !v.length) { return; } post({ type: 'runBestOfN', prompt: v[0], models, mode }); closeMenu(); if (seeded.length) { els.input.value = ''; autoGrow(); updateSendEnabled(); } toast(`Started ${models.length} agents on the same task`); return; }
      if (!v.length) { return; } post({ type: 'runParallel', tasks: v, mode }); closeMenu(); if (seeded.length) { els.input.value = ''; autoGrow(); updateSendEnabled(); } toast(`Started ${v.length} agent${v.length === 1 ? '' : 's'}`);
    }
    function setKind(k) {
      kind = k;
      for (const c of box.querySelectorAll('.par-card')) { c.classList.toggle('on', c.dataset.m === k); c.setAttribute('aria-checked', String(c.dataset.m === k)); }
      modelsBox.classList.toggle('hidden', k !== 'bestof');
      if (k === 'bestof') { const keep = values()[0] || ''; rows.innerHTML = ''; addRow(keep, false); } else if (!rows.children.length) { addRow('', false); }
      [...rows.querySelectorAll('input.task')].forEach((i, idx) => { i.placeholder = k === 'bestof' ? 'Describe the task, e.g. "Make the sign-up form easier to use"' : idx ? 'Another task…' : 'What should this agent do? e.g. "Add a dark mode"'; });
      renumber(); update();
    }
    function renderIdeas() {
      if (!launcher.pool.length) { ideas.innerHTML = `<span class="muted">${launcher.loadingMore ? 'Asking the model…' : 'No ideas yet — type a task above.'}</span>`; return; }
      const used = new Set(values().map((v) => v.toLowerCase()));
      ideas.innerHTML = launcher.pool.map((s, i) => `<button class="idea ${s.kind} ${used.has(s.title.toLowerCase()) ? 'used' : ''}" data-i="${i}" title="${esc(s.detail || '')}"><b>${esc(s.title)}</b>${s.detail ? `<span>${esc(s.detail)}</span>` : ''}</button>`).join('') + (launcher.loadingMore ? '<span class="muted loading">Asking the model for more…</span>' : '');
    }
    launcher.renderIdeas = renderIdeas;
    ideas.onclick = (e) => {
      const b = e.target.closest('.idea'); if (!b) { return; }
      const sug = launcher.pool[Number(b.dataset.i)]; if (!sug) { return; }
      const empty = [...rows.querySelectorAll('input.task')].find((i) => !i.value.trim());
      if (kind === 'bestof' || empty) { (empty || rows.querySelector('input.task')).value = sug.title; } else { addRow(sug.title, false); }
      update(); renderIdeas();
    };
    box.querySelector('.par-cards').onclick = (e) => { const c = e.target.closest('.par-card'); if (c) { setKind(c.dataset.m); } };
    modelsBox.onchange = update;
    box.onclick = (e) => { const a = e.target.closest('[data-a]'); if (!a) { return; } if (a.dataset.a === 'cancel') { closeMenu(); els.input.focus(); } else if (a.dataset.a === 'add') { addRow('', true); update(); } else if (a.dataset.a === 'more') { if (!launcher.loadingMore) { launcher.loadingMore = true; renderIdeas(); post({ type: 'suggestTasks', more: true }); } } else if (a.dataset.a === 'run') { go(); } };
    p.appendChild(box);
    if (seeded.length) { seeded.forEach((t) => addRow(t, false)); } else { addRow('', false); }
    setKind(kind); renderIdeas();
    post({ type: 'suggestTasks' });
    const r = els.history.getBoundingClientRect(); const pw = Math.min(560, window.innerWidth - 20);
    p.style.left = `${Math.max(10, Math.min(r.left - pw + r.width, window.innerWidth - pw - 10))}px`; p.style.top = `${r.bottom + 6}px`; p.style.width = `${pw}px`;
    rows.querySelector('input.task').focus();
  }
  /** Autocomplete for a half-typed task: prefix matches first, then tasks containing every typed word, then recent prompts. */
  function completeTask(input, pool, recent) {
    const q = input.trim().toLowerCase(); if (q.length < 2) { return []; }
    const words = q.split(/\s+/).filter(Boolean); const last = words[words.length - 1]; const whole = words.slice(0, -1);
    // Finished words must appear as words; the word being typed must start a word ("write a re" → "Write a README…", not "Review…").
    const score = (t) => { const l = t.toLowerCase(); if (l === q) { return -1; } if (l.startsWith(q)) { return 100; } const tokens = l.split(/[^a-z0-9]+/).filter(Boolean); if (!whole.every((w) => tokens.includes(w)) || !tokens.some((tk) => tk.startsWith(last))) { return 0; } return 60 - Math.min(30, Math.max(0, l.length - q.length) / 4); };
    return [...new Set([...pool.map((s) => s.title), ...recent])].map((t) => ({ t, s: score(t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.t);
  }
  els.newTab.onclick = () => post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' });
  els.history.onclick = openHistory;
  // Placeholder adapts to the composer width.
  const PLACEHOLDERS = [[0, 'Ask anything…'], [300, 'Ask, plan or build… (@ context)'], [420, 'Plan, build, fix anything… (@ context, / commands)']];
  function basePlaceholder() { const w = els.box.clientWidth; let p = PLACEHOLDERS[0][1]; for (const [min, t] of PLACEHOLDERS) { if (w >= min) { p = t; } } return p; }
  new ResizeObserver(() => syncPlaceholder()).observe(els.box);
  function syncPlaceholder() {
    const sid = state.session && state.session.id; const p = sid && state.paused.get(sid);
    const mode = state.session && MODES[state.session.mode];
    els.input.placeholder = p && p.paused ? 'Add instructions — the agent reads them when it resumes…' : sid && state.running.has(sid) ? 'Type to steer this agent (used at its next step), ⌘⇧↵ for a new tab…' : mode && state.session.mode !== 'agent' && els.box.clientWidth >= 300 ? mode.placeholder : basePlaceholder();
  }
  let tasksSig = '';
  function renderTasks() {
    const todos = (state.session && state.session.todos) || [];
    els.tasks.classList.toggle('hidden', !todos.length); if (!todos.length) { tasksSig = ''; return; }
    const done = todos.filter((t) => t.status === 'done').length;
    els.tasksLabel.textContent = `Tasks ${done}/${todos.length}`;
    els.tasksMeter.firstElementChild.style.width = `${Math.round((done / todos.length) * 100)}%`;
    const sig = `${state.session.id}|${todos.map((t) => `${t.id}:${t.status}:${t.title}:${t.agent || ''}:${(t.dependsOn || []).join(',')}`).join('|')}`;
    if (sig === tasksSig) { return; }
    tasksSig = sig;
    const y = els.tasksList.scrollTop;
    els.tasksList.innerHTML = '';
    for (const t of todos) {
      // in_progress is a filled marker, not a spinner: the Workers card and the status line already show the motion.
      const li = el('li', `todo ${t.status}`, `<span class="box">${t.status === 'done' ? I.check : t.status === 'in_progress' ? '<i class="now"></i>' : t.status === 'skipped' ? I.x : ''}</span><span class="title">${esc(t.title)}</span>${t.agent ? `<span class="todo-agent" title="${esc(t.status === 'pending' ? `Will be delegated to the ${t.agent} subagent${t.dependsOn && t.dependsOn.length ? ` after ${t.dependsOn.join(', ')}` : ''}` : t.status === 'in_progress' ? `The ${t.agent} subagent is working on this` : `Delegated to the ${t.agent} subagent`)}">${I.agent}${esc(t.agent)}${t.dependsOn && t.dependsOn.length ? `<span class="todo-after">after ${esc(t.dependsOn.join(', '))}</span>` : ''}</span>` : ''}`);
      if (t.result) { li.title = t.result.slice(0, 600); }
      els.tasksList.appendChild(li);
    }
    els.tasksList.scrollTop = y;
  }
  let changesSig = '';
  function renderChanges() {
    const s = state.session; const files = s ? state.changes.get(s.id) || [] : [];
    const wt = s ? state.worktree.get(s.id) : null;
    els.changes.classList.toggle('hidden', !files.length); if (!files.length) { changesSig = ''; return; }
    const added = files.reduce((n, f) => n + (f.added || 0), 0); const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
    els.changesLabel.textContent = `${files.length} file${files.length === 1 ? '' : 's'} changed${wt ? ` in isolated copy${added || removed ? ` · +${added} −${removed}` : ''}` : ''}`;
    // Isolated worktree: the agent's edits are not in the workspace yet — Apply brings them over, Discard throws the copy away.
    els.changes.classList.toggle('isolated', !!wt);
    const head = els.changes.querySelector('.panel-head');
    const undoAll = head.querySelector('[data-a="undoAll"]'); const keepAll = head.querySelector('[data-a="keepAll"]');
    if (wt) {
      undoAll.title = 'Discard the isolated copy and its changes'; undoAll.querySelector('.long').textContent = 'Discard'; undoAll.dataset.a = 'discardWorktree';
      keepAll.title = wt.conflicts && wt.conflicts.length ? `Last apply left conflict markers in: ${wt.conflicts.join(', ')}` : 'Apply these changes to your workspace as uncommitted edits (3-way merge on conflict)'; keepAll.querySelector('.long').textContent = 'Apply to workspace'; keepAll.dataset.a = 'applyWorktree';
    } else {
      const u = head.querySelector('[data-a="discardWorktree"]'); const k = head.querySelector('[data-a="applyWorktree"]');
      if (u) { u.title = 'Reject all changes'; u.querySelector('.long').textContent = 'Reject all'; u.dataset.a = 'undoAll'; }
      if (k) { k.title = 'Accept all changes'; k.querySelector('.long').textContent = 'Accept all'; k.dataset.a = 'keepAll'; }
    }
    const sig = `${s.id}|${wt ? 'wt' : ''}|${files.map((f) => `${f.fsPath}:${f.kind}:${f.added || 0}:${f.removed || 0}`).join('|')}`;
    if (sig === changesSig) { return; }
    changesSig = sig;
    const y = els.changesList.scrollTop;
    els.changesList.innerHTML = '';
    const KIND = { create: 'A', modify: 'M', delete: 'D', rename: 'R' };
    for (const f of files) {
      const stat = f.added || f.removed ? `<span class="stat"><i class="add">+${f.added || 0}</i><i class="del">−${f.removed || 0}</i></span>` : '';
      const acts = wt ? '' : `<span class="acts"><button data-a="undo" title="Reject">${I.undo}</button><button data-a="keep" title="Accept">${I.check}</button></span>`;
      const li = el('li', 'change', `<span class="kind ${f.kind}">${KIND[f.kind] || 'M'}</span><span class="name" title="${esc(f.path)}">${esc(f.path)}</span>${stat}${acts}`);
      li.onclick = (e) => { const a = e.target.closest('[data-a]'); if (a) { post({ type: a.dataset.a === 'undo' ? 'undoChanges' : 'keepChanges', sessionId: s.id, fsPath: f.fsPath }); return; } if (f.kind !== 'delete') { post({ type: 'showDiff', sessionId: s.id, fsPath: f.fsPath }); } };
      els.changesList.appendChild(li);
    }
    els.changesList.scrollTop = y;
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
    // Return focus to the composer unless the picked action opened something that took it.
    const pick = (it) => { closeMenu(); it.onPick && it.onPick(); if (!document.activeElement || document.activeElement === document.body) { els.input.focus(); } };
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
  document.addEventListener('mousedown', (e) => { if (menuState && e.target.isConnected && !els.popover.contains(e.target) && !e.target.closest('.pick, .ctxbtn, #btnHistory')) { closeMenu(); } });
  // The popover is position:fixed from its anchor; scrolling or resizing would leave it floating detached.
  els.messages.addEventListener('scroll', () => { if (menuState) { closeMenu(); } }, { passive: true });
  window.addEventListener('resize', () => { if (menuState) { closeMenu(); } });

  els.modeBtn.onclick = () => openMenu(els.modeBtn, Object.entries(MODES).map(([k, m]) => ({ label: m.label, desc: m.desc, icon: m.icon, selected: (state.session && state.session.mode) === k, onPick: () => setMode(k) })));
  els.modelBtn.onclick = () => {
    const s = state.session; const cur = (s && s.model) || '';
    const items = [{ label: 'Auto', desc: state.defaultModel ? `Default: ${state.defaultModel.split('/').pop()}` : 'Best available tool-capable model', icon: I.sparkle, selected: !cur, onPick: () => chooseModel('') }];
    for (const m of state.models) { items.push({ group: m.providerId, label: m.name, desc: `${(m.contextWindow / 1024).toFixed(0)}k ctx${m.supportsTools ? ' · tools' : ' · text tools'}${m.supportsVision ? ' · vision' : ''}`, tag: m.supportsVision ? 'vision' : undefined, icon: I.bot, selected: m.id === cur, onPick: () => chooseModel(m.id) }); }
    items.push({ hr: true }, { label: 'Refresh models', icon: I.spin, onPick: () => { state.modelsRequested = true; post({ type: 'refreshModels' }); toast('Refreshing models…'); } }, { label: 'Manage models…', icon: I.list, onPick: () => post({ type: 'openSettings', section: 'models' }) }, { label: 'Configure providers…', icon: I.list, onPick: () => post({ type: 'openSettings', section: 'providers' }) });
    openMenu(els.modelBtn, items, { search: 'Search models…' });
  };
  function chooseModel(id) { if (!state.session) { return; } state.session.model = id; syncModel(); updateCtx(); post({ type: 'setModel', sessionId: state.session.id, model: id, makeDefault: false }); }
  // ------------------------------------------------------------------ skills for this chat
  const SKILL_MODES = {
    auto: { label: 'Auto', desc: 'Install matching registry skills as the request starts; strong matches load into the request' },
    ask: { label: 'Ask', desc: 'Offer registry skills as an Install chip; installed skills still load when they clearly match' },
    off: { label: 'Off', desc: 'No registry lookups and no skill suggestions in this chat — pinned skills and /skill still work' },
  };
  const sessionSkills = () => (state.session && state.session.skills) || {};
  const effectiveSkillsMode = () => sessionSkills().mode || state.skillsMode || 'auto';
  function syncSkills() {
    if (!els.skillsBtn) { return; }
    const ss = sessionSkills(); const pinned = ss.pinned || []; const mode = effectiveSkillsMode();
    els.skillsLabel.textContent = pinned.length ? `${pinned.length} pinned` : ss.mode ? `Skills: ${SKILL_MODES[mode].label}` : 'Skills';
    els.skillsBtn.classList.toggle('on', !!(pinned.length || ss.mode));
    els.skillsBtn.classList.toggle('off', mode === 'off' && !pinned.length);
    els.skillsBtn.title = `Skills in this chat: ${SKILL_MODES[mode].label}${ss.mode ? ' (overrides the global setting)' : ` (global setting)`}${pinned.length ? ` · pinned: ${pinned.join(', ')}` : ''}`;
  }
  function setSkills(patch) {
    if (!state.session) { return; }
    const cur = sessionSkills();
    const next = { mode: 'mode' in patch ? patch.mode : cur.mode, pinned: 'pinned' in patch ? patch.pinned : cur.pinned };
    state.session.skills = next.mode || (next.pinned && next.pinned.length) ? next : undefined;
    syncSkills();
    post({ type: 'setSkills', sessionId: state.session.id, mode: next.mode || null, pinned: next.pinned || [] });
  }
  els.skillsBtn.onclick = () => {
    const ss = sessionSkills(); const pinned = new Set(ss.pinned || []); const g = state.skillsMode || 'auto';
    const items = [
      { group: 'This chat', label: `Inherit global (${SKILL_MODES[g].label})`, desc: 'Follow Settings → Skills', icon: I.sparkle, selected: !ss.mode, onPick: () => setSkills({ mode: undefined }) },
      ...Object.entries(SKILL_MODES).map(([k, m]) => ({ group: 'This chat', label: m.label, desc: m.desc, icon: k === 'off' ? I.x : I.book, selected: ss.mode === k, onPick: () => setSkills({ mode: k }) })),
    ];
    if (state.skills.length) {
      items.push({ hr: true });
      for (const s of state.skills) {
        const on = pinned.has(s.name);
        items.push({ group: 'Pin to every request', label: s.name, desc: s.description, icon: I.book, selected: on, tag: on ? 'pinned' : undefined, onPick: () => { const next = new Set(pinned); on ? next.delete(s.name) : next.add(s.name); setSkills({ pinned: [...next] }); } });
      }
    }
    items.push({ hr: true }, { label: 'Manage skills…', desc: 'Install from the registry, enable / disable, remove', icon: I.list, onPick: () => post({ type: 'openSettings', section: 'skills' }) });
    openMenu(els.skillsBtn, items, { search: state.skills.length > 6 ? 'Search skills…' : undefined });
  };
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
      { group: 'Web page', label: 'Screenshot a URL…', desc: 'Renders a page or local dev server with a headless browser', icon: I.globe, onPick: () => post({ type: 'captureUrl' }) },
      { group: 'Web page', label: 'Screenshot a URL (phone size)…', desc: '390×844 viewport with a mobile user agent', icon: I.globe, onPick: () => post({ type: 'captureUrl', mobile: true }) },
      { group: 'Web page', label: 'Inspect a URL (screenshot + console + network)…', desc: 'DevTools report drafted into the composer for the model to analyse', icon: I.bug, onPick: () => post({ type: 'inspectUrl' }) },
      { group: 'Web page', label: 'Open URL in browser view…', desc: 'Opens beside the editor, inside VS Code', icon: I.open, onPick: () => post({ type: 'openBrowser' }) },
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
  /** ⌘/Ctrl+Shift+Enter: start the draft as a new agent in its own tab, leaving the current chat (even a running one) untouched. */
  function sendInNewTab() {
    const text = els.input.value.trim();
    if (!text) { return; }
    const atRefs = [...text.matchAll(/(?:^|\s)@([\w./-]+(?:#L\d+(?:-L?\d+)?)?)/g)].map((m) => m[1]);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    const images = state.images.map((i) => i.data);
    post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent', text, attachments, images: images.length ? images : undefined });
    state.history.unshift(text); state.history = state.history.slice(0, 50); state.histIdx = -1;
    els.input.value = ''; state.attachments = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled();
    toast('Started in a new tab');
  }
  /** Queue the composer text for the running agent in this tab; the host echoes it back as a "queued" row. */
  function steerCurrent() {
    const text = els.input.value.trim();
    if ((!text && !state.images.length) || !state.session) { return; }
    const atRefs = [...text.matchAll(/(?:^|\s)@([\w./-]+(?:#L\d+(?:-L?\d+)?)?)/g)].map((m) => m[1]);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    const images = state.images.map((i) => i.data);
    post({ type: 'steer', sessionId: state.session.id, text: text || 'Consider the attached image(s).', attachments, images: images.length ? images : undefined });
    state.history.unshift(text); state.history = state.history.slice(0, 50); state.histIdx = -1;
    state.drafts.delete(state.session.id);
    els.input.value = ''; state.attachments = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); els.input.focus();
  }
  /** A message typed while the agent was busy: a compact row inside the assistant's turn, "queued" until the loop takes it. */
  function steerRow(content, images, id, queued) {
    const d = el('div', `steer ${queued ? 'queued' : ''}`);
    if (id) { d.dataset.steerId = id; }
    d.innerHTML = `<span class="ico">${I.reply}</span><div class="txt"></div><span class="badge">${queued ? 'queued' : 'added'}</span>`;
    d.querySelector('.txt').textContent = String(content || '').replace(/\n\n\[\d+ images? attached\]$/, '');
    if (images && images.length) { const im = el('div', 'imgs', images.map((x) => `<img src="${x.startsWith('data:') ? x : `data:image/png;base64,${x}`}" alt="">`).join('')); d.appendChild(im); }
    return d;
  }
  function sendCurrent(fromSuggestion) {
    const text = els.input.value.trim();
    if ((!text && !state.images.length) || !state.session) { return; }
    if (state.running.has(state.session.id) || state.pendingSend.has(state.session.id)) {
      const p = state.paused.get(state.session.id);
      // Paused: the message is plainly meant for this agent. Running: ask, since a new tab is just as likely.
      if (p && p.paused) { steerCurrent(); return; }
      openMenu(els.box, [{ label: 'Add to this agent', desc: 'Queued and read at its next step — it keeps working', icon: I.agent, onPick: steerCurrent }, { label: 'Send in a new tab', desc: 'Starts another agent in parallel (⌘⇧↵)', icon: I.sparkle, onPick: sendInNewTab }, { label: 'Stop this agent first', desc: 'Then send here', icon: I.stop, onPick: () => post({ type: 'stop', sessionId: state.session.id }) }, { label: 'Cancel', icon: I.x }]); return;
    }
    const atRefs = [...text.matchAll(/(?:^|\s)@([\w./-]+(?:#L\d+(?:-L?\d+)?)?)/g)].map((m) => m[1]);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    const images = state.images.map((i) => i.data);
    const finalText = text || 'Describe what you see in the attached image(s).';
    post({ type: 'send', sessionId: state.session.id, text: finalText, attachments, images: images.length ? images : undefined });
    state.history.unshift(finalText); state.history = state.history.slice(0, 50); state.histIdx = -1;
    const empty = els.messages.querySelector('.empty'); if (empty) { empty.remove(); }
    if (!finalText.startsWith('/')) {
      const u = userTurn({ content: finalText, images }, undefined);
      u.classList.add('fresh');
      if (attachments.length) { u.insertBefore(el('div', 'att', attachments.map((a) => `<span class="chip">${I.file}<span>${esc(a)}</span></span>`).join('')), u.firstChild.nextSibling); }
      els.messages.appendChild(u); ensureLive(state.session.id); setStatus('Sending…');
      // React before the host acknowledges: Stop and the progress bar appear now; a watchdog undoes it if nothing comes back.
      const sid = state.session.id;
      setRunning(true);
      clearTimeout(state.pendingSend.get(sid));
      state.pendingSend.set(sid, setTimeout(() => { state.pendingSend.delete(sid); if (!state.running.has(sid) && state.session && state.session.id === sid) { setRunning(false); toast('The request did not start — check the LocalPilot output log and try again', 'error'); } }, 10000));
    }
    state.drafts.delete(state.session.id);
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
    if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendInNewTab(); return; }
    // Shift+Tab rotates the mode (Agent → Multitask → Debug → Plan → Ask), like Cursor.
    if (e.key === 'Tab' && e.shiftKey && !menuState && state.session && !state.running.has(state.session.id)) { e.preventDefault(); const keys = Object.keys(MODES); const next = keys[(keys.indexOf(state.session.mode) + 1) % keys.length]; setMode(next); toast(`${MODES[next].label} mode`); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !els.input.value.trim() && state.session && els.messages.querySelector('.plancard') && !state.running.has(state.session.id)) { e.preventDefault(); post({ type: 'buildPlan', sessionId: state.session.id }); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); return; }
    if (e.key === 'Escape' && e.altKey && state.session && state.running.has(state.session.id)) { e.preventDefault(); togglePause(); return; }
    if (e.key === 'Escape' && state.session && state.running.has(state.session.id)) { post({ type: 'stop', sessionId: state.session.id }); return; }
    if (e.key === 'ArrowUp' && !els.input.value && state.history.length) { e.preventDefault(); state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1); els.input.value = state.history[state.histIdx]; autoGrow(); updateSendEnabled(); }
    if (e.key === 'ArrowDown' && state.histIdx >= 0 && els.input.value === state.history[state.histIdx]) { e.preventDefault(); state.histIdx--; els.input.value = state.histIdx >= 0 ? state.history[state.histIdx] : ''; autoGrow(); updateSendEnabled(); }
  });
  els.input.addEventListener('paste', (e) => { const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => /^image\//.test(it.type)); if (items.length) { e.preventDefault(); items.forEach((it) => addImageFile(it.getAsFile())); } });
  els.send.onclick = () => sendCurrent();
  els.stop.onclick = () => state.session && post({ type: 'stop', sessionId: state.session.id });
  els.pause.onclick = togglePause;
  els.tasksToggle.onclick = () => { els.tasks.classList.toggle('open'); els.tasksList.classList.toggle('hidden'); };
  els.tasks.classList.add('open');
  els.changesToggle.onclick = () => { els.changes.classList.toggle('open'); els.changesList.classList.toggle('hidden'); };
  els.changes.querySelector('.panel-head').onclick = (e) => {
    const a = e.target.closest('[data-a]'); if (!a || !state.session) { return; }
    const act = a.dataset.a;
    if (act === 'applyWorktree' || act === 'discardWorktree') { post({ type: act, sessionId: state.session.id }); return; }
    post({ type: act === 'undoAll' ? 'undoChanges' : 'keepChanges', sessionId: state.session.id });
  };
  els.box.addEventListener('dragover', (e) => { e.preventDefault(); els.box.classList.add('drop'); });
  els.box.addEventListener('dragleave', () => els.box.classList.remove('drop'));
  els.box.addEventListener('drop', (e) => { e.preventDefault(); els.box.classList.remove('drop'); const files = [...(e.dataTransfer.files || [])]; const imgs = files.filter((f) => /^image\//.test(f.type)); imgs.forEach(addImageFile); if (!imgs.length) { for (const u of (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter(Boolean)) { post({ type: 'attachUri', uri: u }); } } });
  els.messages.addEventListener('click', (e) => {
    const code = e.target.closest('[data-code]');
    if (code) { const pre = code.closest('.code').querySelector('pre'); const text = pre ? pre.textContent : ''; const act = code.dataset.code; if (act === 'copy') { navigator.clipboard.writeText(text).then(() => toast('Copied')); } if (act === 'insert') { post({ type: 'insertCode', code: text }); } if (act === 'apply') { post({ type: 'applyCodeToFile', code: text }); } return; }
    const link = e.target.closest('.path-link'); if (link) { e.preventDefault(); post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined }); return; }
    const uchip = e.target.closest('.fchip[data-url]'); if (uchip) { e.preventDefault(); post({ type: 'openExternal', url: uchip.dataset.url }); return; }
    const img = e.target.closest('.imgs img, .md-img, .content.shot img, .content.inspect .shot-img'); if (img) { openLightbox(img.src, img.alt); return; }
    const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); post({ type: 'openExternal', url: a.getAttribute('href') }); }
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); els.input.focus(); }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); openContextMenu(); }
    if (e.target && e.target.classList && e.target.classList.contains('rename')) { return; }
    if (e.altKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); cycleTab(e.key === 'ArrowDown' ? 1 : -1); }
    if (e.altKey && !mod && /^[1-9]$/.test(e.key)) { const { list } = tabList(); const t = list[Number(e.key) - 1]; if (t) { e.preventDefault(); selectTab(t.id); } }
    if (mod && e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); els.newTab.click(); }
    if (mod && e.altKey && e.key.toLowerCase() === 'w') { const id = activeId(); if (id && !state.running.has(id)) { e.preventDefault(); closeTab(id); } }
  });

  // ------------------------------------------------------------------ messages from the extension
  // Branded boot screen shown until the first session arrives from the extension host.
  let bootTimer = 0; let bootTries = 0;
  function dismissBoot() {
    clearTimeout(bootTimer);
    const b = $('boot');
    if (!b) { return; }
    b.classList.add('out');
    setTimeout(() => b.remove(), 260);
    post({ type: 'booted' });
  }
  // If the host is slow to answer (still activating, re-parented webview, lost message) ask again, and after a few
  // tries say so and offer a manual retry — a spinner must never be the only thing on screen.
  function requestInit() {
    clearTimeout(bootTimer);
    bootTries++;
    post({ type: 'ready' });
    const b = $('boot');
    if (!b) { return; }
    if (bootTries >= 3 && !b.querySelector('.boot-hint')) {
      const hint = el('div', 'boot-hint', `<span>Still connecting to LocalPilot…</span><button class="btn" type="button">Retry</button>`);
      hint.querySelector('button').onclick = () => { bootTries = 0; requestInit(); };
      b.appendChild(hint);
    }
    bootTimer = setTimeout(requestInit, bootTries < 3 ? 2500 : 6000);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init': state.sessions = m.sessions || []; state.models = m.models; state.modelsLoading = !m.models.length; state.defaultModel = m.defaultModel; state.skills = m.skills; state.agents = m.agents; state.skillsMode = m.skillsMode || 'auto'; state.running = new Set(m.running); state.paused = new Map((m.paused || []).map((id) => [id, { paused: true, holding: true }])); state.platform = m.platform || ''; state.activeHint = m.activeSessionId || null; if (!state.openTabs) { state.openTabs = new Set(state.sessions.slice().sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (b.updatedAt - a.updatedAt)).slice(0, 8).map((s) => s.id)); } syncModel(); renderTabs(); break;
      case 'sessions': state.sessions = m.sessions || []; for (const id of [...state.unread]) { if (!state.sessions.some((s) => s.id === id)) { state.unread.delete(id); } } renderTabs(); break;
      case 'session': {
        const prev = state.session && state.session.id; const switching = prev !== m.session.id;
        if (switching && prev) { saveDraft(prev); }
        state.session = m.session; state.loadingTab = null; state.activeHint = null; state.unread.delete(m.session.id); clearTimeout(selectTab.timer);
        renderSession(); renderChanges(); renderTasks(); renderTabs(); dismissBoot();
        if (switching) { closeMenu(); restoreDraft(m.session.id); const y = state.scroll.get(m.session.id); if (y !== undefined && !state.running.has(m.session.id)) { els.messages.scrollTop = y; } }
        // Don't yank focus away from a rename box, popover search or anything else the user is typing in.
        if (!document.activeElement || document.activeElement === document.body || els.messages.contains(document.activeElement)) { els.input.focus(); }
        break;
      }
      case 'changes': state.changes.set(m.sessionId, m.files); state.checkpoints.set(m.sessionId, m.checkpoints || []); if (m.worktree) { state.worktree.set(m.sessionId, m.worktree); } else { state.worktree.delete(m.sessionId); } if (state.session && state.session.id === m.sessionId) { renderChanges(); } break;
      case 'skills': state.skills = m.skills || []; state.agents = m.agents || []; if (m.skillsMode) { state.skillsMode = m.skillsMode; } syncSkills(); break;
      case 'models': { const hadNone = !state.models.length; const asked = state.modelsRequested; const wasLoading = state.modelsLoading; state.modelsRequested = false; state.modelsLoading = false; state.models = m.models; state.defaultModel = m.defaultModel; syncModel(); updateCtx(); if (hadNone && m.models.length) { if (asked) { toast(`${m.models.length} model(s) found`); } if (state.session && !state.session.messages.length) { renderSession(); } } else if (hadNone && wasLoading && state.session && !state.session.messages.length) { renderSession(); } break; }
      case 'event': handleEvent(m.event); break;
      case 'paused': {
        if (m.childId) { laneSetPaused(m.sessionId, m.childId, m.paused, m.holding); break; }
        state.paused.set(m.sessionId, { paused: m.paused, holding: m.holding });
        noteStatus(m.sessionId, m.paused ? (m.holding ? 'Paused' : 'Pausing after this step…') : 'Resuming…');
        if (state.session && state.session.id === m.sessionId) { syncPause(); setStatus(state.status.get(m.sessionId) || ''); }
        renderTabs();
        break;
      }
      case 'steerQueued': {
        const live = ensureLive(m.sessionId);
        live.root.appendChild(steerRow(m.content, m.images, m.id, true));
        noteStatus(m.sessionId, state.paused.get(m.sessionId) && state.paused.get(m.sessionId).paused ? 'Paused · message waiting' : 'Message queued for the next step');
        if (state.session && state.session.id === m.sessionId) { setStatus(state.status.get(m.sessionId)); scrollToBottom(false); }
        break;
      }
      case 'running': {
        const isActive = state.session && state.session.id === m.sessionId;
        if (!m.running) { state.paused.delete(m.sessionId); }
        clearTimeout(state.pendingSend.get(m.sessionId)); state.pendingSend.delete(m.sessionId);
        state.scroll.delete(m.sessionId);
        if (m.running) { state.running.add(m.sessionId); state.unread.delete(m.sessionId); noteStatus(m.sessionId, 'Starting…'); }
        else { state.running.delete(m.sessionId); finishLive(m.sessionId); noteStatus(m.sessionId, ''); if (!isActive && !state.dismissed.delete(m.sessionId) && state.sessions.some((s) => s.id === m.sessionId)) { state.unread.add(m.sessionId); } for (const [aid, sid] of [...state.approvalSid]) { if (sid === m.sessionId) { state.approvalSid.delete(aid); removeApproval(aid); } } state.attention.delete(m.sessionId); }
        if (isActive) { setRunning(m.running); if (!m.running) { post({ type: 'selectSession', id: m.sessionId }); } }
        renderTabs();
        break;
      }
      case 'approval': state.approvalSid.set(m.id, m.sessionId); renderApproval(m); if (!state.session || state.session.id !== m.sessionId) { state.attention.add(m.sessionId); renderTabs(); const s = state.sessions.find((x) => x.id === m.sessionId); toast(`Approval needed in “${(s && s.title) || 'another chat'}”`); } break;
      case 'approvalResolved': { removeApproval(m.id); resolveAttention(m.id); break; }
      case 'toast': if (m.text.startsWith('attach:')) { addAttachment(m.text.slice(7)); } else { toast(m.text, m.level); } break;
      case 'draft': els.input.value = m.text || ''; autoGrow(); updateSendEnabled(); els.input.focus(); break;
      case 'focusInput': els.input.focus(); post({ type: 'requestOpenFiles' }); break;
      case 'historyCleared': state.openTabs = null; state.unread.clear(); state.attention.clear(); for (const id of [...state.live.keys()]) { if (!state.running.has(id)) { state.live.delete(id); } } renderTabs(); break;
      case 'openFiles': state.openFiles = m.files || []; break;
      case 'taskSuggestions': {
        if (m.source === 'quick') { launcher.pool = m.items || []; } else { launcher.loadingMore = false; const have = new Set(launcher.pool.map((s) => s.title.toLowerCase())); launcher.pool = [...(m.items || []).filter((s) => !have.has(s.title.toLowerCase())), ...launcher.pool]; }
        launcher.recent = m.recent || [];
        if (launcher.box && launcher.box.isConnected && launcher.renderIdeas) { launcher.renderIdeas(); }
        break;
      }
      case 'openLauncher': openParallelComposer(m.kind); break;
      case 'image': if (state.images.length >= 4) { toast('Up to 4 images per message', 'error'); break; } state.images.push(m.image); renderChips(); updateSendEnabled(); els.input.focus(); break;
    }
  });

  // Permission prompt (Claude Code style): Allow once / Allow for session / Deny, with keyboard shortcuts.
  // Prompts from agents in other tabs show up here too (so a background agent never stalls unnoticed) with a link to that chat.
  function resolveAttention(approvalId) {
    const sid = state.approvalSid.get(approvalId); if (!sid) { return; }
    state.approvalSid.delete(approvalId);
    if (![...state.approvalSid.values()].includes(sid)) { state.attention.delete(sid); renderTabs(); }
  }
  /** Removes a prompt by id and unregisters its key handler — the only way prompts leave the DOM. */
  function removeApproval(id) {
    const d = els.approvals.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!d) { return; }
    if (d._dispose) { d._dispose(); }
    d.remove();
  }
  function renderApproval(a) {
    if (els.approvals.querySelector(`[data-id="${CSS.escape(a.id)}"]`)) { return; }
    const d = el('div', 'approval'); d.dataset.id = a.id;
    const kind = { terminal: 'Run command', write: 'Edit file', delete: 'Delete', network: 'Network' }[a.kind] || a.kind;
    const other = !state.session || state.session.id !== a.sessionId; const sess = other ? state.sessions.find((s) => s.id === a.sessionId) : null;
    d.innerHTML = `<div class="head">${I.warn}<span>${esc(a.title)}</span>${kind.toLowerCase() === String(a.title).toLowerCase() ? '' : `<span class="kind">${esc(kind)}</span>`}</div>${other ? `<button class="sess" data-a="open" title="Open that chat">${I.agent}<span>${esc((sess && sess.title) || 'Another chat')}</span>${I.chev}</button>` : ''}<pre></pre><div class="actions"><button class="btn ghost" data-a="deny" title="Deny (N)">Deny <kbd>N</kbd></button><button class="btn" data-a="session" title="Allow for this session (A)"><span class="long">Allow for session</span><span class="short">Session</span> <kbd>A</kbd></button><button class="btn primary" data-a="allow" title="Allow once (Y)"><span class="long">Allow once</span><span class="short">Once</span> <kbd>Y</kbd></button></div>`;
    d.querySelector('pre').textContent = a.detail;
    const answer = (act) => { post({ type: 'approval', id: a.id, approved: act !== 'deny', remember: act === 'session' }); removeApproval(a.id); resolveAttention(a.id); els.input.focus(); };
    // Y/A/N answer the oldest pending prompt only; with several queued, one keypress must not resolve them all.
    const key = (e) => { if (e.defaultPrevented || els.approvals.firstElementChild !== d) { return; } if (e.target === els.input && els.input.value) { return; } if (e.target !== els.input && e.target.closest && e.target.closest('.popover, .rename, input, textarea, select')) { return; } const k = e.key.toLowerCase(); if (k === 'y') { answer('allow'); } else if (k === 'a') { answer('session'); } else if (k === 'n' || k === 'escape') { answer('deny'); } else { return; } e.preventDefault(); };
    d.onclick = (ev) => { const b = ev.target.closest('[data-a]'); if (!b) { return; } if (b.dataset.a === 'open') { selectTab(a.sessionId); return; } answer(b.dataset.a); };
    document.addEventListener('keydown', key, true);
    d._dispose = () => document.removeEventListener('keydown', key, true);
    els.approvals.appendChild(d);
    if (state.session && state.session.id === a.sessionId) { scrollToBottom(false); }
  }

  updateSendEnabled();
  requestInit();
})();
