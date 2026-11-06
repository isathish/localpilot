// LocalPilot chat webview — vanilla JS, no dependencies.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const calmMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = {
    messages: $('messages'), input: $('input'), send: $('btnSend'), stop: $('btnStop'), pause: $('btnPause'), status: $('status'), statusText: $('statusText'),
    modeBtn: $('modeBtn'), modeLabel: $('modeLabel'), modeIcon: $('modeIcon'), modelBtn: $('modelBtn'), modelLabel: $('modelLabel'), skillsBtn: $('skillsBtn'), skillsLabel: $('skillsLabel'), ctx: $('ctxMeter'), usage: $('usagePill'),
    approvals: $('approvals'), chips: $('chips'), toasts: $('toasts'), box: $('box'), addCtx: $('btnAddCtx'), image: $('btnImage'), improve: $('btnImprove'),
    changes: $('changes'), changesList: $('changesList'), changesLabel: $('changesLabel'), changesToggle: $('changesToggle'), changesMeter: $('changesMeter'),
    tabs: $('tabs'), progress: $('progress'), tasks: $('tasks'), tasksList: $('tasksList'), tasksLabel: $('tasksLabel'), tasksMeter: $('tasksMeter'), tasksToggle: $('tasksToggle'),
    popover: $('popover'), newTab: $('btnNewTab'), btnComposerMore: $('btnComposerMore'), history: $('btnHistory'), bgruns: $('bgruns'),
    hints: $('hints'), disclaimer: $('disclaimer'),
  };
  // Webview state survives the view being hidden/restored: which chats are open as tabs.
  const persisted = (typeof vscode.getState === 'function' && vscode.getState()) || {};
  function saveState() { if (typeof vscode.setState === 'function') { vscode.setState({ ...((typeof vscode.getState === 'function' && vscode.getState()) || {}), openTabs: state.openTabs ? [...state.openTabs] : undefined }); } }

  const I = {
    check: '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7"/></svg>',
    plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
    x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
    spin: '<svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 1-5.2 3"/></svg>',
    refresh: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>',
    download: '<svg viewBox="0 0 16 16"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M3 12.5h10"/></svg>',
    insert: '<svg viewBox="0 0 16 16"><path d="M8 3v8M4.5 7.5L8 11l3.5-3.5M3 13h10"/></svg>',
    apply: '<svg viewBox="0 0 16 16"><path d="M3 3h7l3 3v7H3z"/><path d="M5 13V9h6v4"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3L7 9"/></svg>',
    undo: '<svg viewBox="0 0 16 16"><path d="M3 7h7a3 3 0 0 1 0 6H8M3 7l3-3M3 7l3 3"/></svg>',
    restore: '<svg viewBox="0 0 16 16"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3l2 1.5"/></svg>',
    diff: '<svg viewBox="0 0 16 16"><path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3M8 6.5v3M6.5 8h3M6.5 11.5h3"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1" fill="currentColor"/><circle cx="15" cy="9.5" r="1" fill="currentColor"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.8v.2"/></svg>',
    book: '<svg viewBox="0 0 16 16"><path d="M3 3h4a2 2 0 0 1 2 2v9a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H9a2 2 0 0 0-2 2v9a1.5 1.5 0 0 1 1.5-1.5H13z"/></svg>',
    closeOthers: '<svg viewBox="0 0 16 16"><rect x="2.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M5.5 3.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-.5M5 8l3 3M8 8l-3 3"/></svg>',
    rules: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M5.5 13.5h5M3 4.5h10"/><path d="M3 4.5l-1.8 4.2a1.9 1.9 0 0 0 3.6 0zM13 4.5l-1.8 4.2a1.9 1.9 0 0 0 3.6 0z"/></svg>',
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
    multidiff: '<svg viewBox="0 0 16 16"><path d="M6 4.5v-2h5.5l2 2V11h-2"/><path d="M2.5 4.5h6l2 2v7h-8z"/><path d="M4.5 9.5h4M4.5 11.5h2.5"/></svg>',
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
    gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6L5 5M11 11l1.4 1.4M3.6 12.4L5 11M11 5l1.4-1.4"/></svg>',
    key: '<svg viewBox="0 0 16 16"><circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4L13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/></svg>',
    ask: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.4-.8.7-.8 1.4M8 11.5h.01"/></svg>',
    compass: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M10.6 5.4 9.1 9.1 5.4 10.6 6.9 6.9z"/></svg>',
    refactor: '<svg viewBox="0 0 16 16"><path d="M2.5 5h8.5M8.5 2.5 11 5 8.5 7.5M13.5 11H5M7.5 8.5 5 11l2.5 2.5"/></svg>',
  };
  /** The one quiet "running" marker used wherever a spinner would only add noise: tabs, background rows, worker lanes. */
  const LIVE_DOT = '<span class="dot live" aria-label="Running"></span>';
  // Core modes, least to most autonomous: the picker, Mod+. and /mode follow this order. `tag` says whether files change.
  const MODES = {
    ask: { label: 'Ask', icon: I.ask, desc: 'Answer questions about the code, read-only', hint: 'Answer questions', tag: 'read-only', placeholder: 'Ask anything about this code…' },
    agent: { label: 'Agent', icon: I.agent, desc: 'Edit files, run commands, verify', hint: 'Edit, run, verify', tag: 'edits files', placeholder: 'Ask anything, or describe a task…' },
    plan: { label: 'Plan', icon: I.plan, desc: 'Investigate and prepare a plan you can build with one click', hint: 'Plan first, build with one click', tag: 'read-only', placeholder: 'Describe what you want; I will prepare a plan first' },
    debug: { label: 'Debug', icon: I.bug, desc: 'Reproduce the problem, find the cause, fix and verify', hint: 'Reproduce, find the cause, fix', tag: 'edits files', placeholder: 'Paste the error or describe what goes wrong…' },
    multitask: { label: 'Multitask', icon: I.layers, desc: 'Splits the work across background workers that run at the same time', hint: 'Parallel background workers', tag: 'edits files', placeholder: 'Coordinate parallel tasks… describe the outcome you want' },
  };
  // "More modes": a specialist runs in its base mode (which decides permissions) with a built-in agent's playbook added
  // to the prompt by the host (SPECIALISTS in src/agent/builtinAgents.ts; keep the two tables in step).
  const SPECIALISTS = {
    architect: { label: 'Architect', base: 'plan', icon: I.compass, desc: 'Design the change: modules, interfaces, risks, ordered steps', hint: 'Design first: interfaces, risks, steps', placeholder: 'Describe the change to design…' },
    review: { label: 'Review', base: 'ask', icon: I.diff, desc: 'Review uncommitted changes or a file, findings by severity', hint: 'Findings by severity, no edits', placeholder: 'Review my changes, or name a file…' },
    test: { label: 'Test', base: 'agent', icon: I.beaker, desc: 'Write and run tests, then fix failures', hint: 'Write, run and fix tests', placeholder: 'What should I test?' },
    refactor: { label: 'Refactor', base: 'agent', icon: I.refactor, desc: 'Restructure code without changing what it does, checked by tests', hint: 'Same behaviour, better structure', placeholder: 'What should I restructure?' },
    explain: { label: 'Explain', base: 'ask', icon: I.book, desc: 'Walk through code, data flow and concepts', hint: 'Walk through code and concepts', placeholder: 'What should I explain?' },
    terminal: { label: 'Terminal', base: 'agent', icon: I.term, desc: 'Shell tasks, each command shown before it runs', hint: 'Shell tasks, commands shown first', placeholder: 'What should I do in the terminal?' },
    project: { label: 'Project', base: 'ask', icon: I.folder, desc: 'Project overview: structure, entry points, build and test', hint: 'Structure, entry points, build, test', placeholder: 'What do you want to know about the project?' },
  };
  /** The chat's specialist id, only while the chat is still in that specialist's base mode. */
  function specOf(s) { const k = s && s.specialist; return k && SPECIALISTS[k] && SPECIALISTS[k].base === s.mode ? k : ''; }
  /** Label, icon, description and placeholder the chat's mode shows: the specialist's when one is active. */
  function modeView(s) { const k = specOf(s); const m = MODES[(s && s.mode) || 'agent'] || MODES.agent; return k ? { ...SPECIALISTS[k], tag: m.tag, baseLabel: m.label } : { ...m, baseLabel: '' }; }
  const READ_TOOLS = new Set(['read_file', 'list_dir', 'file_search', 'grep_search', 'find_symbol', 'find_references', 'get_diagnostics', 'get_editor_state', 'memory_read', 'memory_list', 'load_skill', 'web_search', 'web_fetch']);
  /** Consecutive calls to these fold into one "Explored" row in the transcript (see foldExplore). */
  const EXPLORE_TOOLS = new Set([...READ_TOOLS, 'gather_context', 'read_pdf', 'repo_graph', 'analyze_workspace', 'mcp_read_resource', 'git_status', 'ci_status']);
  // Built-in slash commands by group: [command, description, group]. A trailing space means the command takes an argument;
  // the rest run as soon as they are picked. /smol (same as /compact) still works when typed.
  const SLASH = [
    ['/clear', 'Clear this chat', 'Chat'], ['/compact', 'Summarise older messages', 'Chat'], ['/newtask ', 'Continue in a new chat that starts from a summary of this one', 'Chat'], ['/context', 'Context usage', 'Chat'],
    ['/mode ask', 'Ask mode', 'Chat'], ['/mode agent', 'Agent mode', 'Chat'], ['/mode plan', 'Plan mode', 'Chat'], ['/mode debug', 'Debug mode', 'Chat'], ['/mode multitask', 'Multitask mode', 'Chat'], ['/model ', 'Switch model for this chat', 'Chat'],
    ['/mode architect', 'Architect: design the change first (Plan)', 'More modes'], ['/mode review', 'Review: findings by severity (Ask)', 'More modes'], ['/mode test', 'Test: write and run tests (Agent)', 'More modes'], ['/mode refactor', 'Refactor: same behaviour, better structure (Agent)', 'More modes'], ['/mode explain', 'Explain: walk through code (Ask)', 'More modes'], ['/mode terminal', 'Terminal: shell tasks, commands shown first (Agent)', 'More modes'], ['/mode project', 'Project: overview, build and test (Ask)', 'More modes'],
    ['/deep-planning ', 'Investigate, ask, then write implementation_plan.md', 'Plan & delegate'], ['/team ', 'Split a task for background workers and the shared board', 'Plan & delegate'], ['/agent ', 'Delegate to a subagent', 'Plan & delegate'], ['/agent new ', 'Create a custom subagent', 'Plan & delegate'],
    ['/help', 'Show commands', 'Info'], ['/memory', 'Instruction files and saved memory notes', 'Info'], ['/permissions', 'Permission rules from settings.json', 'Info'], ['/hooks', 'Configured hooks', 'Info'], ['/board', 'Shared task board', 'Info'], ['/agents', 'List subagents', 'Info'], ['/commands', 'List custom slash commands', 'Info'],
    ['/skills', 'List skills', 'Skills'], ['/skill ', 'Run a task with a skill', 'Skills'], ['/skill install ', 'Install a skill from GitHub, a URL or a folder', 'Skills'], ['/skill browse ', 'Search and install from the skill catalog', 'Skills'],
  ];
  const MENTIONS = [['workspace', 'Project file tree', I.folder], ['selection', 'Current selection / active file', I.cursor], ['problems', 'Errors & warnings', I.bug], ['git', 'git status + diff', I.git], ['editors', 'Open editors', I.list], ['terminal', 'Last terminal command & output', I.term]];

  const state = {
    session: null, sessions: [], models: [], defaultModel: '', contextWindow: 0, running: new Set(), attachments: [], images: [], skills: [], agents: [], commands: [], openFiles: [],
    live: new Map(), changes: new Map(), checkpoints: new Map(), history: [], histIdx: -1,
    // Per chat: turns with a git checkpoint, files changed since the latest message ({ key, files }); whether checkpoints are on.
    gitCheckpoints: new Map(), lastTurn: new Map(), checkpointsOn: true,
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
    /** sid → self-healing cards of the current/last turn and its outcome; sid → interrupted recovery state. */
    recovery: new Map(), interrupted: new Map(),
    /** sid → the Run interrupted card's facts (a run cut off by a reload); sid → a model fallback this turn ({ wanted, used, … }). */
    runInt: new Map(), rerouted: new Map(),
    /** sid → files accepted or rejected since the latest message ({ path, fsPath, kind, state, redoUntil }), kept in the review queue. */
    reviewed: new Map(),
    /** sid → files ({ path, fsPath }) a worktree apply left with conflict markers (listed first in the review queue). */
    conflicts: new Map(),
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; }
  function post(m) {
    // A stop the user asked for settles the turn as "Stopped by you", not as a failure (finishLive / settleWork).
    if (m && (m.type === 'stop' || (m.type === 'toolFailureAction' && m.action === 'stop'))) { const lv = state.live.get(m.sessionId); if (lv) { lv.stopped = true; } }
    vscode.postMessage(m);
  }
  // Toasts float just above the composer, however tall the draft, approvals and task panels make it.
  const composerEl = document.getElementById('composer');
  if (composerEl && window.ResizeObserver) { new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${composerEl.offsetHeight}px`)).observe(composerEl); }
  /**
   * `action` ({ label, msg }) adds a button that posts `msg` back to the host. Errors go to the role="alert" region so a
   * screen reader interrupts for them; warnings and errors stay long enough to read (60 ms a character, 8 s at least),
   * and hovering or focusing a toast holds it.
   */
  function toast(text, level, action) {
    const lv = level || 'info';
    const t = el('div', `toast ${lv}`, `<span class="tt">${esc(text)}</span>`); t.title = text;
    if (action && action.label && action.msg) { const b = el('button', 'ta', esc(action.label)); b.onclick = () => { post(action.msg); t.remove(); }; t.appendChild(b); }
    const x = el('button', 'tx', '×'); x.setAttribute('aria-label', 'Dismiss'); x.title = 'Dismiss'; x.onclick = () => t.remove(); t.appendChild(x);
    const ms = lv === 'info' ? (action ? 10000 : 3200) : Math.max(8000, String(text).length * 60);
    let left = ms; let since = 0; let timer = 0;
    const run = () => { clearTimeout(timer); since = Date.now(); timer = setTimeout(() => t.remove(), left); };
    const hold = () => { if (!timer) { return; } clearTimeout(timer); timer = 0; left = Math.max(1500, left - (Date.now() - since)); };
    t.addEventListener('mouseenter', hold); t.addEventListener('focusin', hold);
    t.addEventListener('mouseleave', () => { if (!t.contains(document.activeElement)) { run(); } });
    t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget) && !t.matches(':hover')) { run(); } });
    const alerts = lv === 'error' && document.getElementById('toastAlerts');
    (alerts || els.toasts).appendChild(t); run();
  }
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
  function highlight(code, lang, store = true) {
    const key = `${lang}\u0000${code}`;
    const hit = hlCache.get(key);
    if (hit !== undefined) { return hit; }
    const out = highlightRaw(code, lang);
    // A still-streaming block changes every tick; caching each partial copy would pile up megabytes.
    if (!store || code.length > 60000) { return out; }
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
    if (lang === 'css') { return esc(code).replace(/(\/\*[\s\S]*?\*\/)|(?<=^|[{};\n]|\*\/)([^{}\n;]+)(?=\s*\{)|(?<![\w-])([\w-]+)(\s*:\s*)([^;}\n]+)/g, (m, c, sel, prop, colon, val) => (c ? `<span class="tk-c">${c}</span>` : sel !== undefined ? `<span class="tk-t">${sel}</span>` : `<span class="tk-p">${prop}</span>${colon}<span class="tk-s">${val}</span>`)); }
    if (lang === 'json') { return esc(code).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b/g, (m, str, colon, num, lit) => (str ? (colon ? `<span class="tk-p">${str}</span>${colon}` : `<span class="tk-s">${str}</span>`) : num ? `<span class="tk-n">${num}</span>` : `<span class="tk-k">${lit}</span>`)); }
    if (lang === 'yaml' || lang === 'toml') { return code.split('\n').map((l) => { const m = /^(\s*)(#.*)$/.exec(l); if (m) { return esc(m[1]) + tok('c', m[2]); } const kv = /^(\s*(?:- )?)([\w.-]+|"[^"]*"|\[[^\]]*\])(\s*[:=]\s*)(.*)$/.exec(l); if (kv) { const v = kv[4]; const val = /^(['"]).*\1$/.test(v) ? tok('s', v) : /^(true|false|null|~|yes|no|on|off)$/i.test(v) ? tok('k', v) : /^-?\d+(\.\d+)?$/.test(v) ? tok('n', v) : esc(v).replace(/(#.*)$/, (c) => `<span class="tk-c">${c}</span>`); return esc(kv[1]) + tok('p', kv[2]) + esc(kv[3]) + val; } return esc(l).replace(/^(\s*-\s)/, (d) => `<span class="tk-o">${d}</span>`); }).join('\n'); }
    const kws = kwSet(lang);
    const lineC = lang === 'py' || lang === 'sh' || lang === 'ruby' ? '#' : lang === 'sql' ? '--' : '//';
    const TRIPLE = ['"""', "'''"];
    const out = []; let i = 0; const n = code.length;
    const push = (cls, t) => out.push(cls ? tok(cls, t) : esc(t));
    // Sticky regexes match at `i` without copying the rest of the block (`code.slice(i)` per token made a long
    // streaming block quadratic — enough to freeze the window).
    const SH_VAR = /\$(?:\{[^}]*\}|[\w@#?*!$-]+)/y; const SH_FLAG = /-{1,2}[\w-]+/y;
    const at = (re) => { re.lastIndex = i; return re.exec(code); };
    while (i < n) {
      const start = i;
      do {
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
      if (lang === 'sh' && ch === '$') { const m = at(SH_VAR); if (m) { push('v', m[0]); i += m[0].length; continue; } }
      if (lang === 'sh' && ch === '-' && (i === 0 || /\s/.test(code[i - 1]))) { const m = at(SH_FLAG); if (m) { push('p', m[0]); i += m[0].length; continue; } }
      if (/[A-Za-z_$@]/.test(ch)) {
        // Start past `ch`: `@` opens a decorator but is not a word character, and a scanner that never advanced
        // on it spun the UI thread forever.
        let j = i + 1; while (j < n && /[\w$]/.test(code[j])) { j++; }
        const w = code.slice(i, j); let k = j; while (k < n && code[k] === ' ') { k++; }
        let p = i - 1; while (p >= 0 && /\s/.test(code[p])) { p--; }
        const prev = p >= 0 ? code[p] : '';
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
      } while (false);
      // No branch may ever leave `i` where it was: this loop runs on the UI thread, and one character it cannot
      // classify must cost one character, not the window.
      if (i === start) { push('', code[i]); i++; }
    }
    return out.join('');
  }
  /** Fenced block with header actions. `info` is the fence info string: `ts`, `ts path/to/file.ts`, `json title="x"`. */
  function codeBlock(code, info, closed = true) {
    const parts = String(info || '').trim().split(/\s+/);
    const lang = parts[0] && !/[./]/.test(parts[0]) ? parts[0] : '';
    const titleM = /(?:title|file|path)=("?)([^"\s]+)\1/.exec(info || '');
    const file = titleM ? titleM[2] : parts.find((p) => /[\w-]+\.[a-z0-9]+$/i.test(p) && !p.includes('=')) || '';
    const lines = code.split('\n').length;
    const head = file ? `<span class="lang path-link" data-path="${esc(file)}" title="Open ${esc(file)}">${esc(file)}</span>` : `<span class="lang">${esc(lang || 'text')}</span>`;
    return `<div class="code" data-lang="${esc(normLang(lang))}"><div class="code-head">${head}<span class="meta">${lines > 1 ? `${lines} lines` : ''}</span><button data-code="copy" title="Copy">${I.copy}<span>Copy</span></button><button data-code="insert" title="Insert at cursor" aria-label="Insert at cursor">${I.insert}</button><button data-code="apply" title="Apply to active file" aria-label="Apply to active file">${I.apply}</button></div><pre><code>${highlight(code, lang || langForPath(file), closed)}</code></pre></div>`;
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
    // Only inline data images render; a remote one would load (and leak) without a click, so it becomes a link.
    s = s.replace(/!\[([^\]]*)\]\(((?:https?:|data:image\/)[^)\s]+)\)/g, (_, alt, src) => hold(src.startsWith('data:') ? `<img class="md-img" src="${src}" alt="${alt}" title="${alt}">` : `<a href="${src}" title="${src}">Image: ${(/^https?:\/\/([^/?#]+)/.exec(src) || [])[1] || src}</a>`));
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
        while (i < lines.length && !close.test(lines[i])) { buf.push(lines[i]); i++; }
        const closed = i < lines.length; i++;
        out.push(codeBlock(buf.join('\n'), info, closed));
        continue;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) { flush(); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`); continue; }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        flush(); const items = [];
        while (i < lines.length && (/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s+\S/.test(lines[i]) && items.length) || (lines[i].trim() === '' && i + 1 < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i + 1])))) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) { items.push({ depth: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10), text: m[3] }); } else if (lines[i].trim()) { items[items.length - 1].text += '\n' + lines[i].trim(); }
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
      const { ordered, start } = items[pos]; let html = '';
      while (pos < items.length && items[pos].depth >= depth) {
        if (items[pos].depth > depth) { html = html.replace(/<\/li>$/, '') + build(items[pos].depth) + '</li>'; continue; }
        const it = items[pos++];
        html += `<li class="${/^\[[ xX]\]\s/.test(it.text) ? 'task-item' : ''}">${inline(it.text).replace(/\n/g, '<br>')}</li>`;
      }
      return ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`;
    };
    let html = '';
    while (pos < items.length) { html += build(items[pos].depth); }
    return html;
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
    // MCP results: inline images from the server, then the text rendered as Markdown.
    const mcpImgs = extra && extra.data && Array.isArray(extra.data.images) ? extra.data.images : [];
    if (/^mcp_/.test(tool) && !pending && (mcpImgs.length || !img)) {
      const text = String(content || '').replace(/^\[image [^\n]*\]$/gm, '').trim();
      c.classList.add('doc');
      c.innerHTML = `${mcpImgs.length ? `<div class="imgs">${mcpImgs.map((m) => `<img src="data:${esc(m.mime || 'image/png')};base64,${esc(m.data || '')}" alt="${esc(m.name || 'image')}" title="Click to enlarge">`).join('')}</div>` : ''}<div class="doc-body"></div>`;
      lazyFill(node, () => { c.querySelector('.doc-body').innerHTML = renderMarkdown(text); });
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
    if (tool === 'web_search') {
      // Results as link cards (title · domain · snippet) rather than a numbered text dump; links open in the browser.
      c.classList.add('doc');
      lazyFill(node, () => {
        const hits = parseWebHits(text);
        c.innerHTML = hits.length ? `<div class="web-hits">${hits.map((h) => `<a class="hit" href="${esc(h.url)}" title="${esc(h.url)}">${I.globe}<span class="hit-main"><span class="t">${esc(h.title || h.url)}</span><span class="u">${esc(h.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0])}</span>${h.snippet ? `<span class="s">${esc(h.snippet)}</span>` : ''}</span></a>`).join('')}</div>` : `<div class="doc-body">${linkify(text)}</div>`;
      });
      return;
    }
    const isDoc = tool === 'web_fetch' || tool === 'memory_read' || tool === 'load_skill' || tool === 'run_parallel_subagents' || tool === 'run_subagent';
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
  /** Parses web_search's text report ("1. Title\n   url\n   snippet" blocks) back into hits. */
  function parseWebHits(text) {
    const hits = [];
    for (const block of String(text || '').split(/\n\n(?=\d+\. )/)) {
      const lines = block.split('\n');
      const head = /^\d+\. (.*)$/.exec(lines[0] || '');
      const url = (lines[1] || '').trim();
      if (!head || !/^https?:\/\//i.test(url)) { continue; }
      hits.push({ title: head[1].trim(), url, snippet: lines.slice(2).join(' ').replace(/\s+/g, ' ').trim() });
    }
    return hits;
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
  /** A step the user denied reads as a neutral "Denied", not as a red failure. */
  function isDenied(r) { return !!r && !!r.isError && (!!r.denied || /^(The user denied this action|User declined|The user declined)\b/.test(String(r.content || ''))); }
  function markDenied(node) {
    if (!node || !node.classList) { return; }
    node.classList.remove('error'); node.classList.add('denied');
    const meta = node.querySelector(':scope > summary .meta'); if (meta) { meta.textContent = 'Denied'; }
    const stat = node.querySelector(':scope > .card-head .stat'); if (stat) { stat.textContent = 'Denied'; }
    const g = node.closest('.editgroup'); if (g) { updateEditGroup(g); }
  }
  /** A step cut short by Stop ("Cancelled", "Not run: the user stopped the run") is neutral like a denial, not a failure. */
  function isCancelled(r) { return !!r && !!r.isError && /^(Cancelled\b|Not run: the user stopped|Stopped by user\b)/.test(String(r.content || '')); }
  function markCancelled(node) {
    if (!node || !node.classList) { return; }
    node.classList.remove('error'); node.classList.add('denied', 'cancelled');
    const ico = node.querySelector(':scope > summary .ico, :scope > .card-head .ico'); if (ico) { ico.innerHTML = I.stop; }
    const meta = node.querySelector(':scope > summary .meta'); if (meta) { meta.textContent = 'Cancelled'; }
    const stat = node.querySelector(':scope > .card-head .stat'); if (stat) { stat.textContent = 'Cancelled'; }
    const g = node.closest('.editgroup'); if (g) { updateEditGroup(g); }
    dropFailBar(node);
  }
  // ---- failed steps: Retry / Edit & retry / Skip / Stop run under the row (spec 03). The host turns a click into a
  // steer while the run lasts and into a new turn once it ended, so it goes through the normal tools and approvals.
  /** The row a failure bar sits under: the top-level step (a failed read inside an Explored group, an edit inside its group). */
  function failAnchor(node) { const top = node.closest('.steps > *'); return top || node; }
  function dropFailBar(node) { if (node && node.__failBar) { node.__failBar.remove(); node.__failBar = null; } }
  /** Tool and target of a step, to tell a later success of the same step ("retried ✓") from a different one. */
  function stepKey(node) {
    const tool = node.classList.contains('card') ? (node.dataset.write === '1' ? 'write_file' : 'edit_file') : node.dataset.tool || '';
    const a = node.__args || parseArgs(node.dataset.args || '{}');
    return `${tool === 'write_file' ? 'edit_file' : tool}|${a.path || a.command || a.url || a.query || ''}`;
  }
  function failText(content) { const t = String(content || '').replace(/^\$ .*\n/, '').split('\n').map((l) => l.trim()).find((l) => l && !/^\[exit code/.test(l)) || 'The step failed'; return t.length > 160 ? `${t.slice(0, 159)}…` : t; }
  function failBar(node, content, sid) {
    if (!node || node.__failBar || node.classList.contains('denied') || !sid) { return; }
    const tool = node.classList.contains('card') ? (node.dataset.write === '1' ? 'write_file' : 'edit_file') : node.dataset.tool;
    if (!tool || tool === 'manage_todos' || node.closest('.subrows, .rec-rows')) { return; }
    const args = node.__args ? JSON.stringify(node.__args) : node.dataset.args || '{}';
    const running = state.running.has(sid);
    const bar = el('div', 'tool-fail', `<span class="why" title="${esc(String(content || '').slice(0, 1500))}">${esc(failText(content))}</span><span class="acts"><button class="btn sm" data-f="retry" title="Ask the agent to try this step again">${I.refresh}<span>Retry</span></button><button class="btn sm ghost" data-f="edit" title="Change the ${tool === 'run_command' ? 'command' : 'arguments'}, then retry">${I.edit}<span>Edit &amp; retry</span></button>${running ? `<button class="btn sm ghost" data-f="skip" title="Carry on without this step">Skip</button><button class="btn sm ghost" data-f="stop" title="Stop the run (${kb('Esc')})">${I.stop}<span>Stop run</span></button>` : ''}</span>`);
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Failed step actions');
    const send = (action, extra) => { post(Object.assign({ type: 'toolFailureAction', sessionId: sid, action, tool, args, error: String(content || '').slice(0, 2000) }, extra || {})); bar.querySelectorAll('button, textarea').forEach((b) => { b.disabled = true; }); bar.classList.add('sent'); };
    bar.onclick = (e) => {
      const b = e.target.closest('button[data-f]'); if (!b || b.disabled) { return; }
      const f = b.dataset.f;
      if (f === 'edit') {
        let form = bar.querySelector('.tf-edit');
        if (!form) {
          const a = parseArgs(args); const cmd = tool === 'run_command' && typeof a.command === 'string';
          form = el('form', 'tf-edit', `<textarea rows="${cmd ? 2 : 5}" spellcheck="false" aria-label="${cmd ? 'Command to run instead' : 'Arguments (JSON) for the retry'}"></textarea><span class="tf-row"><button class="btn sm primary" type="submit">${cmd ? 'Run instead' : 'Retry with these'}</button><button class="btn sm ghost" type="button" data-x="1">Cancel</button></span>`);
          const ta = form.querySelector('textarea'); ta.value = cmd ? a.command : JSON.stringify(a, null, 2);
          form.onsubmit = (ev) => { ev.preventDefault(); const v = ta.value.trim(); if (v) { send('edit', { args: v }); } };
          ta.onkeydown = (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); form.requestSubmit(); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); form.remove(); } };
          form.querySelector('[data-x]').onclick = () => form.remove();
          bar.appendChild(form);
        }
        form.querySelector('textarea').focus(); return;
      }
      send(f);
    };
    node.__failBar = bar;
    failAnchor(node).after(bar);
  }
  /** A later success of the same step: its bar goes, the failed row says it was retried. */
  function noteRetried(okNode) {
    const container = okNode.closest('.turn'); if (!container) { return; }
    const key = stepKey(okNode);
    for (const n of container.querySelectorAll('.step.error[data-tool], .card.edit.error')) {
      if (n !== okNode && n.__failBar && stepKey(n) === key) { dropFailBar(n); n.classList.add('retried'); const meta = n.querySelector(':scope > summary .meta, :scope > .card-head .stat'); if (meta) { meta.insertAdjacentHTML('beforeend', ' <span class="retried-tag">retried ✓</span>'); } }
    }
  }
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
      case 'read_file': if (Array.isArray(a.files)) { return `${v('Read', 'Reading')} ${a.files.map((f) => fchip(f && typeof f === 'object' ? f.path : f, 'file', { line: f && f.start_line })).join(' ')}`; } return `${v('Read', 'Reading')} ${fchip(a.path, 'file', { line: a.start_line })}${a.start_line ? `, lines ${a.start_line} to ${a.end_line || '…'}` : ''}`;
      case 'list_dir': return `${v('Listed', 'Listing')} ${fchip(a.path || '.', 'folder')}`;
      case 'grep_search': return `${v('Searched', 'Searching')} for ${code(a.query)}${a.include_pattern ? ` in ${code(a.include_pattern, 24)}` : ''}`;
      case 'file_search': return `${v('Searched', 'Searching')} for files matching ${code(a.pattern)}`;
      case 'find_symbol': return `${v('Looked up', 'Looking up')} ${code(a.query)}`;
      case 'find_references': return `${v('Found', 'Finding')} references to ${code(a.symbol)}`;
      case 'security_scan': return `${v('Scanned', 'Scanning')} for ${Array.isArray(a.kinds) && a.kinds.length ? esc(a.kinds.join(', ')) : 'vulnerable dependencies, secrets and risky code'}${a.path ? ` in ${fchip(a.path, 'folder')}` : ''}`;
      case 'repos': return `${v(a.action === 'exec' ? 'Ran' : a.action === 'search' ? 'Searched' : 'Listed', a.action === 'exec' ? 'Running' : a.action === 'search' ? 'Searching' : 'Listing')} ${a.action === 'exec' ? `${code(a.command, 50)} in ` : a.action === 'search' ? `${code(a.query, 40)} in ` : ''}${Array.isArray(a.repos) && a.repos.length ? esc(a.repos.join(', ')) : 'all repositories'}`;
      case 'team_board': return `${v({ add: 'Added to', claim: 'Claimed from', complete: 'Completed on', release: 'Released on', fail: 'Marked failed on', note: 'Noted on' }[a.action] || 'Read', { add: 'Adding to', claim: 'Claiming from', complete: 'Completing on', release: 'Releasing on', fail: 'Failing on', note: 'Noting on' }[a.action] || 'Reading')} the board${a.id ? ` ${code(a.id, 40)}` : ''}${a.title ? ` ${code(a.title, 50)}` : ''}`;
      case 'git_status': return `${v('Checked', 'Checking')} git ${esc(a.action || 'status')}${a.path ? ` of ${fchip(a.path)}` : ''}`;
      case 'git_commit': return `${v('Committed', 'Committing')}${a.branch ? ` on ${code(a.branch, 30)}` : ''} ${code(String(a.message || '').split('\n')[0], 60)}`;
      case 'git_push': return `${v('Pushed', 'Pushing')} the branch`;
      case 'pull_request': return `${v(a.action === 'create' ? 'Opened' : a.action === 'comment' ? 'Commented on' : 'Read', a.action === 'create' ? 'Opening' : a.action === 'comment' ? 'Commenting on' : 'Reading')} ${a.action === 'list' ? 'pull requests' : `pull request${a.number ? ` #${esc(a.number)}` : ''}`}${a.title ? ` ${code(a.title, 50)}` : ''}`;
      case 'ci_status': return `${v(a.action === 'rerun' ? 'Re-ran' : 'Read', a.action === 'rerun' ? 'Re-running' : 'Reading')} CI ${a.action === 'logs' ? 'failure logs' : a.action === 'rerun' ? 'failed jobs' : 'runs'}`;
      case 'repo_graph': { const what = { impact: 'what depends on', dependents: 'importers of', dependencies: 'imports of', symbol: 'where', external: 'users of', hubs: 'central modules', cycles: 'import cycles', overview: 'the import graph' }[a.action] || 'the import graph'; return `${v('Mapped', 'Mapping')} ${what}${a.path ? ` ${a.action === 'symbol' || a.action === 'external' ? code(a.path) : fchip(a.path)}` : ''}${a.action === 'symbol' ? ' is defined' : ''}`; }
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
      case 'apply_patch': { const files = [...String(a.input || '').matchAll(/^\s*\*\*\* (?:Add|Delete|Update) File:\s*(.+?)\s*$/gm)].map((m) => m[1]); return `${v('Patched', 'Patching')} ${files.length === 1 ? fchip(files[0]) : `<b>${files.length} files</b> ${files.slice(0, 3).map((f) => fchip(f)).join(' ')}`}`; }
      case 'run_subagent': return `${v('Delegated', 'Delegating')} to <b>${esc(a.agent || 'subagent')}</b>`;
      case 'run_parallel_subagents': return `${v('Ran', 'Running')} <b>${(a.tasks || []).length} subagents</b> in parallel`;
      case 'mcp_read_resource': return `${v('Read', 'Reading')} ${code(a.uri, 50)} from ${esc(a.server || 'MCP')}`;
      default: { const mcp = /^mcp_(.+?)__(.+)$/.exec(name); if (mcp) { return `${v('Called', 'Calling')} ${code(mcp[2], 40)} <span class="muted">· ${esc(mcp[1])}</span>`; } return `${v('Ran', 'Running')} ${code(name, 40)} ${short(a, 50)}`; }
    }
  }
  function toolIcon(name) {
    if (name === 'read_file' || name === 'get_editor_state') { return I.file; }
    if (name === 'list_dir' || name === 'create_directory') { return I.folder; }
    if (/search|find_|gather/.test(name)) { return I.search; }
    if (/^web|^open_browser|^browser_screenshot$/.test(name)) { return name === 'browser_screenshot' ? I.camera : I.globe; }
    if (name === 'browser_inspect' || name === 'get_diagnostics') { return I.bug; }
    if (name === 'run_command') { return I.term; }
    if (name === 'edit_file' || name === 'write_file' || name === 'apply_patch') { return I.edit; }
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
    card.innerHTML = `<div class="card-head"><span class="ico">${result ? (result.isError ? I.x : I.edit) : I.spin}</span><span class="name" title="${esc(a.path || '')}">${esc(a.path || '')}</span><span class="stat"><span class="a">+${d.add}</span> <span class="d">−${d.del}</span></span><span class="rtag hidden"></span><span class="acts"><button data-showdiff title="Review ${esc(a.path || 'the file')} in a side-by-side diff (accept or reject it there)" aria-label="Diff of ${esc(a.path || 'the file')}">${I.diff}</button><button data-open="${esc(a.path || '')}" title="Open file" aria-label="Open ${esc(a.path || 'file')}">${I.open}</button></span></div><div class="diff collapsed"></div>`;
    card.__diff = d.html; card.__args = a;
    if (result && !result.isError && state.session) { syncEditTag(card, state.reviewed.get(state.session.id)); }
    card.querySelector('.card-head').onclick = (e) => { if (e.target.closest('[data-showdiff]')) { if (state.session && a.path) { post({ type: 'showDiff', sessionId: state.session.id, fsPath: a.path }); } return; } if (e.target.closest('[data-open]')) { post({ type: 'openFile', path: e.target.closest('[data-open]').dataset.open, sessionId: state.session && state.session.id }); return; } const diff = card.querySelector('.diff'); if (card.__diff !== undefined) { diff.innerHTML = card.__diff; card.__diff = undefined; } diff.classList.toggle('collapsed'); };
    if (result && result.isError) { const err = el('div', 'term', ''); err.textContent = result.content; card.appendChild(err); }
    return card;
  }
  /** The review decision on an edit card's file (from the review queue): "Accepted" / "Rejected" after its stat. */
  function syncEditTag(card, rows) {
    const t = card.querySelector('.card-head .rtag'); if (!t) { return; }
    const p = (card.dataset.path || '').replace(/^\.\//, '').replace(/\\/g, '/');
    const r = p && (rows || []).find((x) => x.path === p || x.fsPath === p || x.fsPath.replace(/\\/g, '/').endsWith(`/${p}`));
    const word = r ? (r.state === 'accepted' ? 'Accepted' : 'Rejected') : '';
    t.classList.toggle('hidden', !word); t.textContent = word; t.className = `rtag ${r ? r.state : ''}${word ? '' : ' hidden'}`;
    t.title = r ? (r.state === 'accepted' ? 'You accepted this file\'s changes' : 'You rejected this file\'s changes: the edits were removed from disk') : '';
  }
  function syncEditTags(sid) {
    if (!state.session || state.session.id !== sid) { return; }
    const rows = state.reviewed.get(sid) || [];
    els.messages.querySelectorAll('.card.edit.ok').forEach((c) => syncEditTag(c, rows));
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
    const denied = cards.filter((c) => c.classList.contains('denied')).length;
    const verb = running ? (shown.dataset.write === '1' ? 'Creating' : 'Editing') : denied === cards.length ? 'Denied' : errs === cards.length ? 'Failed to edit' : shown.dataset.write === '1' && cards.length === 1 ? 'Created' : 'Edited';
    const others = cards.length - 1;
    g.querySelector(':scope > summary .label').innerHTML = `<b>${verb}</b> ${fchip(shown.dataset.path)}${others > 0 ? `, ${others} other step${others > 1 ? 's' : ''}` : ''} <span class="stat"><span class="a">+${add}</span> <span class="d">−${del}</span></span>`;
    g.querySelector(':scope > summary').title = [...files].join('\n');
    setState(g, running ? 'running' : errs ? 'error' : 'ok');
    if (!running && denied === cards.length) { g.classList.add('denied'); const ico = g.querySelector(':scope > summary .ico'); if (ico) { ico.innerHTML = I.x; } } else { g.classList.remove('denied'); }
  }

  // Terminal row (run_command): "Ran `cmd`" with exit badge; output expands below.
  function termRow(a, result) {
    const s = stepEl(`step term ${result ? (result.isError ? 'error' : 'ok') : 'running'}`, toolLabel('run_command', a, !result));
    s.__ico = I.term; s.dataset.tool = 'run_command'; s.dataset.args = JSON.stringify(a || {});
    const c = s.querySelector(':scope > .content'); c.className = 'content termout';
    // The folder it ran in when that is not the workspace root; Rerun goes through the agent (same tool, same approval rules).
    const cwd = typeof a.cwd === 'string' && a.cwd.trim() && !/^\.\/?$/.test(a.cwd.trim()) ? a.cwd.trim() : '';
    c.innerHTML = `<div class="term-acts">${cwd ? `<span class="cwd" title="Ran in ${esc(cwd)}">${I.folder}<span>${esc(short(cwd, 40))}</span></span>` : ''}<span class="sp"></span><button data-copy title="Copy command" aria-label="Copy command">${I.copy}<span>Command</span></button><button data-copyout title="Copy output" aria-label="Copy output">${I.term}<span>Output</span></button><button data-rerun title="Ask the agent to run this command again (your approval settings apply)" aria-label="Rerun">${I.refresh}<span>Rerun</span></button><button data-openterm title="Put this command in a terminal without running it" aria-label="Open in terminal">${I.open}<span>Open in terminal</span></button></div><pre class="term"></pre>`;
    c.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.classList.contains('term-more') || b.closest('.tests')) { return; } e.preventDefault();
      const sid = state.session && state.session.id;
      if (b.hasAttribute('data-copy')) { navigator.clipboard.writeText(a.command || '').then(() => toast('Command copied')); }
      else if (b.hasAttribute('data-copyout')) { navigator.clipboard.writeText(c.querySelector('.term').textContent).then(() => toast('Output copied')); }
      else if (b.hasAttribute('data-rerun') && sid) { post({ type: 'toolFailureAction', sessionId: sid, action: 'rerun', tool: 'run_command', args: JSON.stringify(a) }); b.disabled = true; toast(state.running.has(sid) ? 'Asked the agent to run it again' : 'Running it again…'); }
      else if (b.hasAttribute('data-openterm')) { post({ type: 'openInTerminal', sessionId: sid, command: a.command || '', cwd: cwd || undefined }); }
    };
    // Running (or detached): let the agent proceed while the command keeps going, or stop it.
    const ctl = el('span', 'cmdctl', `<button data-c="detach" title="Let the agent continue while the command keeps running; later output goes to a log the agent can read">${I.play}<span>Proceed While Running</span></button><button data-c="stop" title="Stop the command and everything it started">${I.stop}</button>`);
    ctl.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) { return; }
      e.preventDefault(); e.stopPropagation();
      if (s.dataset.callId) { post({ type: b.dataset.c === 'detach' ? 'detachCommand' : 'stopCommand', id: s.dataset.callId }); b.disabled = true; }
    };
    s.querySelector(':scope > summary .meta').before(ctl);
    setTermRow(s, result ? result.content : '', !result);
    setState(s, result ? (result.isError ? 'error' : 'ok') : 'running');
    return s;
  }
  /** Live output of a running command: the last 5 lines, expandable to all of it. */
  function termOutput(node, chunk) {
    if (!node || node.dataset.tool !== 'run_command' || !node.classList.contains('running')) { return; }
    node.__live = ((node.__live || '') + chunk).slice(-60000);
    if (!node.__autoOpen) { node.__autoOpen = true; node.__fill = null; node.open = true; }
    if (node.__raf) { return; }
    node.__raf = requestAnimationFrame(() => {
      node.__raf = 0;
      if (!node.classList.contains('running')) { return; }
      const pre = node.querySelector('.term'); if (!pre) { return; }
      const lines = node.__live.replace(/\n$/, '').split('\n');
      const full = node.dataset.full === '1';
      pre.textContent = (full ? lines : lines.slice(-5)).join('\n');
      let more = node.querySelector('.term-more');
      if (lines.length > 5) {
        if (!more) { more = el('button', 'term-more', ''); more.onclick = (e) => { e.preventDefault(); node.dataset.full = node.dataset.full === '1' ? '' : '1'; termOutput(node, ''); }; pre.before(more); }
        more.textContent = full ? 'Show last 5 lines' : `Show all ${lines.length} lines`;
      }
    });
  }
  /** Command states from the host (running / detached / done), kept so a late tool_end knows whether it was detached. */
  const cmdStates = new Map();
  const cmdLogs = new Map();
  function setCommandState(id, st, logPath) {
    if (st === 'done') { cmdStates.delete(id); cmdLogs.delete(id); } else { cmdStates.set(id, st); if (logPath) { cmdLogs.set(id, logPath); } }
    for (const node of document.querySelectorAll(`.step.term[data-call-id="${CSS.escape(id)}"]`)) { applyCommandState(node); }
  }
  /** Rows drawn after the state arrived (transcript redraws) pick it up here, so a detached command keeps its Stop control. */
  function applyCommandState(node) {
    const id = node.dataset.callId; const st = cmdStates.get(id); const logPath = cmdLogs.get(id);
    node.classList.toggle('detached', st === 'detached');
    if (st === 'detached' && logPath) { node.title = `Still running; output goes to ${logPath}`; } else if (!st) { node.removeAttribute('title'); }
  }
  function setTermRow(node, content, running) {
    const out = String(content || '').replace(/^\$ .*\n/, '').replace(/\n\[exit code [^\]]*\]$/, '');
    const pre = node.querySelector('.term');
    const more = node.querySelector('.term-more'); if (more && !running) { more.remove(); }
    lazyFill(node, () => { pre.innerHTML = running ? '<span class="muted">Running…</span>' : out ? ansiToHtml(out) : '<span class="muted">(no output)</span>'; });
    const m = /\[exit code (\d+|null)\]/.exec(String(content || ''));
    let n = 0; if (out) { for (let i = -1; (i = out.indexOf('\n', i + 1)) >= 0;) { n++; } n++; }
    const meta = node.querySelector(':scope > summary .meta');
    meta.innerHTML = running ? '' : `${n > 1 ? `<span class="lines">${n} lines</span>` : ''}${m ? `<span class="exit ${m[1] === '0' ? 'good' : 'bad'}">exit ${m[1]}</span>` : ''}`;
  }

  /** A test run's result on its command row: "6 passed · 1 failed", the failing tests first, Re-run failed / Fix failures. */
  function testSummary(node, t) {
    if (!node || !t || typeof t !== 'object') { return; }
    const n = (k) => Math.max(0, Number(k) || 0);
    const passed = n(t.passed), failed = n(t.failed), skipped = n(t.skipped);
    const meta = node.querySelector(':scope > summary .meta');
    const badge = `<span class="tests-badge" title="${esc(`${t.runner || 'Tests'}: ${passed} passed, ${failed} failed, ${skipped} skipped`)}">${failed ? `<b class="f">${failed} failed</b>` : ''}${failed && passed ? '<i>·</i>' : ''}${passed ? `<b class="p">${passed} passed</b>` : ''}${skipped ? `<i>·</i><b class="s">${skipped} skipped</b>` : ''}</span>`;
    if (meta) { const lines = meta.querySelector('.lines'); if (lines) { lines.remove(); } meta.insertAdjacentHTML('afterbegin', badge); }
    if (!failed) { return; }
    const rows = (Array.isArray(t.failures) ? t.failures : []).slice(0, 20);
    const box = el('div', 'tests', `<ul>${rows.map((f) => `<li><span class="x" aria-hidden="true">${I.x}</span><span class="tn" title="${esc(f.name || '')}">${short(f.name || 'test', 90)}</span>${f.file ? fchip(f.file, 'file', { line: f.line }) : ''}${f.message && f.message !== f.name ? `<span class="tm" title="${esc(f.message)}">${short(f.message, 140)}</span>` : ''}</li>`).join('')}${failed > rows.length ? `<li class="more">${failed - rows.length} more failing in the output below</li>` : ''}</ul><span class="tacts"><button class="btn sm" data-t="rerunFailed" title="Ask the agent to run only the failing tests again">${I.refresh}<span>Re-run failed</span></button><button class="btn sm ghost" data-t="fixFailures" title="Ask the agent to fix the failing tests and re-run them">${I.edit}<span>Fix failures</span></button><button class="link heal hidden" data-t="heal" title="Show the self-healing card">Self-healing is fixing this</button></span>`);
    const names = rows.map((f) => `${f.name || 'test'}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}${f.message && f.message !== f.name ? `: ${f.message}` : ''}`);
    box.onclick = (e) => {
      const b = e.target.closest('button[data-t]'); if (!b || b.disabled) { return; }
      e.preventDefault(); e.stopPropagation();
      if (b.dataset.t === 'heal') { const card = node.closest('.turn') && [...node.closest('.turn').querySelectorAll(':scope > .rec')].pop(); if (card) { card.scrollIntoView({ block: 'center', behavior: calmMotion() ? 'auto' : 'smooth' }); } return; }
      const sid = state.session && state.session.id; if (!sid) { return; }
      post({ type: 'toolFailureAction', sessionId: sid, action: b.dataset.t, tool: 'run_command', args: node.dataset.args || '{}', tests: names });
      b.disabled = true;
    };
    const c = node.querySelector(':scope > .content'); const pre = c && c.querySelector('.term');
    if (pre) { pre.before(box); } else if (c) { c.appendChild(box); }
    node.classList.add('has-tests');
    syncHealLink(node);
  }
  /** "Self-healing is fixing this" shows on a failing test row once a recovery card is running in the same turn. */
  function syncHealLink(node) {
    const link = node.querySelector('.tests .heal'); const turn = node.closest('.turn'); if (!link || !turn) { return; }
    link.classList.toggle('hidden', !turn.querySelector(':scope > .rec.running'));
  }

  // Subagent pill: "agent · task · model" with its own nested step rows streaming underneath.
  function modelName(ref) { const m = state.models.find((x) => x.id === ref); const n = m ? m.name : ref ? String(ref).split('/').pop() : ''; return n.replace(/[-_:]?(instruct|chat)\b/i, ''); }
  function subagentCard(agent, prompt, model, label) {
    const d = stepEl('subagent running', '');
    d.__ico = I.agent; d.dataset.calls = '0'; d.dataset.pending = '1'; d.dataset.agent = agent || ''; d.dataset.label = label || ''; d.__prompt = prompt || label || '';
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
    const sid = state.session && state.session.id;
    if (error && sid && state.running.has(sid)) { laneRetry(d, error, sid); }
  }
  /** A failed worker lane gets Retry: the agent delegates the same task again (a steer while running, else a new turn). */
  function laneRetry(d, error, sid) {
    if (!d || /^(Cancelled|Stopped)\b/i.test(String(error || '')) || d.querySelector(':scope > summary .lane-retry') || !d.__prompt) { return; }
    const b = el('button', 'lane-retry', `${I.refresh}<span>Retry</span>`); b.type = 'button'; b.title = `Run this ${d.dataset.agent || 'worker'} task again`; b.setAttribute('aria-label', `Retry the ${d.dataset.agent || 'worker'} task`);
    b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); post({ type: 'toolFailureAction', sessionId: sid, action: 'retry', tool: 'run_subagent', args: JSON.stringify({ agent: d.dataset.agent || '', prompt: d.__prompt }), error: String(error).slice(0, 2000) }); b.disabled = true; };
    d.querySelector(':scope > summary .chev').before(b);
  }
  /** Host step for run_parallel_subagents while live: a queued lane per task becomes the child's pill as it starts. */
  /** Workers card ("4 working · Stop all"): one row per background worker with its current step; rows expand to the full trace. */
  function subHost(name, a, tasks) {
    const list = tasks || a.tasks || [];
    const n = list.length;
    const d = stepEl('step subhost workers running', `<b>${n} working</b>`, undefined, '');
    d.__ico = I.layers; d.dataset.total = String(n); d.dataset.done = '0'; d.dataset.tool = name; d.dataset.args = JSON.stringify(a || {});
    const ctl = el('span', 'lanectl host', `<button data-c="stopall" title="Stop every worker in this batch">${I.stop}<span>Stop all</span></button>`);
    ctl.onclick = (e) => { const b = e.target.closest('button'); if (!b) { return; } e.preventDefault(); e.stopPropagation(); const sid = state.session && state.session.id; const live = sid && state.live.get(sid); if (!live) { return; } for (const [childId, node] of live.subs) { if (d.contains(node) && node.classList.contains('running')) { post({ type: 'stopChild', sessionId: sid, childId }); } } };
    d.querySelector(':scope > summary .chev').before(ctl);
    const c = d.querySelector(':scope > .content'); c.className = 'content subs'; c.innerHTML = '';
    for (const t of list) { const lane = el('div', 'lane pending', `<span class="ico"><span class="dot idle"></span></span><span class="pill"><span class="pico">${I.agent}</span><b class="who">${esc(t.agent || 'explore')}</b></span><span class="what">${short(t.prompt, 90)}</span>`); lane.dataset.what = String(t.prompt || ''); lane.title = String(t.prompt || ''); c.appendChild(lane); }
    hostProgress(d);
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
    const d = stepEl(`step subhost workers ${failed === sections.length ? 'error' : 'ok'}`, `<b>${sections.length} done</b>${failed ? `<span class="muted"> · ${failed} failed</span>` : ''}`, undefined, '');
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
  function hostCounts(host) {
    const c = host.querySelector(':scope > .content');
    return { running: c ? c.querySelectorAll(':scope > .step.subagent.running').length : 0, queued: c ? c.querySelectorAll(':scope > .lane.pending').length : 0, done: Number(host.dataset.done || 0) };
  }
  function hostProgress(host) {
    const label = host.querySelector(':scope > summary .label'); const meta = host.querySelector(':scope > summary .meta');
    if (!host.classList.contains('running')) { return; }
    const { running, queued, done } = hostCounts(host);
    const failed = host.querySelectorAll(':scope > .content > .step.subagent.error').length;
    const extra = [queued && `${queued} queued`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(' · ');
    if (label) { label.innerHTML = `<b>${running ? `${running} working` : queued ? 'Starting workers' : 'Finishing'}</b>${extra ? `<span class="muted"> · ${extra}</span>` : ''}`; }
    if (meta) { meta.textContent = ''; }
  }
  /** Tool label as plain text: drops the language badge inside file chips, then all markup. */
  function plainLabel(html) { return String(html).replace(/<i class="lang[^"]*">[^<]*<\/i>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }
  /** Current step of a worker, shown on its row like Cursor's "Exploring challenge codebase structure". */
  function laneNow(sub, text) { const m = sub.querySelector(':scope > summary .meta'); if (!m) { return; } const steps = Number(sub.dataset.calls || 0); m.innerHTML = `<span class="now">${esc(text)}</span>${steps ? `<span class="muted"> · ${steps} step${steps === 1 ? '' : 's'}</span>` : ''}`; }
  /** "2 workers running · 1 done" for the status line while a Workers card is live — the lanes carry each worker's own step. */
  function workersSummary(host) { const { running, queued, done } = hostCounts(host); return [`${running} worker${running === 1 ? '' : 's'} running`, queued && `${queued} queued`, done && `${done} done`].filter(Boolean).join(' · '); }
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
    if (tc.name === 'run_command') { const s = termRow(a, result); s.dataset.callId = tc.id; applyCommandState(s); if (result && result.tests) { testSummary(s, result.tests); } container.appendChild(s); return s; }
    if (tc.name === 'run_parallel_subagents' && !result) { const h = subHost(tc.name, a); h.dataset.callId = tc.id; container.appendChild(h); return h; }
    if ((tc.name === 'run_parallel_subagents' || tc.name === 'run_todos_parallel') && result) { const h = subHostSettled(tc.name, a, result); if (h) { h.dataset.callId = tc.id; container.appendChild(h); return h; } }
    if (tc.name === 'run_todos_parallel' && !result) {
      const wanted = Array.isArray(a.ids) ? new Set(a.ids.map(String)) : null;
      const tasks = (state.session && Array.isArray(state.session.todos) ? state.session.todos : []).filter((t) => t.agent && t.status !== 'done' && (!wanted || wanted.has(String(t.id)))).map((t) => ({ agent: t.agent, prompt: t.title }));
      const h = subHost(tc.name, a, tasks); h.dataset.callId = tc.id; container.appendChild(h); return h;
    }
    if (tc.name === 'run_subagent') { const c = subagentCard(a.agent, a.prompt, a.model); c.dataset.callId = tc.id; if (result) { finishSubagent(c, result.isError ? '' : result.content, result.isError ? result.content : ''); c.open = false; } container.appendChild(c); return c; }
    const s = stepEl(`step ${result ? (result.isError ? 'error' : 'ok') : 'running'}`, toolLabel(tc.name, a, !result));
    s.__ico = toolIcon(tc.name); s.dataset.tool = tc.name; s.dataset.callId = tc.id; s.dataset.args = tc.arguments || '{}';
    toolContent(s, tc.name, a, result ? result.content : '', !result, result);
    if (result && result.image) { s.open = true; }
    setState(s, result ? (result.isError ? 'error' : 'ok') : 'running');
    if (EXPLORE_TOOLS.has(tc.name)) { foldExplore(container, s); } else { container.appendChild(s); }
    return s;
  }
  // Explore group: a burst of reads/searches folds into one row — "Read a.ts, b.ts +2 more · searched 3 times" — instead of a
  // stack of near-identical lines (Copilot/Cursor style). Grouping starts at the second consecutive explore row; each row keeps
  // its own expandable details inside the group.
  function foldExplore(container, row) {
    const prev = container.lastElementChild;
    if (prev && prev.classList.contains('explore')) { prev.querySelector(':scope > .content').appendChild(row); updateExploreGroup(prev); return; }
    if (prev && prev.classList.contains('step') && EXPLORE_TOOLS.has(prev.dataset.tool)) {
      const g = stepEl('step explore running', '<b>Exploring</b>…'); g.__ico = I.search;
      const c = g.querySelector(':scope > .content'); c.className = 'content rows'; c.innerHTML = '';
      container.replaceChild(g, prev); c.appendChild(prev); c.appendChild(row);
      updateExploreGroup(g);
      return;
    }
    container.appendChild(row);
  }
  function updateExploreGroup(g) {
    const rows = [...g.querySelectorAll(':scope > .content > .step')]; if (!rows.length) { return; }
    const running = rows.some((r) => r.classList.contains('running')); const errs = rows.filter((r) => r.classList.contains('error')).length;
    const files = []; let searches = 0, folders = 0, symbols = 0, web = 0, checks = 0, other = 0;
    for (const r of rows) {
      const a = parseArgs(r.dataset.args || '{}');
      switch (r.dataset.tool) {
        case 'read_file': case 'read_pdf': if (a.path && !files.includes(a.path)) { files.push(a.path); } break;
        case 'list_dir': folders++; break;
        case 'grep_search': case 'file_search': searches++; break;
        case 'find_symbol': case 'find_references': case 'repo_graph': symbols++; break;
        case 'web_search': case 'web_fetch': web++; break;
        case 'get_diagnostics': checks++; break;
        default: other++;
      }
    }
    const n = (k, one, many) => `${k} ${k === 1 ? one : many || `${one}s`}`;
    const parts = [];
    if (running) {
      const v = (now) => `<b>${now}</b>`;
      if (files.length) { parts.push(`${v('Reading')} ${files.slice(0, 3).map((p) => fchip(p)).join(' ')}${files.length > 3 ? ` <span class="muted">+${files.length - 3} more</span>` : ''}`); }
      if (searches) { parts.push(`${v('Searching')} ${searches === 1 ? 'once' : `${searches} times`}`); }
      if (folders) { parts.push(`${v('Listing')} ${n(folders, 'folder')}`); }
      if (symbols) { parts.push(`${v('Looking up')} ${n(symbols, 'symbol')}`); }
      if (web) { parts.push(`${v('Researching')} the web`); }
      if (checks) { parts.push(`${v('Checking')} problems`); }
      if (other) { parts.push(`${v('Gathering')} context`); }
    } else {
      // Settled: one compact line — "Explored 7 files · 3 searches" — the rows stay one click away.
      const few = files.length && files.length <= 2;
      const what = [few ? files.map((p) => fchip(p)).join(' ') : files.length ? n(files.length, 'file') : '', searches && n(searches, 'search', 'searches'), folders && n(folders, 'folder'), symbols && n(symbols, 'symbol'), web && n(web, 'web lookup'), checks && 'problems'].filter(Boolean);
      parts.push(`<b>Explored</b> ${what.length ? what.join(' <i class="dot">·</i> ') : n(rows.length, 'step')}`);
    }
    g.querySelector(':scope > summary .label').innerHTML = parts.join(' <i class="dot">·</i> ');
    g.querySelector(':scope > summary .meta').textContent = `${rows.length} steps`;
    g.querySelector(':scope > summary').title = files.join('\n');
    setState(g, running ? 'running' : errs === rows.length ? 'error' : 'ok');
  }
  function finishTool(node, payload, sid) {
    if (!node) { return; }
    const ok = !payload.isError;
    const cancelled = isCancelled(payload);
    node.__t0 = 0; node.classList.remove('slow'); if (node.title === SLOW_TIP) { node.removeAttribute('title'); }
    const secs = payload.cached ? 'cached' : payload.durationMs > 800 ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
    if (node.classList.contains('subhost')) {
      setState(node, ok ? 'ok' : 'error');
      const total = Number(node.dataset.total || 0); const failed = node.querySelectorAll(':scope > .content > .step.subagent.error').length;
      node.querySelector(':scope > summary .label').innerHTML = total ? `<b>${total} done</b>${failed ? `<span class="muted"> · ${failed} failed</span>` : ''}` : toolLabel(node.dataset.tool, parseArgs(node.dataset.args || '{}'), false);
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
      if (cancelled) { markCancelled(node); } else if (!ok && !isDenied(payload)) { failBar(node, payload.content, sid); } else if (ok) { noteRetried(node); }
      return;
    }
    setState(node, ok ? 'ok' : 'error');
    const args = parseArgs(node.dataset.args || '{}');
    node.querySelector(':scope > summary .label').innerHTML = toolLabel(node.dataset.tool, args, false);
    if (node.dataset.tool === 'run_command') {
      setTermRow(node, payload.content || '', false);
      node.classList.toggle('detached', cmdStates.get(node.dataset.callId) === 'detached');
      const tests = (payload.data && payload.data.tests) || payload.tests;
      if (tests) { testSummary(node, tests); }
      if (cancelled) { markCancelled(node); return; }
      if (!ok) { node.open = true; } else if (node.__autoOpen) { node.open = false; }
      // While the run goes on, a failed command is the agent's next input: say so (finishLive turns it into "run stopped").
      const exit = /\[exit code (\d+)\]\s*$/.exec(String(payload.content || ''));
      if (!ok && exit && exit[1] !== '0' && sid && state.running.has(sid) && !isDenied(payload)) {
        const next = el('div', 'term-next', `Exit ${esc(exit[1])}<i>·</i><span>${tests && tests.failed ? 'the agent will read the failures and try a fix' : 'the agent will read the output and try a fix'}</span>`); next.dataset.live = '1';
        const c = node.querySelector(':scope > .content'); if (c) { c.appendChild(next); }
      }
      if (ok) { noteRetried(node); } else if (!isDenied(payload) && !(exit && sid && state.running.has(sid))) { failBar(node, payload.content, sid); }
      return;
    }
    toolContent(node, node.dataset.tool, args, payload.content || '', false, payload);
    if (payload.data && payload.data.image) { node.open = true; }
    // MCP results up to 20 lines (or with images) show open; longer ones stay collapsed.
    if (/^mcp_/.test(node.dataset.tool) && ok && ((payload.data && payload.data.images) || String(payload.content || '').split('\n').length <= 20)) { node.open = true; }
    node.querySelector(':scope > summary .meta').textContent = secs;
    const group = node.parentElement && node.parentElement.closest('.step.explore');
    if (group) { updateExploreGroup(group); }
    if (cancelled) { markCancelled(node); } else if (!ok && !isDenied(payload)) { failBar(node, payload.content, sid); } else if (ok) { noteRetried(node); }
  }

  // ------------------------------------------------------------------ transcript rendering
  /** "Restore checkpoint" is enabled where there is something to restore: a git checkpoint taken before this turn, or file
   *  snapshots of this turn or a later one. Hidden in worktree chats; with checkpoints off, a click opens the setting. */
  function syncRestoreButton(turn, sid) {
    const b = turn.querySelector('[data-act="restore"]'); if (!b) { return; }
    const has = turn.dataset.checkpoint !== undefined;
    const key = Number(turn.dataset.checkpoint);
    b.classList.toggle('hidden', !sid || state.worktree.has(sid) || !has);
    const ok = has && ((state.gitCheckpoints.get(sid) || []).includes(key) || (state.checkpoints.get(sid) || []).some((t) => t >= key));
    const off = !ok && !state.checkpointsOn;
    // aria-disabled rather than disabled: the tooltip saying why stays reachable by hover and keyboard.
    b.disabled = false; b.classList.toggle('off', off); b.setAttribute('aria-disabled', String(!ok));
    b.title = ok ? 'Restore checkpoint: files only, the chat only, or both'
      : off ? 'No checkpoint for this message: checkpoints are off (localpilot.checkpoints.enabled). Click to open the setting.'
        : 'No checkpoint for this message: nothing was recorded before it ran, or it was already restored';
  }
  /** Files only / chat only / both, for the user message at `index`. */
  function restoreMenu(btn, index) {
    if (!state.session) { return; }
    if (btn.classList.contains('off')) { post({ type: 'openCheckpointSetting' }); return; }
    if (btn.getAttribute('aria-disabled') === 'true') { return; }
    const sid = state.session.id;
    const go = (restoreType) => post({ type: 'restoreCheckpoint', sessionId: sid, messageIndex: index, restoreType });
    openMenu(btn, [
      { label: 'Restore files only', desc: 'Put the files back as they were before this message; keep the chat', icon: I.file, onPick: () => go('workspace') },
      { label: 'Restore chat only', desc: 'Remove this message and later turns; keep the files as they are', icon: I.edit, onPick: () => go('task') },
      { label: 'Restore both', desc: 'Put the files back and rewind the chat to this message', icon: I.restore, onPick: () => go('both') },
    ]);
  }
  function userTurn(m, index) {
    const d = el('div', 'turn user');
    d.dataset.index = index;
    const atts = [];
    const text = (m.meta && m.meta.display ? m.meta.display : m.content)
      .replace(/<attachment[^>]*path="([^"]+)"(?:\s+kind="pdf"\s+pages="(\d+(?:-\d+)?) of (\d+)")?(?:\s+lines="(\d+)[^"]*")?[^>]*>[\s\S]*?<\/attachment>\s*/g, (_, p, pg, n, ln) => { atts.push(pg && pg !== `1-${n}` && !(n === '1' && pg === '1') ? `${p}#page=${pg}` : ln ? `${p}#L${ln}` : p); return ''; })
      .replace(/<(workspace_tree|problems|git|open_editors|directory|terminal_output)[^>]*>[\s\S]*?<\/\1>\s*/g, (_, t) => { atts.push('@' + (t === 'workspace_tree' ? 'workspace' : t === 'open_editors' ? 'editors' : t === 'terminal_output' ? 'terminal' : t)); return ''; })
      .replace(/\n\n\[\d+ images? attached\]$/, '');
    const act = el('div', 'actions', `<button data-act="copy" title="Copy" aria-label="Copy message">${I.copy}</button>${index !== undefined ? `<button data-act="edit" title="Edit this message here, then Reset Chat (keep the files) or Reset Code (also restore the files)" aria-label="Edit message">${I.edit}<span>Edit</span></button><button data-act="restore" title="Restore checkpoint: files only, the chat only, or both" aria-label="Restore checkpoint" aria-haspopup="listbox">${I.restore}<span>Restore checkpoint</span></button>` : ''}`);
    if (m.meta && m.meta.checkpoint !== undefined) { d.dataset.checkpoint = m.meta.checkpoint; }
    act.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) { return; }
      if (b.dataset.act === 'copy') { copyTo(b, text); }
      if (b.dataset.act === 'edit') { inlineEdit(d, m, index, text); }
      if (b.dataset.act === 'restore') { restoreMenu(b, index); }
    };
    d.appendChild(act);
    syncRestoreButton(d, state.session && state.session.id);
    if (atts.length) { d.appendChild(el('div', 'att', atts.map(attChip).join(''))); }
    if (m.images && m.images.length) { d.appendChild(el('div', 'imgs', m.images.map((b64, k) => `<img src="data:image/png;base64,${b64}" alt="Image ${k + 1} of ${m.images.length}" title="Click to enlarge">`).join(''))); }
    const ut = el('div', 'utext', inline(text)); d.appendChild(ut);
    // Clicking the text of a sent message edits it (links, paths and a text selection keep their own meaning).
    if (index !== undefined) { ut.classList.add('editable'); ut.onclick = (e) => { if (e.target.closest('a, .path-link, code') || String(window.getSelection() || '')) { return; } inlineEdit(d, m, index, text); }; }
    if (m.meta && m.meta.corrections && m.meta.corrections.length) { d.appendChild(correctionNote(m.meta.corrections)); }
    return d;
  }
  /** Answers to `checkpointExists`, keyed `<session>:<index>`, for the inline editors waiting on them. */
  const editChecks = new Map();
  /** Edits a sent message in place. Nothing is cut until Reset Chat (rewind and resend, files kept) or Reset Code (also
   *  put the files back to the checkpoint before this message); Esc or Cancel leaves the chat as it was. */
  function inlineEdit(d, m, index, text) {
    if (!state.session || index === undefined || d.classList.contains('editing')) { return; }
    const sid = state.session.id; const key = `${sid}:${index}`;
    const draft = { images: (m.images || []).map((x) => String(x).replace(/^data:[^,]*,/, '')), attachments: null };
    const box = el('div', 'uedit', `<textarea rows="2" aria-label="Edit message"></textarea><div class="uedit-chips"></div><div class="uedit-bar"><span class="hint">Esc to cancel</span><button class="btn ghost" data-e="cancel">Cancel</button><button class="btn" data-e="chat" disabled title="Rewind the chat to this message and send the edit; files stay as they are">Reset Chat</button><button class="btn primary" data-e="code" disabled aria-busy="true" title="Checking for a checkpoint…">${I.spin}<span>Reset Code</span></button></div>`);
    const ta = box.querySelector('textarea'); const chips = box.querySelector('.uedit-chips');
    const chatB = box.querySelector('[data-e="chat"]'); const codeB = box.querySelector('[data-e="code"]');
    ta.value = text.trim();
    let touched = false; let canCode = false; let busy = false;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; };
    const chipsHtml = () => {
      chips.innerHTML = '';
      (draft.attachments || []).forEach((a, i) => { const c = el('span', 'chip', `${a.startsWith('@') ? I.list : I.file}<span title="${esc(a)}">${esc(a.replace(/^@/, ''))}</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { draft.attachments.splice(i, 1); chipsHtml(); sync(); }; chips.appendChild(c); });
      draft.images.forEach((b64, i) => { const c = el('span', 'chip img', `<img src="data:image/png;base64,${b64}" alt=""><span>image-${i + 1}.png</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { draft.images.splice(i, 1); chipsHtml(); sync(); }; chips.appendChild(c); });
      chips.classList.toggle('hidden', !chips.children.length);
    };
    const sync = () => {
      const empty = !ta.value.trim() && !draft.images.length;
      const ready = draft.attachments !== null && !busy;
      chatB.disabled = empty || !ready; codeB.disabled = empty || !ready || !canCode;
    };
    const close = () => { editChecks.delete(key); box.remove(); d.classList.remove('editing'); };
    const submit = (restoreWorkspace) => {
      if (busy || (restoreWorkspace ? codeB.disabled : chatB.disabled)) { if (!ta.value.trim() && !draft.images.length) { toast('The edited message is empty — type something or press Esc to cancel', 'error'); } return; }
      busy = true; sync(); box.classList.add('busy');
      check.release = () => { busy = false; box.classList.remove('busy'); sync(); };
      post({ type: 'editAndRegenerate', sessionId: sid, index, text: ta.value.trim(), images: draft.images.length ? draft.images : undefined, attachments: draft.attachments || [], restoreWorkspace });
    };
    const check = {
      done: (r) => {
        draft.attachments = (r.attachments || []).slice();
        if (!touched && typeof r.text === 'string') { ta.value = r.text; grow(); }
        canCode = !!r.exists; codeB.removeAttribute('aria-busy'); codeB.innerHTML = '<span>Reset Code</span>';
        codeB.title = r.exists ? 'Put the files back as they were before this message, rewind the chat and send the edit' : `${r.reason || 'No checkpoint for this message'} — Reset Code is unavailable`;
        chipsHtml(); sync();
      },
      release: null,
    };
    editChecks.set(key, check);
    ta.addEventListener('input', () => { touched = true; grow(); sync(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(false); }
    });
    box.onclick = (e) => { const b = e.target.closest('[data-e]'); if (!b) { return; } if (b.dataset.e === 'cancel') { close(); } else { submit(b.dataset.e === 'code'); } };
    d.classList.add('editing'); d.appendChild(box); chipsHtml(); grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    post({ type: 'checkpointExists', sessionId: sid, index });
  }
  /** "Corrected dicee.py → dice.py": names in the request that were matched to the real ones in the workspace. */
  function correctionNote(fixes) {
    const n = el('div', 'corrected', `${I.check}<span>Corrected ${fixes.map((f) => `<code>${esc(f.from)}</code> → <code>${esc(f.to)}</code>`).join(', ')}</span>`);
    n.title = 'Misspelled names were matched to files and identifiers in your workspace before the agent started (localpilot.prompts.autoCorrect)';
    return n;
  }
  function assistantTurn(m, results) {
    const d = el('div', 'turn assistant');
    const steps = el('div', 'steps');
    if (m.thinking) { steps.appendChild(thinkingRow(m.thinking, 0, false)); }
    for (const tc of m.toolCalls || []) { const r = results.get(tc.id) || { content: '(no result)', isError: false }; const node = placeTool(steps, tc, r); if (isDenied(r)) { markDenied(node); } else if (isCancelled(r)) { markCancelled(node); } else if (node && r.isError) { node.__err = r.content; } }
    if (steps.children.length) { d.appendChild(steps); }
    const err = m.meta && m.meta.error;
    if (err) {
      // A failed turn: any partial answer, then the same error box the live turn showed (actions added on the latest turn).
      const partial = m.content && m.content.trim() && m.content !== `(error: ${err})` ? m.content : '';
      if (partial) { d.appendChild(el('div', 'body', renderMarkdown(partial))); }
      d.appendChild(errorBox(err));
      return d;
    }
    // Self-healing's footer ("Verified: …", "Incomplete: …") is drawn as its card, not repeated at the end of the answer.
    const report = m.meta && m.meta.healing && typeof m.meta.healing.report === 'string' && m.meta.healing.report.trim();
    const content = report && m.content && m.content.trimEnd().endsWith(report) ? m.content.trimEnd().slice(0, -report.length).trimEnd() : m.content;
    if (content && content.trim()) {
      const body = el('div', 'body', renderMarkdown(content)); d.appendChild(body);
      // Long or structured answers read better in the dedicated Markdown reader.
      const long = content.length > 600 || /^#{1,3}\s/m.test(content) || /^\|.*\|$/m.test(content);
      if (report) { d.appendChild(recSettled(state.session ? state.session.id : '', null, report)); }
      d.appendChild(answerFoot(m, long));
    } else if (report) { d.appendChild(recSettled(state.session ? state.session.id : '', null, report)); }
    return d.children.length ? d : null;
  }
  /** Under every answer: which model replied and how fast (from the turn's meta), then Copy / Regenerate / Open as
   *  document — always visible, so nothing depends on hovering. Regenerate is added to the latest answer by renderSession. */
  function answerFoot(m, long) {
    const mt = m.meta || {};
    const info = [];
    if (mt.model) { info.push(`<span class="mdl" title="Answered by ${esc(mt.model)}">${esc(modelName(mt.model))}</span>`); }
    const out = mt.healing && reportOutcome(mt.healing.report); if (BADGE[out]) { info.unshift(outcomeBadge(out, mt.healing.report)); }
    if (mt.outputTokens && mt.genMs > 250) { info.push(`<span title="${mt.outputTokens.toLocaleString()} tokens generated in ${(mt.genMs / 1000).toFixed(1)}s">${Math.round(mt.outputTokens / (mt.genMs / 1000))} tok/s</span>`); }
    const f = el('div', 'afoot', `<span class="info">${info.join('<i>·</i>')}</span><span class="acts"><button data-act="copy" title="Copy response" aria-label="Copy response">${I.copy}</button>${long ? `<button data-act="doc" title="Open as document in the Markdown reader" aria-label="Open as document">${I.open}</button>` : ''}</span>`);
    f.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) { return; }
      if (b.dataset.act === 'doc') { post({ type: 'openMarkdown', text: m.content, title: state.session && state.session.title }); }
      else if (b.dataset.act === 'copy') { copyTo(b, m.content); }
      else if (b.dataset.act === 'regen' && state.session && !state.running.has(state.session.id)) { b.disabled = true; post({ type: 'retry', sessionId: state.session.id }); }
      else if (b.dataset.act === 'viewChanges' && state.session) { post({ type: 'review', sessionId: state.session.id, scope: 'turn' }); }
      else if (b.dataset.act === 'viewChangesDiff' && state.session) { post({ type: 'viewChanges', sessionId: state.session.id, scope: 'turn' }); }
    };
    return f;
  }
  /**
   * The fix for a failed turn, by error kind: start Ollama or open the model settings when the server is unreachable,
   * set the API key when it was rejected, compact and retry when the prompt was too long; Retry otherwise. Change model
   * stays the secondary action and Show log is always there.
   */
  function errorActions(box, sid) {
    if (box.dataset.kind === 'mistake_limit') { mistakeActions(box, sid); return; }
    const kind = box.dataset.kind || '', ollama = box.dataset.provider === 'ollama';
    const fix = kind === 'connection' ? (ollama ? { a: 'ollama', icon: I.play, label: 'Start Ollama', title: 'Start the local Ollama server (and pull a model if none is installed), then Retry' } : { a: 'models', icon: I.gear, label: 'Open model settings', title: 'Check the model server and its models in Settings, then Retry' })
      : kind === 'auth' ? { a: 'key', icon: I.key, label: 'Set API key…', title: 'Enter a valid API key in Settings → Providers, then Retry' }
      : kind === 'quota' ? { a: 'key', icon: I.key, label: 'Provider settings…', title: 'Check the account or key in Settings → Providers, or pick another model' }
      : kind === 'context' ? { a: 'compact', icon: I.layers, label: 'Compact and retry', title: 'Summarise older messages to make room, then send the last message again' }
      : null;
    const retryBtn = `<button class="btn sm ${fix ? '' : 'primary'}" data-a="retry" title="Send the last message again">${I.refresh}<span>Retry</span></button>`;
    const raise = kind === 'context' ? `<button class="btn sm ghost" data-a="ctxwin" title="Settings → Models → Context window: give the model a larger window">${I.gear}<span>Raise context window</span></button>` : '';
    const acts = el('span', 'err-acts', `<button class="btn sm ghost" data-a="log" title="Open the LocalPilot log" aria-label="Show log">${I.file}<span>Show log</span></button>${raise}<button class="btn sm" data-a="model" title="Pick another model for this chat, then Retry" aria-label="Change model">${I.layers}<span>Change model</span></button>${fix && fix.a !== 'compact' ? retryBtn : ''}${fix ? `<button class="btn sm primary" data-a="${fix.a}" title="${esc(fix.title)}">${fix.icon}<span>${esc(fix.label)}</span></button>` : retryBtn}`);
    // Rate limited: Retry counts down the moment the server is likely to accept requests again.
    if (kind === 'ratelimit') {
      const span = acts.querySelector('[data-a="retry"] span'); let left = 10;
      const tick = () => { if (!span.isConnected && left < 10) { return; } span.textContent = left > 0 ? `Retry in ${left}s` : 'Retry'; if (left-- > 0) { setTimeout(tick, 1000); } };
      tick();
    }
    acts.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) { return; }
      const a = b.dataset.a;
      if (a === 'log') { post({ type: 'showLog' }); return; }
      if (state.running.has(sid)) { return; }
      if (a === 'retry') { b.disabled = true; b.classList.add('busy'); post({ type: 'retry', sessionId: sid }); }
      else if (a === 'compact') { b.disabled = true; b.classList.add('busy'); post({ type: 'compactNow', sessionId: sid, retry: true }); }
      else if (a === 'ollama') { post({ type: 'autoSetupModels' }); }
      else if (a === 'models') { post({ type: 'openSettings', section: 'models' }); }
      // Deep links: the chat's provider card opens with its key field focused; the context window setting is highlighted.
      else if (a === 'key') { const cm = currentModel(); post({ type: 'openSettings', section: 'providers', ...(cm ? { expand: cm.providerId } : {}) }); }
      else if (a === 'ctxwin') { post({ type: 'openSettings', section: 'models', key: 'contextWindow' }); }
      else { els.modelBtn.click(); }
    };
    box.appendChild(acts);
  }
  /** The mistake limit: Continue with guidance (a short note, sent as the next message), Restore checkpoint, Show log. */
  function mistakeActions(box, sid) {
    const acts = el('span', 'err-acts', `<button class="btn sm ghost" data-a="log" title="Open the LocalPilot log">${I.file}<span>Show log</span></button><button class="btn sm" data-a="restore" title="Put the files and the chat back as they were before your last message">${I.restore}<span>Restore checkpoint</span></button><button class="btn sm primary" data-a="guide" title="Tell LocalPilot what to do differently; it continues from here">${I.play}<span>Continue with guidance</span></button>`);
    acts.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) { return; }
      if (b.dataset.a === 'log') { post({ type: 'showLog' }); return; }
      if (state.running.has(sid)) { return; }
      if (b.dataset.a === 'restore') { b.disabled = true; post({ type: 'runAction', sessionId: sid, action: 'restore' }); return; }
      let form = box.querySelector('.err-guide');
      if (!form) {
        form = el('form', 'err-guide rec-guide', '<input type="text" placeholder="What should LocalPilot do differently?" aria-label="Guidance to continue with"><button class="btn sm primary" type="submit">Continue</button><button class="btn sm ghost" type="button" data-x="1">Cancel</button>');
        form.onsubmit = (ev) => { ev.preventDefault(); const t = form.querySelector('input').value.trim(); if (!t || !state.session || state.session.id !== sid) { return; } els.input.value = t; autoGrow(); updateSendEnabled(); sendCurrent(); form.remove(); };
        form.querySelector('[data-x]').onclick = () => form.remove();
        box.appendChild(form);
      }
      form.querySelector('input').focus();
    };
    box.appendChild(acts);
  }
  /** Copy with feedback on the button itself (icon → check for a moment); a toast only if the clipboard refuses. */
  function copyTo(btn, text) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn.dataset.html) { btn.dataset.html = btn.innerHTML; }
      btn.innerHTML = btn.dataset.html.replace(/<svg[\s\S]*?<\/svg>/, I.check).replace(/>Copy</, '>Copied<'); btn.classList.add('copied');
      clearTimeout(btn._t); btn._t = setTimeout(() => { btn.innerHTML = btn.dataset.html; btn.classList.remove('copied'); }, 1400);
    }, () => toast('Could not copy to the clipboard', 'error'));
  }
  function renderSession() {
    const s = state.session;
    // Same-session refreshes (mode/model change, compaction, restore) must not lose the reader's place.
    const same = s && els.messages.dataset.sid === s.id;
    const m = els.messages;
    const stick = !same || m.scrollHeight - m.scrollTop - m.clientHeight < 160;
    const y = m.scrollTop;
    const open = same ? [...m.querySelectorAll('details')].map((d, i) => (d.open ? i : -1)).filter((i) => i >= 0) : [];
    if (!same) { const cr = document.querySelector('.confirm-row'); if (cr) { cr.remove(); } }
    els.messages.innerHTML = '';
    els.messages.dataset.sid = s ? s.id : '';
    if (!s) { return; }
    syncMode(); syncModel(); syncSkills(); updateCtx();
    // While the agent runs, the messages it has appended so far are drawn by the live turn (built from the event
    // stream, replayed on reopen) — drawing them from the transcript as well showed every step twice after a tab switch.
    const inFlight = state.running.has(s.id) || state.live.has(s.id) || state.pendingSend.has(s.id);
    if (!s.messages.length && !inFlight) { renderEmpty(); }
    const results = new Map();
    for (const m of s.messages) {
      if (m.role === 'tool' && m.toolCallId) { results.set(m.toolCallId, { content: m.content, isError: (m.meta && m.meta.failed) || /^(Tool .* failed|User declined|The user (denied|declined)|Error|Cancelled|Not run: the user stopped|old_text not found)/i.test(m.content) || /\[exit code [1-9]/.test(m.content), ...(m.meta && m.meta.tests ? { tests: m.meta.tests } : {}) }); }
      // Text-protocol models get every result of a step in one user message: split it back into the tool rows' results.
      if (m.role === 'user' && m.meta && m.meta.toolResults) { const parts = [...m.content.matchAll(/<tool_result name="[^"]*">\n?([\s\S]*?)\n?<\/tool_result>/g)].map((x) => x[1]); m.meta.toolResults.forEach((id, k) => { const c = parts[k]; if (c !== undefined) { results.set(id, { content: c, isError: /^(Tool .* failed|User declined|The user (denied|declined)|Error|Cancelled|old_text not found)/i.test(c) || /\[exit code [1-9]/.test(c) }); } }); }
      // Images captured by tools travel in a user-role carrier message; attach them to the originating step instead of showing a bubble.
      if (m.role === 'user' && m.meta && m.meta.toolImages && m.images) { m.meta.toolImages.forEach((id, k) => { const r = results.get(id) || { content: '', isError: false }; r.image = { data: m.images[k], mime: 'image/png' }; results.set(id, r); }); }
    }
    // Each settled assistant turn gets the same "Worked for …" strip it had live, computed from its rows and the timestamps.
    let cur = null;
    const settleReplay = () => {
      if (!cur) { return; }
      const st = turnStats(cur.el);
      if (st.steps || st.workers) { const w = workStrip(); cur.el.insertBefore(w, cur.el.firstChild); settleWork(cur.el, w, st, cur.dur || (cur.end && cur.start ? cur.end - cur.start : 0), false, cur.stopped); }
      if (cur.stopped) { cur.el.classList.add('stopped'); }
      cur = null;
    };
    const cutoff = inFlight && typeof s.liveFrom === 'number' ? s.liveFrom : s.messages.length;
    s.messages.forEach((m, i) => {
      if (i >= cutoff) { return; }
      const ts = (m.meta && m.meta.timestamp) || 0;
      if (m.role === 'user' && m.meta && m.meta.hidden && m.meta.nudge && !m.meta.healing) {
        // Replay of a nudge: the previous reply is kept but marked as retracted, exactly as it looked live.
        const prev = els.messages.lastElementChild;
        if (prev && prev.classList.contains('assistant')) { const bodies = prev.querySelectorAll(':scope > .body'); const last = bodies[bodies.length - 1]; if (last) { last.classList.add('retracted'); } prev.appendChild(nudgeNote(m.meta.nudge)); }
        return;
      }
      if (m.role === 'tool' || (m.role === 'user' && m.meta && (m.meta.toolImages || m.meta.toolResults || m.meta.hidden))) { return; }
      if (m.meta && m.meta.summary) { settleReplay(); const n = el('div', 'turn'); const handoff = /\nThis is a new task continuing the chat /.test(m.content); const det = stepEl('ok', handoff ? 'New task: started from a summary of the previous chat' : 'Conversation compacted to free context', m.content.replace(/<\/?conversation_summary>/g, '').replace(/Continue from here.*$/s, '').replace(/This is a new task continuing the chat .*$/s, '').trim()); det.querySelector('.ico').innerHTML = I.list; n.appendChild(det); els.messages.appendChild(n); return; }
      if (m.role === 'user' && m.meta && m.meta.steer) {
        const prev = els.messages.lastElementChild;
        const row = steerRow(m.content, m.images, m.meta.steerId, false, m.meta.corrections);
        if (prev && prev.classList.contains('assistant')) { prev.appendChild(row); } else { const t = el('div', 'turn assistant'); t.appendChild(row); els.messages.appendChild(t); }
        return;
      }
      const node = m.role === 'user' ? userTurn(m, i) : assistantTurn(m, results);
      if (m.role === 'user') { settleReplay(); }
      // An assistant message with nothing to draw still carries the turn's facts (duration, stopped).
      if (!node) { if (cur && m.role === 'assistant' && m.meta) { if (m.meta.durationMs) { cur.dur = m.meta.durationMs; } if (m.meta.stopped) { cur.stopped = true; } } return; }
      // Consecutive assistant messages (tool calls, then the answer) form one turn, exactly as they streamed live —
      // so settling the transcript at the end of a turn does not shift the layout.
      const prev = els.messages.lastElementChild;
      if (m.role !== 'user' && prev && prev.classList.contains('assistant')) {
        const act = node.querySelector(':scope > .actions, :scope > .afoot');
        if (act) { for (const old of prev.querySelectorAll(':scope > .actions, :scope > .afoot')) { old.remove(); } }
        while (node.firstChild) { prev.appendChild(node.firstChild); }
        if (cur && cur.el === prev) { cur.end = ts || cur.end; if (m.meta && m.meta.durationMs) { cur.dur = m.meta.durationMs; } if (m.meta && m.meta.stopped) { cur.stopped = true; } }
        return;
      }
      els.messages.appendChild(node);
      if (m.role !== 'user') { cur = { el: node, start: ts, end: ts, dur: m.meta && m.meta.durationMs, stopped: !!(m.meta && m.meta.stopped) }; }
    });
    // The turn still streaming is the live element below, not a settled one.
    if (!state.running.has(s.id) && !state.live.has(s.id)) { settleReplay(); }
    // The latest answer can be regenerated: same request, sent again (files the turn changed are kept).
    const lastTurn = els.messages.lastElementChild;
    const failedBox = !inFlight && lastTurn && lastTurn.classList.contains('assistant') && lastTurn.querySelector(':scope > .error-box:last-child');
    if (failedBox) { errorActions(failedBox, s.id); }
    // The latest turn: Continue / Discard after a stop, and the actions on steps that failed and were not retried.
    if (!inFlight && lastTurn && lastTurn.classList.contains('assistant')) { settledRunActions(lastTurn, s.id); }
    const foot = !failedBox && !inFlight && lastTurn && lastTurn.classList.contains('assistant') && lastTurn.querySelector(':scope > .afoot .acts');
    if (foot) { foot.insertAdjacentHTML('beforeend', `<button data-act="regen" title="Regenerate: send your last message again for a new answer (files changed by this turn are kept)" aria-label="Regenerate">${I.refresh}</button>`); }
    syncViewChanges(s.id);
    // Plan mode finished with a checklist: the "Prepared plan" card — title, summary, todos and one-click Build.
    if (s.mode === 'plan' && s.plan && (s.todos || []).length && !state.running.has(s.id)) { els.messages.appendChild(planCard(s)); }
    // Install / Create / Use offers from the last request outlive its live turn.
    if (s.offers && !inFlight) { const n = skillSuggestionNote(s.offers); if (n) { n.classList.add('offer'); els.messages.appendChild(n); } }
    const live = state.live.get(s.id);
    if (!inFlight) { recReplay(s.id); }
    if (live) { els.messages.appendChild(live.root); if (live.dirty) { scheduleRender(live); } }
    renderInterrupted();
    setRunning(state.running.has(s.id) || state.pendingSend.has(s.id));
    if (state.running.has(s.id)) { setStatus(state.status.get(s.id) || 'Working…'); } else if (state.pendingSend.has(s.id)) { setStatus('Sending…'); }
    if (open.length) { const all = m.querySelectorAll('details'); for (const i of open) { if (all[i]) { all[i].open = true; } } }
    if (stick) { scrollToBottom(true); } else { m.scrollTop = y; }
    updateJump();
  }
  /** Continue / Discard changes under a turn the user stopped; Retry / Edit & retry on its failed steps that were never retried. */
  function settledRunActions(turn, sid) {
    const failed = [...turn.querySelectorAll('.steps .step.error[data-tool], .steps .card.edit.error')].filter((n) => !n.classList.contains('denied') && !n.closest('.subrows, .rec-rows'));
    const ok = [...turn.querySelectorAll('.steps .step.ok[data-tool], .steps .card.edit.ok')];
    // After the run, a failure the agent simply moved past is history; the bar stays where the run ended on it (or broke off).
    const all = [...turn.querySelectorAll('.steps .step[data-tool], .steps .card.edit')].filter((n) => !n.closest('.subrows, .rec-rows'));
    const brokeOff = turn.classList.contains('stopped') || !!turn.querySelector(':scope > .error-box');
    for (const n of failed) {
      const key = stepKey(n);
      const later = ok.some((o) => stepKey(o) === key && (n.compareDocumentPosition(o) & 4));
      if (later) { n.classList.add('retried'); continue; }
      if (brokeOff || n === all[all.length - 1]) { failBar(n, n.__err || '', sid); }
    }
    for (const lane of turn.querySelectorAll('.steps .step.subagent.error')) { laneRetry(lane, 'failed', sid); }
    if (!turn.classList.contains('stopped')) { return; }
    const pending = (state.changes.get(sid) || []).length;
    const bar = el('div', 'stopped-acts', `<span class="muted">${turn.querySelector(':scope > .work') ? '' : `${I.stop} Stopped by you`}</span><span class="acts"><button class="btn sm primary" data-s="continue" title="Pick the task up where it stopped">${I.play}<span>Continue</span></button>${pending ? `<button class="btn sm ghost" data-s="discard" title="Revert the ${pending} file${pending === 1 ? '' : 's'} this chat changed and you have not kept">${I.undo}<span>Discard changes</span></button>` : ''}</span>`);
    bar.onclick = (e) => {
      const b = e.target.closest('button[data-s]'); if (!b || state.running.has(sid)) { return; }
      b.disabled = true;
      if (b.dataset.s === 'continue') { post({ type: 'runAction', sessionId: sid, action: 'continue' }); } else { post({ type: 'undoChanges', sessionId: sid }); b.remove(); }
    };
    const work = turn.querySelector(':scope > .work');
    if (work) { work.after(bar); } else { turn.appendChild(bar); }
  }
  /** "Run interrupted": a run that never ended (VS Code reloaded or closed mid-run). Resume, Restore checkpoint, Dismiss. */
  function renderRunInterrupted(s) {
    const st = state.runInt.get(s.id); if (!st) { return; }
    const changed = state.changes.get(s.id) || [];
    const files = changed.length ? changed.map((f) => f.path || f.fsPath) : Array.isArray(st.files) ? st.files : [];
    const facts = [st.steps ? `Stopped during step ${st.steps + 1}` : 'Stopped before it finished', st.tasksTotal ? `Tasks ${st.tasksDone || 0}/${st.tasksTotal}` : '', files.length ? `${files.length} file${files.length === 1 ? '' : 's'} edited` : ''].filter(Boolean).join(' · ');
    const list = files.slice(0, 6).map((f) => `<li title="${esc(f)}">${esc(f)}</li>`).join('') + (files.length > 6 ? `<li class="more">+${files.length - 6} more</li>` : '');
    const when = st.startedAt ? new Date(st.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const card = el('div', 'rec rec-int run-int warn', `<div class="rec-head"><span class="ico">${I.pause}</span><span class="t">Run interrupted</span>${when ? `<span class="when">started ${esc(when)}</span>` : ''}</div><div class="rec-body"><div class="rec-title">${esc(facts)}</div><div class="rec-cause">VS Code closed or reloaded while LocalPilot was working. Nothing ran since.</div>${list ? `<ul class="rec-files">${list}</ul>` : ''}</div><div class="rec-final"><div class="rec-acts"><button class="btn sm primary" data-run="continue" title="Start a turn that checks what was done and carries on">${I.play}<span>Resume</span></button><button class="btn sm" data-run="restore" title="Put the files and the chat back as they were before your last message">${I.restore}<span>Restore checkpoint</span></button>${files.length ? `<button class="btn sm ghost" data-run="review" title="Open the changes this chat made">${I.diff}<span>Review changes</span></button>` : ''}<button class="btn sm ghost" data-run="dismiss" title="Keep everything as it is and hide this card">Dismiss</button></div></div>`);
    card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Run interrupted');
    card.querySelector('.rec-acts').onclick = (e) => {
      const b = e.target.closest('button[data-run]'); if (!b) { return; }
      post({ type: 'runAction', sessionId: s.id, action: b.dataset.run });
      if (b.dataset.run === 'review') { return; }
      if (b.dataset.run === 'continue') { card.querySelectorAll('button').forEach((x) => { x.disabled = true; }); b.classList.add('busy'); return; }
      state.runInt.delete(s.id); card.remove();
    };
    els.messages.appendChild(card);
  }
  /** The host's `git diff --diff-filter=U` for a conflict card: resolved files are ticked, Resume turns on when none are left. */
  function applyConflicts(sid, files) {
    const left = new Set(files);
    for (const card of document.querySelectorAll(`.rec[data-conflict="1"][data-sid="${CSS.escape(sid)}"]`)) {
      for (const li of card.querySelectorAll('.rec-conflicts li[data-file]')) {
        const done = !left.has(li.dataset.file); li.classList.toggle('resolved', done);
        const b = li.querySelector('button[data-merge]'); if (b) { b.disabled = done; b.textContent = done ? 'Resolved' : 'Open in merge editor'; }
      }
      const resume = card.querySelector('.rec-final button[data-ra="resume"][data-wait]');
      if (resume && !files.length && !(card.__p && card.__p.done)) { resume.disabled = false; delete resume.dataset.wait; resume.title = 'No conflicts left: continue the task'; card.dataset.resolved = '1'; }
    }
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
        <div class="plan-foot"><span class="hint">Build switches to Agent mode and runs the checklist — independent items in parallel.</span><span class="plan-acts"><button class="btn ghost revise" data-a="revise" title="Ask for changes to this plan; the chat stays in Plan mode">Revise</button><button class="btn build" data-a="build">Build <kbd>${kb('Mod+Enter')}</kbd></button></span></div>
      </div>`;
    d.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) { return; }
      if (b.dataset.a === 'build') { post({ type: 'buildPlan', sessionId: s.id }); b.disabled = true; b.textContent = 'Building…'; }
      else if (b.dataset.a === 'revise') { if (state.session && state.session.id === s.id && state.session.mode !== 'plan') { setMode('plan'); } state.revising = s.id; syncPlaceholder(); els.input.focus(); }
      else if (b.dataset.a === 'open' && s.plan.file) { post({ type: 'openFile', path: s.plan.file }); }
      else if (b.dataset.a === 'copy') { navigator.clipboard.writeText(todos.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`).join('\n')).then(() => toast('Checklist copied')); }
      else if (b.dataset.a === 'detail') { const prev = d.previousElementSibling; if (prev && prev.classList.contains('assistant')) { prev.scrollIntoView({ behavior: calmMotion() ? 'auto' : 'smooth', block: 'start' }); } }
    };
    return d;
  }
  /** The context strip's status: the first thing that needs attention, else Ready. */
  function ctxStatus() {
    const ws = state.workspace || {}; const n = ws.interventions || 0;
    if (!state.models.length && state.modelsLoading) { return { cls: 'busy', spin: true, text: 'Finding models…' }; }
    if (!state.models.length) { return { cls: 'warn', text: 'No model, set one up', action: 'setup', title: 'Set up a local model, look for model servers, or add a cloud provider' }; }
    if (n) { return { cls: 'warn', text: `${n} task${n === 1 ? ' needs' : 's need'} you · Review`, action: 'interventions', title: 'Self-healing stopped and is waiting for you: open the queue' }; }
    if (ws.indexing) { return { cls: 'busy', spin: true, text: `Indexing ${Number(ws.indexing).toLocaleString()} files…` }; }
    if (state.offline) { return { cls: 'muted', text: state.models.some((x) => !x.remote) ? 'Offline · local models only' : 'Offline', title: 'No network: cloud models and web tools are unavailable' }; }
    return { cls: 'ok', text: 'Ready', title: 'A model is available' };
  }
  /** Folder · branch · status under the welcome heading; redrawn in place when any of them changes. */
  function renderCtxStrip(strip) {
    strip = strip || els.messages.querySelector(':scope > .empty .ctx-strip'); if (!strip) { return; }
    const ws = state.workspace || {}; const st = ctxStatus(); const parts = [];
    // No folder (the window has none): a chat that cannot touch files; Open folder is the way out.
    if (ws.folders === 0) { parts.push(`<span class="seg folder">${I.folder}<span class="t">No folder open · chat only</span></span><button class="link" data-a="openFolder">Open folder…</button>`); }
    else {
      if (ws.name) { parts.push(`<span class="seg folder" title="${esc(`Workspace: ${ws.name}${ws.folders > 1 ? ` (${ws.folders} folders)` : ''}`)}">${I.folder}<span class="t">${esc(ws.name)}</span></span>`); }
      if (ws.branch) { parts.push(`<span class="seg branch" title="${esc(`Git branch: ${ws.branch}`)}">${I.git}<span class="t">${esc(ws.branch)}</span></span>`); }
    }
    const lead = st.spin ? '<span class="spinner" aria-hidden="true"></span>' : '<i class="dot" aria-hidden="true"></i>';
    parts.push(`<span class="seg status ${st.cls}"${st.title ? ` title="${esc(st.title)}"` : ''}>${lead}${st.action ? `<button class="link" data-a="${st.action}">${esc(st.text)}</button>` : `<span class="t">${esc(st.text)}</span>`}</span>`);
    const html = parts.join('');
    if (strip.dataset.sig !== html) { strip.dataset.sig = html; strip.innerHTML = html; }
  }
  function renderEmpty() {
    // A heading that says what this is for, the mode it will run in, where it runs, then things to start with and recent chats.
    const wrap = el('div', 'empty');
    const news = whatsNewCard(); if (news) { wrap.appendChild(news); }
    const ws = state.workspace || {}; const noFolder = ws.folders === 0;
    const hero = el('div', 'hero', `<h2>What are we building today?</h2><p class="sub">Ask a question, or describe a task: LocalPilot plans it, edits files, runs commands and checks the result.</p><p class="modeline"><span class="txt"></span> <span class="chg"><span aria-hidden="true">· </span><button class="link" data-a="mode" aria-haspopup="listbox" aria-label="Change mode">change</button></span></p>`);
    hero.querySelector('[data-a="mode"]').onclick = (e) => { e.stopPropagation(); openModeMenu(); };
    wrap.appendChild(hero);
    const strip = el('div', 'ctx-strip'); strip.setAttribute('role', 'status'); strip.setAttribute('aria-label', 'Workspace and status');
    strip.onclick = (e) => {
      const a = e.target.closest('[data-a]'); if (!a) { return; }
      if (a.dataset.a === 'openFolder') { post({ type: 'workspaceAction', action: 'openFolder' }); }
      else if (a.dataset.a === 'interventions') { post({ type: 'workspaceAction', action: 'interventions' }); }
      else if (a.dataset.a === 'setup') { openModelMenu(''); }
    };
    renderCtxStrip(strip); wrap.appendChild(strip);
    // Without a model nothing can answer: setting one up comes first, and the suggestions wait for it.
    const noModels = !state.models.length && !state.modelsLoading;
    if (noModels) {
      const n = el('div', 'notice', `<b>No local models found.</b><br>LocalPilot can start or install <b>Ollama</b> and download a starter coder model sized for this machine. Or start <b>LM Studio</b>, <b>llama.cpp</b> or <b>vLLM</b> yourself and refresh.<div class="row"><button class="btn primary" data-a="setup">Set up automatically</button><button class="btn" data-a="refresh">Refresh models</button><button class="btn" data-a="settings">Manage models</button></div>`);
      n.onclick = (e) => { const a = e.target.dataset.a; if (a === 'setup') { state.modelsRequested = true; post({ type: 'autoSetupModels' }); toast('Setting up models…'); } if (a === 'refresh') { state.modelsRequested = true; post({ type: 'detectModels' }); toast('Looking for model servers…'); } if (a === 'settings') { post({ type: 'openSettings', section: 'models' }); } };
      wrap.appendChild(n);
    }
    // One row per starter. `send` runs at once (in `mode` for that turn only); otherwise the chat switches to `mode` and
    // the draft is prefilled, so the user finishes the sentence.
    const row = (icon, label, tag, act, tagTitle) => {
      const b = el('button', 'suggestion', `<span class="ico">${icon}</span><span class="lbl">${esc(label)}</span>${tag ? `<span class="mode${act.count ? ' count' : ''}"${tagTitle ? ` title="${esc(tagTitle)}"` : ''}>${esc(tag)}</span>` : ''}`);
      b.title = noModels && !act.always ? 'Set up a model first' : act.title || act.send || label;
      if (noModels && !act.always) { b.setAttribute('aria-disabled', 'true'); }
      b.onclick = () => {
        if (noModels && !act.always) { return; }
        if (act.run) { act.run(); return; }
        if (act.send) { els.input.value = act.send; sendCurrent(true, { modeOverride: act.mode }); return; }
        if (act.mode) { setMode(act.mode); }
        // A starter's context (Fix a bug's @problems) goes when another starter is picked instead.
        for (const ref of state.starterRefs || []) { const i = state.attachments.indexOf(ref); if (i >= 0) { state.attachments.splice(i, 1); } }
        state.starterRefs = (act.attach || []).filter((ref) => !state.attachments.includes(ref)); renderChips();
        for (const ref of act.attach || []) { addAttachment(ref); }
        els.input.value = act.fill || ''; autoGrow(); updateSendEnabled(); syncEmptyChrome();
        els.input.focus(); els.input.selectionStart = els.input.selectionEnd = els.input.value.length;
      };
      return b;
    };
    const group = (title, cls, rows) => { const g = el('div', `sgroup ${cls}`); g.appendChild(el('div', 'recent-h', esc(title))); const list = el('div', 'suggestions'); rows.forEach((r) => list.appendChild(r)); g.appendChild(list); wrap.appendChild(g); };
    const errs = ws.errors || 0;
    const OVERVIEW = 'Explore the workspace structure and summarise what this project does, its main modules and how to build/run it.';
    group('Start', 'starters', noFolder ? [
      row(I.ask, 'Ask a coding question', 'Ask', { mode: 'ask', title: 'Switches to Ask and puts the cursor in the message box' }),
      row(I.bug, 'Explain an error', 'Ask', { mode: 'ask', fill: 'Explain this error and how to fix it:\n', title: 'Paste the error after the prompt' }),
      row(I.file, 'Write a snippet', 'Ask', { mode: 'ask', fill: 'Write a ', title: 'Code in the answer, nothing is written to disk' }),
      row(I.folder, 'Open a folder', '', { always: true, run: () => post({ type: 'workspaceAction', action: 'openFolder' }), title: 'Open a folder so LocalPilot can edit files and run commands' }),
    ] : [
      row(I.sparkle, 'Build a feature', 'Agent', { mode: 'agent', fill: 'Build ', title: 'Switches to Agent and starts the request: describe the feature' }),
      // With errors in the Problems panel they go along as context (@problems) and the tag counts them.
      row(I.bug, 'Fix a bug', errs ? `${errs.toLocaleString()} error${errs === 1 ? '' : 's'}` : 'Debug', { mode: 'debug', fill: 'Fix: ', count: errs > 0, attach: errs ? ['problems'] : [], title: errs ? `Switches to Debug and attaches the ${errs} error${errs === 1 ? '' : 's'} VS Code is showing` : 'Switches to Debug: describe the bug or paste the error' }, errs ? 'Errors in the Problems panel' : 'Runs in Debug mode'),
      row(I.agent, 'Create an agent', 'Subagent', { mode: 'agent', fill: '/agent new ', title: 'Describe a job; LocalPilot writes a reusable subagent for it (.localpilot/agents)' }),
      row(I.search, 'Understand codebase', 'Ask', { mode: 'ask', send: OVERVIEW }),
    ]);
    // The file you are on (sent by the host as the active editor changes): actions on it, sent at once.
    const file = !noFolder && state.activeFile ? base(state.activeFile) : '';
    if (file) {
      group(`For ${file}`, 'forfile', [
        row(I.file, `Explain ${file}`, 'Ask', { mode: 'ask', send: `Explain what ${state.activeFile} does and how it fits into the codebase.` }),
        row(I.bug, `Fix problems in ${file}`, 'Agent', { mode: 'agent', send: `Run get_diagnostics for ${state.activeFile} and fix every error.` }),
        row(I.beaker, state.hasSelection ? 'Write tests for my selection' : `Write tests for ${file}`, 'Agent', { mode: 'agent', send: state.hasSelection ? "Write unit tests for the selected code using the project's existing test framework." : `Write unit tests for ${state.activeFile} using the project's existing test framework.` }),
      ]);
    }
    // Pick up where you left off: the latest chats with something in them (five on tall panels, three on short ones).
    const recent = state.sessions.filter((x) => x.messageCount > 0 && x.id !== (state.session && state.session.id)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
    if (recent.length) {
      const r = el('div', 'recent', `<div class="recent-h">Recent<button data-a="all" title="Search every chat and its messages">Search all chats</button></div>`);
      for (const x of recent) {
        const v = modeView(x);
        const row = el('button', 'recent-row', `<span class="ico">${state.running.has(x.id) ? LIVE_DOT : v.icon}</span><span class="t">${esc(x.title || 'New chat')}</span><span class="when">${esc(timeAgo(x.updatedAt))}</span>`);
        row.title = `Open “${x.title || 'New chat'}” · ${v.label}`;
        row.onclick = () => historyOpen(x.id);
        r.appendChild(row);
      }
      // History opens with its search box focused.
      r.querySelector('[data-a="all"]').onclick = () => els.history.click();
      wrap.appendChild(r);
    }
    els.messages.appendChild(wrap);
    syncModeLine();
  }
  /** The hint row and the disclaimer belong to a chat with nothing in it yet; the hints step aside once you type. */
  function syncEmptyChrome() {
    const s = state.session; const empty = !!s && !s.messages.length && !state.running.has(s.id) && !state.pendingSend.has(s.id) && !state.live.has(s.id);
    if (els.hints) { els.hints.classList.toggle('hidden', !empty || !!els.input.value.trim()); }
    if (els.disclaimer) { els.disclaimer.classList.toggle('hidden', !empty); }
  }

  // ------------------------------------------------------------------ live streaming
  // Work strip: one line at the top of a turn — "Reading the code · 4 steps · 2 files read · 12s" — so the user always
  // sees what the agent is doing, how much it has done and for how long, without reading the rows. When the turn
  // settles it becomes "Worked for 1m 12s · 9 steps · …" and folds the steps away on click (as Copilot does).
  const PHASES = { read_file: 'Reading the code', list_dir: 'Exploring the workspace', grep_search: 'Searching the code', file_search: 'Searching the code', find_symbol: 'Looking up symbols', find_references: 'Looking up references', gather_context: 'Gathering context', get_editor_state: 'Reading the editor', get_diagnostics: 'Checking for errors', edit_file: 'Editing files', apply_patch: 'Editing files', write_file: 'Writing files', create_directory: 'Writing files', delete_path: 'Deleting files', run_command: 'Running a command', web_search: 'Researching on the web', web_fetch: 'Reading documentation', browser_inspect: 'Checking the UI', browser_screenshot: 'Checking the UI', open_browser: 'Opening the browser', manage_todos: 'Planning', load_skill: 'Loading a skill', memory_read: 'Recalling notes', memory_list: 'Recalling notes', memory_save: 'Saving a note', ask_user: 'Waiting for your answer', run_subagent: 'Delegating', run_parallel_subagents: 'Coordinating workers', run_todos_parallel: 'Coordinating workers' };
  function workStrip() { return el('div', 'work running', `<span class="ico">${I.spin}</span><span class="phase">Starting…</span><span class="facts"></span><span class="time"></span><span class="chev">${I.chev}</span>`); }
  function setPhase(live, text) { if (live.work && text && live.phase !== text) { live.phase = text; if (!live.pausedAt) { live.work.querySelector('.phase').textContent = text; } } }
  const SLOW_TIP = 'Still running; Esc stops the run';
  /** Time the turn has been working: paused stretches do not count. */
  function liveElapsed(live, now) { return Math.max(0, now - live.startedAt - (live.pausedMs || 0) - (live.pausedAt ? now - live.pausedAt : 0)); }
  /** The work strip while the loop holds at a step boundary: pause icon, "Paused after step N", frozen timer, Resume. */
  function syncWorkPause(live, now) {
    if (!live.work) { return; }
    const p = state.paused.get(live.sid); const held = !!(p && p.paused && p.holding);
    if (held && !live.pausedAt) {
      live.pausedAt = now;
      live.work.classList.add('paused');
      live.work.querySelector('.ico').innerHTML = I.pause;
      const n = turnStats(live.root).steps;
      live.work.querySelector('.phase').textContent = n ? `Paused after step ${n}` : 'Paused';
      const b = el('button', 'btn sm work-resume', `${I.play}<span>Resume</span>`); b.type = 'button'; b.title = `Resume (${kb('Alt+Esc')})`;
      b.onclick = (e) => { e.stopPropagation(); post({ type: 'resume', sessionId: live.sid }); b.disabled = true; };
      live.work.querySelector('.chev').before(b);
    } else if (!held && live.pausedAt) {
      live.pausedMs = (live.pausedMs || 0) + (now - live.pausedAt); live.pausedAt = 0;
      live.work.classList.remove('paused');
      live.work.querySelector('.ico').innerHTML = I.spin;
      live.work.querySelector('.phase').textContent = live.phase || 'Working';
      const b = live.work.querySelector('.work-resume'); if (b) { b.remove(); }
    }
  }
  /** Elapsed time on a running step's row; after 30 s it turns `slow` (Esc stops the run). Frozen while paused. */
  function stepClock(n, now) {
    if (!n.__t0 || !n.classList.contains('running') || n.classList.contains('subhost') || n.classList.contains('subagent') || n.classList.contains('card')) { return; }
    const ms = now - n.__t0; if (ms < 3000) { return; }
    const meta = n.querySelector(':scope > summary .meta'); if (!meta) { return; }
    let t = meta.querySelector(':scope > .el'); if (!t) { t = el('span', 'el', ''); meta.appendChild(t); }
    t.textContent = fmtDur(ms);
    if (ms >= 30000 && !n.classList.contains('slow')) { n.classList.add('slow'); if (!n.title) { n.title = SLOW_TIP; } }
  }
  /** What a turn did, counted from its rows — the same for the live turn and a replayed one. A worker's own rows are not the parent's steps. */
  function turnStats(root) {
    const st = { steps: 0, files: new Set(), searches: 0, edits: new Set(), cmds: 0, web: 0, workers: 0 };
    for (const n of root.querySelectorAll('.steps .step[data-tool], .steps .card.edit, .steps .step.subagent')) {
      const w = n.closest('.step.subagent');
      if ((w && (w !== n || w.parentElement.closest('.step.subagent'))) || n.classList.contains('subhost')) { continue; }
      if (n.classList.contains('subagent')) { st.workers++; continue; }
      st.steps++;
      if (n.classList.contains('card')) { if (n.dataset.path) { st.edits.add(n.dataset.path); } continue; }
      const t = n.dataset.tool;
      if (t === 'read_file') { const p = parseArgs(n.dataset.args || '{}').path; if (p) { st.files.add(p); } }
      else if (/^web_|^browser_/.test(t)) { st.web++; }
      else if (/search|find_|list_dir/.test(t)) { st.searches++; }
      else if (t === 'run_command') { st.cmds++; }
    }
    return st;
  }
  function factsText(st) {
    const n = (k, one, many) => `${k} ${k === 1 ? one : many || one + 's'}`;
    const p = [];
    if (st.steps) { p.push(n(st.steps, 'step')); }
    if (st.files.size) { p.push(`${n(st.files.size, 'file')} read`); }
    if (st.searches) { p.push(n(st.searches, 'search', 'searches')); }
    if (st.edits.size) { p.push(`${n(st.edits.size, 'file')} edited`); }
    if (st.cmds) { p.push(n(st.cmds, 'command')); }
    if (st.web) { p.push(n(st.web, 'web lookup')); }
    if (st.workers) { p.push(n(st.workers, 'worker')); }
    return p.join(' · ');
  }
  /** Checklist items a worker failed (skipped with a reason other than "Not run"; see run_todos_parallel). */
  function todoFailed(t) { return t.status === 'skipped' && !!t.result && !/^Not run\b/.test(String(t.result)); }
  /** "6 steps · 2 files edited · 1 task failed": only the failed part is in the error colour. */
  function workFacts(work, text, failed) { work.querySelector('.facts').innerHTML = `${esc(text)}${failed ? `${text ? ' · ' : ''}<b class="bad">${failed} task${failed === 1 ? '' : 's'} failed</b>` : ''}`; }
  function failedTodos() { const todos = state.session && Array.isArray(state.session.todos) ? state.session.todos : []; return todos.filter(todoFailed); }
  function fmtDur(ms) { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; }
  function updateWork(live) {
    if (!live.work || live.workPending) { return; }
    live.workPending = true;
    requestAnimationFrame(() => { live.workPending = false; if (live.work) { workFacts(live.work, factsText(turnStats(live.root)), state.session && state.session.id === live.sid ? failedTodos().length : 0); } });
  }
  function settleWork(root, work, st, ms, failed, stopped) {
    if (!st.steps && !st.workers) { work.remove(); return; }
    // Stopped by the user is not a failure: muted stop icon and its own wording (Continue / Discard come with the latest turn).
    work.className = `work done${stopped ? ' stopped' : failed ? ' failed' : ''}`;
    work.querySelector('.ico').innerHTML = stopped ? I.stop : failed ? I.x : I.check;
    work.querySelector('.phase').textContent = stopped ? (ms ? `Stopped by you after ${fmtDur(ms)}` : 'Stopped by you') : ms ? `${failed ? 'Stopped after' : 'Worked for'} ${fmtDur(ms)}` : failed ? 'Stopped' : 'Work done';
    const res = work.querySelector('.work-resume'); if (res) { res.remove(); }
    // The checklist's failed items belong to the latest turn only (the todos are the chat's current plan).
    const ft = root.classList.contains('live') || !root.nextElementSibling ? failedTodos().length : 0;
    workFacts(work, factsText(st), ft);
    work.querySelector('.time').textContent = '';
    work.title = 'Show or hide the steps of this turn';
    work.onclick = () => { root.classList.toggle('folded'); };
  }
  let workTicker = 0;
  /** Output speed over the last few seconds (≈ chars/4 per token); 0 once the stream has paused. */
  function noteStream(live, n) { const now = Date.now(); (live.stream || (live.stream = [])).push([now, n]); }
  function streamRate(live, now) {
    const s = live.stream; if (!s || !s.length) { return 0; }
    while (s.length && now - s[0][0] > 3000) { s.shift(); }
    if (!s.length || now - s[s.length - 1][0] > 1500) { return 0; }
    const span = Math.max(1000, now - s[0][0]);
    return Math.round(s.reduce((a, x) => a + x[1], 0) / 4 / (span / 1000));
  }
  function tickWork() {
    let any = false;
    const now = Date.now();
    for (const live of state.live.values()) {
      if (!live.work) { continue; }
      any = true;
      if (state.session && state.session.id === live.sid) {
        syncWorkPause(live, now);
        if (live.pausedAt) { continue; }
        const rate = streamRate(live, now);
        const t = live.work.querySelector('.time');
        const ms = liveElapsed(live, now);
        t.textContent = rate ? `~${rate} tok/s · ${fmtDur(ms)}` : fmtDur(ms);
        t.title = rate ? 'Model output speed over the last few seconds, and time spent working (pauses not counted)' : 'Time spent working since you sent (pauses not counted)';
        for (const n of live.tools.values()) { stepClock(n, now); }
        for (const n of live.subTools.values()) { stepClock(n, now); }
        if (live.waitRow) { tickWait(live, now); }
      }
    }
    if (!any) { clearInterval(workTicker); workTicker = 0; }
  }
  function ensureLive(sessionId) {
    let live = state.live.get(sessionId);
    if (!live) {
      const root = el('div', 'turn assistant live');
      const work = workStrip();
      const steps = el('div', 'steps');
      const body = el('div', 'body', '<span class="typing"><i></i><i></i><i></i></span>');
      root.appendChild(work); root.appendChild(steps); root.appendChild(body);
      live = { sid: sessionId, root, work, steps, body, text: '', thinking: '', thinkingEl: null, thinkStart: 0, tools: new Map(), subs: new Map(), subTools: new Map(), timer: 0, startedAt: Date.now(), phase: '', durationMs: 0, failed: false };
      state.live.set(sessionId, live); state.recovery.delete(sessionId);
      if (state.session && state.session.id === sessionId) { for (const e of els.messages.querySelectorAll(':scope > .empty, :scope > .rec-int')) { e.remove(); } els.messages.appendChild(root); }
      if (!workTicker) { workTicker = setInterval(tickWork, 1000); }
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
  /** Reasoning streams into its row once per frame (long chains of thought arrive at 100+ tokens/s), following the tail. */
  function scheduleThinking(live) {
    if (live.thinkPending) { return; }
    live.thinkPending = true;
    requestAnimationFrame(() => {
      live.thinkPending = false;
      const row = live.thinkingEl; if (!row) { return; }
      const c = row.querySelector(':scope > .content');
      const atEnd = c.scrollHeight - c.scrollTop - c.clientHeight < 24;
      c.textContent = live.thinking;
      if (atEnd) { c.scrollTop = c.scrollHeight; }
      row.querySelector(':scope > summary .meta').textContent = `${Math.round((Date.now() - live.thinkStart) / 1000)}s`;
      followLive(live);
    });
  }
  function finishThinking(live) {
    if (!live.thinkingEl) { return; }
    const secs = Math.max(1, Math.round((Date.now() - live.thinkStart) / 1000));
    live.thinkingEl.querySelector(':scope > .content').textContent = live.thinking;
    if (!live.thinkingEl.dataset.user) { live.thinkingEl.open = false; }
    setState(live.thinkingEl, 'ok');
    live.thinkingEl.querySelector(':scope > summary .label').innerHTML = `<b>Thought</b> ${thinkSummary(live.thinking)}`;
    live.thinkingEl.querySelector(':scope > summary .meta').textContent = `${secs}s`;
    live.thinkingEl = null;
  }
  // ---- slow model: the wait for the first token is a row in the transcript ("Loading gemma4:12b into memory · 24s"),
  // with the limit it times out at, and Switch model / Stop once it has taken 20 s.
  const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  function waitText(p, secs) {
    const name = p.name || modelName(p.model) || 'the model';
    return p.phase === 'load' ? `Loading ${name} into memory · ${secs}s` : p.phase === 'queue' ? `Waiting for ${name}: busy with other requests · ${secs}s` : `${name} is reading the prompt · ${secs}s`;
  }
  function showWait(live, sid, p) {
    if (p.done) { clearWait(live); return; }
    const secs = Math.max(0, Number(p.seconds) || 0);
    // A few seconds of prefill is normal; the row appears only when the wait is noticeable.
    if (secs < 4 && !live.waitRow) { return; }
    let row = live.waitRow && live.waitRow.isConnected ? live.waitRow : null;
    if (!row) {
      rotateBody(live);
      row = el('div', 'note wait', `<span class="ico">${I.spin}</span><span class="t"></span><span class="lim"></span><span class="acts hidden"><button class="btn sm ghost" data-w="switch" title="Stop this request and send the message again with another model">${I.layers}<span>Switch model</span></button><button class="btn sm ghost" data-w="stop" title="Stop the run (${kb('Esc')})">${I.stop}<span>Stop</span></button></span>`);
      row.setAttribute('role', 'status');
      row.onclick = (e) => {
        const b = e.target.closest('button[data-w]'); if (!b) { return; }
        if (b.dataset.w === 'stop') { post({ type: 'stop', sessionId: sid }); b.disabled = true; return; }
        modelPickThen = (id) => { if (id && id !== live.waitRow?.__p?.model) { post({ type: 'switchModelAndRetry', sessionId: sid, model: id }); return true; } return false; };
        openModelMenu();
      };
      live.root.insertBefore(row, live.body); live.waitRow = row;
      clearTyping(live);
    }
    row.__p = p; row.__at = Date.now(); row.__secs = secs;
    paintWait(row, secs);
    followLive(live);
  }
  function paintWait(row, secs) {
    const p = row.__p || {};
    row.querySelector('.t').textContent = waitText(p, secs);
    const lim = Number(p.limitSec) || 0;
    row.querySelector('.lim').textContent = lim ? `times out at ${fmtClock(lim)}` : '';
    row.querySelector('.acts').classList.toggle('hidden', secs < 20);
    row.classList.toggle('long', lim > 0 && secs > lim * 0.75);
  }
  /** Between the host's once-a-second updates (or if they pause) the counter keeps moving. */
  function tickWait(live, now) { const row = live.waitRow; if (!row || !row.isConnected || !row.__at) { return; } paintWait(row, row.__secs + Math.floor((now - row.__at) / 1000)); }
  function clearWait(live) { if (live.waitRow) { live.waitRow.remove(); live.waitRow = null; } }
  /** Output arrived after a retry: the retry row turns into "Recovered on attempt N". */
  function retryRecovered(live) {
    const row = live.retryRow; if (!row) { return; }
    live.retryRow = null;
    if (!row.isConnected) { return; }
    row.className = 'note retry ok';
    row.innerHTML = `<span class="ico">${I.check}</span><span>Recovered on attempt ${esc(row.dataset.attempt || '2')}</span>`;
  }
  // ---- model fallback: a note at the top of the turn says which model answers instead, with a way to keep it or go back.
  function routeNote(live, sid, p) {
    if (!p.used || !p.wanted) { return; }
    state.rerouted.set(sid, p); if (state.session && state.session.id === sid) { syncModel(); }
    const old = live.root.querySelector(':scope > .note.route'); if (old) { old.remove(); }
    const wanted = modelName(p.wanted) || p.wanted; const used = p.usedName || modelName(p.used) || p.used;
    const n = el('div', 'note route', `<span class="ico">${I.warn}</span><span class="t"><b>${esc(wanted)}</b> ${p.unavailable ? 'is not answering' : 'is not available'}. This turn uses <b>${esc(used)}</b>${p.cloud ? ' <span class="badge cloud" title="Cloud model: prompts leave this machine">cloud</span>' : ''}.</span><span class="acts"><button class="btn sm ghost" data-r="keep" title="Make ${esc(used)} this chat's model">Use for this chat</button><button class="btn sm ghost" data-r="retry" title="Stop and send the message again with ${esc(wanted)}">${I.refresh}<span>Retry with ${esc(short(wanted, 24))}</span></button></span>`);
    n.title = p.reason || '';
    n.onclick = (e) => {
      const b = e.target.closest('button[data-r]'); if (!b) { return; }
      if (b.dataset.r === 'keep') { post({ type: 'setModel', sessionId: sid, model: p.used, makeDefault: false }); if (state.session && state.session.id === sid) { state.session.model = p.used; } state.rerouted.delete(sid); syncModel(); n.querySelector('.acts').innerHTML = `<span class="muted">${I.check} ${esc(used)} is now this chat's model</span>`; }
      else { post({ type: 'switchModelAndRetry', sessionId: sid, model: p.wanted }); b.disabled = true; }
    };
    const anchor = live.work && live.work.parentElement === live.root ? live.work.nextSibling : live.root.firstChild;
    live.root.insertBefore(n, anchor);
  }
  // ---- todo ↔ step links: rows carry data-todo; a linked checklist item scrolls to its first step.
  function linkTodo(id) { const li = els.tasksList && els.tasksList.querySelector(`li.todo[data-id="${CSS.escape(id)}"]`); if (li && !li.classList.contains('linked')) { li.classList.add('linked'); li.tabIndex = 0; li.setAttribute('role', 'button'); } }
  // ---- approval ↔ step: the row waiting on a prompt reads "Needs approval · Review".
  const APPROVAL_TOOLS = { terminal: ['run_command'], write: ['edit_file', 'write_file', 'apply_patch', 'create_directory'], delete: ['delete_path'], network: ['web_fetch', 'web_search', 'browser_screenshot', 'browser_inspect', 'open_browser'] };
  function markApprovalRow(a) {
    const live = state.live.get(a.sessionId); if (!live) { return; }
    const tools = APPROVAL_TOOLS[a.kind];
    const rows = [...live.tools.values()].filter((n) => n.classList.contains('running') && !n.__approval && (n.classList.contains('card') ? !tools || tools.includes(n.dataset.write === '1' ? 'write_file' : 'edit_file') : !tools ? /^mcp_/.test(n.dataset.tool || '') : tools.includes(n.dataset.tool)));
    const row = rows.pop(); if (!row) { return; }
    row.__approval = a.id; row.classList.add('needs');
    const where = row.classList.contains('card') ? row.querySelector(':scope > .card-head .stat') : row.querySelector(':scope > summary .meta');
    if (!where) { return; }
    const tag = el('span', 'needs-tag', `<span class="lbl">Needs approval</span><i>·</i><button class="link" type="button" title="Go to the approval prompt" aria-label="Review the approval this step is waiting for">Review</button>`);
    tag.querySelector('button').onclick = (e) => { e.preventDefault(); e.stopPropagation(); const d = els.approvals.querySelector(`[data-id="${CSS.escape(a.id)}"]`); if (d) { d.scrollIntoView({ block: 'nearest' }); if (d._focusFirst) { d._focusFirst(); } } };
    where.prepend(tag);
  }
  function unmarkApproval(node) { if (!node || !node.__approval) { return; } node.__approval = null; node.classList.remove('needs'); const t = node.querySelector('.needs-tag'); if (t) { t.remove(); } }
  function unmarkApprovalId(id) { for (const live of state.live.values()) { for (const n of live.tools.values()) { if (n.__approval === id) { unmarkApproval(n); } } } }
  /** An `error` event's text: a plain string (older transcripts), or `{ message, kind, provider }`; the mistake limit has `latest`. */
  function errorText(p) { return p && typeof p === 'object' ? String(p.message || p.latest || 'Error') : String(p); }
  /** The kind of a stored error (the transcript keeps only its text), read from the wording describeModelError uses. */
  function guessErrorKind(text) {
    const t = String(text || '');
    return /could not reach the model server|no model|not running|ECONNREFUSED|fetch failed|has no provider it can send/i.test(t) ? 'connection'
      : /rejected the API key|api key|unauthori[sz]ed|out of credits|quota/i.test(t) ? 'auth'
      : /rate limit/i.test(t) ? 'ratelimit'
      : /too long|context (window|length)|maximum context|prompt is too/i.test(t) ? 'context' : '';
  }
  /** Ollama is the likely server when the chat's model is on it, or when no model was found at all. */
  function guessProvider() { const cm = currentModel(); return cm ? (/ollama/i.test(`${cm.providerId} ${state.providerNames && state.providerNames[cm.providerId] || ''}`) && !cm.remote ? 'ollama' : '') : (!state.models.length ? 'ollama' : ''); }
  /** Error row for an `error` event or a stored failure; the mistake limit names the latest failure and how to carry on. */
  /** The error box's title by kind: what went wrong in a few words, the message below says why and what to do. */
  const ERR_TITLE = { connection: 'Cannot reach the model server', auth: 'API key rejected', quota: 'Out of credits', ratelimit: 'Rate limited', stall: 'Model stopped responding', context: 'Prompt too large', server: 'Model server error', mistake_limit: 'Stopped after repeated errors', other: 'Something went wrong' };
  function errorHead(kind, text) {
    const h = el('div', 'err-head', `<span class="ico">${I.warn}</span><b>${esc(ERR_TITLE[kind] || ERR_TITLE.other)}</b><button class="err-copy" type="button" title="Copy error" aria-label="Copy error">${I.copy}</button>`);
    h.querySelector('.err-copy').onclick = (e) => { e.stopPropagation(); copyTo(e.currentTarget, text); };
    return h;
  }
  function errorBox(p) {
    if (p && typeof p === 'object' && p.kind === 'mistake_limit') {
      const box = el('div', 'error-box mistake-limit', `<span class="msg">LocalPilot ran into ${esc(p.count)} errors in a row and stopped.<br>Latest: <code>${esc(p.latest || 'unknown error')}</code><br>Tell it what to do differently and it carries on, or go back to before this turn.</span>`);
      box.dataset.kind = 'mistake_limit';
      box.prepend(errorHead('mistake_limit', `LocalPilot ran into ${p.count} errors in a row and stopped. Latest: ${p.latest || 'unknown error'}`));
      return box;
    }
    const box = el('div', 'error-box', `<span class="msg">${esc(errorText(p))}</span>`);
    const obj = p && typeof p === 'object';
    box.dataset.kind = obj && p.kind ? String(p.kind) : guessErrorKind(errorText(p));
    box.dataset.provider = obj && p.provider ? String(p.provider) : guessProvider();
    box.prepend(errorHead(box.dataset.kind, errorText(p)));
    box.setAttribute('role', 'alert');
    return box;
  }
  /** Inline note under a retracted reply: why the model is being asked to act instead of the turn ending. */
  function nudgeNote(reason) {
    const why = {
      claimed: 'The reply said this was done, but no tool ran — asking the model to actually do it.',
      announced: 'The reply announced an action without taking it — asking the model to do it.',
      shown: 'The tool call was written as text instead of being made — asking the model to call it.',
      stale: 'The workers already finished — asking the model to report their results instead of re-announcing the hand-off.',
      malformed: 'The tool call could not be parsed — asking the model to resend it.',
      length: 'The reply was cut off at the output limit — asking the model for a shorter call.',
    }[reason] || 'Nothing was executed — asking the model to act or explain.';
    return el('div', 'note nudge', `${I.warn}<span>${esc(why)}</span>`);
  }
  // ------------------------------------------------------------------ self-healing (recovery card, outcome badge)
  const REC_STEPS = [['Detect', ['detecting', 'classifying', 'retrying']], ['Diagnose', ['diagnosing', 'resolving', 'escalating']], ['Fix', ['fixing', 'rolling_back']], ['Validate', ['verifying', 'validating']], ['Regression', ['regression', 'completing']]];
  const REC_CAT = { model_timeout: 'Model timeout', model_unavailable: 'Model unavailable', model_overload: 'Model overloaded', model_output: 'Model output', compile: 'Compile', typescript: 'TypeScript', lint: 'Lint', build: 'Build', dependency: 'Dependency', unit_test: 'Unit test', integration_test: 'Integration test', runtime: 'Runtime', database: 'Database', data_corruption: 'Data corruption', mcp: 'MCP', git_conflict: 'Git conflict', security: 'Security', tool: 'Tool', permission: 'Permission', check_timeout: 'Check timeout', loop: 'Agent loop', unknown: 'Unknown' };
  const REC_REASON = { exhausted: 'fix attempts used up', duplicate: 'the same error keeps coming back', deadline: 'recovery time limit reached', loop: 'the agent kept repeating itself', mistake_limit: 'too many errors in a row', approval_needed: 'an approval is needed', credentials: 'credentials are missing or rejected', git_conflict: 'a git conflict needs your review', security: 'a security finding needs your decision', data_corruption: 'possible data corruption, nothing was written', model_blocked: 'the model reported it is blocked', user_edit_conflict: 'you changed the same files', model_unavailable: 'the model server is unavailable' };
  const REC_PHASE = { detecting: 'detecting', classifying: 'classifying', retrying: 'retrying', diagnosing: 'diagnosing', resolving: 'resolving', fixing: 'fixing', validating: 'validating', verifying: 'verifying', rolling_back: 'rolling back', regression: 'regression check', escalating: 'escalating', completing: 'completing', interrupted: 'interrupted', executing: 'executing', idle: 'idle' };
  const BADGE = { completed: ['ok', 'Completed ✓ verified'], completed_unverified: ['warn', 'Not verified'], incomplete: ['bad', 'Incomplete'], blocked: ['bad', 'Blocked'] };
  const recStep = (phase) => REC_STEPS.findIndex((s) => s[1].includes(phase));
  const recTerminal = (o) => ['completed', 'completed_unverified', 'incomplete', 'blocked', 'failed', 'cancelled'].includes(o);
  /** The code in "TypeScript TS2345 in src/a.ts:4" (TS2345, E0308, CS1002, F401, GHSA-…, ModuleNotFoundError, MCP:-32602). */
  const recCode = (p) => p.code || ((/\b(TS\d{3,5}|E\d{4}|CS\d{4}|NU\d{4}|[A-Z]\d{3,4}|GHSA-[\w-]+|MCP:-?\d+|[A-Z]\w*Error)\b/.exec(p.title || '') || [])[1]) || '';
  /** "Verified: …" / "Not verified: …" / "Incomplete: …" / "Blocked: …": the outcome a stored footer reports. */
  const reportOutcome = (r) => { const t = String(r || '').trim(); return /^verified\b/i.test(t) ? 'completed' : /^(not verified|unverified)\b/i.test(t) ? 'completed_unverified' : /^incomplete\b/i.test(t) ? 'incomplete' : /^blocked\b/i.test(t) ? 'blocked' : ''; };
  /** Per chat: the cards of the current/last turn by recovery id (payloads merged) and the turn's outcome. */
  function recCache(sid) { let c = state.recovery.get(sid); if (!c) { c = { cards: new Map(), outcome: null }; state.recovery.set(sid, c); } return c; }
  function recMerge(prev, p) {
    const m = Object.assign({}, prev || {});
    for (const [k, v] of Object.entries(p || {})) { if (v !== undefined && v !== null) { m[k] = v; } }
    const i = recStep(m.phase); m.reached = Math.max(prev && typeof prev.reached === 'number' ? prev.reached : -1, i);
    if (recTerminal(m.phase) && !m.outcome) { m.outcome = m.phase; }
    // An answered card asks again when the engine escalates anew (a new intervention) or goes back to work.
    const iv = p && p.intervention;
    if ((iv && iv.id !== (prev && prev.intervention && prev.intervention.id)) || (p && p.phase && !recTerminal(p.phase))) { delete m.done; }
    return m;
  }
  /** Counts the user's visible turns in `msgs[0, end)`: the position of the answer that follows the last one. */
  function userTurns(msgs, end) {
    return (msgs || []).slice(0, end).filter((m) => m.role === 'user' && !(m.meta && (m.meta.hidden || m.meta.steer || m.meta.summary || m.meta.toolResults || m.meta.toolImages))).length;
  }
  function outcomeBadge(outcome, title) {
    const b = BADGE[outcome]; if (!b) { return ''; }
    return `<span class="outcome ${b[0]}"${title ? ` title="${esc(title)}"` : ''}>${esc(b[1])}</span>`;
  }
  function recHeader(p) {
    const parts = ['Self-healing'];
    if (p.attempt) { parts.push(`attempt ${p.attempt}${p.max ? `/${p.max}` : ''}`); }
    if (p.category) { const code = recCode(p); parts.push(`${REC_CAT[p.category] || p.category}${code ? ` (${code})` : ''}`); }
    else if (!p.id) { parts.push('verifying changes'); }
    return parts.join(' · ');
  }
  function recBody(p) {
    const out = p.outcome && recTerminal(p.outcome) ? p.outcome : '';
    const steps = REC_STEPS.map((s, i) => {
      // Finished well: every step done. Stopped: the furthest step reached is where it failed. Running: the current one.
      const ok = out === 'completed' || out === 'completed_unverified'; const r = Math.max(0, p.reached); const now = recStep(p.phase); const cur = !out && now === i;
      const cls = ok ? 'done' : out ? (i < r ? 'done' : i === r && out !== 'cancelled' ? 'bad' : '') : cur ? 'cur' : i <= Math.max(p.reached, now) ? 'done' : '';
      return `<li class="${cls}"${cur ? ' aria-current="step"' : ''}>${esc(s[0])}</li>`;
    }).join('');
    const chip = (c) => {
      const st = String(c.status || ''); const sym = st === 'passed' ? '✓' : st === 'failed' ? '✗' : st === 'timeout' ? '⏱' : st === 'skipped' ? '' : '…';
      const ms = typeof c.ms === 'number' && st !== 'skipped' ? (c.ms >= 1000 ? `${(c.ms / 1000).toFixed(1)}s` : `${Math.round(c.ms)}ms`) : '';
      const tip = st === 'skipped' ? `Skipped${c.skipReason ? `: ${c.skipReason}` : ''}` : `${c.id}: ${st}${ms ? ` in ${ms}` : ''}`;
      // A failed check with an excerpt expands (click / Enter) to show what failed.
      const ex = c.excerpt && (st === 'failed' || st === 'timeout') ? ` data-ex="${esc(c.id)}" tabindex="0" role="button" aria-expanded="false"` : '';
      return `<span class="rchip ${esc(st)}" title="${esc(ex ? `${tip} · show what failed` : tip)}"${ex}>${sym ? `<b>${sym}</b>` : ''}<span class="n">${esc(c.id)}</span>${st === 'skipped' ? '<i>skipped</i>' : ms ? `<i>${esc(ms)}</i>` : ''}</span>`;
    };
    const patch = (x) => `<li class="${x.result === 'rolled_back' ? 'rb' : ''}" title="${esc(x.file)}${x.result ? ` (${esc(String(x.result).replace(/_/g, ' '))})` : ''} · open its diff" data-file="${esc(x.file)}" tabindex="0" role="button"><span class="f">${esc(x.file)}</span><span class="a">+${esc(x.added || 0)}</span><span class="r">−${esc(x.removed || 0)}</span></li>`;
    const checks = Array.isArray(p.checks) ? p.checks : []; const patches = Array.isArray(p.patches) ? p.patches : [];
    // Once the card stopped, each attempt's patches that are still applied can be rolled back (all of them when the
    // payload does not say which attempt wrote a patch).
    const groups = new Map(); for (const x of patches) { const k = typeof x.attempt === 'number' ? String(x.attempt) : ''; if (!groups.has(k)) { groups.set(k, []); } groups.get(k).push(x); }
    const sent = Array.isArray(p.rbSent) ? p.rbSent : [];
    const rb = (k, xs) => {
      if (!out || !xs.some((x) => x.result !== 'rolled_back')) { return ''; }
      const asked = sent.includes(k); const label = k ? `Rollback attempt ${k}` : 'Rollback fixes';
      return `<li class="rec-rb"><button class="btn sm" type="button" data-rb="${esc(k)}"${asked ? ' disabled' : ''} title="${esc(k ? `Undo the files attempt ${k} changed` : 'Undo the files the fix attempts changed')}">${I.undo}<span>${asked ? 'Rollback requested' : esc(label)}</span></button></li>`;
    };
    const plist = [...groups].map(([k, xs]) => `<ul class="rec-patches">${groups.size > 1 && k ? `<li class="rec-att">Attempt ${esc(k)}</li>` : ''}${xs.map(patch).join('')}${rb(k, xs)}</ul>`).join('');
    return `<ol class="rec-stepper">${steps}</ol>${p.title ? `<div class="rec-title">${esc(p.title)}</div>` : ''}${p.rootCause ? `<div class="rec-cause"><span>Root cause:</span> ${esc(p.rootCause)}</div>` : ''}${checks.length ? `<div class="rec-checks">${checks.map(chip).join('')}</div>` : ''}${plist}${p.decision && !out ? `<div class="rec-decision">${I.spin}<span>${esc(p.decision)}</span></div>` : ''}`;
  }
  /** Final state line + intervention actions; rebuilt only when they change so an open guidance box survives updates. */
  function recFinal(card, p) {
    const out = p.outcome && recTerminal(p.outcome) ? p.outcome : '';
    const sig = JSON.stringify([out, p.attempt, p.intervention, p.contract && p.contract.checksModified, p.done]);
    const fin = card.querySelector(':scope > .rec-final');
    if (fin.dataset.sig === sig) { return; }
    fin.dataset.sig = sig; fin.innerHTML = '';
    card.classList.remove('ok', 'warn', 'bad', 'off');
    if (!out) { return; }
    if (out === 'completed') { card.classList.add('ok'); fin.innerHTML = `${I.check}<span>${p.attempt ? `Recovered after ${p.attempt} attempt${p.attempt === 1 ? '' : 's'}` : 'Verified'}</span>`; return; }
    if (out === 'completed_unverified') {
      card.classList.add('warn');
      const mod = (p.contract && p.contract.checksModified) || [];
      fin.innerHTML = `${I.warn}<span>Not verified${mod.length ? ': the fix changed files that define the checks' : ''}</span>${mod.length ? `<ul class="rec-mod">${mod.map((x) => `<li><code>${esc(x.file)}</code>${x.attempt ? ` <i>attempt ${esc(x.attempt)}</i>` : ''}</li>`).join('')}</ul>` : ''}`;
      return;
    }
    if (out === 'cancelled') { card.classList.add('off'); fin.innerHTML = '<span>Cancelled</span>'; return; }
    card.classList.add('bad');
    const iv = p.intervention;
    const reason = iv ? REC_REASON[iv.reason] || String(iv.reason || '').replace(/_/g, ' ') : out === 'failed' ? 'recovery failed' : 'the task is not finished';
    fin.innerHTML = `${I.warn}<span>Needs you: ${esc(reason)}</span>`;
    // A git conflict lists its files, each with its own merge editor; Resume stays off until git reports none left.
    const conflict = iv && iv.reason === 'git_conflict';
    const files = conflict && Array.isArray(iv.files) ? iv.files : [];
    if (files.length) { fin.insertAdjacentHTML('beforeend', `<ul class="rec-conflicts">${files.map((f) => `<li data-file="${esc(f)}"><span class="f" title="${esc(f)}">${esc(f)}</span><button class="btn sm" type="button" data-merge="${esc(f)}" title="Open ${esc(f)} in the merge editor">Open in merge editor</button></li>`).join('')}</ul>`); }
    if (iv && iv.next) { fin.insertAdjacentHTML('beforeend', `<div class="rec-next">${esc(iv.next)}</div>`); }
    if (conflict) {
      card.dataset.conflict = '1';
      fin.onclick = (e) => { const b = e.target.closest('button[data-merge]'); if (b) { recPost(card.dataset.sid, card.dataset.rid || p.id, 'openMergeEditor', { file: b.dataset.merge }); } };
      post({ type: 'checkConflicts', sessionId: card.dataset.sid });
      if (typeof setInterval === 'function' && !card.__poll) { card.__poll = setInterval(() => { if (!card.isConnected || card.dataset.conflict !== '1' || (card.__p && card.__p.done)) { clearInterval(card.__poll); card.__poll = 0; return; } post({ type: 'checkConflicts', sessionId: card.dataset.sid }); }, 5000); }
    }
    // Accepting a risk is only ever offered for a security finding.
    const sec = p.category === 'security' || (iv && iv.reason === 'security');
    const acts = (iv && Array.isArray(iv.nextActions) ? iv.nextActions : []).filter((a) => a && a.action && (a.action !== 'acceptRisk' || sec) && !(a.action === 'openMergeEditor' && files.length));
    if (acts.length && !p.done) {
      const box = recActions(card, p, acts); fin.appendChild(box);
      const resume = conflict && box.querySelector('button[data-ra="resume"]');
      if (resume && !card.dataset.resolved) { resume.disabled = true; resume.dataset.wait = '1'; resume.title = 'Resolve the conflicts first (save the merged files); this turns on once git reports none left'; }
    }
  }
  /**
   * Webview -> host `{ type: 'recoveryAction', sessionId, recoveryId, action, text?, attempt? }`: `text` is the guidance of
   * `retryWithGuidance`, `attempt` the attempt a `rollback` undoes (absent: every fix attempt). For `acceptRisk` the host
   * must confirm with a modal (`showWarningMessage(…, { modal: true })`) and `audit()` the decision before it acts: the
   * click in the card is a request, not that confirmation.
   */
  function recPost(sid, recoveryId, action, extra) { post(Object.assign({ type: 'recoveryAction', sessionId: sid, recoveryId, action }, extra || {})); }
  function recActions(card, p, acts) {
    const box = el('div', 'rec-acts');
    acts.forEach((a, i) => { const b = el('button', `btn sm${a.action === 'acceptRisk' ? ' danger' : i === 0 ? ' primary' : a.action === 'dismiss' ? ' ghost' : ''}`, esc(a.label || a.action)); b.dataset.ra = a.action; b.title = a.action === 'acceptRisk' ? 'Keep the finding in the code; LocalPilot asks you to confirm and records the decision in the audit log' : a.command ? `${a.label || a.action} (${a.command})` : a.label || a.action; box.appendChild(b); });
    const send = (action, text) => {
      recPost(card.dataset.sid, card.dataset.rid || p.id, action, text ? { text } : null);
      box.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
      const c = recCache(card.dataset.sid).cards.get(card.dataset.rid); if (c) { c.done = true; }
      if (action === 'dismiss') { box.remove(); }
    };
    box.onclick = (e) => {
      const b = e.target.closest('button[data-ra]'); if (!b || b.disabled) { return; }
      const a = b.dataset.ra;
      if (a === 'retryWithGuidance') {
        let form = box.querySelector('.rec-guide');
        if (!form) {
          form = el('form', 'rec-guide', '<input type="text" placeholder="What should LocalPilot do differently?" aria-label="Guidance for the next attempt"><button class="btn sm primary" type="submit">Send</button><button class="btn sm ghost" type="button" data-x="1">Cancel</button>');
          form.onsubmit = (ev) => { ev.preventDefault(); const t = form.querySelector('input').value.trim(); if (t) { send('retryWithGuidance', t); } };
          form.querySelector('[data-x]').onclick = () => form.remove();
          box.appendChild(form);
        }
        form.querySelector('input').focus(); return;
      }
      send(a);
    };
    return box;
  }
  /** Draws / updates a recovery card element from its merged payload. */
  function recPaint(card, p) {
    card.querySelector(':scope > .rec-head .t').textContent = recHeader(p);
    card.__p = p;
    const sig = JSON.stringify([p.phase, p.reached, p.title, p.rootCause, p.checks, p.patches, p.decision, p.outcome, p.rbSent]);
    const body = card.querySelector(':scope > .rec-body');
    if (body.dataset.sig !== sig) { body.dataset.sig = sig; body.innerHTML = recBody(p); }
    card.classList.toggle('running', !(p.outcome && recTerminal(p.outcome)));
    recFinal(card, p);
  }
  function recCardEl(sid, p) {
    const card = el('div', 'rec running', `<div class="rec-head"><span class="ico">${I.refresh}</span><span class="t"></span><button class="link rec-details" type="button" title="Open this chat's recovery in the self-healing dashboard">Details</button></div><div class="rec-body"></div><div class="rec-verify"><div class="rec-vh">Verification</div><div class="rec-rows"></div></div><div class="rec-final"></div>`);
    card.dataset.sid = sid; card.dataset.rid = p.id || '';
    card.setAttribute('role', 'group'); card.setAttribute('aria-label', 'Self-healing');
    card.querySelector(':scope > .rec-head .rec-details').onclick = () => post({ type: 'openRecovery', sessionId: card.dataset.sid });
    const body = card.querySelector(':scope > .rec-body');
    // Enter / Space on a chip or patch row acts like a click (they are role=button).
    body.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('[data-ex], li[data-file]')) { e.preventDefault(); e.target.click(); } };
    body.onclick = (e) => {
      const chip = e.target.closest('[data-ex]');
      if (chip) {
        const c = ((card.__p && card.__p.checks) || []).find((x) => x.id === chip.dataset.ex); const host = chip.closest('.rec-checks'); if (!c || !host) { return; }
        const open = host.nextElementSibling && host.nextElementSibling.classList.contains('rec-ex') && host.nextElementSibling.dataset.id === c.id ? host.nextElementSibling : null;
        for (const x of body.querySelectorAll('.rec-ex')) { x.remove(); } for (const x of body.querySelectorAll('[data-ex]')) { x.setAttribute('aria-expanded', 'false'); }
        if (!open) { const pre = el('pre', 'rec-ex'); pre.dataset.id = c.id; pre.textContent = c.excerpt; host.after(pre); chip.setAttribute('aria-expanded', 'true'); }
        return;
      }
      const row = e.target.closest('li[data-file]');
      if (row && !e.target.closest('button')) { post({ type: 'showDiff', sessionId: card.dataset.sid, fsPath: row.dataset.file }); return; }
      const b = e.target.closest('button[data-rb]'); const cur = card.__p; if (!b || b.disabled || !cur) { return; }
      const k = b.dataset.rb;
      recPost(card.dataset.sid, card.dataset.rid || cur.id, 'rollback', k ? { attempt: Number(k) } : null);
      cur.rbSent = [...(Array.isArray(cur.rbSent) ? cur.rbSent : []), k];
      recPaint(card, cur);
    };
    recPaint(card, p);
    return card;
  }
  /** The live card for a payload: by id, else the id-less verification card adopted, else a new one above the stream. */
  function recLiveCard(live, sid, id) {
    let card = id ? live.root.querySelector(`:scope > .rec[data-rid="${CSS.escape(id)}"]`) : null;
    if (!card) { card = live.root.querySelector(':scope > .rec[data-rid=""]'); if (card && id) { card.dataset.rid = id; } }
    // Steps that come after the card (a fixer worker, the next edits) start a new block below it, in order.
    if (!card) { rotateBody(live); card = recCardEl(sid, { id: id || '', phase: 'verifying', reached: -1 }); live.root.insertBefore(card, live.body); if (live.steps.children.length) { live.steps = el('div', 'steps'); live.root.insertBefore(live.steps, live.body); } else { live.root.insertBefore(live.steps, live.body); } }
    return card;
  }
  function onRecovery(live, sid, p, visible) {
    if (!p || typeof p !== 'object') { return; }
    const cache = recCache(sid);
    const m = recMerge(cache.cards.get(p.id) || cache.cards.get(''), p); cache.cards.delete(''); cache.cards.set(p.id, m);
    recPaint(recLiveCard(live, sid, p.id), m);
    if (!recTerminal(m.outcome)) { const t = `Self-healing: ${REC_PHASE[m.phase] || m.phase}${m.decision ? ` · ${m.decision}` : ''}`; noteStatus(sid, t); if (visible) { setStatus(t); } setPhase(live, 'Self-healing'); }
    followLive(live);
  }
  /** `turn_end` with the engine's verdict: settles a card still open and labels the answer footer once the transcript reloads. */
  function recTurnEnd(live, sid, pl, visible) {
    if (!pl || !pl.outcome) { return; }
    const c = recCache(sid); const rid = pl.recovery && pl.recovery.id; c.outcome = { outcome: pl.outcome, contract: pl.contract, id: rid, report: pl.recovery && pl.recovery.report };
    const key = rid && c.cards.has(rid) ? rid : [...c.cards.keys()].pop();
    if (key !== undefined && !recTerminal(c.cards.get(key).outcome)) { onRecovery(live, sid, { id: key, phase: pl.outcome, outcome: pl.outcome, contract: pl.contract, attempt: pl.recovery && pl.recovery.attempts || undefined }, visible); }
  }
  /** A worker's event forwarded under this chat's id (`{ childId, agent, inner, data }`)? A root recovery payload may
   *  name the worker it delegated to in its own `childId`; only wrapped events carry `data`. */
  function wrappedChild(e) {
    return !!(e.payload && typeof e.payload === 'object' && e.payload.childId && e.type !== 'subagent_start' && e.type !== 'subagent_end' && !(e.type === 'recovery' && !('data' in e.payload)));
  }
  function onChildRecovery(live, sid, pl, visible) {
    const d = pl.data; if (!d || typeof d !== 'object') { return; }
    recChild(live.subs.get(pl.childId), d, false);
    if (!recTerminal(d.outcome || d.phase)) { childStatus(live, sid, pl.childId, pl.agent, `self-healing: ${REC_PHASE[d.phase] || d.phase}`, visible); }
    followLive(live);
  }
  /** A verification tool row (origin healing) goes under the card, not in the turn's steps. */
  function recToolRows(live, sid) {
    const c = recCache(sid); if (!c.cards.size) { c.cards.set('', { id: '', phase: 'verifying', reached: 3 }); }
    const last = [...live.root.querySelectorAll(':scope > .rec')].pop();
    return (last && last.classList.contains('running') ? last : recLiveCard(live, sid, '')).querySelector(':scope > .rec-verify > .rec-rows');
  }
  /** A worker's recovery: one compact line (and its verification rows) inside the subagent row. */
  function recChild(sub, d, toolRow) {
    const rows = sub && (sub.querySelector(':scope > .content > .subrows') || sub.querySelector('.subrows')); if (!rows) { return null; }
    let mini = rows.querySelector(':scope > .rec-mini');
    if (!mini) { mini = el('div', 'rec-mini running', '<div class="rm-line"><span class="ico"></span><span class="t">Self-healing</span><span class="chips"></span></div><div class="rec-rows"></div>'); mini.querySelector('.ico').innerHTML = I.refresh; rows.appendChild(mini); }
    if (toolRow) { return mini.querySelector('.rec-rows'); }
    const p = recMerge(mini.__p, d); mini.__p = p;
    const out = p.outcome && recTerminal(p.outcome) ? p.outcome : '';
    mini.className = `rec-mini ${out ? (out === 'completed' ? 'ok' : out === 'completed_unverified' ? 'warn' : out === 'cancelled' ? 'off' : 'bad') : 'running'}`;
    const head = recHeader(p).replace(/^Self-healing/, out === 'completed' ? 'Recovered' : out === 'completed_unverified' ? 'Not verified' : out && out !== 'cancelled' ? 'Needs attention' : 'Self-healing');
    mini.querySelector('.t').textContent = `${head}${!out && p.phase ? ` · ${REC_PHASE[p.phase] || p.phase}` : ''}`;
    mini.querySelector('.t').title = [p.title, p.rootCause && `Root cause: ${p.rootCause}`, p.decision].filter(Boolean).join('\n');
    mini.querySelector('.chips').innerHTML = (Array.isArray(p.checks) ? p.checks : []).map((c) => `<b class="${esc(c.status)}" title="${esc(`${c.id}: ${c.status}${c.skipReason ? ` (${c.skipReason})` : ''}`)}">${c.status === 'passed' ? '✓' : c.status === 'failed' ? '✗' : c.status === 'timeout' ? '⏱' : '–'}</b>`).join('');
    return mini;
  }
  /** Replay: the card of a finished turn. The full payload when this webview saw the turn, else the stored footer. */
  function recSettled(sid, p, report) {
    if (p) { const card = recCardEl(sid, p); if (!card.querySelector('.rec-rows').children.length) { card.querySelector('.rec-verify').remove(); } return card; }
    const out = reportOutcome(report);
    const n = el('div', `rec settled ${out === 'completed' ? 'ok' : out === 'completed_unverified' ? 'warn' : out ? 'bad' : ''}`, `<div class="rec-head"><span class="ico">${out === 'completed' ? I.check : out ? I.warn : I.refresh}</span><span class="t">Self-healing</span></div><div class="rec-report"></div>`);
    n.querySelector('.rec-report').textContent = report;
    return n;
  }
  /** The turn this webview watched finish: its full cards replace the stored footer card, and its outcome labels the footer. */
  function recReplay(sid) {
    const rc = state.recovery.get(sid); if (!rc) { return; }
    // The cards belong to the answer at the position the turn ended at; a transcript cut back (checkpoint restore, undo) drops them.
    const s = state.session; const at = s && s.id === sid ? userTurns(s.messages, s.messages.length) : undefined;
    if (rc.at === undefined) { rc.at = at; } else if (at !== rc.at) { state.recovery.delete(sid); return; }
    const turn = [...els.messages.querySelectorAll(':scope > .turn.assistant:not(.plancard)')].pop(); if (!turn) { return; }
    if (rc.cards.size) {
      const stored = [...turn.querySelectorAll(':scope > .rec.settled')].pop();
      const ref = stored || [...turn.querySelectorAll(':scope > .body')].pop() || turn.querySelector(':scope > .afoot');
      const cards = rc.els && rc.els.length ? rc.els : [...rc.cards.values()].map((p) => recSettled(sid, p));
      for (const card of cards) { card.classList.remove('running'); if (ref) { turn.insertBefore(card, ref); } else { turn.appendChild(card); } }
      if (stored) { stored.remove(); }
    }
    const o = rc.outcome; const info = turn.querySelector(':scope > .afoot .info');
    // Without a contract the engine was off: 'completed' then only means "ended with an answer", not verified.
    if (o && info && !info.querySelector('.outcome') && BADGE[o.outcome] && (o.contract || o.outcome !== 'completed')) { info.insertAdjacentHTML('afterbegin', outcomeBadge(o.outcome, o.report) + (info.children.length ? '<i>·</i>' : '')); }
  }
  /** The id an interrupted card's actions name: the store's key for it (`recoveryId` if the host sent one, else the session). */
  const recInterruptedId = (sid, st) => String(st.recoveryId || st.sessionId || st.sid || sid);
  /** "Recovery interrupted" (a reload or exit stopped it mid-way): Resume, Rollback fixes or Dismiss. */
  function renderInterrupted() {
    for (const n of els.messages.querySelectorAll(':scope > .rec-int')) { n.remove(); }
    const s = state.session; const st = s && state.interrupted.get(s.id);
    if (!s || state.running.has(s.id) || state.live.has(s.id)) { return; }
    // No recovery to resume: a plain run cut off by a reload gets the Run interrupted card (drawn outside this section).
    if (!st) { if (typeof renderRunInterrupted === 'function') { renderRunInterrupted(s); } return; }
    const n = typeof st.attempt === 'number' ? st.attempt : Array.isArray(st.attempts) ? st.attempts.length : 0;
    const last = Array.isArray(st.attempts) && st.attempts.length ? st.attempts[st.attempts.length - 1] : null;
    const cat = st.category || (last && last.category);
    // The store overwrites `phase` with 'interrupted'; only a phase from before that says where it stopped.
    const ph = [st.lastPhase, st.phase].find((x) => typeof x === 'string' && x && x !== 'interrupted');
    const facts = [ph ? `Stopped while ${REC_PHASE[ph] || ph}` : 'Stopped before it finished', n && `attempt ${n}${st.max ? `/${st.max}` : ''}`, cat && (REC_CAT[cat] || cat)].filter(Boolean).join(' · ');
    const fails = (Array.isArray(st.active) ? st.active : []).slice(0, 3).map((f) => `<li>${f.code ? `<code>${esc(f.code)}</code> ` : ''}${short(String(f.message || ''), 120)}${f.file ? ` <span class="at">${esc(f.file)}${f.line ? `:${esc(f.line)}` : ''}</span>` : ''}</li>`).join('');
    const cause = (st.intervention && st.intervention.rootCause) || (last && last.rootCause) || st.rootCause;
    // The files changed so far (not yet kept or reverted), so Resume / Rollback are not a blind choice.
    const changed = (state.changes && state.changes.get(s.id)) || [];
    const files = changed.slice(0, 6).map((f) => `<li title="${esc(f.path || f.fsPath || '')}">${esc(f.path || f.fsPath || '')}</li>`).join('') + (changed.length > 6 ? `<li class="more">+${changed.length - 6} more</li>` : '');
    const review = changed.length ? `<button class="btn sm ghost" data-run="review" title="Open the changes this chat made so far">${I.diff || ''}<span>Review changes so far</span></button>` : '';
    const card = el('div', 'rec rec-int warn', `<div class="rec-head"><span class="ico">${I.pause}</span><span class="t">Recovery interrupted</span></div><div class="rec-body"><div class="rec-title">${esc(facts)}</div>${cause ? `<div class="rec-cause"><span>Root cause:</span> ${esc(cause)}</div>` : ''}${fails ? `<ul class="rec-fails">${fails}</ul>` : ''}${files ? `<div class="rec-vh">${changed.length} file${changed.length === 1 ? '' : 's'} changed so far</div><ul class="rec-files">${files}</ul>` : ''}</div><div class="rec-final"><div class="rec-acts"><button class="btn sm primary" data-ra="resume" title="Re-run the checks, then continue fixing where it stopped">${I.play}<span>Resume</span></button><button class="btn sm" data-ra="rollback" title="Undo the files the interrupted fix attempts changed">${I.undo}<span>Rollback fixes</span></button>${review}<button class="btn sm ghost" data-ra="dismiss" title="Keep the files as they are and forget this recovery">Dismiss</button></div></div>`);
    card.querySelector('.rec-acts').onclick = (e) => {
      const r = e.target.closest('button[data-run]'); if (r) { post({ type: 'runAction', sessionId: s.id, action: r.dataset.run }); return; }
      const b = e.target.closest('button[data-ra]'); if (!b) { return; }
      recPost(s.id, recInterruptedId(s.id, st), b.dataset.ra);
      if (b.dataset.ra === 'resume') { card.querySelectorAll('button').forEach((x) => { x.disabled = true; }); b.classList.add('busy'); }
      else { state.interrupted.delete(s.id); card.remove(); }
    };
    els.messages.appendChild(card);
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
    // The composer floats over the transcript, so the button sits just above the composer, not at the transcript's edge.
    if (show) { jump.style.top = `${Math.round((composerEl ? composerEl.getBoundingClientRect().top : m.getBoundingClientRect().bottom) - 40)}px`; }
  }
  // A line cut by the transcript's top edge fades out instead of looking like it slides under the task card.
  const markScrolled = () => { const m = els.messages; const top = m.scrollTop > 2; const below = m.scrollHeight - m.scrollTop - m.clientHeight > 2; if (m.classList.contains('scrolled') !== top) { m.classList.toggle('scrolled', top); } if (m.classList.contains('below') !== below) { m.classList.toggle('below', below); } };
  els.messages.addEventListener('scroll', () => { noteScroll(); updateJump(); markScrolled(); }, { passive: true });
  window.addEventListener('resize', () => { noteScroll(); updateJump(); });
  // Sticky last user message: once the request the reader is looking at has scrolled out above the viewport, a strip
  // at the top of the transcript shows it; clicking it scrolls back to that message.
  // A plain strip, not a tooltip: an aria-label names the action, and the "Jump" hint shows on hover and focus.
  const stickyUser = el('button', 'stickyuser hidden');
  stickyUser.type = 'button'; stickyUser.setAttribute('aria-label', 'Your request. Jump back to this message');
  $('app').appendChild(stickyUser);
  let stickyTarget = null; let stickyPending = false;
  function updateStickyUser() {
    stickyPending = false;
    const m = els.messages; const top = m.getBoundingClientRect().top;
    const turns = m.querySelectorAll('.turn.user');
    let target = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      const r = turns[i].getBoundingClientRect();
      if (r.top < top) { target = r.bottom <= top + 4 ? turns[i] : null; break; }
    }
    syncFirstTurnShown();
    if (target && taskHeadCovers(target)) { target = null; }
    stickyTarget = target;
    if (!target) { stickyUser.classList.add('hidden'); return; }
    const ut = target.querySelector('.utext');
    const text = ((ut ? ut.textContent : target.textContent) || '').replace(/\s+/g, ' ').trim();
    if (stickyUser.dataset.text !== text) {
      stickyUser.dataset.text = text;
      stickyUser.innerHTML = `<span class="lead">${I.reply}<span>You</span></span><span class="txt"></span><span class="go" aria-hidden="true">Jump<svg viewBox="0 0 16 16"><path d="M4.5 9.5 8 6l3.5 3.5"/></svg></span>`;
      stickyUser.querySelector('.txt').textContent = text;
    }
    placeSticky();
    stickyUser.classList.remove('hidden');
  }
  /** Pins the strip to the transcript's top edge, measured, not remembered: the task header above changes height on its own. */
  function placeSticky() {
    const top = Math.round(els.messages.getBoundingClientRect().top - $('app').getBoundingClientRect().top);
    if (stickyUser.style.top !== `${top}px`) { stickyUser.style.top = `${top}px`; }
  }
  // The transcript moves when the task header collapses, expands or gets its badges: re-pin (and re-check) then.
  if (typeof ResizeObserver === 'function') { new ResizeObserver(() => { markScrolled(); if (!stickyUser.classList.contains('hidden')) { scheduleSticky(); } }).observe(els.messages); }
  const scheduleSticky = () => { if (!stickyPending) { stickyPending = true; requestAnimationFrame(updateStickyUser); } };
  els.messages.addEventListener('scroll', scheduleSticky, { passive: true });
  window.addEventListener('resize', scheduleSticky);
  stickyUser.onclick = () => { if (stickyTarget && stickyTarget.isConnected) { stickyTarget.scrollIntoView({ block: 'start', behavior: calmMotion() ? 'auto' : 'smooth' }); } stickyUser.classList.add('hidden'); };
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
    for (const node of [...live.subTools.values(), ...live.tools.values()]) { if (node.classList.contains('running')) { finishTool(node, { isError: true, content: 'Cancelled' }, sessionId); } }
    clearWait(live);
    // "Exit 1 · the agent will read the output…" no longer holds once the run is over.
    for (const n of live.root.querySelectorAll('.term-next[data-live]')) { if (live.stopped) { n.querySelector('span').textContent = 'run stopped'; delete n.dataset.live; } else { n.remove(); } }
    for (const c of live.subs.values()) { if (c.classList.contains('running')) { finishSubagent(c, '', 'Cancelled'); } }
    // Hook rows still running are left as they are: their result arrives after the turn (handleEvent's outside-a-run branch).
    finishThinking(live);
    if (live.work) { settleWork(live.root, live.work, turnStats(live.root), live.durationMs || liveElapsed(live, Date.now()), live.failed && !live.stopped, !!live.stopped); live.work = null; }
    // The recovery cards (with their verification rows and any open guidance box) outlive the live turn: the reloaded transcript reuses them.
    const rc = state.recovery.get(sessionId); if (rc) { rc.els = [...live.root.querySelectorAll(':scope > .rec')]; for (const c of rc.els) { if (c.classList.contains('running')) { c.classList.remove('running'); c.querySelector(':scope > .rec-body .rec-decision')?.remove(); } } }
    // Where the turn sits in the transcript (its user message is before `liveFrom`): replay only puts the cards back there.
    const s = state.session; if (rc && s && s.id === sessionId && typeof s.liveFrom === 'number') { rc.at = userTurns(s.messages, s.liveFrom); }
    state.live.delete(sessionId);
  }
  function renderHookRow(row, h) {
    const end = h.status === 'running' ? `${I.spin}` : `→ <b class="st ${esc(h.status)}">${esc(h.status)}</b>${typeof h.ms === 'number' ? ` <i>${esc(h.ms)} ms</i>` : ''}`;
    row.className = `note hook ${esc(h.status || '')}`;
    row.innerHTML = `<span class="gear" aria-hidden="true">⚙</span> ${esc(h.event)} <code>${esc(h.name)}</code>${h.tool ? ` <span class="tool">${esc(h.tool)}</span>` : ''} ${end}`;
  }
  function handleEvent(e) {
    const sid = e.sessionId; const visible = state.session && state.session.id === sid;
    // Events outside a run (memory saved after it, a custom command's preparation) must not open a live turn nobody ends.
    if (!state.running.has(sid) && !state.pendingSend.has(sid) && !state.live.has(sid)) {
      // A hook that outlived its turn (TaskCancel, TaskError, a Notification) finishes its row where the turn left it.
      if (e.type === 'hook') { const h = e.payload || {}; const row = h.id && !h.childId && document.querySelector(`.note.hook[data-hid="${CSS.escape(String(h.id))}"]`); if (row) { renderHookRow(row, h); } }
      else if (e.type === 'memory') { if (visible && e.payload && e.payload.saved && e.payload.saved.length) { toast(`Saved to memory: ${e.payload.saved.join(', ')}`, 'info'); } }
      else if (e.type === 'context') { if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); } }
      else if (e.type === 'error' && visible) { toast(errorText(e.payload), 'error'); }
      return;
    }
    const live = ensureLive(sid);
    // A worker's events forwarded under this chat's id; only the kinds drawn on its lane are handled below.
    const child = wrappedChild(e);
    if (child && !['status', 'tool_start', 'tool_end', 'tool_progress', 'model_request'].includes(e.type)) {
      const d = e.payload.data;
      if (e.type === 'error') { childStatus(live, sid, e.payload.childId, e.payload.agent, errorText(d), visible); }
      else if (e.type === 'retry' && d) { childStatus(live, sid, e.payload.childId, e.payload.agent, `retrying ${d.attempt}/${d.max}`, visible); }
      else if (e.type === 'recovery') { onChildRecovery(live, sid, e.payload, visible); }
      return;
    }
    switch (e.type) {
      case 'assistant_delta': if (live.waitRow) { clearWait(live); } if (live.retryRow) { retryRecovered(live); } live.text += e.payload; noteStream(live, String(e.payload).length); setPhase(live, 'Writing'); scheduleRender(live); break;
      case 'steer': {
        // Queued rows become part of the transcript; what streams next belongs after them.
        rotateBody(live);
        for (const id of (e.payload && e.payload.ids) || []) { const row = live.root.querySelector(`.steer[data-steer-id="${CSS.escape(id)}"]`); if (row) { row.classList.remove('queued'); row.querySelector('.badge').textContent = 'added'; live.root.appendChild(row); } }
        if (live.root.lastElementChild !== live.body) { live.steps = el('div', 'steps'); live.root.appendChild(live.steps); live.body = el('div', 'body'); live.root.appendChild(live.body); }
        showTyping(live); break;
      }
      case 'thinking_delta':
        if (live.waitRow) { clearWait(live); } if (live.retryRow) { retryRecovered(live); }
        live.thinking += e.payload; noteStream(live, String(e.payload).length); clearTyping(live); setPhase(live, 'Thinking');
        if (!live.thinkingEl) {
          // Open while the model reasons so the user reads along; it folds back to "Thought …" once the answer starts.
          live.thinkStart = Date.now(); live.thinkingEl = thinkingRow('', 0, true); live.thinkingEl.open = true; live.steps.appendChild(live.thinkingEl);
          const row = live.thinkingEl; row.querySelector(':scope > summary').addEventListener('click', () => { row.dataset.user = '1'; });
        }
        scheduleThinking(live);
        break;
      case 'status':
        if (e.payload && typeof e.payload === 'object' && e.payload.childId) {
          const d = e.payload.data;
          const t = e.payload.inner === 'status' && typeof d === 'string' ? d : e.payload.inner === 'tool_start' && d ? d.name : '';
          if (t) { childStatus(live, sid, e.payload.childId, e.payload.agent, t, visible); }
        } else { const t = typeof e.payload === 'string' ? e.payload : ''; noteStatus(sid, t); if (visible) { setStatus(t); } if (t) { setPhase(live, /^Continuing\b/.test(t) ? 'Thinking' : t.replace(/…$/, '')); } }
        break;
      case 'tool_start': {
        finishThinking(live);
        if (e.payload && e.payload.childId) {
          // A subagent's tool call: render it as a nested row under that agent's pill.
          const d = e.payload.data || {}; const sub = live.subs.get(e.payload.childId);
          if (sub && d.name !== 'manage_todos') {
            const rows = d.origin === 'healing' ? recChild(sub, d, true) : sub.querySelector(':scope > .content > .subrows') || sub.querySelector('.subrows');
            if (rows) { const node = placeTool(rows, { id: d.id, name: d.name, arguments: JSON.stringify(d.args || {}) }, null); if (node) { live.subTools.set(`${e.payload.childId}:${d.id}`, node); node.__t0 = Date.now(); } sub.dataset.calls = String(Number(sub.dataset.calls || 0) + 1); }
          }
          childStatus(live, sid, e.payload.childId, e.payload.agent, plainLabel(toolLabel(d.name, d.args || {}, true)), visible);
          followLive(live);
          break;
        }
        const heal = e.payload.origin === 'healing';
        if (!heal) { rotateBody(live); }
        clearWait(live); retryRecovered(live);
        const node = placeTool(heal ? recToolRows(live, sid) : live.steps, { id: e.payload.id, name: e.payload.name, arguments: JSON.stringify(e.payload.args || {}) }, null);
        if (node) { live.tools.set(e.payload.id, node); node.__t0 = Date.now(); if (e.payload.todoId) { node.dataset.todo = String(e.payload.todoId); linkTodo(String(e.payload.todoId)); } }
        setPhase(live, heal ? 'Verifying' : PHASES[e.payload.name] || 'Working'); updateWork(live);
        noteStatus(sid, toolLabel(e.payload.name, e.payload.args || {}, true).replace(/<[^>]+>/g, ''));
        followLive(live);
        break;
      }
      case 'tool_progress': {
        const d = e.payload && e.payload.childId ? e.payload.data || {} : e.payload || {};
        const node = e.payload && e.payload.childId ? live.subTools.get(`${e.payload.childId}:${d.id}`) : live.tools.get(d.id);
        if (node && typeof d.chunk === 'string') { termOutput(node, d.chunk); if (visible) { followLive(live); } }
        break;
      }
      case 'tool_end':
        if (e.payload && e.payload.childId) { const d = e.payload.data || {}; finishTool(live.subTools.get(`${e.payload.childId}:${d.id}`), d); break; }
        finishTool(live.tools.get(e.payload.id), e.payload, sid); if (isDenied(e.payload)) { markDenied(live.tools.get(e.payload.id)); } unmarkApproval(live.tools.get(e.payload.id)); showTyping(live); break;
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
            hostProgress(host);
          } else { live.steps.appendChild(c); }
        }
        c.dataset.childId = e.payload.childId; live.subs.set(e.payload.childId, c);
        if (c.closest('.subhost.workers')) { c.open = false; }
        setPhase(live, 'Coordinating workers'); updateWork(live);
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
      case 'model_request': {
        if (e.payload && e.payload.childId) {
          // A worker's request names the model that really answers it (the router may have spread it to an idle one): show it on the lane.
          const d = e.payload.data || {}; const sub = live.subs.get(e.payload.childId);
          if (sub && d.model) { const pill = sub.querySelector(':scope > summary .pill'); const name = modelName(d.model); const el0 = pill && pill.querySelector('.model'); if (el0) { el0.textContent = name; } else if (pill && name) { pill.insertAdjacentHTML('beforeend', `<i>·</i><span class="model">${esc(name)}</span>`); } const task = sub.querySelector(':scope > summary .lane-task'); if (task) { task.title = `${task.title.replace(/\nModel: .*$/, '')}\nModel: ${name}`; } }
          break;
        }
        state.modelOf.set(sid, e.payload.model); if (e.payload.queued) { noteStatus(sid, `Waiting for ${e.payload.name} — busy with ${e.payload.queued} other chat${e.payload.queued === 1 ? '' : 's'}…`); } scheduleBg(); break;
      }
      case 'todos': if (state.session && state.session.id === sid) { state.session.todos = Array.isArray(e.payload) ? e.payload : []; renderTasks(); updateWork(live); } break;
      case 'nudge': {
        // Self-healing's hidden fix prompts are not nudges: nothing was retracted.
        if (e.payload && e.payload.healing) { break; }
        // A text reply cut off at the output limit is being continued: the rest streams on into the same body.
        if (e.payload && e.payload.reason === 'length' && e.payload.continued) {
          const st = 'Reply cut off at the output limit — continuing…'; noteStatus(sid, st); if (visible) { setStatus(st); }
          showTyping(live); followLive(live);
          break;
        }
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
      // The meter follows the run: an estimate before each request, the server's real count after it.
      case 'context': if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); } break;
      // Facts the finished run taught, saved to project memory after the answer.
      case 'memory': if (visible && e.payload && e.payload.saved && e.payload.saved.length) { toast(`Saved to memory: ${e.payload.saved.join(', ')}`, 'info'); } break;
      case 'compaction': rotateBody(live); live.root.insertBefore(el('div', 'note', `Context compacted: ${e.payload.before.toLocaleString()} → ${e.payload.after.toLocaleString()} tokens (${e.payload.removed} messages summarised)`), live.body); break;
      case 'skill_suggestions': { rotateBody(live); const n = skillSuggestionNote(e.payload || {}); if (n) { live.root.insertBefore(n, live.body); } break; }
      case 'clarify': rotateBody(live); live.root.insertBefore(el('div', 'note', `Request looks ambiguous (${esc((e.payload && e.payload.reasons || []).join('; '))}) — interpreting it from the editor, open files, errors and git changes.`), live.body); break;
      case 'hook': {
        // One compact row per hook run ("⚙ PreToolUse lint-guard → blocked"), updated in place when it finishes.
        const h = e.payload || {}; if (h.childId || !h.id) { break; }
        let row = live.root.querySelector(`.note.hook[data-hid="${CSS.escape(String(h.id))}"]`);
        if (!row) { rotateBody(live); row = el('div', 'note hook'); row.dataset.hid = String(h.id); live.root.insertBefore(row, live.body); }
        renderHookRow(row, h);
        break;
      }
      case 'rules_applied': { const files = (e.payload && e.payload.files) || []; if (files.length) { rotateBody(live); live.root.insertBefore(el('div', 'note rules', `Conditional rules applied: ${files.map((f) => `<code>${esc(f)}</code>`).join(', ')}`), live.body); } break; }
      case 'retry': {
        // One row per turn, updated in place: "Retrying 2/3 in 4s: connection dropped", then "Recovered on attempt 2".
        clearWait(live);
        const p = e.payload || {}; const why = { empty: 'the model returned nothing', stall: 'the model stopped responding', network: 'the connection dropped', server: 'the model server returned an error', ratelimit: 'the server is rate limiting', overload: 'the model ran out of memory', toolcall: 'the tool call could not be read' }[p.reason] || 'a temporary error';
        const total = Number(p.max) + 1; const next = Number(p.attempt) + 1; const wait = Number(p.delayMs) >= 1000 ? ` in ${Math.round(p.delayMs / 1000)}s` : '';
        let row = live.retryRow && live.retryRow.isConnected ? live.retryRow : null;
        if (!row) { rotateBody(live); row = el('div', 'note retry'); row.setAttribute('role', 'status'); live.root.insertBefore(row, live.body); live.retryRow = row; }
        row.className = 'note retry'; row.dataset.attempt = String(next);
        row.innerHTML = `<span class="ico">${I.spin}</span><span>Retrying ${esc(next)}/${esc(total)}${esc(wait)}: ${esc(why)}${p.adjust ? ` (${esc(p.adjust)})` : ''}</span>`;
        row.title = String(p.message || '');
        noteStatus(sid, `Retrying (${p.attempt}/${p.max})…`); if (visible) { setStatus(`Retrying (${p.attempt}/${p.max})…`); }
        break;
      }
      case 'waiting': showWait(live, sid, e.payload || {}); break;
      case 'route': routeNote(live, sid, e.payload || {}); break;
      case 'error': { clearWait(live); if (live.retryRow) { live.retryRow.className = 'note retry failed'; live.retryRow.querySelector('.ico').innerHTML = I.warn; live.retryRow = null; } rotateBody(live); live.failed = true; setPhase(live, e.payload && e.payload.kind === 'mistake_limit' ? 'Stopped' : 'Failed'); const box = errorBox(e.payload); errorActions(box, sid); live.root.insertBefore(box, live.body); break; }
      case 'recovery': onRecovery(live, sid, e.payload, visible); for (const n of live.root.querySelectorAll('.step.has-tests')) { syncHealLink(n); } break;
      case 'turn_end': noteStatus(sid, 'Finishing…'); recTurnEnd(live, sid, e.payload, visible); if (e.payload && typeof e.payload.durationMs === 'number') { live.durationMs = e.payload.durationMs; } if (visible && e.payload && typeof e.payload.contextTokens === 'number') { state.session.contextTokens = e.payload.contextTokens; updateCtx(); } break;
    }
  }

  /** Chips for skills matching the request (click → prefill `/skill name`), a catalog skill installed/offered for it, and a recurring request type worth saving as a skill. */
  function skillSuggestionNote(p) {
    const skills = p.skills || []; const preloaded = p.preloaded || []; const create = p.create; const installed = p.installed; const available = p.available; const ready = p.ready;
    if (!skills.length && !preloaded.length && !create && !installed && !available && !ready) { return null; }
    const n = el('div', 'note skills');
    const sid = state.session && state.session.id;
    const prune = (wrap) => { wrap.remove(); if (!n.querySelector('.learn, .chip')) { n.remove(); } };
    if (ready) {
      const row = el('div', 'learn');
      row.appendChild(el('span', 'lbl', `${I.check || ''}“${esc(ready.name)}” is installed. Run the request again with it:`));
      const use = el('button', 'chip brand', `${I.play || ''}Use “${esc(ready.name)}”`); use.title = `Prefills /skill ${ready.name} with your last request — press Enter to send`;
      use.onclick = () => { els.input.value = `/skill ${ready.name} ${ready.prompt || ''}`.trim(); autoGrow(); updateSendEnabled(); els.input.focus(); };
      row.appendChild(use); n.appendChild(row);
    }
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
      get.dataset.install = available.name;
      get.onclick = () => { post({ type: 'installCatalogSkill', name: available.name, repo: available.repo, sessionId: sid }); get.disabled = true; get.innerHTML = `${I.spin || ''}Installing…`; };
      const no = el('button', 'chip', 'Not now'); no.title = 'Do not offer this skill again'; no.onclick = () => { post({ type: 'dismissCatalogSkill', name: available.name, sessionId: sid }); prune(wrap); };
      wrap.appendChild(get); wrap.appendChild(no); n.appendChild(wrap);
    }
    if (create) {
      const wrap = el('div', 'learn');
      wrap.appendChild(el('span', 'lbl', `Requests like this have come up ${create.count}× with no skill covering them.`));
      const mk = el('button', 'chip brand', `${I.plus || ''}Create “${esc(create.slug)}” skill`); mk.title = 'Prefills a prompt asking the agent to write .localpilot/skills/' + create.slug + '/SKILL.md from what worked here';
      mk.onclick = () => { els.input.value = `Create a reusable skill at .localpilot/skills/${create.slug}/SKILL.md for requests like: ${(create.samples || []).map((x) => `"${x}"`).join(', ')}. Use front-matter (name, description with quoted trigger phrases) and a step-by-step body based on how we handled it in this project, then reload skills.`; autoGrow(); updateSendEnabled(); els.input.focus(); };
      const no = el('button', 'chip', 'Not now'); no.onclick = () => { post({ type: 'dismissSkillTopic', topic: create.topic }); prune(wrap); };
      wrap.appendChild(mk); wrap.appendChild(no); n.appendChild(wrap);
    }
    return n;
  }

  // ------------------------------------------------------------------ composer state
  function setStatus(text) { els.statusText.textContent = text || ''; els.status.classList.toggle('hidden', !text); }
  function setRunning(running) { fitModelChip(); els.send.classList.toggle('hidden', running); els.stop.classList.toggle('hidden', !running); els.pause.classList.toggle('hidden', !running); els.progress.classList.toggle('hidden', !running); if (!running) { setStatus(''); } syncPause(); updateSendEnabled(); updateJump(); }
  function updateSendEnabled() { els.send.disabled = !els.input.value.trim() && !state.images.length; syncEmptyChrome(); }
  /** Pause button, progress bar and placeholder follow the active session's pause state. */
  function syncPause() {
    const sid = state.session && state.session.id; const p = (sid && state.paused.get(sid)) || { paused: false, holding: false };
    els.pause.classList.toggle('on', p.paused);
    els.pause.innerHTML = p.paused ? I.play : I.pause;
    els.pause.title = p.paused ? (p.holding ? `Resume (${kb('Alt+Esc')})` : 'Pausing after the current step… click to cancel') : `Pause after the current step (${kb('Alt+Esc')})`;
    els.progress.classList.toggle('paused', p.paused);
    document.body.classList.toggle('paused', !!(sid && state.running.has(sid) && p.paused));
    syncPlaceholder();
  }
  function togglePause() { if (!state.session || !state.running.has(state.session.id)) { return; } const p = state.paused.get(state.session.id); post({ type: p && p.paused ? 'resume' : 'pause', sessionId: state.session.id }); }
  function updateCtx() {
    const s = state.session; if (!s) { return; }
    const model = currentModel() || state.models[0];
    const win = model ? effectiveWindow(model) : 32768; const used = s.contextTokens || 0; const pct = Math.min(100, Math.round((used / win) * 100));
    els.ctx.style.setProperty('--pct', pct); els.ctx.querySelector('.txt').textContent = `${pct}%`;
    const native = model && model.contextWindow > win ? model.contextWindow : 0;
    // The breakdown lives in the hover card (ctxCard); a native tooltip would cover it.
    state.ctxInfo = { used, win, pct, native, compactions: s.compactions || 0 };
    els.ctx.removeAttribute('title'); els.ctx.setAttribute('aria-label', `Context ${pct}% used: ${used.toLocaleString()} of ${win.toLocaleString()} tokens. Click to compact`);
    els.ctx.setAttribute('aria-disabled', String(state.running.has(s.id)));
    refreshCtxCard();
    // No model, no window to measure against: the ring would only ever say 0%, so it hides.
    els.ctx.className = `ctx ${pct > 85 ? 'danger' : pct > 65 ? 'warn' : ''}${model ? '' : ' hidden'}`;
    updateUsage();
  }
  /** Shortcut text for the host's platform: kb('Mod+Shift+Enter') is ⌘⇧↩ on macOS and Ctrl+Shift+Enter on Windows and Linux. */
  function kb(spec) { const mac = state.platform === 'darwin'; return spec.split('+').map((k) => (mac ? { Mod: '⌘', Alt: '⌥', Shift: '⇧', Enter: '↩' } : { Mod: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+', Enter: 'Enter' })[k] || k).join(''); }
  /** Titles that name a shortcut follow the platform the host reports in `init`. */
  function syncShortcutTitles() {
    els.newTab.title = `New chat — runs in parallel (${kb('Mod+Shift+Enter')} sends the draft in a new tab)`;
    if (els.improve && !els.improve.classList.contains('busy')) { els.improve.title = improveTitle(); }
    if (state.session) { syncPause(); } else { els.pause.title = `Pause after the current step (${kb('Alt+Esc')})`; }
  }
  /** Compact decimal token count, as providers quote windows: 950, 12.3k, 32.8k, 400k, 1M. */
  function fmtTok(n) { const v = Number(n) > 0 ? Number(n) : 0; return v >= 1e6 ? `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M` : v >= 1e5 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(v)); }
  function fmtUsd(v) { return v > 0 && v < 0.0001 ? '<$0.0001' : `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`; }
  function fmtBytes(b) { const v = Number(b) || 0; return v >= 1048576 ? `${(v / 1048576).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`; }
  /** Tokens and cost of the open chat: its list row is refreshed while it runs, the loaded session only when it opens. */
  function chatUsage() { const s = state.session; if (!s) { return null; } const row = state.sessions.find((x) => x.id === s.id); return (row && row.usage) || s.usage || null; }
  /** Input counts cached tokens too (what the model read); the cost only exists for priced cloud models. */
  function usageParts(u) { if (!u || !u.requests) { return null; } const input = (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0); return { input, output: u.completionTokens || 0, cost: typeof u.costUsd === 'number' ? u.costUsd : undefined }; }
  function usageModelIsLocal(u) { const m = u && u.provider && u.model ? state.models.find((x) => x.id === `${u.provider}/${u.model}`) : currentModel(); return !!m && !m.remote; }
  function usageText(u) {
    const p = usageParts(u); if (!p) { return ''; }
    const cache = u.cacheReadTokens || u.cacheWriteTokens ? ` (cache read ${fmtTok(u.cacheReadTokens)} · write ${fmtTok(u.cacheWriteTokens)})` : '';
    const sub = u.subagentTokens && u.subagentTokens.requests ? `\nSubagents: ↑${fmtTok(u.subagentTokens.promptTokens)} ↓${fmtTok(u.subagentTokens.completionTokens)} in ${u.subagentTokens.requests} request${u.subagentTokens.requests === 1 ? '' : 's'}` : '';
    const cost = p.cost !== undefined ? ` · ${fmtUsd(p.cost)}` : usageModelIsLocal(u) ? ' · local · free' : '';
    return `This chat: ↑${fmtTok(p.input)} in${cache} ↓${fmtTok(p.output)} out · ${u.requests} request${u.requests === 1 ? '' : 's'}${cost}${sub}`;
  }
  function updateUsage() {
    const u = chatUsage(); const p = usageParts(u);
    els.usage.classList.toggle('hidden', !p); if (!p) { return; }
    els.usage.querySelector('.tok').textContent = `↑${fmtTok(p.input)} ↓${fmtTok(p.output)}`;
    const cost = els.usage.querySelector('.cost'); cost.textContent = p.cost !== undefined ? fmtUsd(p.cost) : ''; cost.classList.toggle('hidden', p.cost === undefined);
    els.usage.title = usageText(u);
  }
  // The window a model is actually given: the Context window setting capped by the model (0 = the model's maximum).
  function effectiveWindow(m) { const native = m.contextWindow > 0 ? m.contextWindow : 32768; const want = state.contextWindow > 0 ? state.contextWindow : native; return Math.max(4096, Math.min(native, want)); }
  function ctxCapped(m) { return m.contextWindow > effectiveWindow(m); }
  function ctxLabel(m) { const w = effectiveWindow(m); return ctxCapped(m) ? `${fmtTok(w)} used of ${fmtTok(m.contextWindow)}` : `${fmtTok(w)} ctx`; }
  function syncMode() {
    syncPlaceholder(); const v = modeView(state.session);
    if (els.modeBtn.dataset.view !== v.label) { els.modeBtn.dataset.view = v.label; els.modeLabel.textContent = v.label; els.modeIcon.innerHTML = v.icon; }
    // A specialist names the mode it runs in, since that decides whether files change ("Review · runs in Ask (read-only)").
    els.modeBtn.title = `${v.baseLabel ? `${v.label} · runs in ${v.baseLabel} (${v.tag})` : `Mode: ${v.label} (${v.tag})`} · ${kb('Mod+.')} to switch`;
    els.modeBtn.setAttribute('aria-label', `Mode: ${v.label}${v.baseLabel ? `, runs in ${v.baseLabel}` : ''}. Change mode`);
    syncModeLine();
  }
  /** The welcome screen's "Agent mode: edits files… · change" line follows the picker. */
  function syncModeLine() {
    const line = els.messages.querySelector(':scope > .empty .modeline .txt'); if (!line) { return; }
    const v = modeView(state.session);
    const what = v.baseLabel ? v.hint : v.desc;
    line.textContent = `${v.label} mode${v.baseLabel ? ` (runs in ${v.baseLabel})` : ''}: ${what.charAt(0).toLowerCase()}${what.slice(1)}`;
  }
  /** Keyboard mode switch (Shift+Tab with a draft, Ctrl/Cmd+.). The toast sits in the polite #toasts live region, so it is
   *  also what a screen reader hears: "Mode: Plan — investigate and prepare a plan…". */
  // Cycles the core modes only; from a specialist the next one is the mode after its base.
  function rotateMode() { const keys = Object.keys(MODES); const next = keys[(keys.indexOf(state.session.mode) + 1) % keys.length]; const m = MODES[next]; setMode(next); toast(`Mode: ${m.label} — ${m.desc.charAt(0).toLowerCase()}${m.desc.slice(1)}`); }
  /** Switches the chat's mode; `specialist` picks a "More modes" entry that runs in `mode`, and anything else clears it. */
  function setMode(mode, specialist) {
    const s = state.session; if (!s || !MODES[mode]) { return; }
    const sp = specialist && SPECIALISTS[specialist] && SPECIALISTS[specialist].base === mode ? specialist : undefined;
    if (s.mode === mode && (specOf(s) || undefined) === sp) { return; }
    s.mode = mode; s.specialist = sp; syncMode();
    post({ type: 'setMode', sessionId: s.id, mode, ...(sp ? { specialist: sp } : {}) });
  }
  /** The mode picker: the five core modes, the specialists under "More modes", then Manage modes. */
  function openModeMenu() {
    const s = state.session; const cur = s ? s.mode : 'agent'; const sp = specOf(s);
    const items = Object.entries(MODES).map(([k, m]) => ({ group: 'Modes', label: m.label, desc: m.hint, title: m.desc, icon: m.icon, tags: [{ text: m.tag, cls: m.tag === 'read-only' ? 'ro' : 'rw' }], selected: cur === k && !sp, onPick: () => setMode(k) }))
      .concat(Object.entries(SPECIALISTS).map(([k, x]) => { const b = MODES[x.base]; return { group: 'More modes', label: x.label, desc: x.hint, title: `${x.desc}. Runs in ${b.label} mode.`, icon: x.icon, tags: [{ text: b.tag, cls: b.tag === 'read-only' ? 'ro' : 'rw', title: `Runs in ${b.label} mode` }], selected: sp === k, onPick: () => setMode(x.base, k) }; }))
      .concat([{ hr: true }, { label: 'Manage modes…', desc: 'Skills and subagents in Settings', icon: I.gear, onPick: () => post({ type: 'openSettings', section: 'skills' }) }]);
    openMenu(els.modeBtn, items, { label: 'Mode', cls: 'modes', foot: `<span><kbd>${esc(kb('Mod+.'))}</kbd> to switch</span>` });
  }
  /** What the router resolves Auto to right now (sent by the host); falls back to the default model until it arrives. */
  function autoModelId() { return state.autoModel || state.defaultModel || ''; }
  function currentModel() { const s = state.session; const want = (s && s.model) || autoModelId(); return state.models.find((m) => m.id === want) || null; }
  function syncModel() {
    syncVision(); syncThink();
    els.modelBtn.classList.toggle('warn', !state.models.length && !state.modelsLoading);
    els.modelBtn.classList.toggle('finding', !state.models.length && !!state.modelsLoading);
    // No models yet: say what is happening (still looking) or what to do (set one up) — the picker offers the actions.
    if (!state.models.length) { els.modelLabel.innerHTML = state.modelsLoading ? '<span class="spinner"></span>Finding models…' : 'Set up a model'; els.modelBtn.title = state.modelsLoading ? 'Looking for local model servers…' : 'No models found — click to set one up, look again, or add a cloud provider'; els.modelBtn.removeAttribute('aria-label'); return; }
    const s = state.session; const explicit = s && s.model; const m = currentModel();
    const name = m ? m.name.replace(/-instruct|-chat/i, '') : explicit ? explicit.split('/').pop() : 'Auto';
    // Narrow composers show the short form: no provider prefix, no ':latest' / ':14b' tag (the full id is in the title).
    const shortName = name.split('/').pop().replace(/:[^:/]+$/, '') || name;
    const label = `<span class="nm">${shortName === name ? esc(name) : `<span class="nm-full">${esc(name)}</span><span class="nm-short">${esc(shortName)}</span>`}</span>`;
    // "<provider> · <model|Auto · resolved>" with a dot for where it runs; the provider gives way first as the composer narrows.
    const prov = m ? providerLabel(m.providerId) : '';
    const auto = m && !explicit;
    const html = `${m ? `<i class="where ${m.remote ? 'cloud' : 'local'}" aria-hidden="true"></i>` : ''}${prov ? `<span class="prov">${esc(prov)} · </span>` : ''}${auto ? '<span class="auto">Auto · </span>' : ''}${label}`;
    if (els.modelLabel.innerHTML !== html) { els.modelLabel.innerHTML = html; }
    const facts = m ? `${m.id} · ${ctxLabel(m)}${ctxCapped(m) ? ' (Settings → Models → Context window)' : ''}${m.supportsTools ? ' · tools' : ' · prompt-based tools'}${m.supportsVision ? ' · vision' : ''}${m.remote ? ' · cloud: prompts leave this machine' : ' · local: runs on this machine'}` : '';
    els.modelBtn.title = m ? (auto ? `Auto picks a model per task; now: ${facts}` : facts) : explicit || 'Model';
    // A fallback answered the last turn: a warning dot on the chip until the chat picks a model or a turn routes normally.
    const rr = s && state.rerouted.get(s.id);
    els.modelBtn.classList.toggle('rerouted', !!rr);
    if (rr) { els.modelBtn.title = `${modelName(rr.wanted) || rr.wanted} is not answering; the last turn used ${rr.usedName || modelName(rr.used)}.\n${els.modelBtn.title}`; }
    els.modelBtn.setAttribute('aria-label', `Model: ${auto ? `Auto, now ${name}` : name}${prov ? ` (${prov}${m.remote ? ', cloud' : ', local'})` : ''}. Change model`);    fitModelChip();
  }
  /** Drops the provider, then "Auto ·", while the chip's label does not fit, so the model's name is what gets the room. */
  let fitPending = false;
  function fitModelChip() {
    if (fitPending) { return; } fitPending = true;
    requestAnimationFrame(() => {
      fitPending = false; const l = els.modelLabel; if (!l.querySelector('.nm')) { return; }
      l.classList.remove('no-prov', 'no-auto');
      const over = () => l.scrollWidth > l.clientWidth;
      if (over()) { l.classList.add('no-prov'); if (over()) { l.classList.add('no-auto'); } }
    });
  }
  /** A provider's display name without the parenthesised extra ("Anthropic (Claude)" → "Anthropic"). */
  function providerLabel(pid) { const n = (state.providerNames && state.providerNames[pid]) || pid || ''; return n.replace(/\s*\(.*\)$/, ''); }
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
    const forced = (s) => s.id === active || state.running.has(s.id) || state.attention.has(s.id) || state.unread.has(s.id);
    for (const s of all) { if (forced(s)) { open.add(s.id); } }
    let list = all.filter((s) => open.has(s.id));
    if (list.length > MAX_TABS) {
      // Too many open: keep pinned, active, running and flagged chats (these may exceed the cap; the strip scrolls) and drop the oldest idle ones from the bar (still in "All chats").
      const keep = new Set(list.filter((s) => s.pinned || forced(s)).map((s) => s.id));
      for (const s of list.slice().sort((a, b) => b.updatedAt - a.updatedAt)) { if (keep.size >= MAX_TABS) { break; } keep.add(s.id); }
      for (const id of [...open]) { if (!keep.has(id)) { open.delete(id); } }
      state.openTabs = open;
      list = list.filter((s) => keep.has(s.id));
    }
    list.sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((a.createdAt || 0) - (b.createdAt || 0)) || a.id.localeCompare(b.id));
    return { list, active, hidden: all.length - list.length, all };
  }
  function tabTitle(s) {
    const running = state.running.has(s.id); const st = state.status.get(s.id);
    const lines = [s.title || 'New chat', `${MODES[s.mode] ? modeView(s).label : s.mode} · ${s.messageCount} message${s.messageCount === 1 ? '' : 's'} · ${tabModel(s)}`];
    if (running) { lines.push(state.paused.get(s.id) && state.paused.get(s.id).paused ? `Paused${st ? ` — ${st}` : ''}` : `Running${st ? ` — ${st}` : '…'}`); }
    if (state.selected.size > 1 && state.selected.has(s.id)) { lines.push(`${state.selected.size} tabs selected — ✕ or Delete closes them all`); }
    if (state.attention.has(s.id)) { lines.push('Waiting for your approval'); }
    if (state.unread.has(s.id)) { lines.push('Finished — new results'); }
    if (s.id === activeId()) { lines.push('Double-click to rename · right-click for actions'); }
    return lines.join('\n');
  }
  /** Model this chat talks to: the one it last requested, else its configured model, else the default. */
  function tabModel(s) { return modelName(state.modelOf.get(s.id) || s.model || autoModelId()) || 'auto'; }
  function tabIndicator(s) {
    if (state.running.has(s.id) && state.paused.get(s.id) && state.paused.get(s.id).paused) { return `<span class="pausedind" aria-label="Paused">${I.pause}</span>`; }
    if (state.running.has(s.id)) { return LIVE_DOT; }
    if (state.attention.has(s.id)) { return I.warn; }
    if (state.unread.has(s.id)) { return '<span class="dot" aria-label="Finished"></span>'; }
    if (s.pinned) { return I.pin; }
    return modeView(s).icon;
  }
  let tabSig = '';
  function renderTabs() {
    const { list, active, hidden } = tabList();
    // The store broadcasts on every save while agents stream; only rebuild the DOM when something visible changed.
    if (els.tabs.querySelector('.rename')) { renderTabs.pending = true; return; }
    const sig = list.map((s) => [s.id, s.title, s.pinned ? 1 : 0, s.id === active ? 1 : 0, state.running.has(s.id) ? 1 : 0, state.paused.get(s.id) && state.paused.get(s.id).paused ? 1 : 0, state.loadingTab === s.id ? 1 : 0, state.unread.has(s.id) ? 1 : 0, state.attention.has(s.id) ? 1 : 0, state.selected.has(s.id) ? 1 : 0].join(':')).join('|') + `#${hidden}#${state.running.size}#${stopArm.id || ''}`;
    if (sig === tabSig) { for (const tab of els.tabs.querySelectorAll('.tab[data-id]')) { const s = list.find((x) => x.id === tab.dataset.id); if (s) { tab.title = tabTitle(s); } } renderBgRuns(); return; }
    tabSig = sig;
    const refocus = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tabs .close') ? document.activeElement.dataset.id : null;
    els.tabs.innerHTML = '';
    for (const s of list) {
      const running = state.running.has(s.id); const isActive = s.id === active;
      const cls = ['tab', isActive && 'active', running && 'running', state.loadingTab === s.id && 'loading', state.unread.has(s.id) && 'unread', state.attention.has(s.id) && 'attention', s.pinned && 'pinned', state.selected.has(s.id) && 'selected'].filter(Boolean).join(' ');
      const b = el('button', cls, `<span class="ind">${tabIndicator(s)}</span><span class="t">${esc(s.title || 'New chat')}</span>`);
      // Close / stop is a sibling button laid over the tab (a button inside a button is not reachable by keyboard).
      const armed = running && stopArm.id === s.id; const title = s.title || 'New chat'; const name = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      const x = el('button', `close${armed ? ' confirm' : ''}`, armed ? 'Stop?' : running ? I.stop : I.x);
      x.dataset.id = s.id; x.tabIndex = isActive ? 0 : -1;
      x.title = armed ? 'Click again to stop this agent' : running ? 'Stop this agent' : s.pinned ? 'Pinned — unpin to close' : 'Close tab';
      x.setAttribute('aria-label', armed ? `Confirm: stop the agent in “${name}”` : running ? `Stop the agent in “${name}”` : `Close chat “${name}”`);
      x.onclick = (e) => {
        e.stopPropagation();
        if (state.selected.size > 1 && state.selected.has(s.id)) { closeSelected(); }
        else if (running) { if (armed) { disarmStop(); post({ type: 'stop', sessionId: s.id }); } else { armStop(s.id); } }
        else if (s.pinned) { toast('Unpin the chat to close its tab'); } else { closeTab(s.id); }
      };
      b.dataset.id = s.id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(isActive)); b.tabIndex = isActive ? 0 : -1;
      if (state.loadingTab === s.id) { b.setAttribute('aria-busy', 'true'); }
      b.title = tabTitle(s);
      b.onclick = (e) => {
        // ⌘/Ctrl-click toggles a tab in the selection, Shift-click selects a range; plain click switches and clears the selection.
        if (e.metaKey || e.ctrlKey) { toggleSelect(s.id); return; }
        if (e.shiftKey) { selectRange(s.id); return; }
        if (state.selected.size) { state.selected.clear(); tabSig = ''; }
        if (e.detail < 2) { selectTab(s.id); }
      };
      b.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); if (state.selected.size > 1 && state.selected.has(s.id)) { closeSelected(); } else if (!running && !s.pinned) { closeTab(s.id); } } };
      b.oncontextmenu = (e) => { e.preventDefault(); openTabMenu(b, s); };
      b.ondblclick = () => startRename(b, s);
      const w = el('span', 'tabw'); w.setAttribute('role', 'presentation'); w.append(b, x);
      els.tabs.appendChild(w);
    }
    if (refocus) { const x = els.tabs.querySelector(`.close[data-id="${CSS.escape(refocus)}"]`); if (x) { x.focus(); } }
    if (hidden > 0) {
      const more = el('button', 'tab more', `<span class="t">+${hidden}</span>`);
      more.title = `${hidden} more chat${hidden === 1 ? '' : 's'} — open All chats`; more.tabIndex = -1;
      more.onclick = openHistory;
      els.tabs.appendChild(more);
    }
    els.history.dataset.n = String(state.running.size);
    els.history.title = state.running.size ? `All chats · ${state.running.size} agent${state.running.size === 1 ? '' : 's'} running` : 'All chats';
    const act = els.tabs.querySelector('.tab.active'); if (act) { act.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    tabEdges();
    renderBgRuns();
    saveState();
  }
  // Stopping a running tab from its × takes two clicks: the first turns it into a "Stop?" pill for 2 s.
  const stopArm = { id: null, timer: 0 };
  function armStop(id) { clearTimeout(stopArm.timer); stopArm.id = id; stopArm.timer = setTimeout(disarmStop, 2000); tabSig = ''; renderTabs(); }
  function disarmStop() { clearTimeout(stopArm.timer); if (stopArm.id) { stopArm.id = null; tabSig = ''; renderTabs(); } }
  function tabEdges() {
    const t = els.tabs; const max = t.scrollWidth - t.clientWidth;
    t.classList.toggle('ovf-l', max > 1 && t.scrollLeft > 1);
    t.classList.toggle('ovf-r', max > 1 && t.scrollLeft < max - 1);
  }
  // Composer isolation: each tab keeps its own draft, attachments, images and scroll offset while you switch around.
  function saveDraft(sid) {
    if (!sid) { return; }
    const text = improving && improving.sid === sid ? improving.original : els.input.value;
    if (text || state.attachments.length || state.images.length) { state.drafts.set(sid, { text, attachments: [...state.attachments], images: [...state.images] }); } else { state.drafts.delete(sid); }
    state.scroll.set(sid, els.messages.scrollTop);
  }
  function restoreDraft(sid) {
    const d = state.drafts.get(sid);
    els.input.value = d ? d.text : ''; state.attachments = d ? [...d.attachments] : []; state.images = d ? [...d.images] : [];
    const locked = !!improving && improving.sid === sid; els.input.readOnly = locked; els.box.classList.toggle('improving', locked);
    renderChips(); autoGrow(); updateSendEnabled();
  }
  /** Optimistic switch: the clicked tab is selected and marked busy right away; the extension answers with the session. */
  function selectTab(id) {
    if (!id || id === activeId()) { return; }
    closeMenu();
    saveDraft(state.session && state.session.id);
    state.loadingTab = id; state.unread.delete(id);
    if (state.openTabs) { state.openTabs.add(id); }
    post({ type: 'selectSession', id });
    renderTabs();
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
  els.tabs.addEventListener('scroll', tabEdges, { passive: true });
  new ResizeObserver(tabEdges).observe(els.tabs);
  // Vertical wheel scrolls the tab strip sideways (mouse users have no horizontal wheel).
  els.tabs.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && els.tabs.scrollWidth > els.tabs.clientWidth) { els.tabs.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  els.tabs.addEventListener('keydown', (e) => {
    const tabs = [...els.tabs.querySelectorAll('.tab')]; const i = tabs.indexOf(document.activeElement);
    if (i < 0 || e.target.classList.contains('rename')) { return; }
    // The "+N" tab takes part in arrow navigation; Enter on it opens All chats (its own click).
    const go = (j) => { e.preventDefault(); const t = tabs[(j + tabs.length) % tabs.length]; t.focus(); if (t.dataset.id) { selectTab(t.dataset.id); } };
    if (!tabs[i].dataset.id) { if (e.key === 'ArrowRight') { go(i + 1); } else if (e.key === 'ArrowLeft') { go(i - 1); } else if (e.key === 'Home') { go(0); } else if (e.key === 'End') { go(tabs.length - 1); } return; }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); const s = tabList().list.find((x) => x.id === tabs[i].dataset.id); if (s) { openTabMenu(tabs[i], s); } return; }
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
      const row = el('div', `bgrun ${paused ? 'paused' : ''}`, `<button class="open">${paused ? `<span class="pausedind">${I.pause}</span>` : LIVE_DOT}<span class="t">${esc(s.title || 'New chat')}</span><span class="st">${esc(state.status.get(s.id) || 'Working…')}</span><span class="mdl" title="Model">${esc(tabModel(s))}</span></button><button class="stop pausebtn" title="${paused ? 'Resume this agent' : 'Pause this agent after its current step'}" aria-label="${paused ? 'Resume' : 'Pause'} “${esc(s.title || 'New chat')}”">${paused ? I.play : I.pause}</button><button class="stop" title="Stop this agent" aria-label="Stop “${esc(s.title || 'New chat')}”">${I.stop}</button>`);
      row.querySelector('.open').title = `${s.title}\n${state.status.get(s.id) || 'Working…'}\nModel: ${tabModel(s)}\nClick to open`;
      row.onclick = (e) => { if (e.target.closest('.pausebtn')) { post({ type: paused ? 'resume' : 'pause', sessionId: s.id }); return; } if (e.target.closest('.stop')) { post({ type: 'stop', sessionId: s.id }); return; } selectTab(s.id); };
      els.bgruns.appendChild(row);
    }
    if (runs.length > 3) { const more = el('button', 'bgrun more', `<span class="st">+${runs.length - 3} more running</span>`); more.onclick = openHistory; els.bgruns.appendChild(more); }
  }
  function scheduleBg() { if (bgTimer) { return; } bgTimer = setTimeout(() => { bgTimer = 0; renderBgRuns(); const t = els.tabs.querySelector('.tab.running'); if (t) { for (const tab of els.tabs.querySelectorAll('.tab.running')) { const s = tabList().all.find((x) => x.id === tab.dataset.id); if (s) { tab.title = tabTitle(s); } } } }, 120); }
  function noteStatus(sid, text) { if (text) { state.status.set(sid, text); } else { state.status.delete(sid); } scheduleBg(); }
  // ------------------------------------------------------------------ chat history ("All chats")
  // Every chat in this workspace, grouped by when it was last used, searchable by title and by what was said (the
  // extension scans the message text), with pin / rename / delete on each row — so chats that are not in the tab bar
  // are managed here without opening them first. Untouched empty chats are hidden; they are noise, not history.
  // The extension sorts, filters and pages the list (`listSessions`); until its page arrives the rows come from the
  // summaries already here. A long history (over 200 chats) loads 50 more each time the list is scrolled to the end.
  const hist = { open: false, q: '', pending: false, sel: 0, confirm: null, renaming: null, timer: 0, sig: '', sort: 'newest', userSort: 'newest', pinnedOnly: false, page: null, seq: 0, offset: 0, refreshTimer: 0, selecting: false, picked: new Set() };
  const HIST_GROUPS = ['Running', 'Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'];
  const HIST_SORTS = [['newest', 'Newest'], ['oldest', 'Oldest'], ['tokens', 'Most tokens'], ['cost', 'Most expensive'], ['size', 'Largest'], ['relevance', 'Relevance']];
  const HIST_ALL_UP_TO = 200; const HIST_PAGE = 50;
  const histKey = () => `${hist.sort}|${hist.pinnedOnly ? 1 : 0}|${hist.q.trim()}`;
  /** Asks for the list again: `more` appends the next page; otherwise the rows loaded so far are refreshed. */
  function histRequest(more) {
    const page = hist.page && hist.page.key === histKey() ? hist.page : null;
    if (more && (!page || page.rows.length >= page.total)) { return; }
    const limit = more ? HIST_PAGE : page && page.total > HIST_ALL_UP_TO ? Math.max(HIST_PAGE, page.rows.length) : undefined;
    hist.seq++; hist.pending = true; hist.more = !!more; hist.offset = more ? page.rows.length : 0;
    const active = activeId();
    post({ type: 'listSessions', seq: hist.seq, offset: hist.offset, limit, sort: hist.sort, query: hist.q.trim(), pinnedOnly: hist.pinnedOnly, keep: [...(active ? [active] : []), ...state.running], first: [...state.running] });
  }
  /** The store changed (a chat saved, renamed, deleted): show it now, then re-read the page, coalesced while agents stream. */
  function histRefresh() { renderHistory(); clearTimeout(hist.refreshTimer); hist.refreshTimer = setTimeout(() => { if (hist.open) { histRequest(false); } }, 250); }
  function histPage(m) {
    if (!hist.open || m.seq !== hist.seq || m.page.offset !== Math.min(hist.offset, m.page.total)) { return; }
    const key = `${m.page.sort}|${m.page.pinnedOnly ? 1 : 0}|${m.page.query}`;
    const rows = hist.more && hist.page && hist.page.key === key ? hist.page.rows.concat(m.page.rows.filter((r) => !hist.page.rows.some((x) => x.id === r.id))) : m.page.rows;
    hist.page = { ...m.page, key, rows }; hist.pending = false; hist.more = false;
    renderHistory();
  }
  function setHistSort(sort) { hist.sort = sort; if (!hist.q.trim()) { hist.userSort = sort; } hist.sel = 0; hist.sig = ''; renderHistory(); histRequest(false); }
  function chatTokens(s) { const u = s.usage; return u ? (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) + (u.completionTokens || 0) : 0; }
  function chatBytes(id) { const s = state.sessions.find((x) => x.id === id); return (s && s.bytes) || 0; }
  function historyGroup(s, startOfToday) {
    const day = 86400e3;
    if (state.running.has(s.id)) { return 'Running'; }
    if (s.pinned) { return 'Pinned'; }
    if (s.updatedAt >= startOfToday) { return 'Today'; }
    if (s.updatedAt >= startOfToday - day) { return 'Yesterday'; }
    if (s.updatedAt >= startOfToday - 7 * day) { return 'Previous 7 days'; }
    if (s.updatedAt >= startOfToday - 30 * day) { return 'Previous 30 days'; }
    return 'Older';
  }
  function historyRows() {
    const active = activeId(); const q = hist.q.trim().toLowerCase();
    const now = new Date(); const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const page = hist.page && hist.page.key === histKey() ? hist.page : null;
    // The page fixes order and membership; the live summaries here supply titles, pins and usage as they change.
    let list = page
      ? page.rows.filter((r) => byId.has(r.id)).map((r) => ({ s: byId.get(r.id), hit: r.snippet ? { snippet: r.snippet, role: r.role } : undefined }))
      : state.sessions
        .filter((s) => s.messageCount > 0 || s.pinned || s.plan || s.id === active || state.running.has(s.id))
        .filter((s) => (!hist.pinnedOnly || s.pinned) && (!q || (s.title || 'New chat').toLowerCase().includes(q)))
        .map((s) => ({ s }));
    if (!page) {
      const local = { oldest: (a, b) => a.s.updatedAt - b.s.updatedAt, tokens: (a, b) => chatTokens(b.s) - chatTokens(a.s), cost: (a, b) => ((b.s.usage && b.s.usage.costUsd) || 0) - ((a.s.usage && a.s.usage.costUsd) || 0), size: (a, b) => (b.s.bytes || 0) - (a.s.bytes || 0) }[hist.sort];
      if (local) { list.sort(local); }
      if (list.length > HIST_ALL_UP_TO) { list = list.slice(0, HIST_PAGE); }
    }
    // Date groups only make sense in time order; the other sorts are one ranked list.
    const grouped = hist.sort === 'newest' || (hist.sort === 'relevance' && !q);
    const rows = list.map((r) => ({ ...r, g: grouped ? historyGroup(r.s, startOfToday) : '' }));
    if (grouped) { rows.sort((a, b) => (HIST_GROUPS.indexOf(a.g) - HIST_GROUPS.indexOf(b.g)) || (b.s.updatedAt - a.s.updatedAt)); }
    return rows;
  }
  /** Escapes and wraps the matched query in <mark>. */
  function highlightMatch(text, q) {
    if (!q) { return esc(text); }
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }
  function openHistory() {
    const p = els.popover; p.innerHTML = ''; p.classList.remove('hidden');
    menuState = { items: [], sel: 0 };
    // Sort and the pinned filter carry over between openings; the query and a selection do not.
    Object.assign(hist, { open: true, hold: false, stale: false, q: '', pending: false, sel: 0, confirm: null, renaming: null, sig: '', sort: hist.userSort, page: null, selecting: false, picked: new Set() });
    const box = el('div', 'hist');
    const search = el('input', 'search'); search.placeholder = 'Search chats and messages…'; search.setAttribute('aria-label', 'Search chats');
    const bar = el('div', 'hist-bar');
    const list = el('div', 'hist-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Chats');
    const foot = el('div', 'hist-foot');
    box.append(search, bar, list, foot); p.appendChild(box);
    search.oninput = () => {
      const was = hist.q.trim(); hist.q = search.value; hist.sel = 0; hist.confirm = null;
      const q = hist.q.trim();
      // Typing ranks by relevance; clearing the query goes back to the sort chosen before.
      if (q && !was && hist.sort !== 'relevance') { hist.userSort = hist.sort; hist.sort = 'relevance'; } else if (!q && was) { hist.sort = hist.userSort; }
      clearTimeout(hist.timer);
      hist.pending = true; hist.timer = setTimeout(() => histRequest(false), q ? 150 : 0);
      renderHistory();
    };
    list.onscroll = () => { if (!hist.pending && list.scrollTop + list.clientHeight >= list.scrollHeight - 60) { histRequest(true); } };
    histRequest(false);
    search.onkeydown = historyKeys;
    // A focused button or the sort select handles its own keys: Enter there presses the button, it does not open the selected chat.
    p.onkeydown = (e) => { if (e.target === search) { return; } if (e.target.classList.contains('rename') || e.target.tagName === 'SELECT' || (e.target.closest('button') && (e.key === 'Enter' || e.key === ' '))) { return; } historyKeys(e); };
    renderHistory();
    placePopover(els.history);
    search.focus();
  }
  /** Between a press and its click, renderHistory waits (the pressed button must still exist when the click lands); one
   *  render catches up after the mouseup. */
  function holdHistory() {
    hist.hold = true;
    window.addEventListener('mouseup', () => { hist.hold = false; setTimeout(() => { if (hist.stale) { hist.stale = false; hist.sig = ''; renderHistory(); } }, 0); }, { once: true, capture: true });
  }
  /** Open a chat from the panel; picking the one already open just closes the panel. */
  function historyOpen(id) { if (id === activeId()) { closeMenu(); els.input.focus(); } else { selectTab(id); } }
  function renderHistory() {
    const p = els.popover; const list = p.querySelector('.hist-list'); const foot = p.querySelector('.hist-foot'); const bar = p.querySelector('.hist-bar');
    if (!hist.open || !list || hist.renaming) { return; }
    if (hist.hold) { hist.stale = true; return; }
    const rows = historyRows(); const active = activeId(); const q = hist.q.trim();
    for (const id of [...hist.picked]) { if (!state.sessions.some((s) => s.id === id)) { hist.picked.delete(id); } }
    hist.sel = Math.max(0, Math.min(hist.sel, rows.length - 1));
    const page = hist.page && hist.page.key === histKey() ? hist.page : null;
    const sig = [q, hist.pending ? 1 : 0, hist.sel, hist.confirm || '', active || '', state.running.size, hist.sort, hist.pinnedOnly ? 1 : 0, hist.selecting ? [...hist.picked].join(',') : '-', page ? page.total : '', ...rows.map(({ s, g, hit }) => `${s.id}:${g}:${s.title}:${s.pinned ? 1 : 0}:${s.messageCount}:${state.unread.has(s.id) ? 1 : 0}:${state.status.get(s.id) || ''}:${hit ? hit.snippet : ''}:${s.bytes || 0}:${chatTokens(s)}`)].join('|');
    if (sig === hist.sig) { return; }
    hist.sig = sig;
    // Re-rendering replaces the buttons: a keyboard user's focus goes back to the same action (or the search box).
    const fa = document.activeElement; const fb = fa && fa.dataset && fa.dataset.a && p.contains(fa) ? fa : null;
    const refocus = fb ? { a: fb.dataset.a, row: (fb.closest('.hist-row') || { dataset: {} }).dataset.id, zone: fb.closest('.hist-foot') ? '.hist-foot' : fb.closest('.hist-bar') ? '.hist-bar' : '' } : null;
    renderHistoryBar(bar, rows, page);
    const y = list.scrollTop;
    list.innerHTML = '';
    let lastGroup = null;
    rows.forEach(({ s, g, hit }, i) => {
      if (g && g !== lastGroup) { list.appendChild(el('div', 'grp', esc(g))); lastGroup = g; }
      const running = state.running.has(s.id); const isActive = s.id === active; const sel = i === hist.sel; const picked = hist.picked.has(s.id);
      const row = el('div', `hist-row${isActive ? ' current' : ''}${sel ? ' sel' : ''}${hist.confirm === s.id ? ' confirm' : ''}${hist.selecting ? ' picking' : ''}${picked ? ' picked' : ''}`);
      row.dataset.id = s.id; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(hist.selecting ? picked : sel));
      const mode = modeView(s);
      const parent = s.parentId ? (state.sessions.find((x) => x.id === s.parentId) || {}).title || s.parentTitle || 'a deleted chat' : '';
      const desc = running ? esc(state.status.get(s.id) || 'Working…') : hit && hit.snippet ? `${hit.role === 'user' ? '<b>You:</b> ' : ''}${highlightMatch(hit.snippet, q)}` : esc(`${mode.label} · ${s.messageCount} message${s.messageCount === 1 ? '' : 's'} · ${timeAgo(s.updatedAt)}${parent ? ` · forked from ${short(parent, 28)}` : ''}`);
      const tag = (s.origin === 'cli' ? '<span class="tag" title="Started in the localpilot terminal CLI">CLI</span>' : s.origin === 'claude-code' ? '<span class="tag" title="Imported from Claude Code">Claude Code</span>' : s.origin === 'codex' ? '<span class="tag" title="Imported from Codex">Codex</span>' : '') + (state.unread.has(s.id) ? '<span class="tag">new</span>' : isActive ? '<span class="tag">open</span>' : '');
      const acts = hist.confirm === s.id
        ? `<span class="q">${running ? 'Stop and delete?' : 'Delete?'}</span><button data-a="confirm" class="danger">Delete</button><button data-a="cancel">Keep</button>`
        : `<button data-a="pin" title="${s.pinned ? 'Unpin' : 'Pin — stays first in the tab bar and is never removed by retention'}" aria-pressed="${!!s.pinned}">${I.pin}</button><button data-a="rename" title="Rename (F2)">${I.rename}</button><button data-a="more" title="More…">${I.list}</button><button data-a="delete" title="${running ? 'Stop the agent and delete this chat' : 'Delete this chat'}">${I.trash}</button>`;
      const meta = historyMeta(s);
      const ico = hist.selecting ? `<input type="checkbox" class="pick-box" tabindex="-1" aria-label="Select" ${picked ? 'checked' : ''}>` : running ? LIVE_DOT : s.pinned ? I.pin : mode.icon;
      row.innerHTML = `<span class="ico">${ico}</span><span class="txt"><span class="lbl">${highlightMatch(s.title || 'New chat', q)}</span><span class="desc${hit && hit.snippet ? ' snippet' : ''}">${desc}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</span>${tag}${hist.selecting ? '' : `<span class="acts">${acts}</span>`}`;
      row.title = `${s.title || 'New chat'}\n${mode.label} · ${s.messageCount} message${s.messageCount === 1 ? '' : 's'} · ${new Date(s.updatedAt).toLocaleString()}${meta ? `\n${meta}` : ''}${s.pinned ? '\nPinned' : ''}${s.origin === 'cli' ? '\nStarted in the terminal CLI' : s.origin === 'claude-code' ? '\nImported from Claude Code' : s.origin === 'codex' ? '\nImported from Codex' : ''}${parent ? `\nForked from ${parent}` : ''}`;
      // Actions run on click, so the row buttons also work from the keyboard; mousedown only keeps focus in the search box
      // and holds re-renders until the click lands (a running chat's status would otherwise replace the row mid-click).
      row.onmousedown = (e) => { if (e.button !== 0 || e.target.closest('.rename')) { return; } e.preventDefault(); holdHistory(); };
      row.onclick = (e) => { if (e.target.closest('.rename')) { return; } if (hist.selecting) { hist.sel = i; togglePicked(s.id); return; } const b = e.target.closest('[data-a]'); if (b) { historyAction(b.dataset.a, s, row); } else { historyOpen(s.id); } };
      row.onmouseenter = () => { if (hist.sel !== i) { hist.sel = i; for (const r of list.querySelectorAll('.hist-row.sel')) { r.classList.remove('sel'); r.setAttribute('aria-selected', 'false'); } row.classList.add('sel'); row.setAttribute('aria-selected', 'true'); } };
      row.oncontextmenu = (e) => { e.preventDefault(); hist.sel = i; historyAction('more', s, row); };
      list.appendChild(row);
    });
    if (!rows.length) { list.appendChild(q && hist.pending ? el('div', 'empty-i searching', '<span class="spinner"></span>Searching messages…') : el('div', 'empty-i', q ? `No chats match “${esc(q)}”` : hist.pinnedOnly ? 'No pinned chats' : 'No chats yet — start one below')); }
    if (page && page.rows.length < page.total) { list.appendChild(el('div', 'empty-i more', hist.pending ? '<span class="spinner"></span>Loading more…' : `${page.total - page.rows.length} more — scroll to load`)); }
    // Title matches can show while message hits are still on their way: a thin shimmer says more may arrive.
    list.classList.toggle('pending', !!(q && hist.pending && rows.length));
    // Only a keyboard move scrolls to the selection; a re-render (a page loaded, a chat saved) keeps the scroll position.
    list.scrollTop = y;
    const selRow = list.querySelector('.hist-row.sel'); if (selRow && hist.reveal) { selRow.scrollIntoView({ block: 'nearest' }); } hist.reveal = false;
    const idle = state.sessions.filter((s) => !state.running.has(s.id) && (s.messageCount > 0 || s.pinned || s.plan));
    // Wide enough (≥320 px), the tidy-up buttons carry a short label; narrower they are icons with the same aria-label.
    foot.innerHTML = `<div class="hist-acts"><button data-a="new" title="Start another chat — the current one keeps running">${I.sparkle}<span>New chat</span></button><button data-a="multi" title="Several agents at once">${I.layers}<span>Multitask</span></button>${state.running.size > 1 ? `<button data-a="stopall" title="Stop every running agent; tabs stay open">${I.stop}<span>Stop all ${state.running.size}</span></button>` : ''}</div><div class="hist-acts tidy"><button data-a="closeothers" title="Close idle tabs — the chats stay here" aria-label="Close idle tabs">${I.closeOthers}<span class="lbl">Close idle tabs</span></button><button data-a="clear" class="danger" title="Clear chat history… (${idle.length} idle chat${idle.length === 1 ? '' : 's'} in this workspace, ${fmtBytes(idle.reduce((n, s) => n + (s.bytes || 0), 0))})" aria-label="Clear chat history" ${idle.length ? '' : 'disabled'}>${I.trash}<span class="lbl">Clear…</span></button><button data-a="settings" title="Memory & history settings" aria-label="Memory and history settings">${I.memory}</button></div>`;
    foot.onmousedown = (e) => { const b = e.target.closest('[data-a]'); if (b && !b.disabled) { e.preventDefault(); holdHistory(); } };
    foot.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b || b.disabled) { return; }
      const a = b.dataset.a;
      if (a === 'new') { closeMenu(); post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent' }); }
      else if (a === 'multi') { openParallelComposer(); }
      else if (a === 'stopall') { for (const id of state.running) { post({ type: 'stop', sessionId: id }); } }
      else if (a === 'closeothers') { closeOtherTabs(); hist.sig = ''; renderHistory(); }
      else if (a === 'clear') { confirmClearHistory(); }
      else if (a === 'settings') { closeMenu(); post({ type: 'openSettings', section: 'memory' }); }
    };
    if (refocus) { restoreHistoryFocus(refocus); }
  }
  function restoreHistoryFocus(f) {
    const p = els.popover; if (!hist.open || hist.renaming || (document.activeElement && document.activeElement !== document.body && p.contains(document.activeElement))) { return; }
    const scope = f.row ? p.querySelector(`.hist-row[data-id="${CSS.escape(f.row)}"]`) : f.zone ? p.querySelector(f.zone) : null;
    const next = { delete: 'cancel', cancel: 'delete', confirm: 'delete' }[f.a];
    const t = scope && (scope.querySelector(`[data-a="${f.a}"]`) || (next && scope.querySelector(`[data-a="${next}"]`)));
    (t && !t.disabled ? t : p.querySelector('.hist > .search') || els.input).focus();
  }
  /** Model, tokens, cost (priced cloud models only) and size on disk of a history row. */
  function historyMeta(s) {
    const u = s.usage; const p = usageParts(u); const parts = [];
    const model = modelName(u && u.model ? (u.provider ? `${u.provider}/${u.model}` : u.model) : s.model);
    if (model) { parts.push(model); }
    if (p) { parts.push(`↑${fmtTok(p.input)} ↓${fmtTok(p.output)}`); if (p.cost !== undefined) { parts.push(fmtUsd(p.cost)); } }
    if (s.bytes) { parts.push(fmtBytes(s.bytes)); }
    return parts.join(' · ');
  }
  const PICKED = '\u0000picked';
  function setSelecting(on) { hist.selecting = on; hist.picked = new Set(); hist.confirm = null; hist.sig = ''; renderHistory(); }
  function togglePicked(id) { if (hist.picked.has(id)) { hist.picked.delete(id); } else { hist.picked.add(id); } if (hist.confirm === PICKED) { hist.confirm = null; } hist.sig = ''; renderHistory(); }
  function deletePicked() {
    const ids = [...hist.picked]; if (!ids.length) { return; }
    const gone = new Set(ids);
    // Optimistic, like a single delete: the rows and their tabs go now; the store's broadcast confirms it.
    state.sessions = state.sessions.filter((x) => !gone.has(x.id));
    for (const id of ids) { state.unread.delete(id); state.selected.delete(id); state.drafts.delete(id); state.scroll.delete(id); if (state.openTabs) { state.openTabs.delete(id); } }
    post({ type: 'deleteSessions', ids });
    hist.selecting = false; hist.picked = new Set(); hist.confirm = null;
    tabSig = ''; renderTabs(); hist.sig = ''; renderHistory();
    toast(`Deleted ${ids.length} chat${ids.length === 1 ? '' : 's'}`);
  }
  /** Sort, Pinned only and Select above the list; in selection mode, Select all / none and Delete N selected (size). */
  function renderHistoryBar(bar, rows, page) {
    if (!bar) { return; }
    if (hist.selecting) {
      const n = hist.picked.size; const bytes = [...hist.picked].reduce((t, id) => t + chatBytes(id), 0);
      const running = [...hist.picked].filter((id) => state.running.has(id)).length;
      const all = page ? page.ids : rows.map((r) => r.s.id);
      bar.innerHTML = hist.confirm === PICKED
        ? `<span class="q">Delete ${n} chat${n === 1 ? '' : 's'}${running ? ` (stops ${running} running)` : ''}? Cannot be undone.</span><span class="spacer"></span><button data-a="dodelete" class="danger">Delete</button><button data-a="nodelete">Keep</button>`
        : `<button data-a="all" title="Select every chat in this list (${all.length})">Select all</button><button data-a="none" ${n ? '' : 'disabled'}>Select none</button><span class="spacer"></span><button data-a="delpicked" class="danger" ${n ? '' : 'disabled'} title="Also removes their transcript archives, checkpoints and command logs">${I.trash}<span>Delete ${n} selected${n ? ` (${fmtBytes(bytes)})` : ''}</span></button><button data-a="done" title="Leave selection (Esc)">Done</button>`;
      bar.onmousedown = (e) => { const b = e.target.closest('[data-a]'); if (b && !b.disabled) { e.preventDefault(); holdHistory(); } };
      bar.onclick = (e) => {
        const b = e.target.closest('[data-a]'); if (!b || b.disabled) { return; }
        const a = b.dataset.a;
        if (a === 'all') { hist.picked = new Set(all); } else if (a === 'none') { hist.picked = new Set(); } else if (a === 'done') { setSelecting(false); return; }
        else if (a === 'delpicked') { hist.confirm = PICKED; } else if (a === 'nodelete') { hist.confirm = null; } else if (a === 'dodelete') { deletePicked(); return; }
        hist.sig = ''; renderHistory();
      };
      bar.onchange = null;
      return;
    }
    const total = page ? page.total : rows.length;
    bar.innerHTML = `<select class="sort" aria-label="Sort chats" title="Sort">${HIST_SORTS.map(([v, l]) => `<option value="${v}"${v === hist.sort ? ' selected' : ''}>${l}</option>`).join('')}</select><button data-a="pinned" aria-pressed="${hist.pinnedOnly}" title="Show pinned chats only">${I.pin}<span>Pinned</span></button><span class="spacer"></span><span class="n">${total} chat${total === 1 ? '' : 's'}</span><button data-a="select" title="Select several chats to delete them together">Select</button>`;
    bar.onchange = (e) => { if (e.target.classList.contains('sort')) { setHistSort(e.target.value); const search = els.popover.querySelector('.hist > .search'); if (search) { search.focus(); } } };
    bar.onmousedown = (e) => { if (e.target.closest('[data-a]')) { e.preventDefault(); holdHistory(); } };
    bar.onclick = (e) => {
      const b = e.target.closest('[data-a]'); if (!b) { return; }
      if (b.dataset.a === 'pinned') { hist.pinnedOnly = !hist.pinnedOnly; hist.sel = 0; hist.sig = ''; renderHistory(); histRequest(false); }
      else if (b.dataset.a === 'select') { setSelecting(true); }
    };
  }
  function historyAction(a, s, row) {
    if (a === 'pin') { s.pinned = !s.pinned; post({ type: 'pinSession', id: s.id }); hist.sig = ''; renderHistory(); return; }
    if (a === 'delete') { hist.confirm = s.id; hist.sig = ''; renderHistory(); return; }
    if (a === 'cancel') { hist.confirm = null; hist.sig = ''; renderHistory(); return; }
    if (a === 'confirm') {
      hist.confirm = null;
      // Optimistic: the row goes now; the store's broadcast confirms it. Its tab closes with it.
      state.sessions = state.sessions.filter((x) => x.id !== s.id); state.unread.delete(s.id); state.selected.delete(s.id); state.drafts.delete(s.id); state.scroll.delete(s.id);
      if (state.openTabs) { state.openTabs.delete(s.id); }
      post({ type: 'deleteSession', id: s.id });
      tabSig = ''; renderTabs(); hist.sig = ''; renderHistory();
      toast(`Deleted “${short(s.title || 'New chat', 32)}”`);
      return;
    }
    if (a === 'rename') { startHistoryRename(row, s); return; }
    if (a === 'more') {
      const running = state.running.has(s.id);
      // openMenu empties the popover before placing itself, so the row is gone by then; keep its box.
      const rect = row ? row.getBoundingClientRect() : els.history.getBoundingClientRect();
      openMenu({ getBoundingClientRect: () => rect }, [
        { label: 'Open', icon: I.open, onPick: () => historyOpen(s.id) },
        { label: s.pinned ? 'Unpin' : 'Pin', icon: I.pin, onPick: () => post({ type: 'pinSession', id: s.id }) },
        { label: 'Fork', desc: 'Branch into a new chat from here', icon: I.fork, onPick: () => post({ type: 'forkSession', id: s.id }) },
        { label: 'Export as Markdown', icon: I.export, onPick: () => post({ type: 'exportSession', id: s.id }) },
        { label: 'Export as HTML', desc: 'A standalone page', icon: I.export, onPick: () => post({ type: 'exportSession', id: s.id, format: 'html' }) },
        ...(running ? [{ label: 'Stop agent', icon: I.stop, onPick: () => post({ type: 'stop', sessionId: s.id }) }] : [{ label: 'Clear messages', desc: 'Keeps the chat, empties it', icon: I.list, onPick: () => post({ type: 'clearSession', sessionId: s.id }) }]),
        { hr: true },
        { label: 'Delete chat…', desc: running ? 'Stops the agent first' : 'Cannot be undone', icon: I.trash, onPick: () => { openHistory(); hist.confirm = s.id; hist.sel = historyRows().findIndex((r) => r.s.id === s.id); hist.reveal = true; hist.sig = ''; renderHistory(); } },
        { hr: true },
        { label: 'Back to all chats', icon: I.reply, onPick: openHistory },
      ]);
    }
  }
  function startHistoryRename(row, s) {
    const lbl = row.querySelector('.lbl'); if (!lbl) { return; }
    hist.renaming = s.id;
    const input = el('input', 'rename'); input.value = s.title || ''; input.maxLength = 80; input.setAttribute('aria-label', 'Chat title');
    lbl.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (commit) => {
      if (done) { return; } done = true; hist.renaming = null;
      const v = input.value.trim();
      if (commit && v && v !== s.title) { s.title = v; if (state.session && state.session.id === s.id) { state.session.title = v; } post({ type: 'renameSession', id: s.id, title: v }); tabSig = ''; renderTabs(); }
      hist.sig = ''; renderHistory();
      const search = els.popover.querySelector('.hist > .search'); if (search) { search.focus(); }
    };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    input.onblur = () => finish(true);
    input.onmousedown = (e) => e.stopPropagation();
  }
  function historyKeys(e) {
    if (!hist.open) { return; }
    const rows = historyRows(); const cur = rows[hist.sel];
    const move = (d) => { e.preventDefault(); if (!rows.length) { return; } hist.sel = (hist.sel + d + rows.length) % rows.length; hist.confirm = null; hist.reveal = true; hist.sig = ''; renderHistory(); };
    if (e.key === 'ArrowDown') { move(1); }
    else if (e.key === 'ArrowUp') { move(-1); }
    else if (e.key === 'Home' && !hist.q) { move(-hist.sel); }
    else if (e.key === 'End' && !hist.q) { move(rows.length - 1 - hist.sel); }
    else if (hist.selecting && (e.key === 'Enter' || (e.key === ' ' && e.target.tagName !== 'INPUT'))) { e.preventDefault(); if (hist.confirm === PICKED) { deletePicked(); } else if (cur) { togglePicked(cur.s.id); } }
    else if (hist.selecting && (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) && !(e.key === 'Delete' && e.target.value)) { e.preventDefault(); if (hist.picked.size) { if (hist.confirm === PICKED) { deletePicked(); } else { hist.confirm = PICKED; hist.sig = ''; renderHistory(); } } }
    else if (e.key === 'Enter') { e.preventDefault(); if (!cur) { return; } if (hist.confirm === cur.s.id) { historyAction('confirm', cur.s); } else { historyOpen(cur.s.id); } }
    else if (e.key === 'Escape') { e.preventDefault(); if (hist.confirm) { historyAction('cancel'); } else if (hist.selecting) { setSelecting(false); } else if (hist.q) { const search = els.popover.querySelector('.hist > .search'); search.value = ''; search.oninput(); } else { closeMenu(); els.input.focus(); } }
    else if (e.key === 'F2' && cur) { e.preventDefault(); const row = els.popover.querySelector(`.hist-row[data-id="${cur.s.id}"]`); if (row) { startHistoryRename(row, cur.s); } }
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) && cur && !(e.key === 'Delete' && e.target.value)) { e.preventDefault(); historyAction(hist.confirm === cur.s.id ? 'confirm' : 'delete', cur.s); }
  }
  function closeOtherTabs() {
    const active = activeId(); const { list } = tabList();
    let n = 0;
    if (!state.openTabs) { state.openTabs = new Set(list.map((s) => s.id)); }
    for (const s of list) { if (s.id !== active && !state.running.has(s.id) && !s.pinned) { state.openTabs.delete(s.id); state.unread.delete(s.id); n++; } }
    renderTabs(); toast(n ? `Closed ${n} tab${n === 1 ? '' : 's'}` : 'Nothing to close');
  }
  function confirmClearHistory() {
    // Same set the panel shows: untouched empty chats are not counted as "history".
    const idle = state.sessions.filter((s) => !state.running.has(s.id) && (s.messageCount > 0 || s.pinned || s.plan)); const pinned = idle.filter((s) => s.pinned).length;
    if (!idle.length) { toast(state.running.size ? 'Only running chats are open — stop them first' : 'No chat history to clear'); return; }
    const size = (list) => fmtBytes(list.reduce((n, s) => n + (s.bytes || 0), 0));
    const items = [
      { label: pinned ? `Delete ${idle.length - pinned} chat${idle.length - pinned === 1 ? '' : 's'} (${size(idle.filter((s) => !s.pinned))}), keep ${pinned} pinned` : `Delete ${idle.length} chat${idle.length === 1 ? '' : 's'} (${size(idle)})`, desc: 'Cannot be undone — file changes already accepted stay on disk', icon: I.trash, onPick: () => post({ type: 'clearHistory', keepPinned: true }) },
      ...(pinned ? [{ label: `Delete everything (${idle.length} · ${size(idle)})`, desc: 'Including pinned chats', icon: I.trash, onPick: () => post({ type: 'clearHistory', keepPinned: false }) }] : []),
      { label: 'Cancel', icon: I.x, onPick: openHistory },
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
  els.newTab.onclick = () => post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent', ...(specOf(state.session) ? { specialist: specOf(state.session) } : {}) });
  els.history.onclick = openHistory;
  // Placeholder adapts to the composer width.
  const PLACEHOLDERS = [[0, 'Ask anything…'], [300, 'Ask anything, or describe a task…']];
  function basePlaceholder() { const w = els.box.clientWidth; let p = PLACEHOLDERS[0][1]; for (const [min, t] of PLACEHOLDERS) { if (w >= min) { p = t; } } return p; }
  new ResizeObserver(() => { syncPlaceholder(); fitModelChip(); }).observe(els.box);
  // Pickers next to the model chip come and go (thinking, Stop): its own size changing is the cue to refit the label.
  new ResizeObserver(() => fitModelChip()).observe(els.modelBtn);
  function syncPlaceholder() {
    const sid = state.session && state.session.id; const p = sid && state.paused.get(sid);
    const mode = state.session && MODES[state.session.mode];
    // A one-row textarea shows one line of placeholder; narrow composers get the short form of the long hints.
    const wide = els.box.clientWidth >= 380;
    // Revise on a plan card: the next message is feedback on the plan, until it is sent.
    if (sid && state.revising === sid && !state.running.has(sid)) { els.input.placeholder = 'What should change in the plan?'; return; }
    els.input.placeholder = p && p.paused ? (wide ? 'Add instructions — the agent reads them when it resumes…' : 'Instructions for when it resumes…') : sid && state.running.has(sid) ? (wide ? `Type to steer this agent (used at its next step), ${kb('Mod+Shift+Enter')} for a new tab…` : 'Steer this agent…') : mode && (state.session.mode !== 'agent' || specOf(state.session)) && els.box.clientWidth >= 300 ? modeView(state.session).placeholder : basePlaceholder();
  }
  let tasksSig = '';
  /** Per-session open/closed choice for the Tasks panel, once the user has toggled it. */
  const tasksUserOpen = new Map();
  /** A linked checklist item: scroll to the first step it ran and flash it. */
  function goToTodo(id) {
    const row = els.messages.querySelector(`[data-todo="${CSS.escape(id)}"]`); if (!row) { return; }
    const turn = row.closest('.turn'); if (turn) { turn.classList.remove('folded'); }
    row.scrollIntoView({ block: 'center', behavior: calmMotion() ? 'auto' : 'smooth' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1600);
  }
  els.tasksList.addEventListener('click', (e) => { const li = e.target.closest('li.todo.linked'); if (li) { goToTodo(li.dataset.id); } });
  els.tasksList.addEventListener('keydown', (e) => { const li = e.target.closest('li.todo.linked'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goToTodo(li.dataset.id); } });
  function renderTasks() {
    const todos = state.session && Array.isArray(state.session.todos) ? state.session.todos : [];
    els.tasks.classList.toggle('hidden', !todos.length); if (!todos.length) { tasksSig = ''; return; }
    const done = todos.filter((t) => t.status === 'done').length;
    els.tasksLabel.textContent = `Tasks ${done}/${todos.length}`;
    // Open while the agent works; folded to one line (the current step) when idle — unless the user chose otherwise.
    const open = tasksUserOpen.has(state.session.id) ? tasksUserOpen.get(state.session.id) : state.running.has(state.session.id);
    els.tasks.classList.toggle('open', open); els.tasksList.classList.toggle('hidden', !open);
    const now = todos.find((t) => t.status === 'in_progress') || todos.find((t) => t.status === 'pending');
    let nowEl = els.tasksToggle.querySelector('.now-task');
    if (!nowEl) { nowEl = el('span', 'now-task', ''); els.tasksLabel.after(nowEl); }
    nowEl.textContent = !open && now ? `· ${now.title}` : '';
    els.tasksMeter.firstElementChild.style.width = `${Math.round((done / todos.length) * 100)}%`;
    const sig = `${state.session.id}|${todos.map((t) => `${t.id}:${t.status}:${t.title}:${t.agent || ''}:${(t.dependsOn || []).join(',')}`).join('|')}`;
    if (sig === tasksSig) { return; }
    tasksSig = sig;
    const y = els.tasksList.scrollTop;
    els.tasksList.innerHTML = '';
    for (const t of todos) {
      // in_progress is a filled marker, not a spinner: the Workers card and the status line already show the motion.
      // A failed item (a worker's error) is marked ✕ in the error colour; skipped ones get a dash and say why.
      const bad = todoFailed(t);
      const li = el('li', `todo ${t.status}${bad ? ' failed' : ''}`, `<span class="box" aria-hidden="true">${t.status === 'done' ? I.check : t.status === 'in_progress' ? '<i class="now"></i>' : bad ? I.x : t.status === 'skipped' ? '<i class="dash"></i>' : ''}</span><span class="title">${esc(t.title)}</span>${t.agent ? `<span class="todo-agent" title="${esc(t.status === 'pending' ? `Will be delegated to the ${t.agent} subagent${t.dependsOn && t.dependsOn.length ? ` after ${t.dependsOn.join(', ')}` : ''}` : t.status === 'in_progress' ? `The ${t.agent} subagent is working on this` : `Delegated to the ${t.agent} subagent`)}">${I.agent}${esc(t.agent)}${t.dependsOn && t.dependsOn.length ? `<span class="todo-after">after ${esc(t.dependsOn.join(', '))}</span>` : ''}</span>` : ''}`);
      li.dataset.id = String(t.id);
      const st = bad ? 'Failed' : t.status === 'skipped' ? 'Skipped' : t.status === 'done' ? 'Done' : t.status === 'in_progress' ? 'In progress' : 'To do';
      li.setAttribute('aria-label', `${st}: ${t.title}`);
      if (t.result) { li.title = `${st}: ${t.result.slice(0, 600)}`; }
      // Linked to the steps that ran it (rows carry data-todo): click or Enter scrolls to the first one.
      if (els.messages.querySelector(`[data-todo="${CSS.escape(String(t.id))}"]`)) { li.classList.add('linked'); li.tabIndex = 0; li.setAttribute('role', 'button'); }
      els.tasksList.appendChild(li);
    }
    els.tasksList.scrollTop = y;
  }
  /** "View changes" under the latest finished answer, when files changed since the last message (commands included). */
  function syncViewChanges(sid) {
    if (!state.session || state.session.id !== sid) { return; }
    const last = els.messages.lastElementChild;
    const foot = last && last.classList.contains('assistant') && !state.running.has(sid) ? last.querySelector(':scope > .afoot .acts') : null;
    // The chip, its "one diff" companion and the separator after them come and go together.
    const drop = (b) => { const all = b.nextElementSibling && b.nextElementSibling.dataset.act === 'viewChangesDiff' ? b.nextElementSibling : null; const after = all || b; if (after.nextElementSibling && after.nextElementSibling.classList.contains('sep')) { after.nextElementSibling.remove(); } if (all) { all.remove(); } b.remove(); };
    els.messages.querySelectorAll('.afoot [data-act="viewChanges"]').forEach((b) => { if (!foot || b.parentElement !== foot) { drop(b); } });
    const lt = state.lastTurn.get(sid); const n = lt ? lt.files : 0;
    let b = foot && foot.querySelector('[data-act="viewChanges"]');
    if (!foot || !n) { if (b) { drop(b); } return; }
    // A labelled chip, not a bare glyph: what it opens (the changed files) is the point, so it says how many. It starts the
    // file-by-file review of that turn; the one-tab multi-file diff is the quieter icon next to it.
    if (!b) { foot.insertAdjacentHTML('afterbegin', `<button class="chg" data-act="viewChanges">${I.diff}<span></span></button><button data-act="viewChangesDiff">${I.multidiff}</button><i class="sep" aria-hidden="true"></i>`); b = foot.firstElementChild; }
    const label = `${n} file${n === 1 ? '' : 's'}`;
    if (b.lastElementChild.textContent !== label) { b.lastElementChild.textContent = label; }
    b.title = `Review changes: ${label} changed since your last message, one by one in a side-by-side diff`; b.setAttribute('aria-label', `Review ${label} changed since your last message`);
    const all = b.nextElementSibling; all.title = `Open all ${label} changed since your last message in one diff`; all.setAttribute('aria-label', all.title);
  }
  let changesSig = '';
  /** The inline "Reject N files?" row while it is open. */
  let rejectConfirm = null;
  /** fsPath of the review-queue row that holds the roving tab stop; `changesKeyNav`: the last move came from the keyboard. */
  let changesFocus = ''; let changesKeyNav = false; let redoTimer = 0;
  const KIND = { create: 'A', modify: 'M', delete: 'D', rename: 'R', conflict: 'C' };
  const KIND_WORD = { create: 'added', modify: 'modified', delete: 'deleted', rename: 'renamed', conflict: 'has conflicts' };
  /** Pending and reviewed files in one list, sorted by path (the order the host walks the queue in, ChangeTracker.forSession) so a row keeps its place when it is accepted or rejected. */
  function reviewRows(sid) {
    const files = state.changes.get(sid) || []; const done = state.worktree.get(sid) ? [] : state.reviewed.get(sid) || [];
    const pend = new Set(files.map((f) => f.fsPath));
    // Conflicts from applying an isolated copy come first: they block the work until resolved in the merge editor.
    const conflicts = (state.conflicts.get(sid) || []).map((c) => ({ fsPath: c.fsPath, path: c.path, kind: 'conflict', state: 'conflict' }));
    return [...conflicts, ...[...files.map((f) => ({ ...f, state: 'pending' })), ...done.filter((r) => !pend.has(r.fsPath))].sort((a, b) => a.fsPath.localeCompare(b.fsPath))];
  }
  function renderChanges() {
    const s = state.session; const files = s ? state.changes.get(s.id) || [] : [];
    const wt = s ? state.worktree.get(s.id) : null;
    const all = s ? reviewRows(s.id) : []; const nConf = all.filter((r) => r.state === 'conflict').length;
    const rows = all; const reviewed = all.length - files.length - nConf;
    els.changes.classList.toggle('hidden', !rows.length);
    // The confirm row belongs to one chat and one count: switching chats, a worktree or an emptied list drops it.
    if (rejectConfirm && (!files.length || wt || rejectConfirm.dataset.sid !== s.id)) { closeRejectConfirm(false); }
    if (rejectConfirm) { rejectConfirm.querySelector('.q').firstChild.textContent = `Reject ${files.length} file${files.length === 1 ? '' : 's'}? `; }
    if (!rows.length) { changesSig = ''; return; }
    const added = files.reduce((n, f) => n + (f.added || 0), 0); const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
    const n = rows.length - nConf; const nf = `${n} file${n === 1 ? '' : 's'}`;
    // "5 files changed · 2 reviewed" with a meter; the short form drops "changed" for narrow panels.
    const conf = nConf ? `${nConf} conflict${nConf === 1 ? '' : 's'} to resolve` : '';
    const label = !n ? conf : `${wt ? `${nf} changed in isolated copy${added || removed ? ` · +${added} −${removed}` : ''}` : reviewed ? `${nf} changed · ${reviewed} reviewed` : `${nf} changed`}${conf ? ` · ${conf}` : ''}`;
    // Narrow panels read "2/5 reviewed" (the .short form); the full label stays as the tooltip.
    const shortLabel = !wt && reviewed ? `${reviewed}/${n} reviewed` : '';
    const html = shortLabel ? `<span class="long">${esc(label)}</span><span class="short">${esc(shortLabel)}</span>` : esc(label);
    if (els.changesLabel.innerHTML !== html) { els.changesLabel.innerHTML = html; els.changesToggle.title = label; }
    els.changesMeter.classList.toggle('hidden', !!wt || !reviewed);
    els.changesMeter.firstElementChild.style.width = `${n ? Math.round((reviewed / n) * 100) : 0}%`;
    els.changesMeter.setAttribute('aria-valuemax', String(n)); els.changesMeter.setAttribute('aria-valuenow', String(reviewed)); els.changesMeter.setAttribute('aria-valuetext', `${reviewed} of ${n} reviewed`);
    els.changesMeter.title = `${reviewed} of ${n} reviewed`;
    // Isolated worktree: the agent's edits are not in the workspace yet — Apply brings them over, Discard throws the copy away.
    els.changes.classList.toggle('isolated', !!wt);
    els.changes.classList.toggle('done', !wt && !files.length);
    const head = els.changes.querySelector('.panel-head');
    // The two buttons are relabelled in place as the session moves between a worktree and the workspace; look them up by either name.
    const undoAll = head.querySelector('[data-a="undoAll"], [data-a="discardWorktree"]'); const keepAll = head.querySelector('[data-a="keepAll"], [data-a="applyWorktree"]');
    const multi = head.querySelector('[data-a="reviewAll"]'); if (multi) { multi.classList.toggle('hidden', !!wt || !files.length); }
    const review = head.querySelector('[data-a="review"], [data-a="clearReviewed"]');
    if (wt) {
      if (review) { review.classList.add('hidden'); }
      if (keepAll) { keepAll.classList.toggle('hidden', !files.length); }
      if (undoAll) { undoAll.classList.toggle('hidden', !files.length); undoAll.title = 'Discard the isolated copy and its changes'; undoAll.querySelector('.long').textContent = 'Discard'; undoAll.dataset.a = 'discardWorktree'; }
      if (keepAll) { keepAll.classList.add('primary'); keepAll.classList.remove('ghost'); keepAll.title = wt.conflicts && wt.conflicts.length ? `Last apply left conflict markers in: ${wt.conflicts.join(', ')}` : 'Apply these changes to your workspace as uncommitted edits (3-way merge on conflict)'; keepAll.querySelector('.long').textContent = 'Apply to workspace'; keepAll.dataset.a = 'applyWorktree'; }
      // Applying while the agent still edits would fold its in-flight edits into the new base; wait for a pause or the end.
      const p = state.paused.get(s.id); const busy = state.running.has(s.id) && !(p && p.holding);
      if (keepAll) { keepAll.setAttribute('aria-disabled', String(busy)); if (busy) { keepAll.title = 'Pause or stop the agent before applying its changes'; } }
    } else {
      // Review (primary) opens the first file not reviewed yet; once every file is decided it becomes Clear reviewed.
      if (undoAll) { undoAll.classList.toggle('hidden', !files.length); undoAll.title = `Reject all ${files.length} file${files.length === 1 ? '' : 's'} waiting for review`; undoAll.querySelector('.long').textContent = 'Reject all'; undoAll.dataset.a = 'undoAll'; }
      if (keepAll) { keepAll.classList.toggle('hidden', !files.length); keepAll.classList.remove('primary'); keepAll.classList.add('ghost'); keepAll.title = `Accept all ${files.length} file${files.length === 1 ? '' : 's'} waiting for review`; keepAll.querySelector('.long').textContent = 'Accept all'; keepAll.dataset.a = 'keepAll'; keepAll.removeAttribute('aria-disabled'); }
      if (review) {
        review.classList.toggle('hidden', !files.length && !reviewed);
        if (files.length) { review.dataset.a = 'review'; review.className = 'btn primary'; review.title = `Review file by file: opens ${files.length === n ? 'the first file' : 'the next file not reviewed yet'} in a side-by-side diff, where Accept and Reject move on to the next`; review.innerHTML = `${I.diff}<span class="long">Review</span>`; }
        else { review.dataset.a = 'clearReviewed'; review.className = 'btn ghost'; review.title = 'Remove the reviewed files from this list (your decisions stay)'; review.innerHTML = `${I.x}<span class="long">Clear reviewed</span>`; }
        review.setAttribute('aria-label', review.dataset.a === 'review' ? 'Review file by file' : 'Clear reviewed');
      }
    }
    const now = Date.now();
    const sig = `${s.id}|${wt ? 'wt' : ''}|${rows.map((f) => `${f.fsPath}:${f.kind}:${f.added || 0}:${f.removed || 0}:${f.state}:${f.redoUntil > now ? 1 : 0}`).join('|')}`;
    // Restore edits expires with the host's redo window: redraw the row then so its button turns into the explanation.
    clearTimeout(redoTimer); const nextExpiry = Math.min(...rows.filter((f) => f.redoUntil > now).map((f) => f.redoUntil));
    if (Number.isFinite(nextExpiry)) { redoTimer = setTimeout(renderChanges, Math.min(nextExpiry - now + 50, 2 ** 31 - 1)); }
    if (sig === changesSig) { return; }
    changesSig = sig;
    const hadFocus = els.changesList.contains(document.activeElement);
    const y = els.changesList.scrollTop;
    els.changesList.innerHTML = '';
    // The roving tab stop stays on its file; a file that just left the pending set hands it to the next pending one.
    const pendingAfter = (fp) => rows.find((r) => r.state === 'pending' && r.fsPath.localeCompare(fp) > 0) || rows.find((r) => r.state === 'pending');
    let focusRow = rows.find((r) => r.fsPath === changesFocus);
    if (focusRow && focusRow.state !== 'pending' && changesKeyNav) { focusRow = pendingAfter(focusRow.fsPath) || focusRow; }
    if (!focusRow) { focusRow = rows.find((r) => r.state === 'pending') || rows[0]; }
    changesFocus = focusRow.fsPath;
    for (const f of rows) {
      const stat = f.added || f.removed ? `<span class="stat"><i class="add">+${f.added || 0}</i><i class="del">−${f.removed || 0}</i></span>` : '';
      const p = esc(f.path); const del = f.kind === 'delete';
      let acts = '';
      if (f.state === 'conflict') { acts = `<span class="acts keep"><button data-a="merge" class="txt" title="Resolve the conflict markers in ${p} in the merge editor" aria-label="Open ${p} in the merge editor">${I.git || I.open}<span class="long">Resolve</span></button></span>`; }
      else if (wt) { acts = ''; }
      else if (f.state === 'pending') { acts = `<span class="acts"><button data-a="undo" title="Reject: put ${p} back as it was (r)" aria-label="Reject ${p}">${I.undo}<span class="long">Reject</span></button><button data-a="keep" title="Accept: keep the agent's ${del ? 'deletion' : 'edits'} (a)" aria-label="Accept ${p}">${I.check}<span class="long">Accept</span></button></span>`; }
      else if (f.state === 'accepted') { acts = `<span class="tag ok">${I.check}<span>Accepted</span></span>`; }
      else {
        const live = f.redoUntil > now;
        acts = `<span class="tag">${I.undo}<span>Rejected</span></span><span class="acts keep"><button data-a="restore" class="txt"${live ? ` title="Put the agent's edits to ${p} back"` : ' aria-disabled="true" title="No longer kept: use Restore checkpoint on the message"'} aria-label="Restore edits to ${p}">${I.restore}<span class="long">Restore edits</span></button></span>`;
      }
      const what = f.state === 'conflict' ? 'open in the merge editor' : f.state === 'pending' ? (del ? 'open the deleted file\'s original' : 'open the diff') : f.state === 'accepted' ? 'accepted, open the file' : del || f.kind === 'create' ? 'rejected' : 'rejected, open the file';
      // The name opens the diff (or the file once reviewed); the row itself carries the keyboard focus (j/k/a/r/Enter).
      const li = el('li', `change ${f.state}`, `<span class="kind ${f.kind}" title="${KIND_WORD[f.kind] || 'modified'}">${KIND[f.kind] || 'M'}</span><button class="name" tabindex="-1" title="${p} — ${what}"${f.state === 'rejected' && (del || f.kind === 'create') ? ' aria-disabled="true"' : ''}>${p}</button>${stat}${acts}`);
      li.dataset.file = f.fsPath; li.dataset.state = f.state; li.setAttribute('tabindex', f.fsPath === changesFocus ? '0' : '-1');
      li.setAttribute('aria-label', `${f.path}, ${KIND_WORD[f.kind] || 'modified'}${f.added || f.removed ? `, ${f.added || 0} added, ${f.removed || 0} removed lines` : ''}, ${f.state === 'pending' ? 'not reviewed' : f.state === 'conflict' ? 'resolve in the merge editor' : f.state}`);
      li.onclick = (e) => { changesKeyNav = false; changesFocus = f.fsPath; changeAction(f, (e.target.closest('[data-a]') || {}).dataset?.a || 'open', e.target.closest('[data-a]')); };
      els.changesList.appendChild(li);
    }
    if (reviewed && files.length) { els.changesList.appendChild(el('li', 'change-foot', `<button class="txt" data-a="clearReviewed" tabindex="-1" title="Remove the reviewed files from this list (your decisions stay)">Clear reviewed</button>`)); els.changesList.lastElementChild.onclick = () => s && post({ type: 'clearReviewed', sessionId: s.id }); }
    els.changesList.scrollTop = y;
    if (hadFocus) { const r = els.changesList.querySelector('li[tabindex="0"]'); if (r) { r.focus({ preventScroll: true }); r.scrollIntoView({ block: 'nearest' }); } }
  }
  /** One row action: open (diff while pending, the file once reviewed), keep / undo, or restore a rejected file's edits. */
  function changeAction(f, act, btn) {
    const s = state.session; if (!s || (btn && btn.getAttribute('aria-disabled') === 'true')) { if (btn && act === 'restore') { toast('No longer kept: use Restore checkpoint on the message'); } return; }
    if (act === 'keep' || act === 'undo') { if (f.state === 'pending') { post({ type: act === 'undo' ? 'undoChanges' : 'keepChanges', sessionId: s.id, fsPath: f.fsPath }); } return; }
    if (act === 'restore') { if (f.state === 'rejected') { post({ type: 'restoreEdits', sessionId: s.id, fsPath: f.fsPath }); } return; }
    if (f.state === 'conflict') { post({ type: 'recoveryAction', sessionId: s.id, action: 'openMergeEditor', file: f.fsPath }); return; }
    if (f.state === 'pending') { post({ type: 'review', sessionId: s.id, scope: 'session', fsPath: f.fsPath }); }
    else if (!(f.state === 'rejected' && (f.kind === 'delete' || f.kind === 'create'))) { post({ type: 'openFile', path: f.fsPath, sessionId: s.id }); }
  }
  // Review queue keys on the focused row: j/k (or arrows) move, a accepts, r rejects, Enter / Space opens.
  els.changesList.addEventListener('keydown', (e) => {
    const li = e.target.closest && e.target.closest('li.change'); if (!li || e.metaKey || e.ctrlKey || e.altKey) { return; }
    const items = [...els.changesList.querySelectorAll('li.change')]; const i = items.indexOf(li);
    const move = (j) => { const t = items[Math.max(0, Math.min(items.length - 1, j))]; if (!t) { return; } items.forEach((x) => x.setAttribute('tabindex', x === t ? '0' : '-1')); changesFocus = t.dataset.file; t.focus(); t.scrollIntoView({ block: 'nearest' }); };
    const k = e.key;
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); move(i + 1); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); move(i - 1); return; }
    if (k === 'Home') { e.preventDefault(); move(0); return; }
    if (k === 'End') { e.preventDefault(); move(items.length - 1); return; }
    if (e.target !== li) { return; } // keys typed on a row's own buttons keep their meaning
    const f = reviewRows(state.session ? state.session.id : '').find((r) => r.fsPath === li.dataset.file); if (!f) { return; }
    const act = k === 'a' ? 'keep' : k === 'r' ? 'undo' : k === 'Enter' || k === ' ' ? 'open' : '';
    if (!act) { return; }
    e.preventDefault(); changesKeyNav = true; changeAction(f, act, null);
  });
  function renderChips() {
    els.chips.innerHTML = '';
    state.attachments.forEach((a, i) => { const c = el('span', 'chip', `${a.startsWith('@') || MENTIONS.some(([n]) => n === a) ? I.list : I.file}<span title="${esc(a)}">${esc(a.replace(/^@/, ''))}</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { state.attachments.splice(i, 1); renderChips(); }; els.chips.appendChild(c); });
    state.images.forEach((img, i) => { const c = el('span', 'chip img', `<img src="data:${img.mime};base64,${img.data}" alt=""><span title="${esc(img.name)}">${esc(img.name)}</span><button title="Remove">${I.x}</button>`); c.querySelector('button').onclick = () => { state.images.splice(i, 1); renderChips(); updateSendEnabled(); }; els.chips.appendChild(c); });
  }
  function addImageFile(file) {
    if (!file || !/^image\//.test(file.type)) { return; }
    if (attachCount() >= MAX_ATTACH) { toast(`Up to ${MAX_ATTACH} images and files per message`, 'error'); return; }
    const blind = visionBlocked(); if (blind) { toast(`${blind} cannot read images — pick a vision model`, 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => addImageUrl(file.name || `pasted-${Date.now().toString(36)}.png`, reader.result);
    reader.readAsDataURL(file);
  }
  /** Downscales to 1568 px max and re-encodes as PNG, so the bytes always match the image/png label. */
  function addImageUrl(name, url) {
    const blind = visionBlocked(); if (blind) { toast(`${blind} cannot read images — pick a vision model`, 'error'); return; }
    const img = new Image();
    img.onload = () => { if (attachCount() >= MAX_ATTACH) { toast(`Up to ${MAX_ATTACH} images and files per message`, 'error'); return; } if (Math.max(img.width, img.height) > MAX_IMAGE_SIDE) { toast(`${name} is ${img.width}×${img.height} px; images may be at most ${MAX_IMAGE_SIDE} px on a side`, 'error'); return; } const MAX = 1568; const k = Math.min(1, MAX / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); state.images.push({ name, data: c.toDataURL('image/png').split(',')[1], mime: 'image/png' }); renderChips(); updateSendEnabled(); els.input.focus(); };
    img.onerror = () => toast(`Could not read image ${name}`, 'error');
    img.src = url;
  }
  function addAttachment(ref) { if (!state.attachments.includes(ref)) { if (attachCount() >= MAX_ATTACH) { toast(`Up to ${MAX_ATTACH} images and files per message`, 'error'); return; } state.attachments.push(ref); renderChips(); } els.input.focus(); }
  /** "Add to Chat": chips join the current draft and the text goes below it (once — a reloaded view gets it again). */
  function appendDraft(text, refs) { for (const ref of refs || []) { if (state.attachments.includes(ref)) { continue; } if (attachCount() >= MAX_ATTACH) { toast(`Up to ${MAX_ATTACH} images and files per message`, 'error'); break; } state.attachments.push(ref); } renderChips(); const t = (text || '').trim(); const v = els.input.value; if (t && !v.includes(t)) { els.input.value = v.trim() ? `${v.replace(/\s+$/, '')}\n\n${t}\n` : `${t}\n`; } autoGrow(); updateSendEnabled(); els.input.focus(); els.input.selectionStart = els.input.selectionEnd = els.input.value.length; }
  /** A queued message brought back for editing goes in front of what is being composed; nothing typed or attached is lost. */
  function mergeDraft(text, images, refs) { const t = (text || '').trim(); const v = els.input.value; if (t) { els.input.value = v.trim() ? `${t}\n\n${v.replace(/^\s+/, '')}` : t; } for (const data of images || []) { state.images.push({ name: `image-${state.images.length + 1}.png`, data: String(data).replace(/^data:[^,]*,/, ''), mime: 'image/png' }); } for (const ref of refs || []) { if (!state.attachments.includes(ref)) { state.attachments.push(ref); } } renderChips(); autoGrow(); updateSendEnabled(); els.input.focus(); els.input.selectionStart = els.input.selectionEnd = t.length; }
  // Limits (the host checks them too): images plus files per message, and the longest side of an image.
  const MAX_ATTACH = 20; const MAX_IMAGE_SIDE = 7680;
  function attachCount() { return state.attachments.length + state.images.length; }
  /** Refuses a send whose chips, @mentions and images together exceed the limit. */
  function tooManyAttachments(attachments) { if (attachments.length + state.images.length <= MAX_ATTACH) { return false; } toast(`${attachments.length + state.images.length} attachments — up to ${MAX_ATTACH} images and files per message`, 'error'); return true; }
  /** The selected model's name when it cannot read images and routing has no vision model to hand them to. */
  function visionBlocked() { const m = currentModel(); if (!m || m.supportsVision || (state.visionRouting && state.models.some((x) => x.supportsVision))) { return ''; } return m.name; }
  function syncVision() { const blind = visionBlocked(); els.image.classList.toggle('off', !!blind); els.image.setAttribute('aria-disabled', blind ? 'true' : 'false'); els.image.title = blind ? `${blind} cannot read images — pick a vision model to attach images or screenshots` : 'Attach image or take a screenshot (area, window, screen)'; }
  /** Inserts text at the caret (dropped text, dropped files as @mentions). */
  function insertAtCaret(text) { const v = els.input.value; const s = els.input.selectionStart; const e = els.input.selectionEnd; els.input.value = v.slice(0, s) + text + v.slice(e); els.input.selectionStart = els.input.selectionEnd = s + text.length; autoGrow(); updateSendEnabled(); els.input.focus(); }
  function insertMention(ref) { const before = els.input.value.slice(0, els.input.selectionStart); insertAtCaret(`${before && !/\s$/.test(before) ? ' ' : ''}@${/^[\w./-]+$/.test(ref) ? ref : `"${ref}"`} `); }

  // ------------------------------------------------------------------ popover menus
  let menuState = null;
  function closeMenu() { menuA11yClose(); els.popover.classList.add('hidden'); els.popover.innerHTML = ''; els.popover.dataset.menu = ''; menuState = null; hist.open = false; hist.renaming = null; hist.confirm = null; }
  /** Above the anchor when there is room, else below; never past the right edge. */
  function placePopover(anchor) {
    const p = els.popover; const r = anchor.getBoundingClientRect(); const pw = Math.min(360, window.innerWidth - 20);
    p.style.left = `${Math.max(10, Math.min(r.left, window.innerWidth - pw - 10))}px`;
    const ph = p.offsetHeight; const above = r.top - 8;
    if (above >= Math.min(ph, 200)) { p.style.top = `${Math.max(8, r.top - 6 - ph)}px`; } else { p.style.top = `${r.bottom + 6}px`; }
  }
  function openMenu(anchor, items, opts = {}) {
    const p = els.popover; p.innerHTML = ''; p.classList.remove('hidden'); p.dataset.menu = opts.cls || '';
    menuState = { items: [], sel: 0, onPick: opts.onPick, inline: !!opts.inline };
    let search = null;
    if (opts.search) { search = el('input', 'search'); search.placeholder = opts.search; p.appendChild(search); }
    const list = el('div', 'list'); p.appendChild(list);
    list.id = 'lpMenuList'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', opts.label || (anchor.getAttribute && (anchor.getAttribute('aria-label') || anchor.title)) || 'Options');
    const render = (q) => {
      list.innerHTML = ''; menuState.items = [];
      const ql = (q || '').toLowerCase(); let lastGroup = null; let notes = 0;
      // `fuzzy` menus rank what was typed by match quality and highlight the matched letters; `onNoMatch` offers
      // something to do with text that matches nothing.
      let shown = items;
      if (opts.fuzzy && ql) {
        shown = items.filter((it) => !it.hr && !it.noSearch).map((it) => {
          const m = fuzzyMatch(ql, it.label);
          if (!m && !`${it.desc || ''} ${it.group || ''}`.toLowerCase().includes(ql)) { return null; }
          return { it, s: m ? m.score : -1e6, html: m ? hlHtml(it.label, m.positions) : '' };
        }).filter(Boolean).sort((a, b) => b.s - a.s).map((x) => ({ ...x.it, labelHtml: x.html || x.it.labelHtml }));
        if (!shown.length && opts.onNoMatch) { shown = opts.onNoMatch(String(q).trim()); }
      }
      for (const it of shown) {
        if (it.hr) { if (!ql) { list.appendChild(el('hr')); } continue; }
        // A status line (searching, nothing found): shown, never highlighted or picked.
        if (it.note) { const n = el('div', `empty-i note${it.spin ? ' searching' : ''}`, `${it.spin ? '<span class="mspin" aria-hidden="true"></span>' : ''}<span>${esc(it.label)}</span>`); n.setAttribute('role', 'status'); list.appendChild(n); notes++; continue; }
        if (!opts.fuzzy && ql && !(`${it.label} ${it.desc || ''} ${it.group || ''}`.toLowerCase().includes(ql))) { continue; }
        if (it.group && it.group !== lastGroup && !ql) { list.appendChild(el('div', 'grp', `${it.groupIcon ? `<span class="gico" aria-hidden="true">${it.groupIcon}</span>` : ''}${esc(it.group)}`)); lastGroup = it.group; }
        const star = it.onStar ? `<button class="star${it.starred ? ' on' : ''}" title="${it.starred ? 'Unstar' : 'Star: pin to the top'}" aria-label="${it.starred ? 'Unstar' : 'Star'} ${esc(it.label)}" aria-pressed="${it.starred ? 'true' : 'false'}">${STAR_ICON}</button>` : '';
        const row = el('div', 'item', `<span class="ico">${it.icon || ''}</span><span class="txt"><span class="lbl">${it.labelHtml || esc(it.label)}</span>${it.desc ? `<span class="desc">${it.descHtml || esc(it.desc)}</span>` : ''}</span>${(it.tags || [it.tag && { text: it.tag }]).filter(Boolean).map((t) => `<span class="tag${t.cls ? ` ${t.cls}` : ''}"${t.title ? ` title="${esc(t.title)}"` : ''}>${esc(t.text)}</span>`).join('')}${star}<span class="check">${it.selected ? I.check : ''}</span>`);
        if (it.title || it.desc) { row.title = it.title || it.desc; }
        row.onmousedown = (e) => { e.preventDefault(); pick(it); };
        // Mouse down only keeps focus and the menu; the toggle runs on click so Enter / Space on a focused star work too.
        if (it.onStar) { const st = row.querySelector('.star'); st.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); }; st.onclick = (e) => { e.preventDefault(); e.stopPropagation(); star(it); }; }
        row.setAttribute('role', 'option'); row.id = `lpOpt${menuState.items.length}`;
        menuState.items.push({ it, row }); list.appendChild(row);
      }
      if (!menuState.items.length && !notes) { list.appendChild(el('div', 'empty-i', 'No matches')); }
      // Ranked results start on the best match; otherwise on the current choice.
      menuState.sel = opts.fuzzy && ql ? 0 : Math.max(0, menuState.items.findIndex((x) => x.it.selected)); highlight();
    };
    const highlight = () => { menuState.items.forEach((x, i) => x.row.classList.toggle('sel', i === menuState.sel)); menuA11y(anchor, search, list); };
    menuState.highlight = highlight;
    // Starring re-opens the menu (the row moves to Starred); keep the highlight on the same row.
    const star = (it) => {
      const keep = it.label; it.onStar(search ? search.value : '');
      if (menuState && menuState.highlight) { const j = menuState.items.findIndex((x) => x.it.label === keep && x.it.onStar); if (j >= 0) { menuState.sel = j; menuState.highlight(); menuState.items[j].row.scrollIntoView({ block: 'nearest' }); } }
    };
    // Return focus to the composer unless the picked action opened something that took it.
    const pick = (it) => { closeMenu(); it.onPick && it.onPick(); if (!document.activeElement || document.activeElement === document.body) { els.input.focus(); } };
    if (search && opts.query) { search.value = opts.query; }
    render(search ? search.value : '');
    if (items.some((it) => it.onStar)) { p.appendChild(el('div', 'mfoot', `<span>↑↓ move</span><span>↵ pick</span><span>⇧↵ star</span>`)); }
    else if (opts.foot) { p.appendChild(el('div', 'mfoot', opts.foot)); }
    placePopover(anchor);
    const key = (e) => {
      if (!menuState || e.isComposing || e.keyCode === 229) { return; }
      const n = menuState.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { menuState.sel = (menuState.sel + 1) % n; highlight(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { menuState.sel = (menuState.sel - 1 + n) % n; highlight(); } }
      else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); const x = menuState.items[menuState.sel]; if (x && x.it.onStar) { star(x.it); } }
      else if (e.key === 'Enter') { e.preventDefault(); const x = menuState.items[menuState.sel]; if (x) { pick(x.it); } }
      // Back to the button that opened the menu (a tab, the model picker …); inline menus belong to the composer.
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); (anchor !== els.box && anchor.isConnected && typeof anchor.focus === 'function' && anchor.matches('button, [tabindex]') ? anchor : els.input).focus(); }
    };
    p.onkeydown = key;
    if (search) { search.oninput = () => render(search.value); search.onkeydown = key; search.focus(); } else { p.tabIndex = -1; list.tabIndex = -1; if (anchor !== els.box) { list.focus(); } menuA11y(anchor, search, list); }
  }
  document.addEventListener('mousedown', (e) => { if (menuState && e.target.isConnected && !els.popover.contains(e.target) && !e.target.closest('.pick, .ctxbtn, #btnHistory, #btnMcp')) { closeMenu(); } });
  // Escape closes the menu even when focus has left it (capture phase, so the approval card's Escape = Deny does not fire too).
  // The composer and the menu handle their own Escape.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuState && e.target !== els.input && !els.popover.contains(e.target)) { e.preventDefault(); closeMenu(); } }, true);
  // The popover is position:fixed from its anchor; scrolling or resizing would leave it floating detached.
  // Only the user's own scrolling closes a popover; auto-scroll while streaming must not.
  for (const ev of ['wheel', 'touchmove']) {
    els.messages.addEventListener(ev, () => { if (menuState) { closeMenu(); } }, { passive: true });
  }
  window.addEventListener('resize', () => { if (menuState) { closeMenu(); } });

  els.modeBtn.onclick = openModeMenu;
  els.modelBtn.onclick = () => { modelPickThen = null; openModelMenu(''); };
  /** Set by "Switch model" on a slow request: the picked model restarts the turn instead of only applying to the next one. */
  let modelPickThen = null;
  /** The model menu: starred models pinned on top, typing ranks by fuzzy match, unmatched text can be used as a model id. */
  function openModelMenu(query) {
    // Nothing to pick from: offer the three ways to get a model instead of an empty list.
    if (!state.models.length) {
      const look = () => { state.modelsRequested = true; state.modelsLoading = true; syncModel(); post({ type: 'detectModels' }); };
      openMenu(els.modelBtn, [
        { label: 'Set up a local model', desc: 'Start or install Ollama and download a starter coder model sized for this machine', icon: I.download, onPick: () => { state.modelsRequested = true; post({ type: 'autoSetupModels' }); toast('Setting up models…'); } },
        { label: 'Look for model servers again', desc: 'Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner', icon: I.refresh, onPick: look },
        { label: 'Use a cloud model…', desc: 'Add OpenAI, Claude, Gemini and others in Settings → Providers', icon: I.globe, onPick: () => post({ type: 'openSettings', section: 'providers' }) },
      ]);
      return;
    }
    const s = state.session; const cur = (s && s.model) || '';
    const autoName = modelName(autoModelId());
    const items = [{ label: 'Auto', desc: autoName ? `${state.defaultModel ? 'Default' : 'Best fit right now'}: ${autoName} · spreads parallel work to idle models` : 'Best available tool-capable model', icon: I.sparkle, selected: !cur, onPick: () => chooseModel('') }];
    const favs = new Set(state.favorites || []);
    const provName = (pid) => (state.providerNames && state.providerNames[pid]) || pid;
    const row = (m, group) => ({ group, label: m.name, desc: `${group === 'Starred' ? `${provName(m.providerId)} · ` : ''}${ctxLabel(m)}${m.supportsTools ? ' · tools' : ' · text tools'}${m.supportsVision ? ' · vision' : ''}`, tags: [m.remote && { text: 'cloud', title: 'Cloud model: prompts leave this machine' }, ctxCapped(m) && { text: 'capped', cls: 'capped', title: 'Limited by Settings → Models → Context window' }], icon: I.bot, selected: m.id === cur, starred: favs.has(m.id), onStar: (q) => toggleFavoriteModel(m.id, q), onPick: () => chooseModel(m.id) });
    for (const m of state.models) { if (favs.has(m.id)) { items.push(row(m, 'Starred')); } }
    for (const m of state.models) { if (!favs.has(m.id)) { items.push(row(m, provName(m.providerId))); } }
    items.push({ hr: true }, { label: 'Refresh models', icon: I.refresh, noSearch: true, onPick: () => { state.modelsRequested = true; post({ type: 'detectModels' }); toast('Refreshing models…'); } }, { label: 'Manage models…', icon: I.list, noSearch: true, onPick: () => post({ type: 'openSettings', section: 'models' }) }, { label: 'Configure providers…', icon: I.list, noSearch: true, onPick: () => post({ type: 'openSettings', section: 'providers' }) });
    // Text that matches no model: use it as a model id with a provider that serves ids it does not list.
    const onNoMatch = (q) => {
      if (!q || /\s/.test(q) || !state.session) { return []; }
      const curPid = (currentModel() || {}).providerId;
      const pids = (state.manualProviders || []).slice().sort((a, b) => (b === curPid) - (a === curPid));
      const prefixed = pids.find((pid) => q.startsWith(`${pid}/`) && q.length > pid.length + 1);
      return (prefixed ? [prefixed] : pids).map((pid) => {
        const id = prefixed ? q.slice(pid.length + 1) : q;
        return { label: `Use '${id}' as a model id with ${provName(pid)}`, desc: 'Added to the provider’s model list', icon: I.plus, onPick: () => { state.modelsRequested = true; post({ type: 'useModelId', sessionId: state.session.id, providerId: pid, modelId: id }); toast(`Using ${id} with ${provName(pid)}`); } };
      });
    };
    openMenu(els.modelBtn, items, { search: 'Search models or type a model id…', fuzzy: true, onNoMatch, query });
  }
  function toggleFavoriteModel(id, q) {
    const favs = new Set(state.favorites || []);
    if (favs.has(id)) { favs.delete(id); } else { favs.add(id); }
    state.favorites = [...favs];
    post({ type: 'toggleFavoriteModel', model: id });
    openModelMenu(q);
  }
  function chooseModel(id) { if (!state.session) { return; } const then = modelPickThen; modelPickThen = null; if (then && then(id)) { return; } state.rerouted.delete(state.session.id); state.session.model = id; syncModel(); updateCtx(); post({ type: 'setModel', sessionId: state.session.id, model: id, makeDefault: false }); }
  // ------------------------------------------------------------------ thinking level for this chat
  const THINK_LEVELS = {
    auto: { label: 'Auto', desc: 'High for Plan and Debug, medium for the agent, low for Ask and subagents' },
    off: { label: 'Off', desc: 'Answer right away, no reasoning pass' },
    low: { label: 'Low', desc: 'A short reasoning pass' },
    medium: { label: 'Medium', desc: 'Balanced reasoning for most tasks' },
    high: { label: 'High', desc: 'Deeper reasoning; slower and uses more tokens' },
    max: { label: 'Max', desc: 'The most the model offers (Claude’s largest budget)' },
  };
  const THINK_GLOBAL = { on: 'On', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', off: 'Off', auto: 'Auto' };
  /** The chip shows only for models that report reasoning; the chat's own level, else the global setting. */
  function syncThink() {
    const btn = document.getElementById('thinkBtn'); if (!btn) { return; }
    const m = currentModel(); const own = state.session && state.session.think;
    btn.classList.toggle('hidden', !(m && m.supportsThinking));
    btn.classList.toggle('on', !!own);
    document.getElementById('thinkLabel').textContent = `Think: ${own ? (THINK_LEVELS[own] || THINK_LEVELS.auto).label : THINK_GLOBAL[state.thinking || 'auto'] || 'Auto'}`;
    btn.title = own ? `Thinking in this chat: ${THINK_LEVELS[own] ? THINK_LEVELS[own].label : own} (overrides the global setting)` : `Thinking follows the global setting (${THINK_GLOBAL[state.thinking || 'auto'] || 'Auto'})`;
  }
  function setThink(level) {
    if (!state.session) { return; }
    state.session.think = level || undefined; syncThink();
    post({ type: 'setThink', sessionId: state.session.id, think: level || null });
  }
  document.getElementById('thinkBtn').onclick = () => {
    const own = state.session && state.session.think;
    const items = [{ label: `Inherit global (${THINK_GLOBAL[state.thinking || 'auto'] || 'Auto'})`, desc: 'Follow Settings → Models → Extended thinking', icon: I.sparkle, selected: !own, onPick: () => setThink(null) }];
    for (const [k, v] of Object.entries(THINK_LEVELS)) { items.push({ group: 'This chat', label: v.label, desc: v.desc, icon: k === 'off' ? I.x : I.brain, selected: own === k, onPick: () => setThink(k) }); }
    openMenu(document.getElementById('thinkBtn'), items);
  };
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
  // Rules, commands, hooks and skills: opens Settings → Customize.
  const improveBtn = document.getElementById('btnImprove');
  if (improveBtn) {
    const rulesBtn = el('button', 'ib', I.rules);
    rulesBtn.id = 'btnRules'; rulesBtn.title = 'Rules, commands, hooks and skills — switch them on or off, edit or create them'; rulesBtn.setAttribute('aria-label', 'Customize rules, commands, hooks and skills');
    rulesBtn.onclick = () => post({ type: 'openSettings', section: 'customize' });
    improveBtn.before(rulesBtn);
  }
  // MCP servers: a popover with a switch, status dot and restart per server, and the total tool count (context cost).
  const MCP_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2"/></svg>';
  const SLASH_GROUPS = { Chat: { order: 0, icon: I.bot }, 'More modes': { order: 0.5, icon: I.sparkle }, 'Plan & delegate': { order: 1, icon: I.plan }, Info: { order: 2, icon: I.ask }, Custom: { order: 3, icon: I.sparkle }, Skills: { order: 4, icon: I.book }, MCP: { order: 5, icon: MCP_ICON } };
  const GEAR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>';
  let mcpBtn = null;
  function syncMcp() {
    const list = state.mcp || [];
    if (!mcpBtn && improveBtn && list.length) {
      mcpBtn = el('button', 'ib mcp-btn', `${MCP_ICON}<span class="mcp-n"></span>`); mcpBtn.id = 'btnMcp'; mcpBtn.setAttribute('aria-haspopup', 'true');
      mcpBtn.onclick = () => (els.popover.querySelector('.mcp-pop') ? closeMenu() : openMcp());
      improveBtn.before(mcpBtn);
    }
    if (!mcpBtn) { return; }
    mcpBtn.classList.toggle('hidden', !list.length);
    const total = list.reduce((n, s) => n + (s.state === 'connected' ? s.tools : 0), 0);
    const bad = list.some((s) => s.state === 'error');
    mcpBtn.classList.toggle('warn', bad);
    mcpBtn.querySelector('.mcp-n').textContent = total ? String(total) : '';
    mcpBtn.title = `MCP servers: ${list.filter((s) => s.state === 'connected').length} of ${list.length} connected · ${total} tool${total === 1 ? '' : 's'} offered to the model${bad ? ' · some failed to start' : ''}`;
    mcpBtn.setAttribute('aria-label', mcpBtn.title);
    if (els.popover.querySelector('.mcp-pop')) { renderMcp(); }
  }
  function openMcp() {
    const p = els.popover; p.innerHTML = ''; p.classList.remove('hidden');
    menuState = { items: [], sel: 0 };
    p.appendChild(el('div', 'mcp-pop'));
    renderMcp();
    post({ type: 'mcpStatus' });
    placePopover(mcpBtn); p.tabIndex = -1; p.focus();
    p.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); els.input.focus(); } };
  }
  function renderMcp() {
    const box = els.popover.querySelector('.mcp-pop'); if (!box) { return; }
    const list = state.mcp || [];
    const total = list.reduce((n, s) => n + (s.state === 'connected' ? s.tools : 0), 0);
    const label = { connected: (s) => `${s.tools} tool${s.tools === 1 ? '' : 's'}`, connecting: () => 'connecting…', restarting: () => 'restarting…', error: () => 'failed', disabled: () => 'off' };
    box.innerHTML = `<div class="mcp-head"><b>MCP servers</b><span>${total} tool${total === 1 ? '' : 's'} in context</span></div>`
      + list.map((s) => `<div class="mcp-row" data-name="${esc(s.name)}"><span class="mcp-dot ${esc(s.state)}"></span><span class="mcp-name" title="${esc(s.error || s.name)}">${esc(s.name)}</span><span class="mcp-st">${esc((label[s.state] || (() => s.state))(s))}</span>`
        + `<button class="ib" data-a="restart" title="Restart ${esc(s.name)}" ${s.state === 'disabled' ? 'disabled' : ''}>${I.refresh}</button>`
        + `<button class="mcp-sw ${s.state === 'disabled' ? '' : 'on'}" role="switch" aria-checked="${s.state !== 'disabled'}" aria-label="${esc(s.name)} on or off" data-a="toggle" ${s.source === 'plugin' ? 'disabled title="Defined by a plugin: switch the plugin off instead"' : ''}><i></i></button></div>`).join('')
      + `<div class="mcp-foot"><button class="btn ghost" data-a="settings">${GEAR_ICON}MCP settings…</button></div>`;
    box.onclick = (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) { return; }
      const row = b.closest('.mcp-row'); const name = row && row.dataset.name; const s = name && list.find((x) => x.name === name);
      if (b.dataset.a === 'settings') { closeMenu(); post({ type: 'openSettings', section: 'mcp' }); }
      else if (b.dataset.a === 'restart' && s) { s.state = 'restarting'; renderMcp(); post({ type: 'mcpRestart', name }); }
      else if (b.dataset.a === 'toggle' && s) { const enabled = s.state === 'disabled'; s.state = enabled ? 'connecting' : 'disabled'; renderMcp(); post({ type: 'mcpToggle', name, enabled }); }
    };
  }
  els.skillsBtn.onclick = () => openSkillsMenu(els.skillsBtn);
  function openSkillsMenu(anchor) {
    const ss = sessionSkills(); const pinned = new Set(ss.pinned || []); const g = state.skillsMode || 'auto';
    const items = [
      { label: `Use global setting (${SKILL_MODES[g].label})`, desc: 'Follow Settings → Skills; changing it there changes this chat too', icon: I.sparkle, selected: !ss.mode, onPick: () => setSkills({ mode: undefined }) },
      ...Object.entries(SKILL_MODES).map(([k, m]) => ({ group: 'Override for this chat', label: m.label, desc: m.desc, icon: k === 'off' ? I.x : I.book, selected: ss.mode === k, onPick: () => setSkills({ mode: k }) })),
    ];
    if (state.skills.length) {
      items.push({ hr: true });
      for (const s of state.skills) {
        const on = pinned.has(s.name);
        items.push({ group: 'Pin to every request', label: s.name, desc: s.description, icon: I.book, selected: on, tag: on ? 'pinned' : undefined, onPick: () => { const next = new Set(pinned); on ? next.delete(s.name) : next.add(s.name); setSkills({ pinned: [...next] }); } });
      }
    }
    items.push({ hr: true }, { label: 'Manage skills…', desc: 'Install from the registry, enable / disable, remove', icon: I.list, onPick: () => post({ type: 'openSettings', section: 'skills' }) });
    openMenu(anchor, items, { search: state.skills.length > 6 ? 'Search skills…' : undefined, label: 'Skills for this chat' });
  }
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
  // The composer's hint row (empty chats only): @ opens the context menu, # attaches the project tree, / starts a command.
  if (els.hints) {
    els.hints.onclick = (e) => {
      const b = e.target.closest('[data-h]'); if (!b) { return; }
      if (b.dataset.h === '@') { openContextMenu(); }
      else if (b.dataset.h === '#') { addAttachment('workspace'); toast('Attached the project file tree (@workspace)'); }
      else { els.input.value = '/'; els.input.focus(); els.input.selectionStart = els.input.selectionEnd = 1; els.input.dispatchEvent(new Event('input')); }
    };
  }
  // The welcome strip says when the machine is offline: cloud models and web tools will fail, local models still work.
  state.offline = navigator.onLine === false;
  for (const ev of ['online', 'offline']) { window.addEventListener(ev, () => { state.offline = navigator.onLine === false; renderCtxStrip(); }); }
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
  // Improve prompt: the model rewrites the draft in place (streamed), the user reviews it and sends; ⌘Z brings the original back.
  function improveTitle() { return `Improve prompt — rewrite the draft into a precise request using the open file and project (${kb('Mod+I')}). Nothing is sent.`; }
  let improving = null; let improveUndo = null;
  function improvePrompt() {
    if (!state.session) { return; }
    if (improving) { post({ type: 'improvePrompt', sessionId: improving.sid, text: '', cancel: true }); return; }
    const text = els.input.value.trim();
    if (!text) { toast('Type a request first, then improve it'); els.input.focus(); return; }
    improving = { sid: state.session.id, original: els.input.value, text: '' }; improveUndo = null;
    els.improve.classList.add('busy'); els.improve.title = 'Improving… click to cancel'; els.input.readOnly = true; els.box.classList.add('improving');
    post({ type: 'improvePrompt', sessionId: improving.sid, text });
  }
  function improvedPrompt(m) {
    if (!improving || m.sessionId !== improving.sid) { return; }
    const onTab = state.session && state.session.id === improving.sid;
    if (m.delta) { improving.text += m.delta; if (onTab) { els.input.value = improving.text.replace(/^\s+/, ''); autoGrow(); els.input.scrollTop = els.input.scrollHeight; } return; }
    if (!m.done) { return; }
    const { original } = improving; improving = null;
    els.improve.classList.remove('busy'); els.improve.title = improveTitle();
    els.input.readOnly = false; els.box.classList.remove('improving');
    if (!onTab) {
      const d = state.drafts.get(m.sessionId); const text = m.error || !m.text ? original : m.text;
      state.drafts.set(m.sessionId, d ? { ...d, text } : { text, attachments: [], images: [] });
      return;
    }
    if (m.error || !m.text) {
      els.input.value = original;
      if (m.error && m.error !== 'cancelled') { toast(m.error, 'error'); }
    } else {
      els.input.value = m.text; improveUndo = { original, improved: m.text };
      toast(`Prompt improved — review it, then send. ${kb('Mod+Z')} restores yours.`);
    }
    autoGrow(); updateSendEnabled(); els.input.focus();
  }
  if (els.improve) { els.improve.onclick = improvePrompt; }
  // Narrow composers (≤360 px) fold Skills, Rules and Improve prompt into one menu so the model name stays readable.
  if (els.btnComposerMore) {
    els.btnComposerMore.onclick = () => {
      const ss = sessionSkills(); const pinned = (ss.pinned || []).length;
      openMenu(els.btnComposerMore, [
        { label: `Skills: ${pinned ? `${pinned} pinned` : SKILL_MODES[effectiveSkillsMode()].label}`, desc: 'Skill lookups and pinned skills for this chat', icon: I.book, onPick: () => openSkillsMenu(els.btnComposerMore) },
        { label: 'Customize rules…', desc: 'Rules, commands, hooks and skills', icon: I.rules, onPick: () => post({ type: 'openSettings', section: 'customize' }) },
        { label: improving ? 'Cancel improving' : `Improve prompt (${kb('Mod+I')})`, desc: 'Rewrites the draft into a precise request. Nothing is sent', icon: I.sparkle, onPick: improvePrompt },
      ], { label: 'More composer actions' });
    };
  }
  els.image.onclick = () => visionBlocked() ? toast(els.image.title, 'error') : openMenu(els.image, [
    { label: 'Image file…', desc: 'PNG, JPEG, GIF or WebP · or paste / drop onto the composer', icon: I.image, onPick: () => post({ type: 'pickImage' }) },
    { hr: true },
    ...screenshotItems(),
  ]);
  els.ctx.onclick = () => openCtxConfirm();

  // inline '/' and '@' autocomplete reuse the popover
  function tokenAt() { const v = els.input.value.slice(0, els.input.selectionStart); const at = /(?:^|\s)@("[^"\n]*|[\w./-]*)$/.exec(v); if (at) { return { kind: '@', tok: at[1].replace(/^"/, ''), quoted: at[1].startsWith('"') }; } if (/^\/\S*$/.test(v) && !v.includes('\n')) { return { kind: '/', tok: v }; } return null; }
  function showInlineMenu(t) {
    if (t.kind === '/') {
      const fill = (v) => { els.input.value = v; els.input.focus(); updateSendEnabled(); };
      const items = SLASH.filter(([c]) => c.startsWith(t.tok) || (c.endsWith(' ') && t.tok.startsWith(c.trim() + ' '))).map(([c, d, g]) => ({ group: g, label: c.trim(), desc: d, onPick: () => { fill(c); if (!c.endsWith(' ')) { sendCurrent(); } } }))
        // Custom commands from .claude/commands, .localpilot/commands and plugins.
        .concat((state.commands || []).filter((c) => c.invoke.startsWith(t.tok) || t.tok.startsWith(c.invoke + ' ')).map((c) => ({ group: 'Custom', label: `${c.invoke}${c.argumentHint ? ' ' + c.argumentHint : ''}`, desc: `${c.description || ''}${c.source ? ` · ${c.source}` : ''}`, onPick: () => fill(`${c.invoke} `) })))
        // Enabled skills run directly as /<skill-name> <task>.
        .concat(!t.tok.includes(' ') ? state.skills.filter((s) => `/${s.name}`.toLowerCase().startsWith(t.tok.toLowerCase())).map((s) => ({ group: 'Skills', label: `/${s.name}`, desc: s.description, onPick: () => fill(`/${s.name} `) })) : [])
        // MCP prompts of the connected servers: /mcp:<server>:<prompt> args…
        .concat((state.mcp || []).flatMap((sv) => sv.prompts || []).filter((pr) => pr.invoke.startsWith(t.tok) || t.tok.startsWith(pr.invoke + ' ')).map((pr) => ({ group: 'MCP', label: pr.usage, desc: pr.description || '', onPick: () => fill(`${pr.invoke} `) })))
        .concat(t.tok.startsWith('/skill ') ? state.skills.filter((s) => `/skill ${s.name}`.startsWith(t.tok.trimEnd())).map((s) => ({ group: 'Skills', label: `/skill ${s.name}`, desc: s.description, onPick: () => fill(`/skill ${s.name} `) })) : [])
        .concat(t.tok.startsWith('/agent ') ? state.agents.filter((a) => `/agent ${a.name}`.startsWith(t.tok.trimEnd())).map((a) => ({ group: 'Plan & delegate', label: `/agent ${a.name}`, desc: a.description, onPick: () => fill(`/agent ${a.name} `) })) : [])
        // One heading per group, in a fixed order; each group has its own icon on the heading and its rows.
        .map((it, n) => ({ ...it, n, icon: (/^\/mode (\w+)$/.test(it.label) && (MODES[it.label.slice(6)] || SPECIALISTS[it.label.slice(6)]) || SLASH_GROUPS[it.group]).icon, groupIcon: SLASH_GROUPS[it.group].icon }))
        .sort((a, b) => SLASH_GROUPS[a.group].order - SLASH_GROUPS[b.group].order || a.n - b.n);
      if (!items.length) { return closeMenu(); }
      openMenu(els.box, items, { inline: true }); els.input.focus();
    } else {
      if (!state.openFiles.length) { post({ type: 'requestOpenFiles' }); }
      const q = t.tok.toLowerCase();
      if (mentionHits.asked !== t.tok) { mentionHits.asked = t.tok; post({ type: 'mentionSearch', query: t.tok }); }
      // Until the host answers this query, the previous answer narrowed by the new text stands in.
      const hits = mentionHits.query === t.tok ? mentionHits.items : mentionHits.items.filter((h) => subseq(q, h.desc));
      const files = hits.length ? hits.map((h) => ({ label: h.label, labelHtml: hlHtml(h.label, h.labelHl), desc: h.desc, descHtml: hlHtml(h.desc, h.hl), icon: h.kind === 'folder' ? I.folder : I.file, tag: h.open ? 'open' : h.recent ? 'recent' : '', onPick: () => applyMention(h.ref) }))
        : state.openFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f.split('/').pop(), desc: f, icon: I.file, onPick: () => applyMention(f) }));
      // Commits whose message matches (or the one a typed hash names) follow the files.
      const commits = mentionHits.query === t.tok && !t.quoted ? mentionHits.commits.map((c) => ({ label: `Commit ${c.sha}`, desc: c.subject, icon: I.git, onPick: () => applyMention(c.sha) })) : [];
      const items = (t.quoted ? [] : MENTIONS.filter(([n]) => n.startsWith(q)).map(([n, d, ic]) => ({ label: `@${n}`, desc: d, icon: ic, onPick: () => applyMention(n) }))).concat(files, commits);
      // The menu stays open while the host searches and when nothing matches, so the @ never just goes quiet.
      if (mentionHits.query !== t.tok) { items.push({ note: true, spin: true, label: 'Searching files…' }); }
      else if (!files.length && !commits.length) {
        items.push({ note: true, label: t.tok ? `No files match “${t.tok}”` : 'No files in this workspace' },
          { label: 'Browse files…', desc: 'Pick files to attach', icon: I.folder, onPick: () => { dropMentionToken(); post({ type: 'pickAttachment' }); } });
      }
      openMenu(els.box, items, { inline: true }); els.input.focus();
    }
  }
  // Workspace-wide @ search: the host ranks its file index (open editors, then recent attachments, then fuzzy score).
  const mentionHits = { asked: null, query: null, items: [], commits: [] };
  function subseq(q, s) { let i = 0; const l = s.toLowerCase(); for (let k = 0; k < l.length && i < q.length; k++) { if (l[k] === q[i]) { i++; } } return i === q.length; }
  function hlHtml(s, pos) { const on = new Set(pos || []); return s.split('').map((c, i) => (on.has(i) ? `<b class="hl">${esc(c)}</b>` : esc(c))).join(''); }
  const STAR_ICON = '<svg viewBox="0 0 16 16"><path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.76.7 3.93L8 11.17l-3.53 1.87.7-3.93L2.3 6.35l3.95-.55z"/></svg>';
  /** Mirrors fuzzyMatch in src/context/mentionSearch.ts: a case-insensitive subsequence match favouring word starts and runs. */
  function fuzzyMatch(query, text) {
    const q = String(query).toLowerCase(); if (!q) { return { score: 0, positions: [] }; }
    const t = String(text).toLowerCase(); let qi = 0; let end = -1;
    const isSep = (c) => '/\\._- :'.includes(c);
    const boundary = (i) => i === 0 || isSep(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i])) || (/[a-zA-Z]/.test(text[i - 1]) && /[0-9]/.test(text[i]));
    for (let i = 0; i < t.length; i++) { if (t[i] === q[qi] && ++qi === q.length) { end = i; break; } }
    if (end < 0) { return null; }
    qi = q.length - 1; let start = end;
    for (let i = end; i >= 0; i--) { if (t[i] === q[qi]) { start = i; if (--qi < 0) { break; } } }
    const fits = (from, at) => { let k = from; for (let i = at; i <= end && k < q.length; i++) { if (t[i] === q[k]) { k++; } } return k === q.length; };
    const positions = []; qi = 0;
    for (let i = start; i <= end && qi < q.length; i++) {
      if (t[i] !== q[qi]) { continue; }
      if (!(positions.length && positions[positions.length - 1] === i - 1) && !boundary(i) && q.length - qi <= end - i) {
        const later = t.indexOf(q[qi], i + 1);
        if (later > 0 && later <= end && boundary(later) && fits(qi + 1, later + 1)) { continue; }
      }
      positions.push(i); qi++;
    }
    if (qi < q.length) { return null; }
    let score = 0;
    positions.forEach((i, k) => { score += 1 + (boundary(i) ? 8 : 0); if (k > 0) { const gap = i - positions[k - 1] - 1; score += gap === 0 ? 6 : -Math.min(gap, 6); } if (text[i] === query[k]) { score += 0.5; } });
    return { score: score - Math.min(positions[0], 10) * 0.5, positions };
  }
  function mentionResults(m) {
    if (m.query !== mentionHits.asked) { return; }
    mentionHits.query = m.query; mentionHits.items = m.items || []; mentionHits.commits = m.commits || [];
    const t = tokenAt();
    if (t && t.kind === '@' && t.tok === m.query && document.activeElement === els.input) { showInlineMenu(t); }
  }
  /** Removes the half-typed `@token` before the caret (its file is being picked another way). */
  function dropMentionToken() { const pos = els.input.selectionStart; const before = els.input.value.slice(0, pos).replace(/@(?:"[^"\n]*|[\w./-]*)$/, ''); els.input.value = before + els.input.value.slice(pos); els.input.selectionStart = els.input.selectionEnd = before.length; updateSendEnabled(); }
  /** Paths outside the plain `@path` alphabet (spaces, brackets …) are quoted: `@"docs/my file.md"`. */
  function applyMention(name) { const pos = els.input.selectionStart; const before = els.input.value.slice(0, pos).replace(/@(?:"[^"\n]*|[\w./-]*)$/, ''); const token = /^[\w./-]+$/.test(name) ? name : `"${name}"`; els.input.value = `${before}@${token} ${els.input.value.slice(pos)}`; els.input.selectionStart = els.input.selectionEnd = before.length + token.length + 2; closeMenu(); els.input.focus(); updateSendEnabled(); }
  /** `@path`, `@path#L3-L9`, `@"path with spaces"`, `@https://…` and `@<commit>` in a draft; also what the composer highlights. */
  const MENTION_RE = /(^|\s)(@(?:"([^"\n]+)"|(https?:\/\/[^\s"<>]*[^\s"<>.,;:!?)\]]|[\w./-]+(?:#L\d+(?:-L?\d+)?|#page=\d+(?:-\d+)?)?)))/g;
  function mentionRefs(text) { return [...text.matchAll(MENTION_RE)].map((m) => m[3] || m[4]); }
  /** Opens what a sent message's context chip names: a file, the Problems panel, the terminal, a URL. */
  function openMentionRef(ref, line) {
    if (/^https?:\/\//i.test(ref)) { post({ type: 'openExternal', url: ref }); return; }
    if (ref.startsWith('@')) { post({ type: 'openMention', ref }); return; }
    post({ type: 'openFile', path: ref, line: line ? Number(line) : undefined, sessionId: state.session ? state.session.id : undefined });
  }
  /** A sent message's context chip; `a` is a path (`file#L3-L9`), a special mention (`problems`, `@git`) or a URL. */
  function attChip(a) {
    const n = String(a).replace(/^@/, '');
    // A commit chip opens Source Control; its text stays the hash.
    if (/^[0-9a-f]{7,40}$/i.test(n)) { return `<span class="chip link" data-ref="@git" title="Commit ${esc(n)}">${I.git}<span>${esc(n)}</span></span>`; }
    const special = MENTIONS.some(([k]) => k === n) || n === 'directory';
    const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|#page=\d+(?:-\d+)?)?$/.exec(a);
    const ref = special ? `@${n}` : /^https?:\/\//i.test(a) ? a : m[1];
    const open = ref !== '@directory';
    return `<span class="chip${open ? ' link' : ''}"${open ? ` data-ref="${esc(ref)}"${!special && m[2] ? ` data-line="${m[2]}"` : ''} title="Open ${esc(n)}"` : ''}>${special ? I.list : I.file}<span>${esc(special ? ref : a)}</span></span>`;
  }
  els.messages.addEventListener('click', (e) => { const c = e.target.closest && e.target.closest('.turn.user .att .chip[data-ref]'); if (c) { openMentionRef(c.dataset.ref, c.dataset.line); } });

  // ------------------------------------------------------------------ input handling
  function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = Math.min(240, els.input.scrollHeight) + 'px'; }
  // Mentions in the draft are highlighted by a mirror of the text drawn behind the transparent textarea. Programmatic
  // `value` writes (drafts, history, improve prompt …) fire no input event, so the setter is wrapped as well.
  const mirror = el('div', 'mirror'); mirror.setAttribute('aria-hidden', 'true');
  const inwrap = el('div', 'inwrap'); els.input.parentNode.insertBefore(inwrap, els.input); inwrap.append(mirror, els.input);
  function syncMirror() {
    const v = els.input.value; let html = ''; let at = 0;
    for (const m of v.matchAll(MENTION_RE)) { const s = m.index + m[1].length; html += `${esc(v.slice(at, s))}<mark>${esc(m[2])}</mark>`; at = s + m[2].length; }
    mirror.innerHTML = `${html}${esc(v.slice(at))}\n`;
    mirror.style.right = `${els.input.offsetWidth - els.input.clientWidth}px`;
    mirror.scrollTop = els.input.scrollTop;
  }
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  Object.defineProperty(els.input, 'value', { configurable: true, get() { return valueProp.get.call(this); }, set(v) { valueProp.set.call(this, v); syncMirror(); } });
  syncMirror();
  els.input.addEventListener('input', syncMirror);
  els.input.addEventListener('scroll', () => { mirror.scrollTop = els.input.scrollTop; });
  /** ⌘/Ctrl+Shift+Enter: start the draft as a new agent in its own tab, leaving the current chat (even a running one) untouched. */
  function sendInNewTab() {
    const text = quoted(els.input.value.trim());
    if (!text) { return; }
    const atRefs = mentionRefs(text);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    if (tooManyAttachments(attachments)) { return; }
    const images = state.images.map((i) => i.data);
    post({ type: 'newSession', mode: (state.session && state.session.mode) || 'agent', text, attachments, images: images.length ? images : undefined });
    state.history.unshift(text); state.history = state.history.slice(0, 50); state.histIdx = -1;
    els.input.value = ''; state.attachments = []; state.starterRefs = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); clearQuote();
    toast('Started in a new tab');
  }
  /** Queue the composer text for the running agent in this tab; the host echoes it back as a "queued" row. */
  function steerCurrent() {
    const text = quoted(els.input.value.trim());
    if ((!text && !state.images.length) || !state.session) { return; }
    const atRefs = mentionRefs(text);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    if (tooManyAttachments(attachments)) { return; }
    const images = state.images.map((i) => i.data);
    post({ type: 'steer', sessionId: state.session.id, text: text || 'Consider the attached image(s).', attachments, images: images.length ? images : undefined });
    state.history.unshift(text); state.history = state.history.slice(0, 50); state.histIdx = -1;
    state.drafts.delete(state.session.id);
    els.input.value = ''; state.attachments = []; state.starterRefs = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); clearQuote(); els.input.focus();
  }
  /** A message typed while the agent was busy: a compact row inside the assistant's turn, "queued" until the loop takes it. */
  function steerRow(content, images, id, queued, fixes) {
    const d = el('div', `steer ${queued ? 'queued' : ''}`);
    if (id) { d.dataset.steerId = id; }
    d.innerHTML = `<span class="ico">${I.reply}</span><div class="txt"></div><span class="badge">${queued ? 'queued' : 'added'}</span>`;
    d.querySelector('.txt').textContent = String(content || '').replace(/\n\n\[\d+ images? attached\]$/, '');
    if (images && images.length) { const im = el('div', 'imgs', images.map((x) => `<img src="${x.startsWith('data:') ? x : `data:image/png;base64,${x}`}" alt="">`).join('')); d.appendChild(im); }
    if (fixes && fixes.length) { d.appendChild(correctionNote(fixes)); }
    return d;
  }
  /** "Send after this turn": the host keeps it in the chat's queue and starts a new turn with it when the run ends. */
  function queueCurrent() {
    const text = quoted(els.input.value.trim());
    if ((!text && !state.images.length) || !state.session) { return; }
    const atRefs = mentionRefs(text);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    if (tooManyAttachments(attachments)) { return; }
    const images = state.images.map((i) => i.data);
    post({ type: 'queueAfterTurn', sessionId: state.session.id, text: text || 'Describe what you see in the attached image(s).', attachments, images: images.length ? images : undefined });
    state.history.unshift(text); state.history = state.history.slice(0, 50); state.histIdx = -1;
    state.drafts.delete(state.session.id);
    els.input.value = ''; state.attachments = []; state.starterRefs = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); clearQuote(); els.input.focus();
  }
  // Queue banner above the input: pending steers of the running turn and messages waiting for it to end (sessionId → { items, label }).
  const queues = new Map();
  let queueBar = null;
  function renderQueue() {
    const q = state.session && queues.get(state.session.id);
    if (!q || !q.items.length) { if (queueBar) { queueBar.classList.add('hidden'); } return; }
    if (!queueBar) { queueBar = el('div', 'queuebar'); queueBar.setAttribute('aria-label', 'Queued messages'); els.status.parentNode.insertBefore(queueBar, els.status); }
    queueBar.classList.remove('hidden');
    queueBar.innerHTML = `<div class="qhead">${I.list}<span></span></div>`;
    queueBar.querySelector('.qhead span').textContent = q.label;
    for (const it of q.items) {
      const row = el('div', `qrow ${it.kind}`, `<span class="qkind">${it.kind === 'steer' ? 'steering' : 'next turn'}</span><span class="qtxt"></span><button class="ib" data-q="edit" title="Edit — back into the composer">${I.edit}</button><button class="ib" data-q="cancel" title="Cancel">${I.x}</button>`);
      row.querySelector('.qtxt').textContent = it.text.replace(/\s+/g, ' ');
      row.querySelector('.qtxt').title = it.text;
      row.querySelector('[data-q="edit"]').onclick = () => post({ type: 'cancelQueued', sessionId: state.session.id, id: it.id, edit: true });
      row.querySelector('[data-q="cancel"]').onclick = () => post({ type: 'cancelQueued', sessionId: state.session.id, id: it.id });
      queueBar.appendChild(row);
    }
  }
  // Quote selection in reply: selecting text in an assistant message offers "Quote"; the quote (per chat) is previewed
  // above the input and sent in front of the message as a "> " block.
  const quotes = new Map();
  let quotePrev = null; let quoteTimer = 0;
  const quoteBtn = el('button', 'quotebtn hidden', `${I.reply}<span>Quote</span>`);
  quoteBtn.type = 'button'; quoteBtn.title = 'Quote the selection in your reply';
  $('app').appendChild(quoteBtn);
  function replySelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { return null; }
    const r = sel.getRangeAt(0); const c = r.commonAncestorContainer;
    const node = c.nodeType === 1 ? c : c.parentElement;
    const turn = node && node.closest('.turn.assistant');
    const text = String(sel).trim();
    return turn && els.messages.contains(turn) && text ? { text, rect: r.getBoundingClientRect() } : null;
  }
  function syncQuoteBtn() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => {
      const s = state.session && replySelection();
      const mr = els.messages.getBoundingClientRect();
      if (!s || s.rect.bottom < mr.top || s.rect.top > mr.bottom) { quoteBtn.classList.add('hidden'); return; }
      quoteBtn.classList.remove('hidden');
      const w = quoteBtn.offsetWidth || 72;
      quoteBtn.style.left = `${Math.round(Math.max(4, Math.min(window.innerWidth - w - 4, s.rect.left + s.rect.width / 2 - w / 2)))}px`;
      quoteBtn.style.top = `${Math.round(Math.max(mr.top + 2, s.rect.top - 32))}px`;
    }, 120);
  }
  document.addEventListener('selectionchange', syncQuoteBtn);
  els.messages.addEventListener('scroll', syncQuoteBtn, { passive: true });
  quoteBtn.addEventListener('mousedown', (e) => e.preventDefault());
  quoteBtn.onclick = () => {
    const s = replySelection(); if (!s || !state.session) { return; }
    quotes.set(state.session.id, s.text.length > 4000 ? `${s.text.slice(0, 4000)}…` : s.text);
    window.getSelection().removeAllRanges(); quoteBtn.classList.add('hidden');
    renderQuote(); els.input.focus();
  };
  function renderQuote() {
    const q = state.session && quotes.get(state.session.id);
    if (!q) { if (quotePrev) { quotePrev.classList.add('hidden'); } return; }
    if (!quotePrev) { quotePrev = el('div', 'quoteprev'); els.box.insertBefore(quotePrev, els.input); }
    quotePrev.classList.remove('hidden');
    quotePrev.innerHTML = `<div class="qtxt"></div><button class="ib" type="button" title="Remove quote" aria-label="Remove quote">${I.x}</button>`;
    quotePrev.querySelector('.qtxt').textContent = q;
    quotePrev.querySelector('button').onclick = () => { if (state.session) { quotes.delete(state.session.id); } renderQuote(); els.input.focus(); };
  }
  /** The composer text with the chat's pending quote in front as a Markdown blockquote (slash commands go as typed). */
  function quoted(text) {
    const q = state.session && quotes.get(state.session.id);
    if (!q || text.startsWith('/')) { return text; }
    const block = q.split('\n').map((l) => `> ${l}`.trimEnd()).join('\n');
    return text ? `${block}\n\n${text}` : block;
  }
  function clearQuote() { if (state.session) { quotes.delete(state.session.id); } renderQuote(); }
  /** /clear asks first, in a row above the composer: Enter or Clear confirms, Escape or Cancel keeps the chat. */
  function confirmClear() {
    closeMenu();
    const old = document.querySelector('.confirm-row'); if (old) { old.querySelector('[data-a="clear"]').focus(); return; }
    const row = el('div', 'confirm-row', `${I.warn}<span class="msg">Clear this chat? Messages are removed; files are not touched.</span><span class="acts"><button class="btn sm" data-a="cancel">Cancel</button><button class="btn sm danger" data-a="clear">Clear</button></span>`);
    row.setAttribute('role', 'alertdialog'); row.setAttribute('aria-label', 'Clear this chat?');
    const done = (clear) => { row.remove(); if (clear && /^\/clear\s*$/i.test(els.input.value.trim())) { sendCurrent(false, { confirmed: true }); } else { els.input.focus(); } };
    row.onclick = (e) => { const b = e.target.closest('[data-a]'); if (b) { done(b.dataset.a === 'clear'); } };
    row.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    els.box.parentNode.insertBefore(row, els.box);
    row.querySelector('[data-a="clear"]').focus();
  }
  /** `opts.modeOverride`: an empty-chat suggestion runs that one turn in Ask or Agent mode; `opts.confirmed` skips the /clear confirm. */
  function sendCurrent(fromSuggestion, opts = {}) {
    if (/^\/clear\s*$/i.test(els.input.value.trim()) && !opts.confirmed && state.session && state.session.messages.length) { confirmClear(); return; }
    if (improving && state.session && improving.sid === state.session.id) { toast('Still improving the prompt — wait for it, or click the sparkle to cancel'); return; }
    const text = quoted(els.input.value.trim());
    if ((!text && !state.images.length) || !state.session) { return; }
    if (state.running.has(state.session.id) || state.pendingSend.has(state.session.id)) {
      const p = state.paused.get(state.session.id);
      // Paused: the message is plainly meant for this agent. Running: ask, since a new tab is just as likely.
      if (p && p.paused) { steerCurrent(); return; }
      openMenu(els.box, [{ label: 'Add to this agent', desc: 'Queued and read at its next step — it keeps working', icon: I.agent, onPick: steerCurrent }, { label: 'Send after this turn', desc: 'Starts a new turn here when this one ends', icon: I.list, onPick: queueCurrent }, { label: 'Send in a new tab', desc: `Starts another agent in parallel (${kb('Mod+Shift+Enter')})`, icon: I.sparkle, onPick: sendInNewTab }, { label: 'Stop this agent first', desc: 'Then send here', icon: I.stop, onPick: () => post({ type: 'stop', sessionId: state.session.id }) }, { label: 'Cancel', icon: I.x }]); els.input.focus(); return;
    }
    const atRefs = mentionRefs(text);
    const attachments = [...new Set([...state.attachments, ...atRefs])];
    if (tooManyAttachments(attachments)) { return; }
    const images = state.images.map((i) => i.data);
    const finalText = text || 'Describe what you see in the attached image(s).';
    post({ type: 'send', sessionId: state.session.id, text: finalText, attachments, images: images.length ? images : undefined, ...(opts.modeOverride ? { modeOverride: opts.modeOverride } : {}) });
    if (state.revising === state.session.id) { state.revising = null; syncPlaceholder(); }
    state.history.unshift(finalText); state.history = state.history.slice(0, 50); state.histIdx = -1;
    const empty = els.messages.querySelector('.empty'); if (empty) { empty.remove(); }
    if (!finalText.startsWith('/')) {
      const u = userTurn({ content: finalText, images }, undefined);
      u.classList.add('fresh');
      if (attachments.length) { u.insertBefore(el('div', 'att', attachments.map(attChip).join('')), u.firstChild.nextSibling); }
      els.messages.appendChild(u); ensureLive(state.session.id); setStatus('Sending…');
      // React before the host acknowledges: Stop and the progress bar appear now; a watchdog undoes it if nothing comes back.
      const sid = state.session.id;
      setRunning(true);
      armSendWatchdog(sid, 10000);
    }
    state.drafts.delete(state.session.id);
    els.input.value = ''; state.attachments = []; state.starterRefs = []; state.images = []; renderChips(); autoGrow(); closeMenu(); updateSendEnabled(); clearQuote(); scrollToBottom(true);
    if (!fromSuggestion) { els.input.focus(); }
  }
  els.input.addEventListener('input', () => { const cr = document.querySelector('.confirm-row'); if (cr) { cr.remove(); } autoGrow(); updateSendEnabled(); warmModel(); const t = tokenAt(); if (t) { showInlineMenu(t); } else if (menuState && !els.popover.querySelector('.search')) { closeMenu(); } });
  // Typing is the strongest signal that a request is coming: ask the host to load the model now (throttled; the
  // host throttles per model too) so the first token is not preceded by a 5–30 s weight load.
  let warmedAt = 0;
  function warmModel() {
    if (!state.session || state.running.has(state.session.id) || Date.now() - warmedAt < 60_000) { return; }
    warmedAt = Date.now();
    post({ type: 'warm', sessionId: state.session.id });
  }
  els.input.addEventListener('focus', warmModel);
  // Moving the caret out of the @ or / token (arrows, Home/End, a click) closes its menu; typing a space already does.
  const leftToken = () => { if (menuState && menuState.inline && !tokenAt()) { closeMenu(); } };
  els.input.addEventListener('keyup', (e) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) { leftToken(); } });
  els.input.addEventListener('mouseup', leftToken);
  /** When the user last pressed a key in the composer: a prompt that appears mid-sentence must not take focus. */
  let lastComposerKey = 0;
  els.input.addEventListener('keydown', (e) => {
    lastComposerKey = Date.now();
    // An IME (Japanese, Chinese, Korean …) uses Enter and the arrows to confirm or pick a candidate: not ours.
    if (e.isComposing || e.keyCode === 229) { return; }
    // Tab from the composer goes straight to a waiting prompt, whose shortcuts only listen once focus is in it.
    if (e.key === 'Tab' && !e.shiftKey && !menuState) { const card = els.approvals.firstElementChild; if (card && card._focusFirst) { e.preventDefault(); card._focusFirst(); return; } }
    if (menuState && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !els.popover.querySelector('.search')) {
      if (e.key === 'Tab') { e.preventDefault(); const x = menuState.items[menuState.sel]; if (x) { closeMenu(); x.it.onPick && x.it.onPick(); } return; }
      if (e.key === 'Enter') { const x = menuState.items[menuState.sel]; if (x && x.it.label !== els.input.value.trim()) { e.preventDefault(); closeMenu(); x.it.onPick && x.it.onPick(); return; } closeMenu(); }
      else { els.popover.onkeydown(e); return; }
    }
    // Backspace right after "@mention " removes the whole mention: select it and let the native delete keep undo working.
    if (e.key === 'Backspace' && !e.altKey && !e.metaKey && !e.ctrlKey && els.input.selectionStart === els.input.selectionEnd) {
      const before = els.input.value.slice(0, els.input.selectionStart);
      const mm = /(?:^|\s)(@(?:"[^"\n]+"|[\w./-]+(?:#L\d+(?:-L?\d+)?|#page=\d+(?:-\d+)?)?)) $/.exec(before);
      if (mm) { els.input.selectionStart = before.length - mm[1].length - 1; }
    }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i') { e.preventDefault(); improvePrompt(); return; }
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && improveUndo && els.input.value === improveUndo.improved) { e.preventDefault(); els.input.value = improveUndo.original; improveUndo = null; autoGrow(); updateSendEnabled(); return; }
    if (improving && state.session && improving.sid === state.session.id && e.key === 'Enter') { e.preventDefault(); return; }
    if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendInNewTab(); return; }
    // Ctrl/Cmd+. rotates the mode (Agent → Multitask → Debug → Plan → Ask); so does Shift+Tab while there is a draft, like
    // Cursor. An empty composer lets Shift+Tab move focus back, so keyboard users can leave it.
    const modeKey = e.key === '.' && !e.shiftKey && !e.altKey && (state.platform === 'darwin' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
    if ((modeKey || (e.key === 'Tab' && e.shiftKey && els.input.value.trim())) && !menuState && state.session && !state.running.has(state.session.id)) { e.preventDefault(); rotateMode(); return; }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !els.input.value.trim() && state.session && els.messages.querySelector('.plancard') && !state.running.has(state.session.id)) { e.preventDefault(); post({ type: 'buildPlan', sessionId: state.session.id }); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); return; }
    if (e.defaultPrevented) { return; }
    if (e.key === 'Escape' && e.altKey && state.session && state.running.has(state.session.id)) { e.preventDefault(); togglePause(); return; }
    if (e.key === 'Escape' && state.session && state.running.has(state.session.id)) { post({ type: 'stop', sessionId: state.session.id }); return; }
    if (e.key === 'ArrowUp' && !e.altKey && !e.metaKey && !e.ctrlKey && !els.input.value && state.history.length) { e.preventDefault(); state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1); els.input.value = state.history[state.histIdx]; autoGrow(); updateSendEnabled(); }
    if (e.key === 'ArrowDown' && state.histIdx >= 0 && els.input.value === state.history[state.histIdx]) { e.preventDefault(); state.histIdx--; els.input.value = state.histIdx >= 0 ? state.history[state.histIdx] : ''; autoGrow(); updateSendEnabled(); }
  });
  els.input.addEventListener('paste', (e) => { const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => /^image\//.test(it.type)); if (items.length) { e.preventDefault(); items.forEach((it) => addImageFile(it.getAsFile())); } });
  els.send.onclick = () => sendCurrent();
  els.stop.onclick = () => state.session && post({ type: 'stop', sessionId: state.session.id });
  els.pause.onclick = togglePause;
  els.tasksToggle.onclick = () => { if (state.session) { tasksUserOpen.set(state.session.id, !els.tasks.classList.contains('open')); } renderTasks(); };
  els.tasks.classList.add('open');
  els.changesToggle.onclick = () => { const open = els.changes.classList.toggle('open'); els.changesList.classList.toggle('hidden', !open); els.changesToggle.setAttribute('aria-expanded', String(open)); };
  // Reject all rewrites files on disk, so it asks first in place of the panel head (like "Delete n chats?" in history).
  function closeRejectConfirm(refocus) {
    if (!rejectConfirm) { return; }
    const head = els.changes.querySelector('.panel-head:not(.confirm)');
    rejectConfirm.remove(); rejectConfirm = null; head.classList.remove('hidden');
    if (refocus) { const b = head.querySelector('[data-a="undoAll"]'); if (b) { b.focus(); } }
  }
  function openRejectConfirm() {
    const s = state.session; const n = (state.changes.get(s.id) || []).length; if (!n) { return; }
    const head = els.changes.querySelector('.panel-head:not(.confirm)');
    const row = el('div', 'panel-head confirm', `<span class="q">Reject ${n} file${n === 1 ? '' : 's'}? <span class="why">Their edits are removed from disk.</span></span><span class="acts"><button class="btn ghost" data-c="keep">Keep</button><button class="btn danger" data-c="reject">${I.undo}Reject</button></span>`);
    row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Confirm reject all'); row.dataset.sid = s.id;
    row.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) { return; } const sid = row.dataset.sid; closeRejectConfirm(b.dataset.c === 'keep'); if (b.dataset.c === 'reject') { post({ type: 'undoChanges', sessionId: sid }); } };
    row.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRejectConfirm(true); } };
    head.classList.add('hidden'); head.after(row); rejectConfirm = row;
    row.querySelector('[data-c="keep"]').focus();
  }
  els.changes.querySelector('.panel-head').onclick = (e) => {
    const a = e.target.closest('[data-a]'); if (!a || !state.session || a.getAttribute('aria-disabled') === 'true') { return; }
    const act = a.dataset.a;
    if (act === 'applyWorktree' || act === 'discardWorktree') { post({ type: act, sessionId: state.session.id }); return; }
    if (act === 'reviewAll') { post({ type: 'viewChanges', sessionId: state.session.id, scope: 'session' }); return; }
    if (act === 'review') { post({ type: 'review', sessionId: state.session.id, scope: 'session' }); return; }
    if (act === 'clearReviewed') { post({ type: 'clearReviewed', sessionId: state.session.id }); return; }
    if (act === 'undoAll') { openRejectConfirm(); return; }
    post({ type: 'keepChanges', sessionId: state.session.id });
  };
  els.box.addEventListener('dragover', (e) => { e.preventDefault(); els.box.classList.add('drop'); });
  els.box.addEventListener('dragleave', () => els.box.classList.remove('drop'));
  els.box.addEventListener('drop', (e) => {
    e.preventDefault(); els.box.classList.remove('drop');
    const dt = e.dataTransfer; const imgs = [...(dt.files || [])].filter((f) => /^image\//.test(f.type)); imgs.forEach(addImageFile);
    if (imgs.length) { return; }
    // Explorer and editor tabs (VS Code's resource lists) and OS files: each becomes an @mention, images an image chip.
    const uris = droppedUris(dt);
    if (uris.length) { for (const u of uris) { post({ type: 'attachUri', uri: u, insert: true }); } return; }
    const text = dt.getData('text/plain'); if (text) { insertAtCaret(text); }
  });
  function droppedUris(dt) {
    const list = (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || '').split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith('#'));
    if (!list.length) { try { const r = JSON.parse(dt.getData('resourceurls') || '[]'); if (Array.isArray(r)) { list.push(...r.map(String)); } } catch { /* not a resource list */ } }
    return [...new Set(list)];
  }
  els.messages.addEventListener('click', (e) => {
    const code = e.target.closest('[data-code]');
    if (code) { const pre = code.closest('.code').querySelector('pre'); const text = pre ? pre.textContent : ''; const act = code.dataset.code; if (act === 'copy') { copyTo(code, text); } if (act === 'insert') { post({ type: 'insertCode', code: text }); } if (act === 'apply') { const pl = code.closest('.code').querySelector('.code-head [data-path]'); post({ type: 'applyCodeToFile', code: text, path: pl ? pl.dataset.path : undefined }); } return; }
    const link = e.target.closest('.path-link'); if (link) { e.preventDefault(); post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined, sessionId: state.session && state.session.id }); return; }
    const uchip = e.target.closest('.fchip[data-url]'); if (uchip) { e.preventDefault(); post({ type: 'openExternal', url: uchip.dataset.url }); return; }
    const img = e.target.closest('.imgs img, .md-img, .content.shot img, .content.inspect .shot-img'); if (img) { openLightbox(img.src, img.alt); return; }
    const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); post({ type: 'openExternal', url: a.getAttribute('href') }); }
  });
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); els.input.focus(); }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'i' && !e.defaultPrevented && e.target !== els.input) { e.preventDefault(); openContextMenu(); }
    if (e.target && e.target.classList && e.target.classList.contains('rename')) { return; }
    if (e.altKey && !mod && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); cycleTab(e.key === 'ArrowDown' ? 1 : -1); }
    if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) { const { list } = tabList(); const t = list[Number(e.code.slice(5)) - 1]; if (t) { e.preventDefault(); e.stopPropagation(); selectTab(t.id); } }
    if (mod && e.altKey && e.code === 'KeyT') { e.preventDefault(); e.stopPropagation(); els.newTab.click(); }
    if (mod && e.altKey && e.code === 'KeyW') { const id = activeId(); if (id && !state.running.has(id)) { e.preventDefault(); e.stopPropagation(); closeTab(id); } }
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

  // ------------------------------------------------------------------ error boundary
  // The webview shares VS Code's UI thread; a handler that throws must cost one message, not the whole chat. Errors
  // are reported to the extension (they end up in the LocalPilot output log) — a silent, half-dead UI is the worst outcome.
  let reported = 0;
  function reportError(where, err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined;
    console.error(`[LocalPilot chat] ${where}: ${message}`, err);
    if (reported++ < 20) { try { post({ type: 'clientError', where, message, stack }); } catch { /* the bridge itself is gone */ } }
  }
  window.addEventListener('error', (e) => reportError('uncaught', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason));

  window.addEventListener('message', (ev) => onMessage(ev.data));
  function onMessage(m) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') { return; }
    try {
      dispatch(m);
    } catch (err) {
      reportError(`message '${m.type}'`, err);
      // A render that threw midway can leave the live turn or the tab strip half-drawn; a fresh paint is cheap.
      if (m.type === 'event' || m.type === 'session' || m.type === 'replay') { try { if (state.session) { renderSession(); } renderTabs(); } catch { /* already reported */ } }
    }
  }
  /**
   * A run that was in flight when this webview was created (chat closed and reopened, moved to another container,
   * opened in an editor tab) arrives as one `replay`: the same events, queued steering rows and pending approvals the
   * live stream would have delivered, in order. They go through the ordinary handlers, so the turn is rebuilt exactly
   * as it looked — partial answer, running steps, worker lanes, the approval waiting for an answer.
   */
  function applyReplay(m) {
    const sid = m.sessionId;
    // Live events that reached this webview before the replay are part of it; start the turn over so nothing doubles.
    const old = state.live.get(sid);
    if (old) { clearTimeout(old.timer); old.root.remove(); state.live.delete(sid); }
    const live = ensureLive(sid);
    if (m.startedAt) { live.startedAt = m.startedAt; }
    if (m.truncated && !live.root.querySelector('.note.replay')) { live.root.insertBefore(el('div', 'note replay', 'Earlier steps of this run are not shown — the full transcript appears when it finishes.'), live.steps); }
    for (const item of m.items || []) { onMessage(item); }
    // Replayed deltas arrive in one burst; they say nothing about the model's current speed.
    live.stream = [];
    if (m.status) { noteStatus(sid, m.status); if (state.session && state.session.id === sid) { setStatus(m.status); } }
    if (state.session && state.session.id === sid) { if (live.dirty) { scheduleRender(live); } scrollToBottom(true); updateJump(); }
    renderTabs();
  }
  function armSendWatchdog(sid, ms) {
    clearTimeout(state.pendingSend.get(sid));
    state.pendingSend.set(sid, setTimeout(() => { if (!state.running.has(sid)) { const shown = state.session && state.session.id === sid; rejectSend(sid); if (shown) { toast('The request did not start — check the LocalPilot output log and try again', 'error', { label: 'Open log', msg: { type: 'showLog' } }); } } else { state.pendingSend.delete(sid); } }, ms));
  }
  /** A send that never became a run: drop its placeholder turn and the bubble drawn for it. */
  function rejectSend(sid) {
    clearTimeout(state.pendingSend.get(sid)); state.pendingSend.delete(sid);
    if (state.running.has(sid)) { return; }
    const live = state.live.get(sid);
    if (live) { clearTimeout(live.timer); live.root.remove(); state.live.delete(sid); }
    if (state.session && state.session.id === sid) {
      const last = els.messages.lastElementChild; if (last && last.matches('.turn.user.fresh')) { last.remove(); }
      setRunning(false);
    }
  }
  function dispatch(m) {
    switch (m.type) {
      case 'init': post({ type: 'requestOpenFiles' }); state.sessions = m.sessions || []; state.models = m.models || []; state.modelsLoading = !state.models.length; state.defaultModel = m.defaultModel; state.contextWindow = Number(m.contextWindow) || 0; state.skills = m.skills || []; state.agents = m.agents || []; state.commands = m.commands || []; state.skillsMode = m.skillsMode || 'auto'; state.running = new Set(m.running || []); state.paused = new Map((m.paused || []).map((id) => [id, { paused: true, holding: true }])); state.platform = m.platform || ''; if (m.workspace) { state.workspace = m.workspace; } syncShortcutTitles(); state.activeHint = m.activeSessionId || null; if (!state.openTabs) { state.openTabs = new Set(state.sessions.slice().sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || (b.updatedAt - a.updatedAt)).slice(0, 8).map((s) => s.id)); } syncModel(); renderTabs(); break;
      case 'sessions': state.sessions = m.sessions || []; for (const id of [...state.unread]) { if (!state.sessions.some((s) => s.id === id)) { state.unread.delete(id); } } renderTabs(); if (state.session) { updateCtx(); } if (hist.open) { histRefresh(); } break;
      case 'sessionPage': histPage(m); break;
      case 'session': {
        const prev = state.session && state.session.id; const switching = prev !== m.session.id;
        if (switching && prev) { saveDraft(prev); }
        state.session = m.session; state.session.liveFrom = m.liveFrom; state.session.offers = m.offers; state.loadingTab = null; state.activeHint = null; state.unread.delete(m.session.id); clearTimeout(selectTab.timer);
        dismissBoot(); renderSession(); renderChanges(); renderTasks(); renderTabs(); renderQueue(); renderQuote(); renderGrants(); scheduleSticky();
        if (switching) { closeMenu(); restoreDraft(m.session.id); const y = state.scroll.get(m.session.id); if (y !== undefined && !state.running.has(m.session.id)) { els.messages.scrollTop = y; } }
        // Don't yank focus away from a rename box, popover search or anything else the user is typing in.
        if (!document.activeElement || document.activeElement === document.body || els.messages.contains(document.activeElement)) { els.input.focus(); }
        break;
      }
      case 'changes': state.changes.set(m.sessionId, m.files); state.reviewed.set(m.sessionId, m.reviewed || []); state.conflicts.set(m.sessionId, m.conflicts || []); if (state.session && state.session.id === m.sessionId && els.messages.querySelector(':scope > .rec-int')) { requestAnimationFrame(renderInterrupted); } state.checkpoints.set(m.sessionId, m.checkpoints || []); state.gitCheckpoints.set(m.sessionId, m.gitCheckpoints || []); if (m.checkpointsEnabled !== undefined) { state.checkpointsOn = m.checkpointsEnabled; } if (m.lastTurn) { state.lastTurn.set(m.sessionId, m.lastTurn); } else { state.lastTurn.delete(m.sessionId); } if (m.worktree) { state.worktree.set(m.sessionId, m.worktree); } else { state.worktree.delete(m.sessionId); } if (state.session && state.session.id === m.sessionId) { renderChanges(); els.messages.querySelectorAll('.turn.user').forEach((t) => syncRestoreButton(t, m.sessionId)); syncViewChanges(m.sessionId); syncEditTags(m.sessionId); } break;
      case 'skills': state.skills = m.skills || []; state.agents = m.agents || []; state.commands = m.commands || state.commands || []; if (m.skillsMode) { state.skillsMode = m.skillsMode; } syncSkills(); break;
      case 'mcpStatus': state.mcp = m.servers || []; syncMcp(); break;
      case 'autoApprove': renderAutoApprove(m); break;
      case 'sessionGrants': if (m.kinds && m.kinds.length) { grants.set(m.sessionId, m.kinds); } else { grants.delete(m.sessionId); } if (state.session && state.session.id === m.sessionId) { renderGrants(); } break;
      case 'models': { const hadNone = !state.models.length; const asked = state.modelsRequested; const wasLoading = state.modelsLoading; state.modelsRequested = false; state.modelsLoading = false; state.models = m.models; state.providerNames = m.providerNames || {}; state.favorites = m.favorites || []; state.manualProviders = m.manualProviders || []; if (m.thinking) { state.thinking = m.thinking; } state.defaultModel = m.defaultModel; state.autoModel = m.autoModel || ''; state.visionRouting = !!m.visionRouting; if (m.contextWindow !== undefined) { state.contextWindow = Number(m.contextWindow) || 0; } syncModel(); updateCtx(); renderCtxStrip(); if (hadNone && m.models.length && asked) { toast(`${m.models.length} model${m.models.length === 1 ? '' : 's'} found`); } /* The empty chat's notice and suggestions depend on having a model: redraw when that flips, either way. */ if ((hadNone !== !m.models.length || (hadNone && wasLoading)) && state.session && !state.session.messages.length) { renderSession(); } break; }
      case 'event': if (m.event && typeof m.event === 'object' && typeof m.event.sessionId === 'string') { handleEvent(m.event); } break;
      case 'skillInstall': {
        // The session redraw replaces a settled offer; this settles chips still inside a live turn.
        for (const b of document.querySelectorAll('[data-install]')) {
          if (b.dataset.install !== m.name) { continue; }
          if (m.ok) { b.innerHTML = `${I.check || ''}Installed`; b.disabled = true; } else { b.disabled = false; b.innerHTML = `${I.refresh || ''}Retry install`; b.title = m.error || 'Install failed'; }
        }
        break;
      }
      case 'paused': {
        if (m.childId) { laneSetPaused(m.sessionId, m.childId, m.paused, m.holding); break; }
        state.paused.set(m.sessionId, { paused: m.paused, holding: m.holding });
        noteStatus(m.sessionId, m.paused ? (m.holding ? 'Paused' : 'Pausing after this step…') : 'Resuming…');
        if (state.session && state.session.id === m.sessionId) { syncPause(); setStatus(state.status.get(m.sessionId) || ''); renderChanges(); }
        { const lv = state.live.get(m.sessionId); if (lv && state.session && state.session.id === m.sessionId) { syncWorkPause(lv, Date.now()); } }
        renderTabs();
        break;
      }
      case 'commandState': if (typeof m.id === 'string') { setCommandState(m.id, m.state, m.logPath); } break;
      case 'sendRejected': rejectSend(m.sessionId); break;
      case 'sendQueued':
        // A manual compaction holds the message back; give it time so the "did not start" watchdog stays quiet.
        if (state.pendingSend.has(m.sessionId)) { armSendWatchdog(m.sessionId, 200000); if (state.session && state.session.id === m.sessionId) { setStatus('Waiting for compaction…'); } }
        break;
      case 'queue': {
        if (m.items && m.items.length) { queues.set(m.sessionId, { items: m.items, label: m.label }); } else { queues.delete(m.sessionId); }
        // A cancelled steer never reaches the model: drop its "queued" row from the turn.
        const lv = state.live.get(m.sessionId);
        for (const id of m.removed || []) { const row = lv && lv.root.querySelector(`.steer.queued[data-steer-id="${CSS.escape(id)}"]`); if (row) { row.remove(); } }
        renderQueue();
        break;
      }
      case 'steerQueued': {
        const live = ensureLive(m.sessionId);
        live.root.appendChild(steerRow(m.content, m.images, m.id, true, m.fixes));
        noteStatus(m.sessionId, state.paused.get(m.sessionId) && state.paused.get(m.sessionId).paused ? 'Paused · message waiting' : 'Message queued for the next step');
        if (state.session && state.session.id === m.sessionId) { setStatus(state.status.get(m.sessionId)); scrollToBottom(false); }
        break;
      }
      case 'running': {
        const isActive = state.session && state.session.id === m.sessionId;
        if (!m.running) { state.paused.delete(m.sessionId); }
        clearTimeout(state.pendingSend.get(m.sessionId)); state.pendingSend.delete(m.sessionId);
        state.scroll.delete(m.sessionId);
        if (m.running) { state.running.add(m.sessionId); state.unread.delete(m.sessionId); state.interrupted.delete(m.sessionId); state.runInt.delete(m.sessionId); if (state.rerouted.delete(m.sessionId) && isActive) { syncModel(); } noteStatus(m.sessionId, 'Starting…'); }
        else { state.running.delete(m.sessionId); finishLive(m.sessionId); noteStatus(m.sessionId, ''); if (!isActive && !state.dismissed.delete(m.sessionId) && state.sessions.some((s) => s.id === m.sessionId)) { state.unread.add(m.sessionId); } for (const [aid, sid] of [...state.approvalSid]) { if (sid === m.sessionId) { state.approvalSid.delete(aid); removeApproval(aid); } } state.attention.delete(m.sessionId); }
        if (isActive) { setRunning(m.running); renderTasks(); renderChanges(); if (!m.running) { post({ type: 'selectSession', id: m.sessionId }); } }
        renderTabs();
        break;
      }
      case 'approval': state.approvalSid.set(m.id, m.sessionId); renderApproval(m); markApprovalRow(m); { const lv = state.live.get(m.sessionId); if (lv) { setPhase(lv, 'Waiting for your approval'); } } if (!state.session || state.session.id !== m.sessionId) { state.attention.add(m.sessionId); renderTabs(); const s = state.sessions.find((x) => x.id === m.sessionId); toast(`Approval needed in “${(s && s.title) || 'another chat'}”`); } break;
      case 'approvalResolved': { removeApproval(m.id); resolveAttention(m.id); unmarkApprovalId(m.id); break; }
      // Host -> webview: a run cut off by a reload (`state` with its facts) or null once it was continued or dismissed.
      case 'runInterrupted': if (typeof m.sessionId === 'string') { if (m.state && typeof m.state === 'object') { state.runInt.set(m.sessionId, m.state); } else { state.runInt.delete(m.sessionId); } if (state.session && state.session.id === m.sessionId) { renderInterrupted(); } } break;
      case 'conflicts': applyConflicts(m.sessionId, Array.isArray(m.files) ? m.files : []); break;
      case 'question': state.approvalSid.set(m.id, m.sessionId); renderQuestion(m); { const lv = state.live.get(m.sessionId); if (lv) { setPhase(lv, 'Waiting for your answer'); } } if (!state.session || state.session.id !== m.sessionId) { state.attention.add(m.sessionId); renderTabs(); const s = state.sessions.find((x) => x.id === m.sessionId); toast(`Question waiting in “${(s && s.title) || 'another chat'}”`); } break;
      case 'questionResolved': { removeApproval(m.id); resolveAttention(m.id); break; }
      case 'toast': if (m.text.startsWith('attach:')) { addAttachment(m.text.slice(7)); } else { toast(m.text, m.level, m.action); } if (m.level === 'error') { editChecks.forEach((c) => c.release && c.release()); } break;
      case 'checkpointExistsResult': { const c = editChecks.get(`${m.sessionId}:${m.index}`); if (c) { c.done(m); } break; }
      case 'editAndRegenerateResult': { const c = editChecks.get(`${m.sessionId}:${m.index}`); if (c && c.release) { c.release(); } break; }
      case 'improvedPrompt': improvedPrompt(m); break;
      case 'promptCorrected': {
        if (!state.session || state.session.id !== m.sessionId) { break; }
        // The bubble was drawn as typed when Send was pressed; show what the agent actually received.
        const u = [...els.messages.querySelectorAll('.turn.user')].pop(); if (!u) { break; }
        const t = u.querySelector('.utext'); if (t) { t.innerHTML = inline(m.text); }
        const old = u.querySelector('.corrected'); if (old) { old.remove(); }
        u.appendChild(correctionNote(m.fixes || []));
        break;
      }
      case 'draft': if (m.append) { appendDraft(m.text, m.attachments); break; } if (m.merge && (els.input.value.trim() || state.images.length || state.attachments.length)) { mergeDraft(m.text, m.images, m.attachments); break; } els.input.value = m.text || ''; if (m.images && m.images.length) { state.images = m.images.map((data, i) => ({ name: `image-${i + 1}.png`, data: String(data).replace(/^data:[^,]*,/, ''), mime: 'image/png' })); } if (m.attachments && m.attachments.length) { state.attachments = m.attachments.slice(); } if ((m.images && m.images.length) || (m.attachments && m.attachments.length)) { renderChips(); } autoGrow(); updateSendEnabled(); els.input.focus(); break;
      case 'focusInput': els.input.focus(); post({ type: 'requestOpenFiles' }); break;
      case 'historyCleared': state.openTabs = null; state.unread.clear(); state.attention.clear(); for (const id of [...state.live.keys()]) { if (!state.running.has(id)) { state.live.delete(id); } } renderTabs(); break;
      case 'mentionResults': mentionResults(m); break;
      case 'workspaceInfo': {
        const prev = state.workspace || {}; state.workspace = m.workspace || {};
        // Errors and folder changes alter the starters (the error count, chat-only rows); the rest redraws the strip in place.
        const welcome = els.messages.querySelector(':scope > .empty');
        if (welcome && (prev.folders !== state.workspace.folders || (prev.errors || 0) !== (state.workspace.errors || 0))) { renderSession(); } else { renderCtxStrip(); }
        break;
      }
      case 'openFiles': {
        const was = `${state.activeFile}|${state.hasSelection}`;
        state.openFiles = m.files || []; state.activeFile = m.active || ''; state.hasSelection = !!m.selection;
        // The empty chat's suggestions name the file you are on; refresh them when that changes.
        if (was !== `${state.activeFile}|${state.hasSelection}` && state.session && !state.session.messages.length && !state.running.has(state.session.id)) { renderSession(); }
        break;
      }
      case 'taskSuggestions': {
        if (m.source === 'quick') { launcher.pool = m.items || []; } else { launcher.loadingMore = false; const have = new Set(launcher.pool.map((s) => s.title.toLowerCase())); launcher.pool = [...(m.items || []).filter((s) => !have.has(s.title.toLowerCase())), ...launcher.pool]; }
        launcher.recent = m.recent || [];
        if (launcher.box && launcher.box.isConnected && launcher.renderIdeas) { launcher.renderIdeas(); }
        break;
      }
      case 'openLauncher': openParallelComposer(m.kind); break;
      case 'insertMention': insertMention(m.ref); break;
      case 'image': if (attachCount() >= MAX_ATTACH) { toast(`Up to ${MAX_ATTACH} images and files per message`, 'error'); break; } addImageUrl(m.image.name, `data:${m.image.mime};base64,${m.image.data}`); break;
      case 'replay': applyReplay(m); break;
      // Host -> webview `{ type: 'recoveryInterrupted', sessionId, state }`: `state` is the session's RecoveryState or
      // UnfinishedSummary (phase already 'interrupted'; `lastPhase` and `recoveryId` optional), null to clear the card.
      // The card's actions post `recoveryAction` with `recoveryId` = state.recoveryId || state.sessionId || state.sid || sessionId.
      case 'recoveryInterrupted': if (typeof m.sessionId === 'string') { if (m.state && typeof m.state === 'object') { state.interrupted.set(m.sessionId, m.state); } else { state.interrupted.delete(m.sessionId); } if (state.session && state.session.id === m.sessionId) { renderInterrupted(); } } break;
    }
  }

  // Auto-approve bar above the input: "Auto-approve: Edit, Web" expands into one choice row per category. A choice writes the
  // global setting and the agent reads it at its next approval, so it applies to a run in progress. Values the
  // organization's policy rules out are disabled.
  const AA_NAMES = { ask: 'Ask', always: 'Always', never: 'Never', safe: 'Safe only', on: 'On', off: 'Off' };
  function renderAutoApprove(m) {
    const box = $('autoApprove'); const body = $('aaBody'); if (!box || !body) { return; }
    box.classList.remove('hidden');
    $('aaLabel').textContent = m.summary || 'none';
    body.innerHTML = (m.items || []).map((it) => {
      const lock = it.locked || { values: [] };
      // Roving tabindex: one tab stop per row, on the checked choice (or the first enabled one).
      const stop = it.values.includes(it.value) && !lock.values.includes(it.value) ? it.value : it.values.find((v) => !lock.values.includes(v));
      const seg = it.values.map((v) => { const off = lock.values.includes(v); return `<button data-k="${esc(it.key)}" data-v="${esc(v)}" role="radio" aria-checked="${v === it.value}" tabindex="${v === stop ? 0 : -1}" class="${v === it.value ? 'on' : ''}"${off ? ` disabled title="${esc(lock.reason)}"` : ''}>${esc(AA_NAMES[v] || v)}</button>`; }).join('');
      const ws = it.overriddenBy === 'workspace' ? ' <i class="aa-ws" title="Set in this workspace\'s settings — changes here apply to the workspace">workspace</i>' : '';
      return `<div class="aa-row${it.locked ? ' locked' : ''}"><span class="aa-name"${it.locked ? ` title="${esc(it.locked.reason)}"` : ''}>${esc(it.label)}${it.locked ? ' <i class="aa-lock">policy</i>' : ''}${ws}</span><span class="seg" role="radiogroup" aria-label="${esc(it.label)}${it.overriddenBy === 'workspace' ? ' (workspace setting)' : ''}">${seg}</span></div>`;
    }).join('');
  }
  if ($('aaToggle')) {
    $('aaToggle').onclick = () => { const open = $('aaBody').classList.toggle('hidden') === false; $('autoApprove').classList.toggle('open', open); $('aaToggle').setAttribute('aria-expanded', String(open)); };
    const pickAa = (b) => {
      for (const x of b.parentElement.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; }
      post({ type: 'setApproval', key: b.dataset.k, value: b.dataset.v });
    };
    $('aaBody').onclick = (e) => {
      const b = e.target.closest('button[data-k]'); if (!b || b.disabled || b.classList.contains('on')) { return; }
      pickAa(b);
    };
    // Radiogroup keys: arrows move and select (skipping choices the policy rules out), Home/End jump to the ends.
    $('aaBody').onkeydown = (e) => {
      const b = e.target.closest('button[data-k]'); if (!b) { return; }
      const opts = [...b.parentElement.children].filter((x) => !x.disabled); const i = opts.indexOf(b);
      const n = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: opts.length - 1 }[e.key];
      if (n === undefined || !opts.length) { return; }
      e.preventDefault();
      const t = opts[(n + opts.length) % opts.length]; t.focus(); if (!t.classList.contains('on')) { pickAa(t); }
    };
  }

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
    d.remove(); syncWaiting();
  }
  /** Keys answer a prompt only when focus is on the prompt itself (or nowhere), never while the user types elsewhere. */
  function promptKeyTarget(d, e) {
    const t = e.target;
    if (t === document.body || t === document.documentElement) { return true; }
    return d.contains(t) && !(t.closest && t.closest('input, textarea, select'));
  }
  /** Focus a new prompt's main button when the user isn't typing; otherwise say how to reach it. */
  function offerPromptFocus(d, first, hint) {
    d._focusFirst = () => { const b = first(); if (b) { b.focus(); } };
    const a = document.activeElement;
    const idle = !els.input.value.trim() && Date.now() - lastComposerKey > 1500 && (!a || a === document.body || a === els.input);
    if (idle && els.approvals.firstElementChild === d) { d._focusFirst(); return; }
    const h = el('div', 'khint', `Press <kbd>Tab</kbd> to answer, or ${hint}`); d.appendChild(h);
    // Once the prompt has focus the hint has done its job.
    d.addEventListener('focusin', () => h.remove(), { once: true });
  }
  const GRANT_LABEL = { terminal: 'Allow all commands in this chat', write: 'Allow all edits in this chat', delete: 'Allow all deletes in this chat', network: 'Allow all network access in this chat', mcp: 'Allow all MCP tools in this chat' };
  const GRANT_NOUN = { terminal: 'command', write: 'edit', delete: 'delete', network: 'network request', mcp: 'MCP tool call' };
  const GRANT_CHIP = { terminal: 'Commands', write: 'Edits', delete: 'Deletes', network: 'Network', mcp: 'MCP tools' };
  /** "Allow all … in this chat" also answers the other prompts of that kind in the chat (parallel workers): say how many. */
  function syncWaiting() {
    const cards = [...els.approvals.querySelectorAll('.approval[data-kind]:not([data-mandatory])')];
    for (const c of cards) {
      const b = c.querySelector('[data-a="session"]'); if (!b) { continue; }
      const n = Math.max(+c.dataset.waiting || 0, cards.filter((o) => o !== c && o.dataset.kind === c.dataset.kind && o.dataset.sid === c.dataset.sid).length);
      b.title = n ? `Also approves ${n} waiting worker${n === 1 ? '' : 's'} (A)` : `Allow every ${GRANT_NOUN[c.dataset.kind] || 'action of this kind'} for the rest of this chat (A)`;
    }
  }
  // "Allow all … in this chat" grants per chat, shown as removable chips at the start of the auto-approve bar.
  const grants = new Map();
  function renderGrants() {
    const box = $('autoApprove'); const head = $('aaToggle'); if (!box || !head) { return; }
    let strip = $('aaGrants');
    const kinds = (state.session && grants.get(state.session.id)) || [];
    if (!kinds.length) { if (strip) { strip.remove(); } box.classList.toggle('has-grants', false); return; }
    if (!strip) { strip = el('div', 'aa-grants'); strip.id = 'aaGrants'; strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Allowed for this chat'); strip.onclick = (e) => { const b = e.target.closest('button[data-kind]'); if (b && state.session) { post({ type: 'revokeGrant', sessionId: state.session.id, kind: b.dataset.kind }); } }; box.insertBefore(strip, head); }
    box.classList.remove('hidden'); box.classList.add('has-grants');
    strip.innerHTML = `<span class="aa-k">This chat:</span>` + kinds.map((k) => { const n = GRANT_CHIP[k] || k; return `<button class="grant" data-kind="${esc(k)}" title="${esc(GRANT_LABEL[k] || n)} — click to ask again" aria-label="Stop allowing ${esc(n.toLowerCase())} in this chat"><span>${esc(n)}</span><span class="x" aria-hidden="true">×</span></button>`; }).join('');
  }
  function renderApproval(a) {
    if (els.approvals.querySelector(`[data-id="${CSS.escape(a.id)}"]`)) { return; }
    const d = el('div', 'approval'); d.dataset.id = a.id;
    const kind = { terminal: 'Run command', write: 'Edit file', delete: 'Delete', network: 'Network', mcp: 'MCP tool' }[a.kind] || a.kind;
    const other = !state.session || state.session.id !== a.sessionId; const sess = other ? state.sessions.find((s) => s.id === a.sessionId) : null;
    // A dangerous command or an organization rule asks every time, so there is no "allow all" to offer.
    const why = a.mandatory ? (a.mandatoryReason === 'policy' ? 'Always asks — required by your organization' : a.kind === 'terminal' ? 'Always asks — dangerous command' : 'Always asks for this action') : '';
    d.dataset.kind = a.kind; d.dataset.sid = a.sessionId; d.dataset.waiting = String(a.waitingSameKind || 0); if (a.mandatory) { d.dataset.mandatory = '1'; }
    // "Allow all … in this chat" with a split menu that also offers the workspace-wide grant (never for a mandatory prompt).
    const all = a.mandatory ? '' : `<span class="split"><button class="btn" data-a="session" title="Allow every ${esc(GRANT_NOUN[a.kind] || 'action of this kind')} for the rest of this chat (A)"><span class="long">${esc(GRANT_LABEL[a.kind] || 'Allow all of these in this chat')}</span><span class="short">All in chat</span> <kbd>A</kbd></button><button class="btn split-more" data-a="more" title="More ways to allow" aria-label="More ways to allow" aria-haspopup="menu">${I.chev}</button></span>`;
    const edit = a.editable ? `<button class="btn ghost" data-a="edit" title="Change the command before it runs; the edited command is what runs">${I.edit}<span class="long">Edit</span></button>` : '';
    // Why it asked, and where that is set: the policy, a destructive command, or the approval setting for this kind.
    const because = a.askedBecause ? `${a.mandatory ? 'Always asks' : 'Asked'} because ${a.askedBecause}` : why;
    const foot = because ? `<div class="always"><span>${esc(because)}</span><i>·</i><button class="link" data-a="settings" title="Settings → Agent → approvals">Change in Settings</button></div>` : '';
    d.innerHTML = `<div class="head">${I.warn}<span>${esc(a.title)}</span>${kind.toLowerCase() === String(a.title).toLowerCase() ? '' : `<span class="kind">${esc(kind)}</span>`}</div>${other ? `<button class="sess" data-a="open" title="Open that chat">${I.agent}<span>${esc((sess && sess.title) || 'Another chat')}</span>${I.chev}</button>` : ''}<pre></pre><div class="reason hidden"><input type="text" maxlength="2000" placeholder="Why not? The agent reads this — Enter denies, Esc cancels" aria-label="Reason for denying"><button class="btn" data-a="denyReason">Deny</button></div><div class="actions"><button class="btn ghost" data-a="reason" title="Deny and tell the agent what to do instead (Shift+N)"><span class="long">Deny with reason…</span><span class="short">Reason…</span></button><button class="btn ghost" data-a="deny" title="Deny (N). Text in the message box goes along as the reason.">Deny <kbd>N</kbd></button>${edit}${all}<button class="btn primary" data-a="allow" title="Allow once (Y)"><span class="long">Allow once</span><span class="short">Once</span> <kbd>Y</kbd></button></div>${foot}`;
    const pre = d.querySelector('pre');
    const cmdLine = a.kind === 'terminal' && /^\$ /.test(String(a.detail || '')) ? String(a.detail).split('\n')[0].slice(2) : '';
    if (cmdLine) { pre.innerHTML = `<span class="sh-prompt">$ </span>${highlight(cmdLine, 'sh')}${esc(String(a.detail).slice(cmdLine.length + 2))}`; pre.classList.add('cmd'); } else { pre.textContent = a.detail; }
    let editor = null;
    const answer = (act, feedback) => {
      const f = act === 'deny' && feedback ? String(feedback).trim() : '';
      const edited = act !== 'deny' && editor && editor.value.trim() && editor.value.trim() !== cmdLine ? editor.value.trim() : '';
      post({ type: 'approval', id: a.id, approved: act !== 'deny', remember: act === 'session', ...(f ? { feedback: f } : {}), ...(edited ? { editedArgs: edited } : {}) }); removeApproval(a.id); resolveAttention(a.id); els.input.focus();
    };
    const openEditor = () => {
      if (editor) { editor.focus(); return; }
      editor = el('textarea', 'cmd-edit'); editor.rows = Math.min(6, Math.max(2, cmdLine.split('\n').length + 1)); editor.spellcheck = false; editor.value = cmdLine; editor.setAttribute('aria-label', 'Command to run (edit, then Allow)');
      editor.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); answer('allow'); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); editor.value = cmdLine; } };
      pre.after(editor); pre.classList.add('hidden');
      const b = d.querySelector('[data-a="edit"]'); if (b) { b.disabled = true; b.title = 'Editing: Allow runs the edited command (Mod+Enter)'; }
      d.querySelector('[data-a="allow"] .long').textContent = 'Allow edited';
      editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
    };
    // Deny with a reason: the reason box, or whatever is in the composer when Deny is clicked (then the draft is used up).
    const reasonBox = d.querySelector('.reason'); const reasonIn = reasonBox.querySelector('input');
    const openReason = () => { reasonBox.classList.remove('hidden'); if (!reasonIn.value && els.input.value.trim()) { reasonIn.value = els.input.value.trim(); } reasonIn.focus(); };
    const denyWithDraft = () => { const draft = els.input.value.trim(); if (draft) { els.input.value = ''; autoGrow(); updateSendEnabled(); } answer('deny', draft); };
    reasonIn.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); answer('deny', reasonIn.value); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); reasonBox.classList.add('hidden'); els.input.focus(); } };
    // Y/A/N answer the oldest pending prompt only; with several queued, one keypress must not resolve them all.
    const key = (e) => { if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || els.approvals.firstElementChild !== d || !promptKeyTarget(d, e)) { return; } const k = e.key.toLowerCase(); if (k === 'n' && e.shiftKey) { openReason(); } else if (k === 'y') { answer('allow'); } else if (k === 'a' && !a.mandatory) { answer('session'); } else if (k === 'n' || k === 'escape') { answer('deny'); } else { return; } e.preventDefault(); e.stopPropagation(); };
    d.onclick = (ev) => {
      const b = ev.target.closest('[data-a]'); if (!b) { return; } const act = b.dataset.a;
      if (act === 'open') { selectTab(a.sessionId); return; } if (act === 'reason') { openReason(); return; } if (act === 'denyReason') { answer('deny', reasonIn.value); return; } if (act === 'deny') { denyWithDraft(); return; }
      if (act === 'edit') { openEditor(); return; }
      if (act === 'settings') { post({ type: 'openSettings', section: 'agent', key: `approvals.${a.kind}` }); return; }
      if (act === 'more') {
        openMenu(b, [
          { label: GRANT_LABEL[a.kind] || 'Allow all of these in this chat', desc: 'Until this chat ends; removable from the auto-approve bar', icon: I.check, onPick: () => answer('session') },
          { label: 'Always allow in this workspace…', desc: `Saves ${GRANT_CHIP[a.kind] || a.kind}: Always in this workspace's settings (asks to confirm)`, icon: I.folder, onPick: () => post({ type: 'approval', id: a.id, approved: true, scope: 'workspace' }) },
        ]);
        return;
      }
      answer(act);
    };
    document.addEventListener('keydown', key, true);
    d._dispose = () => document.removeEventListener('keydown', key, true);
    els.approvals.appendChild(d); syncWaiting();
    offerPromptFocus(d, () => d.querySelector('[data-a="allow"]'), '<kbd>Y</kbd> / <kbd>N</kbd>');
    // The footer scrolls on short hosts (bottom Panel); prompts sit at its top.
    els.approvals.parentElement.scrollTop = 0;
    if (state.session && state.session.id === a.sessionId) { scrollToBottom(false); }
  }

  // ask_user: up to 4 questions with explained options, a recommended pick, multi-select and an own-words answer.
  // Shares the approvals slot (and its removal/attention bookkeeping); 1–9 pick in the first unanswered question,
  // Enter submits once every question has an answer, Esc skips (the agent then goes with its recommendations).
  function renderQuestion(a) {
    if (els.approvals.querySelector(`[data-id="${CSS.escape(a.id)}"]`)) { return; }
    const qs = a.questions || [];
    const sel = qs.map(() => new Set()); const other = qs.map(() => '');
    const d = el('div', 'approval question'); d.dataset.id = a.id;
    const other_ = !state.session || state.session.id !== a.sessionId; const sess = other_ ? state.sessions.find((s) => s.id === a.sessionId) : null;
    d.innerHTML = `<div class="head">${I.ask}<span>${qs.length > 1 ? `${qs.length} questions before I start` : 'A question before I start'}</span></div>${other_ ? `<button class="sess" data-a="open" title="Open that chat">${I.agent}<span>${esc((sess && sess.title) || 'Another chat')}</span>${I.chev}</button>` : ''}` +
      qs.map((q, qi) => `<div class="q" data-q="${qi}"><div class="q-head">${q.header ? `<span class="q-chip">${esc(q.header)}</span>` : ''}<span class="q-text">${esc(q.question)}</span>${q.multiSelect ? '<span class="q-hint">choose any</span>' : ''}</div><div class="opts" role="${q.multiSelect ? 'group' : 'radiogroup'}">` +
        (q.options || []).map((o, oi) => `<button class="opt${q.multiSelect ? ' multi' : ''}" data-q="${qi}" data-o="${oi}" role="${q.multiSelect ? 'checkbox' : 'radio'}" aria-checked="false"><span class="mark"></span><span class="ol"><span class="ot"><b>${esc(o.label)}</b>${o.label === q.recommended ? '<span class="rec">Recommended</span>' : ''}</span>${o.description ? `<span class="od">${esc(o.description)}</span>` : ''}</span></button>`).join('') +
        `<label class="opt own"><span class="mark"></span><input data-q="${qi}" type="text" placeholder="${(q.options || []).length ? 'Something else…' : 'Your answer…'}" aria-label="Your own answer"></label></div></div>`).join('') +
      `<div class="actions"><button class="btn ghost" data-a="skip" title="Skip — the agent uses its recommendations (Esc)">Skip</button><button class="btn primary" data-a="submit" disabled>Submit <kbd>↵</kbd></button></div>`;
    const submitBtn = d.querySelector('[data-a="submit"]');
    const answered = (qi) => sel[qi].size > 0 || other[qi].trim().length > 0;
    const sync = () => {
      d.querySelectorAll('.opt[data-o]').forEach((b) => { const on = sel[+b.dataset.q].has(+b.dataset.o); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
      d.querySelectorAll('.opt.own').forEach((l) => { const qi = +l.querySelector('input').dataset.q; l.classList.toggle('on', other[qi].trim().length > 0); });
      d.querySelectorAll('.q').forEach((q) => q.classList.toggle('done', answered(+q.dataset.q)));
      submitBtn.disabled = !qs.every((_, qi) => answered(qi));
    };
    const pick = (qi, oi) => {
      const q = qs[qi];
      if (q.multiSelect) { if (sel[qi].has(oi)) { sel[qi].delete(oi); } else { sel[qi].add(oi); } }
      else { sel[qi] = new Set([oi]); other[qi] = ''; d.querySelector(`input[data-q="${qi}"]`).value = ''; }
      sync();
    };
    const finish = (answers) => { post({ type: 'answer', id: a.id, answers }); removeApproval(a.id); resolveAttention(a.id); els.input.focus(); };
    const submit = () => { if (submitBtn.disabled) { return; } finish(qs.map((q, qi) => ({ question: q.question, selected: [...sel[qi]].sort((x, y) => x - y).map((oi) => q.options[oi].label), other: other[qi].trim() || undefined }))); };
    d.onclick = (ev) => { const b = ev.target.closest('[data-a], .opt[data-o]'); if (!b) { return; } if (b.dataset.o !== undefined) { pick(+b.dataset.q, +b.dataset.o); return; } if (b.dataset.a === 'open') { selectTab(a.sessionId); } else if (b.dataset.a === 'skip') { finish(null); } else if (b.dataset.a === 'submit') { submit(); } };
    d.querySelectorAll('input[data-q]').forEach((inp) => {
      inp.oninput = () => { const qi = +inp.dataset.q; other[qi] = inp.value; if (!qs[qi].multiSelect && inp.value.trim()) { sel[qi].clear(); } sync(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); inp.blur(); } };
    });
    const key = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || els.approvals.firstElementChild !== d) { return; }
      // Esc skips only from inside the card; Esc in the composer keeps meaning "stop the run".
      if (!promptKeyTarget(d, e) || (e.key === 'Escape' && !d.contains(e.target))) { return; }
      if (/^[1-9]$/.test(e.key)) { const qi = qs.findIndex((_, i) => !answered(i)); const at = qi < 0 ? qs.length - 1 : qi; const oi = +e.key - 1; if (qs[at] && qs[at].options && oi < qs[at].options.length) { pick(at, oi); e.preventDefault(); e.stopPropagation(); } return; }
      if (e.key === 'Enter' && !submitBtn.disabled) { e.preventDefault(); e.stopPropagation(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    document.addEventListener('keydown', key, true);
    d._dispose = () => document.removeEventListener('keydown', key, true);
    els.approvals.appendChild(d);
    sync();
    offerPromptFocus(d, () => d.querySelector('.opt[data-o]') || d.querySelector('input[data-q]'), '<kbd>1</kbd>–<kbd>9</kbd>');
    els.approvals.parentElement.scrollTop = 0;
    if (state.session && state.session.id === a.sessionId) { scrollToBottom(false); }
  }

  // ------------------------------------------------------------------ task header
  // A card under the tab strip: the chat's first prompt (clamped, click to expand), where it runs, what it has cost so
  // far, and Copy / Delete. Whether the card is folded is remembered in the webview state.
  const taskHead = el('section', 'taskhead hidden');
  taskHead.setAttribute('aria-label', 'Task');
  els.messages.before(taskHead);
  /** sessionId → the folder the chat works in (its worktree, else the workspace), from the `session` message. */
  const taskCwd = new Map();
  /** Chats whose prompt is shown in full instead of clamped. */
  const taskOpen = new Set();
  const viewState = () => (typeof vscode.getState === 'function' && vscode.getState()) || {};
  // Folded by default (one line); expanding is the reader's choice and is remembered.
  function headCollapsed() { return viewState().taskHeadExpanded !== true; }
  function setHeadCollapsed(v) { if (typeof vscode.setState === 'function') { vscode.setState({ ...viewState(), taskHeadExpanded: !v }); } }
  // While the first prompt is on screen as a turn, the card would only repeat it: it steps aside until that turn scrolls away.
  let firstTurnEl = null;
  const firstTurnIo = window.IntersectionObserver ? new IntersectionObserver((entries) => {
    for (const en of entries) { if (en.target === firstTurnEl) { setAway(en.isIntersecting); } }
    scheduleSticky();
  }, { root: els.messages }) : null;
  function firstTurnOf(s) {
    if (!s) { return null; }
    const idx = (s.messages || []).findIndex((x) => x.role === 'user' && !(x.meta && x.meta.summary));
    const el0 = idx >= 0 ? els.messages.querySelector(`:scope > .turn.user[data-index="${idx}"]`) : null;
    // A just-sent first message is drawn before the host numbers it.
    if (el0) { return el0; }
    const lone = els.messages.querySelector(':scope > .turn.user');
    return lone && lone.dataset.index === 'undefined' && !els.messages.querySelector(':scope > .turn.user[data-index]:not([data-index="undefined"])') ? lone : null;
  }
  function watchFirstTurn() {
    const t = firstTurnOf(state.session);
    if (t === firstTurnEl) { return; }
    if (firstTurnIo && firstTurnEl) { firstTurnIo.unobserve(firstTurnEl); }
    firstTurnEl = t; setAway(false);
    if (firstTurnIo && t) { firstTurnIo.observe(t); }
  }
  if (window.MutationObserver) { new MutationObserver(watchFirstTurn).observe(els.messages, { childList: true }); }
  /** Scrolling settles it at once too: the observer reports on its own schedule, the sticky row decides now. */
  function syncFirstTurnShown() {
    if (!firstTurnEl || !firstTurnEl.isConnected) { return; }
    const r = firstTurnEl.getBoundingClientRect(); const v = els.messages.getBoundingClientRect();
    setAway(r.bottom > v.top && r.top < v.bottom);
  }
  /** Shows or hides the card without moving the transcript: the scroll offset absorbs the card's height. */
  function setAway(v) {
    if (taskHead.classList.contains('away') === v) { return; }
    const m = els.messages; const before = m.getBoundingClientRect().top;
    taskHead.classList.toggle('away', v);
    m.scrollTop += m.getBoundingClientRect().top - before;
  }
  /** True while the card stands for the first prompt (shown, not stepped aside): the sticky row then leaves that turn to it. */
  function taskHeadCovers(turn) { return turn === firstTurnEl && !taskHead.classList.contains('hidden') && !taskHead.classList.contains('away'); }
  function firstPrompt(s) {
    const m = (s.messages || []).find((x) => x.role === 'user' && !(x.meta && x.meta.summary));
    if (!m) { return ''; }
    return String((m.meta && m.meta.display) || m.content || '')
      .replace(/<attachment[^>]*>[\s\S]*?<\/attachment>\s*/g, '')
      .replace(/<(workspace_tree|problems|git|open_editors|directory|terminal_output)[^>]*>[\s\S]*?<\/\1>\s*/g, '')
      .replace(/\n\n\[\d+ images? attached\]$/, '').trim();
  }
  const leaf = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  function renderTaskHead() {
    const s = state.session; const prompt = s ? firstPrompt(s) : '';
    if (!prompt) { taskHead.classList.add('hidden'); taskHead.innerHTML = ''; taskHead.__sig = ''; return; }
    const collapsed = headCollapsed(); const open = taskOpen.has(s.id);
    const u = chatUsage(); const p = usageParts(u); const local = usageModelIsLocal(u);
    const row = state.sessions.find((x) => x.id === s.id); const bytes = row && row.bytes;
    const wt = s.worktree; const cwd = taskCwd.get(s.id) || '';
    const sig = JSON.stringify([s.id, prompt, collapsed, open, p, local, wt && wt.path, cwd, bytes, s.title]);
    if (sig === taskHead.__sig) { return; }
    taskHead.__sig = sig;
    const where = wt
      ? `<span class="badge iso" title="Isolated worktree: ${esc(wt.path)}${wt.base ? `\nStarted from ${esc(String(wt.base).slice(0, 10))}` : ''}">${I.git}<span>isolated: ${esc(leaf(wt.path))}</span></span>`
      : cwd ? `<span class="badge" title="Working folder: ${esc(cwd)}">${I.folder}<span>${esc(leaf(cwd))}</span></span>` : '';
    const tok = p ? `<span class="pill" title="${esc(usageText(u))}">↑${fmtTok(p.input)} ↓${fmtTok(p.output)}</span>` : '';
    const cost = p && p.cost !== undefined && !local ? `<span class="pill cost" title="Cost reported by the provider">${fmtUsd(p.cost)}</span>` : '';
    taskHead.className = `taskhead${collapsed ? ' collapsed' : ''}${taskHead.classList.contains('away') ? ' away' : ''}`;
    taskHead.innerHTML = `<div class="th-row"><button class="th-toggle" aria-expanded="${!collapsed}" title="${collapsed ? 'Show the task' : 'Fold the task away'}"><span class="chev">${I.chev}</span><span class="th-k">Task</span></button>`
      + `<span class="th-line"${collapsed ? ` title="${esc(prompt.slice(0, 400))}"` : ''}>${collapsed ? esc(prompt.split('\n')[0]) : ''}</span>${collapsed && !wt ? '' : where}${tok}${cost}`
      + `<button class="ib" data-th="copy" title="Copy the task" aria-label="Copy the task">${I.copy}</button>`
      + `<button class="ib" data-th="delete" title="Delete this chat${bytes ? ` (${fmtBytes(bytes)} on disk)` : ''}" aria-label="Delete this chat${bytes ? `, ${fmtBytes(bytes)} on disk` : ''}">${I.trash}</button></div>`
      + (collapsed ? '' : `<div class="th-text${open ? ' open' : ''}" tabindex="0" role="button" aria-expanded="${open}">${inline(prompt).replace(/\n/g, '<br>')}</div>`);
    const t = taskHead.querySelector('.th-text');
    // Only a prompt that overflows the clamp fades out and expands on click.
    if (t && !open) { requestAnimationFrame(() => { const over = t.scrollHeight > t.clientHeight + 2; t.classList.toggle('clamped', over); t.title = over ? 'Click to show the whole prompt' : ''; }); }
    if (t && open) { t.title = 'Click to clamp'; }
  }
  function toggleTaskText() {
    const s = state.session; const t = taskHead.querySelector('.th-text'); if (!s || !t) { return; }
    if (!t.classList.contains('clamped') && !taskOpen.has(s.id)) { return; }
    if (taskOpen.has(s.id)) { taskOpen.delete(s.id); } else { taskOpen.add(s.id); }
    renderTaskHead();
  }
  taskHead.addEventListener('click', (e) => {
    const s = state.session; if (!s) { return; }
    if (e.target.closest('.th-toggle')) { setHeadCollapsed(!headCollapsed()); renderTaskHead(); return; }
    const b = e.target.closest('[data-th]');
    if (b && b.dataset.th === 'copy') { copyTo(b, firstPrompt(s)); return; }
    if (b && b.dataset.th === 'delete') {
      const title = s.title || 'New chat'; const running = state.running.has(s.id);
      openMenu(b, [
        { label: `Delete “${title.length > 32 ? `${title.slice(0, 31)}…` : title}”`, desc: running ? 'Stops the agent and deletes everything' : 'Permanently removes this chat', icon: I.trash, onPick: () => { if (state.openTabs) { state.openTabs.delete(s.id); saveState(); } post({ type: 'deleteSession', id: s.id }); } },
        { label: 'Cancel', icon: I.x },
      ]);
      return;
    }
    const link = e.target.closest('.path-link'); if (link) { post({ type: 'openFile', path: link.dataset.path, line: link.dataset.line ? Number(link.dataset.line) : undefined, sessionId: s.id }); return; }
    if (e.target.closest('.th-text') && !String(window.getSelection() || '')) { toggleTaskText(); }
  });
  taskHead.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('th-text')) { e.preventDefault(); toggleTaskText(); } });

  // ------------------------------------------------------------------ context meter: breakdown and compact confirmation
  /** Chat preferences from the host (`uiPrefs`): tips, the auto-compact threshold and the What's new card. */
  const uiPrefs = { showTips: true, compactionThreshold: 0.75, autoCompact: true, whatsNew: null };
  const ctxCard = el('div', 'ctxcard hidden'); ctxCard.id = 'ctxCard'; ctxCard.setAttribute('role', 'tooltip');
  document.body.appendChild(ctxCard);
  els.ctx.setAttribute('aria-describedby', 'ctxCard');
  /** '' hidden · 'hover' the breakdown · 'confirm' the "Compact this chat?" question. */
  let ctxMode = '';
  function ctxRows() {
    const c = state.ctxInfo; if (!c) { return ''; }
    const u = chatUsage(); const n = (v) => Number(v || 0).toLocaleString();
    const row = (k, v, cls) => `<div class="r${cls ? ` ${cls}` : ''}"><span>${k}</span><b>${v}</b></div>`;
    let h = `<div class="h">Context</div>${row('Used', `${n(c.used)} · ${c.pct}%`)}${row('Window', n(c.win))}${row('Remaining', n(Math.max(0, c.win - c.used)))}`;
    if (u && u.requests) {
      h += `<div class="h">This chat</div>${row('Prompt tokens', n(u.promptTokens))}${row('Output tokens', n(u.completionTokens))}`;
      if (u.cacheReadTokens || u.cacheWriteTokens) { h += row('Cache read', n(u.cacheReadTokens)) + row('Cache write', n(u.cacheWriteTokens)); }
    }
    const at = Math.round(uiPrefs.compactionThreshold * 100);
    h += row('Auto-compact', uiPrefs.autoCompact ? `at ${at}% · ${n(Math.round(c.win * uiPrefs.compactionThreshold))}` : 'off', 'sep');
    if (c.compactions) { h += row('Compacted', `${c.compactions}×`); }
    if (c.native) { h += ctxRaiseNote(c); }
    return h;
  }
  /** The model can take more than the Context window setting gives it: say so, with the way to raise it. */
  function ctxRaiseNote(c) {
    return `<div class="note">The model supports ${fmtTok(c.native)} tokens; this chat gets ${fmtTok(c.win)}. <button class="link" data-c="raise" title="Settings → Models → Context window">Raise context window…</button></div>`;
  }
  function placeCtxCard() {
    const r = els.ctx.getBoundingClientRect(); const w = ctxCard.offsetWidth; const h = ctxCard.offsetHeight;
    ctxCard.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    ctxCard.style.top = `${r.top - h - 6 >= 8 ? r.top - h - 6 : r.bottom + 6}px`;
  }
  function showCtxCard(mode) {
    if (!state.session || !state.ctxInfo || els.ctx.classList.contains('hidden')) { return; }
    ctxMode = mode;
    const busy = state.running.has(state.session.id);
    ctxCard.setAttribute('role', mode === 'confirm' ? 'dialog' : 'tooltip');
    ctxCard.classList.toggle('confirm', mode === 'confirm');
    if (mode === 'confirm') { ctxCard.setAttribute('aria-label', 'Compact this chat?'); } else { ctxCard.removeAttribute('aria-label'); }
    ctxCard.innerHTML = mode === 'confirm'
      ? `<div class="q"><b>Compact this chat?</b> Older messages are summarised to free up context. The latest turns are kept as they are.</div>${state.ctxInfo.native ? ctxRaiseNote(state.ctxInfo) : ''}<div class="acts"><button class="btn" data-c="cancel">Cancel</button><button class="btn primary" data-c="compact">Compact</button></div>`
      : `${ctxRows()}<div class="hint">${busy ? 'You can compact once the agent finishes' : 'Click to compact now'}</div>`;
    ctxCard.classList.remove('hidden'); placeCtxCard();
    if (mode === 'confirm') { ctxCard.querySelector('[data-c="compact"]').focus(); }
  }
  function hideCtxCard() { ctxMode = ''; ctxCard.classList.add('hidden'); }
  function refreshCtxCard() { if (ctxMode === 'hover') { showCtxCard('hover'); } }
  function openCtxConfirm() {
    if (!state.session) { return; }
    if (state.running.has(state.session.id)) { showCtxCard('hover'); return; }
    if (ctxMode === 'confirm') { hideCtxCard(); return; }
    showCtxCard('confirm');
  }
  const ctxHover = () => { if (ctxMode !== 'confirm') { showCtxCard('hover'); } };
  // A short grace period lets the pointer cross to the card (it holds the Raise context window link) without it closing.
  const ctxLeave = () => { setTimeout(() => { if (ctxMode === 'hover' && !ctxCard.matches(':hover') && !els.ctx.matches(':hover') && !ctxCard.contains(document.activeElement) && document.activeElement !== els.ctx) { hideCtxCard(); } }, 150); };
  ctxCard.addEventListener('mouseleave', ctxLeave); ctxCard.addEventListener('focusout', ctxLeave);
  els.ctx.addEventListener('mouseenter', ctxHover); els.ctx.addEventListener('focus', ctxHover);
  els.ctx.addEventListener('mouseleave', ctxLeave); els.ctx.addEventListener('blur', ctxLeave);
  ctxCard.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) { return; }
    if (b.dataset.c === 'compact' && state.session && !state.running.has(state.session.id)) { post({ type: 'compactNow', sessionId: state.session.id }); }
    if (b.dataset.c === 'raise') { hideCtxCard(); post({ type: 'openSettings', section: 'models' }); return; }
    hideCtxCard(); els.input.focus();
  });
  ctxCard.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideCtxCard(); els.ctx.focus(); } });
  document.addEventListener('mousedown', (e) => { if (ctxMode === 'confirm' && !ctxCard.contains(e.target) && !els.ctx.contains(e.target)) { hideCtxCard(); } });
  window.addEventListener('resize', () => { if (ctxMode) { hideCtxCard(); } });

  // ------------------------------------------------------------------ tips while the agent thinks, What's new
  function tips() {
    const mod = state.platform === 'darwin' ? '⌘' : 'Ctrl+'; const alt = state.platform === 'darwin' ? '⌥' : 'Alt+';
    return [
      'Type while the agent works to steer it: your message is read at its next step.',
      'The send menu while busy has <b>Send after this turn</b>, which queues a message for when the run ends.',
      '<b>@</b> adds files, folders, <code>@problems</code>, <code>@git</code> or the last terminal output as context.',
      '<code>/compact</code> summarises older messages when the context ring fills up.',
      'Hover the context ring for a token breakdown; click it to compact.',
      'Every message gets a checkpoint: <b>Restore checkpoint</b> puts back the files, the chat or both.',
      'Click a message you sent to edit it, then rewind and resend from there.',
      '<b>Multitask</b> mode splits the work across background workers that run at the same time.',
      '<b>Best of N</b> runs one prompt on several models side by side; apply the best result.',
      `<kbd>${kb('Mod+Shift+Enter')}</kbd> sends the draft in a new tab: another agent, in parallel.`,
      'Select text in an answer and click <b>Quote</b> to reply to just that part.',
      `<kbd>${mod}.</kbd> in the composer (or <kbd>${kb('Shift+Tab')}</kbd> with a draft) cycles Agent, Multitask, Debug, Plan and Ask.`,
      '<b>Plan</b> mode investigates read-only and prepares a checklist you build with one click.',
      `<kbd>${alt}Esc</kbd> pauses after the current step; <kbd>Esc</kbd> stops the agent.`,
      `<kbd>${mod}I</kbd> rewrites your draft into a precise request without sending it.`,
      'Drag files from the Explorer onto the composer to mention them.',
      'Paste a screenshot to show a vision model what you see.',
      'Project rules in <code>AGENTS.md</code> or <code>.localpilot/rules</code> are followed in every chat.',
      '<code>/skill &lt;name&gt; …</code> runs a task with a skill; <code>/skills</code> lists them.',
      '<code>/newtask</code> continues in a fresh chat that starts from a summary of this one.',
      'Long answers open as a document in the Markdown reader: the <b>Open as document</b> button.',
      `<kbd>${alt}↑</kbd> / <kbd>${alt}↓</kbd> switch between chat tabs.`,
    ];
  }
  const tipRow = el('div', 'tiprow hidden', `<span class="k">Tip</span><span class="t"></span><button class="ib tip-x" title="Hide tips" aria-label="Hide tips" aria-haspopup="menu">${I.x}</button>`);
  tipRow.setAttribute('role', 'note');
  els.status.after(tipRow);
  let tipsHidden = false;
  tipRow.querySelector('.tip-x').onclick = (e) => openMenu(e.currentTarget, [
    { label: 'Hide for this session', desc: 'Tips come back when the chat view reloads', icon: I.x, onPick: () => { tipsHidden = true; tipRow.classList.add('hidden'); } },
    { label: 'Turn tips off', desc: 'Change it in Settings → Agent & approvals', icon: I.gear, onPick: () => { tipsHidden = true; tipRow.classList.add('hidden'); post({ type: 'setTipsEnabled', enabled: false }); } },
  ], { label: 'Hide tips' });
  let thinkingSince = 0; let tipShownAt = 0; let tipIdx = Math.floor(Math.random() * 22);
  /** The model is working on its answer: reasoning streams, or the typing dots wait for its first token. Not when paused or asking. */
  function agentThinking() {
    const s = state.session; if (!s || !state.running.has(s.id) || els.approvals.children.length) { return false; }
    const p = state.paused.get(s.id); if (p && p.paused) { return false; }
    const live = state.live.get(s.id);
    return !!(live && (live.thinkingEl || live.body.querySelector('.typing')));
  }
  setInterval(() => {
    if (!uiPrefs.showTips || tipsHidden || !agentThinking()) { thinkingSince = 0; tipRow.classList.add('hidden'); return; }
    const now = Date.now(); if (!thinkingSince) { thinkingSince = now; }
    if (now - thinkingSince < 4000) { return; }
    if (tipRow.classList.contains('hidden') || now - tipShownAt > 9000) {
      const list = tips(); tipIdx = (tipIdx + 1) % list.length;
      tipRow.querySelector('.t').innerHTML = list[tipIdx]; tipShownAt = now; tipRow.classList.remove('hidden');
    }
  }, 1000);
  function whatsNewCard() {
    const w = uiPrefs.whatsNew; if (!w || !Array.isArray(w.bullets) || !w.bullets.length) { return null; }
    const c = el('div', 'whatsnew', `<div class="wn-h"><b>What's new in v${esc(w.version)}</b><button class="ib" data-w="close" title="Dismiss" aria-label="Dismiss what's new">${I.x}</button></div><ul>${w.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul><button class="wn-log" data-w="log">Open changelog</button>`);
    c.setAttribute('role', 'note'); c.setAttribute('aria-label', `What's new in version ${w.version}`);
    c.onclick = (e) => {
      const b = e.target.closest('[data-w]'); if (!b) { return; }
      if (b.dataset.w === 'log') { post({ type: 'openChangelog' }); return; }
      uiPrefs.whatsNew = null; c.remove(); post({ type: 'dismissWhatsNew' });
    };
    return c;
  }

  // ------------------------------------------------------------------ answers: path links that exist, Mermaid diagrams
  // Settled answers are scanned shortly after they land (a mutation observer, so every render path is covered): path
  // links are checked in one batch per scan, and links to files that do not exist become plain code.
  const scriptNonce = (document.currentScript && document.currentScript.nonce) || '';
  /** `<sessionId>\0<path>` → whether it exists. */
  const pathKnown = new Map();
  let pathSeq = 0; let enhanceTimer = 0;
  new MutationObserver(() => { if (!enhanceTimer) { enhanceTimer = setTimeout(enhanceAnswers, 120); } }).observe(els.messages, { childList: true, subtree: true });
  function enhanceAnswers() {
    enhanceTimer = 0;
    const sid = state.session && state.session.id; if (!sid) { return; }
    const ask = new Set();
    for (const link of els.messages.querySelectorAll('.turn.assistant:not(.live) > .body .path-link:not([data-ck])')) {
      const p = link.dataset.path; if (!p) { continue; }
      const known = pathKnown.get(`${sid}\u0000${p}`);
      if (known === undefined) { if (ask.size < 200) { ask.add(p); link.dataset.ck = 'wait'; } } else { settlePathLink(link, known); }
    }
    if (ask.size) { post({ type: 'pathsExist', seq: ++pathSeq, sessionId: sid, paths: [...ask] }); }
    for (const block of els.messages.querySelectorAll('.turn.assistant:not(.live) > .body .code[data-lang="mermaid"]:not([data-mm])')) { block.dataset.mm = '1'; mermaidFigure(block); }
  }
  function settlePathLink(link, exists) {
    if (exists) { link.dataset.ck = '1'; return; }
    if (link.closest('.code-head')) { link.classList.remove('path-link'); link.dataset.ck = '0'; link.title = 'Not in the workspace yet'; return; }
    const c = document.createElement('code'); c.className = 'nopath'; c.textContent = link.textContent; c.title = 'No such file in the workspace';
    link.replaceWith(c);
  }
  function applyPathChecks(m) {
    const sid = m.sessionId || (state.session && state.session.id); if (!sid || !m.exists) { return; }
    for (const [p, ok] of Object.entries(m.exists)) { pathKnown.set(`${sid}\u0000${p}`, !!ok); }
    if (!state.session || state.session.id !== sid) { return; }
    for (const link of els.messages.querySelectorAll('.path-link[data-ck="wait"]')) {
      const known = pathKnown.get(`${sid}\u0000${link.dataset.path}`);
      if (known !== undefined) { settlePathLink(link, known); }
    }
  }
  let mermaidLoad = null; let mermaidQueue = Promise.resolve(); let mermaidSeq = 0;
  function loadMermaid() {
    if (window.mermaid) { return Promise.resolve(window.mermaid); }
    const src = document.body.dataset.mermaid; if (!src) { return Promise.reject(new Error('Mermaid is not bundled')); }
    if (!mermaidLoad) {
      mermaidLoad = new Promise((resolve, reject) => {
        const s = document.createElement('script'); s.nonce = scriptNonce; s.src = src;
        s.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('Mermaid did not load')));
        s.onerror = () => { mermaidLoad = null; reject(new Error('Mermaid could not be loaded')); };
        document.head.appendChild(s);
      });
    }
    return mermaidLoad;
  }
  function mermaidTheme() {
    const c = document.body.classList;
    if (c.contains('vscode-high-contrast-light')) { return 'base'; }
    return c.contains('vscode-dark') || c.contains('vscode-high-contrast') ? 'dark' : 'default';
  }
  /** Wraps a ```mermaid block in a figure; the diagram replaces the source once drawn, and the source stays one click away. */
  function mermaidFigure(block) {
    const source = (block.querySelector('pre') || {}).textContent || '';
    if (!source.trim()) { return; }
    const fig = el('figure', 'mermaid'); fig.dataset.source = source;
    block.before(fig); fig.appendChild(block);
    fig.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fig]'); if (!b) { return; }
      if (b.dataset.fig === 'copy') { copyTo(b, source); }
      else if (b.dataset.fig === 'open') { post({ type: 'openMarkdown', text: `\`\`\`mermaid\n${source}\n\`\`\`\n`, title: `${(state.session && state.session.title) || 'Chat'} · diagram` }); }
      else if (b.dataset.fig === 'src') { block.hidden = !block.hidden; b.setAttribute('aria-pressed', String(!block.hidden)); }
    });
    drawMermaid(fig);
  }
  function drawMermaid(fig) {
    mermaidQueue = mermaidQueue.then(async () => {
      if (!fig.isConnected) { return; }
      const block = fig.querySelector(':scope > .code'); const source = fig.dataset.source || '';
      let mermaid;
      try { mermaid = await loadMermaid(); } catch { fig.classList.add('unavailable'); return; }
      const font = getComputedStyle(document.body).getPropertyValue('--vscode-font-family').trim() || 'sans-serif';
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mermaidTheme(), fontFamily: font });
      const id = `lp-chat-mermaid-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, source);
        let holder = fig.querySelector(':scope > .mermaid-svg');
        if (!holder) {
          fig.insertAdjacentHTML('afterbegin', `<div class="fig-bar"><span class="lbl">Diagram</span><span class="spacer"></span><button data-fig="src" aria-pressed="false" title="Show the Mermaid source">Source</button><button data-fig="copy" title="Copy the Mermaid source">${I.copy}<span>Copy source</span></button><button data-fig="open" title="Open in the Markdown reader">${I.open}<span>Open in reader</span></button></div><div class="mermaid-svg" role="img" aria-label="Mermaid diagram"></div>`);
          holder = fig.querySelector(':scope > .mermaid-svg');
        }
        holder.innerHTML = svg; fig.classList.add('drawn'); fig.querySelector(':scope > .mermaid-error')?.remove();
        if (block) { block.hidden = true; }
      } catch (err) {
        document.getElementById(`d${id}`)?.remove(); document.getElementById(id)?.remove();
        let e = fig.querySelector(':scope > .mermaid-error');
        if (!e) { e = el('div', 'mermaid-error'); fig.prepend(e); }
        e.textContent = `Mermaid: ${(err && err.message ? err.message : String(err)).split('\n').slice(0, 3).join(' ')}`;
        if (block) { block.hidden = false; }
      }
    }).catch(() => undefined);
  }
  let chatTheme = mermaidTheme();
  new MutationObserver(() => {
    const t = mermaidTheme(); if (t === chatTheme) { return; }
    chatTheme = t; els.messages.querySelectorAll('figure.mermaid.drawn').forEach(drawMermaid);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // ------------------------------------------------------------------ accessibility
  for (const b of [els.modeBtn, els.modelBtn, els.skillsBtn, $('thinkBtn'), els.btnComposerMore]) { if (b) { b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false'); } }
  /** Says "3 of 12: /compact" in an assertive live region as the selection in a menu moves. */
  function srAnnounce(text) {
    let r = document.getElementById('srLive');
    if (!r) { r = el('div', 'sr-only'); r.id = 'srLive'; r.setAttribute('aria-live', 'assertive'); r.setAttribute('aria-atomic', 'true'); document.body.appendChild(r); }
    r.textContent = ''; requestAnimationFrame(() => { r.textContent = text; });
  }
  /** Listbox semantics for openMenu: the focused control (composer, search box or list) points at the selected option. */
  function menuA11y(anchor, search, list) {
    if (!menuState) { return; }
    const items = menuState.items; const x = items[menuState.sel];
    items.forEach((y, i) => y.row.setAttribute('aria-selected', String(i === menuState.sel)));
    const owner = anchor === els.box ? els.input : search || list;
    if (search) { search.setAttribute('role', 'combobox'); search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-autocomplete', 'list'); }
    if (owner !== list) { owner.setAttribute('aria-controls', list.id); }
    if (x) { owner.setAttribute('aria-activedescendant', x.row.id); } else { owner.removeAttribute('aria-activedescendant'); }
    const prev = els.popover._anchor; if (prev && prev !== anchor) { prev.setAttribute('aria-expanded', 'false'); els.popover._anchor = null; }
    if (anchor && anchor.setAttribute && anchor !== els.box) { anchor.setAttribute('aria-expanded', 'true'); els.popover._anchor = anchor; }
    const label = x ? plainLabel(x.it.labelHtml || esc(x.it.label || '')) : '';
    const said = items.length ? `${menuState.sel + 1} of ${items.length}: ${label}` : 'No matches';
    if (said !== els.popover._said) { els.popover._said = said; srAnnounce(said); }
  }
  function menuA11yClose() {
    els.input.removeAttribute('aria-activedescendant'); els.input.removeAttribute('aria-controls');
    const a = els.popover._anchor; if (a) { a.setAttribute('aria-expanded', 'false'); els.popover._anchor = null; }
    els.popover._said = '';
  }
  // Escape anywhere in the chat stops the run when nothing else claims it (a menu, an approval, a text field, the lightbox).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) { return; }
    if (ctxMode) { e.preventDefault(); hideCtxCard(); return; }
    if (menuState || els.approvals.children.length || e.target === els.input || (els.tabs.contains(e.target) && state.selected.size)) { return; }
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], .popover')) { return; }
    const lb = document.getElementById('lightbox'); if (lb && !lb.classList.contains('hidden')) { return; }
    const s = state.session; if (!s || !state.running.has(s.id)) { return; }
    e.preventDefault(); post({ type: 'stop', sessionId: s.id }); srAnnounce('Stopping the agent');
  }, true);
  // Collapsing a group (a finished thought, an explore group) must not leave a reader who was following the end behind.
  els.messages.addEventListener('toggle', (e) => { if (!e.target.open && stickToBottom) { requestAnimationFrame(() => scrollToBottom(false)); } }, true);

  // The extras above follow the same messages as the main handler (which runs first: it was registered earlier).
  window.addEventListener('message', (ev) => {
    const m = ev.data; if (!m || typeof m !== 'object' || typeof m.type !== 'string') { return; }
    try {
      switch (m.type) {
        case 'uiPrefs': {
          const had = !!uiPrefs.whatsNew;
          Object.assign(uiPrefs, { showTips: m.showTips !== false, compactionThreshold: Number(m.compactionThreshold) || 0.75, autoCompact: m.autoCompact !== false, whatsNew: m.whatsNew || null });
          refreshCtxCard();
          if (had !== !!uiPrefs.whatsNew && state.session && !(state.session.messages || []).length) { renderSession(); }
          break;
        }
        case 'pathsExistResult': applyPathChecks(m); break;
        case 'session': if (m.session) { taskCwd.set(m.session.id, m.cwd || ''); } if (ctxMode === 'confirm') { hideCtxCard(); } renderTaskHead(); break;
        case 'sessions': renderTaskHead(); break;
        case 'running':
          if (state.session && state.session.id === m.sessionId) { if (m.running && ctxMode === 'confirm') { hideCtxCard(); } updateCtx(); }
          // A finished run may have created files an earlier answer named: check those links again on the next render.
          if (!m.running) { for (const [k, v] of pathKnown) { if (!v && k.startsWith(`${m.sessionId}\u0000`)) { pathKnown.delete(k); } } }
          break;
      }
    } catch (err) { reportError(`message '${m.type}' (extras)`, err); }
  });

  updateSendEnabled();
  requestInit();
})();
