import * as vscode from 'vscode';
import { buildRepoGraph, fileKey, findCycles, hubs, reach, RepoGraph } from '../context/repoGraph';
import { Tool } from '../types';

const ACTIONS = ['overview', 'dependents', 'dependencies', 'impact', 'hubs', 'cycles', 'external', 'symbol'] as const;

const list = (items: string[], max = 60) => `${items.slice(0, max).join('\n')}${items.length > max ? `\n… and ${items.length - max} more` : ''}`;

/** Test files across ecosystems: test_x.py, x_test.go, x.spec.ts, FooTest.kt, tests/, androidTest/, Foo.UnitTests/… */
function isTestPath(rel: string): boolean {
  const parts = rel.split('/');
  const base = parts.pop()!;
  const stem = base.replace(/\.[^.]+$/, '');
  return (
    /^(tests|conftest)\.py$|^test_.+\.py$|_test\.(go|py)$|\.(test|spec|cy|e2e)\./i.test(base) ||
    // Case-sensitive suffix so "latest.ts" or "contest/" are not tests.
    /[a-z0-9_](Tests?|Spec|IT)$/.test(stem) ||
    parts.some((d) => /^(tests?|__tests__|specs?|e2e|cypress|javatests)$|\.(unit|integration)?tests$/i.test(d) || /[a-z0-9]Tests?$/.test(d))
  );
}

/** Text answer for one repo_graph action. Pure, so the CLI, tests and the tool share it. */
export function answerRepoGraph(g: RepoGraph, action: string, target?: string, depth = 4): { content: string; isError?: boolean } {
  const r = answer(g, action, target, depth);
  return g.truncated ? { ...r, content: `${r.content}\n\ngraph incomplete: file limit reached; results may miss files` } : r;
}

function answer(g: RepoGraph, action: string, target: string | undefined, depth: number): { content: string; isError?: boolean } {
  const needFile = () => {
    if (!target) {
      return { error: `"${action}" needs path: a workspace-relative file.` };
    }
    const k = fileKey(g, target);
    const dir = target.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (k.key) {
      return { key: k.key, note: k.key !== dir ? `Resolved "${target}" to ${k.key}.\n` : '' };
    }
    const inside = dir ? g.files.filter((f) => f.startsWith(`${dir}/`)) : [];
    if (inside.length) {
      return { error: `"${target}" is a folder; pass a file inside it, e.g.:\n${inside.slice(0, 5).join('\n')}` };
    }
    if (k.suggestions.length) {
      return { error: `"${target}" does not match exactly one file — did you mean one of:\n${k.suggestions.join('\n')}` };
    }
    return { error: `"${target}" is not a source file in the graph (supported: TS/JS, Python, Go, Rust, Java/Kotlin, C#).` };
  };
  switch (action) {
    case 'overview': {
      const edges = [...g.deps.values()].reduce((n, s) => n + s.size, 0);
      const top = hubs(g, 8);
      const ext = [...g.external].sort((a, b) => b[1].size - a[1].size).slice(0, 10);
      const orphans = g.files.filter((f) => !(g.rdeps.get(f)?.size) && !(g.deps.get(f)?.size)).length;
      const cycles = findCycles(g, 3);
      return {
        content: [
          `${g.files.length} source files, ${edges} internal imports, ${g.external.size} external packages, ${g.symbols.size} top-level symbols.`,
          top.length ? `Most imported (change these with care):\n${top.map((h) => `  ${h.file} ← ${h.importedBy} file${h.importedBy === 1 ? '' : 's'}`).join('\n')}` : '',
          ext.length ? `Main external packages:\n${ext.map(([p, fs]) => `  ${p} (${fs.size} file${fs.size === 1 ? '' : 's'})`).join('\n')}` : '',
          cycles.length ? `Import cycles: ${cycles.length}${cycles.length === 3 ? '+' : ''} (action "cycles" lists them)` : 'No import cycles.',
          orphans ? `${orphans} file${orphans === 1 ? '' : 's'} neither import nor are imported by other files (entry points, scripts or dead code).` : '',
        ].filter(Boolean).join('\n\n'),
      };
    }
    case 'dependents':
    case 'dependencies': {
      const f = needFile();
      if (f.error) {
        return { content: f.error, isError: true };
      }
      const set = [...((action === 'dependents' ? g.rdeps : g.deps).get(f.key!) ?? [])].sort();
      const ext = action === 'dependencies' ? [...g.external].filter(([, fs]) => fs.has(f.key!)).map(([p]) => p).sort() : [];
      return { content: `${f.note}${f.key} ${action === 'dependents' ? 'is imported by' : 'imports'} ${set.length} file${set.length === 1 ? '' : 's'}${set.length ? `:\n${list(set)}` : '.'}${ext.length ? `\nExternal packages: ${ext.join(', ')}` : ''}` };
    }
    case 'impact': {
      const f = needFile();
      if (f.error) {
        return { content: f.error, isError: true };
      }
      const hit = [...reach(g.rdeps, f.key!, depth)].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const tests = hit.filter(([p]) => isTestPath(p));
      const more = [...reach(g.rdeps, f.key!, depth + 1).values()].filter((d) => d === depth + 1).length;
      const noTests = more ? `No test file found within ${depth} levels (more importers beyond the depth limit).` : 'No importer was recognised as a test — consider adding one.';
      return {
        content: f.note + (hit.length
          ? `Changing ${f.key} can affect ${hit.length} file${hit.length === 1 ? '' : 's'} (transitive importers, up to ${depth} levels):\n${list(hit.map(([p, d]) => `${'  '.repeat(d - 1)}${p}${d > 1 ? ` (via ${d} hops)` : ''}`))}${more ? `\n${more} more importer(s) beyond depth ${depth} — rerun with depth: ${Math.min(10, depth + 2)}` : ''}${tests.length ? `\n\nTests to run (${tests.length}):\n${list(tests.map(([p]) => p), 20)}` : `\n\n${noTests}`}`
          : g.truncated
            ? `No indexed file imports ${f.key}.`
            : `Nothing in the workspace imports ${f.key}: a change stays local (or it is an entry point loaded another way).`),
      };
    }
    case 'hubs': {
      const h = hubs(g, 25);
      return { content: h.length ? `Most imported files:\n${h.map((x) => `${x.file} ← ${x.importedBy} · imports ${x.imports}`).join('\n')}` : 'No internal imports found.' };
    }
    case 'cycles': {
      const c = findCycles(g, 15);
      return { content: c.length ? `${c.length} import cycle${c.length === 1 ? '' : 's'} (files that import each other, directly or through others):\n${c.map((x, i) => `${i + 1}. ${x.join(' ↔ ')}`).join('\n')}` : 'No import cycles.' };
    }
    case 'external': {
      if (target) {
        const users = [...(g.external.get(target) ?? [])].sort();
        return { content: users.length ? `${target} is imported by ${users.length} file${users.length === 1 ? '' : 's'}:\n${list(users)}` : `No file imports the package "${target}".` };
      }
      const ext = [...g.external].sort((a, b) => b[1].size - a[1].size);
      return { content: ext.length ? `External packages by number of importing files:\n${list(ext.map(([p, fs]) => `${p} (${fs.size})`), 80)}` : 'No external imports.' };
    }
    case 'symbol': {
      if (!target) {
        return { content: '"symbol" needs path: the symbol name.', isError: true };
      }
      const exact = g.symbols.get(target) ?? [];
      const loose = exact.length ? [] : [...g.symbols].filter(([n]) => n.toLowerCase().includes(target.toLowerCase())).slice(0, 20).flatMap(([n, defs]) => defs.map((d) => ({ ...d, name: n })));
      const rows = exact.length ? exact.map((d) => `${d.kind} ${target} — ${d.file}:${d.line} (imported by ${g.rdeps.get(d.file)?.size ?? 0})`) : loose.map((d) => `${d.kind} ${d.name} — ${d.file}:${d.line}`);
      return { content: rows.length ? `${exact.length ? 'Defined at' : `No exact match; similar names`}:\n${list(rows, 40)}` : `No top-level definition named "${target}". Try grep_search for local or nested names.` };
    }
  }
  return { content: `Unknown action "${action}". Use one of: ${ACTIONS.join(', ')}.`, isError: true };
}

export const repoGraphTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'repo_graph',
    description:
      'Repository import graph and symbol index (TS/JS, Python, Go, Rust, Java/Kotlin, C#), built from the source without a language server and cached. Use it before changing shared code and to understand a large codebase: "impact" lists every file that may break when a file changes (transitive importers) and the tests to run; "dependents"/"dependencies" give direct importers/imports; "hubs" the most central modules; "cycles" import cycles; "external" which files use a package; "symbol" where a top-level function/class/type is defined; "overview" a summary.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        path: { type: 'string', description: 'File (for dependents/dependencies/impact), package (external) or symbol name (symbol)' },
        depth: { type: 'integer', description: 'Levels for impact (default 4)' },
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return { content: 'No workspace folder open.', isError: true };
    }
    ctx.progress('Indexing imports…');
    const g = await buildRepoGraph(root);
    return answerRepoGraph(g, String(args.action ?? 'overview'), typeof args.path === 'string' ? args.path.trim() : undefined, Math.max(1, Math.min(10, Number(args.depth) || 4)));
  },
};
