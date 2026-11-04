import * as vscode from 'vscode';
import * as cp from 'child_process';
import { Tool, ToolContext } from '../types';
import { displayPath, resolveWorkspacePath } from './fs';
import { onAbort } from '../agent/resilience';

/** `findFiles` scoped to the agent's root: the workspace by default, its isolated worktree when it has one. */
function findIn(ctx: ToolContext, pattern: string, max: number): Thenable<vscode.Uri[]> {
  const root = ctx.workspaceRoot;
  const inWorkspace = !root || vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === root);
  return inWorkspace ? vscode.workspace.findFiles(pattern, EXCLUDES, max) : vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), pattern), new vscode.RelativePattern(vscode.Uri.file(root), EXCLUDES), max);
}

const EXCLUDES = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**,**/*.min.js,**/*.map}';

export const fileSearchTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'file_search',
    description: 'Find files by file NAME or path glob (e.g. "src/**/*.ts", "**/package.json"). Does not look inside files — to find where a function, class or string is defined or used, call grep_search (text) or find_symbol (language server) instead. Returns workspace-relative paths.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, max_results: { type: 'integer', description: 'Default 50' } },
      required: ['pattern'],
    },
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '**/*');
    const max = Number(args.max_results ?? 50);
    const files = await findIn(ctx, pattern, max);
    if (!files.length) {
      // A bare identifier in a glob almost always means the model wanted a content search.
      const looksLikeSymbol = /^(\*\*\/)?[\w.-]+\*?$/.test(pattern) && !/\.[a-z]{1,5}$/i.test(pattern.replace(/\*$/, ''));
      return { content: `No files match ${pattern}.${looksLikeSymbol ? ` file_search only matches file names — to find "${pattern.replace(/^\*\*\//, '').replace(/\*$/, '')}" inside files use grep_search with that text as the query (or find_symbol for definitions).` : ''}` };
    }
    return { content: files.map((f) => displayPath(f, ctx)).sort().join('\n') };
  },
};

export const grepSearchTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'grep_search',
    description:
      'Search INSIDE file contents with a regex or literal string (uses ripgrep when available) — the right tool to find where a function, class, variable or message is defined or used. Returns `path:line: text` matches. Use include_pattern to restrict to a glob.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        is_regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
        include_pattern: { type: 'string', description: 'Glob such as "src/**/*.ts"' },
        case_sensitive: { type: 'boolean' },
        max_results: { type: 'integer', description: 'Default 100' },
      },
      required: ['query'],
    },
  },
  async execute(args, ctx) {
    const query = String(args.query ?? '');
    if (!query) {
      return { content: 'query is required', isError: true };
    }
    const max = Number(args.max_results ?? 100);
    const root = ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return { content: 'No workspace open', isError: true };
    }
    const rg = await findRipgrep();
    const include = typeof args.include_pattern === 'string' && args.include_pattern ? args.include_pattern : undefined;
    const caseSensitive = Boolean(args.case_sensitive);
    const search = async (isRegex: boolean): Promise<string[]> => {
      if (rg) {
        const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', '50', '--max-columns', '300'];
        if (!isRegex) {
          rgArgs.push('--fixed-strings');
        }
        if (!caseSensitive) {
          rgArgs.push('--ignore-case');
        }
        if (include) {
          rgArgs.push('--glob', include);
        }
        // --hidden: dot-folders such as .github hold real sources; the VCS folders stay excluded.
        rgArgs.push('--hidden');
        for (const g of ['!node_modules', '!.git', '!.hg', '!.svn', '!dist', '!out', '!build']) {
          rgArgs.push('--glob', g);
        }
        rgArgs.push('-e', query, '.');
        // Exit 2 also means "some files could not be read" alongside real matches: keep them.
        let stderr: string | undefined;
        const out = await runProcess(rg, rgArgs, root, ctx.signal, 60_000, [0, 1, 2], (code, err) => {
          if (code === 2) {
            stderr = err.trim();
          }
        });
        const found = out.split('\n').filter(Boolean).slice(0, max).map((l) => l.replace(/^\.\//, ''));
        if (stderr !== undefined && !found.length) {
          throw new Error(stderr || 'ripgrep exited with code 2');
        }
        if (stderr) {
          found.push(`(ripgrep reported: ${stderr.split('\n')[0]})`);
        }
        return found;
      }
      // Fallback: naive JS search (slower, but dependency-free).
      // This runs the model's pattern in-process, where nothing can interrupt one regex test: a nested quantifier such
      // as (a+)+ can backtrack for minutes and freeze the extension host. Such patterns are searched as plain text, very
      // long lines (minified code) are skipped, and the whole search stops after 10 s.
      const files = await findIn(ctx, include ?? '**/*', 2000);
      const risky = isRegex && /\([^()]*[+*][^()]*\)[+*{]/.test(query);
      const re = new RegExp(isRegex && !risky ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
      const results: string[] = risky ? [`(the pattern has a nested repetition that can hang a search without ripgrep; it was searched as plain text)`] : [];
      const deadline = Date.now() + 10_000;
      for (const f of files) {
        if (ctx.signal.aborted || results.length >= max || Date.now() > deadline) {
          break;
        }
        try {
          if ((await vscode.workspace.fs.stat(f)).size > 1_000_000) {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(f);
          const text = Buffer.from(bytes).toString('utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && results.length < max; i++) {
            if (lines[i].length <= 2000 && re.test(lines[i])) {
              results.push(`${displayPath(f, ctx)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            }
          }
        } catch {
          /* skip unreadable */
        }
      }
      return results;
    };
    let isRegex = Boolean(args.is_regex);
    let lines: string[];
    try {
      lines = await search(isRegex);
    } catch (e) {
      return { content: `grep_search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    // Models routinely send an escaped regex ("def foo\(") without is_regex; a literal search then looks for a
    // backslash and finds nothing. Retry as a regex before reporting no matches.
    if (!lines.length && !isRegex && looksLikeRegex(query) && !ctx.signal.aborted) {
      isRegex = true;
      lines = await search(true).catch(() => []);
    }
    if (!lines.length) {
      return { content: `No matches for "${query}"${isRegex ? ' (searched as a regular expression as well)' : ''}. Try a shorter literal such as the bare identifier, or find_symbol for definitions.` };
    }
    return { content: lines.join('\n') };
  },
};

/** Escaped metacharacters, classes or alternation: the query was written as a regex even if is_regex was not set. */
export function looksLikeRegex(query: string): boolean {
  if (!/\\[()[\]{}.*+?|^$dswbDSWB]|\.\*|\[[^\]]+\]|\(.*\|.*\)/.test(query)) {
    return false;
  }
  try {
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

export const findSymbolTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'find_symbol',
    description: 'Find symbol definitions (classes, functions, variables) across the workspace using the language server.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  async execute(args) {
    const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', String(args.query ?? ''))) ?? [];
    if (!syms.length) {
      return { content: 'No symbols found (language server may not be ready).' };
    }
    return {
      content: syms
        .slice(0, 50)
        .map((s) => `${vscode.SymbolKind[s.kind]} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`)
        .join('\n'),
    };
  },
};

export const findReferencesTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'find_references',
    description: 'Find all references to the symbol at a given file position using the language server.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, line: { type: 'integer', description: '1-based' }, symbol: { type: 'string', description: 'Symbol name on that line' } },
      required: ['path', 'line', 'symbol'],
    },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(String(args.path), ctx);
    const doc = await vscode.workspace.openTextDocument(uri);
    const lineIdx = Number(args.line) - 1;
    const col = doc.lineAt(lineIdx).text.indexOf(String(args.symbol));
    if (col < 0) {
      return { content: `Symbol "${args.symbol}" not found on line ${args.line}`, isError: true };
    }
    const locs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, new vscode.Position(lineIdx, col))) ?? [];
    return { content: locs.length ? locs.slice(0, 100).map((l) => `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}`).join('\n') : 'No references found.' };
  },
};

let rgPath: string | null | undefined;
let rgCheckedAt = 0;
export async function findRipgrep(): Promise<string | null> {
  // A miss is re-probed after a while (rg may be installed meanwhile); a hit is kept.
  if (rgPath || (rgPath === null && Date.now() - rgCheckedAt < 5 * 60_000)) {
    return rgPath;
  }
  const appRoot = vscode.env.appRoot;
  const exe = `rg${process.platform === 'win32' ? '.exe' : ''}`;
  const target = `${process.platform}-${process.arch}`;
  // Recent VS Code builds ship @vscode/ripgrep-universal (one binary per platform folder); older ones @vscode/ripgrep.
  const candidates = [
    ...(appRoot
      ? [
          `${appRoot}/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/${target}/${exe}`,
          `${appRoot}/node_modules/@vscode/ripgrep-universal/bin/${target}/${exe}`,
          `${appRoot}/node_modules/@vscode/ripgrep/bin/${exe}`,
          `${appRoot}/node_modules.asar.unpacked/@vscode/ripgrep/bin/${exe}`,
        ]
      : []),
    'rg',
  ];
  rgCheckedAt = Date.now();
  for (const c of candidates) {
    try {
      await runProcess(c, ['--version'], undefined);
      rgPath = c;
      return c;
    } catch {
      /* try next */
    }
  }
  rgPath = null;
  return null;
}

export function runProcess(
  cmd: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
  timeoutMs = 60_000,
  okCodes: readonly number[] = [0, 1],
  onExit?: (code: number | null, stderr: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { cwd, shell: false });
    let out = '';
    let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const off = onAbort(signal, () => child.kill('SIGKILL'));
    child.on('close', off);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      // ripgrep exits 1 when there are no matches.
      if (code !== null && okCodes.includes(code)) {
        onExit?.(code, err);
        resolve(out);
      } else {
        reject(new Error(err || `exit code ${code}`));
      }
    });
  });
}

export const searchTools: Tool[] = [fileSearchTool, grepSearchTool, findSymbolTool, findReferencesTool];
