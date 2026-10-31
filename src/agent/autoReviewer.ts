import * as vscode from 'vscode';
import type { ProviderRegistry } from '../providers/registry';

export type ApprovalKind = 'terminal' | 'write' | 'delete' | 'network';

export interface AutoReviewRequest {
  kind: ApprovalKind;
  /** What the tool wants to do ("Run command", "Edit src/a.ts") and its details (the command, a diff, a URL). */
  title: string;
  detail: string;
  /** The user's request this run is working on, so the reviewer can judge whether the action serves it. */
  request: string;
  signal?: AbortSignal;
}

export interface AutoVerdict {
  /** `allow` runs the action without a prompt; `ask` hands it to the user as usual. Auto mode never denies on its own. */
  decision: 'allow' | 'ask';
  reason: string;
  source: 'rule' | 'model' | 'error';
}

/**
 * Actions auto mode always sends to the user, whatever the reviewer would say: irreversible, outward-facing or
 * privilege-raising commands, and writes to secrets or git internals. Patterns are deliberately broad — a false
 * positive costs one prompt, a false negative could cost the user's data.
 */
const RISKY_COMMANDS: [RegExp, string][] = [
  [/\brm\s+(?:-\w*\s+)*-\w*[rR]\w*\b|\brm\s.*--recursive\b|\brm\s+(?:-\w*\s+)*-\w*f\w*\s+[~/*]/, 'recursive or forced delete'],
  [/\bsudo\b|\bdoas\b|\brunas\b/, 'raises privileges'],
  [/\bgit\s+push\b/, 'publishes to a remote'],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|checkout\s+--\s+\.|restore\s+(?:--\S+\s+)*\.(?:\s|$)|branch\s+-D|stash\s+(?:drop|clear))/, 'discards work'],
  [/\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\biex\b/, 'runs a downloaded script'],
  [/\bmkfs\b|\bdd\s+if=|\bdiskutil\s+erase|\bformat\s+[a-z]:/i, 'writes a disk directly'],
  [/:\(\)\s*\{\s*:\s*\|\s*:/, 'fork bomb'],
  [/\bchmod\s+(?:-\w+\s+)*[0-7]?777\b|\bchown\s+-R\b/, 'changes permissions broadly'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\bkillall\b|\bpkill\b/, 'stops the machine or other processes'],
  [/\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+(?:release|pr\s+merge|repo\s+delete)\b|\bvsce\s+publish\b/, 'publishes a package or release'],
  [/\b(?:drop|truncate)\s+(?:table|database|schema)\b/i, 'destroys database data'],
  [/\bkubectl\s+(?:delete|apply)\b|\bterraform\s+(?:apply|destroy)\b|\bhelm\s+(?:uninstall|delete)\b/, 'changes live infrastructure'],
  [/\bdocker\s+(?:system|volume|image)\s+prune\b|\bdocker\s+rm\s+-f\b/, 'deletes containers or data'],
  [/\b(?:ssh|scp|rsync)\s+\S*@/, 'connects to another machine'],
  [/>\s*\/dev\/sd|>\s*\/etc\//, 'overwrites system files'],
];

const SENSITIVE_PATHS = /(?:^|[\s/\\])(?:(?:\.ssh|\.git|\.aws|\.gnupg)[/\\]|(?:\.env(?:\.[\w-]+)?|id_(?:rsa|ed25519|ecdsa)|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))(?=\s|$|[/\\]))/i;

/** Why auto mode must ask about this action, or undefined when the reviewer may decide. */
export function hardRisk(kind: ApprovalKind, title: string, detail: string): string | undefined {
  if (kind === 'terminal') {
    const text = `${title}\n${detail}`;
    for (const [re, why] of RISKY_COMMANDS) {
      if (re.test(text)) {
        return why;
      }
    }
  }
  if ((kind === 'write' || kind === 'delete') && SENSITIVE_PATHS.test(` ${title} `)) {
    return 'touches secrets or git internals';
  }
  return undefined;
}

/** Reads the reviewer's answer; anything that is not a clear "allow" means "ask the user". */
export function parseVerdict(text: string): { allow: boolean; reason: string } {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const v = JSON.parse(json) as { decision?: unknown; reason?: unknown };
      const d = String(v.decision ?? '').toLowerCase();
      return { allow: d === 'allow', reason: String(v.reason ?? '').slice(0, 200) };
    } catch {
      /* fall through to the keyword form */
    }
  }
  const m = body.match(/^\s*(ALLOW|BLOCK)\b[:\s-]*(.*)/i);
  return m ? { allow: m[1].toUpperCase() === 'ALLOW', reason: m[2].trim().slice(0, 200) } : { allow: false, reason: 'unclear answer from the reviewer' };
}

const REVIEW_PROMPT = `You review actions a coding agent wants to take on the user's machine. Approve an action only when it is clearly part of doing what the user asked and its effects stay inside the project and can be undone (editing source files, running builds, tests, linters, formatters, package installs listed in the project, read-only git commands, fetching documentation).
Block anything that is destructive or hard to undo, reaches outside the project, sends data to third parties, changes credentials or system settings, or that the user's request does not call for. When unsure, block — blocking only means the user is asked.
Answer with JSON only: {"decision":"allow"|"block","reason":"<one short sentence>"}`;

/**
 * Auto mode: approvals that would prompt the user are first reviewed by a small local model. Hard risk rules run
 * first and always reach the user; the model can only turn a prompt into an approval, never into a denial, and any
 * failure (no model, timeout, unparseable answer) falls back to asking.
 */
export class AutoReviewer {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly log?: vscode.LogOutputChannel,
    private readonly timeoutMs = 30_000
  ) {}

  async review(req: AutoReviewRequest, modelRef?: string): Promise<AutoVerdict> {
    const risk = hardRisk(req.kind, req.title, req.detail);
    if (risk) {
      return { decision: 'ask', reason: risk, source: 'rule' };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    const onOuter = () => abort.abort();
    req.signal?.addEventListener('abort', onOuter);
    try {
      const { provider, model } = await this.providers.route({ role: 'fast', modelRef: modelRef || undefined });
      const user = `User's request:\n${req.request.slice(0, 2000)}\n\nAction (${req.kind}): ${req.title}\n${req.detail.slice(0, 3000)}`;
      let out = '';
      for await (const ev of provider.chat({ model: model.modelId, messages: [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content: user }], temperature: 0, think: false, maxTokens: 200, contextWindow: model.contextWindow, signal: abort.signal })) {
        if (ev.type === 'text') {
          out += ev.text;
        }
      }
      const v = parseVerdict(out);
      this.log?.info(`auto mode (${model.id}): ${v.allow ? 'allow' : 'ask'} ${req.kind} "${req.title}" — ${v.reason}`);
      return { decision: v.allow ? 'allow' : 'ask', reason: v.reason, source: 'model' };
    } catch (e) {
      const why = abort.signal.aborted && !req.signal?.aborted ? 'the reviewer timed out' : e instanceof Error ? e.message : String(e);
      this.log?.warn(`auto mode: review failed (${why}); asking the user`);
      return { decision: 'ask', reason: why, source: 'error' };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onOuter);
    }
  }
}
