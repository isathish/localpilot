/**
 * `#codebase` (also `@codebase`): one attachment that orients the model in the whole project — the folders, the
 * project map, the import graph's summary, a capped file list and the files whose names or top-level symbols match
 * the request. There is no embedding (semantic) index: related files are matched by name, and the block says so, so
 * neither the model nor the user mistakes it for semantic search.
 */

const STOP = new Set(['this', 'that', 'what', 'when', 'where', 'which', 'with', 'from', 'into', 'have', 'does', 'make', 'some', 'there', 'their', 'about', 'should', 'would', 'could', 'code', 'file', 'files', 'codebase', 'project', 'repo', 'work', 'works', 'explain', 'show', 'find', 'tell', 'please', 'using', 'used', 'like', 'also', 'more', 'than', 'them', 'they', 'then', 'only', 'each', 'other', 'into', 'over', 'after', 'before', 'between', 'function', 'class', 'method', 'test', 'tests', 'need', 'want', 'add', 'fix', 'change', 'update', 'implement', 'create', 'write']);

/** Words in a request worth matching against file names and symbols: identifiers of 4+ characters, minus filler. */
export function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.matchAll(/[A-Za-z_$][\w$]{3,}/g)) {
    const w = m[0];
    if (!STOP.has(w.toLowerCase())) {
      out.add(w);
      // camelCase and snake_case parts too: "chatController" also matches "controller.ts".
      for (const p of w.split(/_|(?<=[a-z0-9])(?=[A-Z])/)) {
        if (p.length >= 4 && !STOP.has(p.toLowerCase())) {
          out.add(p);
        }
      }
    }
  }
  return [...out].slice(0, 12);
}

export type SymbolIndex = ReadonlyMap<string, readonly { file: string; kind: string; line: number }[]>;

/**
 * Files related to the request by name: top-level symbols named like a query term (exact names score highest), then
 * paths containing a term. One line per file, best first, at most `max`.
 */
export function relatedFiles(query: string, files: readonly string[], symbols: SymbolIndex | undefined, max = 15): string[] {
  const terms = queryTerms(query).map((t) => t.toLowerCase());
  if (!terms.length) {
    return [];
  }
  const hits = new Map<string, { score: number; why: Set<string> }>();
  const hit = (file: string, score: number, why: string) => {
    const h = hits.get(file) ?? { score: 0, why: new Set<string>() };
    h.score += score;
    if (h.why.size < 3) {
      h.why.add(why);
    }
    hits.set(file, h);
  };
  if (symbols) {
    for (const [name, defs] of symbols) {
      const n = name.toLowerCase();
      for (const t of terms) {
        // A definition named exactly like a term is the strongest signal there is without a semantic index.
        const score = n === t ? 10 : n.length <= 40 && n.includes(t) ? 2 : 0;
        if (score) {
          defs.slice(0, 5).forEach((d) => hit(d.file, score, `${d.kind} ${name}`));
          break;
        }
      }
    }
  }
  for (const f of files) {
    const lower = f.toLowerCase();
    const baseName = lower.slice(lower.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    // The best term only: "chatController" and its parts "chat" and "controller" are one match, not three.
    let best = 0;
    for (const t of terms) {
      best = Math.max(best, baseName === t ? 5 : baseName.includes(t) ? 3 : lower.includes(t) ? 1 : 0);
    }
    if (best) {
      hit(f, best, best > 1 ? 'file name' : 'path');
    }
  }
  return [...hits]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([f, h]) => `${f} (${[...h.why].join(', ')})`);
}

export interface CodebaseParts {
  root: string;
  /** Multi-root: one line per workspace folder. */
  roots?: string;
  map?: string;
  /** The repo graph's overview text, or why it is missing. */
  graph?: string;
  tree?: string;
  related?: string[];
  /** Terms the related files were matched on. */
  terms?: string[];
}

const MAX_CHARS = 24_000;

/** The `<codebase>` attachment. Sections that would push it past ~24k characters are cut, the file list first. */
export function formatCodebase(p: CodebaseParts): string {
  const sections = [
    p.roots ? `# Workspace folders\n${p.roots}` : '',
    p.map ? `# Project map\n${p.map}` : '',
    p.graph ? `# Import graph\n${p.graph}` : '',
    p.related?.length ? `# Related to the request (by name and symbol: ${p.terms?.join(', ')})\n${p.related.join('\n')}` : p.terms?.length ? `# Related to the request\nNo file or top-level symbol is named like: ${p.terms.join(', ')}.` : '',
    '# Search\nThere is no semantic (embedding) index: the related files above are matched by name and symbol. Use grep_search for text, find_symbol for definitions and repo_graph for dependencies.',
  ].filter(Boolean);
  const fixed = sections.join('\n\n');
  let tree = p.tree ?? '';
  const room = MAX_CHARS - fixed.length - 200;
  if (tree.length > room) {
    const lines = tree.slice(0, Math.max(0, room)).split('\n');
    lines.pop();
    tree = `${lines.join('\n')}\n... (file list cut to fit; use file_search for more)`;
  }
  return `<codebase root="${p.root.replace(/"/g, '&quot;')}">\n${fixed}${tree.trim() ? `\n\n# Files\n${tree}` : ''}\n</codebase>`;
}
