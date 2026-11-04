import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ParsedRule, parseRule, ruleApplies } from './ruleConditions';
import { alwaysEnabled, managedDir } from '../agent/managedPolicy';

/**
 * Project instruction ("memory") files, resolved the way Claude Code does:
 *
 *   1. user     ~/.claude/CLAUDE.md, ~/.localpilot/CLAUDE.md, ~/.localpilot/rules.md, ~/.agents/AGENTS.md, then
 *               USER_RULE_DIRS (~/.localpilot/rules/, ~/.claude/rules/, ~/.cline/rules/, ~/Documents/Cline/Rules/ …)
 *   2. ancestors  CLAUDE.md / .claude/CLAUDE.md / .localpilot/rules.md in each parent folder of the workspace
 *                 (monorepo roots), nearest last
 *   3. project  .localpilot/rules.md, AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, .cursorrules,
 *               .github/copilot-instructions.md, .windsurfrules, .clinerules (file), then RULE_DIRS
 *               (.cursor/rules/, .localpilot/rules/, .claude/rules/, .clinerules/, .cline/rules/), each sorted by rule name
 *   4. local    CLAUDE.local.md (personal, git-ignored)
 *   5. managed  the organisation's rules folder next to managed-settings.json (`<policyDir>/rules/`) — highest
 *               precedence, so it comes last and is the last to be cut by the size cap
 *
 * `@path` on a line of its own or inside a sentence imports another file (relative to the importing file, `~/` for
 * home), recursively up to IMPORT_DEPTH levels; code blocks and spans are left alone. Imports from repository files
 * must stay inside the workspace (or ~/.claude, ~/.localpilot); credential files are never imported.
 *
 * Front matter (see ruleConditions): `disabled: true` / `enabled: false` leaves a file out; `paths:` / `globs:` make it
 * conditional, injected only when a file in context (message, open editors, working set, attachments) matches.
 */

export const PROJECT_RULE_FILES = ['.localpilot/rules.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules', '.clinerules'];
export const LOCAL_RULE_FILES = ['CLAUDE.local.md', '.localpilot/rules.local.md'];
export const RULE_DIRS = ['.cursor/rules', '.localpilot/rules', '.claude/rules', '.clinerules', '.cline/rules'];
export const USER_RULE_DIRS = ['.localpilot/rules', '.claude/rules', '.cline/rules', 'Documents/Cline/Rules', 'Cline/Rules'];
const RULE_EXT = /\.(md|mdc|markdown|txt)$/i;
const ANCESTOR_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), path.join('.localpilot', 'rules.md')];
const IMPORT_DEPTH = 5;
const MAX_IMPORT_CHARS = 20_000;

export interface InstructionFile {
  file: string;
  /** Shown in the prompt as the section label, e.g. `CLAUDE.md`, `../CLAUDE.md`, `~/.claude/CLAUDE.md`. */
  label: string;
  scope: 'user' | 'ancestor' | 'project' | 'local' | 'managed';
  /** For files from a rules folder: the front-matter `name` or the file's basename, used as the `## ` heading. */
  name?: string;
  /** Set by buildInstructions when the size cap cut this file short or left it out. */
  note?: 'truncated' | 'omitted';
  /** Conditional rule: the globs from `paths:` / `globs:` ([] = never applies). */
  paths?: string[];
  /** Conditional rule: whether the last build's context paths matched it. */
  applied?: boolean;
  /** Turned off with `disabled: true` (only listed with `includeDisabled`). */
  disabled?: boolean;
  /** `alwaysEnabled: true` front matter: cannot be switched off. */
  alwaysEnabled?: boolean;
}

/** Parsed rule files, re-read only when their mtime or size changes. */
const ruleCache = new Map<string, { mtimeMs: number; size: number; rule: ParsedRule }>();

async function readRule(file: string): Promise<ParsedRule | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) {
      return undefined;
    }
    const hit = ruleCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      return hit.rule;
    }
    const rule = parseRule(await fs.readFile(file, 'utf8'));
    if (ruleCache.size > 1000) {
      ruleCache.clear();
    }
    ruleCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rule });
    return rule;
  } catch {
    return undefined;
  }
}

async function readIfFile(file: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) {
      return undefined;
    }
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Path identity for dedupe and comparisons: case-insensitive on Windows. */
const key = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const tilde = (p: string, home: string) => (p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, '/')}` : p);

/** Every instruction file that exists, in prompt order; turned-off files only with `includeDisabled`. */
export async function collectInstructionFiles(roots: string[], home = os.homedir(), opts: { includeDisabled?: boolean; /** The organisation's rules folder; null for none. */ managedDir?: string | null } = {}): Promise<InstructionFile[]> {
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const push = async (file: string, label: string, scope: InstructionFile['scope'], name?: string) => {
    // By real path, so a symlinked AGENTS.md -> CLAUDE.md is included (and counted against the cap) once.
    const id = key(await fs.realpath(file).catch(() => file));
    if (seen.has(id)) {
      return;
    }
    const rule = await readRule(file);
    const always = rule !== undefined && alwaysEnabled(rule.meta);
    const disabled = !!rule?.condition.disabled && !always;
    if (rule === undefined || (disabled && !opts.includeDisabled)) {
      return;
    }
    seen.add(id);
    out.push({ file, label, scope, ...(name ? { name } : {}), ...(rule.condition.paths ? { paths: rule.condition.paths } : {}), ...(disabled ? { disabled: true } : {}), ...(always ? { alwaysEnabled: true } : {}) });
  };
  /** The rule files of one folder (not recursive), by rule name; files with an empty body are left out. */
  const pushDir = async (dir: string, labelDir: string, scope: InstructionFile['scope']) => {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(dir)).filter((n) => RULE_EXT.test(n));
    } catch {
      return; // not present, or a file (the legacy single-file .clinerules)
    }
    const rules: { n: string; name: string }[] = [];
    for (const n of entries) {
      const rule = await readRule(path.join(dir, n));
      if (rule === undefined) {
        continue;
      }
      const { meta, body } = rule;
      if (body.trim()) {
        rules.push({ n, name: (typeof meta.name === 'string' && meta.name.trim()) || n.replace(RULE_EXT, '') });
      }
    }
    rules.sort((a, b) => a.name.localeCompare(b.name) || a.n.localeCompare(b.n));
    for (const r of rules) {
      await push(path.join(dir, r.n), `${labelDir}/${r.n}`, scope, r.name);
    }
  };
  for (const f of ['.claude/CLAUDE.md', '.localpilot/CLAUDE.md', '.localpilot/rules.md', '.agents/AGENTS.md']) {
    await push(path.join(home, f), `~/${f}`, 'user');
  }
  for (const d of USER_RULE_DIRS) {
    await pushDir(path.join(home, d), `~/${d}`, 'user');
  }
  for (const root of roots) {
    // Ancestors, farthest first; the home folder and the filesystem root are not project folders.
    const ancestors: string[] = [];
    for (let dir = path.dirname(root); dir !== path.dirname(dir) && key(dir) !== key(home); dir = path.dirname(dir)) {
      ancestors.unshift(dir);
    }
    for (const dir of ancestors) {
      for (const f of ANCESTOR_FILES) {
        await push(path.join(dir, f), path.relative(root, path.join(dir, f)).replace(/\\/g, '/'), 'ancestor');
      }
    }
    for (const rel of PROJECT_RULE_FILES) {
      await push(path.join(root, rel), rel, 'project');
    }
    for (const dir of RULE_DIRS) {
      await pushDir(path.join(root, dir), dir, 'project');
    }
    for (const rel of LOCAL_RULE_FILES) {
      await push(path.join(root, rel), rel, 'local');
    }
  }
  const orgDir = opts.managedDir === undefined ? managedDir('rules') : opts.managedDir;
  if (orgDir) {
    await pushDir(orgDir, 'organization/rules', 'managed');
  }
  return out.map((f) => ({ ...f, label: f.scope === 'user' ? tilde(f.file, home) : f.label }));
}

/** Mask fenced code blocks and inline code so `@foo` inside them is not treated as an import. */
function maskCode(text: string): { masked: string; restore: (s: string) => string } {
  const slots: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    slots.push(m);
    return `\u0000${slots.length - 1}\u0000`;
  });
  return { masked, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]) };
}

const IMPORT_RE = /(^|[\s(])@((?:~\/|\.{1,2}\/|\/)?[\w.-][\w./-]*)/g;

/** Credential locations are never imported, whoever asks. */
const isSecret = (p: string) => /(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)|[\\/]\.config[\\/]gcloud([\\/]|$)/.test(p) || /^(\.env|id_(rsa|dsa|ecdsa|ed25519)|keys\.json$|\.credentials\.json$)|\.(pem|key)$/i.test(path.basename(p));
const isInside = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const realpath = (p: string) => fs.realpath(p).catch(() => path.resolve(p));
const refusedImports = new Set<string>();

/**
 * Resolves `@path` imports in an instruction file's text. Unless `scope` is `user`, targets must resolve inside one
 * of `roots` (default: the importing file's folder) or be Markdown under ~/.claude / ~/.localpilot; refused imports stay as plain text.
 */
export async function resolveImports(text: string, file: string, opts: { home?: string; depth?: number; seen?: Set<string>; scope?: InstructionFile['scope']; roots?: string[] } = {}): Promise<string> {
  const depth = opts.depth ?? 0;
  if (depth >= IMPORT_DEPTH) {
    return text;
  }
  const home = opts.home ?? os.homedir();
  const seen = opts.seen ?? new Set<string>([key(file)]);
  const roots = opts.roots ?? [path.dirname(file)];
  const allowed = opts.scope === 'user' ? undefined : await Promise.all(roots.map(realpath));
  // Outside the workspace only Markdown under ~/.claude and ~/.localpilot: they also hold API keys and OAuth tokens.
  const homeDocs = opts.scope === 'user' ? [] : await Promise.all([path.join(home, '.claude'), path.join(home, '.localpilot')].map(realpath));
  const { masked, restore } = maskCode(text);
  const refs = [...masked.matchAll(IMPORT_RE)];
  if (!refs.length) {
    return text;
  }
  let out = masked;
  for (const m of refs) {
    const rel = m[2].replace(/[.,;:)]+$/, '');
    if (!rel || /^[\d.]+$/.test(rel)) {
      continue;
    }
    const abs = rel.startsWith('~/') ? path.join(home, rel.slice(2)) : path.isAbsolute(rel) ? rel : path.resolve(path.dirname(file), rel);
    const id = key(abs);
    if (seen.has(id)) {
      continue;
    }
    const real = await realpath(abs);
    if (isSecret(path.resolve(abs)) || isSecret(real) || (allowed && !allowed.some((dir) => isInside(real, dir)) && !(/\.md$/i.test(real) && homeDocs.some((dir) => isInside(real, dir))))) {
      if (!refusedImports.has(`${file}|${real}`)) {
        refusedImports.add(`${file}|${real}`);
        console.warn(`LocalPilot: not importing ${rel} into ${file}: outside the workspace or a credential file`);
      }
      continue;
    }
    const content = await readIfFile(abs);
    if (content === undefined) {
      continue; // not a file: leave the token (it may be a handle or an email)
    }
    seen.add(id);
    const inner = await resolveImports(content.length > MAX_IMPORT_CHARS ? `${content.slice(0, MAX_IMPORT_CHARS)}\n…(import truncated)` : content, abs, { home, depth: depth + 1, seen, scope: opts.scope, roots });
    out = out.replace(m[0], () => `${m[1]}\n<!-- imported: ${rel} -->\n${inner.trim()}\n<!-- end import -->\n`);
  }
  return restore(out);
}

/**
 * The concatenated instruction text for the prompt, capped at `maxChars`. The budget goes to the highest-precedence
 * files first (local, then project, ancestors, user), so an oversized user file cannot crowd out the project's rules.
 * Conditional rules are included only when one of `contextPaths` (workspace-relative, POSIX) matches their globs.
 */
export async function buildInstructions(roots: string[], opts: { home?: string; maxChars?: number; contextPaths?: readonly string[]; managedDir?: string | null } = {}): Promise<{ text: string; files: InstructionFile[] }> {
  const home = opts.home ?? os.homedir();
  const collected = await collectInstructionFiles(roots, home, { managedDir: opts.managedDir });
  const files = collected.map((f) => (f.paths ? { ...f, applied: ruleApplies(f.paths, opts.contextPaths ?? []) } : f));
  const parts: { file: InstructionFile; text: string }[] = [];
  for (const f of files) {
    if (f.applied === false) {
      continue;
    }
    const rule = await readRule(f.file);
    if (rule === undefined) {
      continue;
    }
    // An ancestor (e.g. the monorepo root above an opened package) may also import from its own folder tree.
    const own = f.scope === 'ancestor' ? path.dirname(f.file).replace(/[\\/]\.(claude|localpilot)$/, '') : undefined;
    // An organisation rule imports only from its own folder.
    const text = (await resolveImports(rule.body, f.file, { home, scope: f.scope, roots: f.scope === 'managed' ? [path.dirname(f.file)] : own ? [...roots, own] : roots })).trim();
    if (text) {
      parts.push({ file: f, text: `<!-- ${f.label}${f.scope === 'user' ? ' (user)' : f.scope === 'local' ? ' (local)' : f.scope === 'managed' ? ' (your organization)' : ''} -->\n${f.name ? `## ${f.name}\n` : ''}${text}` });
    }
  }
  const marker = '\n…(truncated)';
  const notes = new Map<InstructionFile, InstructionFile['note']>();
  let budget = opts.maxChars ?? 12_000;
  const kept: string[] = [];
  for (const p of [...parts].reverse()) {
    if (p.text.length <= budget) {
      kept.unshift(p.text);
      budget -= p.text.length + 2;
    } else if (budget > 200) {
      kept.unshift(p.text.slice(0, budget - marker.length) + marker);
      notes.set(p.file, 'truncated');
      budget = 0;
    } else {
      notes.set(p.file, 'omitted');
    }
  }
  return { text: kept.join('\n\n'), files: files.map((f) => (notes.has(f) ? { ...f, note: notes.get(f) } : f)) };
}
