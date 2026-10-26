import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Project instruction ("memory") files, resolved the way Claude Code does:
 *
 *   1. user     ~/.claude/CLAUDE.md, ~/.localpilot/CLAUDE.md, ~/.localpilot/rules.md
 *   2. ancestors  CLAUDE.md / .claude/CLAUDE.md / .localpilot/rules.md in each parent folder of the workspace
 *                 (monorepo roots), nearest last
 *   3. project  .localpilot/rules.md, AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, .cursorrules,
 *               .github/copilot-instructions.md, .windsurfrules, then .cursor/rules/*, .localpilot/rules/*
 *   4. local    CLAUDE.local.md (personal, git-ignored) — highest precedence, so it comes last
 *
 * `@path` on a line of its own or inside a sentence imports another file (relative to the importing file, `~/` for
 * home), recursively up to IMPORT_DEPTH levels; code blocks and spans are left alone.
 */

export const PROJECT_RULE_FILES = ['.localpilot/rules.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules'];
export const LOCAL_RULE_FILES = ['CLAUDE.local.md', '.localpilot/rules.local.md'];
export const RULE_DIRS = ['.cursor/rules', '.localpilot/rules', '.claude/rules'];
const ANCESTOR_FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), path.join('.localpilot', 'rules.md')];
const IMPORT_DEPTH = 5;
const MAX_IMPORT_CHARS = 20_000;

export interface InstructionFile {
  file: string;
  /** Shown in the prompt as the section label, e.g. `CLAUDE.md`, `../CLAUDE.md`, `~/.claude/CLAUDE.md`. */
  label: string;
  scope: 'user' | 'ancestor' | 'project' | 'local';
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

const tilde = (p: string, home: string) => (p.startsWith(home) ? `~${p.slice(home.length).replace(/\\/g, '/')}` : p);

/** Every instruction file that exists, in prompt order. */
export async function collectInstructionFiles(roots: string[], home = os.homedir()): Promise<InstructionFile[]> {
  const out: InstructionFile[] = [];
  const seen = new Set<string>();
  const push = async (file: string, label: string, scope: InstructionFile['scope']) => {
    const key = path.resolve(file);
    if (seen.has(key)) {
      return;
    }
    if ((await readIfFile(file)) !== undefined) {
      seen.add(key);
      out.push({ file, label, scope });
    }
  };
  for (const f of ['.claude/CLAUDE.md', '.localpilot/CLAUDE.md', '.localpilot/rules.md']) {
    await push(path.join(home, f), `~/${f}`, 'user');
  }
  for (const root of roots) {
    // Ancestors, farthest first; the home folder and the filesystem root are not project folders.
    const ancestors: string[] = [];
    for (let dir = path.dirname(root); dir !== path.dirname(dir) && path.resolve(dir) !== path.resolve(home); dir = path.dirname(dir)) {
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
      let entries: string[] = [];
      try {
        entries = (await fs.readdir(path.join(root, dir))).filter((n) => /\.(md|mdc)$/.test(n)).sort();
      } catch {
        /* not present */
      }
      for (const n of entries) {
        await push(path.join(root, dir, n), `${dir}/${n}`, 'project');
      }
    }
    for (const rel of LOCAL_RULE_FILES) {
      await push(path.join(root, rel), rel, 'local');
    }
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

/** Resolves `@path` imports in an instruction file's text. */
export async function resolveImports(text: string, file: string, opts: { home?: string; depth?: number; seen?: Set<string> } = {}): Promise<string> {
  const depth = opts.depth ?? 0;
  if (depth >= IMPORT_DEPTH) {
    return text;
  }
  const home = opts.home ?? os.homedir();
  const seen = opts.seen ?? new Set<string>([path.resolve(file)]);
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
    const key = path.resolve(abs);
    if (seen.has(key)) {
      continue;
    }
    const content = await readIfFile(abs);
    if (content === undefined) {
      continue; // not a file: leave the token (it may be a handle or an email)
    }
    seen.add(key);
    const inner = await resolveImports(content.length > MAX_IMPORT_CHARS ? `${content.slice(0, MAX_IMPORT_CHARS)}\n…(import truncated)` : content, abs, { home, depth: depth + 1, seen });
    out = out.replace(m[0], () => `${m[1]}\n<!-- imported: ${rel} -->\n${inner.trim()}\n<!-- end import -->\n`);
  }
  return restore(out);
}

/** Front-matter of .mdc / rule files is metadata, not instructions. */
const stripFrontMatter = (s: string) => s.replace(/^---[\s\S]*?\n---\s*/, '');

/** The concatenated instruction text for the prompt, capped at `maxChars`. */
export async function buildInstructions(roots: string[], opts: { home?: string; maxChars?: number } = {}): Promise<{ text: string; files: InstructionFile[] }> {
  const home = opts.home ?? os.homedir();
  const files = await collectInstructionFiles(roots, home);
  const parts: string[] = [];
  for (const f of files) {
    const raw = await readIfFile(f.file);
    if (raw === undefined) {
      continue;
    }
    const text = (await resolveImports(stripFrontMatter(raw), f.file, { home })).trim();
    if (text) {
      parts.push(`<!-- ${f.label}${f.scope === 'user' ? ' (user)' : f.scope === 'local' ? ' (local)' : ''} -->\n${text}`);
    }
  }
  const joined = parts.join('\n\n');
  const max = opts.maxChars ?? 12_000;
  return { text: joined.length > max ? `${joined.slice(0, max)}\n…(rules truncated)` : joined, files };
}
