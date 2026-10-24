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
    search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
    gallery: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><path d="M11.5 9.5v5M9 12h5"/></svg>',
    external: '<svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/></svg>',
    cloud: '<svg viewBox="0 0 16 16"><path d="M5 12.5a3 3 0 0 1-.4-6A4 4 0 0 1 12.3 7.6 2.5 2.5 0 0 1 12 12.5z"/></svg>',
    gauge: '<svg viewBox="0 0 16 16"><path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l2.5-4"/><path d="M2 13.5h12"/></svg>',
    file: '<svg viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6 8h4M6 10.5h4"/></svg>',
    folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z"/></svg>',
  };
  const SECTIONS = [
    ['providers', 'Providers', I.server], ['models', 'Models', I.cpu], ['gallery', 'Model gallery', I.gallery], ['skills', 'Skills & subagents', I.book], ['agent', 'Agent & approvals', I.shield], ['completions', 'Inline completions', I.ghost],
    ['web', 'Web search', I.globe], ['memory', 'Memory & history', I.brain], ['mcp', 'MCP servers', I.plug], ['dashboard', 'Dashboard', I.gauge], ['advanced', 'Advanced', I.wrench],
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
  /** Vendor logos (Simple Icons, CC0 1.0 — https://simpleicons.org). Vendors without a usable vector mark keep a monogram below. */
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
  };
  /** Brand marks for provider cards: real logo where we have one, otherwise a monogram, each in the vendor accent colour. */
  const BRANDS = {
    ollama: { mark: LOGOS.ollama, color: '#9ca3af' }, lmstudio: { mark: LOGOS.lmstudio, color: '#7c5cff' }, llamacpp: { mark: 'λ', color: '#f2a33a' },
    vllm: { mark: LOGOS.vllm, color: '#30a2ff' }, docker: { mark: LOGOS.docker, color: '#2496ed' }, jan: { mark: 'JA', color: '#22c55e' },
    localai: { mark: 'LA', color: '#06b6d4' }, sglang: { mark: 'SG', color: '#ef4444' }, custom: { mark: I.plug, color: '' },
  };
  /** Resolves a brand from a preset key or a provider config (id prefix such as "ollama-2", then baseUrl/type hints). */
  const brandOf = (keyOrCfg) => {
    if (typeof keyOrCfg === 'string') { return BRANDS[keyOrCfg]; }
    const p = keyOrCfg || {};
    const base = String(p.id || '').replace(/-\d+$/, '');
    if (BRANDS[base]) { return BRANDS[base]; }
    if (p.type === 'ollama') { return BRANDS.ollama; }
    const url = String(p.baseUrl || '');
    const hit = PRESET_PROVIDERS.find((pr) => pr.key !== 'custom' && pr.cfg.baseUrl === url);
    return hit ? BRANDS[hit.key] : null;
  };
  const markSpan = (b, fallback) => {
    const mark = b ? b.mark : esc(String(fallback || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?');
    return `<span class="ic brand-mark${b && b.color ? '' : ' plain'}"${b && b.color ? ` style="--mark:${b.color}"` : ''} aria-hidden="true">${mark}</span>`;
  };
  const brandMark = (keyOrCfg, fallback) => markSpan(brandOf(keyOrCfg), fallback);
  /** Model vendors (catalog `vendor` names): real logo where Simple Icons has one, else a monogram, in the vendor colour. */
  const VENDORS = {
    'google deepmind': { mark: LOGOS.google, color: '#4285f4' }, google: { mark: LOGOS.google, color: '#4285f4' },
    nvidia: { mark: LOGOS.nvidia, color: '#76b900' }, alibaba: { mark: LOGOS.qwen, color: '#615ced' },
    'mistral ai': { mark: LOGOS.mistral, color: '#fa520f' }, mistral: { mark: LOGOS.mistral, color: '#fa520f' }, openai: { mark: 'OA', color: '#10a37f' },
    meta: { mark: LOGOS.meta, color: '#0866ff' }, deepseek: { mark: LOGOS.deepseek, color: '#4d6bfe' },
    microsoft: { mark: 'MS', color: '#0078d4' }, 'hugging face': { mark: LOGOS.huggingface, color: '#f59e0b' }, bigcode: { mark: 'BC', color: '#a855f7' },
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
    if (/phi-?\d|phi4|phi3/.test(n)) { return 'microsoft'; }
    if (/smollm/.test(n)) { return 'hugging face'; }
    if (/starcoder/.test(n)) { return 'bigcode'; }
    return '';
  };
  const vendorMark = (vendor, fallback) => markSpan(VENDORS[String(vendor || '').toLowerCase()] || null, fallback || vendor);
  const APPROVAL = [['ask', 'Ask'], ['always', 'Allow'], ['never', 'Block']];
  const APPROVAL_PRESETS = {
    safe: { title: 'Careful', desc: 'Ask before every command, edit, delete and network call.', v: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask' } },
    balanced: { title: 'Balanced', desc: 'Edits and web are allowed; ask for terminal commands and deletes. (Default)', v: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always' } },
    autonomous: { title: 'Autonomous', desc: 'Let the agent run commands and edit freely; only deletes need approval.', v: { terminal: 'always', write: 'always', delete: 'ask', network: 'always' } },
  };

  const state = { page: 'settings', section: 'providers', scope: 'user', data: null, probe: null, tests: {}, expanded: null, busy: false, setup: { step: 0, model: '', approvals: 'balanced', inline: false, providers: null }, models: null, modelsRequested: false, jobs: [], cat: { filter: 'fits', q: '', open: {} }, installTarget: {}, runtimes: null, starter: null,
    // Model gallery: one browse state per registry source (Ollama library, Docker Hub ai/, Hugging Face GGUF) and
    // the chosen install runtime per source; tag lists are fetched on expand.
    gallery: { source: 'ollama', target: {}, pullRef: '', pullError: '', pullTarget: '', by: {} },
    // Dashboard: last summary + range, and the log viewer filters (follow streams new lines in).
    dash: { days: 7, summary: null, logFile: '', loading: false, logs: [], level: 'info', q: '', follow: true, timer: null },
    // Skill registry browser (Settings → Skills): query, results with installed state, per-repo index status, install jobs.
    skillReg: { q: '', filter: 'all', scope: '', entries: [], status: [], loading: false, loaded: false, refreshing: false, jobs: {} }, skillFilter: '' };
  const galleryState = (source) => (state.gallery.by[source] ||= { q: '', capability: '', sort: 'popular', page: 1, models: [], hasMore: false, loading: false, loaded: false, error: null, tags: {}, open: {} });

  // ------------------------------------------------------------------ helpers
  /** Makes a clickable card header a real disclosure control: focusable, announced, toggled with Enter/Space. */
  function disclosure(head, open, label, toggle) {
    if (!head) { return; }
    head.setAttribute('role', 'button'); head.tabIndex = 0; head.setAttribute('aria-expanded', String(!!open)); head.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${label}`);
    head.onclick = (e) => { if (e.target.closest('button, a, input, select')) { return; } toggle(); };
    head.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); toggle(); } };
  }
  function toast(text, level) { const t = el('div', `toast ${level || 'info'}`, esc(text)); document.getElementById('toasts').appendChild(t); setTimeout(() => t.remove(), 3000); }
  const S = (key) => (state.data && state.data.settings[key]) || { value: undefined, default: undefined, scope: 'default' };
  const val = (key) => S(key).value;
  function set(key, value) { state.pendingSave = Date.now(); post({ type: 'set', key, value, scope: state.scope }); }
  /** Brief "Saved" acknowledgement in the header after a setting round-trips through VS Code. */
  function flashSaved() {
    const t = app.querySelector('.top .saved'); if (!t) { return; }
    t.classList.add('show'); clearTimeout(flashSaved.timer); flashSaved.timer = setTimeout(() => t.classList.remove('show'), 1400);
  }
  function reset(key) { post({ type: 'reset', key, scope: state.scope === 'workspace' ? 'workspace' : 'user' }); }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const scopeBadge = (key) => { const s = S(key).scope; return s === 'default' ? '' : `<span class="badge ${s}" title="Set in ${s} settings">${s}</span>`; };
  const resetBtn = (key) => (S(key).scope === 'default' ? '' : `<button class="reset" data-reset="${esc(key)}" title="Reset to default">${I.undo}</button>`);

  /** Generic setting row. kind: text|number|password|select|toggle|textarea|range|seg */
  function field(key, label, desc, kind, opts = {}) {
    const f = el('div', `field ${opts.wide ? 'wide' : ''}`);
    // Components declare the setting keys they render from and how to rebuild themselves, so a changed setting
    // refreshes just that element instead of the whole page (see refreshComponents).
    f.dataset.deps = key;
    f._rebuild = () => field(key, label, desc, kind, opts);
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
      // `last` tracks what was sent so blur + the trailing debounce do not save the same value twice.
      let last = v;
      const commit = () => {
        if (kind === 'number') {
          const n = Number(i.value);
          if (i.value === '' || Number.isNaN(n) || (opts.min !== undefined && n < opts.min) || (opts.max !== undefined && n > opts.max)) { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); i.title = `Enter a number${opts.min !== undefined ? ` from ${opts.min}` : ''}${opts.max !== undefined ? ` to ${opts.max}` : ''} — not saved yet`; return; }
          i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); i.title = ''; if (n !== last) { last = n; set(key, n); }
        } else if (opts.validate && i.value && !opts.validate(i.value)) { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); i.title = opts.invalidHint || 'Not a valid value — not saved yet'; }
        else { i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); i.title = ''; if (i.value !== (last ?? '')) { last = i.value; set(key, i.value); } }
      };
      i.onchange = commit; i.onblur = commit; i.oninput = debounce(commit, 700);
      ctl.appendChild(i);
    }
    if (opts.after) { ctl.appendChild(opts.after); }
    return f;
  }
  const card = (...children) => { const c = el('div', 'card'); children.forEach((x) => x && c.appendChild(x)); return c; };
  /** Marks any element as a self-rebuilding component bound to the given setting keys. */
  const component = (node, deps, rebuild) => { node.dataset.deps = deps.join(','); node._rebuild = rebuild; return node; };
  /** Settings whose change restructures a page (lists, visibility) rather than one control — these re-render the section. */
  const STRUCTURAL_KEYS = new Set(['providers', 'mcpServers', 'skillsPaths', 'models.disabled', 'webSearch.provider']);
  /** Rebuilds only the components that depend on the changed keys. Keeps a focused control intact (just refreshes its label). */
  function refreshComponents(keys) {
    const want = new Set(keys);
    for (const node of [...app.querySelectorAll('[data-deps]')]) {
      if (!node._rebuild || !node.dataset.deps.split(',').some((k) => want.has(k))) { continue; }
      const fresh = node._rebuild();
      wireGlobal(fresh);
      if (node.contains(document.activeElement)) {
        const a = node.querySelector('.lbl'); const b = fresh.querySelector('.lbl');
        if (a && b) { a.replaceWith(b); }
        continue;
      }
      node.replaceWith(fresh);
    }
  }
  const enabledModels = () => (state.data.models || []).filter((m) => !m.disabled);
  const modelOptions = (filter) => enabledModels().filter(filter || (() => true)).map((m) => [m.id, m.name, `${m.providerId} · ${Math.round(m.contextWindow / 1024)}k${m.supportsTools ? ' · tools' : ''}${m.supportsVision ? ' · vision' : ''}${m.supportsFim ? ' · FIM' : ''}`]);
  const shortId = (id) => String(id || '').split('/').pop();

  // ------------------------------------------------------------------ shell
  /**
   * Settings page: the header and sidebar are built once and kept; render() only swaps the <section> for the
   * current page. Setting changes go through refreshComponents() and never reach here unless they restructure
   * the page. The setup wizard is small and still renders as a whole.
   */
  let renderedSection = null;
  function render() {
    if (!state.data) { return; }
    // Rebuilding collapses the document and drops the scroll position; put it back once the page is rebuilt — unless
    // the user moved to another section, which must start at its top.
    const sameSection = state.page === 'settings' && renderedSection === `${state.page}/${state.section}`;
    const y = sameSection ? window.scrollY : 0;
    renderedSection = `${state.page}/${state.section}`;
    app.removeAttribute('aria-busy');
    if (state.page === 'setup') {
      app.innerHTML = ''; app.dataset.page = 'setup';
      renderSetup();
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
    top.innerHTML = `<div class="brand"><img src="${LOGO}" alt=""><div><b>LocalPilot</b><span>Settings · v${esc(d.version)}</span></div></div><span class="spacer"></span>
      <span class="saved" role="status" aria-live="polite">${I.check}Saved</span>
      <div class="scope" role="radiogroup" aria-label="Settings scope"><button data-s="user">User</button><button data-s="workspace">Workspace</button></div>
      <button class="btn" data-cmd="localpilot.openChat" title="Open chat" aria-label="Open chat">${I.chat}Open chat</button>`;
    top.querySelectorAll('.scope button').forEach((b) => (b.onclick = () => { if (b.disabled) { return; } state.scope = b.dataset.s; render(); }));
    app.appendChild(top);
    const layout = el('div', 'layout');
    const side = el('nav', 'side'); side.setAttribute('aria-label', 'Settings sections');
    side.innerHTML = `<div class="grp">Settings</div><div class="tabs" role="tablist">${SECTIONS.map(([id, label, icon]) => `<a data-sec="${id}" role="tab" tabindex="-1">${icon}${esc(label)}</a>`).join('')}</div><div class="grp">Help</div><a data-cmd="localpilot.openWelcome" role="button" tabindex="0">${I.rocket}Run setup again</a><a data-url="https://isathish.github.io/localpilot/docs/configuration/" role="link" tabindex="0">${I.book}Documentation</a>`;
    const tabs = [...side.querySelectorAll('[data-sec]')];
    const go = (a) => { state.section = a.dataset.sec; state.expanded = null; render(); a.focus({ preventScroll: true }); };
    tabs.forEach((a, i) => {
      a.onclick = () => go(a);
      // Keyboard: Enter/Space activates; arrows move between sections like a native tab strip.
      a.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(a); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); go(tabs[(i + 1) % tabs.length]); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); go(tabs[(i - 1 + tabs.length) % tabs.length]); }
        else if (e.key === 'Home') { e.preventDefault(); go(tabs[0]); } else if (e.key === 'End') { e.preventDefault(); go(tabs[tabs.length - 1]); }
      };
    });
    side.querySelectorAll('[data-cmd],[data-url]').forEach((a) => { a.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); a.click(); } }; });
    // Narrow layout turns the nav into a scrolling pill strip: show fades where more pills are hidden.
    side.onscroll = () => updateNavFades(side);
    layout.appendChild(side);
    const main = el('main', 'content');
    main.appendChild(el('section', 'sec'));
    layout.appendChild(main);
    app.appendChild(layout);
    wireGlobal(top); wireGlobal(side);
  }
  /** Cheap per-render sync of the persistent shell: version, scope buttons, active nav entry. */
  function syncShell() {
    const d = state.data;
    const v = app.querySelector('.top .brand span'); if (v) { v.textContent = `Settings · v${d.version}`; }
    app.querySelectorAll('.top .scope button').forEach((b) => {
      b.classList.toggle('on', state.scope === b.dataset.s);
      if (b.dataset.s === 'workspace') { b.disabled = !d.hasWorkspace; b.title = d.hasWorkspace ? '' : 'Open a folder to edit workspace settings'; }
    });
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
    ({ providers: secProviders, models: secModels, gallery: secGallery, skills: secSkills, agent: secAgent, completions: secCompletions, web: secWeb, memory: secMemory, mcp: secMcp, dashboard: secDashboard, advanced: secAdvanced }[state.section] || secProviders)(sec);
    wireGlobal(sec);
    const old = app.querySelector('main.content > .sec');
    if (old) { old.replaceWith(sec); } else { app.querySelector('main.content').appendChild(sec); }
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
    bar.querySelector('#probe').onclick = () => { state.busy = true; state.probedSig = providerSig(list); state.probedAt = Date.now(); render(); post({ type: 'probe' }); };
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
      const b = el('button', 'preset', `${brandMark(pr.key, pr.label)}<div><b title="${esc(pr.label)}">${esc(pr.label)}</b><span title="${esc(pr.sub)}">${taken ? 'already added' : esc(pr.sub)}</span></div>`);
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
  const providerSig = (list) => list.map((p) => `${p.id}@${p.baseUrl}@${p.enabled === false ? 0 : 1}`).join('|');
  function providerCard(p, list) {
    const probe = (state.probe || []).find((r) => r.id === p.id) || state.tests[p.id];
    const open = state.expanded === p.id;
    const c = el('div', `prov ${p.enabled === false ? 'off' : ''}`);
    c.dataset.prov = p.id;
    const status = probe ? (probe.ok ? 'ok' : 'err') : state.busy ? 'busy' : '';
    const n = probe && probe.ok ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'} · ${probe.latencyMs} ms` : probe ? 'unreachable' : (state.data.models || []).filter((m) => m.providerId === p.id).length ? `${(state.data.models || []).filter((m) => m.providerId === p.id).length} models` : '';
    c.innerHTML = `<div class="prov-head"><span class="dot ${status}"></span>${brandMark(p, p.displayName || p.id)}<div class="prov-title"><b>${esc(p.displayName || p.id)}</b><span>${esc(p.baseUrl)}</span></div><div class="prov-meta"><span class="badge">${p.type === 'ollama' ? 'Ollama API' : 'OpenAI API'}</span>${n ? `<span class="badge ${status}">${esc(n)}</span>` : ''}${p.enabled === false ? '<span class="badge">disabled</span>' : ''}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
    disclosure(c.querySelector('.prov-head'), open, `${p.displayName || p.id} settings`, () => { state.expanded = open ? null : p.id; render(); });
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
  const ROLE_LABEL = { agent: 'agent', completion: 'completions', vision: 'images', reasoning: 'plan', fast: 'subagents' };
  const TARGET_LABEL = { ollama: 'Ollama', docker: 'Docker Model Runner', lmstudio: 'LM Studio' };
  const fitBadge = (fit) => fit === 'ok' ? '<span class="badge ok">fits</span>' : fit === 'tight' ? '<span class="badge warn">tight</span>' : fit === 'over' ? '<span class="badge err">too big</span>' : '';
  const gbText = (gb) => (gb === undefined || gb === null ? '' : gb >= 10 ? `${Math.round(gb)} GB` : `${Number(gb).toFixed(1)} GB`);
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
    auto.innerHTML = `<button class="btn ${anyModels ? '' : 'brand'}" id="auto" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${anyModels ? 'Install starter set' : 'Set up automatically'}</button><span class="hint" ${setupJob ? `data-job-detail="${esc(setupJob.id)}"` : ''}>${esc(setupJob ? setupJob.detail : `Picks for this machine: ${starter}. Starts or installs Ollama when needed.`)}</span>`;
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
      const tg = el('button', `toggle ${m.disabled ? '' : 'on'}`); tg.setAttribute('role', 'switch'); tg.title = m.disabled ? 'Enable' : 'Disable (hidden from pickers and routing; stays installed)';
      tg.onclick = () => { tg.classList.toggle('on'); post({ type: 'toggleModel', id: m.id, enabled: !!m.disabled }); };
      row.appendChild(tg);
      row.insertAdjacentHTML('beforeend', vendorMark((m.catalog && m.catalog.vendor) || vendorFromModelId(m.modelId || m.name), m.name));
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
        b.onclick = () => post({ type: 'removeModel', target: m.removable, model: m.modelId, providerId: m.providerId, name: m.name });
        acts.appendChild(b);
      }
      right.appendChild(acts);
      row.appendChild(right);
      inst.appendChild(row);
    }
    return component(inst, ['defaultModel', 'inlineCompletion.model', 'routing.vision', 'routing.reasoning'], installedCard);
    };
    sec.appendChild(installedCard());

    // --- routing
    sec.appendChild(el('h2', 'sub', 'Routing'));
    const autoFor = (role) => { const m = d.installed.find((x) => !x.disabled && x.autoRoles.includes(role)); return m ? `Auto → ${m.name}` : role === 'vision' ? 'Auto → no vision model installed' : 'Auto → best available'; };
    const opts = modelOptions();
    sec.appendChild(card(
      field('routing.enabled', 'Route automatically', 'Send image turns to a vision model, completions to the smallest FIM model, Plan mode to the reasoning model, subagents to the models below, and fall back to the best available model when the chosen one is offline or disabled.', 'toggle'),
      field('defaultModel', 'Agent & chat', opts.length ? `New chats and editor actions. ${esc(autoFor('agent'))}.` : 'No models enabled yet.', 'select', { options: [['', 'Auto (best for this machine)', ''], ...opts] }),
      field('inlineCompletion.model', 'Inline completions', `Fill-in-the-middle model for ghost text. ${esc(autoFor('completion'))}.`, 'select', { options: [['', 'Auto (smallest FIM model)', ''], ...(modelOptions((m) => m.supportsFim).length ? modelOptions((m) => m.supportsFim) : opts)] }),
      field('routing.vision', 'Images', `Used when a turn has images and the session model cannot see. ${esc(autoFor('vision'))}.`, 'select', { options: [['', 'Auto (best vision model)', ''], ...(modelOptions((m) => m.supportsVision).length ? modelOptions((m) => m.supportsVision) : opts)] }),
      field('routing.reasoning', 'Plan mode', 'Optional reasoning model for planning (qwen3, deepseek-r1, gpt-oss — pair with Extended thinking below). Empty keeps the session model.', 'select', { options: [['', 'Keep the session model', ''], ...opts] }),
      field('routing.fast', 'Read-only subagents', `<code>explore</code>, <code>clarifier</code>, <code>researcher</code> run many short tool calls, often several in parallel — a small tool-capable model keeps them snappy. ${esc(autoFor('fast'))}.`, 'select', { options: [['', 'Auto (smallest tool-capable model that fits)', ''], ['session', 'Keep the session model', ''], ...opts] }),
      field('routing.coding', 'Implementing subagents', '<code>coder</code>, <code>tester</code>, <code>debugger</code>, <code>docs</code>. Pick a stronger coding model here while chatting with a lighter one. Empty keeps the session model.', 'select', { options: [['', 'Keep the session model', ''], ...opts] })
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
    head(sec, 'Model gallery', `Browse and install any model from the registries your runtimes download from — the <a data-url="https://ollama.com/library">Ollama library</a>, Docker Hub's <a data-url="https://hub.docker.com/u/ai">ai/</a> models for Docker Model Runner and <a data-url="https://huggingface.co/models?library=gguf">Hugging Face GGUF</a> repositories for LM Studio and Ollama — not just the curated catalog. Sizes are compared against this machine; installed models show up under <a data-sec="models">Models</a>.`);
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
    if (g.loading && !g.models.length) { box.appendChild(el('div', 'loading short', `<span class="spinner"></span>Searching ${esc(src.site)}…`)); return; }
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
        b.onclick = () => { g.open[m.name] = !open; if (!open && !g.tags[m.name]) { g.tags[m.name] = { loading: true }; post({ type: 'galleryTags', source, name: m.name }); } renderGalleryResults(); };
        act.appendChild(b);
      }
      headEl.appendChild(act);
      c.appendChild(headEl);
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

  // ------------------------------------------------------------------ agent & approvals
  function secAgent(sec) {
    head(sec, 'Agent & approvals', 'Control what the agent may do on its own. “Ask” shows an inline approval card in the chat; “Allow” proceeds silently; “Block” refuses.');
    const APPROVAL_KEYS = ['approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network'];
    const presetsEl = () => {
      const cur = { terminal: val('approvals.terminal'), write: val('approvals.write'), delete: val('approvals.delete'), network: val('approvals.network') };
      const presets = el('div', 'approval-presets');
      for (const [k, p] of Object.entries(APPROVAL_PRESETS)) {
        const on = Object.keys(p.v).every((x) => p.v[x] === cur[x]);
        const b = el('button', `ap ${on ? 'on' : ''}`, `<b>${esc(p.title)}</b><span>${esc(p.desc)}</span>`);
        b.onclick = () => { for (const [x, v] of Object.entries(p.v)) { if (cur[x] !== v) { set(`approvals.${x}`, v); } } };
        presets.appendChild(b);
      }
      return component(presets, APPROVAL_KEYS, presetsEl);
    };
    sec.appendChild(presetsEl());
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
    sec.appendChild(el('h2', 'sub', 'Understanding requests'));
    sec.appendChild(card(
      field('autoClarify', 'Interpret vague requests automatically', 'When a prompt is short or says “fix this” / “make it faster” without naming a target, the agent is handed the active file, selection, open editors, recent edits, errors and git changes, states <i>Understood as: …</i> and proceeds. It only asks when two readings would lead to materially different work.', 'toggle')
    ));
    sec.appendChild(el('h2', 'sub', 'Isolated worktrees'));
    sec.appendChild(card(
      field('worktrees.mode', 'Where agents work', 'Each agent can work in its own copy of the repository (a git worktree seeded with your uncommitted changes), so several agents never clobber each other or your open files. You review the result in the Changes panel and <b>Apply to workspace</b> or <b>Discard</b>. Outside a git repository agents edit directly.', 'select', { options: [['always', 'Always isolate', 'every agent chat gets its own copy (recommended)'], ['parallel', 'Only agents started together', 'Multitask batches and Best of N are isolated; a single chat edits the workspace'], ['off', 'Never', 'agents edit the workspace directly']] }),
      field('worktrees.location', 'Worktree folder', 'Where the copies live, one sub-folder per repository. Empty = <code>~/.localpilot/worktrees</code>. Setup commands for new copies (<code>npm ci</code>…) go in <code>.localpilot/worktrees.json</code> as <code>{ "setup": ["npm ci"] }</code>.', 'text', { placeholder: '~/.localpilot/worktrees', wide: true })
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
    kv.innerHTML = `<dl class="kv store"><dt>Chats</dt><dd><b>${ss.count}</b>${ss.pinned ? ` · ${ss.pinned} pinned` : ''}${ss.running ? ` · <span class="badge on">${ss.running} running</span>` : ''}</dd><dt>Messages</dt><dd>${(ss.messages || 0).toLocaleString()}</dd><dt>On disk</dt><dd>${fmtBytes(ss.bytes)}${ss.oldest ? ` · oldest ${fmtAgo(ss.oldest)}` : ''}</dd><dt>Where</dt><dd>VS Code workspace storage for this folder — never leaves this machine.</dd></dl>`;
    hist.appendChild(kv);
    const retention = field('sessions.retention', 'Keep at most', 'Oldest idle chats are removed automatically when a new chat starts. Pinned and running chats never count. <code>0</code> keeps everything.', 'number', { min: 0, max: 1000, step: 5 });
    hist.appendChild(retention);
    const acts = el('div', 'btnrow');
    acts.innerHTML = `<span class="muted small">Clearing removes idle chats only; running agents keep going and pinned chats can be kept.</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.showSessions">${I.chat}Browse chats</button><button class="btn sm danger" data-cmd="localpilot.clearHistory" ${ss.count ? '' : 'disabled'}>${I.trash}Clear chat history…</button>`;
    hist.appendChild(acts);
    sec.appendChild(hist);
    // ---- memory notes
    sec.appendChild(el('h2', 'sub', 'Memory notes'));
    const mem = el('div', 'btnrow');
    mem.innerHTML = `<span class="muted small">${d.memory.project} project note(s) · ${d.memory.global} global note(s)</span><span class="spacer"></span><button class="btn sm" data-cmd="localpilot.openMemory">${I.book}Open folder</button><button class="btn sm danger" data-cmd="localpilot.clearMemory" ${d.memory.project + d.memory.global ? '' : 'disabled'}>${I.trash}Clear…</button>`;
    sec.appendChild(card(
      field('memory.enabled', 'Enable memory', 'The agent can <code>memory_save</code> / <code>memory_read</code> notes in <code>.localpilot/memory/</code> (project, commit-able) and in global storage. A compact index is added to every prompt.', 'toggle', { after: mem })
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
  const SOURCE_LABEL = { builtin: 'built-in', workspace: 'workspace', user: 'user' };
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
    head(sec, 'Skills & subagents', 'Skills are step-by-step playbooks (<code>SKILL.md</code>) the agent loads when a request matches — project conventions, release procedures, document formats, cloud workflows. Install them from the registry below, write your own, and decide per chat how eagerly they are used.');
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
    const inst = el('div', 'card');
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
      row.appendChild(tg);
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
    const repos = Array.isArray(val('skills.repositories')) ? val('skills.repositories') : [];
    const rcard = el('div', 'card');
    const rf = el('div', 'field wide');
    rf.innerHTML = `<div><div class="lbl">Repositories${scopeBadge('skills.repositories')}${resetBtn('skills.repositories')}</div><div class="desc">GitHub repositories or folders in the <a href="https://agentskills.io">Agent Skills</a> format (<code>owner/repo/path[@ref]</code>). The registry above is their combined index, cached for a day; the first repository wins when several offer the same skill name. Set <code>GITHUB_TOKEN</code> for private repositories or higher rate limits.</div></div>`;
    const rctl = el('div', 'ctl');
    const rul = el('ul', 'list');
    const status = new Map((reg.status || []).map((s) => [s.repo, s]));
    repos.forEach((p, i) => {
      const li = el('li', '', `<code>${esc(p)}</code><span class="muted small sk-st" data-repo="${esc(p)}"> · ${repoStatusText(status.get(p))}</span><span class="spacer"></span><button class="reset x" title="Remove">${I.x}</button>`);
      li.querySelector('button').onclick = () => set('skills.repositories', repos.filter((_, j) => j !== i));
      rul.appendChild(li);
    });
    const raddRow = el('div', 'row', `<input type="text" placeholder="owner/repo/skills" aria-label="Skill repository to add (owner/repo/path)"><button class="btn sm">${I.plus}Add</button>`);
    raddRow.querySelector('button').onclick = () => { const v = raddRow.querySelector('input').value.trim(); if (v) { set('skills.repositories', [...repos, v]); } };
    rctl.appendChild(rul); rctl.appendChild(raddRow); rf.appendChild(rctl); rcard.appendChild(rf);
    const rbar = el('div', 'btnrow');
    rbar.innerHTML = `<span class="muted small">Index cached in <code>~/.localpilot/skill-catalog.json</code>.</span><span class="spacer"></span><button class="btn sm" id="sk-refresh" ${state.busy ? 'disabled' : ''}>${state.busy ? '<span class="spinner"></span>' : I.refresh}Re-index now</button><button class="btn sm" data-cmd="localpilot.installSkill" title="From a GitHub repository (owner/repo or a folder in it), a URL to a SKILL.md, or a local folder">${I.download}Install from URL or folder…</button>`;
    rbar.querySelector('#sk-refresh').onclick = () => { state.busy = true; render(); post({ type: 'refreshSkillRegistry' }); };
    rcard.appendChild(rbar);
    sec.appendChild(rcard);

    // ---- skill folders
    sec.appendChild(el('h2', 'sub', 'Skill folders'));
    const paths = Array.isArray(val('skillsPaths')) ? val('skillsPaths') : [];
    const sp = el('div', 'card');
    const f = el('div', 'field wide');
    f.innerHTML = `<div><div class="lbl">Extra skill folders${scopeBadge('skillsPaths')}${resetBtn('skillsPaths')}</div><div class="desc"><code>.localpilot/skills</code>, <code>.claude/skills</code>, <code>.github/skills</code> and <code>~/.agents/skills</code> are scanned automatically. Add more folders here (each skill is a folder with <code>SKILL.md</code>).</div></div>`;
    const ctl = el('div', 'ctl');
    const ul = el('ul', 'list');
    paths.forEach((p, i) => { const li = el('li', '', `<code>${esc(p)}</code><button class="reset x" title="Remove">${I.x}</button>`); li.querySelector('button').onclick = () => set('skillsPaths', paths.filter((_, j) => j !== i)); ul.appendChild(li); });
    const addRow = el('div', 'row', `<input type="text" placeholder="/path/to/skills or ~/skills" aria-label="Skills folder to add"><button class="btn sm">${I.plus}Add</button>`);
    addRow.querySelector('button').onclick = () => { const v = addRow.querySelector('input').value.trim(); if (v) { set('skillsPaths', [...paths, v]); } };
    ctl.appendChild(ul); ctl.appendChild(addRow); f.appendChild(ctl); sp.appendChild(f); sec.appendChild(sp);

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
  const repoStatusText = (st) => (st ? (st.error ? `<span class="badge err" title="${esc(st.error)}">error</span> ${esc(st.error)}` : `${st.skills} skill${st.skills === 1 ? '' : 's'}${st.fetched ? ` · indexed ${fmtAgo(st.fetched)}` : ''}`) : 'not indexed yet');
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
    if (reg.loading && !reg.entries.length) { box.appendChild(el('div', 'loading short', `<span class="spinner"></span>${reg.refreshing ? 'Indexing the skill repositories for the first time…' : 'Searching the registry…'}`)); return; }
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
      disclosure(c.querySelector('.prov-head'), open, `${name} server settings`, () => { state.expanded = open ? null : `mcp:${name}`; render(); });
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
  // ------------------------------------------------------------------ dashboard (local metrics, telemetry, logs)
  const DASH_RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'All']];
  const fmtN = (n) => { n = Number(n) || 0; return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n); };
  const fmtMs = (ms) => { ms = Number(ms) || 0; return ms >= 60e3 ? `${(ms / 60e3).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10e3 ? 0 : 1)} s` : `${Math.round(ms)} ms`; };
  const pct = (p) => `${Math.round(Number(p) || 0)}%`;
  const fmtTime = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
  /** Tiny inline SVG bar chart; `pick` maps a day point to a number. Bars are titled with day + value. */
  function spark(series, pick, cls) {
    const vals = series.map(pick);
    const max = Math.max(1, ...vals);
    const w = 100 / Math.max(1, vals.length);
    const bars = vals.map((v, i) => `<rect x="${(i * w).toFixed(2)}" y="${(28 - (v / max) * 26).toFixed(2)}" width="${Math.max(0.6, w - 0.8).toFixed(2)}" height="${((v / max) * 26 + 0.5).toFixed(2)}" rx=".6"><title>${esc(series[i].day)} · ${fmtN(v)}</title></rect>`).join('');
    return `<svg class="spark ${cls || ''}" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
  }
  function kpi(label, value, sub, sparkHtml, tone) {
    return `<div class="kpi ${tone || ''}"><div class="kpi-l">${esc(label)}</div><div class="kpi-v">${value}</div>${sub ? `<div class="kpi-s">${sub}</div>` : ''}${sparkHtml || ''}</div>`;
  }
  // --- charts: plain inline SVG, theme chart colours, hover titles, real axis labels. No library, no canvas. ---
  const CH = { w: 600, h: 150, padL: 34, padR: 6, padT: 8, padB: 20 };
  const dayLabel = (day) => { const d = new Date(`${day}T12:00:00`); return isNaN(d) ? day : `${d.getDate()} ${d.toLocaleString(undefined, { month: 'short' })}`; };
  const niceMax = (v) => { if (v <= 0) { return 1; } const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
  /** Y axis: 3 gridlines with labels; X axis: at most ~8 day labels. */
  function axes(series, max, fmt) {
    const { w, h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    let out = '';
    for (const f of [0, 0.5, 1]) { const y = padT + ih - f * ih; out += `<line class="grid" x1="${padL}" x2="${w - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="ax" x="${padL - 5}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${esc(fmt(max * f))}</text>`; }
    const step = Math.max(1, Math.ceil(series.length / 8));
    series.forEach((d, i) => { if (i % step === 0 || i === series.length - 1) { const x = padL + (i + 0.5) * (iw / series.length); out += `<text class="ax" x="${x.toFixed(1)}" y="${h - 5}" text-anchor="middle">${esc(dayLabel(d.day))}</text>`; } });
    return out;
  }
  /** Grouped or stacked bars per day. `keys`: [{ k, label, cls, pick }]. */
  function barChart(series, keys, opts = {}) {
    const { w, h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    const stacked = !!opts.stacked;
    const vals = series.map((d) => keys.map((k) => Number(k.pick(d)) || 0));
    const max = niceMax(Math.max(1, ...vals.map((v) => stacked ? v.reduce((a, b) => a + b, 0) : Math.max(...v))));
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
        bars += `<rect class="s${j} ${k.cls || ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - (stacked ? 0 : 1)).toFixed(1)}" height="${Math.max(0.5, bh).toFixed(1)}" rx="1"><title>${esc(dayLabel(series[i].day))} · ${esc(k.label)}: ${esc(fmt(val))}</title></rect>`;
        acc += val;
      });
    });
    return chartFrame(`${axes(series, max, fmt)}${bars}`, keys);
  }
  /** One or more lines (with a soft area under the first) over the day series. */
  function lineChart(series, keys, opts = {}) {
    const { w, h, padL, padR, padT, padB } = CH; const ih = h - padT - padB; const iw = w - padL - padR;
    const fmt = opts.fmt || fmtN;
    const max = niceMax(Math.max(1, ...series.flatMap((d) => keys.map((k) => Number(k.pick(d)) || 0))));
    const px = (i) => padL + (i + 0.5) * (iw / Math.max(1, series.length)); const py = (v) => padT + ih - (v / max) * ih;
    let out = axes(series, max, fmt);
    keys.forEach((k, j) => {
      const pts = series.map((d, i) => [px(i), py(Number(k.pick(d)) || 0), Number(k.pick(d)) || 0]);
      const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
      if (j === 0 && pts.length > 1) { out += `<path class="area s0" d="${path} L${pts[pts.length - 1][0].toFixed(1)} ${(padT + ih).toFixed(1)} L${pts[0][0].toFixed(1)} ${(padT + ih).toFixed(1)} Z"/>`; }
      out += `<path class="line s${j}" d="${path}"/>`;
      out += pts.map((p, i) => `<circle class="pt s${j}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5"><title>${esc(dayLabel(series[i].day))} · ${esc(k.label)}: ${esc(fmt(p[2]))}</title></circle>`).join('');
    });
    return chartFrame(out, keys);
  }
  function chartFrame(inner, keys) {
    const legend = keys.length > 1 || keys[0].cls ? `<div class="legend">${keys.map((k, j) => `<span><i class="s${j} ${k.cls || ''}"></i>${esc(k.label)}</span>`).join('')}</div>` : '';
    return `<div class="chart"><svg viewBox="0 0 ${CH.w} ${CH.h}" role="img">${inner}</svg>${legend}</div>`;
  }
  /** Donut with a centred headline; `parts`: [{ label, value, cls }]. */
  function donut(parts, centre, sub) {
    const total = parts.reduce((a, p) => a + (Number(p.value) || 0), 0) || 1;
    const r = 34, c = 2 * Math.PI * r; let off = 0; let arcs = '';
    for (const p of parts) { const len = (Number(p.value) / total) * c; if (len > 0) { arcs += `<circle class="${p.cls}" r="${r}" cx="45" cy="45" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(p.label)}: ${fmtN(p.value)} (${pct((p.value / total) * 100)})</title></circle>`; off += len; } }
    return `<div class="donut"><svg viewBox="0 0 90 90" aria-hidden="true"><circle class="track" r="${r}" cx="45" cy="45"/>${arcs}<text class="dv" x="45" y="43" text-anchor="middle">${esc(centre)}</text><text class="ds" x="45" y="56" text-anchor="middle">${esc(sub || '')}</text></svg><ul class="dl">${parts.map((p) => `<li><i class="${p.cls}"></i>${esc(p.label)}<b>${fmtN(p.value)}</b></li>`).join('')}</ul></div>`;
  }
  /** 24-bucket histogram (activity by hour of day) with hour labels. */
  function hourChart(hourly) {
    const max = Math.max(1, ...hourly); const w = 240, h = 70, bw = w / 24;
    const bars = hourly.map((v, i) => `<rect class="s0" x="${(i * bw + 1).toFixed(1)}" y="${(50 - (v / max) * 46).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((v / max) * 46 + 0.5).toFixed(1)}" rx="1"><title>${String(i).padStart(2, '0')}:00 – ${String(i).padStart(2, '0')}:59 · ${fmtN(v)} calls</title></rect>`).join('');
    const labels = [0, 6, 12, 18, 23].map((i) => `<text class="ax" x="${(i * bw + bw / 2).toFixed(1)}" y="64" text-anchor="middle">${String(i).padStart(2, '0')}</text>`).join('');
    return `<div class="chart hours"><svg viewBox="0 0 ${w} ${h}" role="img">${bars}${labels}</svg></div>`;
  }
  const pctl = (p) => p && (p.p50 || p.p95) ? `<span class="pctl" title="median · 95th percentile">${fmtMs(p.p50)} <i>/ ${fmtMs(p.p95)}</i></span>` : '<span class="muted">—</span>';
  function requestDashboard(days) {
    if (typeof days === 'number') { state.dash.days = days; }
    state.dash.loading = true;
    post({ type: 'dashboard', days: state.dash.days });
  }
  function requestLogs() { post({ type: 'logs', level: state.dash.level, q: state.dash.q, follow: state.dash.follow }); }
  function stopDashboardTimer() { if (state.dash.timer) { clearInterval(state.dash.timer); state.dash.timer = null; } if (state.dash.follow) { post({ type: 'logs', level: state.dash.level, q: state.dash.q, follow: false }); } }
  function secDashboard(sec) {
    head(sec, 'Dashboard', 'What LocalPilot did on this machine: model throughput and latency, tool usage, agent runs, inline completions, provider health and the live log. Everything is recorded locally in <code>~/.localpilot/telemetry</code> — nothing is sent anywhere.');
    const bar = el('div', 'dash-bar');
    const seg = el('div', 'seg');
    for (const [d, l] of DASH_RANGES) { const b = el('button', state.dash.days === d ? 'on' : '', esc(l)); b.onclick = () => { requestDashboard(d); render(); }; seg.appendChild(b); }
    bar.appendChild(seg);
    bar.appendChild(el('span', 'spacer'));
    const refresh = el('button', 'btn sm', `${I.refresh}Refresh`); refresh.onclick = () => requestDashboard(); bar.appendChild(refresh);
    const exp = el('button', 'btn sm', `${I.download}Export…`); exp.title = 'Save every recorded event and the current log as JSON'; exp.onclick = () => post({ type: 'exportTelemetry' }); bar.appendChild(exp);
    const folder = el('button', 'btn sm ghost', `${I.folder}Open folder`); folder.onclick = () => post({ type: 'openTelemetryFolder' }); bar.appendChild(folder);
    sec.appendChild(bar);
    const body = el('div', 'dash'); body.id = 'dash'; sec.appendChild(body);
    renderDashboard();
    // Logs
    sec.appendChild(el('h2', 'sub', 'Logs <span class="count" id="logCount"></span>'));
    const lc = el('div', 'card logcard');
    const tools = el('div', 'logbar');
    const lvl = el('select'); lvl.setAttribute('aria-label', 'Minimum level');
    for (const [k, l] of [['trace', 'Trace'], ['debug', 'Debug'], ['info', 'Info'], ['warn', 'Warnings'], ['error', 'Errors']]) { const o = el('option', '', esc(l)); o.value = k; if (k === state.dash.level) { o.selected = true; } lvl.appendChild(o); }
    lvl.onchange = () => { state.dash.level = lvl.value; requestLogs(); };
    const q = el('input'); q.type = 'text'; q.placeholder = 'Filter log lines…'; q.value = state.dash.q; q.setAttribute('aria-label', 'Filter log lines');
    q.oninput = debounce(() => { state.dash.q = q.value.trim(); requestLogs(); }, 250);
    const follow = el('button', `btn sm ${state.dash.follow ? 'on' : ''}`, `${I.play}Follow`); follow.title = 'Stream new lines as they are written';
    follow.onclick = () => { state.dash.follow = !state.dash.follow; follow.classList.toggle('on', state.dash.follow); requestLogs(); };
    const openFile = el('button', 'btn sm', `${I.file}Open log file`); openFile.title = state.dash.logFile || "Today's log file"; openFile.onclick = () => post({ type: 'openLogFile' });
    const channel = el('button', 'btn sm ghost', 'Output channel'); channel.onclick = () => post({ type: 'command', id: 'localpilot.showLogs' });
    tools.append(lvl, q, follow, openFile, channel);
    lc.appendChild(tools);
    const pre = el('div', 'logview'); pre.id = 'logview'; pre.setAttribute('role', 'log'); pre.setAttribute('aria-live', 'polite'); lc.appendChild(pre);
    sec.appendChild(lc);
    renderLogs();
    // Settings
    sec.appendChild(el('h2', 'sub', 'Telemetry'));
    sec.appendChild(card(
      field('telemetry.enabled', 'Record usage metrics', 'Model calls, tokens and latency, tool runs, agent turns, inline completions, provider health and worktree actions are appended to daily JSONL files on this machine so this page can show them. Turning it off stops recording; the log is still mirrored for the viewer above. <b>Nothing is ever sent to a third party.</b>', 'toggle'),
      field('telemetry.retentionDays', 'Keep for', 'Days of metrics and log files to keep; older files are deleted automatically. <code>0</code> keeps everything.', 'number', { min: 0, max: 3650, step: 1 })
    ));
    const danger = el('div', 'btnrow');
    danger.innerHTML = `<span class="muted small" id="dashStorage"></span><span class="spacer"></span><button class="btn sm danger" id="dashClear">${I.trash}Delete all recorded data…</button>`;
    danger.querySelector('#dashClear').onclick = () => post({ type: 'clearTelemetry' });
    sec.appendChild(danger);
    renderStorage();
    // Fresh numbers on open and every 15 s while this page is visible; the log follows live via logLine messages.
    requestDashboard();
    requestLogs();
    if (state.dash.timer) { clearInterval(state.dash.timer); }
    state.dash.timer = setInterval(() => { if (state.section === 'dashboard' && document.visibilityState === 'visible' && !state.dash.loading) { requestDashboard(); } }, 15000);
  }
  function renderStorage() {
    const n = document.getElementById('dashStorage'); const s = state.dash.summary;
    if (!n || !s) { return; }
    n.innerHTML = `${fmtN(s.storage.events)} events · ${fmtBytes(s.storage.bytes)} in ${s.storage.files} file(s)${s.storage.oldest ? ` · since ${new Date(s.storage.oldest).toLocaleDateString()}` : ''} · <code>${esc(s.storage.dir)}</code>`;
  }
  /** Provider display name for a recorded provider id (the id itself when the provider is no longer configured). */
  function provName(id) { const p = providersList().find((x) => x.id === id); return p ? p.displayName || p.id : id; }
  function renderDashboard() {
    const root = document.getElementById('dash');
    if (!root) { return; }
    const s = state.dash.summary;
    if (!s) { root.innerHTML = `<p class="empty">${state.dash.loading ? 'Loading…' : 'No data yet.'}</p>`; return; }
    const t = s.totals;
    const empty = !t.runs && !t.modelCalls && !s.completions.requested && !s.health.length;
    if (empty) {
      root.innerHTML = `<p class="empty">Nothing recorded in this period yet. Start a chat, use inline completions or run the CLI and the numbers appear here.</p>`;
      return;
    }
    const tokens = t.promptTokens + t.completionTokens;
    const okRate = t.runs ? Math.round((t.done / t.runs) * 100) : 0;
    const topTps = s.models.filter((m) => m.tokPerSec).sort((a, b) => b.tokPerSec - a.tokPerSec)[0];
    const health = s.health;
    const up = health.filter((h) => h.up).length;
    const c = s.completions;
    const kpis = el('div', 'kpis');
    kpis.innerHTML = [
      kpi('Agent runs', fmtN(t.runs), `${t.done} done · ${t.stopped} stopped · <span class="${t.failed ? 'err-text' : ''}">${t.failed} failed</span>${t.subagentRuns ? ` · ${t.subagentRuns} subagent` : ''}`, spark(s.series, (d) => d.runs), t.failed && okRate < 70 ? 'warn' : ''),
      kpi('Tokens', fmtN(tokens), `${fmtN(t.promptTokens)} in · ${fmtN(t.completionTokens)} out${topTps ? ` · best <b>${topTps.tokPerSec}</b> tok/s` : ''}`, spark(s.series, (d) => d.tokens)),
      kpi('Model calls', fmtN(t.modelCalls), `${t.retries} retr${t.retries === 1 ? 'y' : 'ies'} · <span class="${t.modelErrors ? 'err-text' : ''}">${t.modelErrors} error${t.modelErrors === 1 ? '' : 's'}</span>`, spark(s.series, (d) => d.modelCalls)),
      kpi('Tool calls', fmtN(t.toolCalls), `<span class="${t.toolErrors ? 'err-text' : ''}">${t.toolErrors} failed</span>${t.toolCalls ? ` · ${pct(100 - (t.toolErrors / t.toolCalls) * 100)} ok` : ''}`, spark(s.series, (d) => d.toolCalls)),
      kpi('Completions', c.shown + c.cached ? pct(c.acceptanceRate) : '—', c.requested ? `${fmtN(c.accepted)} accepted of ${fmtN(c.shown + c.cached)} shown · ${fmtN(c.requested)} requested${c.latency.p50 ? ` · ${fmtMs(c.latency.p50)} median` : ''}` : 'no inline completions yet', spark(s.series, (d) => d.completionsShown)),
      kpi('Providers', health.length ? `${up}/${health.length} up` : '—', health.length ? health.map((h) => `<span class="dot ${h.up ? 'ok' : 'err'}"></span>${esc(provName(h.provider))} ${pct(h.uptime)}`).join(' · ') : 'no checks yet', '', health.length && up < health.length ? 'warn' : ''),
      kpi('Throughput', t.tokPerSec ? `${t.tokPerSec} <span class="kpi-u">tok/s</span>` : '—', t.tokPerSec ? `generation speed across all calls${topTps ? ` · fastest ${esc(topTps.model)}` : ''}` : 'no completed calls yet', spark(s.series, (d) => d.tokPerSec)),
      kpi('Turn time', t.runTime.p50 ? fmtMs(t.runTime.p50) : '—', t.runTime.p50 ? `median · p95 ${fmtMs(t.runTime.p95)} · ${t.steps.p50} step${t.steps.p50 === 1 ? '' : 's'} per turn` : 'no finished turns yet', ''),
      kpi('Cache hits', t.toolCalls ? pct((t.cachedTools / t.toolCalls) * 100) : '—', t.toolCalls ? `${fmtN(t.cachedTools)} read-only tool calls answered from the turn cache` : 'no tool calls yet', spark(s.series, (d) => d.cachedTools)),
    ].join('');
    root.innerHTML = '';
    root.appendChild(kpis);
    // Charts: activity per day, tokens in/out, generation speed, outcomes, tool reliability, hour of day.
    const many = s.series.length > 1;
    if (many) {
      const charts = el('div', 'dash-cols charts');
      const act = el('div', 'card');
      act.innerHTML = `<h3>Activity <span class="count">${t.activeDays} of ${s.series.length} day${s.series.length === 1 ? '' : 's'} active</span></h3>` + barChart(s.series, [{ label: 'Model calls', pick: (d) => d.modelCalls }, { label: 'Tool calls', pick: (d) => d.toolCalls }, { label: 'Agent runs', pick: (d) => d.runs }, { label: 'Errors', cls: 'err', pick: (d) => d.errors }]);
      charts.appendChild(act);
      const tok = el('div', 'card');
      tok.innerHTML = `<h3>Tokens <span class="count">${fmtN(tokens)}</span></h3>` + barChart(s.series, [{ label: 'Prompt (in)', pick: (d) => d.promptTokens }, { label: 'Completion (out)', pick: (d) => d.completionTokens }], { stacked: true });
      charts.appendChild(tok);
      root.appendChild(charts);
      const charts2 = el('div', 'dash-cols charts');
      const spd = el('div', 'card');
      spd.innerHTML = `<h3>Generation speed <span class="count">tok/s per day</span></h3>` + lineChart(s.series, [{ label: 'Completion tokens / s', pick: (d) => d.tokPerSec }], { fmt: (v) => `${Math.round(v)}` });
      charts2.appendChild(spd);
      const acc = el('div', 'card');
      acc.innerHTML = `<h3>Completions <span class="count">shown vs accepted</span></h3>` + barChart(s.series, [{ label: 'Shown', pick: (d) => d.completionsShown }, { label: 'Accepted', pick: (d) => d.completionsAccepted }]);
      charts2.appendChild(acc);
      root.appendChild(charts2);
    }
    const rings = el('div', 'dash-cols rings');
    const oc = el('div', 'card');
    oc.innerHTML = `<h3>Run outcomes</h3>` + (t.runs ? donut([{ label: 'Done', value: t.done, cls: 'ok' }, { label: 'Stopped', value: t.stopped, cls: 'muted' }, { label: 'Failed', value: t.failed, cls: 'err' }], pct(okRate), 'completed') : '<p class="empty">No runs yet.</p>');
    rings.appendChild(oc);
    const tc = el('div', 'card');
    tc.innerHTML = `<h3>Tool reliability</h3>` + (t.toolCalls ? donut([{ label: 'Succeeded', value: t.toolCalls - t.toolErrors - t.cachedTools, cls: 'ok' }, { label: 'From cache', value: t.cachedTools, cls: 's0' }, { label: 'Failed', value: t.toolErrors, cls: 'err' }], pct(100 - (t.toolErrors / t.toolCalls) * 100), 'ok') : '<p class="empty">No tool calls yet.</p>');
    rings.appendChild(tc);
    const hc0 = el('div', 'card');
    const peak = s.hourly.indexOf(Math.max(...s.hourly));
    hc0.innerHTML = `<h3>Activity by hour <span class="count">${s.hourly.some(Boolean) ? `busiest ${String(peak).padStart(2, '0')}:00` : ''}</span></h3>` + (s.hourly.some(Boolean) ? hourChart(s.hourly) : '<p class="empty">No activity yet.</p>');
    rings.appendChild(hc0);
    root.appendChild(rings);
    // Models
    const cols = el('div', 'dash-cols');
    const models = el('div', 'card tblwrap');
    models.innerHTML = `<h3>Models <span class="count">${s.models.length}</span></h3>` + (s.models.length ? `<table class="tbl dash-tbl"><thead><tr><th>Model</th><th>Calls</th><th>Tokens in / out</th><th title="completion tokens per second of generation">tok/s</th><th title="time to first token: median / p95">First token</th><th title="whole request: median / p95">Request</th><th>Errors</th></tr></thead><tbody>${s.models.map((m) => `<tr><td class="mono"><b>${esc(m.model)}</b><span class="muted small"> · ${esc(provName(m.provider))}</span></td><td>${fmtN(m.calls)}</td><td>${fmtN(m.promptTokens)} / ${fmtN(m.completionTokens)}</td><td>${m.tokPerSec ? `<b>${m.tokPerSec}</b>` : '—'}</td><td>${pctl(m.ttft)}</td><td>${pctl(m.duration)}</td><td class="${m.errors ? 'err-text' : 'muted'}">${m.errors}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No model calls in this period.</p>');
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
    // Recent errors
    if (s.errors.length) {
      const ec = el('div', 'card tblwrap');
      ec.innerHTML = `<h3>Recent problems <span class="count">${s.errors.length}</span></h3><table class="tbl dash-tbl errs"><tbody>${s.errors.slice(0, 12).map((e) => `<tr><td class="muted small nowrap">${fmtAgo(e.t)}</td><td><span class="badge ${e.kind === 'health' ? 'warn' : 'err'}">${esc(e.kind)}</span></td><td class="mono">${esc(e.kind === 'health' ? provName(e.what) : e.what)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('')}</tbody></table>`;
      root.appendChild(ec);
    }
    renderStorage();
  }
  const LOG_RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
  function logLine(e) { return `<div class="ll ${e.level}"><span class="lt">${fmtTime(e.t)}</span><span class="lv">${e.level}</span><span class="lm">${esc(e.msg)}</span></div>`; }
  function renderLogs() {
    const v = document.getElementById('logview'); const n = document.getElementById('logCount');
    if (!v) { return; }
    const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 40;
    v.innerHTML = state.dash.logs.length ? state.dash.logs.map(logLine).join('') : `<p class="empty">${state.dash.q ? 'No log lines match.' : 'Nothing logged yet.'}</p>`;
    if (n) { n.textContent = state.dash.logs.length ? String(state.dash.logs.length) : ''; }
    if (atBottom || state.dash.follow) { v.scrollTop = v.scrollHeight; }
  }
  function appendLog(e) {
    if (LOG_RANK[e.level] < LOG_RANK[state.dash.level] || (state.dash.q && !e.msg.toLowerCase().includes(state.dash.q.toLowerCase()))) { return; }
    state.dash.logs.push(e);
    if (state.dash.logs.length > 500) { state.dash.logs.shift(); }
    const v = document.getElementById('logview');
    if (!v) { return; }
    const empty = v.querySelector('.empty'); if (empty) { empty.remove(); }
    v.insertAdjacentHTML('beforeend', logLine(e));
    while (v.childElementCount > 500) { v.firstElementChild.remove(); }
    const n = document.getElementById('logCount'); if (n) { n.textContent = String(state.dash.logs.length); }
    if (state.dash.follow) { v.scrollTop = v.scrollHeight; }
  }

  function secAdvanced(sec) {
    const d = state.data;
    head(sec, 'Advanced', 'Housekeeping, diagnostics and the raw settings files.');
    sec.appendChild(card(
      field('showWelcomeOnStartup', 'Show setup on first run', 'Open the welcome screen when LocalPilot starts and no model server has been configured yet.', 'toggle'),
      field('chat.location', 'Chat location', 'Where the chat lives. Changing it moves the chat right away; the LocalPilot icon in the editor title bar and the status bar always open it wherever it is.', 'select', { options: [['sidebar', 'Primary Side Bar', 'left, with the Explorer'], ['secondarySidebar', 'Secondary Side Bar', 'right, where Copilot Chat lives'], ['panel', 'Panel', 'bottom, next to the Terminal'], ['editor', 'Editor Area', 'a tab in the main area']] })
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
    about.innerHTML = `<div class="field wide"><dl class="kv"><dt>Version</dt><dd>${esc(d.version)}</dd><dt>Chats</dt><dd>${d.sessions && typeof d.sessions === 'object' ? d.sessions.count : d.sessions}</dd><dt>Models</dt><dd>${(d.models || []).length} from ${providersList().filter((p) => p.enabled !== false).length} provider(s)</dd><dt>Privacy</dt><dd>LocalPilot talks only to the servers listed under Providers. No telemetry, no account.</dd><dt>Author</dt><dd><a data-url="https://github.com/isathish">Sathishkumar Nagarajan</a> · <a data-url="https://github.com/isathish">@isathish on GitHub</a></dd><dt>Links</dt><dd><a data-url="https://isathish.github.io/localpilot/">Website</a> · <a data-url="https://isathish.github.io/localpilot/docs/configuration/">Configuration reference</a> · <a data-url="https://github.com/isathish/localpilot/issues">Report an issue</a></dd></dl></div>`;
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
        const sub = ol && !ol.installed ? `Downloads and installs Ollama in the background (no admin rights needed), starts it and downloads ${plan}. One click — nothing else to configure.` : ol && !ol.running ? `Ollama is installed but not running. Starts it and downloads ${plan}.` : `Downloads ${plan} into Ollama.`;
        help.innerHTML = `<div class="auto-setup"><button class="btn brand" id="autoSetup" ${setupJob ? 'disabled' : ''}>${setupJob ? '<span class="spinner"></span>' : I.download}${esc(setupJob ? 'Setting up…' : label)}</button><div class="auto-sub">${setupJob ? `<b data-job-title="${esc(setupJob.id)}">${esc(setupTitle(setupJob))}</b><span data-job-detail="${esc(setupJob.id)}">${esc(setupJob.detail || '')}</span>${setupJob.progress >= 0 ? `<div class="progress" data-job="${esc(setupJob.id)}"><i style="width:${barWidth(setupJob)}"></i></div>` : ''}` : esc(sub)}</div></div><p class="hint"><b>Or do it yourself</b> — any of these works:</p><ul class="help-list"><li><b>Ollama</b> — install from <a data-url="https://ollama.com">ollama.com</a>, then <code>ollama pull qwen2.5-coder:7b</code>. It starts automatically.</li><li><b>Docker</b> — <code>docker model pull ai/qwen2.5-coder</code> with Docker Desktop's Model Runner (enable host access: <code>docker desktop enable model-runner --tcp=12434</code>), or run any Ollama / vLLM / llama.cpp container with a published port.</li><li><b>LM Studio</b> — open the <i>Developer</i> tab and start the local server (port 1234).</li><li><b>llama.cpp</b> — <code>llama-server -m model.gguf --port 8080</code></li><li><b>vLLM</b> — <code>vllm serve Qwen/Qwen2.5-Coder-7B-Instruct</code></li></ul>`;
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
      c.innerHTML = `<h3>2 · Choose a default model</h3><p class="hint">For agent mode pick a tool-capable model (gemma4 e2b–12b, nemotron-3.5-bolt, devstral, gpt-oss). You can switch per chat at any time.</p>`;
      const list = el('div', 'mdl-list');
      if (!all.length) {
        const e = el('div', 'empty', 'The server is running but has no models yet. <button class="btn brand sm" id="autoSetup2">Download a starter model</button> or pull one by hand (e.g. <code>ollama pull gemma4:e4b</code>) and go back.');
        e.querySelector('#autoSetup2').onclick = () => { su.pendingAuto = true; post({ type: 'autoSetup', installRuntime: false, target: 'ollama' }); su.step = 0; render(); };
        list.appendChild(e);
      }
      for (const m of all) {
        const b = el('button', `mdl ${su.model === m.id ? 'on' : ''}`, `${vendorMark(vendorFromModelId(m.modelId || m.name), m.name)}<div class="t"><b>${esc(m.name)}</b><span>${esc(m.provider)} · ${Math.round(m.contextWindow / 1024)}k context</span></div><div class="tags">${m.id === recommend(found) ? '<span class="badge brand">recommended</span>' : ''}${m.supportsTools ? '<span class="badge ok">tools</span>' : '<span class="badge">prompt tools</span>'}${m.supportsVision ? '<span class="badge">vision</span>' : ''}${m.supportsFim ? '<span class="badge">FIM</span>' : ''}</div>`);
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
    const score = (m) => { const n = m.name.toLowerCase(); const sz = /(\d+(?:\.\d+)?)b/.exec(n); const b = sz ? parseFloat(sz[1]) : 7; return (m.supportsTools ? 10 : 0) + (/coder|devstral|codestral/.test(n) ? 5 : 0) + (/gemma4|gemma-4|nemotron-3\.5-bolt/.test(n) ? 8 : 0) + (/qwen|llama|mistral|gemma|deepseek|gpt-oss|nemotron/.test(n) ? 2 : 0) + Math.min(b, 32) / 8 - (b > 40 ? 3 : 0) - (/embed|rerank|vl|llava|whisper/.test(n) ? 20 : 0); };
    return [...all].sort((a, b) => score(b) - score(a))[0]?.id || '';
  }

  // ------------------------------------------------------------------ messaging
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state': {
        const prev = state.data;
        state.data = m;
        if (prev && state.pendingSave && Date.now() - state.pendingSave < 10_000) { state.pendingSave = 0; flashSaved(); }
        const nav = !prev || m.navigate !== false;
        const navChanged = nav && ((m.page && m.page !== state.page) || (m.section && m.section !== state.section));
        if (nav && m.page) { state.page = m.page; }
        if (nav && m.section) { state.section = m.section; }
        if (nav && m.section === 'models' && state.models && !state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
        if (!prev || navChanged || state.page === 'setup' || !app.querySelector('main.content > .sec')) { render(); break; }
        // A settings round-trip: find what actually changed and refresh only those components.
        const keys = new Set([...Object.keys(prev.settings || {}), ...Object.keys(m.settings || {})]);
        const changed = [...keys].filter((k) => JSON.stringify((prev.settings || {})[k]) !== JSON.stringify((m.settings || {})[k]));
        const SECTION_DATA = { providers: ['models'], models: ['models'], gallery: ['models'], skills: ['skills', 'agents', 'learning'], completions: ['models'], memory: ['memory'], mcp: ['mcp'], advanced: ['models', 'sessions', 'version'] };
        const otherChanged = ['hasWorkspace', ...(SECTION_DATA[state.section] || [])].some((k) => JSON.stringify(prev[k]) !== JSON.stringify(m[k]));
        if (otherChanged || changed.some((k) => STRUCTURAL_KEYS.has(k))) { render(); break; }
        if (changed.length) { refreshComponents(changed); }
        break;
      }
      case 'probe': {
        state.probe = m.results; state.busy = false; state.dmr = m.dockerModelRunner || null; state.runtimes = m.runtimes || state.runtimes; state.starter = m.starter || state.starter;
        for (const r of m.results) { state.tests[r.id] = r; }
        // After a one-click setup from the wizard, jump straight to the model step with the recommendation selected.
        const found = m.results.filter((r) => r.ok && r.models.length);
        if (state.page === 'setup' && state.setup.pendingAuto && found.length) { state.setup.pendingAuto = false; state.setup.providers = m.results.filter((r) => r.ok || r.configured).map((r) => ({ id: r.id, type: r.type, baseUrl: r.baseUrl, displayName: r.displayName })); state.setup.model = recommend(found); state.setup.step = 1; }
        render();
        break;
      }
      case 'testResult': {
        state.tests[m.id] = m.result;
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
        g.models = [...(m.page > 1 ? g.models : []), ...(m.models || []).filter((x) => !seen.has(x.name))];
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
        break;
      }
      case 'skillJob':
        state.skillReg.jobs[m.name] = { status: m.status, detail: m.detail };
        if (m.status === 'done') { setTimeout(() => { delete state.skillReg.jobs[m.name]; if (state.section === 'skills') { renderSkillRegistry(); } }, 1500); }
        if (state.section === 'skills') { renderSkillRegistry(); }
        break;
      case 'busy':
        state.busy = m.busy;
        if (!m.busy) { render(); }
        break;
      case 'dashboard':
        state.dash.loading = false;
        state.dash.summary = m.summary; state.dash.logFile = m.logFile || '';
        if (typeof m.days === 'number') { state.dash.days = m.days; }
        if (state.section === 'dashboard') { renderDashboard(); }
        break;
      case 'logs':
        state.dash.logs = Array.isArray(m.entries) ? m.entries : [];
        if (state.section === 'dashboard') { renderLogs(); }
        break;
      case 'logLine':
        if (state.section === 'dashboard' && m.entry) { appendLog(m.entry); }
        break;
      case 'toast':
        toast(m.text, m.level);
        break;
    }
  });
  post({ type: 'ready' });
})();
