/**
 * YAML-ish front-matter parser for SKILL.md / agent / command files: `key: value` lines, `[a, b]` and `- item` lists,
 * `|` / `>` block scalars, indented multi-line values, quotes stripped.
 */
export function parseFrontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.replace(/^\uFEFF/, ''));
  if (!m) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  const indentOf = (l: string) => /^\s*/.exec(l)![0].length;
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
  /** Lines after `i` that are blank or indented deeper than `indent`. */
  const block = (i: number, indent: number): string[] => {
    const out: string[] = [];
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > indent); j++) {
      out.push(lines[j]);
    }
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) {
      continue;
    }
    const key = kv[1];
    const value = kv[2].trim();
    if (!value) {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next !== undefined && /^\s*-\s+/.test(next)) {
        // `key:` followed by `- item` lines (at any indent, including column 0).
        const items: string[] = [];
        for (; i + 1 < lines.length; i++) {
          const item = /^\s*-\s+(.*)$/.exec(lines[i + 1]);
          if (item) {
            items.push(unquote(item[1]));
          } else if (lines[i + 1].trim()) {
            break;
          }
        }
        meta[key] = items;
        continue;
      }
      // `key:` followed by indented text: a plain multi-line scalar (a nested map is skipped, as before).
      const text = block(i, 0);
      i += text.length;
      if (/^\s+[A-Za-z0-9_-]+:(\s|$)/.test(text.find((l) => l.trim()) ?? '')) {
        meta[key] = [];
        continue;
      }
      const joined = text.map((l) => l.trim()).filter(Boolean).join(' ');
      meta[key] = joined ? unquote(joined) : [];
      continue;
    }
    const scalar = /^([|>])([+-]?)\d*$/.exec(value);
    if (scalar) {
      const text = block(i, 0);
      i += text.length;
      const common = Math.min(...text.filter((l) => l.trim()).map(indentOf));
      const rows = text.map((l) => (l.trim() ? l.slice(common) : ''));
      let s: string;
      if (scalar[1] === '|') {
        s = rows.join('\n');
      } else {
        // Folding: consecutive lines join with a space, blank lines become newlines.
        s = '';
        let sep = '';
        for (const r of rows) {
          if (!r) {
            s += '\n';
            sep = '';
          } else {
            s += sep + r;
            sep = ' ';
          }
        }
      }
      const body = s.replace(/\n+$/, '');
      meta[key] = scalar[2] === '-' ? body : scalar[2] === '+' ? `${s}\n` : body ? `${body}\n` : '';
      continue;
    }
    let v: unknown = value;
    if (/^\[.*\]$/.test(value)) {
      v = value.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
    } else {
      v = unquote(value);
    }
    meta[key] = v;
  }
  return { meta, body: m[2] };
}
