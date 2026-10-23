import * as path from 'path';
import * as vscode from 'vscode';
import { balancedShards, ParallelPool } from '../agent/parallel';
import { Tool } from '../types';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**,**/.next/**,**/target/**,**/coverage/**,**/.vscode-test/**,**/*.min.js,**/*.map,**/*.lock,**/package-lock.json}';
const MAX_FILES = 20_000;
/** Manifests worth summarising (name, scripts, dependency counts) — read concurrently, never fully quoted. */
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'pubspec.yaml', 'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'Makefile'];
const LANG_BY_EXT: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', rb: 'Ruby', php: 'PHP',
  swift: 'Swift', c: 'C', h: 'C/C++ headers', cc: 'C++', cpp: 'C++', hpp: 'C/C++ headers', css: 'CSS', scss: 'SCSS', html: 'HTML', vue: 'Vue', svelte: 'Svelte', md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML', sql: 'SQL', sh: 'Shell', dart: 'Dart',
};
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|test_[^/]+\.py$/;

export interface WorkspaceShard {
  /** Short label for the shard, e.g. `src/agent + src/tools`. */
  label: string;
  /** Workspace-relative folders (or files at the root) in this shard. */
  paths: string[];
  files: number;
}

export interface WorkspaceAnalysis {
  root: string;
  files: number;
  truncated: boolean;
  languages: { name: string; files: number }[];
  folders: { path: string; files: number; tests: number; languages: string[] }[];
  rootFiles: string[];
  manifests: { path: string; summary: string }[];
  testFiles: number;
  shards: WorkspaceShard[];
}

/** Pure part of the analysis: groups workspace-relative paths into folders, languages and balanced shards. */
export function summarizeWorkspace(root: string, relPaths: readonly string[], parts: number, truncated = false): WorkspaceAnalysis {
  const langs = new Map<string, number>();
  const folders = new Map<string, { files: number; tests: number; langs: Map<string, number> }>();
  const rootFiles: string[] = [];
  let testFiles = 0;
  for (const rel of relPaths) {
    const norm = rel.split(path.sep).join('/');
    const ext = path.extname(norm).slice(1).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    if (lang) {
      langs.set(lang, (langs.get(lang) ?? 0) + 1);
    }
    const isTest = TEST_PATH.test(norm);
    if (isTest) {
      testFiles++;
    }
    const segs = norm.split('/');
    if (segs.length === 1) {
      rootFiles.push(norm);
      continue;
    }
    // Shard key: top-level folder, or second level for very large top-level folders (src/agent, src/ui…).
    const key = segs[0];
    const f = folders.get(key) ?? { files: 0, tests: 0, langs: new Map<string, number>() };
    f.files++;
    if (isTest) {
      f.tests++;
    }
    if (lang) {
      f.langs.set(lang, (f.langs.get(lang) ?? 0) + 1);
    }
    folders.set(key, f);
  }
  // Split big top-level folders by their subfolders so shards stay balanced.
  const units: { path: string; files: number }[] = [];
  const total = relPaths.length;
  for (const [name, f] of folders) {
    if (f.files > Math.max(40, total / Math.max(2, parts)) && total > 60) {
      const sub = new Map<string, number>();
      for (const rel of relPaths) {
        const segs = rel.split(path.sep).join('/').split('/');
        if (segs[0] === name && segs.length > 1) {
          const k = segs.length > 2 ? `${name}/${segs[1]}` : `${name}/*`;
          sub.set(k, (sub.get(k) ?? 0) + 1);
        }
      }
      for (const [p, n] of sub) {
        units.push({ path: p, files: n });
      }
    } else {
      units.push({ path: `${name}/`, files: f.files });
    }
  }
  if (rootFiles.length) {
    units.push({ path: '(root files)', files: rootFiles.length });
  }
  const shards = balancedShards(units, (u) => u.files, parts).map((group) => ({
    label: group.map((u) => u.path.replace(/\/\*$/, '/')).slice(0, 4).join(' + ') + (group.length > 4 ? ` +${group.length - 4}` : ''),
    paths: group.map((u) => u.path.replace(/\/\*$/, '/')),
    files: group.reduce((n, u) => n + u.files, 0),
  }));
  return {
    root,
    files: total,
    truncated,
    languages: [...langs].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files),
    folders: [...folders]
      .map(([p, f]) => ({ path: `${p}/`, files: f.files, tests: f.tests, languages: [...f.langs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l) }))
      .sort((a, b) => b.files - a.files),
    rootFiles: rootFiles.sort(),
    manifests: [],
    testFiles,
    shards,
  };
}

/** One-line summary of a manifest without quoting it (dependency counts, scripts, module name). */
export function summarizeManifest(name: string, text: string): string {
  try {
    if (name === 'package.json' || name === 'composer.json') {
      const j = JSON.parse(text) as { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: object; devDependencies?: object; require?: object; workspaces?: unknown };
      const deps = Object.keys(j.dependencies ?? j.require ?? {}).length;
      const dev = Object.keys(j.devDependencies ?? {}).length;
      const scripts = Object.keys(j.scripts ?? {});
      return `${j.name ?? '?'}${j.version ? `@${j.version}` : ''} · ${deps} deps, ${dev} dev deps${j.workspaces ? ' · workspaces' : ''}${scripts.length ? ` · scripts: ${scripts.slice(0, 12).join(', ')}${scripts.length > 12 ? ', …' : ''}` : ''}`;
    }
  } catch {
    /* fall through to the generic summary */
  }
  const lines = text.split('\n');
  if (name === 'go.mod') {
    return `${/^module\s+(\S+)/m.exec(text)?.[1] ?? '?'} · ${lines.filter((l) => /^\s+\S+\s+v/.test(l)).length} requirements`;
  }
  if (name === 'Cargo.toml' || name === 'pyproject.toml') {
    return `${/^name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '?'} · ${lines.filter((l) => /^[\w.-]+\s*=/.test(l) && !/^(name|version|description|edition|authors|license|readme)\s*=/.test(l)).length} entries`;
  }
  if (name === 'requirements.txt') {
    return `${lines.filter((l) => l.trim() && !l.startsWith('#')).length} requirements`;
  }
  if (name === 'Makefile') {
    return `targets: ${lines.map((l) => /^([A-Za-z0-9_.-]+):/.exec(l)?.[1]).filter(Boolean).slice(0, 12).join(', ')}`;
  }
  if (/^Dockerfile/.test(name)) {
    return `base: ${/^FROM\s+(\S+)/m.exec(text)?.[1] ?? '?'}`;
  }
  return `${lines.length} lines`;
}

export function formatAnalysis(a: WorkspaceAnalysis): string {
  const out: string[] = [];
  out.push(`Workspace: ${a.root} — ${a.files}${a.truncated ? '+' : ''} files${a.testFiles ? `, ${a.testFiles} test files` : ''}`);
  if (a.languages.length) {
    out.push(`Languages: ${a.languages.slice(0, 8).map((l) => `${l.name} (${l.files})`).join(', ')}`);
  }
  if (a.manifests.length) {
    out.push(`Manifests:\n${a.manifests.map((m) => `  ${m.path}: ${m.summary}`).join('\n')}`);
  }
  if (a.folders.length) {
    out.push(`Folders:\n${a.folders.slice(0, 25).map((f) => `  ${f.path} ${f.files} files${f.tests ? ` (${f.tests} tests)` : ''}${f.languages.length ? ` · ${f.languages.join(', ')}` : ''}`).join('\n')}${a.folders.length > 25 ? `\n  … +${a.folders.length - 25} more` : ''}`);
  }
  if (a.rootFiles.length) {
    out.push(`Root files: ${a.rootFiles.slice(0, 20).join(', ')}${a.rootFiles.length > 20 ? `, +${a.rootFiles.length - 20}` : ''}`);
  }
  if (a.shards.length > 1) {
    out.push(
      `Suggested shards for a parallel analysis (${a.shards.length} subagents, ~${Math.round(a.files / a.shards.length)} files each):\n${a.shards.map((s, i) => `  ${i + 1}. ${s.label} (${s.files} files): ${s.paths.join(', ')}`).join('\n')}\nFan out with run_parallel_subagents — one "explore" (or "reviewer") task per shard, each told its paths and the exact question — then merge the reports.`
    );
  }
  return out.join('\n\n');
}

export function createAnalyzeWorkspaceTool(maxShards: () => number): Tool {
  return {
    parallelSafe: true,
    definition: {
      name: 'analyze_workspace',
      description:
        'Fast whole-workspace overview without a model call: file and language counts per folder, test locations, manifest summaries (name, scripts, dependency counts) and a balanced split of the repository into shards sized for parallel subagents. Call it FIRST for repository-wide analysis, audits, reviews or onboarding questions, then fan out one explore/reviewer subagent per shard with run_parallel_subagents instead of reading files one by one.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional workspace-relative folder to analyse instead of the whole workspace' },
          shards: { type: 'integer', description: 'How many shards to suggest (default: the parallel concurrency setting)' },
        },
      },
    },
    async execute(args, ctx) {
      const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        return { content: 'No workspace folder open.', isError: true };
      }
      const sub = typeof args.path === 'string' && args.path.trim() && args.path.trim() !== '.' ? args.path.trim().replace(/^\/+|\/+$/g, '') : '';
      const base = sub ? path.join(root, sub) : root;
      if (!path.normalize(base).startsWith(path.normalize(root))) {
        return { content: 'path must stay inside the workspace.', isError: true };
      }
      const parts = Math.max(1, Math.min(8, Number(args.shards) || maxShards()));
      const files = await vscode.workspace.findFiles(sub ? `${sub}/**/*` : '**/*', EXCLUDE, MAX_FILES);
      const rel = files.map((f) => path.relative(base, f.fsPath)).filter((p) => p && !p.startsWith('..'));
      const analysis = summarizeWorkspace(sub || root, rel, parts, files.length >= MAX_FILES);
      // Manifests at the root and one level down (monorepo packages), read concurrently.
      const candidates = files.filter((f) => {
        const r = path.relative(base, f.fsPath).split(path.sep);
        return r.length <= 3 && MANIFESTS.includes(r[r.length - 1]);
      });
      const pool = new ParallelPool(8);
      const settled = await pool.map(candidates.slice(0, 24), async (f) => {
        const bytes = await vscode.workspace.fs.readFile(f);
        const text = Buffer.from(bytes).toString('utf8').slice(0, 200_000);
        return { path: path.relative(base, f.fsPath).split(path.sep).join('/'), summary: summarizeManifest(path.basename(f.fsPath), text) };
      });
      analysis.manifests = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])).sort((a, b) => a.path.localeCompare(b.path));
      return { content: formatAnalysis(analysis), data: analysis };
    },
  };
}
