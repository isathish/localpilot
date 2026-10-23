/** YAML-ish front-matter parser for SKILL.md / agent files: `key: value` lines, `[a, b]` lists, quotes stripped. */
export function parseFrontMatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) {
    return { meta: {}, body: raw };
  }
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) {
      continue;
    }
    let v: unknown = kv[2].trim();
    if (typeof v === 'string') {
      if (/^\[.*\]$/.test(v)) {
        v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else {
        v = v.replace(/^['"]|['"]$/g, '');
      }
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}
