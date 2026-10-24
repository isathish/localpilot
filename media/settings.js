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
    ['web', 'Web search', I.globe], ['memory', 'Memory & history', I.brain], ['mcp', 'MCP servers', I.plug], ['advanced', 'Advanced', I.wrench],
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
  function render() {
    if (!state.data) { return; }
    // Rebuilding collapses the document and drops the scroll position; put it back once the page is rebuilt.
    const y = window.scrollY;
    app.removeAttribute('aria-busy');
    if (state.page === 'setup') {
      app.innerHTML = ''; app.dataset.page = 'setup';
      renderSetup();
    } else {
      if (app.dataset.page !== 'settings') { app.innerHTML = ''; app.dataset.page = 'settings'; renderShell(); }
      syncShell();
      renderSection();
    }
    if (y) { window.scrollTo(0, y); }
  }
  function renderShell() {
    const d = state.data;
    const top = el('header', 'top');
    top.innerHTML = `<div class="brand"><img src="${LOGO}" alt=""><div><b>LocalPilot</b><span>Settings · v${esc(d.version)}</span></div></div><span class="spacer"></span>
      <div class="scope" role="radiogroup" aria-label="Settings scope"><button data-s="user">User</button><button data-s="workspace">Workspace</button></div>
      <button class="btn" data-cmd="localpilot.openChat">${I.chat}Open chat</button>`;
    top.querySelectorAll('.scope button').forEach((b) => (b.onclick = () => { if (b.disabled) { return; } state.scope = b.dataset.s; render(); }));
    app.appendChild(top);
    const layout = el('div', 'layout');
    const side = el('nav', 'side');
    side.innerHTML = `<div class="grp">Settings</div>${SECTIONS.map(([id, label, icon]) => `<a data-sec="${id}">${icon}${esc(label)}</a>`).join('')}<div class="grp">Help</div><a data-cmd="localpilot.openWelcome">${I.rocket}Run setup again</a><a data-url="https://isathish.github.io/localpilot/docs/configuration/">${I.book}Documentation</a>`;
    side.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; state.expanded = null; render(); }));
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
    app.querySelectorAll('.side [data-sec]').forEach((a) => a.classList.toggle('on', a.dataset.sec === state.section));
  }
  function renderSection() {
    const sec = el('section', 'sec');
    ({ providers: secProviders, models: secModels, agent: secAgent, completions: secCompletions, web: secWeb, memory: secMemory, mcp: secMcp, advanced: secAdvanced }[state.section] || secProviders)(sec);
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
  }
  function providerCard(p, list) {
    const probe = (state.probe || []).find((r) => r.id === p.id) || state.tests[p.id];
    const open = state.expanded === p.id;
    const c = el('div', `prov ${p.enabled === false ? 'off' : ''}`);
    c.dataset.prov = p.id;
    const status = probe ? (probe.ok ? 'ok' : 'err') : state.busy ? 'busy' : '';
    const n = probe && probe.ok ? `${probe.models.length} model${probe.models.length === 1 ? '' : 's'} · ${probe.latencyMs} ms` : probe ? 'unreachable' : (state.data.models || []).filter((m) => m.providerId === p.id).length ? `${(state.data.models || []).filter((m) => m.providerId === p.id).length} models` : '';
    c.innerHTML = `<div class="prov-head"><span class="dot ${status}"></span>${brandMark(p, p.displayName || p.id)}<div class="prov-title"><b>${esc(p.displayName || p.id)}</b><span>${esc(p.baseUrl)}</span></div><div class="prov-meta"><span class="badge">${p.type === 'ollama' ? 'Ollama API' : 'OpenAI API'}</span>${n ? `<span class="badge ${status}">${esc(n)}</span>` : ''}${p.enabled === false ? '<span class="badge">disabled</span>' : ''}<span class="chev" style="transform:rotate(${open ? 90 : 0}deg)">${I.chev}</span></div></div>`;
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
    sec.querySelectorAll('[data-sec]').forEach((a) => (a.onclick = () => { state.section = a.dataset.sec; render(); }));
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
    head(sec, 'Memory & history', 'What LocalPilot keeps on this machine: chat history for this workspace, durable notes the agent writes, and the skills and subagents it can load.');
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
    sec.appendChild(el('h2', 'sub', 'Skill folders'));
    const paths = Array.isArray(val('skillsPaths')) ? val('skillsPaths') : [];
    const sp = el('div', 'card');
    sp.appendChild(field('skills.builtin', 'Built-in skills', 'Playbooks that ship with LocalPilot for the whole development loop: <code>requirements</code>, <code>design</code>, <code>new-project</code>, <code>implement</code>, <code>test</code>, <code>debug</code>, <code>review</code>, <code>refactor</code>, <code>ui-design</code>, <code>claude-ui-ux</code>, <code>docs</code>, <code>deploy</code>, <code>ship</code>, <code>explore-codebase</code>. A workspace or user skill with the same name overrides the bundled one.', 'toggle'));
    const f = el('div', 'field wide');
    f.innerHTML = `<div><div class="lbl">Extra skill folders${scopeBadge('skillsPaths')}${resetBtn('skillsPaths')}</div><div class="desc"><code>.localpilot/skills</code>, <code>.claude/skills</code>, <code>.github/skills</code> and <code>~/.agents/skills</code> are scanned automatically. Add more folders here (each skill is a folder with <code>SKILL.md</code>).</div></div>`;
    const ctl = el('div', 'ctl');
    const ul = el('ul', 'list');
    paths.forEach((p, i) => { const li = el('li', '', `<code>${esc(p)}</code><button class="reset x" title="Remove">${I.x}</button>`); li.querySelector('button').onclick = () => set('skillsPaths', paths.filter((_, j) => j !== i)); ul.appendChild(li); });
    const addRow = el('div', 'row', `<input type="text" placeholder="/path/to/skills or ~/skills"><button class="btn sm">${I.plus}Add</button>`);
    addRow.querySelector('button').onclick = () => { const v = addRow.querySelector('input').value.trim(); if (v) { set('skillsPaths', [...paths, v]); } };
    ctl.appendChild(ul); ctl.appendChild(addRow); f.appendChild(ctl); sp.appendChild(f); sec.appendChild(sp);
    sec.appendChild(el('h2', 'sub', 'Skill catalog'));
    const cat = el('div', 'card');
    cat.appendChild(field('skills.autoInstall', 'Install matching skills', 'When a request matches a skill from the repositories below better than anything installed — planning, design docs, debugging, writing Markdown, PDFs… — install it as the request starts, offer it as a chip, or never look.', 'seg', { options: [['auto', 'Automatically'], ['ask', 'Ask'], ['off', 'Off']] }));
    cat.appendChild(field('skills.autoInstallScope', 'Install into', 'Automatically installed skills go to your home folder (every workspace) or the current project.', 'seg', { options: [['user', '~/.localpilot/skills'], ['workspace', '.localpilot/skills']] }));
    const repos = Array.isArray(val('skills.repositories')) ? val('skills.repositories') : [];
    const rf = el('div', 'field wide');
    rf.innerHTML = `<div><div class="lbl">Skill repositories${scopeBadge('skills.repositories')}${resetBtn('skills.repositories')}</div><div class="desc">GitHub repositories or folders in the <a href="https://agentskills.io">Agent Skills</a> format (<code>owner/repo/path</code>). The first one wins when several offer the same skill name. Browse and install from them with the button below.</div></div>`;
    const rctl = el('div', 'ctl');
    const rul = el('ul', 'list');
    repos.forEach((p, i) => { const li = el('li', '', `<code>${esc(p)}</code><button class="reset x" title="Remove">${I.x}</button>`); li.querySelector('button').onclick = () => set('skills.repositories', repos.filter((_, j) => j !== i)); rul.appendChild(li); });
    const raddRow = el('div', 'row', `<input type="text" placeholder="owner/repo/skills"><button class="btn sm">${I.plus}Add</button>`);
    raddRow.querySelector('button').onclick = () => { const v = raddRow.querySelector('input').value.trim(); if (v) { set('skills.repositories', [...repos, v]); } };
    rctl.appendChild(rul); rctl.appendChild(raddRow); rf.appendChild(rctl); cat.appendChild(rf); sec.appendChild(cat);
    const SOURCE_LABEL = { builtin: 'built-in', workspace: 'workspace', user: 'user' };
    const tableFor = (title, rows, empty, usage) => {
      const h = el('h2', 'sub', `${title} (${rows.length})`);
      sec.appendChild(h);
      if (!rows.length) { sec.appendChild(el('div', 'empty', empty)); return; }
      const t = el('table', 'tbl', `<thead><tr><th>Name</th><th>Description</th><th>Source</th>${usage ? '<th title="Times the agent loaded this skill">Used</th>' : ''}</tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.name)}</td><td>${esc(r.description)}</td><td><span class="badge">${esc(SOURCE_LABEL[r.source] || r.source)}</span></td>${usage ? `<td class="mono muted">${r.used ? `${r.used}×` : '—'}</td>` : ''}</tr>`).join('')}</tbody>`);
      sec.appendChild(card(t));
    };
    tableFor('Skills', d.skills, 'No skills found. Use <b>Browse catalog…</b> or <b>Install skill…</b> below, or create <code>.localpilot/skills/&lt;name&gt;/SKILL.md</code> in your project.', true);
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
    tableFor('Subagents', d.agents, 'No subagents found. Create <code>.localpilot/agents/&lt;name&gt;.md</code> with a description and system prompt.');
    const bar = el('div', 'btnrow'); bar.style.marginTop = '12px';
    bar.innerHTML = `<button class="btn primary" data-cmd="localpilot.browseSkills" title="Search the configured skill repositories and install from them">${I.book}Browse catalog…</button><button class="btn" data-cmd="localpilot.installSkill" title="From a GitHub repository (owner/repo or a folder in it), a URL to a SKILL.md, or a local folder">${I.download}Install skill…</button><button class="btn" data-cmd="localpilot.reloadSkills">${I.refresh}Reload skills, subagents & MCP</button>`;
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
        const nav = !prev || m.navigate !== false;
        const navChanged = nav && ((m.page && m.page !== state.page) || (m.section && m.section !== state.section));
        if (nav && m.page) { state.page = m.page; }
        if (nav && m.section) { state.section = m.section; }
        if (nav && m.section === 'models' && state.models && !state.modelsRequested) { state.modelsRequested = true; post({ type: 'loadModels' }); }
        if (!prev || navChanged || state.page === 'setup' || !app.querySelector('main.content > .sec')) { render(); break; }
        // A settings round-trip: find what actually changed and refresh only those components.
        const keys = new Set([...Object.keys(prev.settings || {}), ...Object.keys(m.settings || {})]);
        const changed = [...keys].filter((k) => JSON.stringify((prev.settings || {})[k]) !== JSON.stringify((m.settings || {})[k]));
        const SECTION_DATA = { providers: ['models'], models: ['models'], completions: ['models'], memory: ['skills', 'agents', 'memory'], mcp: ['mcp'], advanced: ['models', 'sessions', 'version'] };
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
        if (state.section === 'models' || state.page === 'setup') { render(); }
        break;
      case 'jobs': {
        state.jobs = m.jobs || [];
        const sig = jobsSig(state.jobs);
        const same = sig === state.jobsSig;
        state.jobsSig = sig;
        if ((state.section === 'models' && state.models) || state.page === 'setup') { if (same) { patchJobs(); } else { render(); } }
        break;
      }
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
