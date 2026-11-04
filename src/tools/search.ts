import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { Tool, ToolContext } from '../types';
import { displayPath, excludedPath, resolveWorkspacePath, toolRoots } from './fs';
import { onAbort } from '../agent/resilience';
import { IGNORE_FILES } from '../agent/ignoreFile';
import * as nodeFs from 'fs';

/** `findFiles` scoped to the agent's root: the workspace by default, its isolated worktree when it has one. */
function findIn(ctx: ToolContext, pattern: string, max: number): Thenable<vscode.Uri[]> {
  const root = ctx.workspaceRoot;
  const inWorkspace = !root || vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === root);
  return inWorkspace ? vscode.workspace.findFiles(pattern, EXCLUDES, max) : vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), pattern), new vscode.RelativePattern(vscode.Uri.file(root), EXCLUDES), max);
}

/** The other workspace folders grep_search covers besides `root`: not `root` itself nor folders inside it. */
function otherSearchRoots(root: string, ctx: ToolContext): string[] {
  const folders = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  return toolRoots(ctx)
    .map((r) => r.path)
    .filter((p) => {
      const rel = path.relative(root, p);
      return (folders.has(p) || p === ctx.workspaceRoot) && rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
    });
}

const EXCLUDES =
  '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/.vscode-test/**,**/.next/**,**/coverage/**,**/target/**,**/vendor/**,**/Pods/**,**/*.min.js,**/*.map}';

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
    const found = await findIn(ctx, pattern, max + 1);
    const visible = found.filter((f) => !excludedPath(f, ctx));
    const files = visible.slice(0, max);
    if (!files.length && found.length) {
      return { content: `Every file matching ${pattern} is excluded by the agent ignore file (.localpilotignore).` };
    }
    if (!files.length) {
      // A bare identifier in a glob almost always means the model wanted a content search.
      const looksLikeSymbol = /^(\*\*\/)?[\w.-]+\*?$/.test(pattern) && !/\.[a-z]{1,5}$/i.test(pattern.replace(/\*$/, ''));
      return { content: `No files match ${pattern}.${looksLikeSymbol ? ` file_search only matches file names — to find "${pattern.replace(/^\*\*\//, '').replace(/\*$/, '')}" inside files use grep_search with that text as the query (or find_symbol for definitions).` : ''}` };
    }
    const list = files.map((f) => displayPath(f, ctx)).sort().join('\n');
    return { content: visible.length > max ? `${list}\n(more than ${max} files match; narrow the pattern)` : list };
  },
};

export const grepSearchTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'grep_search',
    description:
      'Search INSIDE file contents with a regex or literal string (uses ripgrep when available) — the right tool to find where a function, class, variable or message is defined or used. Returns `path:line: text` matches from every workspace folder. Use include_pattern to restrict to a glob.',
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
    const search = async (isRegex: boolean): Promise<{ lines: string[]; note?: string }> => {
      if (rg) {
        const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(Math.max(max, 50)), '--max-columns', '300'];
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
        // Every workspace folder is searched, each from its own folder so a path-scoped include_pattern
        // ("src/**/*.ts") applies inside it. Hits of the others are shown relative to the agent's root (`../api/src/x.ts`),
        // which the file tools resolve back. A folder inside the root is already covered by the root's search.
        const runs = [root, ...otherSearchRoots(root, ctx)];
        let stderr: string | undefined;
        const outs = await Promise.all(
          runs.map((dir) => {
            const ignore = IGNORE_FILES.map((name) => path.join(dir, name)).filter((f) => nodeFs.existsSync(f));
            // Exit 2 also means "some files could not be read" alongside real matches: keep them.
            return runProcess(rg, [...rgArgs, ...ignore.flatMap((f) => ['--ignore-file', f]), '-e', query, '.'], dir, ctx.signal, 60_000, [0, 1, 2], (code, err) => {
              if (code === 2) {
                stderr = [stderr, err.trim()].filter(Boolean).join('\n');
              }
            });
          })
        );
        // The ignore files are applied here as well: `!include` and per-folder files are beyond --ignore-file.
        const all = outs.flatMap((out, i) => {
          const rel = i ? path.relative(root, runs[i]) : '';
          return out.split('\n').flatMap((l) => {
            const m = /^(?:\.[\\/])?(.+?)(:\d+:)/.exec(l);
            if (!m) {
              return l ? [l] : [];
            }
            const file = rel ? path.join(rel, m[1]) : m[1];
            return excludedPath(vscode.Uri.file(path.resolve(root, file)), ctx) ? [] : [file + l.slice(m[0].length - m[2].length)];
          });
        });
        const found = all.slice(0, max);
        if (stderr !== undefined && !found.length) {
          throw new Error(stderr || 'ripgrep exited with code 2');
        }
        if (all.length > max) {
          found.push(`[showing ${max} of ${all.length} matches — narrow with include_pattern or raise max_results]`);
        }
        if (stderr) {
          found.push(`(ripgrep reported: ${stderr.split('\n')[0]})`);
        }
        return { lines: found };
      }
      // Fallback: naive JS search (slower, but dependency-free).
      // This runs the model's pattern in-process, where nothing can interrupt one regex test: a nested quantifier such
      // as (a+)+ can backtrack for minutes and freeze the extension host. Such patterns are searched as plain text, very
      // long lines (minified code) are skipped, and the whole search stops after 10 s.
      const files = (await findIn(ctx, include ? (include.includes('/') ? include : `**/${include}`) : '**/*', 2000)).filter((f) => !excludedPath(f, ctx));
      const pattern = isRegex ? safeRegex(query) : query;
      const risky = isRegex && riskyRegex(pattern);
      const re = new RegExp(isRegex && !risky ? pattern : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
      const results: string[] = risky ? [`(the pattern has a nested repetition that can hang a search without ripgrep; it was searched as plain text)`] : [];
      const found = () => results.length - (risky ? 1 : 0);
      const deadline = Date.now() + 10_000;
      let scanned = 0;
      let cut = files.length >= 2000;
      for (const f of files) {
        if (ctx.signal.aborted || found() >= max || Date.now() > deadline) {
          cut = true;
          break;
        }
        try {
          if ((await vscode.workspace.fs.stat(f)).size > 1_000_000) {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(f);
          const text = Buffer.from(bytes).toString('utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && found() < max; i++) {
            if (i > 0 && i % 500 === 0) {
              if (ctx.signal.aborted || Date.now() > deadline) {
                cut = true;
                break;
              }
              await new Promise((r) => setImmediate(r));
            }
            if (lines[i].length <= 2000 && re.test(lines[i])) {
              results.push(`${displayPath(f, ctx)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            }
          }
        } catch {
          /* skip unreadable */
        }
        scanned++;
      }
      cut ||= found() >= max;
      const note = cut ? `(searched ${scanned} of ${files.length}${files.length >= 2000 ? '+' : ''} files; results may be incomplete — narrow with include_pattern)` : undefined;
      return { lines: found() ? (note ? [...results, note] : results) : [], note };
    };
    let isRegex = Boolean(args.is_regex);
    let res: { lines: string[]; note?: string };
    try {
      res = await search(isRegex);
    } catch (e) {
      return { content: `grep_search failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    // Models routinely send an escaped regex ("def foo\(") without is_regex; a literal search then looks for a
    // backslash and finds nothing. Retry as a regex before reporting no matches.
    if (!res.lines.length && !isRegex && looksLikeRegex(query) && !ctx.signal.aborted) {
      isRegex = true;
      const first = res;
      res = await search(true).catch(() => first);
    }
    if (!res.lines.length) {
      if (res.note) {
        return { content: `No matches for "${query}" in the files searched ${res.note}` };
      }
      return { content: `No matches for "${query}"${isRegex ? ' (searched as a regular expression as well)' : ''}. Try a shorter literal such as the bare identifier, or find_symbol for definitions.` };
    }
    return { content: res.lines.join('\n') };
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

/** `(.|\s)`-style "any character" groups rewritten to the equivalent `[\s\S]`, which cannot backtrack. */
function safeRegex(query: string): string {
  return query.replace(/\((?:\?:)?(?:\.\|\\[sn]|\\s\|\.)\)/g, '[\\s\\S]');
}

/** Patterns that can backtrack catastrophically: nested quantifiers, quantified groups with alternation or optionals, quantified nested groups. */
export function riskyRegex(query: string): boolean {
  const q = safeRegex(query).replace(/\(\?(?:[:=!]|<[=!]|<\w+>)/g, '(');
  return /\([^()]*[+*][^()]*\)[+*{]/.test(q) || /\([^()]*[|?][^()]*\)[+*{]/.test(q) || /\)[+*?]?\)[+*{]/.test(q);
}

export const findSymbolTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'find_symbol',
    description: 'Find symbol definitions (classes, functions, variables) across the workspace using the language server.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  async execute(args, ctx) {
    const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', String(args.query ?? ''))) ?? [];
    if (!syms.length) {
      return { content: 'No symbols found (language server may not be ready).' };
    }
    // An isolated worktree is not indexed: map hits in a workspace folder onto the worktree's copy of the file.
    const root = ctx.workspaceRoot;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const isolated = !!root && !folders.includes(root);
    let mapped = false;
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const s of syms) {
      let uri = s.location.uri;
      if (isolated && root) {
        const folder = folders.find((f) => { const rel = path.relative(f, uri.fsPath); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
        if (folder) {
          uri = vscode.Uri.file(path.join(root, path.relative(folder, uri.fsPath)));
          mapped = true;
        }
      }
      const line = s.location.range.start.line + 1;
      const key = `${uri.fsPath}:${line}`;
      if (seen.has(key)) {continue;}
      seen.add(key);
      rows.push(`${vscode.SymbolKind[s.kind]} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${displayPath(uri, ctx)}:${line}`);
    }
    const list = rows.slice(0, 50).join('\n');
    const more = rows.length > 50 ? `\n(showing 50 of ${rows.length})` : '';
    const note = mapped ? "\n(language-server index reflects the user's checkout; re-read the file before editing)" : '';
    return { content: `${list}${more}${note}` };
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
    const symbol = String(args.symbol);
    const lineIdx = Number(args.line) - 1;
    if (!Number.isInteger(lineIdx) || lineIdx < 0 || lineIdx >= doc.lineCount) {
      return { content: `Line ${args.line} is out of range (the file has ${doc.lineCount} lines)`, isError: true };
    }
    // Whole-identifier hits on the line (then the lines around it), so `id` does not land inside `userId`.
    const word = new RegExp('(?<![\\w$])' + symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w$])', 'g');
    let positions: vscode.Position[] = [];
    for (const d of [0, -1, 1, -2, 2]) {
      const l = lineIdx + d;
      if (l < 0 || l >= doc.lineCount) {continue;}
      positions.push(...[...doc.lineAt(l).text.matchAll(word)].map((m) => new vscode.Position(l, m.index ?? 0)));
      if (d === 0 && positions.length) {break;}
    }
    if (!positions.length) {
      const col = doc.lineAt(lineIdx).text.indexOf(symbol);
      if (col < 0) {
        return { content: `Symbol "${symbol}" not found on line ${args.line}`, isError: true };
      }
      positions = [new vscode.Position(lineIdx, col)];
    }
    let at = positions[0];
    let locs: vscode.Location[] = [];
    for (const p of positions) {
      locs = (await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, p)) ?? [];
      if (locs.length) {
        at = p;
        break;
      }
    }
    const head = `References to "${symbol}" (${displayPath(uri, ctx)}:${at.line + 1}:${at.character + 1}):`;
    if (!locs.length) {
      return { content: `${head}\nNo references found.` };
    }
    const list = locs.slice(0, 100).map((l) => `${displayPath(l.uri, ctx)}:${l.range.start.line + 1}`).join('\n');
    return { content: `${head}\n${list}${locs.length > 100 ? `\n(showing 100 of ${locs.length})` : ''}` };
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out += d));
    child.stderr.on('data', (d: string) => (err += d));
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
