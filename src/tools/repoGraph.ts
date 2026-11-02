import * as vscode from 'vscode';
import { buildRepoGraph, fileKey, findCycles, hubs, reach, RepoGraph } from '../context/repoGraph';
import { Tool } from '../types';

const ACTIONS = ['overview', 'dependents', 'dependencies', 'impact', 'hubs', 'cycles', 'external', 'symbol'] as const;

const list = (items: string[], max = 60) => `${items.slice(0, max).join('\n')}${items.length > max ? `\n… and ${items.length - max} more` : ''}`;

/** Text answer for one repo_graph action. Pure, so the CLI, tests and the tool share it. */
export function answerRepoGraph(g: RepoGraph, action: string, target?: string, depth = 4): { content: string; isError?: boolean } {
  const needFile = () => {
    if (!target) {
      return { error: `"${action}" needs path: a workspace-relative file.` };
    }
    const k = fileKey(g, target);
    return k.key ? { key: k.key } : { error: k.suggestions.length ? `"${target}" matches several files — pass one of:\n${k.suggestions.join('\n')}` : `"${target}" is not a source file in the graph (supported: TS/JS, Python, Go, Rust, Java/Kotlin, C#).` };
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
          `${g.files.length} source files, ${edges} internal imports, ${g.external.size} external packages, ${g.symbols.size} top-level symbols${g.truncated ? ' (repository truncated at the file limit)' : ''}.`,
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
      return { content: `${f.key} ${action === 'dependents' ? 'is imported by' : 'imports'} ${set.length} file${set.length === 1 ? '' : 's'}${set.length ? `:\n${list(set)}` : '.'}${ext.length ? `\nExternal packages: ${ext.join(', ')}` : ''}` };
    }
    case 'impact': {
      const f = needFile();
      if (f.error) {
        return { content: f.error, isError: true };
      }
      const hit = [...reach(g.rdeps, f.key!, depth)].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const tests = hit.filter(([p]) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.|_test\.(go|py)$|test_[^/]+\.py$/.test(p));
      return {
        content: hit.length
          ? `Changing ${f.key} can affect ${hit.length} file${hit.length === 1 ? '' : 's'} (transitive importers, up to ${depth} levels):\n${list(hit.map(([p, d]) => `${'  '.repeat(d - 1)}${p}${d > 1 ? ` (via ${d} hops)` : ''}`))}${tests.length ? `\n\nTests to run (${tests.length}):\n${list(tests.map(([p]) => p), 20)}` : '\n\nNo test file depends on it — consider adding one.'}`
          : `Nothing in the workspace imports ${f.key}: a change stays local (or it is an entry point loaded another way).`,
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
