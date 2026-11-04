import * as fs from 'fs';
import * as path from 'path';

/**
 * Tools that only matter in some conversations. Every tool definition is sent with every request, and on a local
 * model the prompt is read before the first token: the source-control, board, multi-repository and security tools
 * add about 2,000 tokens. They are offered when the recent conversation is about them or the workspace calls for them
 * (a board exists, several repositories are registered); slash commands that use them mention them, so they qualify.
 */
const TOPICS: { tools: string[]; words: RegExp; workspace?: (root: string, repos: number) => boolean }[] = [
  { tools: ['git_commit', 'git_push', 'pull_request', 'ci_status'], words: /\b(commit\w*|push\w*|merg\w*|git|ship|publish\w*|upload\w*|pull[ -]?requests?|PRs?|branch\w*|ci|workflows?|actions|checks?|pipelines?|builds? (?:failed|failing|broke|is red)|github|gitlab|git_commit|git_push|pull_request|ci_status|release\w*)\b/i },
  { tools: ['team_board'], words: /\b(board|team_board|backlog|hand ?off|handoff|claim|split (it|this|the work)|for others|teammates?|workers?|team|inbox|mailbox|broadcast)\b/i, workspace: (root) => !!root && fs.existsSync(path.join(root, '.localpilot', 'board')) },
  { tools: ['schedule'], words: /\b(schedul\w*|cron\w*|crontab|recurring|every (night|day|morning|evening|hour|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ (minutes?|hours?))|nightly|daily|weekly|hourly|periodic\w*)\b/i },
  { tools: ['repos'], words: /\b(repos|repositories|repository|multi[- ]?repo|monorepo|across (the )?projects)\b/i, workspace: (_root, repos) => repos > 1 },
  { tools: ['read_pdf'], words: /\.pdf\b|\bpdfs?\b|read_pdf/i, workspace: (root) => !!root && hasPdf(root) },
  { tools: ['notebook_edit'], words: /\.ipynb\b|\bnotebooks?\b|\bjupyter\b|notebook_edit/i },
  { tools: ['security_scan'], words: /\b(security|secure|vulnerab\w*|cves?|ghsa|advisor(y|ies)|secrets?|leak\w*|credentials?|audit|scan|sast|owasp|injection|dependenc(y|ies) (check|update|upgrade))\b/i },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'target', 'vendor', '__pycache__']);
let pdfCache: { root: string; at: number; found: boolean } | undefined;

/** True when a PDF sits in the top levels of the workspace (bounded walk, cached for a minute). */
export function hasPdf(root: string): boolean {
  if (pdfCache?.root === root && Date.now() - pdfCache.at < 60_000) {
    return pdfCache.found;
  }
  let budget = 3000;
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--budget < 0) {
        return false;
      }
      if (e.isFile() && /\.pdf$/i.test(e.name)) {
        return true;
      }
    }
    return depth > 0 && entries.some((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && walk(path.join(dir, e.name), depth - 1));
  };
  const found = walk(root, 3);
  pdfCache = { root, at: Date.now(), found };
  return found;
}

/** Names of situational tools to leave out of this run. */
export function irrelevantTools(recentText: string, root: string | undefined, repoCount: number): Set<string> {
  const out = new Set<string>();
  for (const t of TOPICS) {
    const needed = t.words.test(recentText) || !!t.workspace?.(root ?? '', repoCount);
    if (!needed) {
      t.tools.forEach((n) => out.add(n));
    }
  }
  return out;
}

/** True when the model was trained on the `*** Begin Patch` format (GPT, Codex, gpt-oss). */
export function prefersApplyPatch(modelId: string): boolean {
  return /gpt|codex|gpt-oss/i.test(modelId);
}

/**
 * File-editing tools to leave out for this model (`localpilot.editTool`): apply_patch replaces edit_file and write_file
 * for models that prefer it, and is not offered to the others. Nothing is dropped when its replacement is unavailable.
 */
export function editToolsToOmit(available: string[], modelId: string, setting: 'auto' | 'edit_file' | 'apply_patch'): Set<string> {
  const has = new Set(available);
  const patch = setting === 'apply_patch' || (setting === 'auto' && prefersApplyPatch(modelId));
  if (patch) {
    return has.has('apply_patch') ? new Set(['edit_file', 'write_file']) : new Set();
  }
  return has.has('edit_file') ? new Set(['apply_patch']) : new Set();
}
