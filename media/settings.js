// LocalPilot settings + first-run setup webview. Vanilla JS; all writes go through the extension host (validated there).
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const LOGO = document.body.dataset.logo;
  const post = (m) => vscode.postMessage(m);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };
  /** Placeholder shapes while a list or the dashboard loads: a status line for screen readers plus shimmering rows. */
  const skeleton = (text, rows = 3, kind = 'rows') => el('div', `skel ${kind}`, `<div class="loading short" role="status"><span class="spinner"></span>${text}</div>${kind === 'kpis'
    ? `<div class="kpis">${'<div class="kpi skel-card"><i class="skl skl-l"></i><i class="skl skl-v"></i><i class="skl skl-s"></i></div>'.repeat(rows)}</div>`
    : '<div class="skel-row"><i class="skl skl-ic"></i><span><i class="skl skl-t"></i><i class="skl skl-s"></i></span></div>'.repeat(rows)}`);
  const I = {
    server: '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2"/><rect x="2" y="9" width="12" height="4.5" rx="1.2"/><path d="M4.5 4.8h.01M4.5 11.3h.01"/></svg>',
    cpu: '<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/><rect x="6.5" y="6.5" width="3" height="3"/><path d="M6 2v2M10 2v2M6 12v2M10 12v2M2 6h2M2 10h2M12 6h2M12 10h2"/></svg>',
    shield: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5 2v4c0 3-2.2 5.3-5 6.5-2.8-1.2-5-3.5-5-6.5v-4z"/><path d="M5.8 8l1.5 1.5L10.5 6"/></svg>',
    lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
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
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
    gallery: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><path d="M11.5 9.5v5M9 12h5"/></svg>',
    external: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
    cloud: '<svg viewBox="0 0 16 16"><path d="M5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12.3 7.6 2.5 2.5 0 0 1 12 12.5z"/></svg>',
    gauge: '<svg viewBox="0 0 16 16"><path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l2.5-4"/><path d="M2 13.5h12"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/></svg>',
    pulse: '<svg viewBox="0 0 16 16"><path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4"/></svg>',
    warn: '<svg viewBox="0 0 16 16"><path d="M8 2.2l6.3 11.3H1.7z"/><path d="M8 6.6v3.2M8 11.7h.01"/></svg>',
    gear: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/></svg>',
    scale: '<svg viewBox="0 0 16 16"><path d="M8 2.5v11M5.5 13.5h5M3 4.5h10"/><path d="M3 4.5l-1.8 4.2a1.9 1.9 0 0 0 3.6 0zM13 4.5l-1.8 4.2a1.9 1.9 0 0 0 3.6 0z"/></svg>',
    pause: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>',
    copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
    eye: '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    edit: '<svg viewBox="0 0 16 16"><path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/><path d="M9 4.5l2.5 2.5"/></svg>',
    keyboard: '<svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7"/></svg>',
    eyeOff: '<svg viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5l11-11"/></svg>',
  };
  const SECTIONS = [
    ['providers', 'Providers', I.server], ['models', 'Models', I.cpu], ['gallery', 'Model gallery', I.gallery], ['skills', 'Skills & subagents', I.book], ['marketplace', 'Marketplace', I.download], ['customize', 'Customize', I.scale], ['agent', 'Agent & approvals', I.shield], ['completions', 'Inline completions', I.ghost],
    ['web', 'Web search', I.globe], ['documents', 'Markdown & PDF', I.file], ['memory', 'Memory & history', I.brain], ['mcp', 'MCP servers', I.plug], ['dashboard', 'Dashboard', I.gauge], ['telemetry', 'Telemetry', I.pulse], ['shortcuts', 'Keyboard shortcuts', I.keyboard], ['advanced', 'Advanced', I.wrench],
  ];
  /** Sidebar order: the Dashboard overview on top (never folds), then where models come from, how the agent behaves, what it can reach, and what it keeps. */
  const NAV_HOME = ['dashboard'];
  const NAV_GROUPS = [
    { id: 'models', label: 'Models', items: ['providers', 'models', 'gallery'] },
    { id: 'agent', label: 'Agent', items: ['agent', 'skills', 'marketplace', 'customize', 'completions'] },
    { id: 'tools', label: 'Tools & integrations', items: ['mcp', 'web', 'documents'] },
    { id: 'data', label: 'Data & system', items: ['memory', 'telemetry', 'shortcuts', 'advanced'] },
  ];
  /** Settings search. Sections match on their name plus these words; fields match on label and key and jump to the row
   *  (`field()` tags it with data-deps). Keep FIELD_INDEX in step with the field() calls of each section. */
  const SECTION_WORDS = {
    providers: 'ollama lm studio llama.cpp vllm openai anthropic claude gemini api key endpoint url cloud gateway connection server colibri',
    models: 'installed download pull routing context temperature thinking memory budget default model',
    gallery: 'catalog library hugging face docker hub download pull install gguf',
    skills: 'skill playbook subagent registry install',
    marketplace: 'marketplace browse install skills mcp servers plugins subagents agents catalog registry extensions add-ons',
    customize: 'rules commands hooks skills plugins agents.md claude.md cursorrules clinerules slash disable enable conditional paths globs hook scripts pretooluse taskstart taskcancel taskerror marketplace browse plugins',
    agent: 'approval permission terminal command edit delete network hooks worktree parallel instructions system prompt clarify diff preview patch checkpoint restore snapshot diagnostics errors compaction summarise trim shell zsh bash powershell profile detach background language english spanish chinese japanese translate locale tips conversation repos repositories monorepo multi-root self-healing recovery retry checks tests regression',
    completions: 'ghost text fim autocomplete tab suggestion',
    web: 'searxng brave tavily duckduckgo browser screenshot fetch internet offline online',
    documents: 'markdown reader preview mermaid outline toc front matter export pdf viewer zoom thumbnails page colours dark sepia scroll sync',
    memory: 'history chats notes retention transcripts',
    mcp: 'model context protocol server tools reconnect',
    dashboard: 'telemetry metrics usage logs redis stats throughput self-healing recovery failures root cause patches regression intervention',
    telemetry: 'telemetry metrics usage record retention redis otlp opentelemetry otel collector traces grafana langfuse export delete',
    advanced: 'setup welcome terminal cli settings.json logs chat location about',
    shortcuts: 'keyboard shortcuts keys keybindings hotkeys bindings change customize',
  };
  /** publisher.name from package.json, for the "@ext:" filter of VS Code's Settings editor. */
  const EXT_ID = 'localpilot.localpilot-agent';
  const FIELD_INDEX = [
    ['providers', 'colibri.path', 'colibri folder'], ['providers', 'colibri.model', 'Colibri model'], ['providers', 'colibri.port', 'Colibri port'], ['providers', 'colibri.modelsDir', 'Colibri models folder'], ['providers', 'colibri.backend', 'Colibri GPU backend'], ['providers', 'colibri.kvSlots', 'Parallel conversations'],
    ['models', 'models.autoSetup', 'Offer automatic setup'], ['models', 'routing.enabled', 'Route automatically'], ['models', 'models.autoTune', 'Learn from usage'],
    ['models', 'defaultModel', 'Default model for agent & chat'], ['models', 'inlineCompletion.model', 'Inline completions model'], ['models', 'routing.vision', 'Images model'],
    ['models', 'routing.reasoning', 'Plan mode model'], ['models', 'routing.fast', 'Read-only subagents model'], ['models', 'routing.coding', 'Implementing subagents model'],
    ['models', 'routing.parallelModels', 'Spread parallel work across models'], ['models', 'routing.fallbackModels', 'Fallback order'], ['models', 'firstTokenTimeoutSeconds', 'First-token wait limit'], ['mcp', 'mcp.toolApprovals', 'MCP tool approvals (per tool)'], ['models', 'contextWindow', 'Context window'], ['models', 'maxOutputTokens', 'Max output tokens'],
    ['models', 'temperature', 'Temperature'], ['models', 'thinking', 'Extended thinking'], ['models', 'keepAlive', 'Keep model loaded'], ['models', 'prewarm', 'Pre-load the model while you type'],
    ['models', 'ollama.flashAttention', 'Ollama flash attention'], ['models', 'ollama.kvCacheType', 'Ollama KV cache'],
    ['providers', 'providers', 'Providers'], ['mcp', 'mcpServers', 'MCP servers'], ['mcp', 'mcp.watchServerFiles', 'Restart MCP servers on file change'], ['providers', 'gateways.litellmConfig', 'LiteLLM config file'], ['models', 'models.disabled', 'Hidden models'],
    ['agent', 'autoMode.enabled', 'Review approvals with a local model (auto mode)'], ['agent', 'autoMode.model', 'Auto mode reviewer model'], ['agent', 'queue.concurrency', 'Queued tasks at once'],
    ['memory', 'memory.maxNoteChars', 'Largest memory note'], ['memory', 'memory.maxNotes', 'Memory notes per scope'],
    ['advanced', 'supervisor.enabled', 'Keep local services running'], ['advanced', 'supervisor.intervalSeconds', 'Service check interval'], ['advanced', 'supervisor.autoInstall', 'Install Ollama without asking'],
    ['skills', 'skillsPaths', 'Skill folders'], ['skills', 'skills.repositories', 'Skill repositories'], ['skills', 'skills.disabled', 'Disabled skills'], ['skills', 'pluginPaths', 'Plugin folders'],
    ['agent', 'approvals.terminal', 'Terminal commands approval'], ['agent', 'approvals.write', 'File edits approval'], ['agent', 'approvals.delete', 'Deleting files approval'],
    ['agent', 'approvals.network', 'Network approval'], ['agent', 'approvals.mcp', 'MCP tools approval'], ['agent', 'approvals.dangerousAlwaysAsk', 'Always ask before destructive commands'], ['agent', 'notifications', 'Notifications'], ['agent', 'terminal.runInIntegratedTerminal', 'Run commands in a visible terminal'], ['agent', 'terminal.reveal', 'Reveal the terminal when a command runs'],
    ['agent', 'autoClarify', 'Interpret vague requests automatically'], ['agent', 'prompts.autoCorrect', 'Correct misspelled names in requests'], ['agent', 'clarify.questions', 'Questions before starting'],
    ['agent', 'hooks.enabled', 'Run hooks'], ['agent', 'worktrees.mode', 'Where agents work'], ['agent', 'worktrees.location', 'Worktree folder'],
    ['agent', 'parallel.maxConcurrency', 'Max concurrent tools / subagents'], ['agent', 'parallel.maxSubagentDepth', 'Max subagent depth'], ['agent', 'compaction.strategy', 'Compaction strategy (when the context fills up)'], ['agent', 'compactionThreshold', 'Compact context at'],
    ['agent', 'maxToolOutputChars', 'Max tool output'], ['agent', 'systemPromptAppend', 'Extra instructions'],
    ['agent', 'terminal.profile', 'Shell for agent commands'], ['agent', 'terminal.shellIntegrationTimeout', 'Wait for shell integration (ms)'], ['agent', 'terminal.autoDetachSeconds', 'Continue while a command keeps running after (s)'],
    ['agent', 'preferredLanguage', 'Answer in (language)'], ['agent', 'showTips', 'Show tips while the agent thinks'], ['agent', 'repos', 'Extra repositories'],
    ['memory', 'memory.autoSave', 'Save what a run taught automatically'], ['memory', 'history.includeCli', 'Include chats from the terminal CLI'], ['customize', 'plugins.marketplaces', 'Plugin marketplaces'],
    ['agent', 'maxConsecutiveMistakes', 'Stop after errors in a row'], ['agent', 'disabledTools', 'Tools (switch tools off)'],
    ['agent', 'diffPreview', 'Show a diff of proposed edits'], ['agent', 'editTool', 'File-editing tool'], ['agent', 'edit.reportNewErrors', 'Tell the agent about errors its edit introduced'], ['agent', 'checkpoints.enabled', 'Checkpoint before each message'],
    ['completions', 'inlineCompletion.enabled', 'Enable inline completions'], ['completions', 'inlineCompletion.debounceMs', 'Debounce'], ['completions', 'inlineCompletion.maxTokens', 'Max tokens per suggestion'],
    ['web', 'webSearch.enabled', 'Let the agent use the internet'], ['web', 'webSearch.provider', 'Search provider'], ['web', 'webSearch.searxngUrl', 'SearXNG URL'], ['web', 'webSearch.apiKey', 'Web search API key'], ['web', 'webSearch.maxResults', 'Max results'],
    ['web', 'browser.chromePath', 'Browser for screenshots'],
    ['memory', 'sessions.retention', 'Keep at most (chats)'], ['memory', 'storage.sessionsInMemory', 'Transcripts in memory'], ['memory', 'memory.enabled', 'Enable memory'],
    ['skills', 'skills.autoInstall', 'Registry skills'], ['skills', 'skills.autoInstallScope', 'Install skills into'], ['skills', 'skills.builtin', 'Built-in skills'],
    ['telemetry', 'telemetry.enabled', 'Record usage metrics'], ['telemetry', 'telemetry.retentionDays', 'Keep metrics and logs for'], ['telemetry', 'storage.redis.enabled', 'Store telemetry in Redis'], ['telemetry', 'storage.redis.url', 'Redis URL'],
    ['telemetry', 'telemetry.otlp.enabled', 'Send telemetry to an OTLP collector'], ['telemetry', 'telemetry.otlp.endpoint', 'OTLP endpoint'], ['telemetry', 'telemetry.otlp.headers', 'OTLP headers'],
    ['telemetry', 'telemetry.otlp.metricsInterval', 'OTLP metric export interval'], ['telemetry', 'telemetry.otlp.exporters', 'OTLP exporters (logs, traces)'], ['telemetry', 'telemetry.otlp.traceSamplePercent', 'Trace sample percent'],
    ['telemetry', 'telemetry.otlp.recordContent', 'Include prompts and tool results on spans'],
    ['advanced', 'showWelcomeOnStartup', 'Show setup on first run'], ['advanced', 'chat.location', 'Chat location'],
    ['documents', 'markdownViewer.scrollSync', 'Keep reader and source scrolled together'], ['documents', 'markdownViewer.outlineDepth', 'Headings shown in the outline'], ['documents', 'markdownViewer.frontMatter', 'YAML front matter'],
    ['documents', 'markdownViewer.mermaid', 'Render Mermaid diagrams'], ['documents', 'markdownViewer.exportTheme', 'Export as HTML / PDF colours'],
    ['documents', 'pdfViewer.pageColors', 'PDF page colours'], ['documents', 'pdfViewer.sidebar', 'PDF sidebar on open'], ['documents', 'pdfViewer.defaultZoom', 'PDF default zoom'],
    ['documents', 'pdfViewer.rangeThresholdMB', 'Load PDF page by page above (MB)'], ['documents', 'pdfViewer.maxFileSizeMB', 'Ask before opening PDFs larger than (MB)'],
    ['documents', 'pdf.maxReadSizeMB', 'Largest PDF the agent may read (MB)'], ['documents', 'pdf.maxChars', 'Most PDF text per read (characters)'],
    ['agent', 'healing.enabled', 'Self-healing'], ['agent', 'healing.autoDetect', 'Detect failures at every step'], ['agent', 'healing.autoRetry', 'Retry transient failures'], ['agent', 'healing.autoFix', 'Fix failures automatically'],
    ['agent', 'healing.regressionRequired', 'Require the full relevant test suite to pass'], ['agent', 'healing.scopeTests', 'Run affected tests first'], ['agent', 'healing.delegateFixes', 'Fix independent failures in parallel'],
    ['agent', 'healing.maxRepairAttempts', 'Fix attempts per failure'], ['agent', 'healing.maxTotalAttempts', 'Recovery attempts per task'], ['agent', 'healing.extraSteps', 'Extra steps for recovery'], ['agent', 'healing.taskDeadlineMinutes', 'Recovery deadline'],
    ['agent', 'healing.checkTiming', 'When checks run'], ['agent', 'healing.checkTimeoutSeconds', 'Time limit per check'], ['agent', 'healing.checkTimeBudgetSeconds', 'Time limit per verification run'], ['agent', 'healing.baseline', 'Failures that were there before'],
    ['agent', 'healing.memory', 'Remember failures and fixes'], ['agent', 'healing.dependencyInstall', 'Installing missing packages'], ['agent', 'healing.securityCheck', 'Security check'], ['agent', 'healing.gitConflicts', 'Git conflicts'],
    ['agent', 'healing.checks', 'Checks'], ['agent', 'healing.policies', 'Retry policies'],
  ];
  /** Every query word must hit the entry; label-prefix hits rank first, then label, key, then section words. */
  function findSettings(q) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean); if (!words.length) { return []; }
    const secName = Object.fromEntries(SECTIONS.map(([id, label]) => [id, label]));
    const entries = [...SECTIONS.map(([id, label]) => ({ sec: id, label, hay: `${label} ${SECTION_WORDS[id] || ''}`.toLowerCase(), lbl: label.toLowerCase() })),
      ...FIELD_INDEX.map(([sec, key, label]) => ({ sec, key, label, hay: `${label} ${key} ${secName[sec] || ''}`.toLowerCase(), lbl: label.toLowerCase() }))];
    // Keys match only at word starts (camelCase / dots), so "temp" finds temperature but not sysTEMPromptAppend.
    const keyWords = (k) => (k || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s.]+/);
    return entries.filter((e) => words.every((w) => e.hay.replace(e.key ? e.key.toLowerCase() : '\0', '').includes(w) || keyWords(e.key).some((k) => k.startsWith(w))))
      .map((e) => ({ ...e, score: (e.lbl.startsWith(words[0]) ? 0 : e.lbl.includes(words[0]) ? 1 : 2) + (e.key ? 0 : .5) }))
      .sort((a, b) => a.score - b.score).slice(0, 8);
  }
  /** Remembered across reloads: collapsed groups and whether the sidebar is folded to icons. */
  const viewState = () => (typeof vscode.getState === 'function' && vscode.getState()) || {};
  const navPrefs = Object.assign({ collapsed: [], rail: false }, viewState().nav);
  const saveNavPrefs = () => { if (typeof vscode.setState === 'function') { vscode.setState({ ...viewState(), nav: navPrefs }); } };
  /** `group` picks the tab: servers on this machine, local gateways to cloud models, cloud APIs. `keyUrl`: where to get a key. */
  const PRESET_PROVIDERS = [
    ...[
      ['ollama', 'Ollama', 'localhost:11434', 'ollama', 'http://localhost:11434'],
      ['lmstudio', 'LM Studio', 'localhost:1234', 'openai', 'http://localhost:1234/v1'],
      ['llamacpp', 'llama.cpp', 'localhost:8080', 'openai', 'http://localhost:8080/v1', 'llama.cpp server'],
      ['vllm', 'vLLM / Unsloth', 'localhost:8000', 'openai', 'http://localhost:8000/v1'],
      ['docker', 'Docker Model Runner', 'localhost:12434', 'openai', 'http://localhost:12434/engines/v1'],
      ['jan', 'Jan', 'localhost:1337', 'openai', 'http://localhost:1337/v1'],
      ['localai', 'LocalAI', 'localhost:8080', 'openai', 'http://localhost:8080/v1'],
      ['sglang', 'SGLang', 'localhost:30000', 'openai', 'http://localhost:30000/v1'],
      ['koboldcpp', 'KoboldCpp', 'localhost:5001', 'openai', 'http://localhost:5001/v1'],
      ['textgen', 'text-generation-webui', 'localhost:5000', 'openai', 'http://localhost:5000/v1'],
      ['gpt4all', 'GPT4All', 'localhost:4891', 'openai', 'http://localhost:4891/v1'],
    ].map(([key, label, sub, type, baseUrl, name]) => ({ key, label, sub, group: 'local', cfg: { id: key, type, baseUrl, displayName: name || label } })),
    // Gateways run here but forward prompts to cloud models, so they are marked `cloud`; a key is optional.
    { key: 'omniroute', label: 'OmniRoute', sub: 'localhost:20128', group: 'gateway', keyUrl: 'https://github.com/diegosouzapw/OmniRoute', cfg: { id: 'omniroute', type: 'openai', baseUrl: 'http://localhost:20128/v1', displayName: 'OmniRoute', cloud: true } },
    { key: 'litellm', label: 'LiteLLM proxy', sub: 'localhost:4000', group: 'gateway', keyUrl: 'https://docs.litellm.ai/docs/simple_proxy', cfg: { id: 'litellm', type: 'openai', baseUrl: 'http://localhost:4000/v1', displayName: 'LiteLLM', cloud: true } },
    // Cloud APIs: the key is read from the usual environment variable until one is pasted (then it goes to the keychain).
    ...[
      ['openai', 'OpenAI', 'api.openai.com', 'openai', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'https://platform.openai.com/api-keys'],
      ['anthropic', 'Anthropic (Claude)', 'api.anthropic.com', 'anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC_API_KEY', 'https://console.anthropic.com/settings/keys'],
      ['gemini', 'Google Gemini', 'generativelanguage.googleapis.com', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY', 'https://aistudio.google.com/apikey'],
      ['openrouter', 'OpenRouter', 'openrouter.ai', 'openai', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'],
      ['groq', 'Groq', 'api.groq.com', 'openai', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', 'https://console.groq.com/keys'],
      ['mistral', 'Mistral AI', 'api.mistral.ai', 'openai', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', 'https://console.mistral.ai/api-keys'],
      ['deepseek', 'DeepSeek', 'api.deepseek.com', 'openai', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', 'https://platform.deepseek.com/api_keys'],
      ['xai', 'xAI (Grok)', 'api.x.ai', 'openai', 'https://api.x.ai/v1', 'XAI_API_KEY', 'https://console.x.ai'],
      ['together', 'Together AI', 'api.together.xyz', 'openai', 'https://api.together.xyz/v1', 'TOGETHER_API_KEY', 'https://api.together.ai/settings/api-keys'],
      ['fireworks', 'Fireworks AI', 'api.fireworks.ai', 'openai', 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY', 'https://fireworks.ai/account/api-keys'],
      ['cerebras', 'Cerebras', 'api.cerebras.ai', 'openai', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai'],
      ['huggingface', 'Hugging Face', 'router.huggingface.co', 'openai', 'https://router.huggingface.co/v1', 'HF_TOKEN', 'https://huggingface.co/settings/tokens'],
      ['nvidia', 'NVIDIA NIM', 'integrate.api.nvidia.com', 'openai', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY', 'https://build.nvidia.com'],
      ['moonshot', 'Moonshot (Kimi)', 'api.moonshot.ai', 'openai', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY', 'https://platform.moonshot.ai/console/api-keys'],
      ['dashscope', 'Alibaba Qwen', 'dashscope-intl.aliyuncs.com', 'openai', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 'https://www.alibabacloud.com/help/en/model-studio/get-api-key'],
      ['ollama-cloud', 'Ollama Cloud', 'ollama.com', 'ollama', 'https://ollama.com', 'OLLAMA_API_KEY', 'https://ollama.com/settings/keys'],
      ['sambanova', 'SambaNova', 'api.sambanova.ai', 'openai', 'https://api.sambanova.ai/v1', 'SAMBANOVA_API_KEY', 'https://cloud.sambanova.ai/apis'],
      ['minimax', 'MiniMax', 'api.minimax.io', 'openai', 'https://api.minimax.io/v1', 'MINIMAX_API_KEY', 'https://www.minimax.io/platform/user-center/basic-information/interface-key'],
      ['zai', 'Z.AI (GLM)', 'api.z.ai', 'openai', 'https://api.z.ai/api/paas/v4', 'ZAI_API_KEY', 'https://z.ai/manage-apikey/apikey-list'],
      ['baseten', 'Baseten', 'inference.baseten.co', 'openai', 'https://inference.baseten.co/v1', 'BASETEN_API_KEY', 'https://app.baseten.co/settings/api_keys'],
      ['nebius', 'Nebius AI Studio', 'api.studio.nebius.com', 'openai', 'https://api.studio.nebius.com/v1', 'NEBIUS_API_KEY', 'https://studio.nebius.com/settings/api-keys'],
      ['requesty', 'Requesty', 'router.requesty.ai · gateway', 'openai', 'https://router.requesty.ai/v1', 'REQUESTY_API_KEY', 'https://app.requesty.ai/api-keys'],
      ['vercel', 'Vercel AI Gateway', 'ai-gateway.vercel.sh · gateway', 'openai', 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_API_KEY', 'https://vercel.com/dashboard/ai-gateway/api-keys'],
      ['azure', 'Azure OpenAI', 'your-resource.openai.azure.com', 'openai', 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', 'AZURE_OPENAI_API_KEY', 'https://portal.azure.com'],
      // Bedrock's OpenAI-compatible endpoint has no /models, so its models are listed. IAM / SigV4 auth goes through LiteLLM.
      ['bedrock', 'Amazon Bedrock', 'bedrock-runtime · API key', 'openai', 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', 'AWS_BEARER_TOKEN_BEDROCK', 'https://console.aws.amazon.com/bedrock/home#/api-keys', ['openai.gpt-oss-120b-1:0', 'openai.gpt-oss-20b-1:0']],
    ].map(([key, label, sub, type, baseUrl, env, keyUrl, models]) => ({ key, label, sub, group: 'cloud', keyUrl, cfg: { id: key, type, baseUrl, displayName: label, apiKey: `\${env:${env}}`, cloud: true, ...(models ? { models } : {}) } })),
  ];
  const CUSTOM_PRESET = { key: 'custom', label: 'Custom endpoint', cfg: { id: 'custom', type: 'openai', baseUrl: '', displayName: 'Custom' } };
  const PRESET_GROUPS = [
    ['local', 'On this machine', 'Model servers on this computer or your network. Nothing leaves it.'],
    ['cloud', 'Cloud APIs', 'Hosted models. Needs an API key; prompts and code are sent to the provider.'],
    ['gateway', 'Gateways', 'Run here and forward to cloud models: one endpoint for many providers.'],
  ];
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
  /** Mirrors rankPresets in src/providers/presetSearch.ts: name first, then key, host and the key's environment variable. */
  function rankPresets(query, presets) {
    const q = query.trim().toLowerCase(); if (!q) { return presets.map((preset) => ({ preset, score: 0, labelHl: [] })); }
    const hits = [];
    presets.forEach((preset, i) => {
      const env = (/\$\{env:([^}]+)\}/.exec(preset.cfg.apiKey || '') || [])[1];
      const label = fuzzyMatch(q, preset.label); const key = fuzzyMatch(q, preset.key); const host = fuzzyMatch(q, preset.sub || preset.cfg.baseUrl); const ev = env ? fuzzyMatch(q, env) : null;
      let score = Math.max(label ? label.score : -Infinity, key ? key.score - 1 : -Infinity, host ? host.score - 6 : -Infinity, ev ? ev.score - 8 : -Infinity);
      if (score === -Infinity) { return; }
      const name = preset.label.toLowerCase();
      if (name === q || preset.key === q) { score += 100; } else if (name.startsWith(q) || preset.key.startsWith(q)) { score += 20; }
      hits.push({ preset, score, labelHl: label ? label.positions : [], i });
    });
    return hits.sort((a, b) => b.score - a.score || a.i - b.i);
  }
  const hlText = (s, pos) => { const on = new Set(pos || []); return [...String(s)].map((c, i) => (on.has(i) ? `<b class="hl">${esc(c)}</b>` : esc(c))).join(''); };
  /** The preset a configured provider came from (id such as "openai-2", else the same base URL), for its key link. */
  const presetOf = (p) => PRESET_PROVIDERS.find((pr) => pr.cfg.id === String(p.id || '').replace(/-\d+$/, '')) || PRESET_PROVIDERS.find((pr) => pr.cfg.baseUrl === p.baseUrl);
  /** Mirrors isRemoteUrl in src/providers/cloud.ts: anything off this machine and the private network is a cloud API. */
  const isRemoteUrl = (u) => {
    let h; try { h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
    return !(h === 'localhost' || /\.(localhost|local|internal)$/.test(h) || h === '::1' || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || !h.includes('.'));
  };
  /** Mirrors isCloudProvider: a cloud URL, or a local gateway marked `cloud`. */
  const isCloud = (p) => (typeof p.cloud === 'boolean' ? p.cloud : p.type === 'anthropic' || p.type === 'vscode-lm' || isRemoteUrl(p.baseUrl));
  const isSecretRef = (v) => /^\$\{secret:[^}]+\}$/.test(String(v || '').trim());
  const API_LABEL = { ollama: 'Ollama API', openai: 'OpenAI API', anthropic: 'Anthropic API', 'vscode-lm': 'VS Code language models' };
  /** Vendor logos, single-colour: Simple Icons (CC0 1.0 — https://simpleicons.org) and, for vendors Simple Icons does not carry
   *  (OpenAI, Groq, Together, Fireworks, xAI, Cerebras, Azure, Microsoft, Kimi), LobeHub Icons (MIT — https://github.com/lobehub/lobe-icons).
   *  Local servers with no published vector mark (Jan, LocalAI, SGLang…) keep a monogram below. */
  const LOGOS = {
    ollama: '<svg class="logo" viewBox="0 0 24 24"><path d="M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z"/></svg>',
    lmstudio: '<svg class="logo" viewBox="0 0 24 24"><path d="M14.025 0c3.492 0 5.237 0 6.571.68a6.24 6.24 0 0 1 2.725 2.724C24 4.738 24 6.484 24 9.975v4.05c0 3.492 0 5.237-.68 6.571a6.24 6.24 0 0 1-2.724 2.725c-1.334.679-3.08.679-6.571.679h-4.05c-3.492 0-5.237 0-6.571-.68A6.24 6.24 0 0 1 .68 20.597C0 19.262 0 17.516 0 14.025v-4.05c0-3.492 0-5.237.68-6.571A6.23 6.23 0 0 1 3.404.68C4.738 0 6.484 0 9.975 0zM7.688 16.313a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625zm-3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm3-3.75a1.313 1.313 0 0 0 0 2.624h11.625a1.313 1.313 0 0 0 0-2.624zm-3-3.75a1.313 1.313 0 0 0 0 2.625h11.625a1.313 1.313 0 0 0 0-2.625z"/></svg>',
    vllm: '<svg class="logo" viewBox="0 0 24 24"><path d="m23.6 0-8.721 4.59L9.829 24h7.41zM9.83 24V5.142H.4Z"/></svg>',
    docker: '<svg class="logo" viewBox="0 0 24 24"><path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/></svg>',
    google: '<svg class="logo" viewBox="0 0 24 24"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
    nvidia: '<svg class="logo" viewBox="0 0 24 24"><path d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"/></svg>',
    qwen: '<svg class="logo" viewBox="0 0 24 24"><path d="M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z"/></svg>',
    mistral: '<svg class="logo" viewBox="0 0 24 24"><path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z"/></svg>',
    meta: '<svg class="logo" viewBox="0 0 24 24"><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"/></svg>',
    deepseek: '<svg class="logo" viewBox="0 0 24 24"><path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/></svg>',
    huggingface: '<svg class="logo" viewBox="0 0 24 24"><path d="M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624"/></svg>',
    openai: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>',
    claude: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
    groq: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z"/></svg>',
    openrouter: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/></svg>',
    together: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M23.197 4.503A6 6 0 0015 2.307a5.973 5.973 0 00-2.995 4.933l5.996.008v.515h-5.996c.039.937.298 1.87.8 2.74a6 6 0 1010.39-6z"/><path d="M.805 4.5A6 6 0 003 12.697a5.972 5.972 0 005.77.127L5.779 7.627l.446-.257 2.997 5.192A6 6 0 10.804 4.5z"/><path d="M12 23.894a6 6 0 005.999-6c0-2.13-1.1-3.996-2.775-5.06l-3.005 5.189-.444-.258 2.997-5.192A6 6 0 1012 23.894z"/></svg>',
    fireworks: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M14.8 5l-2.801 6.795L9.195 5H7.397l3.072 7.428a1.64 1.64 0 003.038.002L16.598 5H14.8zm1.196 10.352l5.124-5.244-.699-1.669-5.596 5.739a1.664 1.664 0 00-.343 1.807 1.642 1.642 0 001.516 1.012L16 17l8-.02-.699-1.669-7.303.041h-.002zM2.88 10.104l.699-1.669 5.596 5.739c.468.479.603 1.189.343 1.807a1.643 1.643 0 01-1.516 1.012l-8-.018-.002.002.699-1.669 7.303.042-5.122-5.246z"/></svg>',
    xai: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z"/></svg>',
    cerebras: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M14.121 2.701a9.299 9.299 0 000 18.598V22.7c-5.91 0-10.7-4.791-10.7-10.701S8.21 1.299 14.12 1.299V2.7zm4.752 3.677A7.353 7.353 0 109.42 17.643l-.901 1.074a8.754 8.754 0 01-1.08-12.334 8.755 8.755 0 0112.335-1.08l-.901 1.075zm-2.255.844a5.407 5.407 0 00-5.048 9.563l-.656 1.24a6.81 6.81 0 016.358-12.043l-.654 1.24zM14.12 8.539a3.46 3.46 0 100 6.922v1.402a4.863 4.863 0 010-9.726v1.402z"/><path d="M15.407 10.836a2.24 2.24 0 00-.51-.409 1.084 1.084 0 00-.544-.152c-.255 0-.483.047-.684.14a1.58 1.58 0 00-.84.912c-.074.203-.11.416-.11.631 0 .218.036.43.11.631a1.594 1.594 0 00.84.913c.2.093.43.14.684.14.216 0 .417-.046.602-.135.188-.09.35-.225.475-.392l.928 1.006c-.14.14-.3.261-.482.363a3.367 3.367 0 01-1.083.38c-.17.026-.317.04-.44.04a3.315 3.315 0 01-1.182-.21 2.825 2.825 0 01-.961-.597 2.816 2.816 0 01-.644-.929 2.987 2.987 0 01-.238-1.21c0-.444.08-.847.238-1.21.15-.35.368-.666.643-.929.278-.261.605-.464.962-.596a3.315 3.315 0 011.182-.21c.355 0 .712.068 1.072.204.361.138.685.36.944.649l-.962.97z"/></svg>',
    azure: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M18.397 15.296H7.4a.51.51 0 00-.347.882l7.066 6.595c.206.192.477.298.758.298h6.226l-2.706-7.775z"/><path d="M8.295.857c-.477 0-.9.304-1.053.756L.495 21.605a1.11 1.11 0 001.052 1.466h5.43c.477 0 .9-.304 1.053-.755l1.341-3.975-2.318-2.163a.51.51 0 01.347-.882h3L15.271.857H8.295z"/><path d="M17.193 1.613a1.11 1.11 0 00-1.052-.756h-7.81.035c.477 0 .9.304 1.052.756l6.748 19.992a1.11 1.11 0 01-1.052 1.466h-.12 7.895a1.11 1.11 0 001.052-1.466L17.193 1.613z"/></svg>',
    kimi: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z"/><path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z"/></svg>',
    microsoft: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M11.49 2H2v9.492h9.492V2h-.002z"/><path d="M22 2h-9.492v9.492H22V2z"/><path d="M11.49 12.508H2V22h9.492v-9.492h-.002z"/><path d="M22 12.508h-9.492V22H22v-9.492z"/></svg>',
    gemini: '<svg class="logo" viewBox="0 0 24 24" fill-rule="evenodd"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
  };
  /** Brand marks for provider cards: real logo where we have one, otherwise a monogram, each in the vendor accent colour. */
  const BRANDS = {
    ollama: { mark: LOGOS.ollama, color: 'var(--fg)' }, lmstudio: { mark: LOGOS.lmstudio, color: 'var(--fg)' }, llamacpp: { mark: 'λ', color: '#f2a33a' },
    vllm: { mark: LOGOS.vllm, color: '#30a2ff' }, docker: { mark: LOGOS.docker, color: '#2496ed' }, jan: { mark: 'JA', color: '#22c55e' },
    localai: { mark: 'LA', color: '#06b6d4' }, sglang: { mark: 'SG', color: '#ef4444' }, custom: { mark: I.plug, color: '' },
    koboldcpp: { mark: 'KC', color: '#64748b' }, omniroute: { mark: 'OM', color: '#14b8a6' }, textgen: { mark: 'TG', color: '#f97316' }, gpt4all: { mark: 'G4', color: '#16a34a' }, litellm: { mark: 'LL', color: '#0ea5e9' },
    openai: { mark: LOGOS.openai, color: 'var(--fg)' }, anthropic: { mark: LOGOS.claude, color: '#d97757' }, gemini: { mark: LOGOS.gemini, color: '#8e75b2' },
    openrouter: { mark: LOGOS.openrouter, color: 'var(--fg)' }, groq: { mark: LOGOS.groq, color: '#f55036' }, mistral: { mark: LOGOS.mistral, color: '#fa520f' },
    deepseek: { mark: LOGOS.deepseek, color: '#4d6bfe' }, xai: { mark: LOGOS.xai, color: 'var(--fg)' }, together: { mark: LOGOS.together, color: '#0f6fff' },
    fireworks: { mark: LOGOS.fireworks, color: '#5019c5' }, cerebras: { mark: LOGOS.cerebras, color: '#f15a29' }, huggingface: { mark: LOGOS.huggingface, color: '#f59e0b' },
    nvidia: { mark: LOGOS.nvidia, color: '#76b900' }, moonshot: { mark: LOGOS.kimi, color: '#1783ff' }, dashscope: { mark: LOGOS.qwen, color: '#615ced' },
    'ollama-cloud': { mark: LOGOS.ollama, color: 'var(--fg)' }, azure: { mark: LOGOS.azure, color: '#0078d4' },
    bedrock: { mark: 'BR', color: '#ff9900' },
  };
  /** Resolves a brand from a preset key or a provider config (id prefix such as "ollama-2", then baseUrl/type hints). */
  const brandOf = (keyOrCfg) => {
    if (typeof keyOrCfg === 'string') { return BRANDS[keyOrCfg]; }
    const p = keyOrCfg || {};
    const base = String(p.id || '').replace(/-\d+$/, '');
    if (BRANDS[base]) { return BRANDS[base]; }
    if (p.type === 'ollama') { return BRANDS.ollama; }
    if (p.type === 'anthropic') { return BRANDS.anthropic; }
    const url = String(p.baseUrl || '');
    const hit = PRESET_PROVIDERS.find((pr) => pr.key !== 'custom' && pr.cfg.baseUrl === url);
    return hit ? BRANDS[hit.key] : null;
  };
  const markSpan = (b, fallback) => {
    const mark = b ? b.mark : esc(String(fallback || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
    return `<span class="ic brand-mark${b && b.color ? '' : ' plain'}"${b && b.color ? ` style="--mark:${b.color}"` : ''} aria-hidden="true">${mark}</span>`;
  };
  const brandMark = (keyOrCfg, fallback) => markSpan(brandOf(keyOrCfg), fallback);
  /** Model vendors (catalog `vendor` names): the vendor's logo where one is published, else a monogram, in the vendor colour. */
  const VENDORS = {
    'google deepmind': { mark: LOGOS.google, color: '#4285f4' }, google: { mark: LOGOS.google, color: '#4285f4' },
    nvidia: { mark: LOGOS.nvidia, color: '#76b900' }, alibaba: { mark: LOGOS.qwen, color: '#615ced' },
    'mistral ai': { mark: LOGOS.mistral, color: '#fa520f' }, mistral: { mark: LOGOS.mistral, color: '#fa520f' }, openai: { mark: LOGOS.openai, color: 'var(--fg)' },
    meta: { mark: LOGOS.meta, color: '#0866ff' }, deepseek: { mark: LOGOS.deepseek, color: '#4d6bfe' },
    microsoft: { mark: LOGOS.microsoft, color: '#0078d4' }, anthropic: { mark: LOGOS.claude, color: '#d97757' }, xai: { mark: LOGOS.xai, color: 'var(--fg)' }, 'hugging face': { mark: LOGOS.huggingface, color: '#f59e0b' }, bigcode: { mark: 'BC', color: '#a855f7' },
  };
  /** Vendor guessed from a model id, for installed models the catalog does not know. */
  const vendorFromModelId = (id) => {
    const n = String(id || '').toLowerCase();
    if (/gemma|gemini/.test(n)) { return 'google'; }
    if (/nemotron|nvidia/.test(n)) { return 'nvidia'; }
    if (/qwen|qwq/.test(n)) { return 'alibaba'; }
    if (/mistral|devstral|codestral|pixtral|ministral|magistral|mixtral/.test(n)) { return 'mistral ai'; }
    if (/llama/.test(n)) { return 'meta'; }
    if (/deepseek/.test(n)) { return 'deepseek'; }
    if (/gpt-oss/.test(n)) { return 'openai'; }
    if (/claude/.test(n)) { return 'anthropic'; }
    if (/(^|\/)(gpt-|chatgpt|o[134](-|$))/.test(n)) { return 'openai'; }
    if (/grok/.test(n)) { return 'xai'; }
    if (/phi-?\d|phi4|phi3/.test(n)) { return 'microsoft'; }
    if (/smollm/.test(n)) { return 'hugging face'; }
    if (/starcoder/.test(n)) { return 'bigcode'; }
    return '';
  };
  const vendorMark = (vendor, fallback) => markSpan(VENDORS[String(vendor || '').toLowerCase()] || null, fallback || vendor);
  const APPROVAL = [['ask', 'Ask'], ['always', 'Allow'], ['never', 'Block']];
  const APPROVAL_PRESETS = {
    safe: { title: 'Careful', desc: 'Ask before every command, edit, delete, network call and MCP tool.', v: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask', mcp: 'ask' } },
    balanced: { title: 'Balanced', desc: 'Edits, web and MCP tools are allowed; ask for terminal commands and deletes. (Default)', v: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always', mcp: 'always' } },
    autonomous: { title: 'Autonomous', desc: 'Let the agent run commands and edit freely; only deletes need approval.', v: { terminal: 'always', write: 'always', delete: 'ask', network: 'always', mcp: 'always' } },
  };

  const state = { page: 'settings', section: 'providers', scope: 'user', data: null, probe: null, tests: {}, expanded: null, busy: false, setup: { step: 0, model: '', approvals: 'balanced', inline: false, providers: null }, models: null, modelsRequested: false, jobs: [], cat: { filter: 'fits', q: '', open: {} }, installTarget: {}, runtimes: null, starter: null,
    // Model gallery: one browse state per registry source (Ollama library, Docker Hub ai/, Hugging Face GGUF) and
    // the chosen install runtime per source; tag lists are fetched on expand.
    gallery: { source: 'ollama', target: {}, pullRef: '', pullError: '', pullTarget: '', by: {} },
    // Dashboard: last summary + range, and the log viewer filters (follow streams new lines in).
    dash: { days: 7, summary: null, logFile: '', loading: false, logs: [], level: 'info', q: '', follow: true, timer: null, includeDisabled: false, provider: '', hidden: [], allProviders: null },
    // Dashboard → Self-healing & recovery: the host's data for the range, the open view, its filters and expanded diffs.
    rec: { data: null, error: '', loaded: false, tab: 'history', cat: '', open: {}, reuse: {}, canDiff: false, ro: null, raf: 0 },
    // Skill registry browser (Settings → Skills): query, results with installed state, per-repo index status, install jobs.
    skillReg: { q: '', filter: 'all', scope: '', entries: [], status: [], loading: false, loaded: false, refreshing: false, jobs: {} }, skillFilter: '' };
  const galleryState = (source) => (state.gallery.by[source] ||= { q: '', capability: '', sort: 'popular', page: 1, models: [], hasMore: false, loading: false, loaded: false, error: null, tags: {}, open: {} });

  // ------------------------------------------------------------------ helpers
  /** Makes a clickable card header a real disclosure control: focusable, announced, toggled with Enter/Space. */
  /** Expand / collapse with liquid motion. Cards are rebuilt by render(), so collapsing animates the card down to its
   *  head first and then rebuilds; expanding marks the label, and the rebuilt card grows from its head the next frame.
   *  The chevron turns on a spring either way. */
  let revealLabel = '';
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SPRING = 'cubic-bezier(.34,1.56,.64,1)'; const GLIDE = 'cubic-bezier(.2,.8,.2,1)';
  function disclosure(head, open, label, toggle) {
    if (!head) { return; }
    head.setAttribute('role', 'button'); head.tabIndex = 0; head.setAttribute('aria-expanded', String(!!open)); head.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${label}`);
    const card = head.parentElement; const chev = head.querySelector('.chev');
    if (open && revealLabel === label && !calm()) {
      revealLabel = '';
      requestAnimationFrame(() => {
        if (!card || !card.isConnected || !card.animate) { return; }
        const from = head.offsetHeight + (card.offsetHeight - card.clientHeight); const to = card.offsetHeight;
        card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: GLIDE });
        const body = head.nextElementSibling; if (body) { body.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 60, easing: GLIDE, fill: 'backwards' }); }
        if (chev) { chev.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], { duration: 480, easing: SPRING }); }
      });
    }
    const run = () => {
      if (!open) { revealLabel = label; toggle(); return; }
      if (calm() || !card || !card.animate) { toggle(); return; }
      const from = card.offsetHeight; const to = head.offsetHeight + (card.offsetHeight - card.clientHeight);
      if (chev) { chev.animate([{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }], { duration: 300, easing: GLIDE, fill: 'forwards' }); }
      const body = head.nextElementSibling; if (body) { body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }); }
      card.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 260, easing: GLIDE, fill: 'forwards' }).onfinish = toggle;
    };
    head.onclick = (e) => { if (e.target.closest('button, a, input, select')) { return; } run(); };
    head.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); run(); } };
  }
  /** action: { label, command } adds a button that runs an allowed command; { label, msg } posts msg back to the host. Info toasts go after 3 s; warnings and errors
   *  stay long enough to read (60 ms per character, 6 s at least), errors are announced at once and can be dismissed.
   *  Hovering or focusing a toast holds it. */
  function toast(text, level, action) {
    const lv = level || 'info';
    const t = el('div', `toast ${lv}${action ? ' has-action' : ''}`, `<span>${esc(text)}</span>`);
    if (lv === 'error') { t.setAttribute('role', 'alert'); }
    if (action && action.label && (action.command || action.msg)) { const b = el('button', 'btn sm', esc(action.label)); b.onclick = () => { post(action.msg || { type: 'command', id: action.command }); t.remove(); }; t.appendChild(b); }
    if (lv === 'error') { const x = el('button', 'toast-x', I.x); x.setAttribute('aria-label', 'Dismiss'); x.title = 'Dismiss'; x.onclick = () => t.remove(); t.appendChild(x); }
    let left = Math.max(lv === 'info' ? 3000 : Math.max(6000, String(text).length * 60), action ? 10000 : 0); let timer = 0; let since = 0;
    const run = () => { since = Date.now(); timer = setTimeout(() => t.remove(), left); };
    const hold = () => { if (timer) { clearTimeout(timer); timer = 0; left = Math.max(1500, left - (Date.now() - since)); } };
    const resume = () => { if (!timer && !t.matches(':hover') && !t.contains(document.activeElement)) { run(); } };
    t.onmouseenter = hold; t.onmouseleave = resume; t.addEventListener('focusin', hold); t.addEventListener('focusout', () => setTimeout(resume, 0));
    document.getElementById('toasts').appendChild(t); run();
  }
  const S = (key) => (state.data && state.data.settings[key]) || { value: undefined, default: undefined, scope: 'default' };
  const val = (key) => S(key).value;
  /** The value stored in the selected scope (not the merged one), so an edit never copies the other scope's value into it. */
  const ownValue = (key) => { const s = S(key); return state.scope === 'workspace' ? (s.workspaceValue ?? s.userValue ?? s.default) : (s.userValue ?? s.default); };
  // Organisation policy per control (managed-settings.json): locked settings, approval floors, allowlists.
  const POLICY = () => (state.data && state.data.policy) || null;
  const MANAGED_TIP = 'Managed by your organization';
  /** Why the policy refuses `value` for `key` (the whole setting is locked, or that value is below an approval floor); '' when it does not. */
  const policyRefuses = (key, value) => {
    const p = POLICY(); if (!p) { return ''; }
    if (p.locked[key]) { return p.locked[key]; }
    return (p.disabledOptions[key] || []).includes(String(value)) ? 'Your organization requires approval here' : '';
  };
  /** The value in effect: what the organisation's policy applies where it decides, otherwise the setting. */
  const effVal = (key) => { const eff = POLICY() && POLICY().effective; return eff && Object.prototype.hasOwnProperty.call(eff, key) ? eff[key] : val(key); };
  const lockIcon = (why) => `<span class="lock" role="img" title="${esc(why ? `${MANAGED_TIP} — ${why}` : MANAGED_TIP)}" aria-label="${esc(MANAGED_TIP)}">${I.lock}</span>`;
  /** Mirrors providerAllowed in src/agent/managedPolicy.ts: why the policy keeps a provider of the user's from loading. */
  const providerPolicyBlock = (p) => {
    const pol = POLICY(); if (!pol || (pol.providers || []).some((m) => m.id === p.id && m.baseUrl === p.baseUrl)) { return ''; }
    if (!pol.allowCloudProviders && isCloud(p)) { return 'Cloud providers are off by your organization'; }
    if (pol.allowedProviderHosts) {
      const host = hostOfUrl(p.baseUrl);
      const ok = pol.allowedProviderHosts.some((h) => { const pat = h.toLowerCase(); return pat.startsWith('*.') ? host === pat.slice(2) || host.endsWith(pat.slice(1)) : host === pat; });
      if (!ok) { return `${host || p.baseUrl} is not on your organization's provider allowlist`; }
    }
    return '';
  };
  /** Writes awaiting the host's 'saved' reply, by request id: the header says "Saved" only once VS Code confirmed it,
   *  and a refused write puts the control back to the stored value. */
  const pendingSaves = new Map(); let saveSeq = 0;
  function set(key, value) {
    const refused = policyRefuses(key, value);
    if (refused) { toast(`${MANAGED_TIP}: ${refused}`, 'error'); refreshComponents([key]); return; }
    const id = ++saveSeq; pendingSaves.set(id, { key, scope: state.scope });
    state.pendingSave = Date.now();
    post({ type: 'set', key, value, scope: state.scope, id });
  }
  /** Brief "Saved" acknowledgement in the header after the host confirmed a write. */
  function flashSaved() {
    const t = app.querySelector('.top .saved'); if (!t) { return; }
    t.classList.add('show'); clearTimeout(flashSaved.timer); flashSaved.timer = setTimeout(() => t.classList.remove('show'), 1400);
  }
  /** Resets the scope that defines the value in effect, whichever scope is selected. */
  function reset(key) { const id = ++saveSeq; pendingSaves.set(id, { key, reset: true }); state.pendingSave = Date.now(); post({ type: 'reset', key, scope: S(key).scope === 'workspace' ? 'workspace' : 'user', id }); }
  function onSaved(m) {
    const p = pendingSaves.get(m.id); pendingSaves.delete(m.id);
    if (!pendingSaves.size) { state.pendingSave = 0; }
    if (m.ok) {
      flashSaved();
      // Switching tuning on or off changes what the dashboard's Model tuning card can show.
      if (p && p.key === 'models.autoTune' && state.page === 'settings' && state.section === 'dashboard') { requestDashboard(); }
      if (p && !p.reset && p.scope === 'user' && !USER_ONLY(p.key) && S(p.key).workspaceValue !== undefined) { toast(`Saved to User settings, but this workspace overrides ${p.key} — switch to Workspace to change the value in effect`, 'warn'); }
      return;
    }
    // Nothing was written, so the state still holds the old value: rebuilding the control flips a switch or segment back.
    const key = (p && p.key) || m.key;
    if (key) { if (state.page !== 'settings' || STRUCTURAL_KEYS.has(key)) { render(); } else { refreshComponents([key]); } }
    toast(m.error || 'The setting could not be saved', 'error');
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  /** Mirrors isUserOnlySetting in src/config.ts (keep the two in step): written to User settings whatever scope is selected. */
  const USER_ONLY = (k) => k === 'routing.fallbackModels' || k === 'mcp.toolApprovals' || k === 'hooks.enabled' || k === 'healing.dependencyInstall' || k === 'healing.securityCheck' || k.startsWith('approvals.') || k.startsWith('autoMode.') || k.startsWith('telemetry.otlp.');
  const userOnlyBadge = (key) => (USER_ONLY(key) ? '<span class="badge useronly" title="Applies to every workspace for safety; the Workspace switch does not change it">User only</span>' : '');
  const scopeBadge = (key) => { const s = S(key).scope; return userOnlyBadge(key) + (s === 'default' ? '' : `<span class="badge ${s}" title="Set in ${s} settings">${s}</span>`); };
  const resetBtn = (key) => {
    if (S(key).scope === 'default') { return ''; }
    const t = S(key).scope === 'workspace' && S(key).userValue !== undefined ? 'Remove workspace override (User value applies)' : 'Reset to default';
    return `<button class="reset" data-reset="${esc(key)}" title="${t}" aria-label="${t}">${I.undo}</button>`;
  };
  /** An on/off switch: the class and aria-checked flip together before onToggle(on) runs. */
  function switchBtn(on, name, onToggle) {
    const b = el('button', `toggle${on ? ' on' : ''}`); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!on)); b.setAttribute('aria-label', name);
    b.onclick = () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); onToggle(v); };
    return b;
  }
  /** Radio semantics for a row of buttons (`.on` = checked): roving tabindex, and arrows / Home / End move and select,
   *  skipping disabled options. Call after the buttons are added and disabled. */
  function radioGroup(g) {
    if (!g.getAttribute('role')) { g.setAttribute('role', 'radiogroup'); }
    const all = () => [...g.querySelectorAll(':scope > button')];
    const off = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';
    const sync = () => {
      const bs = all(); const cur = bs.find((b) => b.classList.contains('on')) || bs.find((b) => !off(b));
      bs.forEach((b) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(b.classList.contains('on'))); b.tabIndex = b === cur ? 0 : -1; });
    };
    g.addEventListener('click', sync);
    g.addEventListener('keydown', (e) => {
      const bs = all().filter((b) => !off(b)); const i = bs.indexOf(document.activeElement); if (i < 0) { return; }
      const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? bs[(i + 1) % bs.length] : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? bs[(i - 1 + bs.length) % bs.length] : e.key === 'Home' ? bs[0] : e.key === 'End' ? bs[bs.length - 1] : null;
      if (!to) { return; }
      e.preventDefault(); to.focus(); if (!to.classList.contains('on')) { to.click(); }
    });
    sync(); g._radioSync = sync;
    return g;
  }

  /** Generic setting row. kind: text|number|password|select|toggle|textarea|range|seg.
   *  opts.after: a full-width line under the row (counts, buttons); opts.badges: extra HTML after the label;
   *  opts.unit: suffix beside a number (json: what one entry is called); opts.off: why the row is unavailable right now (controls are disabled). */
  function field(key, label, desc, kind, opts = {}) {
    const f = el('div', `field ${opts.wide ? 'wide' : ''}${USER_ONLY(key) && state.scope === 'workspace' ? ' useronly-ws' : ''}`);
    // Components declare the setting keys they render from and how to rebuild themselves, so a changed setting
    // refreshes just that element instead of the whole page (see refreshComponents).
    f.dataset.deps = key;
    f._rebuild = () => field(key, label, desc, kind, opts);
    f.innerHTML = `<div><div class="lbl">${esc(label)}${opts.badges || ''}${scopeBadge(key)}${resetBtn(key)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div><div class="ctl"></div>`;
    const ctl = f.querySelector('.ctl');
    // Where the policy decides the value (locked, or held at an approval floor), show what applies, not what is stored.
    const v = effVal(key);
    if (kind === 'toggle') {
      const b = switchBtn(v, label, (on) => set(key, on)); b.dataset.fk = key; ctl.appendChild(b);
    } else if (kind === 'select') {
      const s = el('select'); s.setAttribute('aria-label', label);
      for (const [ov, ol, od] of opts.options) { const o = el('option'); o.value = ov; o.textContent = ol + (od ? ` — ${od}` : ''); if (String(ov) === String(v)) { o.selected = true; } s.appendChild(o); }
      if (opts.options.every(([ov]) => String(ov) !== String(v)) && v !== undefined && v !== '') { const o = el('option'); o.value = v; o.textContent = `${v} (not available)`; o.selected = true; s.appendChild(o); }
      s.onchange = () => set(key, opts.cast ? opts.cast(s.value) : s.value);
      ctl.appendChild(s);
    } else if (kind === 'seg') {
      const g = el('div', 'seg'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', label);
      for (const [ov, ol] of opts.options) { const b = el('button', String(ov) === String(v) ? 'on' : '', esc(ol)); b.dataset.fk = `${key}=${ov}`; b.onclick = () => { if (b.classList.contains('on')) { return; } g.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); set(key, ov); }; g.appendChild(b); }
      ctl.appendChild(g);
    } else if (kind === 'range') {
      const w = el('div', 'range', `<input type="range" min="${opts.min}" max="${opts.max}" step="${opts.step}" value="${esc(v)}" aria-label="${esc(label)}"><output>${esc(opts.fmt ? opts.fmt(v) : v)}</output>`);
      const r = w.querySelector('input');
      r.oninput = () => { w.querySelector('output').textContent = opts.fmt ? opts.fmt(Number(r.value)) : r.value; };
      r.onchange = () => set(key, Number(r.value));
      ctl.appendChild(w);
    } else if (kind === 'json') {
      // Arrays and objects without a form here: how many entries, and the key opened in settings.json (opts.unit names one entry).
      const n = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
      const ws = state.scope === 'workspace';
      const b = el('button', 'btn sm', `${I.external}Edit in settings.json`);
      b.title = `Open ${ws ? 'the workspace' : 'your User'} settings.json at localpilot.${key}`;
      b.onclick = () => post({ type: 'command', id: ws ? 'workbench.action.openWorkspaceSettingsFile' : 'workbench.action.openSettingsJson', args: ws ? undefined : [{ revealSetting: { key: `localpilot.${key}`, edit: true } }] });
      const r = el('div', 'row json-row'); r.append(el('span', 'muted small', n ? plural(n, opts.unit || 'entry') : 'None set'), b); ctl.appendChild(r);
    } else if (kind === 'textarea') {
      const t = el('textarea'); t.value = v ?? ''; t.placeholder = opts.placeholder || ''; t.setAttribute('aria-label', label);
      t.onchange = () => set(key, t.value);
      ctl.appendChild(t);
    } else {
      // A `secret` field holding a ${secret:…} reference stays empty; leaving it empty keeps the stored key.
      const stored = opts.secret && isSecretRef(v);
      const i = el('input'); i.type = kind === 'number' ? 'number' : kind === 'password' ? 'password' : 'text'; i.value = stored ? '' : v ?? ''; i.placeholder = stored ? '•••••••• saved in secret storage — type to replace' : opts.placeholder || ''; i.setAttribute('aria-label', label);
      if (kind === 'number') { if (opts.min !== undefined) { i.min = opts.min; } if (opts.max !== undefined) { i.max = opts.max; } if (opts.step) { i.step = opts.step; } }
      // `last` tracks what was sent so blur + the trailing debounce do not save the same value twice.
      let last = stored ? '' : v;
      const commit = () => {
        if (kind === 'number') {
          const n = Number(i.value);
          if (i.value === '' || Number.isNaN(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); i.title = `Enter a number${opts.min !== undefined ? ` from ${opts.min}` : ''}${opts.max !== undefined ? ` to ${opts.max}` : ''} — not saved yet`; return; }
          i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); i.title = ''; if (n !== last) { last = n; set(key, n); }
        } else if (opts.validate && i.value && !opts.validate(i.value)) { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); i.title = opts.invalidHint || 'Not a valid value — not saved yet'; }
        else { i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); i.title = ''; if (i.value !== (last ?? '')) { last = i.value; set(key, i.value); } }
      };
      i.onchange = commit; i.onblur = commit; i.oninput = debounce(commit, 700);
      if (opts.unit) { const r = el('div', 'row unit-row'); r.append(i, el('span', 'unit', esc(opts.unit))); ctl.appendChild(r); } else if (kind === 'password') { const r = el('div', 'row pw-row'); r.append(i, eyeToggle(i, label)); ctl.appendChild(r); } else { ctl.appendChild(i); }
    }
    const why = policyRefuses(key, undefined);
    const floor = (POLICY() && POLICY().disabledOptions[key]) || [];
    // A full-width line under the label and the control, so a switch keeps its corner and the buttons get the width.
    // Appended before the lock so its buttons (Redis setup, …) are disabled with the control.
    if (opts.after) { opts.after.classList.add('after'); f.appendChild(opts.after); }
    const controls = () => f.querySelectorAll(':scope > .ctl :is(button, input, select, textarea), :scope > .after :is(button, input, select, textarea)');
    if (why) {
      // Locked by the organisation: the control shows the value the policy applies, nothing here can change it.
      f.classList.add('locked');
      f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(why));
      const rb = f.querySelector('.reset'); if (rb) { rb.remove(); }
      controls().forEach((x) => { x.disabled = true; x.title = MANAGED_TIP; });
    } else if (opts.off) {
      f.classList.add('off');
      controls().forEach((x) => { x.disabled = true; x.title = opts.off; });
    } else if (floor.length && kind === 'seg') {
      const btns = ctl.querySelectorAll('.seg button');
      opts.options.forEach(([ov], i) => { if (floor.includes(String(ov)) && btns[i]) { btns[i].disabled = true; btns[i].setAttribute('aria-disabled', 'true'); btns[i].title = `${MANAGED_TIP} — your organization requires approval here`; } });
      f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(`${opts.options.filter(([ov]) => floor.includes(String(ov))).map(([, l]) => l).join(', ')} is not allowed`));
    }
    const seg = ctl.querySelector(':scope > .seg'); if (seg) { radioGroup(seg); }
    return f;
  }
  /** Show / hide button for a password input; the label names what is revealed for screen readers. */
  function eyeToggle(input, label) {
    const b = el('button', 'btn sm ghost eye', I.eye); b.type = 'button';
    const sync = () => { const shown = input.type === 'text'; b.innerHTML = shown ? I.eyeOff : I.eye; b.title = shown ? 'Hide' : 'Show'; b.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} ${label}`); b.setAttribute('aria-pressed', String(shown)); };
    b.onclick = () => { input.type = input.type === 'text' ? 'password' : 'text'; sync(); };
    sync();
    return b;
  }
  const card = (...children) => { const c = el('div', 'card'); children.forEach((x) => x && c.appendChild(x)); return c; };
  /** Marks any element as a self-rebuilding component bound to the given setting keys. */
  const component = (node, deps, rebuild) => { node.dataset.deps = deps.join(','); node._rebuild = rebuild; return node; };
  /** Settings whose change restructures a page (lists, visibility) rather than one control — these re-render the section. */
  const STRUCTURAL_KEYS = new Set(['providers', 'mcpServers', 'models.disabled', 'webSearch.provider']);
  const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
  /** Typing into it: a rebuild would eat the text or the caret. A switch, button or checkbox is not. */
  const isEditing = (a) => !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !/^(checkbox|radio|range|button)$/.test(a.type)));
  /** Rebuilds only the components that depend on the changed keys. Keeps a field being typed in intact (just refreshes
   *  its label); a component whose switch or checkbox was just used is rebuilt and the focus put back on the same control. */
  function refreshComponents(keys) {
    const want = new Set(keys);
    for (const node of [...app.querySelectorAll('[data-deps]')]) {
      if (!node.isConnected || !node._rebuild || !node.dataset.deps.split(',').some((k) => want.has(k))) { continue; }
      const fresh = node._rebuild();
      wireGlobal(fresh);
      const act = document.activeElement;
      const fk = node.contains(act) && act.dataset ? act.dataset.fk : '';
      if (fk) {
        node.replaceWith(fresh);
        const n = fresh.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
        if (n) { if (n.tagName !== 'BUTTON') { n.value = act.value; } n.focus({ preventScroll: true }); }
        continue;
      }
      if (node.contains(act) && isEditing(act)) {
        const a = node.querySelector('.lbl'); const b = fresh.querySelector('.lbl');
        if (a && b) { a.replaceWith(b); }
        continue;
      }
      const at = node.contains(act) ? [...node.querySelectorAll(FOCUSABLE)].indexOf(act) : -1;
      node.replaceWith(fresh);
      const back = at >= 0 && fresh.querySelectorAll(FOCUSABLE)[at];
      if (back && !back.disabled) { back.focus({ preventScroll: true }); }
    }
  }
  /** Replies to a "Browse…" folder dialog, by setting key: the editor that asked appends the picked path. */
  const onPicked = {};
  const missingPath = (p) => ((state.data && state.data.settingsMeta && state.data.settingsMeta.missingPaths) || []).includes(p);
  const otherScope = () => (state.scope === 'workspace' ? 'user' : 'workspace');
  const scopeName = (sc) => (sc === 'workspace' ? 'Workspace' : 'User');
  /** The value written in one scope only (no fallback to the other scope or the default). */
  const scopeValue = (key, sc) => (sc === 'workspace' ? S(key).workspaceValue : S(key).userValue);
  const testValid = (validate, v) => !validate || (validate instanceof RegExp ? validate.test(v) : !!validate(v));
  /** Editable list setting (folders, marketplaces). Edits the selected scope's own list; entries only the other scope has
   *  are shown read-only (VS Code does not merge lists: the Workspace list replaces the User one). Enter adds; empty,
   *  invalid and duplicate input is refused in place. opts: placeholder, validate (RegExp or fn), invalidHint, browse. */
  function listEditor(key, label, desc, opts = {}) {
    const build = () => {
      const own = Array.isArray(ownValue(key)) ? ownValue(key) : [];
      const other = scopeValue(key, otherScope());
      const foreign = (Array.isArray(other) ? other : []).filter((x) => !own.includes(x));
      const f = el('div', 'field wide list-ed');
      f.innerHTML = `<div><div class="lbl">${esc(label)}${scopeBadge(key)}${resetBtn(key)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`;
      const ctl = el('div', 'ctl');
      const ul = el('ul', 'list');
      const missing = '<span class="badge warn" title="This folder does not exist on this machine">not found</span>';
      own.forEach((p) => {
        const li = el('li', '', `<code title="${esc(p)}">${esc(p)}</code>${missingPath(p) ? missing : ''}<button class="reset x" title="Remove" aria-label="${esc(`Remove ${p}`)}">${I.x}</button>`);
        li.querySelector('button').onclick = () => set(key, own.filter((x) => x !== p));
        ul.appendChild(li);
      });
      const sc = otherScope();
      foreign.forEach((p) => {
        const tip = sc === 'workspace' ? 'Set in Workspace settings, whose list replaces this one in this workspace' : 'Set in User settings — this Workspace list replaces it here';
        ul.appendChild(el('li', 'inherited', `<code title="${esc(p)}">${esc(p)}</code>${missingPath(p) ? missing : ''}<span class="badge" title="${esc(tip)}">${sc === 'workspace' ? 'from Workspace' : 'inherited from User'}</span>`));
      });
      if (own.length || foreign.length) { ctl.appendChild(ul); }
      const row = el('div', 'row list-add');
      const input = el('input'); input.type = 'text'; input.placeholder = opts.placeholder || ''; input.setAttribute('aria-label', `${label}: entry to add`); input.dataset.fk = `${key}:add`;
      const add = el('button', 'btn sm', `${I.plus}Add`);
      const hint = el('div', 'list-hint err-text'); hint.id = `hint-${key.replace(/\W/g, '-')}`; hint.hidden = true; hint.setAttribute('role', 'alert');
      const bad = (msg) => { input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', hint.id); hint.textContent = msg; hint.hidden = false; input.focus(); };
      const clear = () => { input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); hint.hidden = true; };
      const commit = (raw) => {
        const v = String(raw ?? '').trim();
        if (!v) { bad('Type a value first'); return false; }
        if (!testValid(opts.validate, v)) { bad(opts.invalidHint || 'Not a valid entry — not added'); return false; }
        if (own.includes(v)) { bad('Already in the list'); return false; }
        clear(); set(key, [...own, v]); return true;
      };
      add.onclick = () => { if (commit(input.value)) { input.value = ''; input.focus(); } };
      input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add.onclick(); } };
      input.oninput = clear;
      row.append(input, add);
      if (opts.browse) {
        const b = el('button', 'btn sm', `${I.folder}Browse…`); b.title = 'Pick a folder';
        b.onclick = () => post({ type: 'pickFolder', key });
        onPicked[key] = (p) => { if (!(Array.isArray(ownValue(key)) ? ownValue(key) : []).includes(p)) { set(key, [...(Array.isArray(ownValue(key)) ? ownValue(key) : []), p]); } };
        row.appendChild(b);
      }
      ctl.append(row, hint);
      f.appendChild(ctl);
      if (policyRefuses(key, undefined)) { f.classList.add('locked'); f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(policyRefuses(key, undefined))); f.querySelectorAll('.ctl :is(button, input)').forEach((x) => { x.disabled = true; x.title = MANAGED_TIP; }); }
      return component(f, [key], build);
    };
    return build();
  }
  /** Map setting (name → folder) as rows of two inputs. Writes the selected scope's own map only: VS Code merges maps, so
   *  entries from the other scope stay in effect and are shown read-only. opts: nameRe, nameHint, namePlaceholder,
   *  valuePlaceholder, browse, addLabel, empty (text when nothing is set), extra (read-only rows: { name, value, badge, tip }). */
  const kvDrafts = {};
  function keyValueEditor(key, label, desc, opts = {}) {
    const build = () => {
      const raw = scopeValue(key, state.scope);
      const own = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const otherRaw = scopeValue(key, otherScope());
      const inherited = Object.entries(otherRaw && typeof otherRaw === 'object' && !Array.isArray(otherRaw) ? otherRaw : {}).filter(([n]) => !(n in own));
      const drafts = kvDrafts[key] || (kvDrafts[key] = []);
      const f = el('div', 'field wide kv-ed');
      f.innerHTML = `<div><div class="lbl">${esc(label)}${scopeBadge(key)}${resetBtn(key)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`;
      const ctl = el('div', 'ctl');
      const rows = el('div', 'kv-rows');
      const entries = Object.entries(own);
      const nameOk = (n) => (opts.nameRe ? opts.nameRe.test(n) : !!n);
      const write = (list) => set(key, Object.fromEntries(list.filter(([n, v]) => n && v)));
      const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/[^\w.-]+/g, '-').slice(0, 40) || 'repo';
      // Saved rows (i < entries.length) and unsaved drafts share one layout; a draft is written once its name and folder are valid.
      const all = [...entries.map(([n, v]) => ({ name: n, value: String(v ?? ''), saved: true })), ...drafts.map((d) => ({ ...d, saved: false }))];
      all.forEach((r, i) => {
        const row = el('div', `kv-row${r.saved ? '' : ' draft'}`);
        const n = el('input'); n.type = 'text'; n.value = r.name; n.placeholder = opts.namePlaceholder || 'name'; n.setAttribute('aria-label', `${label}: name ${i + 1}`); n.dataset.fk = `${key}:n:${i}`; n.className = 'kv-name';
        const v = el('input'); v.type = 'text'; v.value = r.value; v.placeholder = opts.valuePlaceholder || ''; v.setAttribute('aria-label', `${label}: folder for ${r.name || `row ${i + 1}`}`); v.dataset.fk = `${key}:v:${i}`; v.className = 'kv-val';
        const hint = el('div', 'kv-hint err-text'); hint.id = `hint-${key.replace(/\W/g, '-')}-${i}`; hint.hidden = true; hint.setAttribute('role', 'alert');
        const bad = (input, msg) => { input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', hint.id); hint.textContent = msg; hint.hidden = false; };
        const ok = (input) => { input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); };
        const problem = (name) => (name && !nameOk(name) ? `${opts.nameHint || 'Not a valid name'} — not saved yet` : name && all.some((o, j) => j !== i && o.name === name && (o.saved || !r.saved)) ? 'Name already used — not saved yet' : '');
        const commit = () => {
          const name = n.value.trim(); const value = v.value.trim();
          ok(n); hint.hidden = true;
          // A draft keeps what was typed (also when it is not valid yet), so a rebuild of the list does not drop it.
          if (!r.saved) { drafts[i - entries.length] = { name, value }; all[i] = { name, value, saved: false }; }
          const why = problem(name);
          if (why) { bad(n, why); return; }
          if (!name || !value) { return; }
          const list = all.filter((o) => o.saved).map((o) => [o.name, o.value]);
          if (r.saved) { if (name === r.name && value === r.value) { return; } list[i] = [name, value]; } else { drafts.splice(i - entries.length, 1); list.push([name, value]); }
          write(list);
        };
        if (problem(r.name)) { bad(n, problem(r.name)); }
        n.onchange = commit; v.onchange = commit;
        n.onkeydown = v.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
        const tags = el('span', 'kv-tags', missingPath(r.value) ? '<span class="badge warn" title="This folder does not exist on this machine">not found</span>' : '');
        const acts = el('span', 'kv-acts');
        if (opts.browse) {
          const b = el('button', 'btn sm', `${I.folder}Browse…`); b.title = 'Pick a folder';
          b.onclick = () => { onPicked[key] = (p) => { v.value = p; if (!n.value.trim()) { let nm = baseName(p); for (let k = 2; all.some((o, j) => j !== i && o.name === nm); k++) { nm = `${baseName(p)}-${k}`; } n.value = nm; } commit(); }; post({ type: 'pickFolder', key, name: n.value.trim() || undefined }); };
          acts.appendChild(b);
        }
        const del = el('button', 'reset x', I.x); del.title = 'Remove'; del.setAttribute('aria-label', `Remove ${r.name || 'this row'}`);
        del.onclick = () => { if (r.saved) { write(all.filter((o, j) => o.saved && j !== i).map((o) => [o.name, o.value])); } else { drafts.splice(i - entries.length, 1); refreshComponents([key]); } };
        acts.appendChild(del);
        row.append(n, v, tags, acts, hint);
        rows.appendChild(row);
      });
      const extra = [...inherited.map(([n, v]) => ({ name: n, value: String(v ?? ''), badge: otherScope() === 'workspace' ? 'from Workspace' : 'inherited from User', tip: `Set in ${scopeName(otherScope())} settings; switch scope to edit it` })), ...(opts.extra || [])];
      extra.forEach((x) => rows.appendChild(el('div', 'kv-row ro', `<b class="kv-name" title="${esc(x.name)}">${esc(x.name)}</b><code class="kv-val" title="${esc(x.value)}">${esc(x.value)}</code><span class="kv-tags">${missingPath(x.value) ? '<span class="badge warn">not found</span>' : ''}<span class="badge" title="${esc(x.tip || '')}">${esc(x.badge)}</span></span>`)));
      if (!all.length && !inherited.length && opts.empty) { ctl.appendChild(el('div', 'muted small kv-empty', opts.empty)); }
      if (all.length || extra.length) { ctl.appendChild(rows); }
      const addBtn = el('button', 'btn sm kv-add', `${I.plus}${esc(opts.addLabel || 'Add')}`);
      addBtn.onclick = () => { drafts.push({ name: '', value: '' }); refreshComponents([key]); const ins = app.querySelectorAll(`[data-fk^="${CSS.escape(key)}:n:"]`); if (ins.length) { ins[ins.length - 1].focus(); } };
      ctl.appendChild(el('div', 'btnrow')).appendChild(addBtn);
      f.appendChild(ctl);
      if (policyRefuses(key, undefined)) { f.classList.add('locked'); f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(policyRefuses(key, undefined))); f.querySelectorAll('.ctl :is(button, input)').forEach((x) => { x.disabled = true; x.title = MANAGED_TIP; }); }
      return component(f, [key], build);
    };
    return build();
  }
  const enabledModels = () => (state.data.models || []).filter((m) => !m.disabled);
  const FIRST_TOKEN_OPTIONS = [[60, '1 min'], [120, '2 min'], [180, '3 min (default)'], [300, '5 min'], [600, '10 min'], [900, '15 min'], [1800, '30 min'], [0, 'No limit']];
  /** Settings → Models → Routing: the ordered fallback list (routing.fallbackModels, User only). Up/down reorder, × removes,
   *  the select adds an installed model; an entry that is not available now stays listed with a badge (it is skipped). */
  function fallbackEditor() {
    const key = 'routing.fallbackModels';
    const build = () => {
      const list = Array.isArray(val(key)) ? val(key).filter((x) => typeof x === 'string') : [];
      const models = enabledModels();
      const nameOf = (id) => { const m = models.find((x) => x.id === id); return m ? m.name : shortId(id); };
      const f = el('div', 'field wide fallback-ed');
      f.innerHTML = `<div><div class="lbl">Fallback order${scopeBadge(key)}${resetBtn(key)}</div><div class="desc">When the chosen model is unavailable (server down, model removed, offline), the first available model in this list answers the turn, and the chat says so. Without a list, the best available model is used. A cloud model listed here is the only way a local model ever falls back to the cloud.</div></div>`;
      const ctl = el('div', 'ctl');
      const ol = el('ol', 'list fb-list'); ol.setAttribute('aria-label', 'Fallback models, first is tried first');
      const write = (next) => set(key, next);
      list.forEach((id, i) => {
        const m = models.find((x) => x.id === id);
        const li = el('li', '', `<span class="fb-n" aria-hidden="true">${i + 1}</span><span class="fb-name"><b title="${esc(id)}">${esc(nameOf(id))}</b><span class="fb-sub"><code title="${esc(id)}">${esc(id)}</code>${m ? (m.remote ? '<span class="badge" title="Prompts and code sent to this model leave this machine">cloud</span>' : '') : '<span class="badge warn" title="Not listed by any provider right now: skipped until it is">not available</span>'}</span></span><span class="fb-acts"><button class="reset" data-a="up" title="Move up" aria-label="${esc(`Move ${nameOf(id)} up`)}" ${i ? '' : 'disabled'}>${I.chev}</button><button class="reset" data-a="down" title="Move down" aria-label="${esc(`Move ${nameOf(id)} down`)}" ${i < list.length - 1 ? '' : 'disabled'}>${I.chev}</button><button class="reset x" data-a="rm" title="Remove" aria-label="${esc(`Remove ${nameOf(id)}`)}">${I.x}</button></span>`);
        li.querySelector('.fb-acts').onclick = (e) => {
          const b = e.target.closest('button[data-a]'); if (!b || b.disabled) { return; }
          const next = list.slice();
          if (b.dataset.a === 'rm') { next.splice(i, 1); } else { const j = b.dataset.a === 'up' ? i - 1 : i + 1; [next[i], next[j]] = [next[j], next[i]]; }
          write(next);
        };
        ol.appendChild(li);
      });
      if (list.length) { ctl.appendChild(ol); } else { ctl.appendChild(el('div', 'muted small fb-empty', 'No fallback order: the best available model is used.')); }
      const free = models.filter((m) => !list.includes(m.id));
      const row = el('div', 'row list-add');
      const sel = el('select'); sel.setAttribute('aria-label', 'Model to add to the fallback order'); sel.dataset.fk = `${key}:add`;
      sel.innerHTML = `<option value="">${free.length ? 'Add a model…' : models.length ? 'Every model is listed' : 'No models available'}</option>` + free.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.providerId)}${m.remote ? ' · cloud' : ''}</option>`).join('');
      sel.disabled = !free.length;
      sel.onchange = () => { if (sel.value) { write([...list, sel.value]); } };
      row.appendChild(sel);
      ctl.appendChild(row);
      f.appendChild(ctl);
      return component(f, [key], build);
    };
    return build();
  }
  const modelOptions = (filter) => enabledModels().filter(filter || (() => true)).map((m) => [m.id, m.name, `${m.providerId} · ${Math.round(m.contextWindow / 1024)}k${m.supportsTools ? ' · tools' : ''}${m.supportsVision ? ' · vision' : ''}${m.supportsFim ? ' · FIM' : ''}`]);
  const shortId = (id) => String(id || '').split('/').pop();

  // ------------------------------------------------------------------ shell
  /**
   * Settings page: the header and sidebar are built once and kept; render() only swaps the <section> for the
   * current page. Setting changes go through refreshComponents() and never reach here unless they restructure
   * the page. The setup wizard is small and still renders as a whole.
   */
  let renderedSection = null;
  let renderedSetupStep = -1;
  function render() {
    if (!state.data) { return; }
    // Rebuilding collapses the document and drops the scroll position; put it back once the page is rebuilt — unless
    // the user moved to another section, which must start at its top.
    const sameSection = state.page === 'settings' && renderedSection === `${state.page}/${state.section}`;
    // An async state push must not rebuild the field being edited: wait until it loses focus (its own blur/change
    // commit runs first). Search boxes re-render on purpose and restore their own focus.
    const act = document.activeElement;
    if (sameSection && act && /^(INPUT|TEXTAREA|SELECT)$/.test(act.tagName) && act.type !== 'search' && act.closest('main.content > .sec')) {
      if (state.renderPendingOn !== act) {
        state.renderPendingOn = act;
        act.addEventListener('focusout', () => setTimeout(() => { if (state.renderPendingOn === act) { state.renderPendingOn = null; render(); } }), { once: true });
      }
      return;
    }
    state.renderPendingOn = null;
    const y = sameSection ? window.scrollY : 0;
    renderedSection = `${state.page}/${state.section}`;
    app.removeAttribute('aria-busy');
    if (state.page === 'setup') {
      if (state.dash.timer) { stopDashboardTimer(); }
      // Fade in only when the wizard opens or moves to another step; a probe result or a click on the same step
      // swaps the content in place and keeps focus on the control that was used.
      const enter = app.dataset.page !== 'setup' || renderedSetupStep !== state.setup.step;
      const focusKey = !enter && act && app.contains(act) ? act.dataset.id || act.id : '';
      renderedSetupStep = state.setup.step;
      app.innerHTML = ''; app.dataset.page = 'setup';
      renderSetup();
      if (enter) { const w = app.querySelector('.setup'); if (w) { w.classList.add('enter'); } }
      const back = focusKey && [...app.querySelectorAll('[data-id], [id]')].find((n) => (n.dataset.id || n.id) === focusKey);
      if (back && !back.disabled) { back.focus({ preventScroll: true }); }
    } else {
      if (app.dataset.page !== 'settings') { app.innerHTML = ''; app.dataset.page = 'settings'; renderShell(); }
      syncShell();
      renderSection();
    }
    window.scrollTo(0, y);
  }
  function renderShell() {
    const d = state.data;
    const top = el('header', 'top');
    top.innerHTML = `<div class="brand"><img src="${LOGO}" alt=""><div><b>LocalPilot</b><span>Settings</span></div></div>
      <div class="find" role="search"><button class="find-open" title="Search settings (⌘F)" aria-label="Search settings">${I.search}</button><label class="find-box">${I.search}<input type="search" placeholder="Search settings" aria-label="Search settings" aria-controls="find-list" aria-autocomplete="list" autocomplete="off" spellcheck="false"><kbd>⌘F</kbd></label><div class="find-list hidden" id="find-list" role="listbox" aria-label="Matching settings"></div></div>
      <span class="spacer"></span>
      <span class="saved" role="status" aria-live="polite">${I.check}Saved</span>
      <div class="scope" role="radiogroup" aria-label="Settings scope" title="User: all folders. Workspace: only this folder (.vscode/settings.json) — wins over User."><button data-s="user" aria-label="User settings">User</button><button data-s="workspace" aria-label="Workspace settings"><span class="long">Workspace</span><span class="short">Wksp</span></button></div>
      <button class="btn" data-cmd="localpilot.openChat" title="Open chat" aria-label="Open chat">${I.chat}Open chat</button>`;
    top.querySelectorAll('.scope button').forEach((b) => (b.onclick = () => { if (b.disabled || state.scope === b.dataset.s) { return; } state.scope = b.dataset.s; render(); }));
    radioGroup(top.querySelector('.scope'));
    wireFind(top);
    app.appendChild(top);
    const layout = el('div', 'layout');
    const side = el('nav', `side${navPrefs.rail ? ' rail' : ''}`); side.setAttribute('aria-label', 'Settings sections');
    const byId = Object.fromEntries(SECTIONS.map((s) => [s[0], s]));
    const group = (id, label, body) => {
      const open = !navPrefs.collapsed.includes(id);
      return `<div class="navgrp${open ? '' : ' closed'}" data-grp="${id}"><button class="grp" aria-expanded="${open}" aria-controls="navgrp-${id}" title="${open ? 'Collapse' : 'Expand'} ${esc(label)}"><span class="chev">${I.chev}</span><span class="lbl">${esc(label)}</span></button><div class="items" id="navgrp-${id}">${body}</div></div>`;
    };
    const tabLinks = (ids) => ids.map((id) => byId[id]).filter(Boolean).map(([id, label, icon]) => `<a data-sec="${id}" role="tab" tabindex="-1" title="${esc(label)}">${icon}<span class="lbl">${esc(label)}</span></a>`).join('');
    const tabsHtml = `<div class="navhome">${tabLinks(NAV_HOME)}</div>` + NAV_GROUPS.map((g) => group(g.id, g.label, tabLinks(g.items))).join('');
    const helpHtml = `<a data-cmd="localpilot.openWelcome" role="button" tabindex="0" title="Run setup again">${I.rocket}<span class="lbl">Run setup again</span></a><a data-url="https://isathish.github.io/localpilot/docs/configuration/" role="link" tabindex="0" title="Documentation">${I.book}<span class="lbl">Documentation</span></a>`;
    side.innerHTML = `<div class="navbar"><button class="navtog" title="${navPrefs.rail ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${navPrefs.rail ? 'Expand sidebar' : 'Collapse sidebar'}" aria-pressed="${navPrefs.rail}"><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.5 3v10"/></svg></button><button class="navall" title="Expand all groups" aria-label="Expand or collapse all groups">${I.chev}</button></div><div class="tabs" role="tablist" aria-orientation="vertical">${tabsHtml}</div>${group('help', 'Help', helpHtml)}`;
    // Arrow keys move between the sections that are visible right now (a collapsed group keeps only its active entry).
    const visibleTabs = () => [...side.querySelectorAll('[data-sec]')].filter((a) => a.offsetParent !== null);
    // Section changes cross-fade (View Transitions where available; settings.css styles them, reduced motion skips them).
    const go = (a) => {
      if (state.section === a.dataset.sec) { a.focus({ preventScroll: true }); return; }
      const swap = () => { state.section = a.dataset.sec; state.expanded = null; render(); };
      if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) { document.startViewTransition(swap); } else { swap(); }
      a.focus({ preventScroll: true });
    };
    side.querySelectorAll('[data-sec]').forEach((a) => {
      a.onclick = () => go(a);
      // Keyboard: Enter/Space activates; arrows move between sections like a native tab strip.
      a.onkeydown = (e) => {
        const tabs = visibleTabs(); const i = tabs.indexOf(a);
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(a); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); go(tabs[(i + 1) % tabs.length]); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); go(tabs[(i - 1 + tabs.length) % tabs.length]); }
        else if (e.key === 'Home') { e.preventDefault(); go(tabs[0]); } else if (e.key === 'End') { e.preventDefault(); go(tabs[tabs.length - 1]); }
      };
    });
    const setGroup = (g, open) => {
      const id = g.dataset.grp; const b = g.querySelector(':scope > .grp');
      g.classList.toggle('closed', !open); b.setAttribute('aria-expanded', String(open));
      b.title = `${open ? 'Collapse' : 'Expand'} ${b.textContent.trim()}`;
      navPrefs.collapsed = navPrefs.collapsed.filter((x) => x !== id).concat(open ? [] : [id]);
    };
    const syncAllBtn = () => { const any = side.querySelector('.navgrp.closed'); const b = side.querySelector('.navall'); b.classList.toggle('open', !any); b.title = any ? 'Expand all groups' : 'Collapse all groups'; };
    side.querySelectorAll('.navgrp > .grp').forEach((b) => {
      b.onclick = () => { const g = b.parentElement; setGroup(g, g.classList.contains('closed')); saveNavPrefs(); syncAllBtn(); };
    });
    side.querySelector('.navall').onclick = () => {
      const open = !!side.querySelector('.navgrp.closed');
      side.querySelectorAll('.navgrp').forEach((g) => setGroup(g, open));
      saveNavPrefs(); syncAllBtn();
    };
    side.querySelector('.navtog').onclick = (e) => {
      navPrefs.rail = !navPrefs.rail; saveNavPrefs();
      side.classList.toggle('rail', navPrefs.rail);
      const t = e.currentTarget; const label = navPrefs.rail ? 'Expand sidebar' : 'Collapse sidebar';
      t.title = label; t.setAttribute('aria-label', label); t.setAttribute('aria-pressed', String(navPrefs.rail));
    };
    syncAllBtn();
    side.querySelectorAll('[data-cmd],[data-url]').forEach((a) => { a.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } }; });
    // Narrow layout turns the nav into a scrolling pill strip: show fades where more pills are hidden, and a ⋯ at its
    // end lists every section. The list lives outside the strip, which would clip and fade it.
    side.onscroll = () => updateNavFades(side);
    const navOrder = [...NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)].map((id) => byId[id]).filter(Boolean);
    const navMore = moreMenu(navOrder.map(([id, label, icon]) => [icon, label, () => { const a = side.querySelector(`[data-sec="${id}"]`); if (a) { go(a); } }]), 'navmore', {
      html: '⋯', label: 'All sections', floating: true,
      onOpen: (menu) => {
        menu.querySelectorAll('button').forEach((b, i) => { const on = navOrder[i][0] === state.section; b.classList.toggle('on', on); if (on) { b.setAttribute('aria-current', 'page'); } else { b.removeAttribute('aria-current'); } });
        const cur = menu.querySelector('button.on'); if (cur) { cur.focus({ preventScroll: true }); cur.scrollIntoView({ block: 'nearest' }); }
      },
    });
    side.appendChild(navMore);
    layout.appendChild(navMore._menu);
    if (!renderShell.fades) { renderShell.fades = true; window.addEventListener('resize', () => { const s = app.querySelector('.side'); if (s) { updateNavFades(s); } }); }
    layout.appendChild(side);
    const main = el('main', 'content');
    main.appendChild(el('section', 'sec'));
    layout.appendChild(main);
    app.appendChild(layout);
    wireGlobal(top); wireGlobal(side);
  }
  /** Scrolls to a setting's row, flashes it and focuses its control (search hits and deep links from the chat). */
  function focusSetting(key) {
    // The row itself, not a component around it that happens to depend on the same key.
    const hits = [...app.querySelectorAll('[data-deps]')].filter((e) => e.dataset.deps.split(/[\s,]+/).includes(key));
    const row = hits.find((e) => e.classList.contains('field')) || hits[0];
    if (!row) { return false; }
    row.scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' });
    row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
    setTimeout(() => row.classList.remove('hit'), 1800);
    const ctl = row.querySelector('.ctl input, .ctl select, .ctl textarea, .ctl button'); if (ctl) { ctl.focus({ preventScroll: true }); }
    return true;
  }
  /** Header search: results list under the box; ↑/↓ + Enter or click jumps to the section and flashes the setting.
   *  On narrow panels the box folds to an icon that opens it over the header. */
  function wireFind(top) {
    const find = top.querySelector('.find'); const q = find.querySelector('input'); const list = find.querySelector('.find-list');
    const secName = Object.fromEntries(SECTIONS.map(([id, label, icon]) => [id, { label, icon }]));
    let hits = []; let sel = 0;
    const close = () => { list.classList.add('hidden'); q.setAttribute('aria-expanded', 'false'); };
    const fold = () => { close(); top.classList.remove('finding'); };
    const paint = () => {
      const v = q.value.trim(); hits = v ? [...findSettings(v), { ext: v }] : []; sel = Math.min(sel, Math.max(0, hits.length - 1));
      if (!v) { close(); return; }
      const item = (h, i) => `<div class="find-item${h.ext ? ' ext' : ''}${i === sel ? ' sel' : ''}" role="option" id="find-${i}" aria-selected="${i === sel}" data-i="${i}">${h.ext
        ? `<span class="ico">${I.external}</span><span class="txt"><b>Search “${esc(h.ext)}” in VS Code settings</b><small>All LocalPilot settings in the Settings editor</small></span>`
        : `<span class="ico">${secName[h.sec].icon}</span><span class="txt"><b>${esc(h.label)}</b><small>${h.key ? `${esc(secName[h.sec].label)} · <code>${esc(h.key)}</code>` : 'Section'}</small></span>`}</div>`;
      list.innerHTML = (hits.length > 1 ? '' : `<div class="find-none">No setting matches “${esc(v)}”</div>`) + hits.map(item).join('');
      list.classList.remove('hidden'); q.setAttribute('aria-expanded', 'true');
      q.setAttribute('aria-activedescendant', `find-${sel}`);
    };
    const pick = (h) => {
      if (!h) { return; }
      // The Settings editor finds every contributed key, including ones this page does not show.
      if (h.ext) { q.value = ''; fold(); q.blur(); post({ type: 'command', id: 'workbench.action.openSettings', args: [`@ext:${EXT_ID} ${h.ext}`] }); return; }
      q.value = ''; fold(); q.blur();
      state.section = h.sec; state.expanded = null;
      // MCP fields live on the Servers tab; a search hit must not land on Browse.
      if (h.sec === 'mcp' && h.key) { mcpCatState().view = 'installed'; }
      render();
      if (!h.key) { window.scrollTo({ top: 0 }); return; }
      requestAnimationFrame(() => focusSetting(h.key));
    };
    q.oninput = () => { sel = 0; paint(); };
    q.onfocus = () => { if (q.value.trim()) { paint(); } };
    q.onkeydown = (e) => {
      if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); sel = (sel + 1) % hits.length; paint(); }
      else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); sel = (sel - 1 + hits.length) % hits.length; paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hits[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); if (q.value) { q.value = ''; close(); } else { fold(); q.blur(); } }
    };
    // mousedown, not click: the input's blur would otherwise close the list before the click lands.
    list.onmousedown = (e) => { const it = e.target.closest('.find-item'); if (it) { e.preventDefault(); pick(hits[Number(it.dataset.i)]); } };
    q.onblur = () => setTimeout(() => { if (!find.contains(document.activeElement)) { close(); if (!q.value) { top.classList.remove('finding'); } } }, 0);
    find.querySelector('.find-open').onclick = () => { top.classList.add('finding'); q.focus(); };
    // ⌘F / Ctrl+F (the panel has no find widget) and "/" outside a text field open the search from anywhere.
    // Registered once: renderShell runs again after the setup page, and the handler looks up the current header.
    if (wireFind.keys) { return; }
    wireFind.keys = true;
    window.addEventListener('keydown', (e) => {
      const t = app.querySelector('.top'); const box = t && t.querySelector('.find input'); if (!box) { return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) { e.preventDefault(); t.classList.add('finding'); box.focus(); box.select(); }
    });
  }
  /** Cheap per-render sync of the persistent shell: version, scope buttons, active nav entry. */
  function syncShell() {
    const d = state.data;
    app.querySelectorAll('.top .scope button').forEach((b) => {
      b.classList.toggle('on', state.scope === b.dataset.s);
      if (b.dataset.s === 'workspace') { b.disabled = !d.hasWorkspace; b.title = d.hasWorkspace ? 'Only this folder (.vscode/settings.json) — wins over User' : 'Open a folder to edit workspace settings'; } else { b.title = 'All folders'; }
    });
    const sc = app.querySelector('.top .scope'); if (sc && sc._radioSync) { sc._radioSync(); }
    app.dataset.scope = state.scope;
    app.querySelectorAll('.side [data-sec]').forEach((a) => { const on = a.dataset.sec === state.section; a.classList.toggle('on', on); a.setAttribute('aria-selected', String(on)); a.tabIndex = on ? 0 : -1; if (on) { a.setAttribute('aria-current', 'page'); } else { a.removeAttribute('aria-current'); } });
    const side = app.querySelector('.side'); const on = side && side.querySelector('[data-sec].on');
    if (side && on && side.scrollWidth > side.clientWidth + 2) { on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' }); }
    if (side) { updateNavFades(side); }
  }
  function updateNavFades(side) {
    const more = side.scrollWidth > side.clientWidth + 2;
    side.classList.toggle('fade-l', more && side.scrollLeft > 4);
    side.classList.toggle('fade-r', more && side.scrollLeft + side.clientWidth < side.scrollWidth - 4);
  }
  function renderSection() {
    if (state.section !== 'dashboard' && state.dash.timer) { stopDashboardTimer(); }
    const sec = el('section', 'sec');
    ({ providers: secProviders, models: secModels, gallery: secGallery, marketplace: secMarketplace, skills: secSkills, customize: secCustomize, agent: secAgent, completions: secCompletions, web: secWeb, documents: secDocuments, memory: secMemory, mcp: secMcp, dashboard: secDashboard, telemetry: secTelemetry, shortcuts: secShortcuts, advanced: secAdvanced }[state.section] || secProviders)(sec);
    wireGlobal(sec);
    const old = app.querySelector('main.content > .sec');
    if (old) { old.replaceWith(sec); } else { app.querySelector('main.content').appendChild(sec); }
  }
  function wireGlobal(root) {
    // Commands run in the host with no reply, so the button acknowledges the click with a short spin of its icon.
    root.querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () => { let args; try { args = b.dataset.args ? JSON.parse(b.dataset.args) : undefined; } catch { args = undefined; } post({ type: 'command', id: b.dataset.cmd, args }); if (b.classList.contains('btn')) { b.classList.add('busy'); setTimeout(() => b.classList.remove('busy'), 1200); } }));
    root.querySelectorAll('[data-url]').forEach((b) => (b.onclick = () => post({ type: 'openExternal', url: b.dataset.url })));
    root.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); reset(b.dataset.reset); }));
    // An inline link to another section ("MCP servers" in a description); sections may wire their own the same way.
    root.querySelectorAll('button.inline-link[data-sec]').forEach((b) => { if (!b.onclick) { b.onclick = () => { state.section = b.dataset.sec; render(); }; } });
  }
  // An organisation policy (managed-settings.json) is shown in full where it bites (approvals, providers), and as one line elsewhere.
  const policyNote = (full) => { const m = state.data && state.data.managed; if (!m) { return ''; } return `<div class="policy" role="note">${I.shield}<div><b>Managed by your organization</b>${m.message ? ` <span class="pm">${esc(m.message)}</span>` : ''}${full && m.lines.length ? `<ul>${m.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ' Some settings here may have no effect.'}<small>${esc(m.source)}</small></div></div>`; };
  const head = (sec, title, lead) => { sec.innerHTML = `<h1>${esc(title)}</h1><p class="lead">${lead}</p>${policyNote(['Agent & approvals', 'Providers', 'Skills & subagents', 'MCP servers', 'Web search'].includes(title))}`; };

  // ------------------------------------------------------------------ providers
  function providersList() { const v = ownValue('providers'); return Array.isArray(v) ? v.map((p) => ({ ...p })) : []; }
  function saveProviders(list) {
    set('providers', list);
    // Optimistic: the next edit (or a render before the round-trip) starts from this list, not the last snapshot.
    const s = state.data && state.data.settings.providers;
    if (s) {
      const copy = () => JSON.parse(JSON.stringify(list));
      s[state.scope === 'workspace' ? 'workspaceValue' : 'userValue'] = copy();
      if (state.scope === 'workspace' || s.workspaceValue === undefined) { s.value = copy(); }
    }
  }
  /** " 312 GB free on that disk." under Models folder (a warning when even the smallest model would not fit); Start colibri checks again before it downloads. */
  function colibriDiskText() {
    const d = state.data && state.data.colibriDisk; if (!d || d.freeGb === undefined) { return ''; }
    const low = d.freeGb < d.smallestGb;
    return ` <span class="${low ? 'warn-text' : ''}" title="${esc(d.dir)}">${low ? I.warn : ''}${Number(d.freeGb).toLocaleString()} GB free on that disk${low ? `: less than the smallest model needs (${d.smallestGb} GB). Pick a folder on a bigger disk.` : '.'}</span>`;
  }
  function secProviders(sec) {
    head(sec, 'Providers', 'Local servers keep your code on this machine; cloud providers receive what you send them. Automatic picks prefer local models.');
    sec.querySelector('h1').insertAdjacentHTML('beforeend', scopeBadge('providers'));
    if (state.scope === 'user' && S('providers').workspaceValue !== undefined) {
      const note = el('div', 'empty', 'This workspace’s <code>.vscode/settings.json</code> defines its own provider list, which replaces the User list shown here. ');
      const go = el('button', 'btn sm', 'Edit workspace providers');
      go.onclick = () => { state.scope = 'workspace'; render(); };
      note.appendChild(go); sec.appendChild(note);
    }
    const list = providersList();
    const bar = el('div', 'btnrow');
    bar.innerHTML = `<button class="btn primary" id="probe">${state.busy ? '<span class="spinner"></span>' : I.refresh}Check all connections</button><button class="btn" data-cmd="localpilot.refreshModels">${I.cpu}Refresh model list</button><span class="spacer"></span><span class="muted small">${plural(enabledModels().length, 'model')} available</span>`;
    bar.querySelector('#probe').onclick = () => { state.busy = true; state.probedSig = providerSig(list); state.probedAt = Date.now(); render(); post({ type: 'probe' }); };
    sec.appendChild(bar);
    // Configured providers, local first: the split shows at a glance which models keep code on this machine.
    // The organisation's providers: locked, only the key is the user's. A same-id entry of the user's is shown here, not below.
    const orgProv = (POLICY() && POLICY().providers) || [];
    const orgIds = new Set(orgProv.map((p) => p.id));
    if (orgProv.length) {
      const org = el('div', 'prov-list');
      org.appendChild(el('div', 'prov-group', `<b>Your organization</b><span class="count">${orgProv.length}</span><span class="muted small">configured by your administrator; add your key</span>`));
      for (const p of orgProv) { org.appendChild(orgProviderCard(p)); }
      sec.appendChild(org);
    }
    const wrap = el('div', 'prov-list'); wrap.dataset.deps = 'providers';
    if (!list.length && !orgProv.length) { wrap.appendChild(el('div', 'empty', 'No providers yet. Add one below: Ollama is the quickest local start, a cloud API needs only a key.')); }
    const mixed = list.some(isCloud) && list.some((p) => !isCloud(p));
    for (const [cloud, label, hint] of [[false, 'Local', 'code stays on this machine'], [true, 'Cloud', 'prompts and code are sent to the provider']]) {
      const items = list.filter((p) => isCloud(p) === cloud && !orgIds.has(p.id));
      if (!items.length) { continue; }
      if (mixed) { wrap.appendChild(el('div', 'prov-group', `<b>${label}</b><span class="count">${items.length}</span><span class="muted small">${hint}</span>`)); }
      for (const p of items) { wrap.appendChild(providerCard(p, list)); }
    }
    sec.appendChild(wrap);

    // Adding: one kind at a time with a filter, instead of thirty tiles at once. A filter searches every kind.
    const add = el('div', 'add-prov');
    add.appendChild(el('h2', 'sub', 'Add a provider'));
    const tab = state.addTab || (list.some((p) => !isCloud(p)) ? 'cloud' : 'local');
    const chips = el('div', 'chips');
    chips.setAttribute('role', 'tablist');
    for (const [k, label] of PRESET_GROUPS) {
      const b = el('button', `chip ${tab === k ? 'on' : ''}`, `${esc(label)} <i>${PRESET_PROVIDERS.filter((pr) => pr.group === k).length}</i>`);
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(tab === k));
      b.onclick = () => { state.addTab = k; state.addQuery = ''; render(); };
      chips.appendChild(b);
    }
    const q = el('input'); q.type = 'search'; q.placeholder = 'Find a provider…'; q.value = state.addQuery || ''; q.setAttribute('aria-label', 'Find a provider');
    chips.appendChild(q);
    add.appendChild(chips);
    const blurb = el('p', 'muted small add-blurb');
    const presets = el('div', 'presets');
    const addPreset = (pr) => {
      const cfg = { ...pr.cfg };
      if (list.some((p) => p.id === cfg.id)) { let n = 2; while (list.some((p) => p.id === `${cfg.id}-${n}`)) { n++; } cfg.id = `${cfg.id}-${n}`; }
      state.expanded = cfg.id;
      // A new cloud provider is useless without its key: open the card with the key field focused.
      state.focusKey = pr.group === 'cloud' ? cfg.id : null;
      // A custom endpoint needs its URL first.
      state.focusUrl = pr.key === 'custom' ? cfg.id : null;
      saveProviders([...list, cfg]);
      render();
    };
    // A query ranks every category with the fuzzy scorer (best match first, letters highlighted); without one the
    // tab's presets show in list order. Arrow keys move through the grid, Enter adds, Esc clears the query.
    let cursor = 0;
    const tiles = () => [...presets.querySelectorAll('button.preset')];
    const mark = (i, focus) => {
      const all = tiles(); if (!all.length) { return; }
      cursor = Math.max(0, Math.min(all.length - 1, i));
      all.forEach((b, k) => { b.classList.toggle('kbd', k === cursor && !!q.value.trim()); b.tabIndex = k === cursor ? 0 : -1; });
      if (focus) { all[cursor].focus(); }
    };
    const fill = () => {
      presets.innerHTML = '';
      const needle = q.value.trim();
      blurb.textContent = needle ? 'Best matches from every category.' : PRESET_GROUPS.find((g) => g[0] === tab)[2];
      const taken = (pr) => list.some((p) => p.id === pr.cfg.id);
      // Already-added ones sink to the end so the grid leads with what can still be added.
      const ranked = needle ? rankPresets(needle, PRESET_PROVIDERS) : PRESET_PROVIDERS.filter((pr) => pr.group === tab).map((preset) => ({ preset, labelHl: [] }));
      for (const { preset: pr, labelHl } of [...ranked.filter((x) => !taken(x.preset)), ...ranked.filter((x) => taken(x.preset))]) {
        const added = taken(pr);
        const b = el('button', `preset ${added ? 'added' : ''}`, `${brandMark(pr.key, pr.label)}<div><b title="${esc(pr.label)}">${hlText(pr.label, labelHl)}</b><span title="${esc(pr.sub)}">${added ? 'added' : esc(pr.sub)}</span></div>`);
        b.title = added ? `${pr.label} is already configured — add it again for a second endpoint` : `Add ${pr.label}`;
        b.onclick = () => addPreset(pr);
        presets.appendChild(b);
      }
      if (!ranked.length) { presets.appendChild(el('div', 'empty', 'Nothing matches. Any OpenAI-compatible server works as a custom endpoint.')); }
      mark(0, false);
    };
    /** Tiles per row, from the layout (the grid wraps with the window width). */
    const perRow = () => { const all = tiles(); const top = all.length ? all[0].offsetTop : 0; const n = all.filter((b) => b.offsetTop === top).length; return Math.max(1, n); };
    const clearQuery = () => { q.value = ''; state.addQuery = ''; fill(); q.focus(); };
    q.oninput = () => { state.addQuery = q.value; fill(); };
    q.onkeydown = (e) => {
      if (e.isComposing) { return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); mark(cursor, true); }
      else if (e.key === 'Enter') { const b = tiles()[cursor]; if (b && q.value.trim()) { e.preventDefault(); b.click(); } }
      else if (e.key === 'Escape' && q.value) { e.preventDefault(); e.stopPropagation(); clearQuery(); }
    };
    presets.onkeydown = (e) => {
      const all = tiles(); const i = all.indexOf(document.activeElement); if (i < 0) { return; }
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow(), ArrowUp: -perRow(), Home: -i, End: all.length - 1 - i }[e.key];
      if (step !== undefined) {
        e.preventDefault();
        // Up from the first row goes back to the search box.
        if (e.key === 'ArrowUp' && i + step < 0) { q.focus(); return; }
        mark(i + step, true);
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearQuery(); }
    };
    presets.onfocusin = (e) => { const i = tiles().indexOf(e.target); if (i >= 0) { cursor = i; } };
    fill();
    add.appendChild(blurb);
    add.appendChild(presets);
    const custom = el('div', 'btnrow add-custom');
    custom.innerHTML = `<span class="muted small">Not listed? Any server with an OpenAI-compatible <code>/v1</code> API works.</span><span class="spacer"></span><button class="btn sm" id="custom">${I.plug}Custom endpoint</button>`;
    custom.querySelector('#custom').onclick = () => addPreset(CUSTOM_PRESET);
    add.appendChild(custom);
    sec.appendChild(add);
    sec.appendChild(el('h2', 'sub', 'Huge MoE models (colibri)'));
    const coli = el('div', 'btnrow');
    coli.innerHTML = `<span class="muted small">A running colibri is detected automatically. <b>Start</b> installs colibri if needed (clone, engine, a model that fits) and starts it in a terminal.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.stopColibri">${I.x}Stop</button><button class="btn sm primary" data-cmd="localpilot.startColibri">${I.bolt}Start colibri</button>`;
    sec.appendChild(card(
      el('div', 'field wide', '<div><div class="desc"><a data-url="https://github.com/JustVugg/colibri">colibri</a> runs very large mixture-of-experts models (GLM-5.2, DeepSeek V4 Flash, Qwen3-Coder-30B…) by keeping the dense part in RAM and streaming experts from disk.</div></div>'),
      field('colibri.path', 'colibri folder', 'A checkout (with <code>c/coli</code>) or an unpacked release. Empty = <code>coli</code> on PATH, then <code>~/colibri</code>; Start colibri offers to install it.', 'text', { placeholder: '~/colibri', wide: true }),
      field('colibri.model', 'Model', 'A catalog id (<code>qwen3-coder-30b</code>, <code>glm-5.2</code>) or a model folder. Empty = colibri recommends one for this machine.', 'text', { placeholder: 'recommended' }),
      field('colibri.modelsDir', 'Models folder', `Where models are downloaded (19 GB to 1.6 TB each). Empty = <code>~/colibri-models</code>.${colibriDiskText()}`, 'text', { placeholder: '~/colibri-models', wide: true }),
      field('colibri.backend', 'GPU backend', 'The engine colibri builds or downloads at setup. Apple Silicon uses Metal automatically.', 'select', { options: [['auto', 'Automatic (CUDA, then Vulkan, then CPU)'], ['cuda', 'CUDA (NVIDIA)'], ['vulkan', 'Vulkan'], ['cpu', 'CPU only']] }),
      field('colibri.port', 'Port', 'Where <code>coli serve</code> listens; auto-detect probes it too.', 'number', { min: 1, max: 65535 }),
      field('colibri.kvSlots', 'Parallel conversations', 'KV slots, so parallel agents keep their own cached context. A few hundred MB each; capped by <a data-sec="agent">max concurrent tools / subagents</a>.', 'number', { min: 1, max: 16 }),
      coli
    ));
    sec.appendChild(el('h2', 'sub', 'Gateways'));
    sec.appendChild(card(
      el('div', 'field wide', '<div><div class="desc">Add <b>OmniRoute</b> or <b>LiteLLM proxy</b> from the Gateways tab above, then <b>Start</b> on its card (or <i>LocalPilot: Start Gateway</i>) installs it if needed and runs it on <code>127.0.0.1</code>. Connect providers in the gateway\'s own dashboard.</div></div>'),
      field('gateways.litellmConfig', 'LiteLLM config file', 'The proxy config (<code>model_list</code>) passed to <code>litellm --config</code>. Empty = asked for on first start.', 'text', { placeholder: '~/litellm/config.yaml', wide: true })
    ));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
    // Reachability is shown without being asked for: probe when the page opens, when the provider list changes
    // (a server was added or its URL edited) and when the last check is older than a minute. The button stays for an
    // immediate re-check. Results arrive as a `probe` message and re-render the cards with ok / unreachable.
    const sig = providerSig(list);
    const stale = !state.probe || sig !== state.probedSig || Date.now() - (state.probedAt || 0) > 60_000;
    if (list.length && stale && !state.busy) {
      state.probedSig = sig; state.probedAt = Date.now(); state.busy = true;
      bar.querySelector('#probe').innerHTML = '<span class="spinner"></span>Check all connections';
      for (const d of sec.querySelectorAll('.prov:not(.off) .dot:not(.ok):not(.err)')) { d.className = 'dot busy'; }
      post({ type: 'probe' });
    }
  }
  const providerSig = (list) => list.map((p) => { const k = (state.data.keys || {})[p.id] || {}; return `${p.id}@${p.baseUrl}@${p.enabled === false ? 0 : 1}@${p.type}@${p.cloud ? 1 : 0}@${p.apiKey || ''}@${k.source || ''}${k.ok ? 1 : 0}`; }).join('|');
  /** Key state without the key: a warning badge for the header when it will not resolve, a note for the key row when it does. */
  function keyState(p) {
    const k = (state.data.keys || {})[p.id];
    if (!k || (k.source === 'none' && !isRemoteUrl(p.baseUrl))) { return { warn: '', note: '' }; }
    if (!k.ok) { return { warn: k.source === 'env' ? `${k.env} not set` : k.source === 'keychain' ? 'key missing' : 'no API key', note: '' }; }
    return { warn: '', note: k.source === 'keychain' ? 'Saved in your OS keychain.' : k.source === 'env' ? `Read from <code>$${esc(k.env)}</code>.` : 'Stored in settings.json.' };
  }
  /** Model ids the provider's last check listed (without the `provider/` prefix). */
  const listedIds = (p, probe) => (probe && probe.ok ? probe.models.map((m) => (String(m.id).startsWith(`${p.id}/`) ? String(m.id).slice(p.id.length + 1) : String(m.id))) : []);
  const datalist = (id, values) => { const dl = el('datalist'); dl.id = id; dl.innerHTML = values.map((v) => `<option value="${esc(v)}">`).join(''); return dl; };
  /** The provider's default model: a dropdown of what the server lists, with loading and error states, or any typed id. */
  function defaultModelCtl(p, probe, upd) {
    const wrap = el('div', 'btnrow'); wrap.style.margin = '0';
    const ids = listedIds(p, probe);
    const loading = state.tests[p.id] === null || (!probe && state.busy);
    const i = el('input'); i.type = 'text'; i.value = p.defaultModel || ''; i.setAttribute('list', `dm-${p.id}`); i.setAttribute('aria-label', 'Default model');
    i.placeholder = loading ? 'Loading models…' : probe && !probe.ok ? 'type a model id' : ids.length ? `one of ${ids.length} listed, or any id` : 'type a model id';
    const commit = () => { const v = i.value.trim(); if ((p.defaultModel || '') !== v) { upd({ defaultModel: v || undefined }); } };
    i.onchange = commit; i.onblur = commit;
    wrap.append(i, datalist(`dm-${p.id}`, ids));
    if (loading) { wrap.appendChild(el('span', 'muted small', '<span class="spinner"></span>Loading models…')); }
    else if (!probe || !probe.ok) {
      const load = el('button', 'btn sm', `${I.refresh}${probe ? 'Retry' : 'Load models'}`);
      if (probe) { load.title = `Could not list models: ${probe.error || 'unreachable'}`; wrap.appendChild(el('span', 'err-text', esc(probe.error || 'Could not list models'))); }
      load.onclick = () => { state.tests[p.id] = null; render(); post({ type: 'test', provider: p }); };
      wrap.appendChild(load);
    }
    return wrap;
  }
  /** Mirrors cleanHeaders in src/providers/providerOptions.ts: an HTTP header name. */
  const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  /** The "Headers, timeout and model settings" rows of a provider card. */
  function providerMore(p, probe, upd, row) {
    const out = [];
    // Custom headers: name / value pairs; values may use ${env:NAME} and ${secret:NAME} like the key.
    const hdrBox = el('div', 'kv');
    let pairs = Object.entries(p.headers || {});
    const saveHeaders = () => { const o = {}; for (const [k, v] of pairs) { if (HEADER_NAME.test(k.trim())) { o[k.trim()] = v; } } upd({ headers: Object.keys(o).length ? o : undefined }); };
    const drawHeaders = () => {
      hdrBox.innerHTML = '';
      pairs.forEach(([k, v], idx) => {
        const r = el('div', 'kv-row');
        const ki = el('input'); ki.type = 'text'; ki.value = k; ki.placeholder = 'Header-Name'; ki.setAttribute('aria-label', 'Header name');
        const vi = el('input'); vi.type = 'text'; vi.value = v; vi.placeholder = 'value or ${env:NAME}'; vi.setAttribute('aria-label', `Value of ${k || 'the header'}`);
        const rm = el('button', 'btn sm', I.x); rm.title = 'Remove this header'; rm.setAttribute('aria-label', 'Remove this header');
        const change = () => { ki.classList.toggle('invalid', !!ki.value.trim() && !HEADER_NAME.test(ki.value.trim())); pairs[idx] = [ki.value, vi.value]; saveHeaders(); };
        ki.onchange = change; vi.onchange = change;
        rm.onclick = () => { pairs = pairs.filter((_, j) => j !== idx); saveHeaders(); drawHeaders(); };
        r.append(ki, vi, rm); hdrBox.appendChild(r);
      });
      const addH = el('button', 'btn sm', `${I.plus}Add header`);
      addH.onclick = () => { pairs = [...pairs, ['', '']]; drawHeaders(); const last = hdrBox.querySelectorAll('.kv-row input'); if (last.length) { last[last.length - 2].focus(); } };
      hdrBox.appendChild(addH);
    };
    drawHeaders();
    out.push(row('Custom headers', `Sent with every request, after the key (so they can replace it). Use <code>\${env:NAME}</code> or <code>\${secret:NAME}</code> for tokens.${isOpenRouter(p) ? ' OpenRouter gets <code>HTTP-Referer</code> and <code>X-Title</code> unless you set them.' : ''}`, hdrBox));
    const to = el('input'); to.type = 'number'; to.min = 1; to.max = 1800; to.step = 1; to.value = p.timeoutMs ? Math.round(p.timeoutMs / 1000) : ''; to.placeholder = 'auto';
    to.onchange = () => { const s = Number(to.value); upd({ timeoutMs: s > 0 ? Math.round(Math.min(1800, s) * 1000) : undefined }); };
    out.push(row('First-token timeout (s)', 'Wait at least this long for a reply to start before calling it stalled, e.g. for a gateway that loads models on demand. Empty = automatic.', to));
    if (/\.(openai\.azure\.com|cognitiveservices\.azure\.com)$/i.test(hostOfUrl(p.baseUrl)) || p.apiVersion) {
      const av = el('input'); av.type = 'text'; av.value = p.apiVersion || ''; av.placeholder = '2024-10-21';
      av.onchange = () => { const v = av.value.trim(); if (v && !/^[\w.-]+$/.test(v)) { av.classList.add('invalid'); return; } av.classList.remove('invalid'); upd({ apiVersion: v || undefined }); };
      out.push(row('Azure api-version', 'Only for deployment URLs (<code>…/openai/deployments/&lt;name&gt;</code>); the <code>/openai/v1</code> endpoint needs none.', av));
    }
    if (isOpenRouter(p)) {
      const sort = ((p.extraBody || {}).provider || {}).sort || '';
      const sel = el('select', '', [['', 'OpenRouter default (balanced)'], ['price', 'Lowest price'], ['throughput', 'Highest throughput'], ['latency', 'Lowest latency']].map(([v, l]) => `<option value="${v}">${l}</option>`).join(''));
      sel.value = sort;
      sel.onchange = () => {
        const eb = JSON.parse(JSON.stringify(p.extraBody || {})); const prov = { ...(eb.provider || {}) };
        if (sel.value) { prov.sort = sel.value; } else { delete prov.sort; }
        if (Object.keys(prov).length) { eb.provider = prov; } else { delete eb.provider; }
        upd({ extraBody: Object.keys(eb).length ? eb : undefined });
      };
      out.push(row('Route requests by', 'Which upstream provider OpenRouter prefers for each model (<code>provider.sort</code>).', sel));
    }
    if (p.type !== 'ollama') {
      const mu = el('input'); mu.type = 'url'; mu.value = p.modelsUrl || ''; mu.placeholder = `${String(p.baseUrl || '').replace(/\/+$/, '')}/models`;
      mu.onchange = () => { const v = mu.value.trim(); if (v && !/^https?:\/\/\S+$/i.test(v)) { mu.classList.add('invalid'); return; } mu.classList.remove('invalid'); upd({ modelsUrl: v || undefined }); };
      out.push(row('Model list URL', 'Where the model list is read from, when it is not under the base URL.', mu));
    }
    out.push(modelOverridesEditor(p, probe, upd));
    return out;
  }
  const isOpenRouter = (p) => hostOfUrl(p.baseUrl) === 'openrouter.ai';
  const hostOfUrl = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  /** Per-model settings (`modelOverrides`): limits, capabilities, prices and temperature that win over what the server says. */
  function modelOverridesEditor(p, probe, upd) {
    const box = el('div', 'field wide ovr-wrap');
    box.innerHTML = '<div><div class="lbl">Model settings</div><div class="desc">Correct what the server or the bundled model facts get wrong, or price a model LocalPilot does not know (US dollars per 1M tokens).</div></div>';
    const list = el('div', 'ovr-list'); box.appendChild(list);
    let entries = Object.entries(p.modelOverrides || {}).map(([id, o]) => [id, { ...o }]);
    const ids = listedIds(p, probe);
    const save = () => { const o = {}; for (const [id, v] of entries) { const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== '')); if (id.trim() && Object.keys(clean).length) { o[id.trim()] = clean; } } upd({ modelOverrides: Object.keys(o).length ? o : undefined }); };
    const num = (label, key, o, step, max) => {
      const w = el('label', 'ovr-f', `<span>${esc(label)}</span>`); const i = el('input'); i.type = 'number'; i.min = 0; i.step = step; if (max) { i.max = max; } i.value = o[key] ?? ''; i.placeholder = 'auto';
      i.onchange = () => { const n = Number(i.value); o[key] = i.value === '' || !Number.isFinite(n) || n < 0 ? undefined : n; save(); };
      w.appendChild(i); return w;
    };
    const tri = (label, key, o) => {
      const w = el('label', 'ovr-f', `<span>${esc(label)}</span>`); const s = el('select', '', '<option value="">auto</option><option value="yes">yes</option><option value="no">no</option>');
      s.value = o[key] === true ? 'yes' : o[key] === false ? 'no' : '';
      s.onchange = () => { o[key] = s.value === 'yes' ? true : s.value === 'no' ? false : undefined; save(); };
      w.appendChild(s); return w;
    };
    const draw = () => {
      list.innerHTML = '';
      entries.forEach((e, idx) => {
        const [id, o] = e;
        const card = el('div', 'ovr');
        const head = el('div', 'ovr-head');
        const mi = el('input'); mi.type = 'text'; mi.value = id; mi.placeholder = 'model id'; mi.setAttribute('list', `ov-${p.id}`); mi.setAttribute('aria-label', 'Model id');
        mi.onchange = () => { e[0] = mi.value.trim(); save(); };
        const rm = el('button', 'btn sm', I.trash); rm.title = 'Remove these model settings'; rm.setAttribute('aria-label', 'Remove these model settings');
        rm.onclick = () => { entries = entries.filter((_, j) => j !== idx); save(); draw(); };
        head.append(mi, rm); card.appendChild(head);
        const grid = el('div', 'ovr-grid');
        grid.append(num('Context window', 'contextWindow', o, 1024), num('Max output', 'maxOutput', o, 256), tri('Vision', 'vision', o), tri('Reasoning', 'reasoning', o), num('Input $/1M', 'inputPrice', o, 0.01), num('Output $/1M', 'outputPrice', o, 0.01), num('Temperature', 'temperature', o, 0.05, 2));
        card.appendChild(grid); list.appendChild(card);
      });
      const add = el('button', 'btn sm', `${I.plus}Add model settings`);
      add.onclick = () => { entries = [...entries, ['', {}]]; draw(); const inputs = list.querySelectorAll('.ovr-head input'); if (inputs.length) { inputs[inputs.length - 1].focus(); } };
      list.appendChild(add);
    };
    box.appendChild(datalist(`ov-${p.id}`, ids));
    draw();
    return box;
  }
  /** One of the organisation's providers: name, endpoint and API shown locked; the API key is the only field, saved in the user's own list. */
  /** Mirrors classifyProviderHealth in src/providers/health.ts for a probe result from this page (keep the thresholds in step). */
  function probeHealth(r, p) {
    const base = { ms: r.latencyMs, models: (r.models || []).length, checkedAt: state.probedAt || Date.now() };
    if (!r.ok) { return /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,20}(api[ _-]?)?key|api[ _-]?key[^.]{0,30}(missing|required|invalid|not set)|authentication/i.test(r.error || '') ? { ...base, state: 'nokey', detail: 'key rejected' } : { ...base, state: 'down', detail: r.error ? String(r.error).slice(0, 80) : 'not answering' }; }
    return { ...base, state: r.latencyMs > (isRemoteUrl(p.baseUrl) ? 4000 : 1500) ? 'slow' : 'ok' };
  }
  /** reachable / slow / down / no key, with the details (latency, models, when) in the tooltip. */
  function healthBadge(h) {
    const ms = typeof h.ms === 'number' ? (h.ms >= 1000 ? `${(h.ms / 1000).toFixed(1)} s` : `${Math.round(h.ms)} ms`) : '';
    const ago = h.checkedAt ? Math.max(0, Math.round((Date.now() - h.checkedAt) / 60000)) : -1;
    const when = ago < 0 ? '' : ago ? `checked ${ago} min ago` : 'checked just now';
    const v = { ok: ['', ms ? `reachable · ${ms}` : 'reachable', 'Reachable'], slow: ['warn', `slow · ${ms}`, 'Slow to answer'], down: ['err', 'down', 'Down'], nokey: ['err', 'no key', 'No usable API key'] }[h.state];
    if (!v) { return ''; }
    const live = h.state === 'ok' || h.state === 'slow';
    const tip = [v[2], h.detail, live && h.models !== undefined ? plural(h.models, 'model') : '', live && ms ? `answered in ${ms}` : '', when].filter(Boolean).join(' · ');
    return `<span class="badge ${v[0]} health" title="${esc(tip)}">${esc(v[1])}</span>`;
  }
  function orgProviderCard(p) {
    const probe = state.tests[p.id] || (state.probe || []).find((r) => r.id === p.id);
    const open = state.expanded === p.id;
    const ks = keyState(p);
    // One vocabulary (reachable / slow / down / no key) for the page's own check and the extension's background checks.
    const h = p.enabled === false ? undefined : probe ? probeHealth(probe, p) : ((state.data && state.data.health) || {})[p.id];
    const status = h ? ({ ok: 'ok', slow: 'warn', down: 'err', nokey: 'err' })[h.state] || '' : state.busy ? 'busy' : '';
    const n = probe && probe.ok ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'}` : probe ? 'unreachable' : '';
    const c = el('div', 'prov managed');
    c.dataset.prov = p.id;
    const badges = `${ks.warn ? `<span class="badge warn" title="Requests are rejected until the key is set">${esc(ks.warn)}</span>` : h ? healthBadge(h) : n ? `<span class="badge">${esc(n)}</span>` : ''}${lockIcon('Endpoint, headers and API version are set by your organization')}`;
    c.innerHTML = `<div class="prov-head"><span class="dot ${ks.warn ? 'err' : status}"></span>${brandMark(p, p.displayName || p.id)}<div class="prov-title"><b title="${esc(p.displayName || p.id)}">${esc(p.displayName || p.id)}</b><span title="${esc(p.baseUrl)}">${esc(hostOfUrl(p.baseUrl) || p.baseUrl)} · ${API_LABEL[p.type] || 'OpenAI API'}</span></div><div class="prov-meta">${badges}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
    disclosure(c.querySelector('.prov-head'), open, `${p.displayName || p.id} settings`, () => { state.expanded = open ? null : p.id; render(); });
    if (!open) { return c; }
    const body = el('div', 'prov-body');
    const row = (label, desc, input) => { const f = el('div', 'field locked'); f.innerHTML = `<div><div class="lbl">${esc(label)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`; const ctl = el('div', 'ctl'); ctl.appendChild(input); f.appendChild(ctl); return f; };
    const ro = (v) => { const i = el('input'); i.type = 'text'; i.value = v; i.disabled = true; i.title = MANAGED_TIP; return i; };
    // Saved into the user's own provider list under the same id; only its key is used while the policy provides the provider.
    const own = providersList();
    const mine = own.find((x) => x.id === p.id);
    const key = mine ? mine.apiKey : undefined;
    const keyIn = el('input'); keyIn.type = /^\$\{env:/.test(key || '') ? 'text' : 'password';
    const stored = isSecretRef(key);
    keyIn.value = stored ? '' : key || '';
    keyIn.placeholder = stored ? '•••••••• saved in secret storage — type to replace' : 'paste your key, or ${env:API_KEY}';
    const saveKey = (v) => {
      const next = providersList(); const i = next.findIndex((x) => x.id === p.id);
      if (i >= 0) { next[i] = { ...next[i], apiKey: v || undefined }; } else if (v) { next.push({ id: p.id, type: p.type, baseUrl: p.baseUrl, apiKey: v }); }
      delete state.tests[p.id]; state.probedSig = ''; saveProviders(next);
    };
    const commitKey = () => { const v = keyIn.value.trim(); if (stored && !v) { return; } if ((key || '') !== v) { saveKey(v); } };
    keyIn.onchange = commitKey; keyIn.onblur = commitKey;
    const keyCtl = el('div', 'btnrow'); keyCtl.style.margin = '0'; keyCtl.appendChild(keyIn);
    if (key) { const forget = el('button', 'btn sm', 'Remove'); forget.title = 'Remove your API key for this provider'; forget.onclick = () => saveKey(''); keyCtl.appendChild(forget); }
    const keyRow = el('div', 'field'); keyRow.innerHTML = `<div><div class="lbl">Your API key</div><div class="desc">${ks.note ? `<b>${ks.note}</b> ` : ''}Kept in VS Code secret storage (your OS keychain). Or write <code>\${env:NAME}</code> to read it from an environment variable.</div></div>`;
    const kc = el('div', 'ctl'); kc.appendChild(keyCtl); keyRow.appendChild(kc);
    body.appendChild(keyRow);
    body.appendChild(row('Base URL', 'Set by your organization.', ro(p.baseUrl)));
    body.appendChild(row('API type', '', ro(API_LABEL[p.type] || 'OpenAI API')));
    if (p.headers && Object.keys(p.headers).length) { body.appendChild(row('Headers', 'Sent with every request; values are not shown.', ro(Object.keys(p.headers).join(', ')))); }
    if (p.apiVersion) { body.appendChild(row('Azure api-version', '', ro(p.apiVersion))); }
    const foot = el('div', 'prov-foot');
    foot.innerHTML = `<button class="btn primary" id="test">${I.bolt}Test connection</button><span class="spacer"></span>`;
    foot.querySelector('#test').onclick = () => { state.tests[p.id] = null; const d = c.querySelector('.dot'); d.className = 'dot busy'; post({ type: 'test', provider: { ...p, apiKey: key } }); };
    body.appendChild(foot);
    if (probe) { body.appendChild(el('div', `prov-result ${probe.ok ? 'ok' : 'err'}`, probe.ok ? `${I.check} Connected in ${probe.latencyMs} ms` : `${I.x} ${esc(probe.error || 'Unreachable')}`)); }
    c.appendChild(body);
    return c;
  }
  function providerCard(p, list) {
    const probe = state.tests[p.id] || (state.probe || []).find((r) => r.id === p.id);
    const open = state.expanded === p.id;
    const c = el('div', `prov ${p.enabled === false ? 'off' : ''}`);
    c.dataset.prov = p.id;
    // One vocabulary (reachable / slow / down / no key) for the page's own check and the extension's background checks.
    const h = p.enabled === false ? undefined : probe ? probeHealth(probe, p) : ((state.data && state.data.health) || {})[p.id];
    const status = h ? ({ ok: 'ok', slow: 'warn', down: 'err', nokey: 'err' })[h.state] || '' : state.busy ? 'busy' : '';

    const n = probe && probe.ok ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'} · ${probe.latencyMs} ms` : probe ? 'unreachable' : (state.data.models || []).filter((m) => m.providerId === p.id).length ? `${(state.data.models || []).filter((m) => m.providerId === p.id).length} models` : '';
    // Header: name, then "where · which API"; badges only for what needs attention or tells the models apart.
    const ks = keyState(p);
    let where = String(p.baseUrl || '').replace(/^https?:\/\//, '');
    if (isRemoteUrl(p.baseUrl)) { try { where = new URL(p.baseUrl).host; } catch { /* keep the URL */ } }
    const all = providersList();
    const grouped = all.some(isCloud) && all.some((x) => !isCloud(x));
    const badges = [
      isCloud(p) && !grouped ? '<span class="badge" title="Prompts and code sent to these models leave this machine">cloud</span>' : '',
      ks.warn ? `<span class="badge warn" title="Requests are rejected until the key is set">${esc(ks.warn)}</span>` : h ? healthBadge(h) : n ? `<span class="badge">${esc(n)}</span>` : '',
      p.enabled === false ? '<span class="badge">disabled</span>' : '',
      providerPolicyBlock(p) ? `<span class="badge err" title="${esc(providerPolicyBlock(p))}">blocked by policy</span>${lockIcon(providerPolicyBlock(p))}` : '',
    ].join('');
    c.innerHTML = `<div class="prov-head"><span class="dot ${ks.warn && p.enabled !== false ? 'err' : status}"></span>${brandMark(p, p.displayName || p.id)}<div class="prov-title"><b title="${esc(p.displayName || p.id)}">${esc(p.displayName || p.id)}</b><span title="${esc(p.baseUrl)}">${esc(where)} · ${API_LABEL[p.type] || 'OpenAI API'}</span></div><div class="prov-meta">${badges}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
    disclosure(c.querySelector('.prov-head'), open, `${p.displayName || p.id} settings`, () => { state.expanded = open ? null : p.id; render(); });
    if (!open) { return c; }
    const body = el('div', 'prov-body');
    const upd = (patch) => { Object.assign(p, patch); delete state.tests[p.id]; state.probedSig = ''; saveProviders(list); };
    const row = (label, desc, input) => { const f = el('div', 'field'); f.innerHTML = `<div><div class="lbl">${esc(label)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`; const ctl = el('div', 'ctl'); ctl.appendChild(input); f.appendChild(ctl); return f; };
    const text = (key, placeholder, type = 'text', validate) => {
      const i = el('input'); i.type = type; i.value = p[key] ?? ''; i.placeholder = placeholder;
      const commit = () => { const v = i.value.trim(); if (validate && v && !validate(v)) { i.classList.add('invalid'); return; } i.classList.remove('invalid'); if ((p[key] ?? '') !== v) { if (key === 'id' && v && state.expanded === p.id) { state.expanded = v; } upd({ [key]: v || undefined }); } };
      i.onchange = commit; i.onblur = commit;
      return i;
    };
    const typeSel = el('select', '', `<option value="ollama">Ollama (native API)</option><option value="openai">OpenAI-compatible (/v1)</option><option value="anthropic">Anthropic (Claude Messages API)</option><option value="vscode-lm">VS Code language models (Copilot)</option>`);
    typeSel.value = p.type; typeSel.onchange = () => upd({ type: typeSel.value });
    body.appendChild(row('Display name', '', text('displayName', p.id)));
    body.appendChild(row('ID', 'Used in model ids as <code>id/model</code>. Lowercase letters, digits, - and _.', text('id', 'ollama', 'text', (v) => /^[a-z0-9_-]+$/.test(v) && !list.some((o) => o !== p && o.id === v))));
    body.appendChild(row('API type', '', typeSel));
    // VS Code's own models: no URL, key, cloud switch or context window to set (VS Code decides all four).
    const lm = p.type === 'vscode-lm';
    if (lm) { body.appendChild(el('div', 'desc', 'Uses the chat models VS Code offers (GitHub Copilot and other extensions). VS Code asks for consent on the first request; no URL or key needed.')); }
    const urlIn = text('baseUrl', 'http://localhost:11434', 'url', (v) => /^https?:\/\/.+/.test(v));
    if (!lm) { body.appendChild(row('Base URL', isRemoteUrl(p.baseUrl) ? 'The provider\'s API endpoint; change it only for a regional or proxy endpoint.' : p.type === 'ollama' ? 'e.g. <code>http://localhost:11434</code> or <code>https://ollama.com</code>' : p.type === 'anthropic' ? 'e.g. <code>https://api.anthropic.com/v1</code>' : 'Include <code>/v1</code>, e.g. <code>http://localhost:1234/v1</code>', urlIn)); }
    // A pasted key is moved to VS Code secret storage by the extension; the field then stays empty and says so.
    const keyIn = el('input'); keyIn.type = /^\$\{env:/.test(p.apiKey || '') ? 'text' : 'password';
    const stored = isSecretRef(p.apiKey);
    keyIn.value = stored ? '' : p.apiKey || '';
    keyIn.placeholder = stored ? '•••••••• saved in secret storage — type to replace' : isCloud(p) ? 'paste the key, or ${env:API_KEY}' : 'not required for local servers';
    const commitKey = () => { const v = keyIn.value.trim(); if (stored && !v) { return; } if ((p.apiKey || '') !== v) { upd({ apiKey: v || undefined }); } };
    keyIn.onchange = commitKey; keyIn.onblur = commitKey;
    const keyCtl = el('div', 'btnrow'); keyCtl.style.margin = '0'; keyCtl.appendChild(keyIn);
    if (p.apiKey) { const forget = el('button', 'btn sm', 'Remove'); forget.title = 'Remove this provider\'s API key'; forget.onclick = () => upd({ apiKey: undefined }); keyCtl.appendChild(forget); }
    const pr = presetOf(p);
    const getKey = pr && pr.keyUrl ? ` <a data-url="${esc(pr.keyUrl)}">${pr.group === 'gateway' ? 'Setup guide' : 'Get an API key'} ↗</a>` : '';
    const keyRow = lm ? null : body.appendChild(row('API key', `${ks.note ? `<b>${ks.note}</b> ` : ''}${isCloud(p) && isRemoteUrl(p.baseUrl) ? 'Required.' : 'Optional for local servers.'} A pasted key is kept in VS Code secret storage (your OS keychain), not in settings.json. Or write <code>\${env:NAME}</code> to read it from an environment variable.${getKey}`, keyCtl));
    // For a cloud API the key is the one field that matters: right under the name, before ID / API type / URL.
    if (keyRow && isCloud(p) && isRemoteUrl(p.baseUrl)) { body.insertBefore(keyRow, body.children[1]); }
    // Mirrors bedrockRegion / withRegion in src/providers/presets.ts: the region is part of a Bedrock endpoint URL.
    const bedrock = /^(https:\/\/bedrock-runtime\.)([a-z0-9-]+)(\.amazonaws\.com)/i.exec(String(p.baseUrl || ''));
    if (bedrock && keyRow) {
      const reg = el('input'); reg.type = 'text'; reg.value = bedrock[2]; reg.placeholder = 'us-east-1'; reg.setAttribute('aria-label', 'AWS region');
      const commitRegion = () => { const v = reg.value.trim().toLowerCase(); if (!/^[a-z]{2}(-[a-z]+)+-\d+$/.test(v)) { reg.classList.toggle('invalid', !!v); return; } reg.classList.remove('invalid'); if (v !== bedrock[2].toLowerCase()) { upd({ baseUrl: p.baseUrl.replace(bedrock[0], `${bedrock[1]}${v}${bedrock[3]}`) }); render(); } };
      reg.onchange = commitRegion; reg.onblur = commitRegion;
      body.insertBefore(row('AWS region', 'Where your Bedrock API key and model access live. The key is sent as a Bearer token; for IAM credentials or profiles, run a LiteLLM proxy instead.', reg), keyRow.nextSibling);
    }
    if (state.focusKey === p.id) { state.focusKey = null; setTimeout(() => keyIn.focus(), 0); }
    if (state.focusUrl === p.id) { state.focusUrl = null; setTimeout(() => urlIn.focus(), 0); }
    if (!lm && !isRemoteUrl(p.baseUrl)) {
      const cl = switchBtn(isCloud(p), `Send prompts to cloud models: ${p.displayName || p.id}`, (on) => upd({ cloud: on ? true : undefined }));
      body.appendChild(row('Sends prompts to cloud models', 'Turn on for gateways such as OmniRoute or LiteLLM that run here but forward to cloud APIs. Automatic model picks then prefer local models over this one.', cl));
    }
    const cw = el('input'); cw.type = 'number'; cw.min = 1024; cw.step = 1024; cw.value = p.contextWindow ?? ''; cw.placeholder = 'auto';
    cw.onchange = () => upd({ contextWindow: cw.value ? Number(cw.value) : undefined });
    if (!lm) { body.appendChild(row('Context window', 'Fallback when the server does not report one.', cw)); }
    const models = el('input'); models.type = 'text'; models.value = (p.models || []).join(', '); models.placeholder = 'auto-discover';
    models.onchange = () => upd({ models: models.value.split(',').map((s) => s.trim()).filter(Boolean) });
    body.appendChild(row('Models', lm ? 'Comma-separated model ids or families to offer, e.g. <code>gpt-4o</code>. Empty offers every model VS Code lists.' : 'Comma-separated list for servers whose <code>/models</code> endpoint is empty (some llama.cpp builds).', models));
    body.appendChild(row('Default model', `What <code>${esc(p.id)}</code> alone means as a model (<code>-m ${esc(p.id)}</code>). Pick one the server lists or type any id.`, defaultModelCtl(p, probe, upd)));
    const more = state.provMore === p.id;
    const moreRow = el('div', 'btnrow prov-more');
    const moreBtn = el('button', 'btn sm', `<span class="chev" style="transform:rotate(${more ? 90 : 0}deg)">${I.chev}</span>Headers, timeout and model settings`);
    moreBtn.setAttribute('aria-expanded', String(more));
    moreBtn.onclick = () => { state.provMore = more ? null : p.id; render(); };
    moreRow.appendChild(moreBtn); body.appendChild(moreRow);
    if (more) { for (const r of providerMore(p, probe, upd, row)) { body.appendChild(r); } }
    const en = switchBtn(p.enabled !== false, `Enable provider ${p.displayName || p.id}`, (on) => upd({ enabled: on ? undefined : false }));
    body.appendChild(row('Enabled', 'Disabled providers are kept in settings but never contacted.', en));
    const foot = el('div', 'prov-foot');
    // Gateways LocalPilot can install and start (OmniRoute, LiteLLM) get a Start button next to Test connection.
    const gw = pr && pr.group === 'gateway' ? pr.key : '';
    foot.innerHTML = `<button class="btn primary" id="test">${I.bolt}Test connection</button>${gw ? `<button class="btn" data-cmd="localpilot.startGateway" data-args='${JSON.stringify([gw])}' title="Install it if needed, start it on 127.0.0.1 and check what it can route to">${I.play || I.bolt}Start ${esc(pr.label)}</button>` : ''}<span class="spacer"></span><button class="btn danger" id="rm">${I.trash}Remove</button>`;
    foot.querySelector('#test').onclick = () => { state.tests[p.id] = null; const d = c.querySelector('.dot'); d.className = 'dot busy'; post({ type: 'test', provider: p }); };
    foot.querySelector('#rm').onclick = () => { saveProviders(list.filter((o) => o !== p)); state.expanded = null; render(); };
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
  const ROLE_LABEL = { agent: 'agent', completion: 'completions', vision: 'images', reasoning: 'plan', fast: 'subagents' };
  const TARGET_LABEL = { ollama: 'Ollama', docker: 'Docker Model Runner', lmstudio: 'LM Studio' };
  const fitBadge = (fit) => fit === 'ok' ? '<span class="badge ok">fits</span>' : fit === 'tight' ? '<span class="badge warn">tight</span>' : fit === 'over' ? '<span class="badge err">too big</span>' : '';
  const gbText = (gb) => (gb === undefined || gb === null ? '' : gb >= 10 ? `${Math.round(gb)} GB` : `${Number(gb).toFixed(1)} GB`);
  /** US dollars per 1M tokens, short: $3, $0.15, $0.075. */
  const usd = (n) => `$${n >= 1 ? Number(n.toFixed(2)) : Number(n.toFixed(4))}`;
  /** Model card price: input / output per 1M tokens (cache reads when known), `local · free` on this machine, nothing when a cloud price is unknown. */
  const priceText = (m) => {
    const p = m.pricing;
    if (!p) { return m.remote ? '' : 'local · free'; }
    return `${usd(p.input)} in · ${usd(p.output)} out /1M${p.cacheRead !== undefined ? ` · cache ${usd(p.cacheRead)}` : ''}`;
  };
  const priceTitle = (m) => {
    const p = m.pricing;
    if (!p) { return 'Runs on this machine or your network: no per-token cost'; }
    return `Per 1M tokens: input ${usd(p.input)}, output ${usd(p.output)}${p.cacheRead !== undefined ? `, cache read ${usd(p.cacheRead)}` : ''}${p.cacheWrite !== undefined ? `, cache write ${usd(p.cacheWrite)}` : ''}. Set your own in the provider's model settings.`;
  };
  const activeJob = (kind, target, model) => state.jobs.find((j) => j.status === 'running' && j.kind === kind && (!target || j.target === target) && (!model || j.model === model));
  const pctText = (job) => (job.progress >= 0 ? `${Math.round(job.progress * 100)}%` : '');
  const barWidth = (job) => `${Math.max(2, Math.round((job.progress < 0 ? 0.3 : job.progress) * 100))}%`;
  function progressBar(job) {
    const w = el('div', `progress ${job.progress < 0 ? 'indet' : ''}`, `<i style="width:${barWidth(job)}"></i>`);
    w.title = job.detail || '';
    w.dataset.job = job.id;
    return w;
  }
  function pctEl(job) { const s = el('span', 'pct', pctText(job)); s.dataset.job = job.id; return s; }
  const setupTitle = (job) => job.kind === 'pull' ? `Downloading ${job.model}${job.progress >= 0 ? ` ${pctText(job)}` : ''}` : job.kind === 'install-runtime' ? 'Installing Ollama' : job.kind === 'start' ? 'Starting Ollama' : 'Setting up';
  const jobsSig = (jobs) => jobs.map((j) => `${j.id}:${j.status}:${j.progress < 0 ? 'i' : 'd'}`).join('|');
  // Progress ticks arrive several times a second; a full re-render would restart every CSS animation and
  // reset scroll, which reads as blinking. Update the bars/labels of running jobs in place instead.
  function patchJobs() {
    for (const j of state.jobs) {
      if (j.status !== 'running') { continue; }
      app.querySelectorAll(`.progress[data-job="${j.id}"]`).forEach((p) => { p.classList.toggle('indet', j.progress < 0); p.firstElementChild.style.width = barWidth(j); p.title = j.detail || ''; });
      app.querySelectorAll(`.pct[data-job="${j.id}"]`).forEach((s) => { s.textContent = pctText(j); });
      app.querySelectorAll(`[data-job-detail="${j.id}"]`).forEach((s) => { s.textContent = j.detail || j.status; });
      app.querySelectorAll(`[data-job-title="${j.id}"]`).forEach((s) => { s.textContent = setupTitle(j); });
    }
  }
  function secModels(sec) {
    head(sec, 'Models', 'What this machine can run, what is installed, and which model handles each task.');
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
    auto.innerHTML = `<button class="btn ${anyModels ? '' : 'brand'}" id="auto" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${anyModels ? 'Install starter set' : 'Set up automatically'}</button><span class="hint" ${setupJob ? `data-job-detail="${esc(setupJob.id)}"` : ''}>${esc(setupJob ? setupJob.detail : `Picks for this machine: ${starter}. Starts or installs Ollama when needed.`)}</span>`;
    auto.querySelector('#auto').onclick = () => post({ type: 'autoSetup', installRuntime: true });
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
        row.innerHTML = `<span class="dot ${j.status === 'running' ? 'busy' : j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : ''}"></span><div class="t"><b>${esc(verb)} ${esc(j.model)} <span class="badge">${esc(TARGET_LABEL[j.target] || j.target)}</span></b><span data-job-detail="${esc(j.id)}">${esc(j.status === 'error' ? j.error || 'failed' : j.detail || j.status)}</span></div>`;
        if (j.status === 'running') {
          const grp = el('div', 'prog-grp');
          grp.appendChild(progressBar(j));
          grp.appendChild(pctEl(j));
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
    const installedCard = () => {
    const inst = el('div', 'card');
    if (!anyModels) {
      inst.appendChild(el('div', 'empty', running.length ? 'The server is running but has no models yet. Use <b>Set up automatically</b> above or install one from the catalog below.' : 'No model server is running. <b>Set up automatically</b> starts or installs Ollama and downloads a starter model sized for this machine.'));
    }
    const def = val('defaultModel');
    const sorted = [...d.installed].sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name));
    for (const m of sorted) {
      const row = el('div', `mrow ${m.disabled ? 'off' : ''}`);
      const tg = switchBtn(!m.disabled, `Enable model ${m.name}`, (on) => post({ type: 'toggleModel', id: m.id, enabled: on })); tg.title = m.disabled ? 'Enable' : 'Disable (hidden from pickers and routing; stays installed)';
      row.appendChild(tg);
      row.insertAdjacentHTML('beforeend', vendorMark((m.catalog && m.catalog.vendor) || vendorFromModelId(m.modelId || m.name), m.name));
      const caps = [m.supportsTools ? 'tools' : 'prompt tools', m.supportsVision ? 'vision' : '', m.supportsFim ? 'FIM' : ''].filter(Boolean).join(' · ');
      // Cloud models: say so where the model is listed, since picking one sends code off the machine.
      if (m.remote) { row.classList.add('cloud'); }
      const t = el('div', 't', `<b title="${esc(m.id)}">${esc(m.name)}</b><span>${esc(m.providerId)} · ${Math.round(m.contextWindow / 1024)}k context${m.gb ? ` · ${esc(gbText(m.gb))}` : ''}${m.parameterSize ? ` · ${esc(m.parameterSize)}` : ''} · ${esc(caps)}${m.catalog ? ` · ${esc(m.catalog.name)} ${esc(m.catalog.tag)}` : ''}${priceText(m) ? ` · <span class="price" title="${esc(priceTitle(m))}">${esc(priceText(m))}</span>` : ''}</span>`);
      row.appendChild(t);
      const right = el('div', 'mrow-right');
      const tags = el('div', 'tags');
      if (m.id === def) { tags.innerHTML += '<span class="badge brand">default</span>'; }
      if (m.remote) { tags.innerHTML += '<span class="badge" title="Served by a cloud API: prompts and code sent to it leave this machine">cloud</span>'; }
      else if (!def && m.autoRoles.includes('agent')) { tags.innerHTML += '<span class="badge brand">auto default</span>'; }
      if (m.id === val('inlineCompletion.model')) { tags.innerHTML += '<span class="badge role">completions</span>'; }
      if (m.id === val('routing.vision')) { tags.innerHTML += '<span class="badge role">images</span>'; }
      if (m.id === val('routing.reasoning')) { tags.innerHTML += '<span class="badge role">plan</span>'; }
      for (const r of m.autoRoles) { if (r !== 'agent' && !tags.innerHTML.includes(`>${ROLE_LABEL[r]}<`)) { tags.innerHTML += `<span class="badge" title="Routing picks this model for ${ROLE_LABEL[r]} unless you choose one">auto · ${ROLE_LABEL[r]}</span>`; } }
      // Installed models normally fit; only say so when they don't (tight / too big).
      if (m.fit !== 'ok') { tags.innerHTML += fitBadge(m.fit); }
      right.appendChild(tags);
      const acts = el('div', 'acts');
      if (!m.disabled && m.id !== def) {
        const b = el('button', 'btn ghost sm', 'Set default'); b.title = 'Use for new chats'; b.onclick = () => set('defaultModel', m.id);
        acts.appendChild(b);
      }
      if (m.removable) {
        const rj = activeJob('remove', m.removable, m.modelId);
        const b = el('button', 'btn ghost sm danger', rj ? '<span class="spinner"></span>' : I.trash); b.title = `Delete from ${TARGET_LABEL[m.removable]}`; b.disabled = !!rj;
        b.onclick = () => post({ type: 'removeModel', target: m.removable, model: m.modelId, providerId: m.providerId, name: m.name });
        acts.appendChild(b);
      }
      right.appendChild(acts);
      row.appendChild(right);
      inst.appendChild(row);
    }
    return component(inst, ['defaultModel', 'inlineCompletion.model', 'routing.vision', 'routing.reasoning', 'models.disabled'], installedCard);
    };
    sec.appendChild(installedCard());

    // --- routing
    sec.appendChild(el('h2', 'sub', 'Routing'));
    const autoFor = (role) => { const m = d.installed.find((x) => !x.disabled && x.autoRoles.includes(role)); return m ? `Auto → ${m.name}` : role === 'vision' ? 'Auto → no vision model installed' : 'Auto → best available'; };
    const opts = modelOptions();
    sec.appendChild(card(
      field('routing.enabled', 'Route automatically', 'Send image turns to a vision model, completions to the smallest FIM model, Plan mode to the reasoning model, subagents to the models below, and fall back to the best available model when the chosen one is offline or disabled.', 'toggle'),
      field('models.autoTune', 'Learn from usage', 'Watch how your installed models actually perform here — runs finished, tok/s, time to first token, errors, completions accepted — and prefer the ones that work. <b>Tune automatically</b> also updates the picks below (with Undo; a model you chose by hand is only replaced when it keeps failing). Local telemetry only; see <b>Dashboard → Model tuning</b>.', 'select', { options: [['auto', 'Tune automatically', ''], ['suggest', 'Suggest only', ''], ['off', 'Off', '']] }),
      field('defaultModel', 'Agent & chat', opts.length ? `New chats and editor actions. ${esc(autoFor('agent'))}.` : 'No models enabled yet.', 'select', { options: [['', 'Auto (best for this machine)', ''], ...opts] }),
      field('inlineCompletion.model', 'Inline completions', `Fill-in-the-middle model for ghost text. ${esc(autoFor('completion'))}.`, 'select', { options: [['', 'Auto (smallest FIM model)', ''], ...(modelOptions((m) => m.supportsFim).length ? modelOptions((m) => m.supportsFim) : opts)] }),
      field('routing.vision', 'Images', `Used when a turn has images and the session model cannot see. ${esc(autoFor('vision'))}.`, 'select', { options: [['', 'Auto (best vision model)', ''], ...(modelOptions((m) => m.supportsVision).length ? modelOptions((m) => m.supportsVision) : opts)] }),
      field('routing.reasoning', 'Plan mode', 'Optional reasoning model for planning (qwen3, deepseek-r1, gpt-oss — pair with Extended thinking below). Empty keeps the session model.', 'select', { options: [['', 'Keep the session model', ''], ...opts] }),
      field('routing.fast', 'Read-only subagents', `<code>explore</code>, <code>clarifier</code>, <code>researcher</code> run many short tool calls, often several in parallel — a small tool-capable model keeps them snappy. ${esc(autoFor('fast'))}.`, 'select', { options: [['', 'Auto (smallest tool-capable model that fits)', ''], ['session', 'Keep the session model', ''], ...opts] }),
      field('routing.coding', 'Implementing subagents', '<code>coder</code>, <code>tester</code>, <code>debugger</code>, <code>docs</code>. Pick a stronger coding model here while chatting with a lighter one. Empty keeps the session model.', 'select', { options: [['', 'Keep the session model', ''], ...opts] }),
      field('routing.parallelModels', 'Spread parallel work across models', 'When several workers (or Auto chats) need a model that is already serving as many requests as it can — one, on a server that answers one request per model at a time — the extra ones run on a comparable idle model that fits in memory alongside, instead of queuing. A model you picked explicitly for a chat is never swapped.', 'toggle'),
      fallbackEditor(),
      field('firstTokenTimeoutSeconds', 'First-token wait limit', 'How long a request may wait for the model\'s first token (loading into memory, reading a long prompt) before it counts as stalled and is retried. Raise it for slow machines or very large local models. While it waits, the chat shows <b>Keep waiting</b> and <b>Switch model</b>.', 'select', { options: [...FIRST_TOKEN_OPTIONS, ...(FIRST_TOKEN_OPTIONS.some(([v]) => v === Number(val('firstTokenTimeoutSeconds'))) || typeof val('firstTokenTimeoutSeconds') !== 'number' ? [] : [[val('firstTokenTimeoutSeconds'), `${val('firstTokenTimeoutSeconds')} s`]])].map(([v, l]) => [v, l, '']), cast: Number })
    ));

    // --- generation
    sec.appendChild(el('h2', 'sub', 'Generation'));
    sec.appendChild(card(
      field('contextWindow', 'Context window', 'Requested context size in tokens (<code>num_ctx</code> for Ollama), capped by the model. <b>Model maximum</b> asks for the largest window the model supports. Larger = more memory and slower prompts; the conversation is compacted before it fills up.', 'select', { options: [[0, 'Model maximum', 'largest the model supports'], [8192, '8k'], [16384, '16k'], [32768, '32k'], [65536, '64k'], [131072, '128k'], [262144, '256k']], cast: Number }),
      field('maxOutputTokens', 'Max output tokens', 'Upper bound per response.', 'number', { min: 256, max: 65536, step: 256 }),
      field('temperature', 'Temperature', '<b>Model default</b> (far left) uses each model’s own setting, as its makers tuned it; thinking models such as Gemma 4 and Qwen 3 tend to repeat themselves at low temperatures. Move it right to force one value for every model.', 'range', { min: -0.05, max: 1.5, step: 0.05, fmt: (v) => (Number(v) < 0 ? 'Model default' : Number(v).toFixed(2)) }),
      field('thinking', 'Extended thinking', 'For reasoning models (Ollama <code>think</code>, OpenAI <code>reasoning_effort</code>, Claude’s thinking budget). A chat can pick its own level with the <b>Think</b> chip in the composer. <b>Auto</b> thinks hard for Plan and Debug, medium for the agent, lightly for subagents and not at all for quick helpers (reviewer, inline edits, summaries). Models without thinking are left alone. Shows a collapsible “Thought for Ns” step.', 'seg', { options: [['auto', 'Auto'], ['off', 'Off'], ['on', 'On'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']] }),
      field('keepAlive', 'Keep model loaded', 'How long Ollama keeps the model in memory after a request (e.g. <code>5m</code>, <code>30m</code>, <code>-1</code> = forever).', 'text', { placeholder: '30m', validate: (v) => /^(-1|0|\d+(ms|s|m|h))$/.test(v) }),
      field('prewarm', 'Pre-load the model while you type', 'Loads the chat’s model as soon as you focus the composer or switch models, so the first token is not preceded by a weight load. Ollama only; at most once every few minutes per model.', 'toggle'),
      field('ollama.flashAttention', 'Ollama flash attention', 'Starts Ollama with <code>OLLAMA_FLASH_ATTENTION</code>: faster prompt processing and a smaller KV cache. Applies when LocalPilot starts or restarts Ollama.', 'toggle'),
      field('ollama.kvCacheType', 'Ollama KV cache', 'Cache precision (<code>OLLAMA_KV_CACHE_TYPE</code>). A smaller cache loads faster and keeps large context windows on the GPU. Needs flash attention.', 'seg', { options: [['f16', 'f16'], ['q8_0', 'q8_0'], ['q4_0', 'q4_0']] })
    ));

    // --- catalog
    sec.appendChild(el('h2', 'sub', 'Model catalog'));
    const chips = el('div', 'chips');
    const filters = [['fits', 'Fits this machine'], ['all', 'All sizes'], ['agent', 'Agent'], ['completion', 'Completions'], ['vision', 'Vision'], ['reasoning', 'Reasoning']];
    for (const [k, l] of filters) { const b = el('button', `chip ${state.cat.filter === k ? 'on' : ''}`, esc(l)); b.onclick = () => { state.cat.filter = k; render(); }; chips.appendChild(b); }
    const q = el('input'); q.type = 'search'; q.placeholder = 'Search models…'; q.setAttribute('aria-label', 'Search the model catalog'); q.value = state.cat.q; q.oninput = debounce(() => { state.cat.q = q.value; render(); }, 250);
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
      const headEl = el('div', 'cat-head', `${vendorMark(f.vendor, f.name)}<div class="t"><b>${esc(f.name)}</b><span class="v">${esc(f.vendor)}</span><p>${esc(f.description)}</p></div><div class="tags">${f.roles.map((r) => `<span class="badge role">${esc(ROLE_LABEL[r] || r)}</span>`).join('')}</div>`);
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
          act.appendChild(pctEl(job));
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
    sec.appendChild(el('p', 'muted small', `Looking for something else? The <a data-sec="gallery">Model gallery</a> searches the whole Ollama library — thousands of models and sizes — and installs any of them, or pulls a model by name (<code>hf.co/…</code> GGUF repos included).`));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }

  // ------------------------------------------------------------------ model gallery (Ollama library · Docker Hub · Hugging Face)
  /** Registries the gallery can browse; a source is offered when a runtime that installs from it is detected. */
  const GALLERY_SOURCES = {
    ollama: { label: 'Ollama library', site: 'ollama.com', url: 'https://ollama.com/library', placeholder: 'Search the Ollama library — e.g. coder, llama, embed…', caps: [['', 'All'], ['tools', 'Tools'], ['vision', 'Vision'], ['thinking', 'Thinking'], ['embedding', 'Embedding']], targets: ['ollama'], cli: { ollama: 'ollama pull' } },
    docker: { label: 'Docker Hub', site: 'hub.docker.com', url: 'https://hub.docker.com/u/ai', placeholder: 'Search the ai/ namespace on Docker Hub — e.g. qwen, gemma, embed…', caps: [['', 'All'], ['vision', 'Vision'], ['embedding', 'Embedding']], targets: ['docker'], cli: { docker: 'docker model pull' } },
    huggingface: { label: 'Hugging Face', site: 'huggingface.co', url: 'https://huggingface.co/models?library=gguf&sort=downloads', placeholder: 'Search GGUF repositories on Hugging Face — e.g. unsloth qwen3, bartowski…', caps: [['', 'All'], ['vision', 'Vision'], ['embedding', 'Embedding']], targets: ['ollama', 'lmstudio'], cli: { ollama: 'ollama pull', lmstudio: 'lms get' } },
  };
  const GALLERY_SORTS = [['popular', 'Most popular'], ['newest', 'Newest'], ['name', 'Name']];
  const PULL_HINT = {
    ollama: { placeholder: 'model[:tag] or hf.co/org/repo[:quant]', desc: 'Anything <code>ollama pull</code> accepts: a library model (<code>qwen3:8b</code>), a user upload (<code>user/model:tag</code>) or a GGUF repository from Hugging Face (<code>hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M</code>).' },
    docker: { placeholder: 'ai/model[:tag]', desc: 'Anything <code>docker model pull</code> accepts: a Docker Hub model (<code>ai/qwen3:8b</code>) or an OCI artifact from another registry.' },
    lmstudio: { placeholder: 'org/repo[@quant] or model-key', desc: 'Anything <code>lms get</code> accepts: a Hugging Face repository (<code>unsloth/Qwen3-8B-GGUF@q4_k_m</code>) or an LM Studio model key (<code>llama-3.1-8b</code>).' },
  };
  /** Mirrors the host-side checks per runtime. */
  const isModelRef = (target, s) => s.length <= 240 && !/\.\./.test(s) && (
    target === 'docker' ? /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/i.test(s)
      : target === 'lmstudio' ? /^[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)?(@[\w.-]+)?$/.test(s)
        : /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(s));
  /** Plain size tags (`8b`, `e4b`, `30b-a3b`, `latest`) and the common Q4_K_M quant are shown first; the rest hide behind “show all”. */
  const isPrimaryTag = (t) => t.isLatest || /^(latest|e?\d+(\.\d+)?[bm](-a\d+(\.\d+)?b)?|\d+x\d+(\.\d+)?b|q4_k_m|q8_0|q4_0)$/i.test(t.tag) || /^(e?\d+(\.\d+)?[bm])(-a\d+(\.\d+)?b)?-q4_K_M$/i.test(t.tag);
  const fitOf = (gb) => { const b = state.models && state.models.system ? state.models.system.modelBudgetGb : 0; return gb === undefined || !b ? 'unknown' : gb <= b ? 'ok' : gb <= b * 1.25 ? 'tight' : 'over'; };
  const runtimeOf = (target) => (state.models && state.models.runtimes || []).find((r) => r.target === target);
  const runtimeRunning = (target) => { const r = runtimeOf(target); return !!(r && r.running); };
  const runtimePresent = (target) => { const r = runtimeOf(target); return !!(r && (r.running || r.installed)); };
  /** Sources worth showing: the Ollama library always; Docker Hub when Docker Model Runner is around; Hugging Face when LM Studio is, or Ollama runs (it pulls hf.co/…). */
  const gallerySources = () => Object.keys(GALLERY_SOURCES).filter((s) => s === 'ollama' || (s === 'docker' ? runtimePresent('docker') : runtimePresent('lmstudio') || runtimeRunning('ollama')));
  const galleryTargets = (source) => GALLERY_SOURCES[source].targets.filter(runtimeRunning);
  const galleryTarget = (source) => { const avail = galleryTargets(source); const want = state.gallery.target[source]; return avail.includes(want) ? want : avail[0] || GALLERY_SOURCES[source].targets[0]; };
  /** What the runtime downloads for a tag: `qwen3:8b`, `ai/qwen3:8b`, `hf.co/org/repo:Q4_K_M` or `org/repo@q4_k_m`. */
  const installRef = (source, target, tag) => {
    if (source !== 'huggingface') { return tag.model; }
    const repo = tag.model.replace(/^hf\.co\//, '').replace(/:[^/]*$/, '');
    return target === 'lmstudio' ? (tag.tag === 'latest' ? repo : `${repo}@${tag.tag.toLowerCase()}`) : tag.model;
  };
  /** Installed model (from the live discovery list) matching a gallery reference on a runtime, if any. */
  const installedFor = (target, ref) => {
    const rt = runtimeOf(target);
    const pid = rt && rt.providerId;
    const list = (state.models && state.models.installed || []).filter((m) => !pid || m.providerId === pid);
    const low = ref.toLowerCase();
    if (target === 'lmstudio') {
      const repo = low.split('@')[0].split('/').pop().replace(/-gguf$/, '');
      return list.find((m) => m.modelId.toLowerCase().includes(repo));
    }
    const want = low.includes(':') ? low : `${low}:latest`;
    return list.find((m) => { const id = m.modelId.toLowerCase(); const idl = id.includes(':') ? id : `${id}:latest`; return idl === want || idl.endsWith(`/${want}`); });
  };
  function gallerySearch(source, reset) {
    const g = galleryState(source);
    if (reset) { g.page = 1; g.models = []; g.hasMore = false; }
    g.loading = true; g.error = null; g.loaded = true;
    post({ type: 'gallerySearch', source, q: g.q, capability: g.capability, sort: g.sort, page: g.page });
  }
  function galleryInstall(target, ref, label) {
    if (!isModelRef(target, ref)) { toast(`Not a valid model reference: ${ref}`, 'error'); return; }
    post({ type: 'installModel', target, model: ref });
    toast(`Installing ${label || ref} on ${TARGET_LABEL[target]}…`);
  }
  /** One line of runtime status with the action that gets it running, shared by the gallery header and the pull box. */
  function runtimeStatusRow(target, cls) {
    const rt = runtimeOf(target);
    const row = el('div', `gal-status ${cls || ''}`);
    if (!state.models) {
      row.innerHTML = `<span class="spinner"></span><div class="t"><b>Checking ${esc(TARGET_LABEL[target])}…</b></div>`;
    } else if (rt && rt.running) {
      row.innerHTML = `<span class="dot ok"></span><div class="t"><b>${esc(TARGET_LABEL[target])} is running</b><span>${esc(rt.baseUrl || '')} · ${esc(gbText(state.models.system.modelBudgetGb))} model budget on ${esc(state.models.system.summary)}</span></div>`;
    } else if (rt && rt.installed) {
      row.innerHTML = `<span class="dot warn"></span><div class="t"><b>${esc(TARGET_LABEL[target])} is installed but not running</b><span>${esc(rt.hint || 'Start it to install models from here.')}</span></div>`;
      if (target === 'ollama') {
        const b = el('button', 'btn sm', `${I.play}Start Ollama`); b.disabled = !!activeJob('start');
        b.onclick = () => { b.disabled = true; post({ type: 'startRuntime', target: 'ollama' }); };
        row.appendChild(b);
      }
    } else {
      row.innerHTML = `<span class="dot"></span><div class="t"><b>${esc(TARGET_LABEL[target])} is not installed</b><span>${esc((rt && rt.hint) || 'Install it to download models from here.')}</span></div>`;
      if (target === 'ollama') {
        const b = el('button', 'btn sm', `${I.download}Install Ollama`);
        b.onclick = () => post({ type: 'autoSetup', installRuntime: true, target: 'ollama' });
        row.appendChild(b);
      }
    }
    return row;
  }
  function secGallery(sec) {
    head(sec, 'Model gallery', `Install models from the <a data-url="https://ollama.com/library">Ollama library</a>, <a data-url="https://hub.docker.com/u/ai">Docker Hub</a> and <a data-url="https://huggingface.co/models?library=gguf">Hugging Face</a>; sizes are checked against this machine.`);
    if (!state.models && !state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
    const sources = gallerySources();
    if (!sources.includes(state.gallery.source)) { state.gallery.source = sources[0]; }
    const source = state.gallery.source;
    const src = GALLERY_SOURCES[source];
    const g = galleryState(source);

    // --- source tabs (one per registry a detected runtime installs from)
    const tabs = el('div', 'gal-tabs'); tabs.setAttribute('role', 'tablist');
    for (const s of sources) {
      const b = el('button', `gal-tab ${s === source ? 'on' : ''}`, `${s === 'huggingface' ? vendorMark('hugging face', 'HF') : brandMark(s, GALLERY_SOURCES[s].label)}<span>${esc(GALLERY_SOURCES[s].label)}</span><small>${esc(GALLERY_SOURCES[s].site)}</small>`);
      b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(s === source));
      b.onclick = () => { state.gallery.source = s; render(); };
      tabs.appendChild(b);
    }
    const missing = Object.keys(GALLERY_SOURCES).filter((s) => !sources.includes(s));
    if (missing.length) { tabs.appendChild(el('span', 'gal-tabs-note', `${missing.map((s) => esc(GALLERY_SOURCES[s].label)).join(' and ')} appear${missing.length === 1 ? 's' : ''} here once ${missing.includes('docker') ? 'Docker Model Runner' : 'LM Studio'} is installed.`)); }
    sec.appendChild(tabs);

    // --- install target (runtime) for this source
    const targets = galleryTargets(source);
    const target = galleryTarget(source);
    const status = el('div', 'card gal-status-card');
    status.appendChild(runtimeStatusRow(target));
    if (targets.length > 1) {
      const pick = el('div', 'gal-target', `<span class="lbl">Install to</span>`);
      const sel = el('select'); sel.setAttribute('aria-label', 'Install to');
      for (const t of targets) { const o = el('option'); o.value = t; o.textContent = `${TARGET_LABEL[t]} (${src.cli[t]})`; o.selected = t === target; sel.appendChild(o); }
      sel.onchange = () => { state.gallery.target[source] = sel.value; render(); };
      pick.appendChild(sel);
      status.appendChild(pick);
    } else if (!targets.length && src.targets.length > 1) {
      status.appendChild(el('div', 'gal-target muted small', `Installs to ${src.targets.map((t) => TARGET_LABEL[t]).join(' or ')} — start one of them.`));
    }
    sec.appendChild(status);

    // --- search tools
    const tools = el('div', 'gal-tools');
    const q = el('input'); q.type = 'search'; q.id = 'gal-q'; q.placeholder = src.placeholder; q.value = g.q; q.setAttribute('aria-label', 'Search models');
    // A full render (finished pull → models refresh) must not steal the caret mid-typing.
    if (document.activeElement && document.activeElement.id === 'gal-q') { requestAnimationFrame(() => { const n = app.querySelector('#gal-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }
    q.oninput = debounce(() => { if (q.value.trim() === g.q) { return; } g.q = q.value.trim(); gallerySearch(source, true); renderGalleryResults(); }, 350);
    q.onkeydown = (e) => { if (e.key === 'Enter') { g.q = q.value.trim(); gallerySearch(source, true); renderGalleryResults(); } };
    const search = el('div', 'gal-search', I.search); search.appendChild(q);
    tools.appendChild(search);
    const chips = el('div', 'chips');
    for (const [k, l] of src.caps) { const b = el('button', `chip ${g.capability === k ? 'on' : ''}`, esc(l)); b.onclick = () => { g.capability = k; gallerySearch(source, true); render(); }; chips.appendChild(b); }
    const sort = el('select'); sort.setAttribute('aria-label', 'Sort');
    for (const [k, l] of GALLERY_SORTS) { const o = el('option'); o.value = k; o.textContent = l; o.selected = g.sort === k; sort.appendChild(o); }
    sort.onchange = () => { g.sort = sort.value; gallerySearch(source, true); render(); };
    chips.appendChild(sort);
    tools.appendChild(chips);
    sec.appendChild(tools);

    // --- results
    const results = el('div', 'gal-results'); results.id = 'gal-results';
    sec.appendChild(results);
    if (!g.loaded) { gallerySearch(source, true); }
    renderGalleryResults(results);

    // --- pull anything by name, on any running runtime
    sec.appendChild(el('h2', 'sub', 'Pull by name'));
    const pull = el('div', 'card gal-pull');
    const pullTargets = ['ollama', 'docker', 'lmstudio'].filter(runtimeRunning);
    const pt = pullTargets.includes(state.gallery.pullTarget) ? state.gallery.pullTarget : pullTargets.includes(target) ? target : pullTargets[0] || 'ollama';
    pull.innerHTML = `<p class="desc">${PULL_HINT[pt].desc}</p>`;
    const row = el('div', 'gal-pull-row');
    if (pullTargets.length > 1) {
      const sel = el('select'); sel.setAttribute('aria-label', 'Runtime');
      for (const t of pullTargets) { const o = el('option'); o.value = t; o.textContent = TARGET_LABEL[t]; o.selected = t === pt; sel.appendChild(o); }
      sel.onchange = () => { state.gallery.pullTarget = sel.value; state.gallery.pullError = ''; render(); };
      row.appendChild(sel);
    }
    const ref = el('input'); ref.type = 'text'; ref.placeholder = PULL_HINT[pt].placeholder; ref.value = state.gallery.pullRef; ref.setAttribute('aria-label', 'Model reference'); ref.spellcheck = false;
    if (state.gallery.pullError) { ref.classList.add('invalid'); }
    const pj = state.gallery.pullRef.trim() ? activeJob('pull', pt, state.gallery.pullRef.trim()) : null;
    const go = el('button', 'btn primary sm', pj ? '<span class="spinner"></span>' : `${I.download}Pull`); go.disabled = !!pj || !pullTargets.length;
    go.title = pullTargets.length ? (GALLERY_SOURCES[source].cli[pt] || { ollama: 'ollama pull', docker: 'docker model pull', lmstudio: 'lms get' }[pt]) : 'Start a runtime first';
    const err = el('div', 'gal-err', esc(state.gallery.pullError));
    const submit = () => { const v = ref.value.trim(); state.gallery.pullRef = v; if (!isModelRef(pt, v)) { state.gallery.pullError = `Not a valid ${TARGET_LABEL[pt]} model reference`; ref.classList.add('invalid'); err.textContent = state.gallery.pullError; return; } state.gallery.pullError = ''; ref.classList.remove('invalid'); err.textContent = ''; galleryInstall(pt, v); };
    ref.oninput = () => { state.gallery.pullRef = ref.value; if (state.gallery.pullError) { state.gallery.pullError = ''; ref.classList.remove('invalid'); err.textContent = ''; } };
    ref.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) { submit(); } };
    go.onclick = submit;
    row.appendChild(ref); row.appendChild(go);
    pull.appendChild(row);
    pull.appendChild(err);
    sec.appendChild(pull);
    sec.appendChild(el('p', 'muted small', 'Listings come from the registries’ public sites and are cached for a few minutes. “Cloud” models run on Ollama’s servers and cannot be downloaded; Hugging Face sizes are the sum of a quantisation’s files.'));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }
  /** Rebuilds just the result list — search responses, tag lists and job updates must not disturb the search box. */
  function renderGalleryResults(container) {
    const box = container || app.querySelector('#gal-results');
    if (!box) { return; }
    box.innerHTML = '';
    const source = state.gallery.source;
    const src = GALLERY_SOURCES[source];
    const g = galleryState(source);
    const target = galleryTarget(source);
    const canInstall = runtimeRunning(target);
    if (g.error) {
      const e = el('div', 'empty', `${esc(g.error)}<br>`);
      const retry = el('button', 'btn sm', `${I.refresh}Try again`); retry.style.marginTop = '8px'; retry.onclick = () => { gallerySearch(source, true); renderGalleryResults(); };
      e.appendChild(retry);
      box.appendChild(e);
      return;
    }
    if (g.loading && !g.models.length) { box.appendChild(skeleton(`Searching ${esc(src.site)}…`, 4)); return; }
    if (!g.models.length) { box.appendChild(el('div', 'empty', `No models match “${esc(g.q)}”${g.capability ? ` with ${esc(g.capability)}` : ''} on ${esc(src.site)}. Try another word — or pull it by name below.`)); return; }
    box.appendChild(el('div', 'gal-count', `${g.models.length}${g.hasMore ? '+' : ''} model${g.models.length === 1 ? '' : 's'}${g.q ? ` for “${esc(g.q)}”` : ''}${g.capability ? ` · ${esc(g.capability)}` : ''} · ${esc(src.site)}`));
    for (const m of g.models) {
      const c = el('div', 'cat gal-model');
      const open = !!g.open[m.name];
      const badges = [
        ...m.capabilities.map((x) => `<span class="badge role">${esc(x)}</span>`),
        ...(m.cloud ? [`<span class="badge" title="Runs on Ollama’s cloud only">${I.cloud} cloud</span>`] : []),
      ].join('');
      const shortName = source === 'docker' ? m.name.replace(/^ai\//, '') : m.name;
      const inst = source === 'huggingface' ? null : installedFor(target, m.name);
      const sizes = m.sizes.length ? m.sizes.map((s) => `<span class="sz">${esc(s)}</span>`).join('') : '';
      const headEl = el('div', 'cat-head', `${vendorMark(vendorFromModelId(shortName.split('/').pop()), shortName)}<div class="t"><b title="${esc(m.name)}">${esc(shortName)}</b>${m.pulls ? `<span class="v" title="Downloads">${I.download} ${esc(m.pulls)}</span>` : ''}${inst ? '<span class="badge ok" style="margin-left:6px">installed</span>' : ''}<p>${esc(m.description || '')}</p><div class="gal-sizes">${sizes}</div></div><div class="tags">${badges}</div>`);
      const act = el('div', 'gal-head-act');
      const link = el('button', 'btn ghost sm', I.external); link.title = `Open on ${src.site}`; link.dataset.url = m.url;
      act.appendChild(link);
      if (!m.cloud) {
        const b = el('button', `btn sm ${open ? 'on' : ''}`, `${open ? 'Hide sizes' : 'Choose size'}${I.chev}`);
        // Liquid open / close, like disclosure(): the card shrinks to its head before the list is rebuilt closed, and
        // grows from its head after it is rebuilt open.
        b.onclick = () => {
          const go = () => { g.open[m.name] = !open; if (!open && !g.tags[m.name]) { g.tags[m.name] = { loading: true }; post({ type: 'galleryTags', source, name: m.name }); } renderGalleryResults(); };
          if (!open) { g.reveal = m.name; go(); return; }
          if (calm() || !c.animate) { go(); return; }
          const chev = b.querySelector('svg:last-child'); if (chev) { chev.animate([{ transform: 'rotate(90deg)' }, { transform: 'rotate(0deg)' }], { duration: 280, easing: GLIDE, fill: 'forwards' }); }
          c.animate([{ height: `${c.offsetHeight}px` }, { height: `${headEl.offsetHeight + (c.offsetHeight - c.clientHeight)}px` }], { duration: 260, easing: GLIDE, fill: 'forwards' }).onfinish = go;
        };
        act.appendChild(b);
      }
      headEl.appendChild(act);
      c.appendChild(headEl);
      if (open && g.reveal === m.name && !calm()) {
        g.reveal = '';
        requestAnimationFrame(() => {
          if (!c.isConnected || !c.animate) { return; }
          c.animate([{ height: `${headEl.offsetHeight + (c.offsetHeight - c.clientHeight)}px` }, { height: `${c.offsetHeight}px` }], { duration: 380, easing: GLIDE });
          const chev = headEl.querySelector('.btn.on > svg:last-child'); if (chev) { chev.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], { duration: 480, easing: SPRING }); }
          // Sizes still loading: remember this height so the card grows on from here when they arrive.
          if (c.querySelector('.cat-var .spinner')) { g.growFrom = { name: m.name, h: c.offsetHeight }; }
        });
      } else if (open && g.growFrom && g.growFrom.name === m.name && !calm()) {
        const from = g.growFrom.h;
        requestAnimationFrame(() => {
          if (!c.isConnected || !c.animate || c.querySelector('.cat-var .spinner')) { return; }
          g.growFrom = null;
          c.animate([{ height: `${from}px` }, { height: `${c.offsetHeight}px` }], { duration: 380, easing: GLIDE });
        });
      }
      if (open) {
        const t = g.tags[m.name] || { loading: true };
        if (t.loading) {
          c.appendChild(el('div', 'cat-var', '<span class="spinner"></span><span class="note">Loading sizes…</span>'));
        } else if (t.error) {
          c.appendChild(el('div', 'cat-var', `<span class="note">${esc(t.error)}</span>`));
        } else if (!t.tags.length) {
          c.appendChild(el('div', 'cat-var', `<span class="note">No downloadable sizes listed — try <code>${esc(src.cli[target] || 'ollama pull')} ${esc(m.name)}</code> below.</span>`));
        } else {
          const all = t.tags;
          const primary = all.filter(isPrimaryTag);
          const show = t.showAll || all.length <= 8 || !primary.length ? all : primary;
          for (const tag of show) {
            const fit = tag.cloud ? 'cloud' : fitOf(tag.sizeGb);
            const ref = installRef(source, target, tag);
            const row = el('div', `cat-var ${fit === 'over' || fit === 'cloud' ? 'dim' : ''}`);
            const ins = installedFor(target, ref);
            const job = state.jobs.find((j) => j.status === 'running' && j.kind === 'pull' && j.target === target && (j.model === ref || (tag.isLatest && j.model === m.name)));
            const meta = [tag.format && tag.format !== 'GGUF' ? esc(tag.format) : '', tag.context ? `${esc(tag.context)} context` : '', tag.inputs ? `${esc(tag.inputs)} input` : '', tag.updated ? esc(tag.updated) : ''].filter(Boolean).join(' · ');
            row.innerHTML = `<span class="sz" title="${esc(ref)}">${esc(tag.tag)}</span><span class="gb">${tag.cloud ? 'cloud' : esc(gbText(tag.sizeGb)) || '—'}</span><span class="fit">${fit === 'cloud' ? `<span class="badge">${I.cloud} cloud</span>` : fitBadge(fit)}</span>${tag.isLatest ? `<span class="badge brand" title="What a bare ${esc(src.cli[target] || 'pull')} ${esc(m.name)} downloads">${source === 'huggingface' ? 'default' : 'latest'}</span>` : ''}${ins ? `<span class="badge ok" title="${esc(ins.id)}">${I.check} installed</span>` : ''}<span class="note">${meta}</span><span class="spacer"></span>`;
            const act2 = el('div', 'cat-act');
            if (job) {
              act2.classList.add('prog-grp');
              act2.appendChild(progressBar(job)); act2.appendChild(pctEl(job));
              const cancel = el('button', 'btn ghost sm', I.x); cancel.title = 'Cancel'; cancel.onclick = () => post({ type: 'cancelJob', id: job.id });
              act2.appendChild(cancel);
            } else if (tag.cloud) {
              act2.appendChild(el('span', 'note', 'Not downloadable'));
            } else {
              const b = el('button', `btn sm ${fit === 'ok' && !ins ? 'primary' : ''}`, `${I.download}${ins ? 'Reinstall' : src.targets.length > 1 ? `Install to ${TARGET_LABEL[target]}` : 'Install'}`);
              b.disabled = !canInstall; b.title = canInstall ? `${src.cli[target]} ${ref}` : `Start ${TARGET_LABEL[target]} first`;
              b.onclick = () => galleryInstall(target, ref, `${shortName} ${tag.tag}`);
              act2.appendChild(b);
            }
            row.appendChild(act2);
            c.appendChild(row);
          }
          if (show.length < all.length) {
            const more = el('button', 'cat-more', `${all.length - show.length} more variant${all.length - show.length === 1 ? '' : 's'} (quantisations, MLX, bf16…) — show all ${all.length} tags`);
            more.onclick = () => { t.showAll = true; renderGalleryResults(); };
            c.appendChild(more);
          } else if (t.showAll && all.length > 8 && primary.length) {
            const less = el('button', 'cat-more', 'Show main sizes only');
            less.onclick = () => { t.showAll = false; renderGalleryResults(); };
            c.appendChild(less);
          }
        }
      }
      box.appendChild(c);
    }
    if (g.hasMore) {
      const more = el('button', 'btn gal-more', g.loading ? '<span class="spinner"></span>Loading…' : `${I.chev}Load more`);
      more.disabled = g.loading;
      more.onclick = () => { g.page += 1; gallerySearch(source, false); renderGalleryResults(); };
      box.appendChild(more);
    }
    wireGlobal(box);
  }

  // ------------------------------------------------------------------ keyboard shortcuts
  /** Built from the host's one list (src/ui/shortcuts.ts): VS Code keybindings from package.json, then the chat's own keys.
   *  "Change…" opens VS Code's Keyboard Shortcuts editor filtered to that command; the chat's keys are fixed. */
  function secShortcuts(sec) {
    head(sec, 'Keyboard shortcuts', 'Every LocalPilot key. The VS Code ones can be changed in VS Code\'s Keyboard Shortcuts editor; the keys inside the chat are fixed. <code>/keys</code> in the chat prints the same list.');
    const groups = (state.data && state.data.shortcuts) || [];
    if (state.keysOs === undefined) { state.keysOs = state.data && state.data.isMac ? 'mac' : 'win'; }
    const bar = el('div', 'btnrow');
    const seg = el('div', 'seg'); seg.setAttribute('aria-label', 'Show keys for');
    seg.innerHTML = [['mac', 'macOS'], ['win', 'Windows / Linux']].map(([k, l]) => `<button class="${state.keysOs === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
    seg.onclick = (e) => { const b = e.target.closest('button[data-k]'); if (b && b.dataset.k !== state.keysOs) { state.keysOs = b.dataset.k; render(); } };
    radioGroup(seg);
    const all = el('button', 'btn sm', `${I.external}Open Keyboard Shortcuts`); all.title = 'VS Code\'s Keyboard Shortcuts editor, filtered to LocalPilot'; all.onclick = () => post({ type: 'openKeybindings', query: 'localpilot.' });
    bar.append(seg, el('span', 'spacer'), all);
    sec.appendChild(bar);
    const kbd = (k) => String(k).split(/ \/ /).map((part) => part.split(' · ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' · ')).join(' <span class="muted">/</span> ');
    for (const g of groups) {
      sec.appendChild(el('h2', 'sub', `${esc(g.title)}${g.customizable ? '' : ' <span class="badge" title="Handled by the chat view itself">fixed</span>'}`));
      const c = el('div', 'card sc-card');
      const ul = el('ul', 'sc-list'); ul.setAttribute('aria-label', g.title);
      for (const r of g.rows || []) {
        const li = el('li', 'sc-row', `<span class="sc-act"><span>${esc(r.action)}</span>${r.when ? `<span class="muted small">${esc(r.when)}</span>` : ''}</span><span class="sc-key">${kbd(state.keysOs === 'mac' ? r.mac : r.win)}</span>`);
        if (g.customizable && r.command) {
          const b = el('button', 'btn sm ghost sc-change', 'Change…'); b.title = `Change the key for “${r.action}” in VS Code's Keyboard Shortcuts editor`; b.setAttribute('aria-label', `Change the key for ${r.action}`);
          b.onclick = () => post({ type: 'openKeybindings', query: r.command });
          li.appendChild(b);
        }
        ul.appendChild(li);
      }
      c.appendChild(ul);
      sec.appendChild(c);
    }
    if (!groups.length) { sec.appendChild(el('div', 'empty', 'No shortcuts found.')); }
  }

  // ------------------------------------------------------------------ command rules
  const RULE_KIND = { allow: ['Allow', 'ok'], ask: ['Ask', ''], block: ['Block', 'err'] };
  const GRANT_NAME = { terminal: 'Terminal commands', write: 'File edits', delete: 'Deleting files', network: 'Network', mcp: 'MCP tools' };
  /** Settings → Agent & approvals → Command rules: Bash(...) permission rules from the settings files (User:
   *  ~/.localpilot/settings.json, Workspace: .localpilot/settings.local.json), the "always allow in this workspace"
   *  grants, and a form to add or edit a rule. Rules in other files are listed read-only with Open file. */
  function commandRulesCard() {
    const build = () => {
      const v = (state.data && state.data.commandRules) || { rules: [], files: {}, fileLabels: {}, grants: [] };
      const box = el('div', 'card rules-card');
      box.appendChild(el('div', 'desc rules-lead', 'Commands you always allow, always ask about, or block, saved from approval cards (<b>Always allow “npm test”</b>) or added here. Block wins over Ask, Ask over Allow; destructive commands you allow still run without asking, so keep Allow rules narrow. <code>npm test</code> matches exactly, <code>npm run test:*</code> by prefix, <code>git log *</code> with wildcards.'));
      for (const k of v.grants || []) {
        const g = el('div', 'rule-grant', `<span class="badge ok">Always</span><span class="rg-t">${esc(GRANT_NAME[k] || k)} in this workspace</span><button class="btn sm ghost">Ask again</button>`);
        g.querySelector('button').title = `Stop allowing ${(GRANT_NAME[k] || k).toLowerCase()} without asking in this workspace`;
        g.querySelector('button').onclick = () => post({ type: 'revokeWorkspaceGrant', kind: k });
        box.appendChild(g);
      }
      const list = el('ul', 'rules');
      list.setAttribute('aria-label', 'Command rules');
      const edit = state.ruleEdit;
      (v.rules || []).forEach((r, i) => {
        const id = `${r.file}|${r.kind}|${r.raw}`;
        if (edit && edit.id === id) { list.appendChild(ruleForm(v, r)); return; }
        const li = el('li', `rule${r.editable ? '' : ' ro'}`);
        const scope = r.scope === 'workspace' ? 'Workspace' : 'User';
        li.innerHTML = `<span class="badge ${RULE_KIND[r.kind][1]} rk">${RULE_KIND[r.kind][0]}</span><span class="rmain"><code class="rp" title="${esc(r.raw)}">${r.pattern ? esc(r.pattern) : '<i>every command</i>'}</code><span class="rs" title="${esc(r.where)}">${scope}${r.editable ? '' : ` · ${esc(r.where)}`}</span></span><span class="ra"></span>`;
        const acts = li.querySelector('.ra');
        if (r.editable) {
          const e = el('button', 'reset', I.edit); e.title = 'Edit'; e.setAttribute('aria-label', `Edit rule ${r.pattern || 'every command'}`);
          e.onclick = () => { state.ruleEdit = { id }; refreshComponents(['@commandRules']); const n = app.querySelector('.rule-form input'); if (n) { n.focus(); } };
          const d = el('button', 'reset x', I.x); d.title = 'Delete'; d.setAttribute('aria-label', `Delete rule ${r.pattern || 'every command'}`);
          d.onclick = () => post({ type: 'commandRuleDelete', file: r.file, raw: r.raw, kind: r.kind });
          acts.append(e, d);
        } else {
          const o = el('button', 'btn sm ghost', `${I.external}Open`); o.title = `Edit it in ${r.where}`; o.onclick = () => post({ type: 'openRuleFile', file: r.file });
          acts.appendChild(o);
        }
        list.appendChild(li);
      });
      if (!(v.rules || []).length) { list.appendChild(el('li', 'empty', 'No command rules yet.')); }
      box.appendChild(list);
      box.appendChild(edit && edit.id === 'new' || !edit ? ruleForm(v) : el('div'));
      return component(box, ['@commandRules'], build);
    };
    return build();
  }
  /** Add (no rule) or edit (rule) form: pattern, kind and scope. */
  function ruleForm(v, r) {
    const f = el(r ? 'li' : 'div', 'rule-form');
    const hasWs = !!(v.files && v.files.workspace);
    f.innerHTML = `<input type="text" placeholder="npm test, npm run test:*, git log *" aria-label="Command or pattern" maxlength="300"><select aria-label="Rule">${['allow', 'ask', 'block'].map((k) => `<option value="${k}">${RULE_KIND[k][0]}</option>`).join('')}</select><select aria-label="Where it applies"><option value="workspace"${hasWs ? '' : ' disabled'}>This workspace</option><option value="user">All workspaces</option></select><button class="btn sm primary">${r ? 'Save' : `${I.plus}Add`}</button>${r ? '<button class="btn sm ghost" data-cancel>Cancel</button>' : ''}<div class="rule-hint err-text" role="alert" hidden></div><div class="rule-where muted small"></div>`;
    const [input] = f.querySelectorAll('input'); const [kind, scope] = f.querySelectorAll('select'); const hint = f.querySelector('.rule-hint'); const where = f.querySelector('.rule-where');
    input.value = r ? r.pattern : ''; kind.value = r ? r.kind : 'allow'; scope.value = r ? r.scope : hasWs ? 'workspace' : 'user';
    const sync = () => { where.textContent = `Saved in ${scope.value === 'workspace' ? (v.fileLabels.workspace || '.localpilot/settings.local.json') + ' (kept out of git)' : v.fileLabels.user || '~/.localpilot/settings.json'}`; };
    scope.onchange = sync; sync();
    const bad = (msg) => { hint.textContent = msg; hint.hidden = false; input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); };
    const submit = () => {
      const p = input.value.trim().replace(/\s+/g, ' ');
      if (!p) { bad('Type a command or pattern first'); return; }
      if (/[\r\n]/.test(p)) { bad('One command per rule'); return; }
      const dup = (v.rules || []).find((x) => x.editable && x.pattern === p && x.scope === scope.value && x !== r && (!r || x.raw !== r.raw || x.file !== r.file));
      if (dup && dup.kind === kind.value) { bad('That rule is already saved'); return; }
      post({ type: 'commandRuleSave', pattern: p, kind: kind.value, scope: scope.value, ...(r ? { replace: { file: r.file, raw: r.raw, kind: r.kind } } : {}) });
      state.ruleEdit = null; input.value = '';
    };
    f.querySelector('.btn.primary').onclick = submit;
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape' && r) { e.preventDefault(); state.ruleEdit = null; refreshComponents(['@commandRules']); } };
    input.oninput = () => { hint.hidden = true; input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); };
    const c = f.querySelector('[data-cancel]'); if (c) { c.onclick = () => { state.ruleEdit = null; refreshComponents(['@commandRules']); }; }
    return f;
  }

  // ------------------------------------------------------------------ agent & approvals
  function secAgent(sec) {
    head(sec, 'Agent & approvals', 'What the agent may do without asking: Ask shows an approval card in the chat, Allow proceeds, Block refuses.');
    const APPROVAL_KEYS = ['approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network', 'approvals.mcp'];
    const presetsEl = () => {
      const cur = { terminal: val('approvals.terminal'), write: val('approvals.write'), delete: val('approvals.delete'), network: val('approvals.network'), mcp: val('approvals.mcp') };
      const presets = el('div', 'approval-presets');
      for (const [k, p] of Object.entries(APPROVAL_PRESETS)) {
        const on = Object.keys(p.v).every((x) => p.v[x] === cur[x]);
        const b = el('button', `ap ${on ? 'on' : ''}`, `<b>${esc(p.title)}</b><span>${esc(p.desc)}</span>`);
        // A value the organisation does not allow is left as it is; the rest of the preset still applies.
        b.onclick = () => { for (const [x, v] of Object.entries(p.v)) { if (cur[x] !== v && !policyRefuses(`approvals.${x}`, v)) { set(`approvals.${x}`, v); } } };
        presets.appendChild(b);
      }
      return component(presets, APPROVAL_KEYS, presetsEl);
    };
    sec.appendChild(presetsEl());
    sec.appendChild(card(
      field('approvals.terminal', 'Terminal commands', '<code>run_command</code> — shell commands in the workspace. <b>Safe only</b> runs read-only commands and routine test, lint and build commands (<code>npm test</code>, <code>tsc</code>, <code>pytest</code>, <code>cargo test</code>) and asks for the rest.', 'seg', { options: [['ask', 'Ask'], ['safe', 'Safe only'], ['always', 'Allow'], ['never', 'Block']] }),
      field('approvals.dangerousAlwaysAsk', 'Always ask before destructive commands', '<code>sudo</code>, <code>rm -rf /…</code>, <code>git push --force</code>, <code>git reset --hard</code> and similar ask even when commands are allowed.', 'toggle'),
      field('approvals.write', 'File edits', '<code>edit_file</code>, <code>write_file</code>, <code>create_directory</code>. Every edit is tracked and can be undone from the Changes panel either way.', 'seg', { options: APPROVAL }),
      field('approvals.delete', 'Deleting files', '<code>delete_path</code> — moves to the OS trash when possible.', 'seg', { options: APPROVAL }),
      field('approvals.network', 'Network', '<code>web_search</code>, <code>web_fetch</code> and the browser tools.', 'seg', { options: APPROVAL }),
      field('approvals.mcp', 'MCP tools', 'Tools from MCP servers. A server\'s <code>autoApprove</code> list runs those tools without asking even when this is Ask. Set single tools to Allow, Ask or Block on the <button class="inline-link" data-sec="mcp">MCP servers</button> page.', 'seg', { options: APPROVAL })
    ));
    sec.appendChild(el('h2', 'sub', 'Command rules'));
    sec.appendChild(commandRulesCard());
    sec.appendChild(el('h2', 'sub', 'Tools'));
    // Each switch edits localpilot.disabledTools by exact name; a tool switched off by a glob or alias stays locked here.
    const toolsEl = () => {
      const box = el('div', 'card tools-card');
      const tools = (state.data && state.data.tools) || [];
      const own = Array.isArray(ownValue('disabledTools')) ? ownValue('disabledTools') : [];
      const merged = Array.isArray(val('disabledTools')) ? val('disabledTools') : [];
      box.appendChild(el('div', 'desc', `Switched-off tools are never offered to the agent or its subagents. ${tools.filter((t) => t.off).length} of ${tools.length} off. MCP tools are managed per server on the MCP page; globs such as <code>mcp_*</code> or <code>browser_*</code> go in <code>localpilot.disabledTools</code>.`));
      if (!tools.length) { box.appendChild(el('div', 'empty', 'No tools registered yet.')); }
      for (const t of tools) {
        const byName = merged.includes(t.name);
        const locked = t.off && !byName;
        const row = el('div', `mrow tool ${t.off ? 'off' : ''}`);
        const tg = el('button', `toggle ${t.off ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.setAttribute('aria-checked', String(!t.off)); tg.setAttribute('aria-label', t.name);
        tg.title = locked ? `Off by a pattern in localpilot.disabledTools (${merged.join(', ')})` : t.off ? 'Turn on: offer this tool to the agent' : 'Turn off: never offer this tool to the agent';
        if (locked) { tg.disabled = true; }
        tg.onclick = () => { tg.classList.toggle('on'); set('disabledTools', t.off ? own.filter((n) => n !== t.name) : [...own.filter((n) => n !== t.name), t.name]); };
        row.appendChild(tg);
        row.appendChild(el('div', 't', `<b>${esc(t.name)}</b><span>${esc(t.description || '')}</span>`));
        box.appendChild(row);
      }
      return component(box, ['disabledTools'], toolsEl);
    };
    sec.appendChild(toolsEl());
    sec.appendChild(el('h2', 'sub', 'Auto mode'));
    sec.appendChild(card(
      field('autoMode.enabled', 'Review approvals with a local model', 'An action that would ask you first is reviewed by a small local model. It approves actions that clearly serve your request and stay inside the project; everything else still shows the approval card. <b>Block</b> rules are never overridden.', 'toggle'),
      field('autoMode.model', 'Reviewer model', 'Empty = the fastest suitable installed model.', 'select', { options: [['', 'Auto (fastest suitable model)', ''], ...modelOptions()] })
    ));
    sec.appendChild(el('h2', 'sub', 'Terminal'));
    sec.appendChild(card(
      field('terminal.runInIntegratedTerminal', 'Run commands in a visible terminal', 'The agent\'s <code>run_command</code> calls run in a branded <b>LocalPilot Agent</b> terminal through shell integration, so you can watch them live. Falls back to a hidden process when the shell has no integration.', 'toggle'),
      shellWait(),
      field('terminal.reveal', 'Reveal the terminal when a command runs', 'Shows the panel without stealing focus from the editor.', 'toggle'),
      termProfile(),
      field('terminal.autoDetachSeconds', 'Continue while a command keeps running after (s)', 'The command keeps running and its later output goes to a log the agent can read. <code>0</code> = never detach (stopped at its timeout).', 'number', { min: 0, max: 3600, step: 30 }),
      field('notifications', 'Notifications', 'A native notification when a chat finishes, or when an auto-approved command is still running after 30 seconds. The terminal CLI rings the bell after runs longer than 10 seconds.', 'seg', { options: [['whenHidden', 'When hidden'], ['always', 'Always'], ['off', 'Off']] })
    ));
    sec.appendChild(el('h2', 'sub', 'Edits &amp; checkpoints'));
    sec.appendChild(card(
      field('diffPreview', 'Show a diff of proposed edits', 'Opens <i>Original ↔ LocalPilot (proposed)</i> beside the editor for <code>edit_file</code>, <code>write_file</code> and <code>apply_patch</code>. <b>On approval</b>: only while an edit waits for your approval.', 'seg', { options: [['onApproval', 'On approval'], ['always', 'Always'], ['off', 'Never']] }),
      field('editTool', 'File-editing tool', 'Which tool the agent edits files with. Models trained on one format make fewer failed edits with it.', 'select', { options: [['auto', 'Auto', 'apply_patch for GPT / Codex / gpt-oss, edit_file for others'], ['edit_file', 'edit_file + write_file'], ['apply_patch', 'apply_patch', 'several files, one approval']] }),
      field('edit.reportNewErrors', 'Tell the agent about errors its edit introduced', 'Waits up to 1.5 s for the language server and adds up to 10 new errors in the edited file to the tool result.', 'toggle'),
      field('checkpoints.enabled', 'Checkpoint before each message', 'In git, a private ref records the working tree (including untracked files) without touching your index, branches or stash. Off: only files the agent edits are snapshotted. Restore from a message\'s checkpoint menu.', 'toggle')
    ));
    sec.appendChild(el('h2', 'sub', 'Conversation'));
    sec.appendChild(card(
      field('preferredLanguage', 'Answer in', 'Applies to chat and CLI. Code, identifiers and commands are never translated.', 'select', { options: [['auto', 'Auto — follow my language'], ...LANGUAGES.map((l) => [l, l])] }),
      field('showTips', 'Show tips while the agent thinks', 'Short built-in feature tips in the chat status row after a few seconds of thinking. Nothing is fetched.', 'toggle'),
      field('autoClarify', 'Interpret vague requests automatically', 'When a prompt is short or says “fix this” / “make it faster” without naming a target, the agent is handed the active file, selection, open editors, recent edits, errors and git changes, states <i>Understood as: …</i> and proceeds. It only asks when two readings would lead to materially different work.', 'toggle'),
      field('prompts.autoCorrect', 'Correct misspelled names in requests', 'Fixes file names and code identifiers you mistyped (<code>dicee.py</code> → <code>dice.py</code>, <code>rollDise</code> → <code>rollDice</code>) against the names in the workspace before the agent starts, so it reads and searches the right thing. Plain words are never changed; corrections are shown under your message.', 'toggle'),
      field('clarify.questions', 'Questions before starting', 'When the agent asks you first, in a card in the chat with explained options and a recommended pick. <b>Smart</b>: for new features and open-ended or large requests, then it states a short plan and starts. <b>Interview</b>: for every change, and it waits for your OK on the plan. <b>Minimal</b>: only when it cannot tell which of two very different things you mean.', 'seg', { options: [['smart', 'Smart'], ['interview', 'Interview'], ['minimal', 'Minimal']] })
    ));
    sec.appendChild(el('h2', 'sub', 'Hooks'));
    sec.appendChild(card(
      field('hooks.enabled', 'Run hooks', 'Shell commands from <code>.localpilot/settings.json</code>, <code>.claude/settings.json</code> and <code>~/.claude/settings.json</code> on <code>PreToolUse</code>, <code>PostToolUse</code>, <code>UserPromptSubmit</code>, <code>Stop</code>, <code>SessionStart</code>… with the Claude Code protocol (exit 2 blocks). Turn off for a repository you do not trust.', 'toggle')
    ));
    sec.appendChild(el('h2', 'sub', 'Isolated worktrees'));
    sec.appendChild(card(
      field('worktrees.mode', 'Where agents work', 'Each agent can work in its own copy of the repository (a git worktree seeded with your uncommitted changes), so several agents never clobber each other or your open files. You review the result in the Changes panel and <b>Apply to workspace</b> or <b>Discard</b>. Outside a git repository agents edit directly.', 'select', { options: [['always', 'Always isolate', 'every agent chat gets its own copy (recommended)'], ['parallel', 'Only agents started together', 'Multitask batches and Best of N are isolated; a single chat edits the workspace'], ['off', 'Never', 'agents edit the workspace directly']] }),
      field('worktrees.location', 'Worktree folder', 'Where the copies live, one sub-folder per repository. Empty = <code>~/.localpilot/worktrees</code>. Setup commands for new copies (<code>npm ci</code>…) go in <code>.localpilot/worktrees.json</code> as <code>{ "setup": ["npm ci"] }</code>.', 'text', { placeholder: '~/.localpilot/worktrees', wide: true })
    ));
    sec.appendChild(el('h2', 'sub', 'Repositories'));
    const auto = ((state.data && state.data.autoRepos) || []).map((r) => ({ name: r.name, value: r.path, badge: 'automatic', tip: r.source === 'repos.json' ? 'From .localpilot/repos.json' : 'A folder of this workspace' }));
    sec.appendChild(card(keyValueEditor('repos', 'Extra repositories', 'Other repositories the agent can list, search, edit and run commands in (the <code>repos</code> tool), one subagent per repository for cross-repository changes. Folders of a multi-root workspace and <code>.localpilot/repos.json</code> are included automatically.', {
      nameRe: /^[\w.-]{1,40}$/, nameHint: 'Letters, digits, “.”, “-” and “_”, up to 40', namePlaceholder: 'name (e.g. api)', valuePlaceholder: '~/src/api', browse: true, addLabel: 'Add repository', extra: auto,
      empty: 'Only this workspace. Add another repository so the agent can search, edit and run commands across both.',
    })));
    sec.appendChild(el('h2', 'sub', 'Parallelism & context'));
    sec.appendChild(card(
      field('parallel.maxConcurrency', 'Max concurrent tools / subagents', 'Read-only tools and parallel subagents run concurrently up to this limit.', 'number', { min: 1, max: 16 }),
      field('parallel.maxSubagentDepth', 'Max subagent depth', 'Levels of subagents allowed. 1 = the agent may delegate but its subagents cannot start their own; 2 (default) = they can, one level deeper.', 'number', { min: 1, max: 4, step: 1 }),
      field('queue.concurrency', 'Queued tasks at once', 'Tasks from the task queue (Agents view → Queue, or <i>LocalPilot: Queue Agent Task…</i>). <code>1</code> runs them one after another; higher values run them side by side, each in its own worktree when <b>Where agents work</b> isolates them.', 'number', { min: 1, max: 8 }),
      field('compaction.strategy', 'When the context fills up', '<b>Summarise</b>: the model writes a structured summary of older messages (falls back to Trim). <b>Trim</b>: keeps your messages, the last replies and one line per tool call. <b>Never</b>: a chat that outgrows the window fails until you run <code>/compact</code> or start a new chat. The full transcript is archived before compaction either way.', 'seg', { options: [['agentic', 'Summarise (model)'], ['basic', 'Trim (instant)'], ['off', 'Never']] }),
      compactAt(),
      field('maxToolOutputChars', 'Max tool output', 'Longer outputs are truncated (head + tail) before reaching the model.', 'number', { min: 2000, max: 200000, step: 1000 }),
      field('maxConsecutiveMistakes', 'Stop after errors in a row', 'A run stops and asks for guidance after this many steps in a row in which every tool call failed. Any successful tool call resets the count. <code>0</code> = no limit.', 'number', { min: 0, max: 50, step: 1 }),
      field('systemPromptAppend', 'Extra instructions', 'Appended to every system prompt — coding conventions, preferred libraries, language. Project rules in <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>.cursorrules</code> and <code>.github/copilot-instructions.md</code> are loaded automatically.', 'textarea', { wide: true, placeholder: 'Always use TypeScript strict mode. Prefer small, pure functions. Use pnpm, not npm.' })
    ));
    sec.appendChild(el('h2', 'sub', 'Self-healing'));
    sec.appendChild(healingSettings());
  }

  /** The localpilot.healing.* rows. With the engine off the rest stays visible but disabled, like compactAt(). */
  function healingSettings() {
    const off = healingOff();
    const o = { off };
    const c = card(
      field('healing.enabled', 'Self-healing', 'Detects failures while the agent works (model errors, failed tools, type errors, failing tests), finds the root cause, fixes it and re-runs the checks before calling a task done. Off: failures are reported as before.', 'toggle'),
      field('healing.autoDetect', 'Detect failures at every step', 'Classifies failed tool calls, model errors and check results as they happen.', 'toggle', o),
      field('healing.autoRetry', 'Retry transient failures', 'Timeouts, a model server that went away, overloaded models and flaky MCP tools are retried with backoff. A deterministic failure is never just repeated.', 'toggle', o),
      field('healing.autoFix', 'Fix failures automatically', 'For compile errors, failing tests and similar the agent diagnoses the root cause and makes a targeted fix. Off: failures are detected and reported only.', 'toggle', o),
      field('healing.regressionRequired', 'Require the full relevant test suite to pass', 'A task only counts as <b>completed</b> when the fix broke nothing else. Off: passing the failing checks is enough.', 'toggle', o),
      field('healing.scopeTests', 'Run affected tests first', 'Tests near the changed files run before the full suite, so a failure shows up sooner.', 'toggle', o),
      field('healing.delegateFixes', 'Fix independent failures in parallel', 'Unrelated groups of failures (different packages, different errors) are fixed by parallel subagents, within <b>Max concurrent tools / subagents</b>.', 'toggle', o),
      field('healing.maxRepairAttempts', 'Fix attempts per failure', 'How often the agent may try to fix one code failure (compile error, failing test…) before it stops and asks you.', 'number', { ...o, min: 0, max: 10, step: 1 }),
      field('healing.maxTotalAttempts', 'Recovery attempts per task', 'All retries and fixes of one task together, whatever the kind of failure.', 'number', { ...o, min: 0, max: 30, step: 1 }),
      field('healing.extraSteps', 'Extra steps for recovery', 'Model steps a recovery may add on top of the usual step limit.', 'number', { ...o, min: 0, max: 60, step: 1 }),
      field('healing.taskDeadlineMinutes', 'Recovery deadline', 'Counted from the first failure of a task: when it passes, the agent stops trying and reports what is left. Runs without failures have no deadline. <code>0</code> = no deadline.', 'number', { ...o, min: 0, max: 1440, step: 5, unit: 'min' }),
      field('healing.checkTiming', 'When checks run', 'The typecheck, lint, build and test commands that verify the work.', 'select', { ...o, options: [['onComplete', 'When the task is done', 'once, before the agent reports back'], ['afterEdits', 'After every edit', 'catches a failure sooner, costs more time']] }),
      field('healing.checkTimeoutSeconds', 'Time limit per check', 'Test commands get twice as long. A check that runs out of time leaves the task <b>Not verified</b>, not failed.', 'number', { ...o, min: 10, max: 3600, step: 10, unit: 's' }),
      field('healing.checkTimeBudgetSeconds', 'Time limit per verification run', 'All checks of one verification run together.', 'number', { ...o, min: 30, max: 7200, step: 30, unit: 's' }),
      field('healing.baseline', 'Failures that were there before', 'Checks run once before the agent changes anything, so failures it did not cause are not blamed on it.', 'select', { ...o, options: [['fast', 'Fast', 'typecheck and lint'], ['all', 'All checks', 'tests too'], ['off', 'Off', 'every failure counts']] }),
      field('healing.memory', 'Remember failures and fixes', 'What fixed a failure before is suggested when the same failure comes back. <b>Workspace</b>: kept with VS Code\'s workspace storage. <b>Project</b>: <code>.localpilot/recovery-memory.json</code>, shareable with your team.', 'select', { ...o, options: [['workspace', 'Workspace'], ['project', 'Project', '.localpilot/recovery-memory.json'], ['off', 'Off']] }),
      field('healing.dependencyInstall', 'Installing missing packages', 'An install always shows an approval card. <b>Never</b>: a missing package is reported and the task is blocked.', 'select', { ...o, options: [['ask', 'Ask every time'], ['never', 'Never install', 'report it and stop']] }),
      field('healing.securityCheck', 'Security check', 'Scans changed files for secrets and unsafe code, offline. <b>Changed files + dependencies</b> also checks dependencies for known vulnerabilities (asks before going online). A finding blocks completion until it is fixed; a repository\'s settings cannot switch this off.', 'select', { ...o, options: [['changed', 'Changed files', 'offline'], ['full', 'Changed files + dependencies', 'asks before going online'], ['off', 'Off']] }),
      field('healing.gitConflicts', 'Git conflicts', 'A merge conflict is never resolved automatically: your changes are kept and the conflict is handed to you to review.', 'select', { off: 'The only option in this release', options: [['escalate', 'Escalate to me']] }),
      lockedRow('Security bypass', 'Disabled (cannot be enabled)', 'Security findings and approval rules are never skipped by self-healing. Only you can accept a risk, from the recovery card in the chat, and that is recorded in the audit log.'),
      healingChecks(),
      healingPolicies()
    );
    return component(c, ['healing.enabled'], healingSettings);
  }
  const healingOff = () => (effVal('healing.enabled') === false ? 'Self-healing is off — switch it on above' : '');
  const HEAL_CAT_LABEL = {
    model_timeout: 'Model stopped responding', model_unavailable: 'Model server unreachable', model_overload: 'Model out of memory', model_output: 'Malformed model output',
    compile: 'Compile errors', typescript: 'Type errors', lint: 'Lint errors', build: 'Build failures', dependency: 'Missing packages',
    unit_test: 'Failing unit tests', integration_test: 'Failing integration tests', runtime: 'Runtime errors',
    database: 'Database and migrations', data_corruption: 'Data corruption', mcp: 'MCP tool failures', git_conflict: 'Git conflicts', security: 'Security findings',
    tool: 'Failed tool calls', permission: 'Permissions and credentials', check_timeout: 'Checks that run out of time', loop: 'Loops and step limits', unknown: 'Other failures',
  };
  /** "1000, 2000" -> [1000, 2000]; null when an entry is not a whole number of ms from 0 to 600000 (the host's clamp). */
  const parseWaits = (text) => {
    const parts = String(text).split(/[\s,;]+/).filter(Boolean);
    if (parts.length > 10 || parts.some((x) => !/^\d+$/.test(x) || Number(x) > 600000)) { return null; }
    return parts.map(Number);
  };
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  /** Retry configuration: one row per failure category with the engine's defaults. A change writes the selected scope's
   *  healing.policies with that category merged in; values equal to the default are dropped, so the entry goes away. */
  function healingPolicies() {
    const h = state.data && state.data.healing;
    const own = ownValue('healing.policies'); const cur = own && typeof own === 'object' && !Array.isArray(own) ? own : {};
    const wrap = el('div', 'heal-pol');
    wrap.appendChild(el('div', 'heal-sub', 'Retry configuration'));
    if (!h) { wrap.appendChild(el('div', 'muted small', 'Open the Settings page in a window with LocalPilot running to edit the retry configuration.')); }
    else {
      const tw = el('div', 'tblwrap');
      const t = el('table', 'tbl heal-pol-tbl');
      t.innerHTML = '<thead><tr><th scope="col">Failure</th><th scope="col">Attempts</th><th scope="col">Waits between retries</th><th scope="col">Time limit per attempt</th><th scope="col"><span class="sr">Reset</span></th></tr></thead>';
      const tb = el('tbody');
      for (const p of h.policies) {
        const ov = cur[p.category] && typeof cur[p.category] === 'object' ? cur[p.category] : {};
        const fixed = p.max === 0;
        const name = HEAL_CAT_LABEL[p.category] || p.category;
        const tr = el('tr', fixed ? 'fixed' : '');
        tr.innerHTML = `<th scope="row">${esc(name)}<span class="cat">${esc(p.category)}</span></th><td></td><td></td><td></td><td class="act"></td>`;
        const [, tdA, tdW, tdT, tdR] = tr.children;
        const fk = (f) => `healing.policies:${p.category}:${f}`;
        const num = (value, min, max, label, placeholder) => {
          const i = el('input'); i.type = 'number'; i.min = min; i.max = max; i.step = 1; i.value = value ?? ''; i.placeholder = placeholder || ''; i.setAttribute('aria-label', `${name}: ${label}`); i.dataset.fk = fk(label); return i;
        };
        const att = num(ov.attempts ?? Math.min(p.attempts, p.max), 0, p.max, 'attempts');
        const waits = el('input'); waits.type = 'text'; waits.value = (Array.isArray(ov.backoffMs) ? ov.backoffMs : p.backoffMs).join(', '); waits.placeholder = 'none'; waits.setAttribute('aria-label', `${name}: waits between retries in milliseconds`); waits.dataset.fk = fk('waits');
        const tmo = num(ov.timeoutSeconds ?? p.timeoutSeconds, 1, 3600, 'time limit', 'default');
        const unit = (input, u) => { const r = el('div', 'row unit-row'); r.append(input, el('span', 'unit', u)); return r; };
        tdA.appendChild(fixed ? el('span', 'fixed-val', `${I.lock}0`) : unit(att, `max ${p.max}`));
        tdW.appendChild(unit(waits, 'ms'));
        tdT.appendChild(unit(tmo, 's'));
        if (fixed) {
          const why = p.category === 'data_corruption' || p.category === 'loop' ? 'Always stops and reports to you' : 'Always handed to you, never retried';
          tr.title = why; [waits, tmo].forEach((x) => { x.disabled = true; x.title = why; });
          tdA.querySelector('.fixed-val').title = why;
        }
        if (cur[p.category] !== undefined) {
          const rb = el('button', 'reset', I.undo); rb.title = `Back to the default for ${name}`; rb.setAttribute('aria-label', rb.title); rb.dataset.fk = fk('reset');
          rb.onclick = () => { const next = { ...cur }; delete next[p.category]; set('healing.policies', next); };
          tdR.appendChild(rb);
        }
        const bad = (i, hint) => { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); i.title = `${hint} — not saved yet`; return true; };
        const ok = (i) => { i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); i.title = ''; };
        const commit = () => {
          const a = Number(att.value); const w = parseWaits(waits.value); const s = tmo.value === '' ? undefined : Number(tmo.value);
          let invalid = false;
          if (att.value === '' || !Number.isInteger(a) || a < 0 || a > p.max) { invalid = bad(att, `Enter a whole number from 0 to ${p.max}`); } else { ok(att); }
          if (!w) { invalid = bad(waits, 'Whole milliseconds separated by commas, at most 10, each up to 600000'); } else { ok(waits); }
          if (s !== undefined && (!Number.isInteger(s) || s < 1 || s > 3600)) { invalid = bad(tmo, 'Enter whole seconds from 1 to 3600, or leave empty for the default'); } else { ok(tmo); }
          if (invalid) { return; }
          const entry = {};
          if (a !== Math.min(p.attempts, p.max)) { entry.attempts = a; }
          if (!sameList(w, p.backoffMs)) { entry.backoffMs = w; }
          if (s !== undefined && s !== p.timeoutSeconds) { entry.timeoutSeconds = s; }
          const next = { ...cur };
          if (Object.keys(entry).length) { next[p.category] = entry; } else { delete next[p.category]; }
          if (JSON.stringify(next) !== JSON.stringify(cur)) { set('healing.policies', next); }
        };
        // Categories held at 0 never retry: nothing in their row can be saved.
        if (!fixed) { [att, waits, tmo].forEach((x) => { x.onchange = commit; }); }
        tb.appendChild(tr);
      }
      t.appendChild(tb); tw.appendChild(t); wrap.appendChild(tw);
    }
    const f = field('healing.policies', 'Retry configuration', 'How often each kind of failure is retried or fixed, how long to wait between retries (the last wait repeats) and how long one attempt may take. Security findings get at most 3 fix attempts; data corruption, git conflicts, permissions and loops always go to you. Changes are written to <code>localpilot.healing.policies</code>.', 'json', { off: healingOff(), unit: 'override', after: wrap });
    return component(f, ['healing.enabled', 'healing.policies'], healingPolicies);
  }
  const CHECK_SOURCE = { discovered: ['Detected', 'Found in the project files'], 'checks.json': ['checks.json', '.localpilot/checks.json in this repository'] };
  /** Detected checks for this workspace (read-only, from the host) plus the Open checks.json button. */
  function healingChecks() {
    const h = state.data && state.data.healing;
    const wrap = el('div', 'heal-checks');
    wrap.appendChild(el('div', 'heal-sub', 'Detected checks for this workspace'));
    // The note is a flex row: the icon and one text span, so inline code and bold stay in the flow of the sentence.
    const note = (cls, html) => { const m = /^(<svg[\s\S]*?<\/svg>)?([\s\S]*)$/.exec(html); return wrap.appendChild(el('div', `heal-note ${cls}`, `${m[1] || ''}<span>${m[2]}</span>`)); };
    if (!h) { note('', 'Checks are listed once the page has loaded.'); }
    else if (!h.hasRoot) { note('', 'Open a folder to see the checks that verify the work in it.'); }
    else {
      if (!h.trusted) { note('warn', `${I.warn}This workspace is not trusted: <code>.localpilot/checks.json</code> and the workspace value of <b>Checks</b> are ignored. Your User value still applies.`); }
      if (h.checksJson === 'invalid') { note('warn', `${I.warn}<code>.localpilot/checks.json</code> is not valid JSON and is ignored.`); }
      if (h.checks.length) {
        const tw = el('div', 'tblwrap');
        const t = el('table', 'tbl heal-checks-tbl');
        t.innerHTML = '<thead><tr><th scope="col">Check</th><th scope="col">Command</th><th scope="col">From</th></tr></thead>';
        const tb = el('tbody');
        for (const c of h.checks) {
          const [src, tip] = c.source === 'setting' ? (c.scope === 'workspace' ? ['Workspace settings', 'localpilot.healing.checks in the workspace settings'] : ['User settings', 'localpilot.healing.checks in your User settings']) : CHECK_SOURCE[c.source] || [c.source, ''];
          const builtIn = c.kind === 'security' && c.source === 'discovered';
          tb.appendChild(el('tr', '', `<td><b>${esc(c.id)}</b><div class="muted small">${esc(c.kind)}${c.required ? '' : ' · optional'}</div></td><td>${builtIn ? `<span class="muted">${esc(c.command)}</span>` : `<code title="${esc(c.cwd ? `in ${c.cwd}` : 'in the workspace folder')}">${esc(c.command)}</code>`}</td><td><span class="badge ${c.source === 'discovered' ? '' : c.source === 'setting' && c.scope === 'user' ? 'user' : 'workspace'}" title="${esc(tip)}">${esc(src)}</span></td>`));
        }
        t.appendChild(tb); tw.appendChild(t); wrap.appendChild(tw);
      } else { note('', 'No checks found: add them below or in <code>.localpilot/checks.json</code>.'); }
      if (h.disabled.length) { note('', `Turned off in <code>.localpilot/checks.json</code>: ${h.disabled.map((d) => `<code>${esc(d)}</code>`).join(', ')}`); }
    }
    const r = el('div', 'row btnrow');
    const b = el('button', 'btn sm', `${I.external}Open checks.json`);
    b.title = h && h.checksJson === 'missing' ? 'Create .localpilot/checks.json from a template and open it' : 'Open .localpilot/checks.json';
    b.disabled = !h || !h.hasRoot;
    b.onclick = () => post({ type: 'openChecksJson' });
    const rl = el('button', 'btn sm ghost', `${I.refresh}Refresh`); rl.title = 'Look for checks in the workspace again'; rl.disabled = !h || !h.hasRoot;
    rl.onclick = () => { rl.disabled = true; post({ type: 'loadChecks' }); };
    r.append(b, rl, el('span', 'muted small', h && !h.trusted ? 'Ignored until you trust this workspace.' : 'checks.json is ignored in untrusted workspaces.'));
    wrap.appendChild(r);
    const f = field('healing.checks', 'Checks', 'Add or override the commands that verify the work, matched by <code>id</code>: <code>{ "id": "custom:e2e", "kind": "test", "command": "npm run test:e2e", "required": false }</code>. <code>.localpilot/checks.json</code> in the repository wins over this. <code>.localpilot/checks.json</code> and the workspace value of this setting are ignored in an untrusted workspace; your User value still applies.', 'json', { off: healingOff(), unit: 'check', after: wrap });
    return component(f, ['healing.enabled', 'healing.checks'], healingChecks);
  }
  /** A value that is fixed by design, not by a setting: shown with a lock and nothing to change. */
  function lockedRow(label, value, desc) {
    const f = el('div', 'field locked fixed');
    f.innerHTML = `<div><div class="lbl">${esc(label)}<span class="lock" role="img" title="Cannot be changed" aria-label="Cannot be changed">${I.lock}</span></div><div class="desc">${desc}</div></div><div class="ctl"><span class="fixed-val">${I.shield}${esc(value)}</span></div>`;
    return f;
  }

  /** The threshold slider follows the strategy: with compaction off it has nothing to trigger. */
  function compactAt() {
    const off = effVal('compaction.strategy') === 'off';
    const fmt = (v) => `${Math.round(v * 100)}%${off ? ' (off)' : ''}`;
    const f = field('compactionThreshold', 'Compact context at', 'When the context reaches this share of the window, older messages are compacted automatically.', 'range', { min: 0.3, max: 0.95, step: 0.05, fmt, off: off ? 'Compaction is off — pick Summarise or Trim above' : '' });
    return component(f, ['compactionThreshold', 'compaction.strategy'], compactAt);
  }

  /** The languages localpilot.preferredLanguage accepts (package.json enum, after "auto"). */
  const LANGUAGES = ['English', 'Arabic', 'Portuguese (Brazil)', 'Czech', 'French', 'German', 'Hindi', 'Hungarian', 'Italian', 'Japanese', 'Korean', 'Polish', 'Portuguese (Portugal)', 'Russian', 'Simplified Chinese', 'Spanish', 'Traditional Chinese', 'Turkish'];
  /** The agent's shell: VS Code's default or one of this OS's terminal profiles, plus the quick pick that explains each one. */
  function termProfile() {
    const names = (state.data && state.data.terminalProfiles) || [];
    const f = field('terminal.profile', 'Shell for agent commands', 'Used by the <b>LocalPilot Agent</b> terminal, background commands and the hidden fallback process. Profiles come from <code>terminal.integrated.profiles</code> for this OS.', 'select', { options: [['default', 'VS Code default shell'], ...names.filter((n) => n !== 'default').map((n) => [n, n])] });
    const ctl = f.querySelector('.ctl'); const sel = ctl.querySelector('select');
    const pick = el('button', 'btn sm', 'Pick…'); pick.dataset.cmd = 'localpilot.selectTerminalProfile'; pick.title = 'Choose from the profiles with their shell paths'; pick.disabled = sel.disabled;
    const row = el('div', 'row pick-row'); row.append(sel, pick); ctl.appendChild(row);
    return component(f, ['terminal.profile'], termProfile);
  }
  /** Only relevant while commands run in the visible terminal. */
  function shellWait() {
    if (!effVal('terminal.runInIntegratedTerminal')) { const h = el('div'); h.hidden = true; return component(h, ['terminal.runInIntegratedTerminal', 'terminal.shellIntegrationTimeout'], shellWait); }
    const f = field('terminal.shellIntegrationTimeout', 'Wait for shell integration (ms)', 'Raise it when a slow shell start-up (large <code>.zshrc</code>, conda) makes commands fall back to a hidden process.', 'number', { min: 500, max: 30000, step: 500 });
    return component(f, ['terminal.runInIntegratedTerminal', 'terminal.shellIntegrationTimeout'], shellWait);
  }
  /** Learned notes need memory itself. */
  function memAutoSave() {
    const off = effVal('memory.enabled') === false;
    const f = field('memory.autoSave', 'Save what a run taught automatically', 'After a run with 3+ tool calls in which the agent saved nothing, the same model may append up to three short notes (verified commands, conventions, pitfalls) to project memory. Runs after the answer; credentials are dropped.', 'toggle', { off: off ? 'Needs Enable memory' : '' });
    return component(f, ['memory.enabled', 'memory.autoSave'], memAutoSave);
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
    sec.appendChild(card(
      field('webSearch.enabled', 'Let the agent use the internet', '<code>web_search</code>, <code>web_fetch</code>, the browser tools and <code>@https://…</code> mentions. Off: these tools are removed from every request and URL mentions are refused. Model providers are not affected.', 'toggle')
    ));
    const prov = val('webSearch.provider');
    // Everything below needs internet access: with the switch off it stays visible but dimmed and inert.
    const dependents = () => {
      const off = effVal('webSearch.enabled') === false ? 'Internet access is off' : '';
      const box = el('div', 'web-deps');
      if (off) { box.appendChild(el('p', 'muted small dim-note', 'Internet access is off — turn it on above to use these.')); }
      box.appendChild(el('h2', 'sub', 'Search'));
      box.appendChild(card(
        field('webSearch.provider', 'Search provider', '<b>DuckDuckGo</b> needs no key. <b>SearXNG</b> is self-hosted and fully private. <b>Brave</b> and <b>Tavily</b> need an API key.', 'select', { off, options: [['duckduckgo', 'DuckDuckGo'], ['searxng', 'SearXNG (self-hosted)'], ['brave', 'Brave Search'], ['tavily', 'Tavily']] }),
        prov === 'searxng' ? field('webSearch.searxngUrl', 'SearXNG URL', 'Your instance, e.g. <code>http://localhost:8888</code>.', 'text', { off, placeholder: 'http://localhost:8888', validate: (v) => /^https?:\/\/.+/.test(v) }) : null,
        prov === 'brave' || prov === 'tavily' ? field('webSearch.apiKey', 'API key', 'Kept in VS Code secret storage (your OS keychain), not in settings.json. Or write <code>${env:NAME}</code> to read it from an environment variable.', 'password', { off, secret: true }) : null,
        field('webSearch.maxResults', 'Max results', '', 'number', { off, min: 1, max: 20 })
      ));
      box.appendChild(el('h2', 'sub', 'Browser'));
      box.appendChild(card(
        field('browser.chromePath', 'Browser for screenshots', 'A Chromium-based browser run headless by <code>browser_screenshot</code> and <i>Screenshot a Web Page…</i>. Empty = auto-detect Chrome, Chromium, Edge, Brave or Arc.', 'text', { off, placeholder: 'auto-detect', wide: true })
      ));
      if (off) { box.querySelectorAll('.card').forEach((c) => { c.classList.add('dim'); c.setAttribute('aria-disabled', 'true'); }); }
      return component(box, ['webSearch.enabled'], dependents);
    };
    sec.appendChild(dependents());
  }

  // ------------------------------------------------------------------ markdown & pdf
  function secDocuments(sec) {
    head(sec, 'Markdown & PDF', 'How LocalPilot\'s Markdown reader and PDF viewer show documents.');
    sec.appendChild(el('h2', 'sub', 'Markdown reader'));
    const md = el('div', 'btnrow');
    md.innerHTML = `<span class="muted small">Opens the active Markdown file, or asks for one.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.openMarkdownViewer">${I.file}Open Markdown reader</button>`;
    sec.appendChild(card(
      field('markdownViewer.scrollSync', 'Keep reader and source scrolled together', 'Double-click a paragraph in the reader to jump to its source line.', 'toggle'),
      field('markdownViewer.outlineDepth', 'Headings shown in the outline', 'Deepest heading level in the outline and in an inline <code>[[toc]]</code>.', 'seg', { options: [[2, 'H2'], [3, 'H3'], [4, 'H4'], [5, 'H5'], [6, 'H6']] }),
      field('markdownViewer.frontMatter', 'YAML front matter', 'Shown as a Properties table above the document.', 'seg', { options: [['collapsed', 'Collapsed'], ['expanded', 'Expanded'], ['hidden', 'Hidden']] }),
      field('markdownViewer.mermaid', 'Render Mermaid diagrams', 'Bundled; works offline.', 'toggle'),
      field('markdownViewer.exportTheme', 'Export as HTML / PDF colours', '', 'seg', { options: [['light', 'Light'], ['match', 'Match VS Code theme']], after: md })
    ));
    sec.appendChild(el('h2', 'sub', 'PDF viewer'));
    const pdf = el('div', 'btnrow');
    pdf.innerHTML = `<span class="muted small">PDFs also open in this viewer from the Explorer.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.openPdf">${I.file}Open a PDF…</button>`;
    sec.appendChild(card(
      field('pdfViewer.pageColors', 'Page colours', 'Auto darkens pages in dark themes and follows high-contrast themes; Dark also inverts photos.', 'seg', { options: [['auto', 'Auto'], ['original', 'Original'], ['dark', 'Dark'], ['sepia', 'Sepia']] }),
      field('pdfViewer.sidebar', 'Sidebar on open', 'Hidden anyway while the viewer is narrower than 640 px.', 'select', { options: [['auto', 'Auto', 'outline if present, else thumbnails'], ['outline', 'Outline'], ['thumbnails', 'Pages'], ['hidden', 'Hidden']] }),
      field('pdfViewer.defaultZoom', 'Default zoom', 'Files you have read before reopen at their last page and zoom.', 'select', { options: [['auto', 'Auto'], ['page-width', 'Page width'], ['page-fit', 'Whole page'], ['page-actual', 'Actual size']] }),
      field('pdfViewer.rangeThresholdMB', 'Load page by page above', 'Larger files load on demand instead of all at once.', 'number', { min: 1, max: 2048, unit: 'MB' }),
      field('pdfViewer.maxFileSizeMB', 'Ask before opening PDFs larger than', '', 'number', { min: 1, max: 10240, unit: 'MB', after: pdf })
    ));
    sec.appendChild(el('h2', 'sub', 'PDFs the agent reads'));
    sec.appendChild(card(
      field('pdf.maxReadSizeMB', 'Largest PDF the agent may read', 'Applies to <code>read_pdf</code>, <code>read_file</code> and PDFs attached to a chat.', 'number', { min: 1, max: 2048, unit: 'MB' }),
      field('pdf.maxChars', 'Most text per read (characters)', 'Still capped by <a data-sec="agent">Max tool output</a> (Agent &amp; approvals).', 'number', { min: 1000, max: 1000000, step: 1000 })
    ));
    sec.querySelectorAll('a[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }

  // ------------------------------------------------------------------ memory & skills
  function fmtBytes(b) { return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`; }
  function fmtAgo(ts) { const d = Date.now() - ts; if (d < 60e3) { return 'just now'; } if (d < 3600e3) { return `${Math.floor(d / 60e3)} min ago`; } if (d < 86400e3) { return `${Math.floor(d / 3600e3)} h ago`; } return `${Math.floor(d / 86400e3)} d ago`; }
  function secMemory(sec) {
    const d = state.data;
    head(sec, 'Memory & history', 'What LocalPilot keeps on this machine: chat history for this workspace and durable notes the agent writes.');
    // ---- chat history (per-workspace storage) with retention
    const ss = d.sessions && typeof d.sessions === 'object' ? d.sessions : { count: Number(d.sessions) || 0, bytes: 0, messages: 0, running: 0, pinned: 0 };
    sec.appendChild(el('h2', 'sub', 'Chat history'));
    const hist = el('div', 'card');
    const kv = el('div', 'field wide');
    kv.innerHTML = `<dl class="kv store"><dt>Chats</dt><dd><b>${ss.count}</b>${ss.pinned ? ` · ${ss.pinned} pinned` : ''}${ss.running ? ` · <span class="badge on">${ss.running} running</span>` : ''}</dd><dt>Messages</dt><dd>${(ss.messages || 0).toLocaleString()}</dd><dt>On disk</dt><dd>${fmtBytes(ss.bytes + (ss.checkpointBytes || 0))}${ss.checkpointBytes ? ` <span class="muted" title="File snapshots and git objects only checkpoint refs keep (freed by git gc once the chats are deleted)">(checkpoints ${fmtBytes(ss.checkpointBytes)})</span>` : ''}${ss.oldest ? ` · oldest ${fmtAgo(ss.oldest)}` : ''}</dd>${ss.inMemory !== undefined ? `<dt>In memory</dt><dd>${ss.inMemory} of ${ss.count} transcript${ss.count === 1 ? '' : 's'} — the rest are read from disk when opened</dd>` : ''}<dt>Where</dt><dd>VS Code workspace storage for this folder — never leaves this machine.</dd></dl>`;
    hist.appendChild(kv);
    const retention = field('sessions.retention', 'Keep at most', 'Oldest idle chats are removed automatically when a new chat starts. Pinned and running chats never count. <code>0</code> keeps everything.', 'number', { min: 0, max: 1000, step: 5 });
    hist.appendChild(retention);
    hist.appendChild(field('storage.sessionsInMemory', 'Transcripts in memory', 'Full chat transcripts kept in RAM (running chats and the one on screen always are). Older chats stay in the list and load from disk when you open or search them — lower this to save memory with long histories.', 'number', { min: 2, max: 500, step: 1 }));
    hist.appendChild(field('history.includeCli', 'Include chats from the terminal CLI', 'Chats started with the <code>localpilot</code> CLI in this folder appear in history marked <b>CLI</b> (read from <code>~/.localpilot/workspaces/</code>). Takes effect after a window reload.', 'toggle'));
    const acts = el('div', 'btnrow');
    acts.innerHTML = `<span class="muted small">Clearing removes idle chats only; running agents keep going and pinned chats can be kept.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.showSessions">${I.chat}Browse chats</button><button class="btn sm danger" data-cmd="localpilot.clearHistory" ${ss.count ? '' : 'disabled'}>${I.trash}Clear chat history…</button>`;
    hist.appendChild(acts);
    sec.appendChild(hist);
    // ---- memory notes
    sec.appendChild(el('h2', 'sub', 'Memory notes'));
    const mem = el('div', 'btnrow');
    mem.innerHTML = `<span class="muted small">${plural(d.memory.project, 'project note')} · ${plural(d.memory.global, 'global note')}</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.openMemory">${I.book}Open folder</button><button class="btn sm danger" data-cmd="localpilot.clearMemory" ${d.memory.project + d.memory.global ? '' : 'disabled'}>${I.trash}Clear…</button>`;
    sec.appendChild(card(
      field('memory.enabled', 'Enable memory', 'The agent can <code>memory_save</code> / <code>memory_read</code> notes in <code>.localpilot/memory/</code> (project, commit-able) and in global storage. A compact index is added to every prompt.', 'toggle', { after: mem }),
      memAutoSave(),
      field('memory.maxNoteChars', 'Largest note', 'Characters per note. When a note grows past it, its oldest paragraphs are dropped (a leading heading is kept).', 'number', { min: 500, max: 100000, step: 500 }),
      field('memory.maxNotes', 'Notes per scope', 'Project and global each. Past it, the least recently updated notes are deleted (<code>README</code> is kept).', 'number', { min: 5, max: 2000, step: 5 })
    ));
    const notes = Array.isArray(d.memory.notes) ? d.memory.notes : [];
    if (notes.length) {
      const t = el('table', 'tbl notes', `<thead><tr><th>Note</th><th>Summary</th><th>Scope</th><th>Updated</th><th></th></tr></thead><tbody>${notes.map((n) => `<tr data-name="${esc(n.name)}" data-scope="${esc(n.scope)}"><td class="mono"><a data-open title="Open ${esc(n.name)}.md">${esc(n.name)}</a></td><td class="muted">${esc(n.summary || '')}<span class="muted small"> · ${(n.chars / 1024).toFixed(1)} KB</span></td><td><span class="badge">${esc(n.scope)}</span></td><td class="muted small">${fmtAgo(n.updatedAt)}</td><td><button class="btn ghost sm danger" data-del title="Delete note">${I.trash}</button></td></tr>`).join('')}</tbody>`);
      t.onclick = (e) => {
        const tr = e.target.closest('tr[data-name]'); if (!tr) { return; }
        if (e.target.closest('[data-del]')) { const b = e.target.closest('[data-del]'); if (b.dataset.armed) { post({ type: 'deleteNote', name: tr.dataset.name, scope: tr.dataset.scope }); tr.classList.add('busy'); } else { b.dataset.armed = '1'; b.innerHTML = 'Delete?'; b.classList.add('armed'); setTimeout(() => { delete b.dataset.armed; b.innerHTML = I.trash; b.classList.remove('armed'); }, 2500); } return; }
        if (e.target.closest('[data-open]')) { post({ type: 'openNote', name: tr.dataset.name, scope: tr.dataset.scope }); }
      };
      const wrap = el('div', 'card tblwrap'); wrap.appendChild(t); sec.appendChild(wrap);
    } else {
      sec.appendChild(el('p', 'empty', 'No notes yet. The agent saves notes with <code>memory_save</code> when it learns something worth keeping (conventions, decisions, gotchas).'));
    }
    sec.appendChild(el('p', 'muted small', `Skills and subagents moved to their own page: <a data-sec="skills">Skills &amp; subagents</a>.`));
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
  }

  // ------------------------------------------------------------------ skills & subagents
  const SOURCE_LABEL = { builtin: 'built-in', workspace: 'workspace', user: 'user', managed: 'organization' };
  /** A skill the organisation requires: its switch is locked on. */
  const lockAlwaysOn = (tg, s) => { if (s.alwaysEnabled) { tg.disabled = true; tg.title = `${MANAGED_TIP} — always on`; tg.insertAdjacentHTML('afterend', lockIcon('Always on: required by your organization')); } };
  const SKILL_MODE_DESC = {
    auto: 'A registry skill that matches a request better than anything installed is installed as the request starts and loaded into it.',
    ask: 'A matching registry skill is offered as an “Install” chip; nothing is downloaded until you click it.',
    off: 'The registry is never consulted for a request. Installed skills are still matched and loaded.',
  };
  function skillSearch(q) {
    state.skillReg.q = q; state.skillReg.loading = true;
    post({ type: 'skillSearch', q });
  }
  function secSkills(sec) {
    const d = state.data;
    head(sec, 'Skills & subagents', 'Playbooks (<code>SKILL.md</code>) the agent loads when a request matches.');
    const mode = val('skills.autoInstall') || 'auto';

    // ---- how skills are used
    sec.appendChild(el('h2', 'sub', 'How skills are used'));
    sec.appendChild(card(
      field('skills.autoInstall', 'Registry skills', `${esc(SKILL_MODE_DESC[mode] || '')} Each chat can override this with the <b>Skills</b> button under its composer — there, <b>Off</b> also silences skill suggestions for that chat — and pin skills to every request.`, 'seg', { options: [['auto', 'Auto'], ['ask', 'Ask'], ['off', 'Off']] }),
      field('skills.autoInstallScope', 'Install into', 'Where skills installed from the registry go: your home folder (every workspace) or the current project (shared with the team through <code>.localpilot/skills</code>).', 'seg', { options: [['user', '~/.localpilot/skills'], ['workspace', '.localpilot/skills']] }),
      field('skills.builtin', 'Built-in skills', 'Playbooks that ship with LocalPilot: <code>requirements</code>, <code>design</code>, <code>new-project</code>, <code>implement</code>, <code>test</code>, <code>debug</code>, <code>review</code>, <code>refactor</code>, <code>ui-design</code>, <code>docs</code>, <code>deploy</code>, <code>ship</code>… A workspace or user skill with the same name overrides the bundled one.', 'toggle')
    ));
    sec.appendChild(el('p', 'muted small', 'What the model sees: the names and one-line descriptions of enabled skills, a rule to use only those names, and — for strong matches, pinned skills and <code>/skill</code> — the full instructions placed directly in the request, so it never has to guess what a skill says.'));

    // ---- installed
    const skills = d.skills || [];
    const enabledCount = skills.filter((s) => !s.disabled).length;
    sec.appendChild(el('h2', 'sub', `Installed skills<span class="count">${enabledCount} enabled · ${skills.length} total</span>`));
    const inst = el('div', 'card'); inst.dataset.deps = 'skills.disabled';
    if (!skills.length) {
      inst.appendChild(el('div', 'empty', 'No skills installed. Search the registry below, or create <code>.localpilot/skills/&lt;name&gt;/SKILL.md</code> in your project.'));
    }
    const q = (state.skillFilter || '').toLowerCase();
    if (skills.length > 8) {
      const f = el('div', 'gal-search sk-filter', I.search);
      const i = el('input'); i.type = 'search'; i.placeholder = 'Filter installed skills…'; i.value = state.skillFilter || ''; i.id = 'sk-filter';
      i.oninput = debounce(() => { state.skillFilter = i.value; render(); }, 200);
      if (document.activeElement && document.activeElement.id === 'sk-filter') { requestAnimationFrame(() => { const n = app.querySelector('#sk-filter'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }
      f.appendChild(i); inst.appendChild(f);
    }
    const sorted = [...skills].sort((a, b) => (a.disabled ? 1 : 0) - (b.disabled ? 1 : 0) || (b.used || 0) - (a.used || 0) || a.name.localeCompare(b.name));
    for (const s of sorted) {
      if (q && !`${s.name} ${s.description}`.toLowerCase().includes(q)) { continue; }
      const row = el('div', `mrow sk ${s.disabled ? 'off' : ''}`);
      const tg = el('button', `toggle ${s.disabled ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.title = s.disabled ? 'Enable: the agent can see and load this skill' : 'Disable: hidden from the agent, stays on disk';
      tg.onclick = () => { tg.classList.toggle('on'); post({ type: 'toggleSkill', name: s.name, enabled: !!s.disabled }); };
      row.appendChild(tg); lockAlwaysOn(tg, s);
      row.appendChild(el('span', 'ic brand-mark sk-ic', I.book));
      row.appendChild(el('div', 't', `<b title="${esc(s.dir || '')}">${esc(s.name)}</b><span>${esc(s.description || '')}</span>`));
      const right = el('div', 'mrow-right');
      const tags = el('div', 'tags');
      tags.innerHTML = `<span class="badge">${esc(SOURCE_LABEL[s.source] || s.source)}</span>${s.used ? `<span class="badge" title="Times the agent loaded this skill">used ${s.used}×</span>` : ''}${s.disabled ? '<span class="badge warn">disabled</span>' : ''}`;
      right.appendChild(tags);
      const acts = el('div', 'acts');
      const open = el('button', 'btn ghost sm', I.external); open.title = 'Open SKILL.md'; open.onclick = () => post({ type: 'openSkill', name: s.name }); acts.appendChild(open);
      if (s.removable) {
        const del = el('button', 'btn ghost sm danger', I.trash); del.title = 'Delete this skill from disk'; del.onclick = () => post({ type: 'removeSkill', name: s.name }); acts.appendChild(del);
      }
      right.appendChild(acts);
      row.appendChild(right);
      inst.appendChild(row);
    }
    sec.appendChild(inst);
    const recurring = (d.learning && d.learning.recurring) || [];
    if (recurring.length) {
      sec.appendChild(el('h2', 'sub', `Suggested skills (${recurring.length})`));
      const box = el('div', 'card');
      box.appendChild(el('div', 'desc', 'Kinds of request that have come up repeatedly with no skill covering them. Creating a skill captures the procedure that worked so the agent follows it every time; it is written to <code>.localpilot/skills/&lt;name&gt;/SKILL.md</code> for you to review.'));
      const ul = el('ul', 'list');
      for (const r of recurring) {
        const li = el('li', '', `<div><code>${esc(r.slug)}</code> <span class="muted small">· ${r.count}× — e.g. ${esc((r.samples || []).slice(-2).map((x) => `“${x}”`).join(', '))}</span></div><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.createSkill" data-args='${esc(JSON.stringify([r]))}'>${I.plus}Create skill</button><button class="reset x" title="Not now" data-cmd="localpilot.dismissSkillTopic" data-args='${esc(JSON.stringify([r.topic]))}'>${I.x}</button>`);
        ul.appendChild(li);
      }
      box.appendChild(ul); sec.appendChild(box);
    }

    // ---- registry
    sec.appendChild(el('h2', 'sub', 'Skill registry'));
    const reg = state.skillReg;
    const tools = el('div', 'gal-tools');
    const search = el('div', 'gal-search', I.search);
    const sq = el('input'); sq.type = 'search'; sq.id = 'sk-q'; sq.placeholder = 'Search the registry — e.g. pdf, release, azure, design doc, debugging…'; sq.value = reg.q; sq.setAttribute('aria-label', 'Search skills');
    if (document.activeElement && document.activeElement.id === 'sk-q') { requestAnimationFrame(() => { const n = app.querySelector('#sk-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }
    sq.oninput = debounce(() => { if (sq.value.trim() === reg.q) { return; } skillSearch(sq.value.trim()); renderSkillRegistry(); }, 300);
    sq.onkeydown = (e) => { if (e.key === 'Enter') { skillSearch(sq.value.trim()); renderSkillRegistry(); } };
    search.appendChild(sq); tools.appendChild(search);
    const chips = el('div', 'chips');
    for (const [k, l] of [['all', 'All'], ['new', 'Not installed'], ['installed', 'Installed']]) { const b = el('button', `chip ${reg.filter === k ? 'on' : ''}`, l); b.onclick = () => { reg.filter = k; renderSkillRegistry(); }; chips.appendChild(b); }
    const scopeSel = el('select'); scopeSel.setAttribute('aria-label', 'Install into');
    for (const [k, l] of [['user', 'Install to ~/.localpilot/skills'], ['workspace', 'Install to .localpilot/skills']]) { const o = el('option'); o.value = k; o.textContent = l; o.selected = (reg.scope || val('skills.autoInstallScope') || 'user') === k; scopeSel.appendChild(o); }
    scopeSel.onchange = () => { reg.scope = scopeSel.value; };
    chips.appendChild(scopeSel);
    tools.appendChild(chips);
    sec.appendChild(tools);
    const results = el('div', 'gal-results'); results.id = 'sk-results';
    sec.appendChild(results);
    if (!reg.loaded) { reg.loaded = true; skillSearch(reg.q); }
    renderSkillRegistry(results);

    // ---- repositories
    const rcard = el('div', 'card');
    const cur = () => (Array.isArray(val('skills.repositories')) ? val('skills.repositories') : []);
    const repoField = () => {
      const rf = el('div', 'field wide');
      rf.innerHTML = `<div><div class="lbl">Repositories${scopeBadge('skills.repositories')}${resetBtn('skills.repositories')}</div><div class="desc">GitHub repositories or folders in the <a href="https://agentskills.io">Agent Skills</a> format (<code>owner/repo/path[@ref]</code>). The registry above is their combined index, cached for a day; the first repository wins when several offer the same skill name. Set <code>GITHUB_TOKEN</code> for private repositories or higher rate limits.</div></div>`;
      const rctl = el('div', 'ctl');
      const rul = el('ul', 'list');
      const status = new Map((reg.status || []).map((s) => [s.repo, s]));
      cur().forEach((p) => {
        const li = el('li', '', `<code>${esc(p)}</code><span class="muted small sk-st" data-repo="${esc(p)}"> · ${repoStatusText(status.get(p))}</span><span class="spacer"></span><button class="reset x" title="Remove">${I.x}</button>`);
        li.querySelector('button').onclick = () => set('skills.repositories', cur().filter((x) => x !== p));
        rul.appendChild(li);
      });
      const raddRow = el('div', 'row', `<input type="text" placeholder="owner/repo/skills" aria-label="Skill repository to add (owner/repo/path)"><button class="btn sm">${I.plus}Add</button>`);
      const input = raddRow.querySelector('input');
      raddRow.querySelector('button').onclick = () => { const v = input.value.trim(); if (v) { set('skills.repositories', [...cur().filter((x) => x !== v), v]); input.value = ''; } };
      rctl.appendChild(rul); rctl.appendChild(raddRow); rf.appendChild(rctl);
      return component(rf, ['skills.repositories'], repoField);
    };
    rcard.appendChild(repoField());
    const rbar = el('div', 'btnrow');
    rbar.innerHTML = `<span class="muted small">Index cached in <code>~/.localpilot/skill-catalog.json</code>.</span><span class="spacer"></span><button class="btn sm" id="sk-refresh" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span>' : I.refresh}Re-index now</button><button class="btn sm" data-cmd="localpilot.installSkill" title="From a GitHub repository (owner/repo or a folder in it), a URL to a SKILL.md, or a local folder">${I.download}Install from URL or folder…</button>`;
    rbar.querySelector('#sk-refresh').onclick = () => { state.busy = true; render(); post({ type: 'refreshSkillRegistry' }); };
    rcard.appendChild(rbar);
    sec.appendChild(rcard);

    // ---- skill and plugin folders
    sec.appendChild(el('h2', 'sub', 'Skill & plugin folders'));
    sec.appendChild(card(
      listEditor('skillsPaths', 'Extra skill folders', '<code>.localpilot/skills</code>, <code>.claude/skills</code>, <code>.github/skills</code> and <code>~/.agents/skills</code> are scanned automatically. Add more folders here (each skill is a folder with <code>SKILL.md</code>).', { placeholder: '/path/to/skills or ~/skills', browse: true }),
      listEditor('pluginPaths', 'Extra plugin folders', 'Claude Code-style plugins (<code>.claude-plugin/plugin.json</code> bundling commands, agents, skills, hooks and <code>.mcp.json</code>). <code>.localpilot/plugins</code>, <code>.claude/plugins</code> and the same folders in your home are scanned automatically.', { placeholder: '/path/to/plugins', browse: true })
    ));

    // ---- subagents
    const agents = d.agents || [];
    sec.appendChild(el('h2', 'sub', `Subagents (${agents.length})`));
    if (!agents.length) {
      sec.appendChild(el('div', 'empty', 'No subagents found. Create <code>.localpilot/agents/&lt;name&gt;.md</code> with a description and system prompt.'));
    } else {
      const t = el('table', 'tbl', `<thead><tr><th>Name</th><th>Description</th><th>Source</th></tr></thead><tbody>${agents.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td>${esc(r.description)}</td><td><span class="badge">${esc(SOURCE_LABEL[r.source] || r.source)}</span></td></tr>`).join('')}</tbody>`);
      sec.appendChild(card(t));
    }
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" data-cmd="localpilot.reloadSkills">${I.refresh}Reload skills, subagents & MCP</button>`;
    sec.appendChild(bar);
  }
  // ------------------------------------------------------------------ customize (rules, commands, hooks, skills)
  const CUSTOM_TABS = [
    ['rule', 'Rules', 'Instruction files added to every prompt: <code>AGENTS.md</code>, <code>CLAUDE.md</code>, <code>.cursorrules</code>, <code>.clinerules</code> and the rule folders (<code>.localpilot/rules/</code>, <code>.cursor/rules/</code>, <code>.claude/rules/</code>, <code>.cline/rules/</code>). Switching one off writes <code>disabled: true</code> into its front matter; <code>paths:</code> or <code>globs:</code> there make a rule apply only while a matching file is in context.'],
    ['command', 'Commands', 'Slash commands from <code>.localpilot/commands/</code> and <code>.claude/commands/</code> (and the same folders in your home). Switching one off writes <code>disabled: true</code> into its front matter.'],
    ['hook', 'Hooks', 'Scripts named after their event (<code>PreToolUse.sh</code>, <code>TaskStart.py</code>…) in <code>.localpilot/hooks/</code>, <code>.clinerules/hooks/</code>, <code>.cline/hooks/</code> and the same folders in your home, plus the hooks configured in <code>settings.json</code> (open the file to change those). A script runs while it is switched on (executable).'],
    ['skill', 'Skills', 'Playbooks the agent loads when a request matches. Install more from the registry in <b>Skills &amp; subagents</b>.'],
    ['plugin', 'Plugins', 'Installed plugins (Claude Code format) and what they add. Switching one off writes <code>enabledPlugins</code> in <code>.localpilot/settings.json</code>.'],
  ];
  function secCustomize(sec) {
    const c = state.custom || (state.custom = { tab: 'rule', data: null, loading: 0, scope: '' });
    head(sec, 'Customize', 'The rules, commands, hooks, skills and plugins in this workspace and in your home folder: switch them on or off, open, delete or create them.');
    // Files change outside the panel too: re-list when the section is shown again after a while.
    if ((!c.loading || Date.now() - c.loading > 10000) && (!c.data || Date.now() - (c.at || 0) > 5000)) { c.loading = Date.now(); post({ type: 'loadCustomize' }); }
    const d = c.data;
    const skills = (state.data && state.data.skills) || [];
    const count = { rule: d ? d.rules.length : 0, command: d ? d.commands.length : 0, hook: d ? d.hooks.length : 0, skill: skills.length, plugin: d && d.plugins ? d.plugins.length : 0 };
    const tabs = el('div', 'chips cz-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [k, label] of CUSTOM_TABS) {
      const b = el('button', `chip ${c.tab === k ? 'on' : ''}`, `${esc(label)} <i>${count[k]}</i>`); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(c.tab === k));
      b.onclick = () => { c.tab = k; render(); };
      tabs.appendChild(b);
    }
    sec.appendChild(tabs);
    const tab = CUSTOM_TABS.find(([k]) => k === c.tab) || CUSTOM_TABS[0];
    sec.appendChild(el('p', 'muted small', tab[2]));
    if (c.tab === 'skill') { customSkills(sec, skills); return; }
    if (c.tab === 'plugin') {
      const bar = el('div', 'btnrow cz-plugin-acts');
      bar.innerHTML = `<button class="btn sm primary" data-cmd="localpilot.browsePlugins" title="Search the plugin marketplaces below and install">${I.search}Browse plugins…</button><button class="btn sm" data-cmd="localpilot.managePlugins" title="Update, switch off or uninstall installed plugins">${I.gear}Manage…</button>`;
      sec.appendChild(bar);
    }
    if (!d) { sec.appendChild(skeleton('Looking for rules, commands, hooks and plugins…', 3)); return; }
    if (c.tab === 'hook') { sec.appendChild(card(field('hooks.enabled', 'Run hooks', 'Turn off for a repository you do not trust: no hook (settings or script) runs.', 'toggle'))); }
    const kind = c.tab; const noun = { rule: 'rule', command: 'command', hook: 'hook', plugin: 'plugin' }[kind];
    const scope = c.scope || (d.hasWorkspace ? 'workspace' : 'global');
    const add = el('div', 'row cz-new');
    // A new hook is a template for an event that has no hook yet.
    const nameField = kind === 'hook' ? `<select id="cz-name" aria-label="Event of the new hook"><option value="">New hook… (pick an event)</option>${(d.events || []).map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}</select>` : `<input type="text" id="cz-name" placeholder="New ${noun}… (e.g. ${kind === 'rule' ? 'testing' : 'review'})" aria-label="Name of the new ${noun}">`;
    add.innerHTML = `${nameField}<select aria-label="Create in">${d.hasWorkspace ? `<option value="workspace"${scope === 'workspace' ? ' selected' : ''}>.localpilot/${kind}s</option>` : ''}<option value="global"${scope === 'global' ? ' selected' : ''}>~/.localpilot/${kind}s</option></select><button class="btn sm">${I.plus}Create</button>`;
    const input = add.querySelector('#cz-name'); const sel = add.querySelector('select[aria-label="Create in"]');
    sel.onchange = () => { c.scope = sel.value; };
    const create = () => { const name = input.value.trim(); if (!name) { input.focus(); return; } if (!/^[\w][\w .-]*$/.test(name) || name.includes('..')) { toast('Use letters, digits, spaces, "-", "_" and "." only (no folders).', 'error'); return; } post({ type: 'customCreate', kind, name, scope: sel.value }); input.value = ''; };
    add.querySelector('button').onclick = create;
    input.onkeydown = (e) => { if (e.key === 'Enter') { create(); } };
    // ---- new item (plugins are installed, not created)
    if (kind === 'hook' && !(d.events || []).length) { sec.appendChild(el('p', 'muted small', 'Every event has a hook already.')); } else if (kind !== 'plugin') { sec.appendChild(add); }
    // ---- lists, workspace first
    const items = kind === 'rule' ? d.rules : kind === 'command' ? d.commands : kind === 'plugin' ? (d.plugins || []) : d.hooks;
    for (const [sc, title] of [['workspace', 'Workspace'], ['global', 'Global']]) {
      const group = items.filter((i) => i.scope === sc);
      sec.appendChild(el('h2', 'sub', `${title}<span class="count">${group.length}</span>`));
      const box = el('div', 'card');
      if (!group.length) { box.appendChild(el('div', 'empty', sc === 'workspace' && !d.hasWorkspace ? 'Open a folder to see its items.' : `No ${noun}s here.`)); }
      for (const it of group) { box.appendChild(customRow(it, d)); }
      sec.appendChild(box);
    }
    if (kind === 'plugin') {
      sec.appendChild(el('h2', 'sub', 'Marketplaces'));
      sec.appendChild(card(listEditor('plugins.marketplaces', 'Plugin marketplaces', '<code>owner/repo</code> on GitHub, any git URL or a local folder with <code>.claude-plugin/marketplace.json</code>. Fetched with git, so private repos use your git credentials.', {
        placeholder: 'owner/repo, git URL or folder', validate: /^([\w.-]+\/[\w.-]+|https?:\/\/\S+|git@\S+|[~\/.].*)$/, invalidHint: 'Use owner/repo, an https:// or git@ URL, or a folder path — not added', browse: true,
      })));
    }
  }
  function customRow(it, d) {
    const row = el('div', `mrow sk ${it.disabled ? 'off' : ''}`);
    const switchable = it.editable && !it.fromSettings && (it.kind !== 'hook' || d.canSwitchHooks);
    if (switchable) {
      const tg = el('button', `toggle ${it.disabled ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.setAttribute('aria-checked', String(!it.disabled)); tg.setAttribute('aria-label', `${it.disabled ? 'Enable' : 'Disable'} ${it.name}`);
      tg.title = it.disabled ? 'Enable: the agent sees it again' : 'Disable: hidden from the agent, stays on disk';
      tg.onclick = () => { tg.classList.toggle('on'); post({ type: 'customToggle', kind: it.kind, file: it.file, enabled: !!it.disabled }); };
      row.appendChild(tg);
    }
    row.appendChild(el('span', 'ic brand-mark sk-ic', it.kind === 'hook' ? I.bolt : it.kind === 'command' ? I.chat : it.kind === 'plugin' ? I.plug : I.file));
    const sub = it.detail ? `<code>${esc(it.detail)}</code>` : esc(it.description || '');
    row.appendChild(el('div', 't', `<b title="${esc(it.file)}">${esc(it.name)}</b><span>${esc(it.label)}${sub ? ` · ${sub}` : ''}</span>`));
    const right = el('div', 'mrow-right');
    const tags = [];
    if (it.paths) { tags.push(`<span class="badge" title="Applies only while a file matching ${esc(it.paths.join(', ') || '(nothing)')} is in context">${it.paths.length ? `when ${esc(it.paths.slice(0, 2).join(', '))}${it.paths.length > 2 ? '…' : ''}` : 'never applies'}</span>`); }
    if (it.fromSettings) { tags.push('<span class="badge">settings.json</span>'); }
    if (it.notRun) { tags.push('<span class="badge warn" title="Hook scripts are named after the event they hook (PreToolUse.sh, TaskStart.py…): this one never runs">not an event</span>'); }
    if (it.version) { tags.push(`<span class="badge">${esc(it.version)}</span>`); }
    if (it.managed) { tags.push(`<span class="badge" title="From your organization's folder next to managed-settings.json">organization</span>`); }
    if (it.alwaysEnabled) { tags.push(lockIcon('Always on: it cannot be switched off')); }
    if (!it.editable && !it.fromSettings && !it.managed && !it.alwaysEnabled) { tags.push('<span class="badge" title="From a parent folder of the workspace: change it there">parent folder</span>'); }
    if (it.disabled) { tags.push('<span class="badge warn">disabled</span>'); }
    right.appendChild(el('div', 'tags', tags.join('')));
    const acts = el('div', 'acts');
    const open = el('button', 'btn ghost sm', I.external); open.title = it.fromSettings ? 'Open the settings file' : it.kind === 'plugin' ? 'Open the plugin manifest' : 'Open in editor'; open.setAttribute('aria-label', `Open ${it.name}`); open.onclick = () => post({ type: 'customOpen', kind: it.kind, file: it.file }); acts.appendChild(open);
    if (it.editable && !it.fromSettings && (it.kind !== 'plugin' || it.removable)) {
      const del = el('button', 'btn ghost sm danger', I.trash); del.title = 'Delete from disk (asks first)'; del.setAttribute('aria-label', `Delete ${it.name}`); del.onclick = () => post({ type: 'customDelete', kind: it.kind, file: it.file }); acts.appendChild(del);
    }
    right.appendChild(acts);
    row.appendChild(right);
    return row;
  }
  function customSkills(sec, skills) {
    for (const [sc, title, match] of [['workspace', 'Workspace', (s) => s.source === 'workspace'], ['global', 'Global', (s) => s.source !== 'workspace']]) {
      const group = skills.filter(match).sort((a, b) => a.name.localeCompare(b.name));
      sec.appendChild(el('h2', 'sub', `${title}<span class="count">${group.length}</span>`));
      const box = el('div', 'card'); box.dataset.deps = 'skills.disabled';
      if (!group.length) { box.appendChild(el('div', 'empty', sc === 'workspace' ? 'No workspace skills. Create <code>.localpilot/skills/&lt;name&gt;/SKILL.md</code>.' : 'No user or built-in skills.')); }
      for (const s of group) {
        const row = el('div', `mrow sk ${s.disabled ? 'off' : ''}`);
        const tg = el('button', `toggle ${s.disabled ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.setAttribute('aria-checked', String(!s.disabled)); tg.setAttribute('aria-label', `${s.disabled ? 'Enable' : 'Disable'} ${s.name}`);
        tg.onclick = () => { tg.classList.toggle('on'); post({ type: 'toggleSkill', name: s.name, enabled: !!s.disabled }); };
        row.appendChild(tg); lockAlwaysOn(tg, s);
        row.appendChild(el('span', 'ic brand-mark sk-ic', I.book));
        row.appendChild(el('div', 't', `<b title="${esc(s.dir || '')}">${esc(s.name)}</b><span>${esc(s.description || '')}</span>`));
        const right = el('div', 'mrow-right');
        right.appendChild(el('div', 'tags', `<span class="badge">${esc(SOURCE_LABEL[s.source] || s.source)}</span>${s.disabled ? '<span class="badge warn">disabled</span>' : ''}`));
        const acts = el('div', 'acts');
        const open = el('button', 'btn ghost sm', I.external); open.title = 'Open SKILL.md'; open.onclick = () => post({ type: 'openSkill', name: s.name }); acts.appendChild(open);
        if (s.removable) { const del = el('button', 'btn ghost sm danger', I.trash); del.title = 'Delete this skill from disk (asks first)'; del.onclick = () => post({ type: 'removeSkill', name: s.name }); acts.appendChild(del); }
        right.appendChild(acts); row.appendChild(right); box.appendChild(row);
      }
      sec.appendChild(box);
    }
  }
  const repoStatusText = (st) => (st ?(st.error ? `<span class="badge err" title="${esc(st.error)}">error</span> ${esc(st.error)}` : `${st.skills} skill${st.skills === 1 ? '' : 's'}${st.fetched ? ` · indexed ${fmtAgo(st.fetched)}` : ''}`) : 'not indexed yet');
  /** Refreshes the per-repository index status in place (the list itself is rebuilt only when the setting changes). */
  function renderSkillRepoStatus() {
    const status = new Map((state.skillReg.status || []).map((s) => [s.repo, s]));
    app.querySelectorAll('.sk-st[data-repo]').forEach((n) => { n.innerHTML = ` · ${repoStatusText(status.get(n.dataset.repo))}`; });
  }
  /** Rebuilds only the registry result list, so typing in the search box is never interrupted by a response. */
  function renderSkillRegistry(container) {
    const box = container || app.querySelector('#sk-results');
    if (!box) { return; }
    box.innerHTML = '';
    const reg = state.skillReg;
    const scope = reg.scope || val('skills.autoInstallScope') || 'user';
    if (reg.loading && !reg.entries.length) { box.appendChild(skeleton(reg.refreshing ? 'Indexing the skill repositories for the first time…' : 'Searching the registry…', 4)); return; }
    let rows = reg.entries;
    if (reg.filter === 'new') { rows = rows.filter((e) => !e.installed); } else if (reg.filter === 'installed') { rows = rows.filter((e) => e.installed); }
    if (!rows.length) {
      const anyErr = (reg.status || []).find((s) => s.error);
      box.appendChild(el('div', 'empty', reg.entries.length ? 'Nothing matches that filter.' : reg.q ? `No registry skill matches “${esc(reg.q)}”. Try other words, or install one from a URL below.` : anyErr ? `The registry could not be indexed: ${esc(anyErr.error)}` : 'The registry is empty — add a repository below.'));
      return;
    }
    box.appendChild(el('div', 'gal-count', `${rows.length} skill${rows.length === 1 ? '' : 's'}${reg.q ? ` for “${esc(reg.q)}”` : ''}${reg.refreshing ? ' · index refreshing…' : ''}`));
    const list = el('div', 'card');
    for (const e of rows.slice(0, 60)) {
      const row = el('div', `mrow sk ${e.installed ? 'have' : ''}`);
      row.appendChild(el('span', 'ic brand-mark sk-ic', I.book));
      row.appendChild(el('div', 't', `<b>${esc(e.name)}</b><span>${esc(e.description || '')}</span>`));
      const right = el('div', 'mrow-right');
      const tags = el('div', 'tags', `<span class="badge" title="${esc(e.repo)}/${esc(e.dir || '')}">${esc(e.repo.split('/').slice(0, 2).join('/'))}</span>${e.installed ? `<span class="badge ok">${I.check} installed${e.installedSource ? ` · ${esc(SOURCE_LABEL[e.installedSource] || e.installedSource)}` : ''}</span>` : ''}`);
      right.appendChild(tags);
      const acts = el('div', 'acts');
      const job = reg.jobs[e.name];
      if (job && job.status === 'running') {
        acts.appendChild(el('span', 'note', `<span class="spinner"></span> ${esc(job.detail || 'Installing…')}`));
      } else {
        const b = el('button', `btn sm ${e.installed ? '' : 'primary'}`, `${I.download}${e.installed ? 'Reinstall' : 'Install'}`);
        b.title = `Install “${e.name}” from ${e.repo} into ${scope === 'workspace' ? '.localpilot/skills' : '~/.localpilot/skills'}`;
        b.onclick = () => { reg.jobs[e.name] = { status: 'running', detail: 'Installing…' }; renderSkillRegistry(); post({ type: 'installRegistrySkill', name: e.name, repo: e.repo, scope }); };
        acts.appendChild(b);
        if (job && job.status === 'error') { acts.appendChild(el('span', 'note err', esc(job.detail || 'failed'))); }
      }
      right.appendChild(acts);
      row.appendChild(right);
      list.appendChild(row);
    }
    if (rows.length > 60) { list.appendChild(el('div', 'cat-more', `${rows.length - 60} more — narrow the search`)); }
    box.appendChild(list);
  }
  // ------------------------------------------------------------------ marketplace (skills, MCP servers, plugins, subagents)
  // One screen to find and install what extends the agent. It reuses the skill registry search (skillSearch), the MCP
  // catalog (mcpCatalog / installMcpCatalog) and loads the plugin marketplaces (pluginCatalog / installPlugin); subagents
  // come installed (built-in, yours, the workspace's) or with plugins, whose rows say how many they add.
  const MK_KINDS = [['all', 'All'], ['skill', 'Skills'], ['mcp', 'MCP servers'], ['plugin', 'Plugins'], ['agent', 'Subagents']];
  const MK_ALL_ROWS = 5;
  function mkState() { return state.market || (state.market = { kind: 'all', q: '', show: 'all', plugins: null, pluginErrors: [], configured: 0, loading: false, jobs: {} }); }
  const mkWords = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
  const mkMatch = (words, hay) => words.every((w) => hay.toLowerCase().includes(w));
  const mkShow = (installed) => { const s = mkState().show; return s === 'all' || (s === 'installed' ? installed : !installed); };
  /** Rows of each kind for the current search and filter. */
  function mkRows() {
    const mk = mkState(); const words = mkWords(mk.q);
    const reg = state.skillReg; const cat = mcpCatState();
    const haveMcp = new Set([...Object.keys(val('mcpServers') || {}), ...(state.data.mcp || []).map((s) => s.name)]);
    const skills = (reg.entries || []).filter((e) => mkShow(!!e.installed));
    const mcp = (cat.entries || []).filter((e) => mkShow(haveMcp.has(e.id)) && mkMatch(words, `${e.id} ${e.name} ${e.tagline || ''} ${(e.tags || []).join(' ')}`)).map((e) => ({ ...e, installed: haveMcp.has(e.id) }));
    const plugins = (mk.plugins || []).filter((p) => mkShow(!!p.installed) && mkMatch(words, `${p.name} ${p.description} ${p.category || ''} ${p.market}`));
    const agents = (state.data.agents || []).filter((a) => mkShow(true) && mkMatch(words, `${a.name} ${a.description}`)).map((a) => ({ ...a, kind: 'agent' }))
      .concat((mk.plugins || []).filter((p) => p.contains && p.contains.agents > 0 && !p.installed && mkShow(false) && mkMatch(words, `${p.name} ${p.description}`)).map((p) => ({ ...p, kind: 'plugin' })));
    return { skill: skills, mcp, plugin: plugins, agent: agents };
  }
  function secMarketplace(sec) {
    const mk = mkState(); const reg = state.skillReg; const cat = mcpCatState();
    head(sec, 'Marketplace', 'Find and install skills, MCP servers, plugins and subagents in one place. Each row says where it comes from and whether it is installed.');
    // First visit: the skill registry (cached for a day), the bundled MCP catalog and the plugin marketplaces (cached checkouts).
    if (!reg.loaded) { reg.loaded = true; skillSearch(mk.q); }
    if (!cat.loaded) { cat.loaded = true; cat.loading = true; post({ type: 'mcpCatalog' }); }
    if (!mk.plugins && !mk.loading) { mk.loading = true; post({ type: 'pluginCatalog' }); }
    const tools = el('div', 'gal-tools');
    const search = el('div', 'gal-search', I.search);
    const q = el('input'); q.type = 'search'; q.id = 'mk-q'; q.placeholder = 'Search the marketplace…'; q.value = mk.q; q.setAttribute('aria-label', 'Search the marketplace');
    if (document.activeElement && document.activeElement.id === 'mk-q') { requestAnimationFrame(() => { const n = app.querySelector('#mk-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }
    // The skill registry is searched on the host; the other kinds filter here.
    const skillQ = debounce(() => { if (reg.q !== mk.q) { skillSearch(mk.q); renderMarket(); } }, 300);
    q.oninput = () => { mk.q = q.value.trim(); renderMarket(); skillQ(); };
    search.appendChild(q); tools.appendChild(search);
    const chips = el('div', 'chips mk-kinds'); chips.setAttribute('role', 'tablist'); chips.setAttribute('aria-label', 'Kind');
    chips.id = 'mk-kinds';
    tools.appendChild(chips);
    const show = el('select'); show.setAttribute('aria-label', 'Show'); show.id = 'mk-show';
    for (const [k, l] of [['all', 'Installed and not'], ['new', 'Not installed'], ['installed', 'Installed']]) { const o = el('option'); o.value = k; o.textContent = l; o.selected = mk.show === k; show.appendChild(o); }
    show.onchange = () => { mk.show = show.value; renderMarket(); };
    chips.after(show);
    sec.appendChild(tools);
    const results = el('div', 'mk-results'); results.id = 'mk-results';
    sec.appendChild(results);
    renderMarket(results);
  }
  function renderMarketKinds(rows) {
    const box = app.querySelector('#mk-kinds'); if (!box) { return; }
    const mk = mkState();
    box.innerHTML = MK_KINDS.map(([k, l]) => { const n = k === 'all' ? '' : ` <i>${rows[k].length}</i>`; return `<button class="chip ${mk.kind === k ? 'on' : ''}" role="tab" aria-selected="${mk.kind === k}" data-k="${k}">${esc(l)}${n}</button>`; }).join('');
    box.onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) { return; } mk.kind = b.dataset.k; renderMarket(); };
  }
  /** Rebuilds only the result groups, so typing in the search box is never interrupted. */
  function renderMarket(container) {
    const box = container || app.querySelector('#mk-results'); if (!box) { return; }
    const mk = mkState(); const rows = mkRows();
    renderMarketKinds(rows);
    box.innerHTML = '';
    const kinds = mk.kind === 'all' ? ['skill', 'mcp', 'plugin', 'agent'] : [mk.kind];
    for (const k of kinds) { box.appendChild(mkGroup(k, rows[k], mk.kind === 'all')); }
  }
  function mkGroup(kind, rows, capped) {
    const mk = mkState(); const reg = state.skillReg; const cat = mcpCatState();
    const g = el('section', 'mk-group'); g.dataset.kind = kind;
    const title = { skill: 'Skills', mcp: 'MCP servers', plugin: 'Plugins', agent: 'Subagents' }[kind];
    const where = { skill: 'From the skill repositories in Skills & subagents', mcp: `The bundled catalog${cat.registry ? ' and the MCP registry' : ''}`, plugin: mk.configured ? `From ${mk.configured} plugin marketplace${mk.configured === 1 ? '' : 's'}` : 'No marketplace set up', agent: 'Installed subagents, and plugins that add some' }[kind];
    const manage = { skill: ['skills', 'Manage skills'], mcp: ['mcp', 'Manage servers'], plugin: ['customize', 'Manage plugins'], agent: ['skills', 'Manage subagents'] }[kind];
    const h = el('div', 'mk-head', `<h2 class="sub">${esc(title)}<span class="count">${rows.length}</span></h2><span class="muted small mk-where">${esc(where)}</span><span class="spacer"></span>`);
    if (kind === 'plugin' || kind === 'mcp') {
      const busy = kind === 'plugin' ? mk.loading : cat.loading;
      const r = el('button', 'btn sm ghost', `${busy ? '<span class="spinner"></span>' : I.refresh}<span>Refresh</span>`); r.disabled = busy;
      r.title = kind === 'plugin' ? 'Fetch the plugin marketplaces again (git)' : 'Fetch the server list from registry.modelcontextprotocol.io (only when you click)'; r.setAttribute('aria-label', `Refresh ${title}`);
      r.onclick = () => { if (kind === 'plugin') { mk.loading = true; post({ type: 'pluginCatalog', refresh: true }); } else { cat.loading = true; post({ type: 'mcpCatalog', refresh: true }); } renderMarket(); };
      h.appendChild(r);
    }
    const m = el('button', 'btn sm ghost', `${I.gear}<span>${esc(manage[1])}</span>`); m.title = `${manage[1]} (Settings → ${{ skills: 'Skills & subagents', mcp: 'MCP servers', customize: 'Customize → Plugins' }[manage[0]]})`; m.setAttribute('aria-label', manage[1]);
    m.onclick = () => { if (manage[0] === 'customize') { state.custom = { ...(state.custom || { data: null, loading: 0, scope: '' }), tab: 'plugin' }; } if (manage[0] === 'mcp') { mcpCatState().view = 'installed'; } state.section = manage[0]; render(); };
    h.appendChild(m);
    g.appendChild(h);
    const loading = kind === 'skill' ? reg.loading && !rows.length : kind === 'mcp' ? cat.loading && !rows.length : kind === 'plugin' ? mk.loading && !rows.length : false;
    if (loading) { g.appendChild(skeleton(kind === 'skill' ? 'Searching the skill registry…' : kind === 'mcp' ? 'Loading the MCP catalog…' : 'Loading the plugin marketplaces…', 2)); return g; }
    if (kind === 'plugin' && mk.pluginErrors.length) { g.appendChild(el('div', 'prov-result err mcp-err', `<span>${I.x} ${mk.pluginErrors.map((e) => `${esc(e.spec)}: ${esc(e.error)}`).join('<br>')}</span>`)); }
    if (!rows.length) {
      const words = mk.q ? ` for “${esc(mk.q)}”` : '';
      const none = { skill: reg.entries.length || mk.q ? `No skill${words}.` : 'The skill registry is empty: add a repository in Skills & subagents.', mcp: `No MCP server${words}.`, plugin: !mk.configured ? 'No plugin marketplace is set up. Add one (owner/repo on GitHub, a git URL or a folder) under <button class="inline-link" data-mk-plugins>Customize → Plugins</button>.' : `No plugin${words}.`, agent: `No subagent${words}.` }[kind];
      const empty = el('div', 'empty', mk.show !== 'all' && !mk.q ? `Nothing ${mk.show === 'installed' ? 'installed' : 'left to install'} here.` : none);
      const link = empty.querySelector('[data-mk-plugins]'); if (link) { link.onclick = () => m.onclick(); }
      g.appendChild(empty);
      return g;
    }
    const list = el('div', 'card');
    const shown = capped ? rows.slice(0, MK_ALL_ROWS) : rows.slice(0, 80);
    for (const r of shown) { list.appendChild(mkRow(kind, r)); }
    if (capped && rows.length > MK_ALL_ROWS) { const more = el('button', 'cat-more mk-more', `Show all ${rows.length} ${esc(title.toLowerCase())}`); more.onclick = () => { mk.kind = kind; renderMarket(); app.querySelector('#mk-results').scrollIntoView({ block: 'start' }); }; list.appendChild(more); }
    else if (!capped && rows.length > 80) { list.appendChild(el('div', 'cat-more', `${rows.length - 80} more: narrow the search`)); }
    g.appendChild(list);
    if (kind === 'agent') { g.appendChild(el('p', 'muted small', 'Subagents come with plugins, or write your own: <code>/agent new &lt;job&gt;</code> in the chat, or a file in <code>.localpilot/agents/</code>.')); }
    return g;
  }
  const mkScopeLabel = (s) => (s === 'workspace' ? 'this workspace' : 'for me');
  function mkRow(kind, e) {
    const mk = mkState();
    const installed = kind === 'agent' ? e.kind === 'agent' : !!e.installed;
    const row = el('div', `mrow sk mk-row ${installed ? 'have' : ''}`);
    const icon = kind === 'skill' ? I.book : kind === 'mcp' ? I.plug : kind === 'agent' && e.kind === 'agent' ? I.chip : I.gallery;
    row.appendChild(el('span', 'ic brand-mark sk-ic', icon));
    const desc = kind === 'mcp' ? e.tagline || '' : e.description || '';
    row.appendChild(el('div', 't', `<b>${esc(e.name)}</b><span>${esc(desc)}</span>`));
    const right = el('div', 'mrow-right'); const tags = []; const acts = el('div', 'acts');
    if (kind === 'skill') {
      tags.push(`<span class="badge" title="${esc(e.repo)}/${esc(e.dir || '')}">${esc(e.repo.split('/').slice(0, 2).join('/'))}</span>`);
      if (e.installed) { tags.push(`<span class="badge ok">${I.check} installed${e.installedSource ? ` · ${esc(SOURCE_LABEL[e.installedSource] || e.installedSource)}` : ''}</span>`); }
      const job = state.skillReg.jobs[e.name];
      if (job && job.status === 'running') { acts.appendChild(el('span', 'note', `<span class="spinner"></span> ${esc(job.detail || 'Installing…')}`)); }
      else {
        const scope = state.skillReg.scope || val('skills.autoInstallScope') || 'user';
        const b = el('button', `btn sm ${e.installed ? '' : 'primary'}`, `${I.download}${e.installed ? 'Reinstall' : 'Install'}`);
        b.title = `Install “${e.name}” from ${e.repo} into ${scope === 'workspace' ? '.localpilot/skills' : '~/.localpilot/skills'}`; b.setAttribute('aria-label', `${e.installed ? 'Reinstall' : 'Install'} skill ${e.name}`);
        b.onclick = () => { state.skillReg.jobs[e.name] = { status: 'running', detail: 'Installing…' }; renderMarket(); post({ type: 'installRegistrySkill', name: e.name, repo: e.repo, scope }); };
        acts.appendChild(b);
        if (job && job.status === 'error') { acts.appendChild(el('span', 'note err', esc(job.detail || 'failed'))); }
      }
    } else if (kind === 'mcp') {
      tags.push(`<span class="badge" title="Where it comes from">${e.origin === 'registry' ? 'MCP registry' : 'bundled catalog'}</span>`, `<span class="badge" title="How it runs">${esc([e.install ? 'local' : '', e.remote ? 'remote' : ''].filter(Boolean).join(' · '))}</span>`);
      if (e.installed) { tags.push(`<span class="badge ok">${I.check} added</span>`); }
      const cat = mcpCatState();
      if (cat.jobs[e.id] === 'running') { acts.appendChild(el('span', 'note', '<span class="spinner"></span> Installing…')); }
      else {
        const b = el('button', `btn sm ${e.installed ? '' : 'primary'}`, `${I.download}${e.installed ? 'Add again' : 'Install'}`);
        b.title = `Add “${e.name}” to ~/.localpilot/mcp.json`; b.setAttribute('aria-label', `${e.installed ? 'Add again' : 'Install'} MCP server ${e.name}`);
        b.onclick = () => { cat.jobs[e.id] = 'running'; renderMarket(); post({ type: 'installMcpCatalog', id: e.id }); setTimeout(() => { if (cat.jobs[e.id] === 'running') { delete cat.jobs[e.id]; renderMarket(); } }, 120000); };
        acts.appendChild(b);
      }
    } else if (kind === 'agent' && e.kind === 'agent') {
      tags.push(`<span class="badge">${esc(SOURCE_LABEL[e.source] || e.source)}</span>`);
      for (const u of e.usedBy || []) { tags.push(`<span class="badge" title="The ${esc(u)} mode follows this subagent's playbook">used by ${esc(u)}</span>`); }
      tags.push(`<span class="badge ok">${I.check} installed</span>`);
    } else {
      // A plugin (also on the Subagents tab when it adds some).
      tags.push(`<span class="badge" title="${esc(e.marketSpec)}">${esc(e.market)}</span>`);
      if (e.category) { tags.push(`<span class="badge">${esc(e.category)}</span>`); }
      const c = e.contains; const adds = c ? [c.commands && `${c.commands} command${c.commands === 1 ? '' : 's'}`, c.agents && `${c.agents} subagent${c.agents === 1 ? '' : 's'}`, c.skills && `${c.skills} skill${c.skills === 1 ? '' : 's'}`, c.mcpServers && `${c.mcpServers} MCP server${c.mcpServers === 1 ? '' : 's'}`, c.hooks && `${c.hooks} hook${c.hooks === 1 ? '' : 's'}`].filter(Boolean).join(', ') : '';
      if (adds) { tags.push(`<span class="badge" title="What it adds">${esc(adds)}</span>`); }
      if (e.installed) { tags.push(`<span class="badge ok">${I.check} installed · ${esc(mkScopeLabel(e.installed.scope))}${e.installed.enabled ? '' : ' (off)'}</span>`); }
      if (mk.jobs[e.name] === 'running') { acts.appendChild(el('span', 'note', '<span class="spinner"></span> Installing…')); }
      else if (e.installed) {
        const b = el('button', 'btn sm', `${I.gear}Manage…`); b.title = 'Update, switch off or uninstall installed plugins'; b.onclick = () => post({ type: 'command', id: 'localpilot.managePlugins' }); acts.appendChild(b);
      } else {
        const b = el('button', 'btn sm primary', `${I.download}Install`); b.title = `Install “${e.name}” from ${e.market}: you choose for you or this workspace, and see what it runs before anything is written`; b.setAttribute('aria-label', `Install plugin ${e.name}`);
        b.onclick = () => { mk.jobs[e.name] = 'running'; renderMarket(); post({ type: 'installPlugin', marketSpec: e.marketSpec, name: e.name }); };
        acts.appendChild(b);
      }
      if (e.homepage) { const r = el('button', 'btn ghost sm', I.external); r.title = `Open ${e.homepage}`; r.setAttribute('aria-label', `Open ${e.name} homepage`); r.onclick = () => post({ type: 'openExternal', url: e.homepage }); acts.prepend(r); }
    }
    if (kind === 'mcp' && e.repo) { const r = el('button', 'btn ghost sm', I.external); r.title = `Open ${e.repo}`; r.setAttribute('aria-label', `Open ${e.name} repository`); r.onclick = () => post({ type: 'openExternal', url: e.repo }); acts.prepend(r); }
    right.appendChild(el('div', 'tags', tags.join('')));
    right.appendChild(acts); row.appendChild(right);
    return row;
  }
  // ------------------------------------------------------------------ mcp
  const splitArgs = (raw) => (raw.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((a) => a.replace(/"/g, ''));
  /** Inverse of splitArgs: an argument with whitespace is quoted so editing it round-trips. */
  const joinArgs = (args) => args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)).join(' ');
  function secMcp(sec) {
    head(sec, 'MCP servers', 'Model Context Protocol servers whose tools become available to the agent: local ones started from a command, or remote ones at a URL (Streamable HTTP or SSE). Governed by the MCP tools approval policy.');
    const cat = mcpCatState();
    const tabs = el('div', 'seg mcp-tabs'); tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = [['installed', 'Servers'], ['browse', 'Browse']].map(([k, l]) => `<button role="tab" aria-selected="${cat.view === k}" class="${cat.view === k ? 'on' : ''}" data-k="${k}">${l}</button>`).join('');
    tabs.onclick = (e) => { const b = e.target.closest('button'); if (b && b.dataset.k !== cat.view) { cat.view = b.dataset.k; render(); } };
    const editBtn = el('button', 'btn sm', `${I.external}Edit configuration…`); editBtn.title = 'Open your mcp.json, the workspace .mcp.json or settings.json'; editBtn.onclick = () => post({ type: 'command', id: 'localpilot.editMcpConfig' });
    const tabBar = el('div', 'btnrow'); tabBar.append(tabs, el('span', 'spacer'), editBtn);
    sec.appendChild(tabBar);
    if (cat.view === 'browse') { mcpBrowse(sec); return; }
    const servers = val('mcpServers') && typeof val('mcpServers') === 'object' ? { ...val('mcpServers') } : {};
    // Shown merged; written from the selected scope's own map so the other scope's servers are never copied into it.
    const own = () => ({ ...((state.scope === 'workspace' ? S('mcpServers').workspaceValue : S('mcpServers').userValue) || {}) });
    const status = new Map((state.data.mcp || []).map((s) => [s.name, s]));
    // Servers from .mcp.json files and plugins are listed too (read-only here: edit them in their file).
    const pol = POLICY();
    // The organisation's servers: listed first, never edited here; `alwaysEnabled` ones have no switch at all.
    const orgSrv = new Set(pol ? pol.mcpServers : []);
    const alwaysOn = new Set(pol ? pol.mcpAlwaysEnabled : []);
    const names = [...new Set([...orgSrv, ...Object.keys(servers), ...status.keys()])];
    const list = el('div');
    if (!names.length) { list.appendChild(el('div', 'empty', 'No MCP servers configured. Add one below — for example the filesystem or GitHub server from <code>@modelcontextprotocol</code>.')); }
    for (const name of names) {
      const st = status.get(name);
      const managed = orgSrv.has(name);
      const inSettings = name in servers && !managed;
      const s = inSettings ? servers[name] : {};
      const off = inSettings ? s.enabled === false : !!st && st.state === 'disabled';
      const open = state.expanded === `mcp:${name}`;
      const c = el('div', `prov ${off ? 'off' : ''}`);
      const tools = st && st.state === 'connected' ? st.tools : undefined;
      const err = st && st.error;
      const busy = st && (st.state === 'connecting' || st.state === 'restarting');
      const auth = !off && st && st.state === 'auth_required';
      const where = inSettings ? (s.url ? `${s.url}${st && st.transport && st.transport !== 'stdio' ? ` · ${st.transport === 'sse' ? 'SSE' : 'HTTP'}` : ''}` : [s.command, ...(s.args || [])].join(' ')) : managed ? 'from your organization' : `from ${({ project: "the workspace's .mcp.json", user: 'your mcp.json', plugin: 'a plugin' })[st && st.source] || 'a server file'}`;
      const badge = tools !== undefined ? `<span class="badge ok">${tools} tool${tools === 1 ? '' : 's'}</span>` : off ? '<span class="badge">disabled</span>' : auth ? `<button class="btn sm primary" data-auth title="Sign in to ${esc(name)} in your browser (OAuth)">${I.external}Authenticate</button>` : busy ? `<span class="badge warn">${st.state === 'restarting' ? 'restarting…' : 'connecting…'}</span>` : `<span class="badge err" title="${esc(err || '')}">${err ? 'failed to start' : 'not connected'}</span>`;
      c.innerHTML = `<div class="prov-head"><span class="dot ${off ? '' : tools !== undefined ? 'ok' : busy ? 'busy' : 'err'}"></span><div class="prov-title"><b>${esc(name)}</b><span>${esc(where)}</span></div><div class="prov-meta">${managed ? lockIcon(alwaysOn.has(name) ? 'Always on: required by your organization' : 'Provided by your organization') : ''}${badge}${off ? '' : `<button class="btn sm ghost" data-restart title="Stop and start ${esc(name)} again">${I.refresh}Restart</button>`}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
      const restart = () => { post({ type: 'restartMcp', name }); toast(`Restarting ${name}…`); };
      const rb = c.querySelector('[data-restart]'); if (rb) { rb.onclick = (e) => { e.stopPropagation(); restart(); }; rb.onkeydown = (e) => e.stopPropagation(); }
      const ab = c.querySelector('[data-auth]'); if (ab) { ab.onclick = (e) => { e.stopPropagation(); post({ type: 'authMcp', name }); }; ab.onkeydown = (e) => e.stopPropagation(); }
      if (err && !off && !busy && !auth) {
        const box = el('div', 'prov-result err mcp-err', `<span>${I.x} ${esc(err)}</span><button class="btn sm">Retry</button>`);
        box.querySelector('button').onclick = restart;
        c.appendChild(box);
      }
      disclosure(c.querySelector('.prov-head'), open, `${name} server settings`, () => { state.expanded = open ? null : `mcp:${name}`; render(); });
      if (open) {
        if (st && st.state === 'connected') { c.appendChild(mcpInspect(name, st)); }
        if (managed) {
          const note = el('div', 'prov-result mcp-err', `<span>${I.lock} Provided by your organization's policy${alwaysOn.has(name) ? ' and always on' : ''}. It cannot be edited here.</span>${alwaysOn.has(name) ? '' : `<button class="btn sm">${off ? 'Turn on' : 'Turn off'}</button>`}`);
          const tb = note.querySelector('button'); if (tb) { tb.onclick = () => post({ type: 'toggleMcp', name, enabled: off }); }
          c.appendChild(note);
        } else if (inSettings) { c.appendChild(mcpForm(name, s, servers, own)); } else {
          const note = el('div', 'prov-result mcp-err', `<span>Defined in ${esc(({ project: "the workspace's .mcp.json", user: 'your mcp.json (~/.localpilot/mcp.json)', plugin: 'a plugin' })[st && st.source] || 'a server file')}. Edit it there; it reloads on save.</span>${st && st.source !== 'plugin' ? `<button class="btn sm">${off ? 'Turn on' : 'Turn off'}</button>` : ''}`);
          const tb = note.querySelector('button'); if (tb) { tb.onclick = () => post({ type: 'toggleMcp', name, enabled: off }); }
          c.appendChild(note);
        }
      }
      list.appendChild(c);
    }
    sec.appendChild(list);
    sec.appendChild(el('h2', 'sub', 'Add a server'));
    const add = el('div', 'card');
    const f = el('div', 'field wide');
    f.innerHTML = `<div><div class="lbl">New MCP server${pol && (pol.blockPersonalRemoteMcp || pol.allowedMcpServers) ? lockIcon(pol.blockPersonalRemoteMcp ? 'Only remote servers your organization lists can start' : 'Only servers on your organization\'s allowlist can start') : ''}</div><div class="desc">Give it a name and either the command that starts it (<code>npx -y @modelcontextprotocol/server-filesystem /path</code>) or the URL of a remote server (<code>https://mcp.example.com/mcp</code>). Add authentication headers after adding it.</div></div>`;
    const ctl = el('div', 'ctl');
    ctl.innerHTML = `<div class="row"><input type="text" id="mcpName" placeholder="name (e.g. filesystem)" style="max-width:200px"><input type="text" id="mcpCmd" placeholder="command and args, or https://… URL"><button class="btn primary sm" id="mcpAdd">${I.plus}Add</button></div>`;
    ctl.querySelector('#mcpAdd').onclick = () => {
      const name = ctl.querySelector('#mcpName').value.trim().replace(/[^\w.-]+/g, '-');
      const raw = ctl.querySelector('#mcpCmd').value.trim();
      const parts = splitArgs(raw);
      if (!name || !parts.length) { toast('Name and a command or URL are required', 'error'); return; }
      if (servers[name] || orgSrv.has(name)) { toast(`“${name}” already exists`, 'error'); return; }
      if (pol && pol.blockPersonalRemoteMcp && /^https?:\/\//i.test(raw) && !(pol.allowedMcpServers || []).some((a) => a.url && a.url.replace(/\/+$/, '') === raw.replace(/\/+$/, ''))) { toast(`${MANAGED_TIP}: remote MCP servers it does not list are blocked`, 'error'); return; }
      const next = own();
      next[name] = /^https?:\/\//i.test(raw) ? { url: raw } : { command: parts[0], args: parts.slice(1) };
      state.expanded = `mcp:${name}`;
      set('mcpServers', next);
    };
    f.appendChild(ctl); add.appendChild(f); sec.appendChild(add);
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn" data-cmd="localpilot.reloadSkills">${I.refresh}Reconnect servers</button><span class="muted small">Servers start when LocalPilot activates and after you reload.</span>`;
    sec.appendChild(bar);
    sec.appendChild(el('h2', 'sub', 'While developing a server'));
    sec.appendChild(card(field('mcp.watchServerFiles', 'Restart local servers when their code changes', 'A stdio server restarts 500 ms after a workspace .js/.mjs/.cjs/.py file in its command, or a file under build/ or dist/, changes. Handy while developing a server.', 'toggle')));
  }
  /** Browse tab: the bundled catalog (plus the MCP registry once refreshed), searched and filtered by tag. */
  const mcpCatState = () => (state.mcpCat ||= { view: 'installed', q: '', tag: '', entries: [], loaded: false, loading: false, registry: false, error: '', jobs: {} });
  function mcpBrowse(sec) {
    const cat = mcpCatState();
    if (!cat.loaded) { cat.loaded = true; cat.loading = true; post({ type: 'mcpCatalog' }); }
    const tools = el('div', 'gal-tools');
    const search = el('div', 'gal-search', I.search);
    const q = el('input'); q.type = 'search'; q.id = 'mcp-q'; q.placeholder = 'Search servers — e.g. github, postgres, browser, search…'; q.value = cat.q; q.setAttribute('aria-label', 'Search MCP servers');
    if (document.activeElement && document.activeElement.id === 'mcp-q') { requestAnimationFrame(() => { const n = app.querySelector('#mcp-q'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }); }
    q.oninput = debounce(() => { cat.q = q.value.trim(); renderMcpCatalog(); }, 150);
    search.appendChild(q); tools.appendChild(search);
    const counts = new Map();
    for (const e of cat.entries) { for (const t of e.tags || []) { counts.set(t, (counts.get(t) || 0) + 1); } }
    const chips = el('div', 'chips');
    for (const t of ['', ...[...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b)).slice(0, 14)]) {
      const b = el('button', `chip ${cat.tag === t ? 'on' : ''}`, esc(t || 'All')); b.onclick = () => { cat.tag = t; render(); }; chips.appendChild(b);
    }
    tools.appendChild(chips);
    sec.appendChild(tools);
    const results = el('div', 'gal-results'); results.id = 'mcp-results';
    sec.appendChild(results);
    renderMcpCatalog(results);
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<span class="muted small">Installing adds the server to <code>~/.localpilot/mcp.json</code>; API keys you enter go to your OS keychain.${cat.registry ? ' Includes servers from the MCP registry.' : ''}</span><span class="spacer"></span><button class="btn sm" id="mcp-reg" ${cat.loading ? 'disabled' : ''} title="Fetch the server list from registry.modelcontextprotocol.io (only when you click)">${cat.loading ? '<span class="spinner"></span>' : I.refresh}Refresh from the MCP registry</button>`;
    bar.querySelector('#mcp-reg').onclick = () => { cat.loading = true; render(); post({ type: 'mcpCatalog', refresh: true }); };
    sec.appendChild(bar);
  }
  function renderMcpCatalog(container) {
    const box = container || app.querySelector('#mcp-results');
    if (!box) { return; }
    box.innerHTML = '';
    const cat = mcpCatState();
    if (cat.loading && !cat.entries.length) { box.appendChild(skeleton('Loading the MCP catalog…', 4)); return; }
    const have = new Set([...Object.keys(val('mcpServers') || {}), ...(state.data.mcp || []).map((s) => s.name)]);
    const words = cat.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = cat.entries.filter((e) => (!cat.tag || (e.tags || []).includes(cat.tag)) && words.every((w) => `${e.id} ${e.name} ${e.tagline} ${(e.tags || []).join(' ')}`.toLowerCase().includes(w)));
    if (cat.error) { box.appendChild(el('div', 'prov-result err mcp-err', `<span>${I.x} The MCP registry could not be loaded: ${esc(cat.error)}</span>`)); }
    if (!rows.length) { box.appendChild(el('div', 'empty', cat.entries.length ? 'No server matches. Try other words, or add one by hand under <b>Servers</b>.' : 'The catalog is empty.')); return; }
    box.appendChild(el('div', 'gal-count', `${rows.length} server${rows.length === 1 ? '' : 's'}${cat.q ? ` for “${esc(cat.q)}”` : ''}`));
    const list = el('div', 'card');
    for (const e of rows.slice(0, 80)) {
      const installed = have.has(e.id);
      const row = el('div', `mrow sk ${installed ? 'have' : ''}`);
      row.appendChild(el('span', 'ic brand-mark sk-ic', I.plug));
      const how = [e.install ? 'local' : '', e.remote ? 'remote' : ''].filter(Boolean).join(' · ');
      const needs = ((e.install && e.install.env) || []).filter((v) => v.required && v.secret !== false).map((v) => v.name);
      row.appendChild(el('div', 't', `<b>${esc(e.name)}</b><span>${esc(e.tagline || '')}${needs.length ? ` <i class="muted">· needs ${esc(needs.join(', '))}</i>` : ''}</span>`));
      const right = el('div', 'mrow-right');
      right.appendChild(el('div', 'tags', `${(e.tags || []).slice(0, 3).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}<span class="badge" title="How it runs">${esc(how)}</span>${installed ? `<span class="badge ok">${I.check} added</span>` : ''}`));
      const acts = el('div', 'acts');
      if (e.repo) { const r = el('button', 'btn ghost sm', I.external); r.title = `Open ${e.repo}`; r.onclick = () => post({ type: 'openExternal', url: e.repo }); acts.appendChild(r); }
      const job = cat.jobs[e.id];
      if (job === 'running') {
        acts.appendChild(el('span', 'note', '<span class="spinner"></span> Installing…'));
      } else {
        const b = el('button', `btn sm ${installed ? '' : 'primary'}`, `${I.download}${installed ? 'Add again' : 'Install'}`);
        b.title = `Add “${e.name}” to ~/.localpilot/mcp.json`;
        b.onclick = () => { cat.jobs[e.id] = 'running'; renderMcpCatalog(); post({ type: 'installMcpCatalog', id: e.id }); setTimeout(() => { if (cat.jobs[e.id] === 'running') { delete cat.jobs[e.id]; renderMcpCatalog(); } }, 120000); };
        acts.appendChild(b);
      }
      right.appendChild(acts);
      row.appendChild(right);
      list.appendChild(row);
    }
    if (rows.length > 80) { list.appendChild(el('div', 'cat-more', `${rows.length - 80} more — narrow the search`)); }
    box.appendChild(list);
  }
  /** Tabs listing what a connected server offers: its tools (required parameters marked *), resources and prompts. */
  function mcpInspect(name, st) {
    const box = el('div', 'mcp-inspect');
    const tabs = [['tools', 'Tools', (st.toolList || []).length], ['resources', 'Resources', (st.resources || []).length + (st.resourceTemplates || []).length], ['prompts', 'Prompts', (st.prompts || []).length]];
    const cur = state.mcpTab && state.mcpTab[name] || 'tools';
    const seg = el('div', 'seg'); seg.setAttribute('role', 'tablist');
    seg.innerHTML = tabs.map(([k, l, n]) => `<button role="tab" aria-selected="${k === cur}" class="${k === cur ? 'on' : ''}" data-k="${k}">${l} <span class="muted">${n}</span></button>`).join('');
    seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) { return; } state.mcpTab = { ...(state.mcpTab || {}), [name]: b.dataset.k }; render(); };
    const body = el('div', 'mcp-list');
    const row = (title, sub, extra) => `<div class="mcp-item"><div><code>${esc(title)}</code>${extra || ''}</div>${sub ? `<div class="desc">${esc(sub)}</div>` : ''}</div>`;
    if (cur === 'tools') {
      // Per-tool approval (localpilot.mcp.toolApprovals, User only): Default follows MCP tools in Agent & approvals, or the
      // server's autoApprove list; Allow / Ask / Block override both for this tool. The organization's floor still applies.
      const all = val('mcp.toolApprovals') && typeof val('mcp.toolApprovals') === 'object' ? val('mcp.toolApprovals') : {};
      const mine = all[name] || {};
      const CAT = { always: 'Allow', ask: 'Ask', never: 'Block' };
      const cat = CAT[effVal('approvals.mcp')] || 'Allow';
      const floor = policyRefuses('approvals.mcp', 'always');
      const tools = st.toolList || [];
      if (tools.length) {
        const set_ = Object.keys(mine).filter((k) => tools.some((t) => t.name === k)).length;
        const hd = body.appendChild(el('div', 'mcp-appr-head muted small', `Approval per tool. <b>Default</b> follows <button class="inline-link" data-sec="agent">MCP tools = ${esc(cat)}</button>${(st.autoApprove || []).length ? ' or this server\'s <code>autoApprove</code> list' : ''}.${set_ ? ` ${set_} set here.` : ''}${floor ? ` ${esc(floor)}.` : ''}`));
        hd.querySelector('[data-sec]').onclick = () => { state.section = 'agent'; render(); };
      }
      for (const t of tools) {
        const item = el('div', 'mcp-item mcp-tool', `<div class="mcp-tool-main"><div><code>${esc(t.name)}</code>${t.params.length ? `<span class="mcp-params">${t.params.map((p) => `<span title="${esc(p.description || '')}">${esc(p.name)}${p.required ? '<b>*</b>' : ''}${p.type ? `<i>: ${esc(p.type)}</i>` : ''}</span>`).join('')}</span>` : ''}</div>${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}</div>`);
        const def = (st.autoApprove || []).includes(t.name) ? 'Allow (server list)' : cat;
        const sel = el('select', 'mcp-appr'); sel.setAttribute('aria-label', `Approval for ${name}/${t.name}`); sel.dataset.fk = `mcp.toolApprovals:${name}:${t.name}`;
        sel.innerHTML = [['', `Default · ${def}`], ['always', 'Allow'], ['ask', 'Ask'], ['never', 'Block']].map(([v, l]) => `<option value="${v}"${(mine[t.name] || '') === v ? ' selected' : ''}${v === 'always' && floor ? ' disabled' : ''}>${esc(l)}</option>`).join('');
        if (mine[t.name]) { item.classList.add('set', `appr-${mine[t.name]}`); }
        sel.onchange = () => {
          const next = { ...all, [name]: { ...mine } };
          if (sel.value) { next[name][t.name] = sel.value; } else { delete next[name][t.name]; }
          if (!Object.keys(next[name]).length) { delete next[name]; }
          set('mcp.toolApprovals', next);
        };
        item.appendChild(sel);
        body.appendChild(item);
      }
      if (!tools.length) { body.innerHTML = '<div class="empty">This server offers no tools.</div>'; }
    } else if (cur === 'resources') {
      body.innerHTML = [...(st.resources || []).map((r) => row(r.uri, [r.name !== r.uri ? r.name : '', r.description].filter(Boolean).join(' — '), r.mimeType ? `<span class="badge">${esc(r.mimeType)}</span>` : '')), ...(st.resourceTemplates || []).map((r) => row(r.uriTemplate, [r.name, r.description].filter(Boolean).join(' — '), '<span class="badge">template</span>'))].join('') || '<div class="empty">This server offers no resources.</div>';
    } else {
      body.innerHTML = (st.prompts || []).map((p) => row(`/mcp:${name}:${p.name}`, p.description, (p.arguments || []).length ? `<span class="mcp-params">${p.arguments.map((a) => `<span title="${esc(a.description || '')}">${esc(a.name)}${a.required ? '<b>*</b>' : ''}</span>`).join('')}</span>` : '')).join('') || '<div class="empty">This server offers no prompts.</div>';
    }
    box.append(seg, body);
    // Rebuilt in place when the approvals change, from the newest status of this server.
    return component(box, ['mcp.toolApprovals', 'approvals.mcp'], () => { const fresh = ((state.data && state.data.mcp) || []).find((x) => x.name === name); return fresh && fresh.state === 'connected' ? mcpInspect(name, fresh) : el('div'); });
  }
  function mcpForm(name, s, servers, own) {
    const body = el('div', 'prov-body');
    const upd = (patch) => { const next = own(); next[name] = { ...(next[name] || servers[name] || {}), ...patch }; for (const k of Object.keys(next[name])) { if (next[name][k] === undefined) { delete next[name][k]; } } set('mcpServers', next); };
    const row = (label, desc, input) => { const f = el('div', 'field'); f.innerHTML = `<div><div class="lbl">${esc(label)}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`; const ctl = el('div', 'ctl'); ctl.appendChild(input); f.appendChild(ctl); return f; };
    const cmd = el('input'); cmd.type = 'text'; cmd.value = s.command || ''; cmd.onchange = () => upd({ command: cmd.value.trim() });
    const args = el('input'); args.type = 'text'; args.value = joinArgs(s.args || []); args.placeholder = 'space-separated; quote an argument with spaces'; args.onchange = () => upd({ args: args.value.trim() ? splitArgs(args.value.trim()) : undefined });
    const cwd = el('input'); cwd.type = 'text'; cwd.value = s.cwd || ''; cwd.placeholder = 'workspace root'; cwd.onchange = () => upd({ cwd: cwd.value.trim() || undefined });
    const env = el('textarea'); env.value = s.env ? JSON.stringify(s.env, null, 2) : ''; env.placeholder = '{ "API_KEY": "…" }';
    env.onchange = () => { try { upd({ env: env.value.trim() ? JSON.parse(env.value) : undefined }); env.classList.remove('invalid'); } catch { env.classList.add('invalid'); toast('Environment must be valid JSON', 'error'); } };
    const en = el('button', `toggle ${s.enabled !== false ? 'on' : ''}`); en.onclick = () => upd({ enabled: s.enabled === false ? undefined : false });
    if (s.url) {
      // Remote server: endpoint, transport and request headers instead of a command line.
      const url = el('input'); url.type = 'url'; url.value = s.url; url.onchange = () => upd({ url: url.value.trim() });
      const type = el('select'); type.innerHTML = '<option value="">Automatic</option><option value="http">Streamable HTTP</option><option value="sse">HTTP + SSE (older servers)</option>'; type.value = s.type || ''; type.onchange = () => upd({ type: type.value || undefined });
      const headers = el('textarea'); headers.value = s.headers ? JSON.stringify(s.headers, null, 2) : ''; headers.placeholder = '{ "Authorization": "Bearer ${env:MY_TOKEN}" }';
      headers.onchange = () => { try { upd({ headers: headers.value.trim() ? JSON.parse(headers.value) : undefined }); headers.classList.remove('invalid'); } catch { headers.classList.add('invalid'); toast('Headers must be valid JSON', 'error'); } };
      body.appendChild(row('URL', '', url));
      body.appendChild(row('Transport', 'Automatic tries Streamable HTTP and falls back to SSE; a URL ending in <code>/sse</code> uses SSE.', type));
      body.appendChild(row('Headers', 'JSON object sent with every request. Use <code>${env:NAME}</code> so tokens stay out of settings.json.', headers));
    } else {
      body.appendChild(row('Command', '', cmd));
      body.appendChild(row('Arguments', '', args));
      body.appendChild(row('Working directory', '', cwd));
      body.appendChild(row('Environment', 'JSON object of extra environment variables.', env));
    }
    const timeout = el('select');
    const secs = [[30, '30 s'], [60, '1 min (default)'], [300, '5 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 hour']];
    if (s.timeout && !secs.some(([v]) => v === s.timeout)) { secs.push([s.timeout, `${s.timeout} s`]); }
    timeout.innerHTML = secs.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    timeout.value = String(s.timeout || 60);
    timeout.onchange = () => { const v = Number(timeout.value); upd({ timeout: v === 60 ? undefined : v }); };
    body.appendChild(row('Timeout', 'How long one request to this server may take before it fails.', timeout));
    body.appendChild(row('Enabled', '', en));
    const foot = el('div', 'prov-foot');
    foot.innerHTML = `<span class="spacer"></span><button class="btn danger">${I.trash}Remove</button>`;
    foot.querySelector('button').onclick = () => {
      const next = own();
      if (!(name in next)) { toast(`“${name}” is defined in ${state.scope === 'workspace' ? 'User' : 'Workspace'} settings — switch scope to remove it`, 'error'); return; }
      delete next[name]; state.expanded = null; set('mcpServers', next);
    };
    body.appendChild(foot);
    return body;
  }

  // ------------------------------------------------------------------ advanced
  // ------------------------------------------------------------------ dashboard (local metrics, telemetry, logs)
  const DASH_RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All']];
  const fmtN = (n) => { n = Number(n) || 0; return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); };
  const fmtMs = (ms) => { ms = Number(ms) || 0; return ms >= 60e3 ? `${(ms / 60e3).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10e3 ? 0 : 1)} s` : `${Math.round(ms)} ms`; };
  const pct = (p) => `${Math.round(Number(p) || 0)}%`;
  /** Dollars as the chat shows them: `$0.0123`, `<$0.0001`, or a dash when nothing was priced (local models are free). */
  const fmtUsd = (v) => (typeof v !== 'number' || !Number.isFinite(v) ? '—' : v > 0 && v < 0.0001 ? '&lt;$0.0001' : `$${v >= 1 ? v.toFixed(2) : v.toFixed(4)}`);
  /** Plain-text dollars for chart titles and axes (escaped by the chart itself). */
  const usdText = (v) => (!v ? '$0' : v < 0.0001 ? '<$0.0001' : `$${v >= 100 ? Math.round(v) : v >= 0.01 ? v.toFixed(2) : v.toFixed(4)}`);
  const p2 = (n) => String(n).padStart(2, '0');
  /** HH:MM:SS; with `dated`, a time from an earlier day gets MM-DD in front. */
  const fmtTime = (t, dated) => { const d = new Date(t); const hms = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; return dated && d.getTime() < new Date().setHours(0, 0, 0, 0) ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hms}` : hms; };
  /** Tiny inline SVG bar chart; `pick` maps a day point to a number. Bars are titled with day + value; `what` names it for
   *  screen readers ("Agent runs per day"), which hear the values (or the total and peak of a long range). */
  function spark(series, pick, what, fmt = fmtN) {
    const vals = series.map(pick);
    const max = Math.max(fmt === fmtN ? 1 : 1e-9, ...vals);
    const w = 100 / Math.max(1, vals.length);
    const bars = vals.map((v, i) => `<rect x="${(i * w).toFixed(2)}" y="${(28 - (v / max) * 26).toFixed(2)}" width="${Math.max(0.6, w - 0.8).toFixed(2)}" height="${((v / max) * 26 + 0.5).toFixed(2)}" rx=".6"><title>${esc(series[i].day)} · ${fmt(v)}</title></rect>`).join('');
    const plain = (v) => String(fmt(v)).replace('&lt;', '<');
    const peak = vals.indexOf(Math.max(...vals));
    const said = vals.length <= 14 ? vals.map(plain).join(', ') : `total ${plain(vals.reduce((a, b) => a + b, 0))}, peak ${plain(vals[peak])} on ${dayLabel(series[peak].day)}`;
    return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" aria-label="${esc(`${what}, last ${vals.length} day${vals.length === 1 ? '' : 's'}: ${said}`)}">${bars}</svg>`;
  }
  const NEEDS_ATTENTION = `<span class="kpi-flag">${I.warn}<span class="sr-only">Needs attention: </span></span>`;
  function kpi(label, value, sub, sparkHtml, tone) {
    return `<div class="kpi ${tone || ''}"><div class="kpi-l">${tone ? NEEDS_ATTENTION : ''}${esc(label)}</div><div class="kpi-v">${value}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}${sparkHtml || ''}</div>`;
  }
  // --- charts: plain inline SVG, theme chart colours, hover titles, real axis labels. No library, no canvas. ---
  // Each chart is drawn for the width of its card (see chartSlot), so axis text stays ~9 px instead of shrinking with the
  // viewBox. A chart returns { html, data }: data feeds the screen-reader summary and the arrow-key readout.
  const CH = { w: 600, h: 150, padL: 34, padR: 6, padT: 8, padB: 20 };
  const dayLabel = (day) => { const d = new Date(`${day}T12:00:00`); return isNaN(d) ? day : `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}`; };
  const niceMax = (v) => { if (v <= 0) { return 1; } const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
  /** Y axis: 3 gridlines with labels; X axis: one day label per ~60 px. */
  function axes(series, max, fmt, w) {
    const { h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    let out = '';
    for (const f of [0, 0.5, 1]) { const y = padT + ih - f * ih; out += `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="ax" x="${padL - 5}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(max * f))}</text>`; }
    const step = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(w / 60))));
    // The last day is always labelled; the regular label before it is dropped when the two would touch.
    const last = series.length - 1;
    series.forEach((d, i) => { if (i === last || (i % step === 0 && last - i >= Math.ceil(step / 2))) { const x = padL + (i + 0.5) * (iw / series.length); out += `<text class="ax" x="${x.toFixed(1)}" y="${h - 5}" text-anchor="middle">${esc(dayLabel(d.day))}</text>`; } });
    return out;
  }
  /** Readout and accessible summary for a day chart: totals per series (or the average for rates), the busiest day. */
  function dayData(series, keys, vals, fmt, title, avg) {
    const span = series.length > 1 ? `${dayLabel(series[0].day)} to ${dayLabel(series[series.length - 1].day)}` : dayLabel(series[0].day);
    const sums = vals.map((v) => v.reduce((a, b) => a + b, 0));
    const peak = sums.indexOf(Math.max(...sums));
    const tot = keys.map((k, j) => vals.reduce((a, v) => a + v[j], 0));
    const what = avg ? `average ${fmt(tot[0] / Math.max(1, vals.filter((v) => v[0]).length))}` : keys.length > 1 ? keys.map((k, j) => `${k.label} ${fmt(tot[j])}`).join(', ') : `total ${fmt(tot[0])}`;
    return {
      label: `${title}, ${span}, ${what}${!sums[peak] ? '' : keys.length > 1 ? `, busiest ${dayLabel(series[peak].day)}` : `, peak ${dayLabel(series[peak].day)} ${fmt(vals[peak][0])}`}`,
      title, cols: ['Day', ...keys.map((k) => k.label)],
      rows: series.map((d, i) => [dayLabel(d.day), ...vals[i].map((v) => fmt(v))]),
      line: (i) => `${dayLabel(series[i].day)} · ${keys.map((k, j) => `${k.label} ${fmt(vals[i][j])}`).join(' · ')}`,
    };
  }
  /** Grouped or stacked bars per day. `keys`: [{ k, label, cls, pick }]. */
  function barChart(series, keys, opts = {}, w = CH.w) {
    const { h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    const stacked = !!opts.stacked;
    const vals = series.map((d) => keys.map((k) => Number(k.pick(d)) || 0));
    const max = niceMax(Math.max(opts.floor ?? 1, ...vals.map((v) => stacked ? v.reduce((a, b) => a + b, 0) : Math.max(...v))));
    const fmt = opts.fmt || fmtN;
    const slot = iw / Math.max(1, series.length); const gap = Math.min(6, slot * 0.25);
    const bw = stacked ? slot - gap : (slot - gap) / keys.length;
    let bars = '';
    vals.forEach((v, i) => {
      let acc = 0;
      keys.forEach((k, j) => {
        const val = v[j]; if (!val) { return; }
        const bh = (val / max) * ih;
        const x = padL + i * slot + gap / 2 + (stacked ? 0 : j * bw);
        const y = padT + ih - bh - (stacked ? (acc / max) * ih : 0);
        bars += `<rect class="s${j} ${k.cls || ''}" data-i="${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - (stacked ? 0 : 1)).toFixed(1)}" height="${Math.max(0.5, bh).toFixed(1)}" rx="1"><title>${esc(dayLabel(series[i].day))} · ${esc(k.label)}: ${esc(fmt(val))}</title></rect>`;
        acc += val;
      });
    });
    return chartFrame(`${axes(series, max, fmt, w)}${bars}`, keys, w, CH.h, dayData(series, keys, vals, fmt, opts.title || 'Per day'));
  }
  /** One or more lines (with a soft area under the first) over the day series. */
  function lineChart(series, keys, opts = {}, w = CH.w) {
    const { h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    const fmt = opts.fmt || fmtN;
    const vals = series.map((d) => keys.map((k) => Number(k.pick(d)) || 0));
    const max = niceMax(Math.max(1, ...vals.flat()));
    const px = (i) => padL + (i + 0.5) * (iw / Math.max(1, series.length)); const py = (v) => padT + ih - (v / max) * ih;
    let out = axes(series, max, fmt, w);
    keys.forEach((k, j) => {
      const pts = series.map((d, i) => [px(i), py(vals[i][j]), vals[i][j]]);
      const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (j === 0 && pts.length > 1) { out += `<path class="area s0" d="${path} L${pts[pts.length - 1][0].toFixed(1)} ${(padT + ih).toFixed(1)} L${pts[0][0].toFixed(1)} ${(padT + ih).toFixed(1)} Z"/>`; }
      out += `<path class="line s${j}" d="${path}"/>`;
      out += pts.map((p, i) => `<circle class="pt s${j}" data-i="${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5"><title>${esc(dayLabel(series[i].day))} · ${esc(k.label)}: ${esc(fmt(p[2]))}</title></circle>`).join('');
    });
    return chartFrame(out, keys, w, CH.h, dayData(series, keys, vals, fmt, opts.title || 'Per day', opts.avg));
  }
  function chartFrame(inner, keys, w, h, data, cls = '') {
    const legend = keys.length > 1 || (keys[0] && keys[0].cls) ? `<div class="legend" aria-hidden="true">${keys.map((k, j) => `<span><i class="s${j} ${k.cls || ''}"></i>${esc(k.label)}</span>`).join('')}</div>` : '';
    // The SVG is only a picture for assistive tech: the focusable wrapper names it, and a hidden table carries the numbers.
    const table = `<table class="sr-only"><caption>${esc(data.title)}</caption><thead><tr>${data.cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${data.rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody></table>`;
    return { data, html: `<div class="chart ${cls}" tabindex="0" role="group" aria-roledescription="chart" aria-label="${esc(data.label)}. Left and Right arrow keys read each ${data.unit || (cls === 'hours' ? 'hour' : 'day')}."><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${inner}</svg>${legend}<div class="chart-val muted small" aria-live="polite"></div>${table}</div>` };
  }
  /** Donut with a centred headline; `parts`: [{ label, value, cls }]. */
  function donut(parts, centre, sub) {
    const total = parts.reduce((a, p) => a + (Number(p.value) || 0), 0) || 1;
    const r = 34, c = 2 * Math.PI * r; let off = 0; let arcs = '';
    for (const p of parts) { const len = (Number(p.value) / total) * c; if (len > 0) { arcs += `<circle class="${p.cls}" r="${r}" cx="45" cy="45" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(p.label)}: ${fmtN(p.value)} (${pct((p.value / total) * 100)})</title></circle>`; off += len; } }
    return `<div class="donut"><svg viewBox="0 0 90 90" aria-hidden="true"><circle class="track" r="${r}" cx="45" cy="45"/>${arcs}<text class="dv" x="45" y="43" text-anchor="middle">${esc(centre)}</text><text class="ds" x="45" y="56" text-anchor="middle">${esc(sub || '')}</text></svg><ul class="dl">${parts.map((p) => `<li><i class="${p.cls}"></i>${esc(p.label)}<b>${fmtN(p.value)}</b></li>`).join('')}</ul></div>`;
  }
  /** 24-bucket histogram (activity by hour of day) with hour labels. */
  function hourChart(hourly, w = 240) {
    const max = Math.max(1, ...hourly); const h = 70, bw = w / 24;
    const hr = (i) => `${String(i).padStart(2, '0')}:00 – ${String(i).padStart(2, '0')}:59`;
    const bars = hourly.map((v, i) => `<rect class="s0" data-i="${i}" x="${(i * bw + 1).toFixed(1)}" y="${(50 - (v / max) * 46).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((v / max) * 46 + 0.5).toFixed(1)}" rx="1"><title>${hr(i)} · ${fmtN(v)} calls</title></rect>`).join('');
    const labels = (w < 200 ? [0, 12, 23] : [0, 6, 12, 18, 23]).map((i) => `<text class="ax" x="${(i * bw + bw / 2).toFixed(1)}" y="64" text-anchor="middle">${String(i).padStart(2, '0')}</text>`).join('');
    const peak = hourly.indexOf(Math.max(...hourly));
    const data = { title: 'Model calls by hour of day', label: `Model calls by hour of day, total ${fmtN(hourly.reduce((a, b) => a + b, 0))}, busiest ${hr(peak)} with ${fmtN(hourly[peak])}`, cols: ['Hour', 'Calls'], rows: hourly.map((v, i) => [hr(i), fmtN(v)]), line: (i) => `${hr(i)} · ${fmtN(hourly[i])} call${hourly[i] === 1 ? '' : 's'}` };
    return chartFrame(`${bars}${labels}`, [], w, h, data, 'hours');
  }
  /** A chart drawn once its card is on the page, at the card's width, and again when the dashboard is resized. */
  function chartSlot(draw, min = 280, max = 600) {
    const slot = el('div', 'chart-slot');
    slot._draw = () => {
      const w = Math.round(Math.max(min, Math.min(max, slot.clientWidth || max)));
      if (w === slot._w) { return; }
      const was = slot.querySelector('.chart'); const focused = was && was.contains(document.activeElement); const at = was ? was._at : -1;
      const r = draw(w); slot._w = w; slot.innerHTML = r.html;
      wireChart(slot.firstElementChild, r.data, at);
      if (focused) { slot.firstElementChild.focus({ preventScroll: true }); }
    };
    return slot;
  }
  function drawCharts(root) { root.querySelectorAll('.chart-slot').forEach((x) => x._draw && x._draw()); }
  let chartRO = null; let chartRaf = 0;
  /** Left/Right (Home/End) walk the bars; the highlighted day's values are read out under the chart. */
  function wireChart(ch, data, at = -1) {
    const n = data.rows.length; const out = ch.querySelector('.chart-val');
    const show = (i) => {
      ch._at = i; ch.classList.toggle('has-hl', i >= 0);
      ch.querySelectorAll('[data-i]').forEach((x) => x.classList.toggle('hl', Number(x.dataset.i) === i));
      out.textContent = i >= 0 ? data.line(i) : '';
    };
    ch.onkeydown = (e) => {
      const i = ch._at ?? -1;
      const next = e.key === 'ArrowRight' ? Math.min(n - 1, i + 1) : e.key === 'ArrowLeft' ? (i < 0 ? n - 1 : Math.max(0, i - 1)) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key === 'Escape' ? -1 : null;
      if (next === null) { return; }
      e.preventDefault(); show(next);
    };
    ch.onfocus = () => { if ((ch._at ?? -1) < 0) { show(n - 1); } };
    ch.onblur = () => show(-1);
    if (at >= 0 && at < n) { show(at); }
  }
  const pctl = (p) => p && (p.p50 || p.p95) ? `<span class="pctl" title="median · 95th percentile">${fmtMs(p.p50)} <i>/ ${fmtMs(p.p95)}</i></span>` : '<span class="muted">—</span>';
  function requestDashboard(days) {
    if (typeof days === 'number') { state.dash.days = days; }
    state.dash.loading = true;
    post({ type: 'dashboard', days: state.dash.days, includeDisabled: state.dash.includeDisabled, providers: state.dash.provider ? [state.dash.provider] : [] });
    // A host that never answers (extension reloading, telemetry wedged) must not leave the page loading forever.
    clearTimeout(state.dash.ttl);
    state.dash.ttl = setTimeout(() => { if (!state.dash.loading) { return; } state.dash.loading = false; state.dash.manual = false; state.dash.error = 'No answer from LocalPilot'; dashBusy(); renderDashboard(); }, 20000);
    dashBusy();
  }
  const recordingOff = () => effVal('telemetry.enabled') === false;
  /** Recovery comes from the RecoveryStore, so a running recovery or a waiting intervention refreshes with telemetry off too. */
  const recLive = () => { const d = state.rec.data; return !!d && (d.current.length > 0 || d.interventions.length > 0); };
  /** What the numbers on screen were asked for: range, disabled providers in or out, one provider or all. */
  const dashKey = () => `${state.dash.days}|${state.dash.includeDisabled}|${state.dash.provider}`;
  /** The Provider filter and the "Not counting N disabled providers" line, refreshed with every reply. */
  function syncDashFilters() {
    const d = state.dash;
    const sel = document.getElementById('dash-prov');
    if (sel) {
      const s = d.summary;
      const ids = d.allProviders || (s ? [...new Set([...(s.providers || []).map((p) => p.provider), ...(s.models || []).map((m) => m.provider)])] : []);
      if (d.provider && !ids.includes(d.provider)) { ids.push(d.provider); }
      const sig = ids.join('\n');
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        sel.replaceChildren(...[['', 'All providers'], ...ids.map((id) => [id, id])].map(([v, l]) => { const o = el('option', '', esc(l)); o.value = v; return o; }));
      }
      sel.value = d.provider;
      sel.closest('.dash-prov').hidden = ids.length < 2 && !d.provider;
    }
    const line = document.getElementById('dash-hidden');
    if (!line) { return; }
    const hid = d.hidden || [];
    line.hidden = !hid.length;
    if (!hid.length) { line.replaceChildren(); return; }
    const calls = hid.reduce((a, h) => a + h.calls, 0);
    const what = `${plural(hid.length, 'disabled provider')} (${plural(calls, 'call')})`;
    const txt = el('span', '', esc(d.includeDisabled ? `Counting ${what}.` : `Not counting ${what}.`));
    txt.title = hid.map((h) => `${h.id}: ${plural(h.calls, 'call')}`).join('\n');
    const b = el('button', 'btn sm ghost', d.includeDisabled ? 'Exclude' : 'Include');
    b.setAttribute('aria-pressed', String(d.includeDisabled));
    b.title = d.includeDisabled ? 'Count only providers that are enabled now' : 'Also count model calls from providers that are disabled or removed';
    b.onclick = () => {
      d.includeDisabled = !d.includeDisabled;
      if (!d.includeDisabled && d.provider && hid.some((h) => h.id === d.provider)) { d.provider = ''; }
      d.manual = true; d.error = ''; requestDashboard(); syncDashFilters();
      const nb = document.querySelector('#dash-hidden button'); if (nb) { nb.focus({ preventScroll: true }); }
    };
    line.replaceChildren(txt, b);
  }
  /** Loading state on the page: the old range's numbers dim while a different range loads, and Refresh spins. */
  function dashBusy() {
    const d = state.dash; const root = document.getElementById('dash'); const rb = document.getElementById('dash-refresh');
    const stale = d.loading && !!d.summary && d.summaryKey !== dashKey();
    if (root) { root.classList.toggle('stale', stale); if (d.loading) { root.setAttribute('aria-busy', 'true'); } else { root.removeAttribute('aria-busy'); } }
    if (rb) { const busy = d.loading && (d.manual || stale); rb.classList.toggle('busy', busy); if (busy) { rb.setAttribute('aria-busy', 'true'); } else { rb.removeAttribute('aria-busy'); } }
    dashMeta();
  }
  /** "Showing 30 Oct to 5 Nov · updated 12 s ago" under the toolbar. */
  function dashMeta() {
    const n = document.getElementById('dash-meta'); if (!n) { return; }
    const s = state.dash.summary; if (!s || !s.to) { n.textContent = ''; return; }
    const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const ago = state.dash.updatedAt ? Math.round((Date.now() - state.dash.updatedAt) / 1000) : -1;
    const upd = ago < 0 ? '' : ago < 5 ? ' · updated just now' : ago < 60 ? ` · updated ${ago} s ago` : ` · updated ${fmtAgo(state.dash.updatedAt)}`;
    n.textContent = `Showing ${s.from && day(s.from) !== day(s.to) ? `${day(s.from)} to ${day(s.to)}` : day(s.to)}${upd}`;
  }
  function requestLogs() { post({ type: 'logs', level: state.dash.level, q: state.dash.q, follow: state.dash.follow }); }
  function stopDashboardTimer() { if (state.dash.timer) { clearInterval(state.dash.timer); state.dash.timer = null; } if (state.dash.follow) { post({ type: 'logs', level: state.dash.level, q: state.dash.q, follow: false }); } }
  /** A "…" button with a keyboard-navigable menu of [icon, label, fn, title, sec] items. `opts`: the button's html,
   *  label and title; `floating` pins the menu to the viewport under the button, kept inside the window, so a scrolling or
   *  masked parent cannot clip it (the caller may move `more._menu` out of such a parent); `onOpen(menu)` runs on open. */
  function moreMenu(items, cls = '', opts = {}) {
    const more = el('div', `dash-more ${cls}`);
    const label = opts.label || 'More actions';
    const moreBtn = el('button', 'btn sm', opts.html || '…'); moreBtn.setAttribute('aria-label', label); moreBtn.title = opts.title || label; moreBtn.setAttribute('aria-haspopup', 'menu'); moreBtn.setAttribute('aria-expanded', 'false');
    const menu = el('div', `menu${opts.floating ? ' floating' : ''}`); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', label); menu.hidden = true;
    const close = (refocus) => { menu.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); window.removeEventListener('resize', onMove); document.removeEventListener('scroll', onMove, true); if (refocus) { moreBtn.focus(); } };
    const outside = (e) => { if (!more.contains(e.target) && !menu.contains(e.target)) { close(false); } };
    // A pinned menu would drift away from its button, so moving the page closes it (scrolling the menu itself does not).
    const onMove = (e) => { if (!e || e.type === 'resize' || !menu.contains(e.target)) { close(false); } };
    const place = () => {
      const r = moreBtn.getBoundingClientRect(); const w = menu.offsetWidth; const h = menu.offsetHeight;
      const below = r.bottom + 4 + h <= window.innerHeight - 8 || r.top < h + 12;
      menu.style.right = 'auto';
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
      menu.style.top = `${Math.round(below ? r.bottom + 4 : r.top - 4 - h)}px`;
    };
    for (const [icon, label, fn, title, sec] of items) { const b = el('button', '', `${icon}${esc(label)}`); b.setAttribute('role', 'menuitem'); if (title) { b.title = title; } if (sec) { b.dataset.sec = sec; } b.onclick = () => { close(false); fn(); }; menu.appendChild(b); }
    moreBtn.onclick = () => {
      if (!menu.hidden) { close(false); return; }
      menu.hidden = false; moreBtn.setAttribute('aria-expanded', 'true'); document.addEventListener('mousedown', outside, true);
      if (opts.floating) { place(); }
      (menu.querySelector('button.on') || menu.querySelector('button')).focus({ preventScroll: !!opts.floating });
      if (opts.onOpen) { opts.onOpen(menu, moreBtn); }
      if (opts.floating) { window.addEventListener('resize', onMove); document.addEventListener('scroll', onMove, true); }
    };
    menu.onkeydown = (e) => {
      const btns = [...menu.querySelectorAll('button')]; const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length].focus(); } else if (e.key === 'Tab') { close(false); }
    };
    more.append(moreBtn, menu); more._menu = menu;
    return more;
  }
  // ------------------------------------------------------------------ self-healing & recovery (dashboard)
  // Data from the host's recovery data service (RecoveryStore states joined with telemetry): signature keys arrive already
  // resolved to `TS2345@src/api/user.ts`. Every value is escaped here; nothing in it is trusted markup.
  const RATE_DEF = 'Recovery rate = recovered ÷ (recovered + escalated + exhausted + blocked) over the recovery episodes in the range. Failures that were already there or that another session caused never open an episode. 0% when nothing has ended yet.';
  const REC_TABS = [['history', 'Failure history'], ['rca', 'Root cause analysis'], ['attempts', 'Recovery attempts'], ['patches', 'Applied patches'], ['retry', 'Retry configuration'], ['regression', 'Regression reports'], ['queue', 'Human intervention'], ['analytics', 'Performance analytics']];
  const REC_PHASE = { idle: 'Idle', executing: 'Working', verifying: 'Running checks', detecting: 'Detecting', classifying: 'Classifying', retrying: 'Retrying', diagnosing: 'Diagnosing', fixing: 'Fixing', validating: 'Validating', rolling_back: 'Rolling back', resolving: 'Resolving a dependency', regression: 'Regression checks', escalating: 'Escalating', completing: 'Completing', interrupted: 'Interrupted', completed: 'Completed', completed_unverified: 'Not verified', incomplete: 'Incomplete', blocked: 'Blocked', failed: 'Failed', cancelled: 'Cancelled' };
  const REC_RESULT = { fixed: 'Fixed', not_fixed: 'Not fixed', worse: 'Made it worse', rolled_back: 'Rolled back', duplicate: 'Same failure again', blocked: 'Blocked', recovered: 'Recovered', escalated: 'Escalated', exhausted: 'Attempts used up', detected: 'Detected', unresolved: 'Unresolved', retry: 'Retried', fix_attempt: 'Fixing', validated: 'Validated', resumed: 'Resumed', 'in progress': 'In progress', kept: 'Kept', ...REC_PHASE };
  const REC_OK = new Set(['fixed', 'recovered', 'completed', 'validated', 'kept']);
  const REC_BAD = new Set(['not_fixed', 'worse', 'blocked', 'escalated', 'exhausted', 'incomplete', 'failed', 'unresolved', 'duplicate']);
  const REC_STRATEGY = { retry: 'Retry', reroute: 'Other model', adjust_resources: 'Adjust resources', repair_output: 'Repair output', fix: 'Targeted fix', diagnose: 'Diagnose', install: 'Install dependency', reconnect: 'Reconnect', validate_schema: 'Validate schema', isolate: 'Isolate', remediate: 'Remediate', escalate: 'Escalate', stop: 'Stop' };
  const REC_REASON = { exhausted: 'Attempts used up', duplicate: 'Same failure after a fix', deadline: 'Deadline reached', loop: 'Loop or step limit', mistake_limit: 'Too many mistakes', approval_needed: 'Needs your approval', credentials: 'Credentials missing', git_conflict: 'Git conflict', security: 'Security finding', data_corruption: 'Data corruption', model_blocked: 'Model refused', user_edit_conflict: 'You edited the same files', model_unavailable: 'Model unavailable' };
  const REC_ACTION_TIP = { resume: 'Continue the task in its chat: the checks run again first', rollback: 'Undo the fixes self-healing made for this task', approveInstall: 'Run the proposed install (it still goes through the approval rules)', acceptRisk: 'Keep the finding in the code; LocalPilot asks you to confirm and records the decision in the audit log', dismiss: 'Remove this item from the queue', openChat: 'Open the chat this task ran in', openMergeEditor: 'Resolve the conflict in the merge editor' };
  const catLabel = (c) => HEAL_CAT_LABEL[c] || String(c || '').replace(/_/g, ' ');
  const resLabel = (r) => REC_RESULT[r] || String(r || '—').replace(/_/g, ' ');
  const resBadge = (r) => (r ? `<span class="badge ${REC_OK.has(r) ? 'ok' : REC_BAD.has(r) ? 'err' : r === 'rolled_back' || r === 'interrupted' || r === 'completed_unverified' ? 'warn' : ''}">${esc(resLabel(r))}</span>` : '<span class="muted">—</span>');
  const sevBadge = (s) => (s ? `<span class="badge ${s === 'critical' || s === 'high' ? 'err' : s === 'medium' ? 'warn' : ''}">${esc(s)}</span>` : '<span class="muted">—</span>');
  const sidShort = (sid) => `<span class="mono" title="${esc(sid)}">${esc(String(sid || '').slice(0, 8))}</span>`;
  const recWhen = (t) => (t ? `<span title="${esc(new Date(t).toLocaleString())}">${esc(fmtTime(t, true))}</span>` : '<span class="muted">—</span>');
  const recKey = (k) => `<code class="rec-key" title="${esc(k)}">${esc(k || '—')}</code>`;
  function renderRecovery() {
    const root = document.getElementById('dash-rec');
    if (!root) { return; }
    const rs = state.rec;
    const r = rs.data;
    if (!r) {
      root.replaceChildren(rs.error ? recErr() : !rs.loaded ? skeleton('Loading recovery data…', 3, 'kpis') : el('p', 'empty', 'Self-healing is not available in this window.'));
      return;
    }
    const t = r.tiles;
    const kpis = el('div', 'kpis rec-kpis');
    kpis.innerHTML = [
      kpi('Engine', t.enabled ? 'On' : 'Off', t.enabled ? 'detects, fixes and re-checks failures' : 'failures are reported, not fixed', '', t.enabled ? '' : 'warn'),
      kpi('Failures detected', fmtN(t.detected), r.days >= 3650 ? 'in everything recorded' : `in the last ${plural(r.days, 'day')}`),
      kpi('Recovered', fmtN(t.recovered), t.detected ? `of ${fmtN(t.detected)} detected` : ''),
      kpi('Pending intervention', fmtN(t.pendingIntervention), t.pendingIntervention ? 'waiting for you · see Human intervention' : 'nothing waiting', '', t.pendingIntervention ? 'warn' : ''),
      kpi('Recovery rate', t.detected ? pct(t.rate) : '—', 'recovered ÷ ended episodes'),
      kpi('Mean time to recover', t.mttrP50 ? fmtMs(t.mttrP50) : '—', t.mttrP50 ? 'median, first failure to verified fix' : 'no recovery yet'),
    ].join('');
    const rate = kpis.children[4]; rate.title = RATE_DEF; rate.tabIndex = 0; rate.setAttribute('aria-label', `Recovery rate ${t.detected ? pct(t.rate) : 'no data'}. ${RATE_DEF}`);
    const nodes = [kpis, recConfigRow(r.config), recCurrent(r.current), recTabs(r)];
    if (rs.error) { nodes.unshift(recErr()); }
    const refocus = recFocusKey(root);
    root.replaceChildren(...nodes);
    for (const d of root.querySelectorAll('details[data-open]')) { d.ontoggle = () => { rs.open[d.getAttribute('data-open')] = d.open; }; }
    if (refocus) { const n = root.querySelector(refocus); if (n) { n.focus({ preventScroll: true }); } }
    drawCharts(root);
    if (typeof ResizeObserver === 'function') {
      if (!rs.ro) { rs.ro = new ResizeObserver(() => { cancelAnimationFrame(rs.raf); rs.raf = requestAnimationFrame(() => { const n = document.getElementById('dash-rec'); if (n) { drawCharts(n); } }); }); }
      rs.ro.disconnect(); rs.ro.observe(root);
    }
  }
  /** Selector for the control that has focus inside the group, so a rebuild (the 15 s refresh, a reply) puts it back. */
  function recFocusKey(root) {
    const a = document.activeElement;
    if (!a || !a.getAttribute || !root.contains(a)) { return ''; }
    const q = (v) => String(v).replace(/["\\]/g, '\\$&');
    for (const k of ['data-ra', 'data-patch', 'data-opendiff', 'data-memory', 'data-tab']) {
      const v = a.getAttribute(k);
      if (v === null) { continue; }
      const card = k === 'data-ra' && a.closest ? a.closest('[data-iv]') : null;
      return `${card ? `[data-iv="${q(card.getAttribute('data-iv'))}"] ` : ''}[${k}="${q(v)}"]`;
    }
    return '';
  }
  /** `open` and the key for a `<details>` whose state survives the rebuilds. */
  const recOpenAttr = (key) => ` data-open="${esc(key)}"${state.rec.open[key] ? ' open' : ''}`;
  function recErr() {
    const c = el('div', 'policy dash-err'); c.setAttribute('role', 'alert');
    c.innerHTML = `${I.x}<div>Could not load recovery data: ${esc(state.rec.error)}</div>`;
    return c;
  }
  /** The engine's switches as read-only chips, Security bypass locked, plus a way to the settings. */
  function recConfigRow(c) {
    const row = el('div', 'rec-config');
    const chip = (label, on) => `<span class="rec-cfg ${on ? 'on' : 'off'}" role="listitem">${on ? I.check : I.x}<span>${esc(label)}<span class="sr-only">: ${on ? 'on' : 'off'}</span></span></span>`;
    const items = el('div', 'rec-cfgs'); items.setAttribute('role', 'list'); items.setAttribute('aria-label', 'Self-healing configuration');
    items.innerHTML = [
      chip('Auto-detect', c.autoDetect), chip('Automatic retry', c.autoRetry), chip('Automatic code fixes', c.autoFix), chip('Regression testing required', c.regressionRequired),
      `<span class="rec-cfg locked" role="listitem" title="Security findings and approval rules are never skipped by self-healing. This cannot be enabled.">${I.lock}<span>Security bypass: disabled</span></span>`,
      `<span class="rec-cfg num" role="listitem">${I.refresh}<span>Max repair attempts <b>${esc(c.maxRepairAttempts)}</b></span></span>`,
    ].join('');
    const b = el('button', 'btn sm ghost', `${I.gear}Settings`); b.title = 'Settings → Agent → Self-healing'; b.setAttribute('aria-label', 'Self-healing settings');
    b.onclick = () => { state.section = 'agent'; render(); };
    row.append(items, b);
    return row;
  }
  /** Running sessions in recovery: phase and attempt N/M with a meter. */
  function recCurrent(cur) {
    const c = el('div', 'card rec-current');
    if (!cur.length) { c.innerHTML = '<h3>Current recovery</h3><p class="muted small rec-none">No task is recovering right now.</p>'; return c; }
    c.innerHTML = `<h3>Current recovery <span class="count">${cur.length}</span></h3><ul class="rec-cur">${cur.map((x) => {
      const share = x.max ? Math.min(100, (x.attempt / x.max) * 100) : 0;
      return `<li><span class="dot busy" aria-hidden="true"></span><div class="rec-cur-t"><b>${esc(x.title || 'Chat')}</b> ${sidShort(x.sessionId)}<div class="muted small">${esc(REC_PHASE[x.phase] || x.phase)}${x.category ? ` · ${esc(catLabel(x.category))}` : ''}${x.key ? ` · ${recKey(x.key)}` : ''}</div></div><span class="rec-att">attempt <b>${esc(x.attempt)}/${esc(x.max)}</b><span class="meter" role="img" aria-label="attempt ${esc(x.attempt)} of ${esc(x.max)}"><i style="width:${share.toFixed(1)}%"></i></span></span></li>`;
    }).join('')}</ul>`;
    return c;
  }
  /** The eight views as tabs; arrow keys move between tabs (roving tabindex). */
  function recTabs(r) {
    const rs = state.rec;
    const wrap = el('div', 'rec-views');
    const list = el('div', 'chips rec-tabs'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', 'Recovery views');
    const count = { history: r.failureHistory.length, rca: r.rca.length, attempts: r.attempts.length, patches: r.patches.length, regression: r.regression.length, queue: r.interventions.length };
    for (const [k, label] of REC_TABS) {
      const on = rs.tab === k;
      const b = el('button', `chip${on ? ' on' : ''}${k === 'queue' && count.queue ? ' attn' : ''}`, `${esc(label)}${count[k] !== undefined ? ` <i>${count[k]}</i>` : ''}`);
      b.id = `rec-tab-${k}`; b.dataset.tab = k; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(on)); b.setAttribute('aria-controls', 'rec-panel'); b.tabIndex = on ? 0 : -1;
      b.onclick = () => { if (rs.tab === k) { return; } rs.tab = k; renderRecovery(); const n = document.getElementById(`rec-tab-${k}`); if (n) { n.focus({ preventScroll: true }); } };
      list.appendChild(b);
    }
    list.onkeydown = (e) => {
      const bs = [...list.querySelectorAll('[role="tab"]')]; const i = bs.indexOf(document.activeElement); if (i < 0) { return; }
      const to = e.key === 'ArrowRight' ? bs[(i + 1) % bs.length] : e.key === 'ArrowLeft' ? bs[(i - 1 + bs.length) % bs.length] : e.key === 'Home' ? bs[0] : e.key === 'End' ? bs[bs.length - 1] : null;
      if (!to) { return; }
      e.preventDefault(); to.click();
    };
    const panel = el('div', 'rec-panel'); panel.id = 'rec-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `rec-tab-${rs.tab}`);
    const view = { history: recHistory, rca: recRca, attempts: recAttempts, patches: recPatches, retry: recRetry, regression: recRegression, queue: recQueue, analytics: recAnalytics }[rs.tab] || recHistory;
    panel.appendChild(view(r));
    wrap.append(list, panel);
    return wrap;
  }
  const recEmpty = (text) => el('p', 'empty', esc(text));
  /** Memory entry the failure's fix came from, by signature (RCA rows carry it). */
  const memoryFor = (r) => { const m = new Map(); for (const x of r.rca) { if (x.memoryUsed && !m.has(x.signature)) { m.set(x.signature, { id: x.memoryUsed, allowed: x.memoryReuseAllowed }); } } return m; };
  /** "Don't suggest again" for a failure-memory entry, "Suggest again" when it is off: the stored value, or the click
   *  until the host's refresh brings the stored value back. */
  function reuseBtn(id, allowed) {
    const mine = state.rec.reuse[id];
    const off = mine !== undefined ? mine === false : allowed === false;
    const b = el('button', 'btn sm ghost', off ? 'Suggest again' : 'Don’t suggest again');
    b.dataset.memory = id;
    b.title = off ? 'Offer this remembered fix again when the same failure comes back' : 'Stop offering this remembered fix for similar failures';
    b.onclick = () => { state.rec.reuse[id] = off; post({ type: 'memoryReuse', id, allowed: off }); renderRecovery(); };
    return b;
  }
  function recHistory(r) {
    const rs = state.rec;
    const box = el('div', 'rec-view');
    if (!r.failureHistory.length) { box.appendChild(recEmpty('No failures in this period. When a build, test, tool or model call fails, it is listed here with what happened next.')); return box; }
    const bar = el('div', 'rec-filter');
    const sel = el('select'); sel.setAttribute('aria-label', 'Category');
    sel.replaceChildren(...[['', 'All categories'], ...r.categories.map((c) => [c, catLabel(c)])].map(([v, l]) => { const o = el('option', '', esc(l)); o.value = v; return o; }));
    if (rs.cat && !r.categories.includes(rs.cat)) { rs.cat = ''; }
    sel.value = rs.cat;
    sel.onchange = () => { rs.cat = sel.value; renderRecovery(); const n = document.querySelector('#rec-panel .rec-filter select'); if (n) { n.focus({ preventScroll: true }); } };
    const rows = r.failureHistory.filter((x) => !rs.cat || x.category === rs.cat);
    bar.append(sel, el('span', 'muted small', `${plural(rows.length, 'failure')}${r.failureHistory.length >= 200 ? ' (the latest 200)' : ''}`));
    box.appendChild(bar);
    const mem = memoryFor(r);
    const card = el('div', 'card tblwrap');
    const t = el('table', 'tbl dash-tbl rec-tbl');
    t.innerHTML = '<thead><tr><th scope="col">Failure</th><th scope="col">Time</th><th scope="col">Session</th><th scope="col">Category</th><th scope="col">Severity</th><th scope="col">Outcome</th><th scope="col"><span class="sr-only">Memory</span></th></tr></thead>';
    const tb = el('tbody');
    for (const x of rows) {
      const tr = el('tr', '', `<td>${recKey(x.key)}${x.source === 'telemetry' ? ' <i title="Only the hash was recorded; the details have since been cleared">from metrics</i>' : ''}</td><td data-label="At">${recWhen(x.t)}</td><td data-label="Session">${sidShort(x.sessionId)}</td><td data-label="">${esc(catLabel(x.category))}</td><td data-label="">${sevBadge(x.severity)}</td><td data-label="">${resBadge(x.outcome)}</td><td class="act"></td>`);
      const m = x.signature && mem.get(x.signature);
      if (m) { tr.lastChild.appendChild(reuseBtn(m.id, m.allowed)); }
      tb.appendChild(tr);
    }
    t.appendChild(tb); card.appendChild(t); box.appendChild(card);
    return box;
  }
  function recRca(r) {
    const box = el('div', 'rec-view');
    if (!r.rca.length) { box.appendChild(recEmpty('No diagnosis yet. Each fix attempt shows the failure, the root cause found, the strategy and whether it worked.')); return box; }
    const ol = el('ol', 'rec-rca');
    for (const x of r.rca) {
      const li = el('li', 'card');
      li.innerHTML = `<div class="rec-rca-h"><b>Attempt ${esc(x.attempt)}</b><span class="muted small">${esc(catLabel(x.category))} · ${recWhen(x.t)} · ${sidShort(x.sessionId)}</span><span class="spacer"></span>${resBadge(x.result || 'in progress')}</div>`
        + `<dl class="kv rec-chain"><dt>Failure</dt><dd>${recKey(x.key)}${x.failure && x.failure !== x.key ? `<div class="rec-msg">${esc(x.failure)}</div>` : ''}</dd>`
        + `<dt>Root cause</dt><dd>${x.rootCause ? esc(x.rootCause) : '<span class="muted">Not stated</span>'}</dd>`
        + `<dt>Strategy</dt><dd>${esc(REC_STRATEGY[x.strategy] || x.strategy)}${x.mode === 'delegate' ? ' <span class="badge">parallel subagent</span>' : ''}</dd>`
        + `${x.memoryUsed ? '<dt>From memory</dt><dd class="rec-mem"><span>A fix remembered from an earlier failure was suggested.</span></dd>' : ''}</dl>`;
      if (x.memoryUsed) { li.querySelector('.rec-mem').appendChild(reuseBtn(x.memoryUsed, x.memoryReuseAllowed)); }
      ol.appendChild(li);
    }
    box.appendChild(ol);
    return box;
  }
  function recAttempts(r) {
    const box = el('div', 'rec-view');
    if (!r.attempts.length) { box.appendChild(recEmpty('No recovery attempts in this period.')); return box; }
    for (const task of r.attempts) {
      const c = el('div', 'card rec-task');
      const total = task.attempts.reduce((a, x) => a + (x.durationMs || 0), 0);
      const step = (a) => `<li class="${REC_OK.has(a.result) ? 'ok' : REC_BAD.has(a.result) ? 'bad' : ''}"><span class="rec-n">${esc(a.n)}</span><div class="rec-step"><div><b>${esc(REC_STRATEGY[a.strategy] || a.strategy)}</b> · ${esc(catLabel(a.category))} ${recKey(a.key)}</div><div class="muted small">${a.durationMs !== undefined ? fmtMs(a.durationMs) : 'running'}${a.patches ? ` · ${plural(a.patches, 'file')} patched` : ''}${a.mode === 'delegate' ? ' · subagent' : ''}${a.adjust.length ? ` · ${a.adjust.map((x) => `<span class="badge">${esc(x)}</span>`).join(' ')}` : ''}</div></div>${resBadge(a.result || 'in progress')}</li>`;
      c.innerHTML = `<h3>${sidShort(task.sessionId)}<span class="muted small">turn ${esc(task.turnKey + 1)}${task.taskId ? ` · queued task ${esc(task.taskId)}` : ''} · ${recWhen(task.recoveryStartedAt || task.startedAt)}</span><span class="spacer"></span>${resBadge(task.outcome || task.phase)}</h3>`
        + (task.attempts.length ? `<ol class="rec-tl">${task.attempts.map(step).join('')}</ol>` : '<p class="muted small">No attempts: the failure was reported without a fix.</p>')
        + `<div class="rec-task-f muted small">${[total ? `${fmtMs(total)} in attempts` : '', ...task.perCategory.map((p) => `${esc(catLabel(p.category))} ${esc(p.count)}`)].filter(Boolean).join(' · ')}</div>`
        + (task.approvals.length ? `<details class="rec-more"${recOpenAttr(`ap:${task.sessionId}|${task.turnKey}`)}><summary>${plural(task.approvals.length, 'approval')}</summary><ul class="rec-list">${task.approvals.map((a) => `<li>${recWhen(a.at)} <b>${esc(a.kind)}</b>${a.command ? ` <code>${esc(a.command)}</code>` : ''} · ${esc(a.decision)}${a.mandatory ? ' · always asked' : ''}${a.blockedBy ? ` · blocked by ${esc(a.blockedBy)}` : ''}</li>`).join('')}</ul></details>` : '')
        + (task.acceptedRisks.length ? `<div class="rec-risk">${I.warn}<span>Risk accepted by you: ${task.acceptedRisks.map((x) => `${x.keys.map(recKey).join(', ')} ${recWhen(x.at)}`).join('; ')}</span></div>` : '');
      box.appendChild(c);
    }
    return box;
  }
  /** Unified diff text with added/removed lines marked (escaped line by line). */
  const diffHtml = (text) => String(text || '').split('\n').map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? 'add' : /^-(?!--)/.test(l) ? 'del' : /^@@/.test(l) ? 'hunk' : ''}">${esc(l)}</span>`).join('\n');
  function recPatches(r) {
    const rs = state.rec;
    const box = el('div', 'rec-view');
    if (!r.patches.length) { box.appendChild(recEmpty('No patches in this period. Files self-healing changes are listed here with a preview of the change and whether it was kept.')); return box; }
    const card = el('div', 'card tblwrap');
    const t = el('table', 'tbl dash-tbl rec-tbl rec-patches');
    t.innerHTML = '<thead><tr><th scope="col">File</th><th scope="col">Lines</th><th scope="col">Attempt</th><th scope="col">Result</th><th scope="col">When</th><th scope="col"><span class="sr-only">Preview</span></th></tr></thead>';
    const tb = el('tbody');
    r.patches.forEach((p, i) => {
      const k = `${p.sessionId}|${p.attempt}|${p.file}|${p.diffHash}`;
      const open = !!rs.open[k];
      const tr = el('tr', p.result === 'rolled_back' ? 'rolled' : '', `<td class="mono" title="${esc(p.file)}">${esc(p.file)}</td><td data-label=""><span class="ok-text">+${esc(p.added)}</span> <span class="err-text">−${esc(p.removed)}</span></td><td data-label="Attempt">${esc(p.attempt)}</td><td data-label="">${resBadge(p.result)}</td><td data-label="">${recWhen(p.t)}</td><td class="act"></td>`);
      const b = el('button', 'btn sm ghost', open ? 'Hide diff' : 'Preview diff');
      b.dataset.patch = String(i);
      b.setAttribute('aria-expanded', String(open));
      b.disabled = !p.preview;
      b.title = p.preview ? `Show the change to ${p.file}` : 'No preview was kept for this change';
      b.onclick = () => { rs.open[k] = !open; renderRecovery(); const n = document.querySelector(`#rec-panel [data-patch="${i}"]`); if (n) { n.focus({ preventScroll: true }); } };
      const od = el('button', 'btn sm ghost', 'Open diff');
      od.dataset.opendiff = String(i);
      od.disabled = !rs.canDiff;
      od.title = rs.canDiff ? `Open the whole change to ${p.file} in a diff editor` : 'Opening diffs is not available in this window';
      od.onclick = () => post({ type: 'openRecoveryDiff', sessionId: p.sessionId, attempt: p.attempt, file: p.file });
      tr.lastChild.appendChild(b); tr.lastChild.appendChild(od);
      tb.appendChild(tr);
      if (open && p.preview) { const d = el('tr', 'rec-diff-row'); d.innerHTML = `<td colspan="6"><pre class="rec-diff" tabindex="0" aria-label="Diff of ${esc(p.file)}">${diffHtml(p.preview)}</pre></td>`; tb.appendChild(d); }
    });
    t.appendChild(tb); card.appendChild(t); box.appendChild(card);
    return box;
  }
  function recRetry(r) {
    const box = el('div', 'rec-view');
    const head = el('div', 'rec-filter');
    head.appendChild(el('span', 'muted small', 'Effective policy per kind of failure: the defaults with your overrides. Security findings get at most 3 fix attempts; data corruption, git conflicts, permissions and loops always go to you.'));
    const b = el('button', 'btn sm', `${I.gear}Edit`); b.title = 'Settings → Agent → Self-healing → Retry configuration'; b.setAttribute('aria-label', 'Edit the retry configuration');
    b.onclick = () => { state.section = 'agent'; render(); };
    head.appendChild(b);
    box.appendChild(head);
    const card = el('div', 'card tblwrap');
    const waits = (p) => (p.backoffMs.length ? `${p.backoffMs.map((ms) => fmtMs(ms)).join(', ')}${p.exponential ? ' <i>exponential</i>' : ''}` : '<span class="muted">none</span>');
    card.innerHTML = `<table class="tbl dash-tbl rec-tbl"><thead><tr><th scope="col">Failure kind</th><th scope="col">Attempts</th><th scope="col">Wait between</th><th scope="col">Time limit</th><th scope="col">Strategy</th></tr></thead><tbody>${r.retryConfig.map((p) => `<tr class="${p.attempts ? '' : 'fixed'}"><td>${esc(catLabel(p.category))}${p.overridden ? ' <span class="badge user">override</span>' : ''}</td><td data-label="Attempts"><b>${esc(p.attempts)}</b>${p.overridden && p.attempts !== p.defaultAttempts ? ` <i>default ${esc(p.defaultAttempts)}</i>` : ''}${p.attempts ? '' : ' <i>goes to you</i>'}</td><td data-label="Wait">${waits(p)}</td><td data-label="Limit">${p.timeoutSeconds ? `${esc(p.timeoutSeconds)} s` : '<span class="muted">default</span>'}</td><td data-label="">${esc(REC_STRATEGY[p.strategy] || p.strategy)}</td></tr>`).join('')}</tbody></table>`;
    box.appendChild(card);
    return box;
  }
  function recRegression(r) {
    const box = el('div', 'rec-view');
    if (!r.regression.length) { box.appendChild(recEmpty('No regression runs in this period. After a fix, the wider checks run again and are compared with the failures from before; the result is shown here.')); return box; }
    const keys = (xs, cls) => (xs.length ? xs.map((k) => `<code class="rec-key ${cls}" title="${esc(k)}">${esc(k)}</code>`).join(' ') : '<span class="muted">none</span>');
    for (const x of r.regression) {
      const c = el('div', `card rec-reg${x.introduced.length ? ' bad' : ''}`);
      c.innerHTML = `<h3>${x.introduced.length ? I.warn : I.check}Attempt ${esc(x.attempt)} <span class="muted small">${sidShort(x.sessionId)} · ${recWhen(x.t)}${x.durationMs ? ` · ${fmtMs(x.durationMs)}` : ''}</span></h3>`
        + `<div class="rec-reg-n" role="list"><span role="listitem"><b>${esc(x.before)}</b> failing before</span><span role="listitem"><b>${esc(x.after)}</b> after</span><span role="listitem" class="${x.introduced.length ? 'err-text' : ''}"><b>${x.introduced.length}</b> introduced</span><span role="listitem"><b>${x.fixed.length}</b> fixed</span></div>`
        + `<dl class="kv rec-chain"><dt>Introduced</dt><dd>${keys(x.introduced, 'bad')}</dd><dt>Fixed</dt><dd>${keys(x.fixed, '')}</dd><dt>Already failing</dt><dd>${keys(x.preexisting, '')}</dd><dt title="Failures in files another chat or subagent changed: not blamed on this task">Another session</dt><dd>${keys(x.foreign, '')}</dd></dl>`;
      box.appendChild(c);
    }
    return box;
  }
  function recQueue(r) {
    const box = el('div', 'rec-view');
    if (!r.interventions.length) { box.appendChild(recEmpty('Nothing needs you. When self-healing stops (attempts used up, an approval, a conflict or a security finding), the task waits here with its root cause and what you can do.')); }
    for (const iv of r.interventions) {
      const c = el('div', 'card rec-iv');
      c.dataset.iv = iv.id;
      const sec = iv.category === 'security' || iv.reason === 'security';
      c.innerHTML = `<h3>${I.warn}<span class="rec-iv-t">${esc(iv.title)}</span></h3>`
        + `<div class="muted small">${esc(REC_REASON[iv.reason] || iv.reason)}${iv.category ? ` · ${esc(catLabel(iv.category))}` : ''} · ${sidShort(iv.sessionId)} · ${recWhen(iv.createdAt)}${iv.patches ? ` · ${plural(iv.patches, 'patched file')}` : ''}</div>`
        + (iv.rootCause || iv.attemptsSummary ? `<dl class="kv rec-chain">${iv.rootCause ? `<dt>Root cause</dt><dd>${esc(iv.rootCause)}</dd>` : ''}${iv.attemptsSummary ? `<dt>Tried</dt><dd>${esc(iv.attemptsSummary)}</dd>` : ''}</dl>` : '')
        + (iv.evidence ? `<details class="rec-more"${recOpenAttr(`iv:${iv.id}`)}><summary>Evidence</summary><pre class="rec-diff">${esc(iv.evidence)}</pre></details>` : '');
      const acts = el('div', 'btnrow rec-acts');
      // Guidance needs a typed instruction (the chat card has the box); accepting a risk is only for security findings.
      const list = (iv.nextActions || []).filter((a) => a && a.action && a.action !== 'retryWithGuidance' && (a.action !== 'acceptRisk' || sec));
      if (!list.some((a) => a.action === 'openChat')) { list.push({ action: 'openChat', label: 'Open chat' }); }
      // Dismiss only resolves the item (it never accepts a risk), so every card can be cleared once it was handled elsewhere.
      if (!list.some((a) => a.action === 'dismiss')) { list.push({ action: 'dismiss', label: 'Dismiss' }); }
      list.forEach((a, i) => {
        const b = el('button', `btn sm${a.action === 'acceptRisk' ? ' danger' : a.action === 'dismiss' ? ' ghost' : i === 0 ? ' primary' : ''}`, esc(a.label || a.action));
        b.dataset.ra = a.action;
        const tip = REC_ACTION_TIP[a.action] || a.label || a.action;
        b.title = a.command ? `${tip} (${a.command})` : tip;
        b.onclick = () => { acts.querySelectorAll('button').forEach((x) => { x.disabled = true; }); post({ type: 'recoveryAction', sessionId: iv.sessionId, action: a.action, id: iv.id }); };
        acts.appendChild(b);
      });
      c.appendChild(acts);
      box.appendChild(c);
    }
    const risks = r.attempts.flatMap((task) => task.acceptedRisks.map((x) => ({ ...x, sessionId: task.sessionId })));
    if (risks.length) {
      const rc = el('div', 'card rec-risks');
      rc.innerHTML = `<h3>Accepted risks <span class="count">${risks.length}</span></h3><p class="muted small">Security findings you chose to keep. Each is in the audit log.</p><ul class="rec-list">${risks.map((x) => `<li>${recWhen(x.at)} ${sidShort(x.sessionId)} ${x.keys.map(recKey).join(', ')}</li>`).join('')}</ul>`;
      box.appendChild(rc);
    }
    return box;
  }
  /** Horizontal bars, one row per category, in the dashboard chart conventions: chartFrame (hidden table, arrow-key readout
   *  via wireChart), one series in the theme chart colour on a recessive track. `rows`: [{ label, value, note }]. */
  function hbarChart(rows, opts, w) {
    const rowH = 22, pad = 4, labW = Math.min(170, Math.round(w * 0.42)), valW = 40;
    const h = rows.length * rowH + pad * 2; const iw = Math.max(20, w - labW - valW - 8);
    const max = opts.max || niceMax(Math.max(1, ...rows.map((x) => x.value)));
    const fit = (s) => { const n = Math.max(6, Math.floor(labW / 6.2)); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
    const fmt = opts.fmt || fmtN;
    const marks = rows.map((x, i) => {
      const y = pad + i * rowH; const bw = x.value ? Math.max(2, (x.value / max) * iw) : 0;
      return `<text class="ax hb-l" x="${labW - 6}" y="${(y + rowH / 2 + 3.5).toFixed(1)}" text-anchor="end">${esc(fit(x.label))}</text><rect class="hb-track" x="${labW}" y="${(y + 6).toFixed(1)}" width="${iw.toFixed(1)}" height="${rowH - 12}" rx="2"/><rect class="s0" data-i="${i}" x="${labW}" y="${(y + 6).toFixed(1)}" width="${bw.toFixed(1)}" height="${rowH - 12}" rx="2"><title>${esc(x.label)}: ${esc(fmt(x.value))}${x.note ? ` (${esc(x.note)})` : ''}</title></rect><text class="ax hb-v" x="${(labW + iw + 6).toFixed(1)}" y="${(y + rowH / 2 + 3.5).toFixed(1)}">${esc(fmt(x.value))}</text>`;
    }).join('');
    const line = (i) => `${rows[i].label} · ${fmt(rows[i].value)}${rows[i].note ? ` · ${rows[i].note}` : ''}`;
    const data = { title: opts.title, unit: opts.unit, label: `${opts.title}: ${rows.map((x) => `${x.label} ${fmt(x.value)}`).join(', ')}`, cols: [opts.col, opts.valueCol], rows: rows.map((x) => [x.label, `${fmt(x.value)}${x.note ? ` (${x.note})` : ''}`]), line };
    return chartFrame(marks, [], w, h, data, 'hbars');
  }
  function recAnalytics(r) {
    const a = r.analytics;
    const box = el('div', 'rec-view');
    if (!r.tiles.detected && !a.rateByCategory.length && !a.topSignatures.length) { box.appendChild(recEmpty('Nothing to analyse yet: the numbers appear once self-healing has handled a failure in this period.')); return box; }
    const cols = el('div', 'dash-cols charts');
    const rc = el('div', 'card');
    rc.innerHTML = `<h3>Recovery rate by category <span class="count" title="${esc(RATE_DEF)}">recovered ÷ ended episodes</span></h3>`;
    if (a.rateByCategory.length) { rc.appendChild(chartSlot((w) => hbarChart(a.rateByCategory.map((x) => ({ label: catLabel(x.category), value: x.rate, note: `${x.recovered} of ${x.detected} recovered` })), { title: 'Recovery rate by category', unit: 'category', col: 'Category', valueCol: 'Recovery rate', max: 100, fmt: (v) => `${Math.round(v)}%` }, w), 260, 600)); } else { rc.appendChild(el('p', 'empty', 'No episode has ended yet.')); }
    cols.appendChild(rc);
    const side = el('div', 'dash-side');
    const dc = el('div', 'card');
    dc.innerHTML = '<h3>Attempts per recovery <span class="count">tasks</span></h3>';
    if (a.attemptsDistribution.length) { dc.appendChild(chartSlot((w) => hbarChart(a.attemptsDistribution.map((x) => ({ label: plural(x.attempts, 'attempt'), value: x.tasks })), { title: 'Recoveries by number of attempts', unit: 'row', col: 'Attempts', valueCol: 'Tasks' }, w), 220, 420)); } else { dc.appendChild(el('p', 'empty', 'No episode has ended yet.')); }
    side.appendChild(dc);
    const kc = el('div', 'card');
    kc.innerHTML = `<h3>Time and memory</h3><dl class="kv dashkv"><dt>Time to recover</dt><dd>${a.mttr.p50 ? `<span class="pctl" title="median · 90th percentile">${fmtMs(a.mttr.p50)} <i>/ ${fmtMs(a.mttr.p90)}</i></span>` : '<span class="muted">—</span>'}</dd><dt title="Remembered fixes that were suggested, and how many of those attempts fixed the failure">Memory hits</dt><dd>${a.memory.suggested ? `<b>${pct(a.memory.hitRate)}</b> <span class="muted small">${fmtN(a.memory.succeeded)} of ${fmtN(a.memory.suggested)}</span>` : '<span class="muted">none suggested</span>'}</dd><dt>Accepted risks</dt><dd class="${a.acceptedRisks ? 'err-text' : 'muted'}">${fmtN(a.acceptedRisks)}</dd></dl><p class="muted small rec-src">${a.source === 'telemetry' ? 'Counts from usage metrics; rates per category and times from the recovery records.' : 'Usage metrics are off, so the counts come from the recovery records.'}</p>`;
    side.appendChild(kc);
    cols.appendChild(side);
    box.appendChild(cols);
    const tc = el('div', 'card tblwrap');
    tc.innerHTML = `<h3>Recurring failures <span class="count">${a.topSignatures.length}</span></h3>` + (a.topSignatures.length ? `<table class="tbl dash-tbl rec-tbl"><thead><tr><th scope="col">Failure</th><th scope="col">Seen</th><th scope="col">Recovered</th><th scope="col">Share recovered</th></tr></thead><tbody>${a.topSignatures.map((x) => { const share = x.count ? (x.recovered / x.count) * 100 : 0; return `<tr><td>${recKey(x.key)}</td><td data-label="Seen">${fmtN(x.count)}</td><td data-label="Recovered">${fmtN(x.recovered)}</td><td data-label=""><span class="meter" role="img" aria-label="${pct(share)} recovered" title="${pct(share)} recovered"><i style="width:${share.toFixed(1)}%"></i></span></td></tr>`; }).join('')}</tbody></table>` : '<p class="empty">No failure came back more than once.</p>');
    box.appendChild(tc);
    return box;
  }
  // ------------------------------------------------------------------ end self-healing & recovery
  function secDashboard(sec) {
    head(sec, 'Dashboard', ''); sec.classList.add('dash-sec');
    sec.querySelector('.lead').replaceWith(privacyLead());
    const bar = el('div', 'dash-bar');
    const seg = el('div', 'seg');
    // The section is rebuilt on a range change, so focus moves to the new selected option (arrow keys keep working).
    for (const [d, l] of DASH_RANGES) { const b = el('button', state.dash.days === d ? 'on' : '', esc(l)); b.onclick = () => { if (state.dash.days === d) { return; } const had = seg.contains(document.activeElement); state.dash.days = d; state.dash.error = ''; render(); const n = had && app.querySelector('.dash-bar .seg button.on'); if (n) { n.focus({ preventScroll: true }); } }; seg.appendChild(b); }
    seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Time range'); radioGroup(seg);
    bar.appendChild(seg);
    const acts = el('div', 'dash-acts');
    const refresh = el('button', 'btn sm', `${I.refresh}<span class="lbl">Refresh</span>`); refresh.id = 'dash-refresh'; refresh.setAttribute('aria-label', 'Refresh'); refresh.title = 'Refresh';
    refresh.onclick = () => { state.dash.manual = true; state.dash.error = ''; requestDashboard(); };
    const rangeName = () => { const r = DASH_RANGES.find(([d]) => d === state.dash.days); return state.dash.days > 0 && r ? r[1].toLowerCase().replace(/^\d/, (x) => `the last ${x}`) : 'everything recorded'; };
    const exp = moreMenu([
      [I.download, 'This range as JSON', () => post({ type: 'exportTelemetry', scope: 'range', days: state.dash.days }), `Raw events from ${rangeName()}`],
      [I.file, 'Summary as CSV (models, tools, modes)', () => post({ type: 'exportTelemetry', scope: 'csv', days: state.dash.days }), `The model, tool and mode tables for ${rangeName()}, as the dashboard shows them`],
      [I.download, 'Everything as JSON', () => post({ type: 'exportTelemetry', scope: 'all', days: 0 }), 'Every recorded event and the current log'],
    ], 'dash-export', { html: `${I.download}<span class="lbl">Export…</span>`, label: 'Export telemetry', title: 'Export telemetry as JSON or CSV', floating: true });
    const prov = el('div', 'dash-prov');
    const provSel = el('select'); provSel.id = 'dash-prov'; provSel.setAttribute('aria-label', 'Provider');
    provSel.onchange = () => { state.dash.provider = provSel.value; state.dash.manual = true; state.dash.error = ''; requestDashboard(); };
    prov.title = 'Show one provider only'; prov.appendChild(provSel);
    bar.appendChild(prov);
    const more = moreMenu([
      [I.folder, 'Open folder', () => post({ type: 'openTelemetryFolder' }), 'Open the folder with the recorded metrics and logs'],
      [I.file, 'Open log file', () => post({ type: 'openLogFile' }), state.dash.logFile || "Today's log file"],
      [I.gear, 'Telemetry settings', () => { state.section = 'telemetry'; render(); }, 'Recording, retention, Redis storage and OTLP export', 'telemetry'],
    ]);
    acts.append(refresh, exp, more);
    bar.appendChild(acts);
    sec.appendChild(bar);
    const hidden = el('p', 'dash-hidden'); hidden.id = 'dash-hidden'; hidden.hidden = true; hidden.setAttribute('aria-live', 'polite'); sec.appendChild(hidden);
    syncDashFilters();
    const meta = el('p', 'dash-meta'); meta.id = 'dash-meta'; meta.setAttribute('aria-live', 'off'); sec.appendChild(meta);
    const body = el('div', 'dash'); body.id = 'dash'; sec.appendChild(body);
    renderDashboard();
    sec.appendChild(el('h2', 'sub', 'Self-healing &amp; recovery'));
    const rec = el('div', 'dash rec-dash'); rec.id = 'dash-rec'; rec.setAttribute('aria-live', 'off'); sec.appendChild(rec);
    renderRecovery();
    // Logs
    sec.appendChild(el('h2', 'sub', 'Logs <span class="count" id="logCount"></span>'));
    const lc = el('div', 'card logcard');
    const tools = el('div', 'logbar');
    const lvl = el('select'); lvl.id = 'logLevel'; lvl.setAttribute('aria-label', 'Minimum level');
    for (const [k, l] of [['trace', 'Trace'], ['debug', 'Debug'], ['info', 'Info'], ['warn', 'Warnings'], ['error', 'Errors']]) { const o = el('option', '', esc(l)); o.value = k; if (k === state.dash.level) { o.selected = true; } lvl.appendChild(o); }
    lvl.onchange = () => { state.dash.level = lvl.value; requestLogs(); };
    const q = el('input'); q.id = 'logQ'; q.type = 'text'; q.placeholder = 'Filter log lines…'; q.value = state.dash.q; q.setAttribute('aria-label', 'Filter log lines');
    q.oninput = debounce(() => { state.dash.q = q.value.trim(); requestLogs(); }, 250);
    const follow = el('button', 'btn sm');
    const syncFollow = () => { const on = state.dash.follow; follow.classList.toggle('on', on); follow.setAttribute('aria-pressed', String(on)); follow.innerHTML = on ? `${I.pause}Following` : `${I.play}Follow`; follow.title = on ? 'Following new lines as they are written — click to pause' : 'Paused — click to stream new lines as they are written'; };
    follow.onclick = () => { state.dash.follow = !state.dash.follow; syncFollow(); requestLogs(); };
    syncFollow();
    const copy = el('button', 'btn sm ghost', `${I.copy}<span class="lbl">Copy</span>`); copy.title = 'Copy the lines shown here'; copy.setAttribute('aria-label', 'Copy the lines shown here');
    copy.onclick = () => {
      const lines = state.dash.logs.map((e) => `${new Date(e.t).toISOString()} ${String(e.level).toUpperCase()} ${e.msg}`);
      if (!lines.length) { toast('Nothing to copy'); return; }
      navigator.clipboard.writeText(lines.join('\n')).then(() => toast(`Copied ${plural(lines.length, 'line')}`), () => toast('Could not copy to the clipboard', 'error'));
    };
    const clear = el('button', 'btn sm ghost', `${I.x}<span class="lbl">Clear view</span>`); clear.title = 'Clear this view (the log file is kept)'; clear.setAttribute('aria-label', 'Clear view');
    clear.onclick = () => { state.dash.logs = []; renderLogs(); };
    const openFile = el('button', 'btn sm log-wide', `${I.file}Open log file`); openFile.title = state.dash.logFile || "Today's log file"; openFile.onclick = () => post({ type: 'openLogFile' });
    const channel = el('button', 'btn sm ghost log-wide', `${I.external}Output channel`); channel.title = 'Show the LocalPilot output channel'; channel.onclick = () => post({ type: 'command', id: 'localpilot.showLogs' });
    // Under 400 px the two "open elsewhere" buttons fold into one menu (CSS swaps them).
    const logMore = moreMenu([
      [I.file, 'Open log file', () => post({ type: 'openLogFile' }), state.dash.logFile || "Today's log file"],
      [I.external, 'Output channel', () => post({ type: 'command', id: 'localpilot.showLogs' }), 'Show the LocalPilot output channel'],
    ], 'log-narrow');
    tools.append(lvl, q, follow, copy, clear, openFile, channel, logMore);
    lc.appendChild(tools);
    const pre = el('div', 'logview'); pre.id = 'logview'; pre.tabIndex = 0; pre.setAttribute('role', 'log'); pre.setAttribute('aria-live', 'polite'); pre.setAttribute('aria-label', 'Log lines'); lc.appendChild(pre);
    const cap = el('p', 'logcap muted small hidden', `Showing the latest ${LOG_CAP} lines; open the log file for everything.`); cap.id = 'logCap'; lc.appendChild(cap);
    sec.appendChild(lc);
    renderLogs();
    // Fresh numbers on open and every 15 s while this page is visible; the log follows live via logLine messages.
    requestDashboard();
    requestLogs();
    if (state.dash.timer) { clearInterval(state.dash.timer); }
    // Nothing new arrives while recording is off, so the tick only ages the "updated" caption.
    state.dash.timer = setInterval(() => { if (state.page === 'settings' && state.section === 'dashboard' && document.visibilityState === 'visible' && !state.dash.loading && (!recordingOff() || recLive())) { requestDashboard(); } else { dashMeta(); } }, 15000);
  }
  // ------------------------------------------------------------------ telemetry
  /** host[:port] of a URL with any user:password@ dropped, so a Redis password never reaches the page. */
  function hostOf(url) {
    const rest = String(url || '').trim().replace(/^[a-z][\w+.-]*:\/\//i, '');
    return rest.split(/[/?#]/)[0].replace(/^.*@/, '');
  }
  const PRIVACY_DEPS = ['telemetry.enabled', 'storage.redis.enabled', 'storage.redis.url', 'telemetry.otlp.enabled', 'telemetry.otlp.endpoint'];
  /** Where usage data goes besides this machine: the Redis server, the user's OTLP collector, the organisation's collector. */
  function telemetryDests() {
    const otlp = state.data && state.data.otlp;
    const org = POLICY() && POLICY().telemetryEndpoint;
    return [...new Set([
      val('storage.redis.enabled') === true && hostOf(val('storage.redis.url') || 'redis://127.0.0.1:6379'),
      // Export needs local recording; an OTEL_EXPORTER_OTLP_ENDPOINT variable decides where it goes.
      !org && effVal('telemetry.otlp.enabled') === true && effVal('telemetry.enabled') !== false && hostOf((otlp && otlp.endpoint) || val('telemetry.otlp.endpoint')),
      org && hostOf(org),
    ].filter(Boolean))];
  }
  const privacyText = () => { const d = telemetryDests(); return d.length ? `Usage recorded on this machine and exported to ${d.map((h) => `<code>${esc(h)}</code>`).join(', ')}.` : 'Usage recorded on this machine in <code>~/.localpilot/telemetry</code>; nothing is sent anywhere.'; };
  const privacyLead = () => component(el('p', 'lead', privacyText()), PRIVACY_DEPS, privacyLead);
  /** OTEL_* variables in VS Code's environment win over these settings; such a row says so and cannot be edited. */
  const OTLP_ENV = { 'telemetry.otlp.endpoint': ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'], 'telemetry.otlp.headers': ['OTEL_EXPORTER_OTLP_HEADERS'], 'telemetry.otlp.metricsInterval': ['OTEL_METRIC_EXPORT_INTERVAL'] };
  const otlpEnvVars = (key) => { const env = (state.data && state.data.otlp && state.data.otlp.fromEnv) || []; return (OTLP_ENV[key] || []).filter((v) => env.includes(v)); };
  /** Badges and the reason a telemetry.otlp.* row is unavailable: export is off, or an environment variable decides it. */
  function otlpRow(key) {
    const env = otlpEnvVars(key);
    const badges = env.map((v) => `<span class="badge env" title="Set in the environment VS Code was started from; it overrides this setting">Overridden by ${esc(v)}</span>`).join('');
    const off = effVal('telemetry.otlp.enabled') !== true ? 'Turn on “Send telemetry to an OTLP collector” first' : env.length ? `Overridden by ${env.join(', ')}` : '';
    return { badges, off };
  }
  const OTLP_EXPORTERS = [['otlp', 'Logs & metrics (otlp)'], ['traces', 'Traces (run / model / tool spans)'], ['console', 'Also print exports to the LocalPilot log (console)']];
  function secTelemetry(sec) {
    head(sec, 'Telemetry', '');
    sec.querySelector('.lead').replaceWith(privacyLead());
    sec.appendChild(card(
      field('telemetry.enabled', 'Record usage metrics', 'Model calls, tokens and latency, tool runs, agent turns, inline completions, provider health and worktree actions are appended to daily JSONL files on this machine (or to the Redis server below, when you turn that on) so the Dashboard can show them. Turning it off stops recording and any export; the log is still mirrored for the log viewer. <b>Nothing is sent anywhere you did not configure.</b>', 'toggle'),
      field('telemetry.retentionDays', 'Keep metrics and logs for', 'Older daily files are deleted automatically. <code>0</code> keeps everything.', 'number', { min: 0, max: 3650, step: 1, unit: 'days' })
    ));
    sec.appendChild(el('h2', 'sub', 'Redis storage (optional)'));
    const redisActs = el('div', 'btnrow');
    redisActs.innerHTML = `<span class="muted small">Docker, Homebrew, apt/dnf, WSL or Memurai, or an existing server.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.setupRedis">${I.cpu}Set up Redis…</button>`;
    sec.appendChild(card(
      field('storage.redis.enabled', 'Store telemetry in Redis', 'Events and the log go to capped Redis streams instead of daily files, and — with <b>Redis Stack</b> — metrics become labelled time series (<code>localpilot:ts:*</code>) for Grafana or RedisInsight. VS Code then keeps only a short log tail in memory. Falls back to files whenever Redis is unreachable. <b>Telemetry goes to the server in the URL</b> — keep it on this machine unless you trust that server.', 'toggle', { after: redisActs }),
      redisUrlField()
    ));
    sec.appendChild(el('h2', 'sub', 'Export to your OpenTelemetry collector'));
    const otlpCard = el('div', 'card otlp');
    const orgOtlp = POLICY() && POLICY().telemetryEndpoint;
    if (orgOtlp) { otlpCard.appendChild(el('div', 'policy', `${I.lock}<div><b>${MANAGED_TIP}</b> Usage metrics, traces and the log are exported to <code>${esc(orgOtlp)}</code>, whatever is set below or in <code>OTEL_*</code> variables.</div>`)); }
    otlpCard.appendChild(field('telemetry.otlp.enabled', 'Send telemetry to an OTLP collector', 'OTLP/HTTP JSON to otel-collector, Grafana Alloy, Langfuse, Phoenix… <code>OTEL_EXPORTER_OTLP_*</code> environment variables override these.', 'toggle'));
    otlpCard.appendChild(otlpBody());
    sec.appendChild(otlpCard);
    sec.appendChild(el('h2', 'sub', 'Recorded data'));
    const danger = el('div', 'btnrow');
    danger.innerHTML = `<span class="muted small" id="dashStorage"></span><span class="spacer"></span><button class="btn sm danger" id="dashClear">${I.trash}Delete all recorded data…</button>`;
    danger.querySelector('#dashClear').onclick = () => post({ type: 'clearTelemetry' });
    sec.appendChild(card(danger));
    renderStorage();
    // The storage line under "Delete all recorded data" comes with the dashboard summary.
    if (!state.dash.loading) { requestDashboard(); }
  }
  /** Everything under the OTLP switch. Rebuilt when export is switched or the exporters change (the sample rate shows only with traces). */
  function otlpBody() {
    const box = el('div', 'otlp-body');
    box.appendChild(otlpEndpointField());
    const exp = Array.isArray(effVal('telemetry.otlp.exporters')) ? effVal('telemetry.otlp.exporters') : ['otlp'];
    box.appendChild(otlpExportersField(exp));
    if (exp.includes('traces')) {
      const r = otlpRow('telemetry.otlp.traceSamplePercent');
      box.appendChild(field('telemetry.otlp.traceSamplePercent', 'Trace sample percent', 'Share of agent runs whose spans are exported. Lower it for busy collectors.', 'range', { min: 0, max: 100, step: 5, fmt: (v) => `${v}%`, ...r }));
      const c = otlpRow('telemetry.otlp.recordContent');
      box.appendChild(field('telemetry.otlp.recordContent', 'Include prompts and tool results on spans', '<span class="warn-note">Sends code and conversation text to the collector.</span> Off: spans carry names, timings, token counts and status only.', 'toggle', c));
    }
    const m = otlpRow('telemetry.otlp.metricsInterval');
    box.appendChild(field('telemetry.otlp.metricsInterval', 'Metric export interval', 'How often counters and histograms are pushed.', 'number', { min: 1, max: 3600, step: 1, unit: 's', ...m }));
    box.appendChild(otlpHeadersField());
    return component(box, ['telemetry.otlp.enabled', 'telemetry.otlp.exporters'], otlpBody);
  }
  function otlpEndpointField() {
    const r = otlpRow('telemetry.otlp.endpoint');
    const t = state.otlpTest || {};
    const res = el('div', 'otlp-result');
    res.id = 'otlpResult'; res.setAttribute('role', 'status'); res.setAttribute('aria-live', 'polite');
    res.innerHTML = t.busy ? '<span class="spinner"></span>Sending a test record…' : t.ok ? `<span class="muted">Collector answered HTTP ${esc(t.status)} from <code>${esc(t.url)}</code></span>` : t.error ? `<span class="err-text">${esc(t.error)}${t.url ? ` — <code>${esc(t.url)}</code>` : ''}</span>` : '';
    res.classList.toggle('hidden', !res.innerHTML);
    const f = field('telemetry.otlp.endpoint', 'Endpoint', '<code>/v1/logs</code>, <code>/v1/metrics</code> and <code>/v1/traces</code> are appended.', 'text', { placeholder: 'http://localhost:4318', validate: (v) => /^https?:\/\/\S+$/.test(v), invalidHint: 'Use http(s)://host:port — /v1/logs, /v1/metrics and /v1/traces are appended', after: res, ...r });
    // Tests whatever is in effect (environment variables included), so it is offered whenever export is on.
    const test = el('button', 'btn sm', `${I.bolt}Test connection`); test.title = 'Send one test record to the collector';
    test.disabled = effVal('telemetry.otlp.enabled') !== true || !!t.busy || f.classList.contains('locked');
    if (test.disabled && !t.busy) { test.title = r.off && effVal('telemetry.otlp.enabled') !== true ? r.off : MANAGED_TIP; }
    test.onclick = () => {
      state.otlpTest = { busy: true }; post({ type: 'testOtlp' });
      const fresh = otlpEndpointField(); f.querySelector('#otlpResult').replaceWith(fresh.querySelector('#otlpResult')); test.disabled = true;
    };
    const ctl = f.querySelector('.ctl'); const input = ctl.querySelector('input');
    const row = el('div', 'row'); input.replaceWith(row); row.append(input, test);
    return component(f, ['telemetry.otlp.endpoint'], otlpEndpointField);
  }
  function otlpExportersField(exp) {
    const key = 'telemetry.otlp.exporters';
    const r = otlpRow(key);
    const f = el('div', `field wide${r.off ? ' off' : ''}`);
    f.innerHTML = `<div><div class="lbl">Exporters${r.badges}${scopeBadge(key)}${resetBtn(key)}</div><div class="desc">What is sent. At least one stays on while export is on.</div></div><div class="ctl checks" role="group" aria-label="OTLP exporters"></div>`;
    const ctl = f.querySelector('.ctl');
    for (const [id, label] of OTLP_EXPORTERS) {
      const l = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = exp.includes(id); cb.disabled = !!r.off; if (r.off) { cb.title = r.off; }
      cb.onchange = () => {
        const next = cb.checked ? [...exp.filter((x) => x !== id), id] : exp.filter((x) => x !== id);
        if (!next.length) { cb.checked = true; toast('Keep at least one exporter', 'error'); return; }
        set(key, OTLP_EXPORTERS.map(([x]) => x).filter((x) => next.includes(x)));
      };
      l.append(cb, el('span', '', esc(label))); ctl.appendChild(l);
    }
    const why = policyRefuses(key, undefined);
    if (why) { f.classList.add('locked'); f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(why)); ctl.querySelectorAll('input').forEach((x) => { x.disabled = true; x.title = MANAGED_TIP; }); }
    f.dataset.deps = key;
    return f;
  }
  function otlpHeadersField() {
    const key = 'telemetry.otlp.headers';
    const r = otlpRow(key);
    const f = el('div', `field wide${r.off ? ' off' : ''}`);
    f.innerHTML = `<div><div class="lbl">Headers${r.badges}${scopeBadge(key)}${resetBtn(key)}</div><div class="desc">Sent with every export, e.g. <code>Authorization</code> or <code>x-honeycomb-team</code>. Values are hidden here and in the log.</div></div><div class="ctl"></div>`;
    const ctl = f.querySelector('.ctl');
    const cur = val(key); let pairs = Object.entries(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}).map(([k, v]) => [k, String(v ?? '')]);
    const save = () => { const o = {}; for (const [k, v] of pairs) { if (HEADER_NAME.test(k.trim())) { o[k.trim()] = v; } } if (JSON.stringify(o) !== JSON.stringify(cur || {})) { set(key, o); } };
    const box = el('div', 'kv otlp-headers');
    const draw = () => {
      box.innerHTML = '';
      pairs.forEach(([k, v], idx) => {
        const row = el('div', 'kv-row');
        const ki = el('input'); ki.type = 'text'; ki.value = k; ki.placeholder = 'Header-Name'; ki.setAttribute('aria-label', 'Header name');
        const vi = el('input'); vi.type = 'password'; vi.value = v; vi.placeholder = 'value'; vi.autocomplete = 'off'; vi.setAttribute('aria-label', `Value of ${k || 'the header'}`);
        const rm = el('button', 'btn sm', I.x); rm.title = 'Remove this header'; rm.setAttribute('aria-label', 'Remove this header');
        const change = () => { ki.classList.toggle('invalid', !!ki.value.trim() && !HEADER_NAME.test(ki.value.trim())); pairs[idx] = [ki.value, vi.value]; save(); };
        ki.onchange = change; vi.onchange = change;
        rm.onclick = () => { pairs = pairs.filter((_, j) => j !== idx); save(); draw(); };
        row.append(ki, vi, rm); box.appendChild(row);
      });
      const add = el('button', 'btn sm', `${I.plus}Add header`);
      add.onclick = () => { pairs = [...pairs, ['', '']]; draw(); const ins = box.querySelectorAll('.kv-row input'); if (ins.length) { ins[ins.length - 2].focus(); } };
      box.appendChild(add);
      const why = policyRefuses(key, undefined);
      if (why || r.off) { box.querySelectorAll('input, button').forEach((x) => { x.disabled = true; x.title = why ? MANAGED_TIP : r.off; }); }
    };
    draw();
    ctl.appendChild(box);
    const why = policyRefuses(key, undefined);
    if (why) { f.classList.add('locked'); f.querySelector('.lbl').insertAdjacentHTML('beforeend', lockIcon(why)); }
    return component(f, [key], otlpHeadersField);
  }
  function renderStorage() {
    const n = document.getElementById('dashStorage'); const s = state.dash.summary;
    if (!n || !s) { return; }
    const st = s.storage;
    const where = st.backend === 'redis' ? '<span class="badge ok">Redis</span> ' : st.backend === 'fallback' ? `<span class="badge warn" title="${esc(st.remoteError || '')}">Redis unreachable — using files</span> ` : '';
    refreshRedisStatus();
    n.innerHTML = `${where}${fmtN(st.events)} events · ${fmtBytes(st.bytes)} in ${plural(st.files, 'file')}${st.oldest ? ` · since ${new Date(st.oldest).toLocaleDateString()}` : ''} · <code>${esc(st.dir)}</code>`;
  }
  /** The Redis URL with a status line under it: where telemetry goes right now (from the dashboard summary) and the
   *  result of the last Test connection. */
  function redisUrlField() {
    const box = el('div', 'redis-status'); box.setAttribute('aria-live', 'polite'); box.appendChild(redisStatus());
    const f = field('storage.redis.url', 'Redis URL', '<code>redis://[user:password@]host:port[/db]</code>, <code>rediss://</code> for TLS. Hidden because it can contain a password. Keep it on <code>127.0.0.1</code> unless the server is protected.', 'password', { placeholder: 'redis://127.0.0.1:6379', validate: validRedisUrl, invalidHint: 'Use redis://[user:password@]host[:port][/db] or rediss://… — not saved yet', after: box });
    return component(f, ['storage.redis.url', 'storage.redis.enabled'], redisUrlField);
  }
  function redisStatus() {
    const wrap = el('div', 'redis-lines'); wrap.id = 'redisStatus';
    const on = effVal('storage.redis.enabled') === true;
    const st = state.dash.summary && state.dash.summary.storage;
    const t = state.redisTest || {};
    const host = hostOf(val('storage.redis.url') || 'redis://127.0.0.1:6379');
    const stack = (i) => (!i ? '' : i.timeSeries ? ' · Redis Stack (time series on)' : i.modules && i.modules.length ? ' · time series off (RedisTimeSeries not loaded)' : ' · plain Redis (time series off)');
    const line = (dot, html) => `<div class="redis-line"><span class="dot ${dot}"></span><span>${html}</span></div>`;
    let now;
    if (!on) { now = line('', '<span class="muted">Off · saving to files on this machine</span>'); }
    else if (st && st.backend === 'fallback') { now = line('warn', `<span class="warn-text">Not reachable: ${esc(st.remoteError || 'no answer')}, saving to files</span>`); }
    else if (st && st.backend === 'redis') { now = line('ok', `<span>Connected to <code>${esc(host)}</code><span class="muted">${esc(stack(t.ok && t.info))}</span></span>`); }
    else { now = line('', `<span class="muted">Not checked yet${st ? ' · new data still goes to files' : ''}</span>`); }
    const res = t.busy ? `<div class="redis-line"><span class="spinner"></span><span>Testing <code>${esc(host)}</code>…</span></div>`
      : t.ok && t.info ? `<div class="redis-line muted">${I.check}<span>Test: <code>${esc(t.info.host)}:${esc(t.info.port)}</code> answered in ${esc(t.info.latencyMs)} ms${t.info.version ? ` · Redis ${esc(t.info.version)}` : ''}${esc(stack(t.info))}</span></div>`
        : t.error ? `<div class="redis-line err-text">${I.x}<span>Test failed: ${esc(t.error)}</span></div>` : '';
    wrap.innerHTML = `${now}${res}`;
    const row = el('div', 'btnrow redis-acts');
    const test = el('button', 'btn sm', t.busy ? '<span class="spinner"></span>Testing…' : `${I.bolt}Test connection`); test.title = 'Connect to the saved Redis URL and send PING';
    const why = policyRefuses('storage.redis.url', undefined);
    test.disabled = !!t.busy || !!why; if (why) { test.title = MANAGED_TIP; }
    test.onclick = () => { state.redisTest = { busy: true }; post({ type: 'testRedis' }); refreshRedisStatus(); };
    row.appendChild(test);
    const out = el('div'); out.append(wrap, row);
    return out;
  }
  /** Swaps only the status block, so a URL being typed keeps its text and caret. */
  function refreshRedisStatus() {
    const box = document.querySelector('.redis-status'); if (!box) { return; }
    const had = box.contains(document.activeElement);
    box.replaceChildren(redisStatus());
    if (had) { const b = box.querySelector('.redis-acts .btn'); if (b) { b.focus({ preventScroll: true }); } }
  }
  /** Same rules as the extension's parser: redis:// or rediss://, a host, an optional numeric port and db. */
  function validRedisUrl(v) {
    try {
      const u = new URL(v);
      return (u.protocol === 'redis:' || u.protocol === 'rediss:') && !!u.hostname && (!u.port || Number(u.port) > 0) && /^\/?\d*$/.test(u.pathname);
    } catch {
      return false;
    }
  }
  // Table scrollers: a right-edge fade while columns are hidden off the edge, kept current on resize and scroll.
  const tblRO = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => es.forEach((e) => edgeFade(e.target))) : null;
  let tblScrollers = [];
  function edgeFade(sc) {
    const scrolls = sc.scrollWidth - sc.clientWidth > 1;
    sc.classList.toggle('scrolls', scrolls);
    sc.classList.toggle('more', scrolls && sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 1);
    // A region that scrolls must be reachable from the keyboard.
    if (scrolls) { sc.tabIndex = 0; sc.setAttribute('role', 'region'); sc.setAttribute('aria-label', `${sc.dataset.name || 'Table'} (scrolls sideways)`); } else { sc.removeAttribute('tabindex'); sc.removeAttribute('role'); sc.removeAttribute('aria-label'); }
  }
  /** Wraps each card table in a scroller and copies every column header onto its cells, for the stacked narrow layout. */
  function fitTables(root) {
    if (tblRO) { tblScrollers = tblScrollers.filter((sc) => sc.isConnected || (tblRO.unobserve(sc), false)); }
    root.querySelectorAll('.tblwrap > table.tbl').forEach((t) => {
      const heads = [...t.querySelectorAll('thead th')].map((th) => (th.dataset.label ?? th.textContent).trim());
      if (heads.length) { t.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (heads[i] && !td.hasAttribute('data-label')) { td.dataset.label = heads[i]; } })); }
      const sc = el('div', 'tblscroll'); const h = t.parentElement.querySelector('h3');
      sc.dataset.name = h ? h.firstChild.textContent.trim() : 'Table';
      t.replaceWith(sc); sc.appendChild(t);
      sc.onscroll = () => edgeFade(sc);
      if (tblRO) { tblRO.observe(sc); tblScrollers.push(sc); } else { requestAnimationFrame(() => edgeFade(sc)); }
    });
  }
  /** Provider display name for a recorded provider id (the id itself when the provider is no longer configured). */
  function provName(id) { const p = providersList().find((x) => x.id === id); return p ? p.displayName || p.id : id; }
  /** Model tuning: what usage says about each installed model per role, open suggestions and recent automatic changes. */
  function tuningCard(tu) {
    const c = el('div', 'card tblwrap tuning');
    // The setting is the truth for on/off: a report from before the switch still says the old mode.
    const mode = effVal('models.autoTune') || (tu && tu.mode) || 'auto';
    if (mode === 'off' || !tu) {
      c.innerHTML = `<h3>Model tuning <span class="count">${mode === 'off' ? 'off' : ''}</span></h3><p class="muted small">${mode === 'off' ? 'Off. LocalPilot is not learning from usage.' : 'Model tuning is not available in this window.'}</p>`;
      if (mode === 'off') {
        c.appendChild(field('models.autoTune', 'Learn from usage', '', 'select', { options: [['auto', 'Tune automatically', ''], ['suggest', 'Suggest only', ''], ['off', 'Off', '']] }));
        c.appendChild(el('p', 'small', '<a data-sec="models">Change on Models</a>'));
      }
      return c;
    }
    const modeLabel = mode === 'auto' ? 'tuning automatically' : 'suggesting only';
    const shortId = (id) => id ? id.slice(id.indexOf('/') + 1) : 'auto';
    const conf = (x) => `<span class="badge ${x === 'high' ? 'ok' : x === 'medium' ? '' : 'muted'}">${esc(x)}</span>`;
    let html = `<h3>Model tuning <span class="count">${fmtN(tu.analysed.runs)} runs · ${fmtN(tu.analysed.calls)} model calls · last ${tu.analysed.days} days · ${esc(modeLabel)}</span></h3>`;
    if (!tu.rankings.length) {
      c.innerHTML = `${html}<p class="muted small">No installed models to compare yet.</p><div class="btnrow"><span class="spacer"></span><button class="btn sm" data-retune="1">${I.refresh}Analyse now</button></div>`;
      const re0 = c.querySelector('[data-retune]'); re0.onclick = () => { re0.disabled = true; post({ type: 'retune' }); };
      return c;
    }
    // What an Apply click did, shown in place of its button; an error clears after a while so the row can be tried again.
    const res = state.dash.tuneResults || {}; const now = Date.now();
    for (const [k, v] of Object.entries(res)) { if (!v.pending && now - v.at > (v.ok ? 300e3 : 30e3)) { delete res[k]; } }
    const act = (g, i) => {
      if (g.kind === 'routing') { return '<span class="muted small" title="The setting is on Auto, and Auto routing already uses this model">Auto uses it</span>'; }
      const r = res[`${g.role}|${g.suggested}`];
      if (r && r.pending) { return '<span class="muted small" role="status">Applying…</span>'; }
      if (r && r.ok) { return `<span class="ok-text" role="status">${I.check}Applied</span>`; }
      if (r && r.error) { return `<span class="err-text" role="alert" title="${esc(r.error)}">${esc(r.error)}</span>`; }
      return `<button class="btn sm" data-tune="${i}" aria-label="Use ${esc(shortId(g.suggested))} for ${esc(roleLabel(g.role))}">Apply</button>`;
    };
    if (tu.suggestions.length) {
      html += `<table class="tbl dash-tbl tune"><thead><tr><th>Role</th><th>Suggested</th><th>Instead of</th><th>Confidence</th><th class="act"><span class="sr-only">Apply</span></th></tr></thead><tbody>${tu.suggestions.map((g, i) => `<tr class="sug"><td>${esc(roleLabel(g.role))}</td><td class="mono"><b>${esc(shortId(g.suggested))}</b></td><td class="mono muted">${esc(shortId(g.current))}${g.currentStruggling ? ' <span class="err-text">struggling</span>' : ''}</td><td>${conf(g.confidence)}</td><td class="act">${act(g, i)}</td></tr><tr class="why"><td colspan="5" class="small" data-label="Why">${esc(g.reason)}</td></tr>`).join('')}</tbody></table>`;
    } else {
      html += `<p class="muted small">${tu.analysed.runs + tu.analysed.calls ? 'Your current picks are the best installed fit for every role.' : 'No usage recorded yet — use the chat for a while and LocalPilot learns which installed models work best here.'}</p>`;
    }
    html += `<div class="dash-cols">${tu.rankings.map((r) => `<div><div class="lbl small">${esc(r.label)}${r.current ? ` <span class="muted">· set to ${esc(shortId(r.current))}</span>` : ''}</div><ol class="small rank">${r.models.map((m) => `<li><span class="mono">${esc(shortId(m.id))}</span> <span class="muted">${m.evidence ? esc(m.detail) : 'not measured yet'}${m.bonus ? ` · <span class="${m.bonus > 0 ? 'ok-text' : 'err-text'}">${m.bonus > 0 ? '+' : ''}${m.bonus}</span>` : ''}</span></li>`).join('')}</ol></div>`).join('')}</div>`;
    // Applied suggestions drop out of the list once the dashboard refreshes; say what changed.
    const gone = Object.entries(res).filter(([k, v]) => v.ok && !tu.suggestions.some((g) => `${g.role}|${g.suggested}` === k));
    if (gone.length) { html += `<p class="ok-text small" role="status">${I.check}Applied: ${gone.map(([k]) => { const [role, model] = k.split('|'); return `${esc(shortId(model))} for ${esc(roleLabel(role))}`; }).join(' · ')}</p>`; }
    if (tu.history.length) {
      html += `<p class="muted small">Recent changes: ${tu.history.slice(0, 4).map((h) => `<code>${esc(h.setting)}</code> → ${esc(shortId(h.value))}${h.manual ? ' <span class="badge muted">manual</span>' : ''} (${new Date(h.at).toLocaleString()})`).join(' · ')}</p>`;
    }
    html += `<div class="btnrow"><span class="spacer"></span><button class="btn sm" data-retune="1">${I.refresh}Analyse now</button></div>`;
    c.innerHTML = html;
    c.querySelectorAll('[data-tune]').forEach((b) => { b.onclick = () => { const g = tu.suggestions[Number(b.dataset.tune)]; res[`${g.role}|${g.suggested}`] = { pending: true, at: Date.now() }; state.dash.tuneResults = res; b.parentElement.innerHTML = '<span class="muted small" role="status">Applying…</span>'; post({ type: 'applyTune', role: g.role, model: g.suggested }); }; });
    const re = c.querySelector('[data-retune]'); if (re) { re.onclick = () => { re.disabled = true; for (const k of Object.keys(res)) { if (res[k].error) { delete res[k]; } } post({ type: 'retune' }); }; }
    return c;
  }
  function roleLabel(role) { return ({ agent: 'Chat & agent', reasoning: 'Plan mode', coding: 'Coding subagents', fast: 'Read-only subagents', completion: 'Inline completions', vision: 'Images' })[role] || role; }
  function renderDashboard() {
    const root = document.getElementById('dash');
    if (!root) { return; }
    const s = state.dash.summary;
    const off = recordingOff();
    const turnOn = () => { if (policyRefuses('telemetry.enabled', true)) { return el('span', 'muted small', 'Set by your organization'); } const b = el('button', 'btn sm primary', 'Turn on'); b.title = 'Record usage metrics on this machine again'; b.onclick = () => { b.disabled = true; set('telemetry.enabled', true); }; return b; };
    const offEmpty = () => { const p = el('div', 'empty dash-off'); p.append(el('span', '', 'Recording is off, so nothing is collected.'), turnOn()); return p; };
    // A failed or missing reply keeps the last numbers on screen, dimmed under a retry card.
    const errCard = () => {
      if (!state.dash.error) { return null; }
      const c = el('div', 'policy dash-err'); c.setAttribute('role', 'alert');
      c.innerHTML = `${I.x}<div>Could not load usage metrics: ${esc(state.dash.error)}</div>`;
      const b = el('button', 'btn sm', `${I.refresh}Try again`); b.onclick = () => { state.dash.error = ''; state.dash.manual = true; renderDashboard(); requestDashboard(); }; c.appendChild(b);
      return c;
    };
    const finish = () => { const e = errCard(); root.classList.toggle('errored', !!e); if (e) { root.prepend(e); } dashBusy(); };
    if (!s) {
      root.replaceChildren(...(state.dash.loading ? [skeleton('Loading usage metrics…', 6, 'kpis')] : off ? [offEmpty()] : state.dash.error ? [] : [el('p', 'empty', 'No data yet.')]));
      return finish();
    }
    const t = s.totals;
    const empty = !t.runs && !t.modelCalls && !s.completions.requested && !s.health.length;
    if (empty) {
      if (off) { root.replaceChildren(offEmpty()); } else { root.innerHTML = `<p class="empty">Nothing recorded in this period yet. Start a chat, use inline completions or run the CLI and the numbers appear here.</p>`; }
      return finish();
    }
    const tokens = t.promptTokens + t.completionTokens;
    const okRate = t.runs ? Math.round((t.done / t.runs) * 100) : 0;
    const topTps = s.models.filter((m) => m.tokPerSec).sort((a, b) => b.tokPerSec - a.tokPerSec)[0];
    const health = s.health;
    const up = health.filter((h) => h.up).length;
    const c = s.completions;
    const ed = s.activity && s.activity.edits;
    const keptLines = ed ? ed.acceptedAdded + ed.acceptedRemoved : 0;
    const undoneLines = ed ? ed.rejectedAdded + ed.rejectedRemoved : 0;
    const hk = s.activity && s.activity.hooks;
    const hookFails = hk ? hk.failed + hk.timeout : 0;
    // Calls that carried a price; older summaries without the provider split count every call of a priced model.
    const priced = Array.isArray(s.providers) ? s.providers.reduce((a, p) => a + (p.pricedCalls || 0), 0) : s.models.filter((m) => m.costUsd !== undefined).reduce((a, m) => a + m.calls, 0);
    const free = !t.costUsd && !priced;
    // Tiles in reading order: the headline numbers first, then the detail. A tile with nothing to show yet is listed on one
    // muted line under the grid instead of taking a box of its own.
    const ser = (pick, what, fmt) => spark(s.series, pick, what, fmt);
    const tiles = [
      ['Agent runs', fmtN(t.runs), `${t.done} done · ${t.stopped} stopped · <span class="${t.failed ? 'err-text' : ''}">${t.failed} failed</span>${t.subagentRuns ? ` · ${t.subagentRuns} subagent` : ''}`, ser((d) => d.runs, 'Agent runs per day'), t.failed && okRate < 70 ? 'warn' : ''],
      ['Tokens', fmtN(tokens), `${fmtN(t.promptTokens)} in · ${fmtN(t.completionTokens)} out${topTps ? ` · best <b>${topTps.tokPerSec}</b> tok/s` : ''}`, ser((d) => d.tokens, 'Tokens per day')],
      !t.modelCalls ? ['Cost', '—'] : free ? ['Cost', 'Free', 'all calls ran locally'] : ['Cost', fmtUsd(t.costUsd || 0), `${fmtN(priced)} priced call${priced === 1 ? '' : 's'}${t.runs ? ` · avg <b>${fmtUsd((t.costUsd || 0) / t.runs)}</b> per run` : ''}`, ser((d) => d.costUsd || 0, 'Cost per day', fmtUsd)],
      ['Providers', health.length ? `${up}/${health.length} up` : '—', health.length ? health.map((h) => `<span class="dot ${h.up ? 'ok' : 'err'}"></span>${esc(provName(h.provider))} ${pct(h.uptime)}`).join(' · ') : '', '', health.length && up < health.length ? 'warn' : ''],
      ['Model calls', fmtN(t.modelCalls), `${t.retries} retr${t.retries === 1 ? 'y' : 'ies'} · <span class="${t.modelErrors ? 'err-text' : ''}">${t.modelErrors} error${t.modelErrors === 1 ? '' : 's'}</span>`, ser((d) => d.modelCalls, 'Model calls per day')],
      ['Tool calls', fmtN(t.toolCalls), `<span class="${t.toolErrors ? 'err-text' : ''}">${t.toolErrors} failed</span>${t.toolCalls ? ` · ${pct(100 - (t.toolErrors / t.toolCalls) * 100)} ok` : ''}`, ser((d) => d.toolCalls, 'Tool calls per day')],
      ['Completions', c.shown + c.cached ? pct(c.acceptanceRate) : '—', `${fmtN(c.accepted)} accepted of ${fmtN(c.shown + c.cached)} shown · ${fmtN(c.requested)} requested${c.latency.p50 ? ` · ${fmtMs(c.latency.p50)} median` : ''}`, ser((d) => d.completionsShown, 'Inline completions shown per day')],
      ['Throughput', t.tokPerSec ? `${t.tokPerSec} <span class="kpi-u">tok/s</span>` : '—', `generation speed across all calls${topTps ? ` · fastest ${esc(topTps.model)}` : ''}`, ser((d) => d.tokPerSec, 'Tokens per second by day')],
      ['Turn time', t.runTime.p50 ? fmtMs(t.runTime.p50) : '—', `median · p95 ${fmtMs(t.runTime.p95)} · ${t.steps.p50} step${t.steps.p50 === 1 ? '' : 's'} per turn`, ''],
      ['Cache hits', t.toolCalls ? pct((t.cachedTools / t.toolCalls) * 100) : '—', `${fmtN(t.cachedTools)} read-only tool calls answered from the turn cache`, ser((d) => d.cachedTools, 'Cached tool calls per day')],
      ['Edits kept', keptLines + undoneLines ? pct((keptLines / (keptLines + undoneLines)) * 100) : '—', ed && ed.accepted + ed.rejected ? `+${fmtN(ed.acceptedAdded)} −${fmtN(ed.acceptedRemoved)} lines kept · <span class="${undoneLines ? 'err-text' : ''}">+${fmtN(ed.rejectedAdded)} −${fmtN(ed.rejectedRemoved)}</span> undone${ed.acceptedFiles + ed.rejectedFiles ? ` · files ${fmtN(ed.acceptedFiles)} kept / ${fmtN(ed.rejectedFiles)} undone` : ''}` : '', ser((d) => d.acceptedLines || 0, 'Lines kept per day')],
      ['Hooks', hk && hk.runs ? fmtN(hk.runs) : '—', hk && hk.runs ? `<span class="${hookFails ? 'err-text' : ''}">${hookFails} failed</span>${hk.timeout ? ` (${hk.timeout} timed out)` : ''} · ${hk.blocked} blocked${hk.duration.p50 ? ` · ${fmtMs(hk.duration.p50)} median` : ''}` : '', ser((d) => d.hookFailures || 0, 'Hook failures per day'), hookFails ? 'warn' : ''],
    ];
    const kpis = el('div', 'kpis');
    kpis.innerHTML = tiles.filter((k) => k[1] !== '—').map(([label, value, sub, sp, tone]) => kpi(label, value, sub, sp, tone)).join('');
    const noData = tiles.filter((k) => k[1] === '—').map((k) => k[0]);
    root.innerHTML = '';
    if (off) {
      const lastDay = [...s.series].reverse().find((d) => d.runs || d.modelCalls || d.toolCalls || d.completionsShown);
      const ban = el('div', 'policy dash-rec');
      ban.innerHTML = `${I.pulse}<div><b>Recording is off.</b> ${lastDay ? `These numbers stop at ${esc(dayLabel(lastDay.day))}.` : 'Nothing new is recorded.'}</div>`;
      ban.appendChild(turnOn()); root.appendChild(ban);
    }
    root.appendChild(kpis);
    if (noData.length) { root.appendChild(el('p', 'muted small kpi-none', `No data yet: ${noData.map(esc).join(' · ')}`)); }
    root.appendChild(tuningCard(state.dash.tuning));
    // Charts: activity per day, tokens in/out, generation speed, outcomes, tool reliability, hour of day.
    const many = s.series.length > 1;
    if (many) {
      const charts = el('div', 'dash-cols charts');
      const act = el('div', 'card');
      act.innerHTML = `<h3>Activity <span class="count">${t.activeDays} of ${s.series.length} day${s.series.length === 1 ? '' : 's'} active</span></h3>`;
      act.appendChild(chartSlot((w) => barChart(s.series, [{ label: 'Model calls', pick: (d) => d.modelCalls }, { label: 'Tool calls', pick: (d) => d.toolCalls }, { label: 'Agent runs', pick: (d) => d.runs }, { label: 'Errors', cls: 'err', pick: (d) => d.errors }], { title: 'Activity per day' }, w)));
      charts.appendChild(act);
      const tok = el('div', 'card');
      tok.innerHTML = `<h3>Tokens <span class="count">${fmtN(tokens)}</span></h3>`;
      tok.appendChild(chartSlot((w) => barChart(s.series, [{ label: 'Prompt (in)', pick: (d) => d.promptTokens }, { label: 'Completion (out)', pick: (d) => d.completionTokens }], { stacked: true, title: 'Tokens per day' }, w)));
      charts.appendChild(tok);
      if (t.costUsd > 0) { charts.appendChild(spendCard(s)); }
      root.appendChild(charts);
      const charts2 = el('div', 'dash-cols charts');
      const spd = el('div', 'card');
      spd.innerHTML = `<h3>Generation speed <span class="count">tok/s per day</span></h3>`;
      spd.appendChild(chartSlot((w) => lineChart(s.series, [{ label: 'Completion tokens / s', pick: (d) => d.tokPerSec }], { fmt: (v) => `${Math.round(v)}`, title: 'Generation speed in tokens per second', avg: true }, w)));
      charts2.appendChild(spd);
      const acc = el('div', 'card');
      acc.innerHTML = `<h3>Completions <span class="count">shown vs accepted</span></h3>`;
      acc.appendChild(chartSlot((w) => barChart(s.series, [{ label: 'Shown', pick: (d) => d.completionsShown }, { label: 'Accepted', pick: (d) => d.completionsAccepted }], { title: 'Inline completions per day' }, w)));
      charts2.appendChild(acc);
      root.appendChild(charts2);
    } else {
      // One day has no daily trend to draw, so its hours take the charts slot.
      const charts = el('div', 'dash-cols charts one');
      const hrs = el('div', 'card');
      const peak = s.hourly.indexOf(Math.max(...s.hourly));
      hrs.innerHTML = `<h3>${state.dash.days === 1 ? 'Today by hour' : 'By hour'} <span class="count">${s.hourly.some(Boolean) ? `busiest ${String(peak).padStart(2, '0')}:00` : ''}</span></h3>` + (s.hourly.some(Boolean) ? '' : '<p class="empty">No activity yet.</p>');
      if (s.hourly.some(Boolean)) { hrs.appendChild(chartSlot((w) => hourChart(s.hourly, w), 180, 640)); }
      charts.appendChild(hrs);
      root.appendChild(charts);
    }
    const rings = el('div', 'dash-cols rings');
    const oc = el('div', 'card');
    oc.innerHTML = `<h3>Run outcomes</h3>` + (t.runs ? donut([{ label: 'Done', value: t.done, cls: 'ok' }, { label: 'Stopped', value: t.stopped, cls: 'muted' }, { label: 'Failed', value: t.failed, cls: 'err' }], pct(okRate), 'completed') : '<p class="empty">No runs yet.</p>');
    rings.appendChild(oc);
    const tc = el('div', 'card');
    tc.innerHTML = `<h3>Tool reliability</h3>` + (t.toolCalls ? donut([{ label: 'Succeeded', value: t.toolCalls - t.toolErrors - t.cachedTools, cls: 'ok' }, { label: 'From cache', value: t.cachedTools, cls: 's0' }, { label: 'Failed', value: t.toolErrors, cls: 'err' }], pct(100 - (t.toolErrors / t.toolCalls) * 100), 'ok') : '<p class="empty">No tool calls yet.</p>');
    rings.appendChild(tc);
    if (many) {
      const hc0 = el('div', 'card');
      const peak = s.hourly.indexOf(Math.max(...s.hourly));
      hc0.innerHTML = `<h3>Activity by hour <span class="count">${s.hourly.some(Boolean) ? `busiest ${String(peak).padStart(2, '0')}:00` : ''}</span></h3>` + (s.hourly.some(Boolean) ? '' : '<p class="empty">No activity yet.</p>');
      if (s.hourly.some(Boolean)) { hc0.appendChild(chartSlot((w) => hourChart(s.hourly, w), 180, 360)); }
      rings.appendChild(hc0);
    }
    root.appendChild(rings);
    // Models
    const cols = el('div', 'dash-cols');
    const models = el('div', 'card tblwrap');
    const so = state.dash.sort || { key: 'calls', dir: 'desc' };
    const sorted = [...s.models].sort((a, b) => (MODEL_SORTS[so.key](a) - MODEL_SORTS[so.key](b)) * (so.dir === 'asc' ? 1 : -1) || b.calls - a.calls);
    const sth = (key, label, title) => `<th data-label="${label}"${so.key === key ? ` aria-sort="${so.dir === 'asc' ? 'ascending' : 'descending'}"` : ''}${title ? ` title="${title}"` : ''}><button class="th-sort${so.key === key ? ' on' : ''}" data-sort="${key}">${label}<span class="arr" aria-hidden="true">${so.key === key ? (so.dir === 'asc' ? '↑' : '↓') : '↕'}</span></button></th>`;
    const latency = (m) => (m.ttft.p50 || m.duration.p50 ? `<span class="pctl" title="p95: first token ${fmtMs(m.ttft.p95)} · request ${fmtMs(m.duration.p95)}">${m.ttft.p50 ? fmtMs(m.ttft.p50) : '—'} <i>·</i> ${fmtMs(m.duration.p50)}</span>` : '<span class="muted">—</span>');
    // Stacked rows have no header to click, so a narrow dashboard sorts with a menu instead.
    const sortSel = s.models.length > 1 ? `<select class="dash-sort" aria-label="Sort models">${[['calls', 'Calls'], ['tokens', 'Tokens'], ['cost', 'Cost'], ['tps', 'tok/s'], ['errors', 'Errors']].map(([k, l]) => `<option value="${k}"${so.key === k ? ' selected' : ''}>${l}</option>`).join('')}</select>` : '';
    models.innerHTML = `<h3>Models <span class="count">${s.models.length}</span>${sortSel}</h3>` + (s.models.length ? `<table class="tbl dash-tbl models"><thead><tr><th>Model</th>${sth('calls', 'Calls')}${sth('tokens', 'Tokens', 'tokens in / out')}${sth('cost', 'Cost', 'provider-reported cost, or the bundled prices; local models are free')}${sth('tps', 'tok/s', 'completion tokens per second of generation')}<th data-label="Latency" title="median time to first token · median whole request; hover a value for the 95th percentile">Latency</th>${sth('errors', 'Errors')}</tr></thead><tbody>${sorted.map((m) => `<tr><td class="mono"><b>${esc(m.model)}</b><span class="muted small"> · ${esc(provName(m.provider))}</span></td><td>${fmtN(m.calls)}</td><td>${fmtN(m.promptTokens)} / ${fmtN(m.completionTokens)}</td><td class="${m.costUsd ? '' : 'muted'}"${m.costUsd === undefined ? ' title="local · free"' : ''}>${fmtUsd(m.costUsd)}</td><td>${m.tokPerSec ? `<b>${m.tokPerSec}</b>` : '—'}</td><td>${latency(m)}</td><td class="${m.errors ? 'err-text' : 'muted'}">${m.errors}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No model calls in this period.</p>');
    const ss = models.querySelector('.dash-sort'); if (ss) { ss.onchange = () => { state.dash.sort = { key: ss.value, dir: 'desc' }; renderDashboard(); const n = document.querySelector('#dash .dash-sort'); if (n) { n.focus({ preventScroll: true }); } }; }
    models.querySelectorAll('[data-sort]').forEach((b) => { b.onclick = () => { const k = b.dataset.sort; state.dash.sort = { key: k, dir: so.key === k && so.dir === 'desc' ? 'asc' : 'desc' }; renderDashboard(); const n = document.querySelector(`#dash [data-sort="${k}"]`); if (n) { n.focus({ preventScroll: true }); } }; });
    cols.appendChild(models);
    // Modes
    const modes = el('div', 'card tblwrap');
    modes.innerHTML = `<h3>Runs by mode <span class="count">${fmtN(t.runs)}</span></h3>` + (s.modes.length ? `<table class="tbl dash-tbl"><thead><tr><th>Mode</th><th>Runs</th><th>Done</th><th>Stopped</th><th>Failed</th><th title="model steps per run: median / p95">Steps</th><th title="turn time: median / p95">Duration</th><th>Tools</th></tr></thead><tbody>${s.modes.map((m) => `<tr><td><span class="badge">${esc(m.mode)}</span></td><td>${m.runs}</td><td>${m.done}</td><td class="muted">${m.stopped}</td><td class="${m.failed ? 'err-text' : 'muted'}">${m.failed}</td><td>${m.steps.p50} <i class="muted">/ ${m.steps.p95}</i></td><td>${pctl(m.duration)}</td><td>${fmtN(m.toolCalls)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No agent runs in this period.</p>');
    cols.appendChild(modes);
    root.appendChild(cols);
    const cols2 = el('div', 'dash-cols');
    // Tools
    const toolsCard = el('div', 'card tblwrap');
    toolsCard.innerHTML = `<h3>Tools <span class="count">${s.tools.length}</span></h3>` + (s.tools.length ? `<table class="tbl dash-tbl"><thead><tr><th>Tool</th><th>Calls</th><th>Failed</th><th>Cached</th><th title="median / p95">Duration</th><th>Share</th></tr></thead><tbody>${s.tools.slice(0, 14).map((x) => { const share = t.toolCalls ? (x.calls / t.toolCalls) * 100 : 0; return `<tr><td class="mono">${esc(x.name)}</td><td>${fmtN(x.calls)}</td><td class="${x.errors ? 'err-text' : 'muted'}">${x.errors}${x.calls ? ` <i class="muted">(${pct((x.errors / x.calls) * 100)})</i>` : ''}</td><td class="muted">${x.cached || ''}</td><td>${pctl(x.duration)}</td><td><span class="meter" title="${pct(share)} of all tool calls"><i style="width:${share.toFixed(1)}%"></i></span></td></tr>`; }).join('')}</tbody></table>${s.tools.length > 14 ? `<p class="muted small">…and ${s.tools.length - 14} more</p>` : ''}` : '<p class="empty">No tool calls in this period.</p>');
    cols2.appendChild(toolsCard);
    // Health + completions + worktrees
    const side = el('div', 'dash-side');
    const hc = el('div', 'card');
    hc.innerHTML = `<h3>Provider health</h3>` + (health.length ? `<ul class="hlist">${health.map((h) => `<li><span class="dot ${h.up ? 'ok' : 'err'}"></span><b>${esc(provName(h.provider))}</b><span class="muted small">${h.up ? `up · ${h.models ?? 0} model${h.models === 1 ? '' : 's'}` : `down · ${esc(h.lastError || 'unreachable')}`}</span><span class="spacer"></span><span class="small" title="${h.ok} of ${h.checks} checks reachable">${pct(h.uptime)}</span><span class="muted small" title="probe latency: median / p95">${h.latency.p50 ? fmtMs(h.latency.p50) : ''}</span></li>`).join('')}</ul>` : '<p class="empty">No provider checks yet.</p>');
    side.appendChild(hc);
    const cc = el('div', 'card');
    cc.innerHTML = `<h3>Inline completions</h3><dl class="kv dashkv"><dt>Requested</dt><dd>${fmtN(c.requested)}</dd><dt>Shown</dt><dd>${fmtN(c.shown)}${c.cached ? ` <span class="muted small">+ ${fmtN(c.cached)} from cache</span>` : ''}</dd><dt>Accepted</dt><dd><b>${fmtN(c.accepted)}</b>${c.shown + c.cached ? ` <span class="muted small">(${pct(c.acceptanceRate)})</span>` : ''}</dd><dt>Empty / failed</dt><dd class="muted">${c.empty} / ${c.error}</dd><dt>Latency</dt><dd>${pctl(c.latency)}</dd></dl>${c.byLanguage.length ? `<div class="chips small">${c.byLanguage.map((l) => `<span class="chip" title="${l.accepted} accepted of ${l.shown} shown">${esc(l.language)} <i class="muted">${l.shown ? pct((l.accepted / l.shown) * 100) : '0%'}</i></span>`).join('')}</div>` : ''}`;
    side.appendChild(cc);
    const wc = el('div', 'card');
    const w = s.worktrees;
    wc.innerHTML = `<h3>Isolated worktrees</h3><dl class="kv dashkv"><dt>Isolated runs</dt><dd>${fmtN(t.isolatedRuns || 0)}${t.runs ? ` <span class="muted small">(${pct(((t.isolatedRuns || 0) / t.runs) * 100)})</span>` : ''}</dd><dt>Created</dt><dd>${w.created}</dd><dt>Applied</dt><dd>${w.applied}<span class="muted small"> · ${w.files} file${w.files === 1 ? '' : 's'}</span></dd><dt>Discarded</dt><dd class="muted">${w.discarded}</dd><dt>Conflicts</dt><dd class="${w.conflicts ? 'err-text' : 'muted'}">${w.conflicts}</dd></dl>`;
    side.appendChild(wc);
    if (s.agents && s.agents.length) {
      const ag = el('div', 'card tblwrap');
      ag.innerHTML = `<h3>Subagents <span class="count">${fmtN(t.subagentRuns)} runs</span></h3><table class="tbl dash-tbl"><thead><tr><th>Agent</th><th>Runs</th><th>Done</th><th>Failed</th><th title="median / p95">Duration</th><th>Tools</th></tr></thead><tbody>${s.agents.map((a) => `<tr><td><span class="badge">${esc(a.agent)}</span></td><td>${a.runs}</td><td>${a.done}</td><td class="${a.failed ? 'err-text' : 'muted'}">${a.failed}</td><td>${pctl(a.duration)}</td><td>${fmtN(a.toolCalls)}</td></tr>`).join('')}</tbody></table>`;
      side.appendChild(ag);
    }
    cols2.appendChild(side);
    root.appendChild(cols2);
    const actCards = activityCards(s);
    if (actCards.length === 1) { root.appendChild(actCards[0]); } else if (actCards.length) {
      const cols3 = el('div', 'dash-cols'); cols3.appendChild(actCards[0]);
      const side3 = el('div', 'dash-side'); actCards.slice(1).forEach((x) => side3.appendChild(x)); cols3.appendChild(side3);
      root.appendChild(cols3);
    }
    // Recent errors
    if (s.errors.length) { root.appendChild(problemsCard(s.errors)); }
    root.querySelectorAll('[data-sec]').forEach((a) => { a.onclick = () => { state.section = a.dataset.sec; render(); }; });
    drawCharts(root);
    if (!chartRO && typeof ResizeObserver === 'function') { chartRO = new ResizeObserver(() => { cancelAnimationFrame(chartRaf); chartRaf = requestAnimationFrame(() => { const r = document.getElementById('dash'); if (r) { drawCharts(r); } }); }); }
    if (chartRO) { chartRO.disconnect(); chartRO.observe(root); }
    fitTables(root);
    finish();
    renderStorage();
  }
  const ERR_KINDS = [['', 'All'], ['model', 'Model'], ['tool', 'Tool'], ['run', 'Run'], ['health', 'Health'], ['hook', 'Hook'], ['mcp', 'MCP']];
  /** Recent problems, filterable by kind. A row opens the log at that problem: filter = what failed, warnings and up. */
  function problemsCard(errors) {
    const d = state.dash; const kind = d.errKind || '';
    const count = (k) => (k ? errors.filter((e) => e.kind === k).length : errors.length);
    const list = kind ? errors.filter((e) => e.kind === kind) : errors;
    const shown = d.errAll ? list : list.slice(0, 12);
    const ec = el('div', 'card probs');
    ec.innerHTML = `<h3>Recent problems <span class="count">${errors.length}</span></h3>`;
    const chips = el('div', 'chips small err-kinds'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Show problems of kind');
    for (const [k, l] of ERR_KINDS) {
      const n = count(k); if (k && !n && k !== kind) { continue; }
      const b = el('button', `chip${k === kind ? ' on' : ''}`, `${esc(l)}<i>${n}</i>`); b.setAttribute('aria-pressed', String(k === kind));
      b.onclick = () => { if (k === kind) { return; } d.errKind = k; d.errAll = false; const fresh = problemsCard(errors); ec.replaceWith(fresh); const nb = fresh.querySelector('.err-kinds .chip.on'); if (nb) { nb.focus({ preventScroll: true }); } };
      chips.appendChild(b);
    }
    ec.appendChild(chips);
    const ul = el('ul', 'errlist');
    for (const e of shown) {
      const li = el('li', '');
      const what = e.kind === 'health' ? provName(e.what) : e.what;
      const row = el('button', 'err-row', `<span class="et muted" title="${esc(new Date(e.t).toLocaleString())}">${fmtAgo(e.t)}</span><span class="badge ${e.kind === 'health' ? 'warn' : 'err'}">${esc(e.kind)}</span><span class="ew mono" title="${esc(what)}">${esc(what)}</span><span class="ed muted" title="${esc(e.detail)}">${esc(e.detail)}</span>`);
      row.title = 'Show matching warnings and errors in the log below';
      row.onclick = () => showInLog(e.what);
      li.appendChild(row);
      if (e.kind === 'health') { const a = el('button', 'inline-link', 'Providers'); a.dataset.sec = 'providers'; a.title = 'Check this provider on the Providers page'; a.onclick = () => { state.section = 'providers'; render(); }; li.appendChild(a); }
      ul.appendChild(li);
    }
    if (!shown.length) { ec.appendChild(el('p', 'muted small', 'No problems of this kind in this period.')); } else { ec.appendChild(ul); }
    if (list.length > 12) {
      const more = el('button', 'inline-link err-more', d.errAll ? 'Show fewer' : `Show all (${list.length})`);
      more.onclick = () => { d.errAll = !d.errAll; const fresh = problemsCard(errors); ec.replaceWith(fresh); const nb = fresh.querySelector('.err-more'); if (nb) { nb.focus({ preventScroll: true }); } };
      ec.appendChild(el('p', 'dash-foot small')).appendChild(more);
    }
    return ec;
  }
  /** Filters the log viewer to one problem and brings it into view. */
  function showInLog(what) {
    state.dash.q = String(what || ''); state.dash.level = 'warn';
    const q = document.getElementById('logQ'); if (q) { q.value = state.dash.q; }
    const lvl = document.getElementById('logLevel'); if (lvl) { lvl.value = 'warn'; }
    requestLogs();
    const v = document.getElementById('logview');
    if (v) { v.closest('.logcard').scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' }); v.focus({ preventScroll: true }); }
  }
  const MODEL_SORTS = { calls: (m) => m.calls, tokens: (m) => m.promptTokens + m.completionTokens, cost: (m) => m.costUsd ?? -1, tps: (m) => m.tokPerSec || 0, errors: (m) => m.errors };
  /** Spend per day, stacked by provider when the summary splits it (the three biggest, the rest as Other). */
  function spendCard(s) {
    const t = s.totals; const card = el('div', 'card');
    const spenders = (s.providers || []).filter((p) => p.costUsd > 0);
    const split = spenders.length > 1 && s.series.some((d) => d.costByProvider);
    let keys = [{ label: spenders.length === 1 ? `${provName(spenders[0].provider)} ${usdText(spenders[0].costUsd)}` : 'Spend', pick: (d) => d.costUsd || 0 }];
    if (split) {
      const by = (d, id) => (d.costByProvider || {})[id] || 0;
      const rest = spenders.slice(3);
      keys = spenders.slice(0, 3).map((p) => ({ label: `${provName(p.provider)} ${usdText(p.costUsd)}`, pick: (d) => by(d, p.provider) }));
      if (rest.length) { keys.push({ label: `Other ${usdText(rest.reduce((a, p) => a + p.costUsd, 0))}`, pick: (d) => rest.reduce((a, p) => a + by(d, p.provider), 0) }); }
    }
    card.innerHTML = `<h3>Spend <span class="count">${fmtUsd(t.costUsd)}${spenders.length > 1 ? ` · ${spenders.length} providers` : ''}</span></h3>`;
    card.appendChild(chartSlot((w) => barChart(s.series, keys, { stacked: true, fmt: usdText, floor: 0.0001, title: 'Spend per day' }, w)));
    return card;
  }
  /** MCP servers, hooks by event and the choices the user made (slash commands, mentions, modes, models, checkpoints, tasks). */
  function activityCards(s) {
    const a = s.activity; if (!a) { return []; }
    const out = [];
    const mcpSet = Object.keys(val('mcpServers') || {}).length + (state.data.mcp || []).length;
    if (a.mcp && (a.mcp.calls || mcpSet)) {
      const mc = el('div', 'card tblwrap');
      const srv = a.mcp.servers || [];
      mc.innerHTML = `<h3>MCP servers <span class="count">${srv.length ? `${plural(srv.length, 'server')} · ` : ''}${plural(a.mcp.calls, 'call')}</span></h3>` + (a.mcp.calls ? `<table class="tbl dash-tbl"><thead><tr><th>Server</th><th>Calls</th><th>Failed</th><th title="median / p95">Duration</th><th>Share</th></tr></thead><tbody>${srv.map((m) => { const share = (m.calls / a.mcp.calls) * 100; return `<tr><td class="mono">${esc(m.server)}</td><td>${fmtN(m.calls)}</td><td class="${m.errors ? 'err-text' : 'muted'}">${m.errors}${m.calls ? ` <i class="muted">(${pct((m.errors / m.calls) * 100)})</i>` : ''}</td><td>${pctl(m.duration)}</td><td><span class="meter" title="${pct(share)} of all MCP calls"><i style="width:${share.toFixed(1)}%"></i></span></td></tr>`; }).join('')}</tbody></table><p class="dash-foot muted small"><button class="inline-link" data-sec="mcp">MCP servers</button></p>` : `<p class="empty">No MCP tool calls in this period. <button class="inline-link" data-sec="mcp">MCP servers</button></p>`);
      out.push(mc);
    }
    const hk = a.hooks;
    if (hk && hk.runs) {
      const hc = el('div', 'card tblwrap');
      hc.innerHTML = `<h3>Hooks <span class="count">${plural(hk.runs, 'run')}</span></h3>` + (hk.byEvent.length ? `<table class="tbl dash-tbl"><thead><tr><th>Event</th><th>Runs</th><th>Failures</th></tr></thead><tbody>${hk.byEvent.map((e) => `<tr><td class="mono">${esc(e.event)}</td><td>${fmtN(e.runs)}</td><td class="${e.failures ? 'err-text' : 'muted'}">${e.failures}</td></tr>`).join('')}</tbody></table>` : '') + `<p class="dash-foot muted small">${hk.ok} ok · ${hk.blocked} blocked · <span class="${hk.failed ? 'err-text' : ''}">${hk.failed} failed</span> · <span class="${hk.timeout ? 'err-text' : ''}">${hk.timeout} timed out</span> · <button class="inline-link" data-sec="customize">Customize hooks</button></p>`;
      out.push(hc);
    }
    const chips = (list, label, n) => list && list.length ? `<div class="chips small">${list.slice(0, n).map((x) => `<span class="chip">${esc(label(x))}<i>${fmtN(x.count)}</i></span>`).join('')}</div>` : '';
    const parts = (pairs) => pairs.filter(([n]) => n).map(([n, l, cls]) => `<span class="${cls || ''}">${fmtN(n)} ${l}</span>`).join(' · ');
    const cp = a.checkpoints || {}; const tk = a.tasks || {};
    const rows = [
      ['Tasks', parts([[tk.created, 'created'], [tk.completed, 'completed'], [tk.aborted, 'aborted'], [tk.failed, 'failed', 'err-text'], [tk.mistakeLimit, 'hit mistake limit', 'warn-text']])],
      ['Slash commands', chips(a.slash, (x) => (String(x.command).startsWith('/') ? x.command : `/${x.command}`), 8)],
      ['Mentions', chips(a.mentions, (x) => `@${x.kind}`, 10)],
      ['Mode switches', chips(a.modeSwitches, (x) => x.to, 10)],
      ['Models picked', chips(a.modelSelections, (x) => x.model.slice(x.model.indexOf('/') + 1), 5)],
      ['Checkpoints', parts([[cp.created, 'created'], [cp.restores, 'restored'], [cp.rewinds, 'rewound'], [cp.failed, 'failed', 'err-text']])],
    ].filter(([, v]) => v);
    if (rows.length) {
      const hw = el('div', 'card');
      hw.innerHTML = `<h3>How you work</h3><dl class="kv dashkv habits">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
      out.push(hw);
    }
    return out;
  }
  const LOG_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  const LOG_CAP = 500;
  const startOfToday = () => new Date().setHours(0, 0, 0, 0);
  function logLine(e) { return `<div class="ll ${e.level}"><span class="lt" title="${esc(new Date(e.t).toISOString())}">${fmtTime(e.t, true)}</span><span class="lv">${e.level}</span><span class="lm">${esc(e.msg)}</span></div>`; }
  /** The count in the heading, the wider time column once a line from an earlier day is shown, and the cap notice. */
  function logChrome(v) {
    const logs = state.dash.logs; const n = document.getElementById('logCount'); const cap = document.getElementById('logCap');
    if (n) { n.textContent = logs.length ? String(logs.length) : ''; }
    const sod = startOfToday(); v.classList.toggle('dated', logs.some((e) => e.t < sod));
    if (cap) { cap.classList.toggle('hidden', logs.length < LOG_CAP); }
  }
  function renderLogs() {
    const v = document.getElementById('logview');
    if (!v) { return; }
    const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 40;
    v.innerHTML = state.dash.logs.length ? state.dash.logs.map(logLine).join('') : `<p class="empty">${state.dash.q ? 'No log lines match.' : 'Nothing logged yet.'}</p>`;
    logChrome(v);
    if (atBottom || state.dash.follow) { v.scrollTop = v.scrollHeight; }
  }
  function appendLog(e) {
    if (LOG_RANK[e.level] < LOG_RANK[state.dash.level] || (state.dash.q && !e.msg.toLowerCase().includes(state.dash.q.toLowerCase()))) { return; }
    state.dash.logs.push(e);
    if (state.dash.logs.length > LOG_CAP) { state.dash.logs.shift(); }
    const v = document.getElementById('logview');
    if (!v) { return; }
    const empty = v.querySelector('.empty'); if (empty) { empty.remove(); }
    v.insertAdjacentHTML('beforeend', logLine(e));
    while (v.childElementCount > LOG_CAP) { v.firstElementChild.remove(); }
    logChrome(v);
    if (state.dash.follow) { v.scrollTop = v.scrollHeight; }
  }

  function secAdvanced(sec) {
    const d = state.data;
    head(sec, 'Advanced', 'Housekeeping, diagnostics and the raw settings files.');
    sec.appendChild(card(
      field('showWelcomeOnStartup', 'Show setup on first run', 'Open the welcome screen when LocalPilot starts and no model server has been configured yet.', 'toggle'),
      field('chat.location', 'Chat location', 'Where the chat lives. Changing it moves the chat right away; the LocalPilot icon in the editor title bar and the status bar always open it wherever it is.', 'select', { options: [['sidebar', 'Primary Side Bar', 'left, with the Explorer'], ['secondarySidebar', 'Secondary Side Bar', 'right, where Copilot Chat lives'], ['panel', 'Panel', 'bottom, next to the Terminal'], ['editor', 'Editor Area', 'a tab in the main area']] })
    ));
    sec.appendChild(el('h2', 'sub', 'Background services'));
    sec.appendChild(card(
      field('supervisor.enabled', 'Keep local services running', 'While VS Code is open, <b>Ollama</b> is started and kept running when it has models downloaded, serves the default model or has run this session, and <b>Redis</b> when Redis storage is on. A request that needs a stopped Ollama starts it either way.', 'toggle'),
      field('supervisor.intervalSeconds', 'Check every', 'Seconds between checks.', 'number', { min: 15, max: 3600, step: 15 }),
      field('supervisor.autoInstall', 'Install Ollama without asking', 'When no model server is found at startup, install Ollama and a starter model that fits this machine (several GB, shown in a cancellable notification). Off: the one-click setup is offered instead.', 'toggle')
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
    about.innerHTML = `<div class="field wide"><dl class="kv"><dt>Version</dt><dd>${esc(d.version)}</dd><dt>Chats</dt><dd>${d.sessions && typeof d.sessions === 'object' ? d.sessions.count : d.sessions}</dd><dt>Models</dt><dd>${(d.models || []).length} from ${plural(providersList().filter((p) => p.enabled !== false).length, 'provider')}</dd><dt>Privacy</dt><dd data-privacy></dd><dt>Author</dt><dd><a data-url="https://github.com/isathish">Sathishkumar Nagarajan</a> · <a data-url="https://github.com/isathish">@isathish on GitHub</a></dd><dt>Links</dt><dd><a data-url="https://isathish.github.io/localpilot/">Website</a> · <a data-url="https://isathish.github.io/localpilot/docs/configuration/">Configuration reference</a> · <a data-url="https://github.com/isathish/localpilot/issues">Report an issue</a></dd></dl></div>`;
    const privacy = () => { const d = telemetryDests(); return component(el('dd', '', `Your code goes only to the model servers listed under Providers (plus web tools and MCP servers you enable). No account. ${d.length ? `Usage is recorded on this machine and exported to ${d.map((h) => `<code>${esc(h)}</code>`).join(', ')}.` : 'Dashboard metrics stay on this machine; no telemetry is sent anywhere.'}`), PRIVACY_DEPS, privacy); };
    about.querySelector('[data-privacy]').replaceWith(privacy());
    sec.appendChild(about);
  }

  // ------------------------------------------------------------------ setup wizard
  function renderSetup() {
    const d = state.data;
    const su = state.setup;
    const wrap = el('div', 'setup');
    wrap.innerHTML = `<div class="hero"><img src="${LOGO}" alt=""><h1>Welcome to LocalPilot</h1><p>A coding agent that runs on your machine. Let's connect a model server — it takes about a minute.</p></div><ol class="steps" aria-label="Setup progress">${['Find server', 'Choose model', 'Approvals'].map((n, i) => `<li class="${i <= su.step ? 'on' : ''}"${i === su.step ? ` aria-current="step"><span class="sr-only">Step ${i + 1} of 3: ${n}</span>` : '>'}</li>`).join('')}</ol>`;
    const c = el('div', 'card');
    if (su.step === 0) {
      c.innerHTML = `<h3>1 · Find your model server</h3><p class="hint">LocalPilot is checking the usual local ports. Start a server if nothing shows up, then check again.</p>`;
      const det = el('div', 'detect');
      const results = state.probe;
      if (!results) { det.innerHTML = `<div class="srv"><span class="spinner"></span><div class="t"><b>Looking for Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner and model containers…</b></div></div>`; }
      else {
        // Configured servers and anything reachable are listed; silent well-known ports stay out of the way.
        for (const r of results.filter((x) => x.ok || x.configured)) {
          const cloud = probeCloud(r);
          const tag = (r.source === 'docker' ? '<span class="tag">Docker</span>' : !r.configured ? '<span class="tag">new</span>' : '') + (cloud ? '<span class="tag cloud" title="Prompts and code sent to this provider leave this machine">cloud</span>' : '');
          // A cloud API that fails is rarely "not running": say the key is missing, or show what the server answered.
          const err = String(r.error || 'unreachable').replace(/\s+/g, ' ').trim();
          const why = r.ok ? `${r.models.length} model${r.models.length === 1 ? '' : 's'}` : !cloud ? 'not running' : keyState(probeProvider(r)).warn ? `<span class="warn-text">API key missing</span> · <button class="inline-link" data-cmd="localpilot.setProviderApiKey" data-args='${esc(JSON.stringify([r.id]))}' aria-label="Add the API key for ${esc(r.displayName)}">Add key</button>` : `<span class="err-text" title="${esc(err)}">${esc(err.length > 48 ? `${err.slice(0, 46)}…` : err)}</span>`;
          det.appendChild(el('div', `srv ${r.ok ? 'ok' : ''}`, `<span class="dot ${r.ok ? 'ok' : 'err'}"></span><div class="t"><b>${esc(r.displayName)}${tag}</b><span>${esc(r.baseUrl)}</span></div><span class="n">${why}</span>`));
        }
        if (state.dmr === 'no-tcp') {
          det.appendChild(el('div', 'srv', `<span class="dot warn"></span><div class="t"><b>Docker Model Runner</b><span>running, but host access is off — run <code>docker desktop enable model-runner --tcp=12434</code> and check again</span></div>`));
        }
      }
      c.appendChild(det);
      const found = (results || []).filter((r) => r.ok && r.enabled !== false);
      if (results && !found.length) {
        const help = el('div');
        help.style.marginTop = '14px';
        const setupJob = state.jobs.find((j) => j.status === 'running' && ['setup', 'pull', 'install-runtime', 'start'].includes(j.kind));
        const ol = (state.runtimes || []).find((r) => r.target === 'ollama');
        const st = state.starter;
        const plan = st ? `${st.agent}${st.completion ? ` + ${st.completion}` : ''} (≈ ${st.gb} GB)` : 'a coder model sized for this machine';
        const label = ol && !ol.installed ? 'Install Ollama & starter model' : ol && !ol.running ? 'Start Ollama & download starter model' : 'Download starter model';
        const sub = ol && !ol.installed ? `Downloads and installs Ollama in the background (no admin rights needed), starts it and downloads ${plan}. One click — nothing else to configure.` : ol && !ol.running ? `Ollama is installed but not running. Starts it and downloads ${plan}.` : `Downloads ${plan} into Ollama.`;
        help.innerHTML = `<div class="auto-setup"><button class="btn brand" id="autoSetup" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${esc(setupJob ? 'Setting up…' : label)}</button><div class="auto-sub">${setupJob ? `<b data-job-title="${esc(setupJob.id)}">${esc(setupTitle(setupJob))}</b><span data-job-detail="${esc(setupJob.id)}">${esc(setupJob.detail || '')}</span>${setupJob.progress >= 0 ? `<div class="progress" data-job="${esc(setupJob.id)}"><i style="width:${barWidth(setupJob)}"></i></div>` : ''}` : esc(sub)}</div></div><p class="hint"><b>Or do it yourself</b> — any of these works:</p><ul class="help-list"><li><b>Ollama</b> — install from <a data-url="https://ollama.com">ollama.com</a>, then <code>ollama pull qwen2.5-coder:7b</code>. It starts automatically.</li><li><b>Docker</b> — <code>docker model pull ai/qwen2.5-coder</code> with Docker Desktop's Model Runner (enable host access: <code>docker desktop enable model-runner --tcp=12434</code>), or run any Ollama / vLLM / llama.cpp container with a published port.</li><li><b>LM Studio</b> — open the <i>Developer</i> tab and start the local server (port 1234).</li><li><b>llama.cpp</b> — <code>llama-server -m model.gguf --port 8080</code></li><li><b>vLLM</b> — <code>vllm serve Qwen/Qwen2.5-Coder-7B-Instruct</code></li></ul>`;
        c.appendChild(help);
        help.querySelector('#autoSetup').onclick = () => { state.setup.pendingAuto = true; const ol2 = (state.runtimes || []).find((r) => r.target === 'ollama'); post({ type: 'autoSetup', installRuntime: !!(ol2 && !ol2.installed), target: 'ollama' }); render(); };
      }
      const foot = el('div', 'foot');
      foot.innerHTML = `<button class="btn" id="again">${state.busy ? '<span class="spinner"></span>' : I.refresh}Check again</button><span class="spacer"></span><button class="btn link" id="skip">Skip setup</button><button class="btn brand" id="next" ${found.length ? '' : 'disabled'}>Continue ${I.chev}</button>`;
      foot.querySelector('#again').onclick = () => { state.busy = true; render(); post({ type: 'probe' }); };
      // The alternatives read as one sentence above the buttons, so the footer keeps to Check again · Skip · Continue.
      const alt = el('p', 'setup-alt muted small', 'No server running? <button class="inline-link" id="manual" title="Add any OpenAI-compatible server by URL">Add a custom endpoint</button> or <button class="inline-link" id="cloud" title="Settings → Providers → Cloud APIs">use a cloud API</button> (OpenAI, Claude, Gemini…).');
      alt.querySelector('#manual').onclick = () => { post({ type: 'leaveSetup' }); state.page = 'settings'; state.section = 'providers'; render(); };
      alt.querySelector('#cloud').onclick = () => { post({ type: 'leaveSetup' }); state.page = 'settings'; state.section = 'providers'; state.addTab = 'cloud'; render(); };
      c.appendChild(alt);
      foot.querySelector('#skip').onclick = () => post({ type: 'finishSetup' });
      foot.querySelector('#next').onclick = () => { su.providers = results.filter((r) => r.ok || r.configured).map((r) => ({ id: r.id, type: r.type, baseUrl: r.baseUrl, displayName: r.displayName })); if (!su.model || !found.some((r) => r.models.some((x) => x.id === su.model))) { su.model = recommend(found); } su.step = 1; render(); };
      c.appendChild(foot);
    } else if (su.step === 1) {
      const found = (state.probe || []).filter((r) => r.ok && r.enabled !== false);
      const all = found.flatMap((r) => r.models.map((m) => ({ ...m, provider: r.displayName, cloud: probeCloud(r) })));
      const best = recommend(found);
      c.innerHTML = `<h3>2 · Choose a default model</h3><p class="hint">For agent mode pick a tool-capable model (gemma4 e2b–12b, nemotron-3.5-bolt, devstral, gpt-oss). You can switch per chat at any time.</p>`;
      const list = el('div', 'mdl-list');
      if (!all.length) {
        const e = el('div', 'empty', 'The server is running but has no models yet. <button class="btn brand sm" id="autoSetup2">Download a starter model</button> or pull one by hand (e.g. <code>ollama pull gemma4:e4b</code>) and go back.');
        e.querySelector('#autoSetup2').onclick = () => { su.pendingAuto = true; post({ type: 'autoSetup', installRuntime: false, target: 'ollama' }); su.step = 0; render(); };
        list.appendChild(e);
      }
      for (const m of all) {
        const b = el('button', `mdl ${su.model === m.id ? 'on' : ''}`, `${vendorMark(vendorFromModelId(m.modelId || m.name), m.name)}<div class="t"><b>${esc(m.name)}</b><span>${esc(m.provider)} · ${Math.round(m.contextWindow / 1024)}k context</span></div><div class="tags">${m.id === best ? '<span class="badge brand">recommended</span>' : ''}${m.cloud ? '<span class="badge cloud" title="Runs on a cloud API: prompts and code leave this machine">cloud</span>' : ''}${m.supportsTools ? '<span class="badge ok">tools</span>' : '<span class="badge">prompt tools</span>'}${m.supportsVision ? '<span class="badge">vision</span>' : ''}${m.supportsFim ? '<span class="badge">FIM</span>' : ''}</div>`);
        b.dataset.id = `mdl:${m.id}`; b.onclick = () => { su.model = m.id; render(); };
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
        // Preset values the organisation locks or forbids are not saved (finishSetup skips them); say which.
        const held = Object.entries(p.v).filter(([x, v]) => policyRefuses(`approvals.${x}`, v)).map(([x]) => x);
        const b = el('button', `ap ${su.approvals === k ? 'on' : ''}`, `<b>${esc(p.title)}</b><span>${esc(p.desc)}</span>${held.length ? `<span class="muted small">${lockIcon('')} Your organization sets ${esc(held.join(', '))}</span>` : ''}`);
        b.dataset.id = `ap:${k}`; b.onclick = () => { su.approvals = k; render(); };
        presets.appendChild(b);
      }
      c.appendChild(presets);
      const fim = (state.probe || []).some((r) => r.ok && r.models.some((m) => m.supportsFim));
      const row = el('div', 'field');
      row.style.borderBottom = 'none';
      row.innerHTML = `<div><div class="lbl">Inline completions</div><div class="desc">Ghost-text suggestions while you type.${fim ? '' : ' Needs a small FIM model such as <code>qwen2.5-coder:1.5b-base</code> — you can enable it later.'}</div></div><div class="ctl"></div>`;
      row.querySelector('.ctl').appendChild(switchBtn(su.inline, 'Inline completions', (on) => { su.inline = on; }));
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
    const picked = su.step > 0 && su.model ? (state.probe || []).find((r) => r.ok && r.enabled !== false && r.models.some((m) => m.id === su.model)) : undefined;
    const away = picked && probeCloud(picked) ? hostOf(picked.baseUrl) : '';
    foot.innerHTML = `${away ? `<span class="warn-text">This model runs at <b>${esc(away)}</b>: prompts and code are sent there.</span>` : 'Local servers keep your code on your machine.'} <a data-url="https://isathish.github.io/localpilot/docs/getting-started/">Getting started guide</a> · <a id="toSettings">All settings</a>`;
    foot.querySelector('#toSettings').onclick = () => { post({ type: 'leaveSetup' }); state.page = 'settings'; render(); };
    wrap.appendChild(foot);
    app.appendChild(wrap);
    wireGlobal(app);
    app.querySelectorAll('.setup [data-cmd="localpilot.setProviderApiKey"]').forEach((b) => { const run = b.onclick; b.onclick = () => { state.keyAdded = true; run(); }; });
    if (!state.probe && !state.busy) { state.busy = true; post({ type: 'probe' }); }
  }
  /** The configured provider behind a probe result (cloud flag, key settings), or the result itself for a discovered server. */
  function probeProvider(r) { const p = providersList().find((x) => x.id === r.id); return p ? { ...r, ...p } : r; }
  const probeCloud = (r) => isCloud(probeProvider(r));
  function recommend(found) {
    const all = found.flatMap((r) => { const cloud = probeCloud(r); return r.models.map((m) => ({ ...m, cloud })); });
    // A local model wins over a comparable cloud one: the cloud penalty outweighs the tool and family bonuses together.
    const score = (m) => { const n = m.name.toLowerCase(); const sz = /(\d+(?:\.\d+)?)b/.exec(n); const b = sz ? parseFloat(sz[1]) : 7; return (m.supportsTools ? 10 : 0) + (/coder|devstral|codestral/.test(n) ? 5 : 0) + (/gemma4|gemma-4|nemotron-3\.5-bolt/.test(n) ? 8 : 0) + (/qwen|llama|mistral|gemma|deepseek|gpt-oss|nemotron/.test(n) ? 2 : 0) + Math.min(b, 32) / 8 - (b > 40 ? 3 : 0) - (/embed|rerank|vl|llava|whisper/.test(n) ? 20 : 0) - (m.cloud ? 15 : 0); };
    return [...all].sort((a, b) => score(b) - score(a))[0]?.id || '';
  }

  // ------------------------------------------------------------------ messaging
  // One handler that throws must cost one message, not the panel; what went wrong is reported to the extension log.
  let reported = 0;
  function reportError(where, err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[LocalPilot settings] ${where}: ${message}`, err);
    if (reported++ < 20) { try { post({ type: 'clientError', where, message, stack: err instanceof Error && err.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : undefined }); } catch { /* bridge gone */ } }
  }
  window.addEventListener('error', (e) => reportError('uncaught', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason));
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') { return; }
    try { onMessage(m); } catch (err) { reportError(`message '${m.type}'`, err); }
  });
  function onMessage(m) {
    switch (m.type) {
      case 'state': {
        const prev = state.data;
        state.data = m;
        const nav = !prev || m.navigate !== false;
        const navChanged = nav && ((m.page && m.page !== state.page) || (m.section && m.section !== state.section));
        // Entering the wizard starts from the current settings, so finishing it without changes keeps them.
        if (nav && m.page === 'setup' && (!prev || state.page !== 'setup')) {
          state.setup = { step: 0, model: val('defaultModel') || '', approvals: Object.keys(APPROVAL_PRESETS).find((k) => ['terminal', 'write', 'delete', 'network'].every((a) => APPROVAL_PRESETS[k].v[a] === val(`approvals.${a}`))) || '', inline: val('inlineCompletion.enabled') === true, providers: null };
          state.probe = null;
        }
        if (nav && m.page) { state.page = m.page; }
        if (nav && m.section) { state.section = m.section; }
        // A deep link from the chat (Set API key, Raise context window): open that provider card / jump to that setting.
        if (nav && m.expand) { state.expanded = m.expand; }
        if (nav && m.focusKey) { const key = m.focusKey; setTimeout(() => { if (!focusSetting(key)) { requestAnimationFrame(() => focusSetting(key)); } }, 60); }
        if (nav && m.expand) { const id = m.expand; setTimeout(() => { const card = [...app.querySelectorAll('.prov[data-prov]')].find((c) => c.dataset.prov === id); if (card) { card.scrollIntoView({ block: 'start', behavior: calm() ? 'auto' : 'smooth' }); const k = card.querySelector('input[type="password"], input'); if (k) { k.focus({ preventScroll: true }); } } }, 60); }
        // A key added from the wizard's "Add key" link: check the providers again so the row turns green.
        if (state.keyAdded && state.page === 'setup') { state.keyAdded = false; state.busy = true; post({ type: 'probe' }); }
        if (nav && m.section === 'models' && state.models && !state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
        if (!prev || navChanged || state.page === 'setup' || !app.querySelector('main.content > .sec')) { render(); break; }
        // A settings round-trip: find what actually changed and refresh only those components.
        const keys = new Set([...Object.keys(prev.settings || {}), ...Object.keys(m.settings || {})]);
        const changed = [...keys].filter((k) => JSON.stringify((prev.settings || {})[k]) !== JSON.stringify((m.settings || {})[k]));
        // The resolved OTLP target (environment variables included) feeds the privacy wording and the Telemetry rows.
        if (JSON.stringify(prev.otlp) !== JSON.stringify(m.otlp)) { changed.push(...PRIVACY_DEPS, 'telemetry.otlp.enabled', 'telemetry.otlp.headers', 'telemetry.otlp.metricsInterval'); }
        const SECTION_DATA = { agent: ['terminalProfiles', 'autoRepos'], providers: ['models'], models: ['models'], gallery: ['models'], skills: ['skills', 'agents', 'learning'], customize: ['skills'], completions: ['models'], memory: ['memory', 'sessions'], mcp: ['mcp'], shortcuts: ['shortcuts', 'isMac'], advanced: ['models', 'sessions', 'version'] };
        const otherChanged = ['hasWorkspace', ...(SECTION_DATA[state.section] || [])].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(m[k]));
        // Provider health: only a changed state redraws the cards (latency and "checked" times change every round).
        const hsig = (d) => JSON.stringify(Object.entries(d.health || {}).map(([k, v]) => [k, v && v.state]));
        if (state.section === 'providers' && hsig(prev) !== hsig(m)) { render(); break; }
        if (otherChanged || changed.some((k) => STRUCTURAL_KEYS.has(k))) { render(); break; }
        if (JSON.stringify(prev.commandRules) !== JSON.stringify(m.commandRules)) { changed.push('@commandRules'); }
        if (changed.length) { refreshComponents(changed); }
        break;
      }
      case 'probe': {
        // Results come from probing user-configured servers; a malformed entry must not take the whole page down.
        const results = (Array.isArray(m.results) ? m.results : []).filter((r) => r && typeof r === 'object' && r.id).map((r) => ({ ...r, models: Array.isArray(r.models) ? r.models.filter(Boolean) : [] }));
        state.probe = results; state.busy = false; state.dmr = m.dockerModelRunner || null; state.runtimes = m.runtimes || state.runtimes; state.starter = m.starter || state.starter;
        for (const r of results) { state.tests[r.id] = r; }
        // After a one-click setup from the wizard, jump straight to the model step with the recommendation selected.
        const found = results.filter((r) => r.ok && r.enabled !== false && r.models.length);
        if (state.page === 'setup' && state.setup.pendingAuto && found.length) { state.setup.pendingAuto = false; state.setup.providers = results.filter((r) => r.ok || r.configured).map((r) => ({ id: r.id, type: r.type, baseUrl: r.baseUrl, displayName: r.displayName })); state.setup.model = recommend(found); state.setup.step = 1; }
        render();
        break;
      }
      case 'testResult': {
        state.tests[m.id] = m.result;
        if (state.probe && m.result) { const i = state.probe.findIndex((r) => r.id === m.id); if (i >= 0) { state.probe[i] = m.result; } }
        if (state.page === 'setup') { render(); break; }
        // Only the tested provider's card changes.
        const list = providersList(); const p = list.find((x) => x.id === m.id); const old = app.querySelector(`.prov[data-prov="${CSS.escape(m.id)}"]`);
        if (p && old) { const fresh = providerCard(p, list); wireGlobal(fresh); old.replaceWith(fresh); }
        break;
      }
      case 'models':
        state.models = m.models; state.jobs = m.models.jobs || state.jobs; state.modelsRequested = false; state.jobsSig = jobsSig(state.jobs);
        if (state.section === 'models' || state.section === 'gallery' || state.page === 'setup') { render(); }
        break;
      case 'jobs': {
        state.jobs = m.jobs || [];
        const sig = jobsSig(state.jobs);
        const same = sig === state.jobsSig;
        state.jobsSig = sig;
        if ((state.section === 'models' && state.models) || state.page === 'setup') { if (same) { patchJobs(); } else { render(); } }
        else if (state.section === 'gallery') { if (same) { patchJobs(); } else { renderGalleryResults(); } }
        break;
      }
      case 'gallery': {
        const g = galleryState(m.source || 'ollama');
        // Ignore pages from a query the user has since changed.
        if (m.q !== g.q || m.capability !== g.capability || m.sort !== g.sort) { break; }
        g.loading = false; g.error = m.error || null; g.hasMore = !!m.hasMore; g.page = m.page;
        const seen = new Set(m.page > 1 ? g.models.map((x) => x.name) : []);
        g.models = [...(m.page > 1 ? g.models : []), ...(m.models || []).filter((x) => x && !seen.has(x.name))];
        // "Load more" is open-ended; the list is re-rendered whole, so keep what fits on screen comfortably.
        if (g.models.length > 600) { g.models = g.models.slice(g.models.length - 600); }
        if (state.section === 'gallery' && state.gallery.source === (m.source || 'ollama')) { renderGalleryResults(); }
        break;
      }
      case 'galleryTags': {
        const g = galleryState(m.source || 'ollama');
        g.tags[m.name] = { loading: false, tags: m.tags || [], error: m.error || null, showAll: false };
        // Docker Hub's listing has no descriptions; the tags call brings one back.
        const model = m.description && g.models.find((x) => x.name === m.name);
        if (model && !model.description) { model.description = m.description; }
        if (state.section === 'gallery' && state.gallery.source === (m.source || 'ollama')) { renderGalleryResults(); }
        break;
      }
      case 'skillRegistry': {
        const reg = state.skillReg;
        if (m.q !== reg.q) { break; }
        reg.loading = false; reg.entries = m.entries || []; reg.status = m.status || []; reg.refreshing = !!m.refreshing;
        if (state.section === 'skills') { renderSkillRegistry(); renderSkillRepoStatus(); }
        if (state.section === 'marketplace') { renderMarket(); }
        break;
      }
      case 'mcpCatalog': {
        const cat = mcpCatState();
        cat.entries = m.entries || []; cat.registry = !!m.registry; cat.error = m.error || ''; cat.loading = !!m.loading;
        if (!m.loading) { cat.jobs = {}; }
        if (m.installed) { cat.view = 'installed'; state.expanded = `mcp:${m.installed}`; }
        if (state.section === 'mcp') { render(); }
        if (state.section === 'marketplace') { renderMarket(); }
        break;
      }
      case 'pluginCatalog': {
        const mk = mkState();
        mk.loading = !!m.loading; mk.configured = m.configured || 0; mk.pluginErrors = m.errors || [];
        if (!m.loading) { mk.plugins = m.entries || []; mk.jobs = {}; }
        if (state.section === 'marketplace') { renderMarket(); }
        break;
      }
      case 'skillJob':
        state.skillReg.jobs[m.name] = { status: m.status, detail: m.detail };
        if (m.status === 'done') { setTimeout(() => { delete state.skillReg.jobs[m.name]; if (state.section === 'skills') { renderSkillRegistry(); } }, 1500); }
        if (state.section === 'skills') { renderSkillRegistry(); }
        if (state.section === 'marketplace') { renderMarket(); }
        break;
      case 'busy':
        state.busy = m.busy;
        if (!m.busy) { render(); }
        break;
      case 'tuneResult':
        (state.dash.tuneResults = state.dash.tuneResults || {})[`${m.role}|${m.model}`] = { ok: !!m.ok, error: m.ok ? '' : m.error || 'Could not apply', at: Date.now() };
        if (state.page === 'settings' && state.section === 'dashboard' && state.dash.summary) { renderDashboard(); }
        break;
      case 'dashboard':
        // A slower reply for a range or filter the user has since switched away from must not overwrite the selection.
        if (typeof m.days === 'number' && m.days !== state.dash.days) { break; }
        if (typeof m.includeDisabled === 'boolean' && m.includeDisabled !== state.dash.includeDisabled) { break; }
        if (Array.isArray(m.providers) && (m.providers[0] || '') !== state.dash.provider) { break; }
        if (Array.isArray(m.hiddenProviders)) { state.dash.hidden = m.hiddenProviders; }
        if (Array.isArray(m.allProviders)) { state.dash.allProviders = m.allProviders; }
        state.dash.loading = false; state.dash.manual = false; clearTimeout(state.dash.ttl);
        if (m.error || !m.summary) { state.dash.error = m.error || 'No numbers in the reply'; } else {
          state.dash.error = ''; state.dash.summary = m.summary; state.dash.summaryKey = dashKey(); state.dash.updatedAt = Date.now();
          state.dash.logFile = m.logFile || ''; state.dash.tuning = m.tuning || null;
        }
        // The recovery group has its own source (the RecoveryStore): a telemetry error leaves it intact, and the reverse.
        state.rec.loaded = true; state.rec.error = m.recoveryError || '';
        // Fresh data carries the stored memory switches: they replace the clicks made since.
        if (m.recovery) { state.rec.data = m.recovery; state.rec.reuse = {}; }
        state.rec.canDiff = !!m.recoveryDiff;
        if (state.page === 'settings' && state.section === 'dashboard') { renderDashboard(); syncDashFilters(); renderRecovery(); }
        if (state.page === 'settings' && state.section === 'telemetry') { renderStorage(); }
        break;
      case 'healingChecks':
        if (m.error) { toast(`Could not read the checks: ${m.error}`, 'error'); refreshComponents(['healing.checks']); break; }
        if (state.data && m.healing) { state.data.healing = m.healing; refreshComponents(['healing.checks']); }
        break;
      case 'otlpTest': {
        state.otlpTest = { ok: !!m.ok, status: m.status, url: m.url || '', error: m.ok ? '' : m.error || 'No answer from the collector' };
        const old = document.getElementById('otlpResult');
        const f = old && old.closest('.field');
        // Only the result line and the button change, so an endpoint being typed in keeps its text and caret.
        if (f && f._rebuild) { const fresh = f._rebuild(); old.replaceWith(fresh.querySelector('#otlpResult')); const tb = f.querySelector('.ctl .row .btn'); const nb = fresh.querySelector('.ctl .row .btn'); if (tb && nb) { tb.replaceWith(nb); } }
        break;
      }
      case 'redisTest':
        state.redisTest = { ok: !!m.ok, info: m.info, error: m.ok ? '' : m.error || 'No answer from Redis' };
        refreshRedisStatus();
        break;
      case 'logs':
        state.dash.logs = Array.isArray(m.entries) ? m.entries : [];
        if (state.section === 'dashboard') { renderLogs(); }
        break;
      case 'logLine':
        if (state.page === 'settings' && state.section === 'dashboard' && m.entry) { appendLog(m.entry); }
        break;
      case 'saved':
        onSaved(m);
        break;
      case 'toast':
        toast(m.text, m.level, m.action);
        break;
      case 'pickedFolder':
        if (onPicked[m.key]) { onPicked[m.key](m.path, m.name); }
        break;
      case 'customize': {
        const c = state.custom || (state.custom = { tab: 'rule', data: null, loading: 0, scope: '' });
        c.data = m.data; c.loading = 0; c.at = Date.now();
        if (state.page === 'settings' && state.section === 'customize') { render(); }
        break;
      }
    }
  }
  post({ type: 'ready' });
})();
