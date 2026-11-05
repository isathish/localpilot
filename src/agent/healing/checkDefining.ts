import { globToRegExp } from '../permissions';
import { CHECK_DEFINING_FILES, CHECK_DEFINING_SECTIONS, type CheckDefiningSection } from './types';

const wholeFile = CHECK_DEFINING_FILES.map((g) => globToRegExp(g));
const sections = CHECK_DEFINING_SECTIONS.map((s) => ({ spec: s, re: globToRegExp(s.glob) }));

function jsonSection(text: string | null, key: string): string | undefined {
  if (text === null) { return undefined; }
  try {
    const v = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
    return v === undefined ? undefined : JSON.stringify(v);
  } catch {
    return `\u0000unparsed:${text}`;
  }
}

/** Every `[header]` block whose header starts with `prefix`, normalised for whitespace, in file order. */
function iniSection(text: string | null, prefix: string): string | undefined {
  if (text === null) { return undefined; }
  const out: string[] = [];
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[+\s*([^\]]+?)\s*\]+$/.exec(line);
    if (header) {
      inSection = header[1].startsWith(prefix);
      if (inSection) { out.push(`[${header[1]}]`); }
      continue;
    }
    if (inSection && line && !line.startsWith('#') && !line.startsWith(';')) { out.push(line); }
  }
  return out.length ? out.join('\n') : undefined;
}

function sectionOf(spec: CheckDefiningSection, text: string | null): string | undefined {
  return spec.format === 'json' ? jsonSection(text, spec.section) : iniSection(text, spec.section);
}

/**
 * Whether editing `relPath` from `before` to `after` (null = absent) changes a check definition (anti-gaming).
 * Returns a label for the footer ("package.json scripts") or undefined. Section-scoped manifests count only when
 * the check section itself differs, so dependency or version fixes are not flagged.
 */
export function checkDefiningEdit(relPath: string, before: string | null, after: string | null): string | undefined {
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (wholeFile.some((re) => re.test(p))) { return p; }
  for (const { spec, re } of sections) {
    if (re.test(p) && sectionOf(spec, before) !== sectionOf(spec, after)) { return `${p} ${spec.section}`; }
  }
  return undefined;
}
