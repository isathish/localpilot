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
  { tools: ['team_board'], words: /\b(board|team_board|backlog|hand ?off|handoff|claim|split (it|this|the work)|for others|teammates?|workers?)\b/i, workspace: (root) => !!root && fs.existsSync(path.join(root, '.localpilot', 'board')) },
  { tools: ['repos'], words: /\b(repos|repositories|repository|multi[- ]?repo|monorepo|across (the )?projects)\b/i, workspace: (_root, repos) => repos > 1 },
  { tools: ['security_scan'], words: /\b(security|secure|vulnerab\w*|cves?|ghsa|advisor(y|ies)|secrets?|leak\w*|credentials?|audit|scan|sast|owasp|injection|dependenc(y|ies) (check|update|upgrade))\b/i },
];

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
