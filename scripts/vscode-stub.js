// Minimal `vscode` stand-in so provider/agent modules can be exercised outside the editor.
const fs = require('fs/promises');
class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (l) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
  fire(v) { for (const l of this.listeners) l(v); }
  dispose() { this.listeners.clear(); }
}
class Disposable {
  constructor(fn) { this.fn = fn; }
  dispose() { this.fn && this.fn(); }
  static from(...ds) { return new Disposable(() => ds.forEach((d) => d.dispose())); }
}
module.exports = {
  EventEmitter,
  Disposable,
  Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }), joinPath: (u, ...s) => ({ fsPath: [u.fsPath, ...s].join('/') }) },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      // autoClarify off: the smoke prompts ("go") are deliberately terse and the agent-loop checks assert the exact transcript shape.
      // LP_CONFIG: JSON of setting overrides for a smoke section, e.g. {"routing.parallelModels": false}.
      get: (k, d) => (process.env.LP_CONFIG && k in JSON.parse(process.env.LP_CONFIG) ? JSON.parse(process.env.LP_CONFIG)[k] : k === 'providers' && process.env.LP_MOCK_URL ? [{ id: 'mock', type: 'openai', baseUrl: process.env.LP_MOCK_URL }] : k === 'approvals.terminal' ? 'always' : k === 'autoClarify' ? false : k === 'skills.disabled' && process.env.LP_SKILLS_DISABLED ? process.env.LP_SKILLS_DISABLED.split(',') : d),
      update: async () => {},
    }),
    onDidChangeConfiguration: () => new Disposable(),
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    asRelativePath: (u) => (typeof u === 'string' ? u : u.fsPath),
    // Real files, so SkillManager can load skills from a temp folder in the smoke tests.
    fs: {
      readDirectory: async (u) => (await fs.readdir(u.fsPath, { withFileTypes: true })).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
      readFile: async (u) => new Uint8Array(await fs.readFile(u.fsPath)),
      // The session store persists through these; the smoke tests only need them to not throw.
      createDirectory: async () => {},
      writeFile: async () => {},
      delete: async () => {},
    },
  },
  window: {
    activeTextEditor: undefined,
    tabGroups: { all: [] },
    // Notifications are recorded so tests can assert that a hidden chat mirrored a prompt; nobody "answers" them.
    notifications: [],
    showWarningMessage(message) { module.exports.window.notifications.push(message); return Promise.resolve(undefined); },
    showInformationMessage() { return Promise.resolve(undefined); },
  },
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  env: { appRoot: '' },
  FileType: { File: 1, Directory: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ConfigurationTarget: { Global: 1 },
  // Module-level references in UI modules pulled in by ChatController.
  CodeActionKind: { QuickFix: 'quickfix', RefactorRewrite: 'refactor.rewrite' },
  ViewColumn: { Active: -1, Beside: -2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
};
