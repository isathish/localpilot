/**
 * Approval decisions that do not need VS Code: the reason given with a denial, the `safe` terminal level, the
 * destructive-command rule and the model's own `requires_approval` flag. Pure: no vscode, no I/O.
 */
import type { ApprovalDecision, ApprovalMode, ApprovalOptions, TerminalApprovalMode } from '../types';

/** Handlers written before denials carried a reason resolve a bare boolean. */
export function toDecision(v: boolean | ApprovalDecision | undefined): ApprovalDecision {
  if (typeof v === 'object' && v) {
    const feedback = v.feedback?.trim();
    return feedback && !v.ok ? { ok: false, feedback } : { ok: !!v.ok };
  }
  return { ok: !!v };
}

/** The tool result the model sees for a denied action: the user's reason when there is one, else the tool's own text. */
export function deniedResultText(toolText: string, feedback: string | undefined): string {
  const f = feedback?.trim();
  return f ? `The user denied this action: ${f}\nNothing was done. Follow the user's instruction instead of retrying the same action.` : toolText;
}

/** Whether a tool result text reports a denial by the user (rendered neutral, not as a failure). */
export function isDenialText(text: string): boolean {
  return /^(The user denied this action|User declined|The user declined)\b/.test(text);
}

/**
 * The approval mode that applies to one request after the `safe` level, the destructive-command rule and the model's
 * `requires_approval`. `mustAsk`: the user answers this one prompt; no session memory or auto-mode review stands in.
 */
export function effectiveApproval(mode: TerminalApprovalMode, opts: ApprovalOptions | undefined, dangerousAlwaysAsk: boolean): { mode: ApprovalMode; mustAsk: boolean } {
  if (mode === 'never') {
    return { mode, mustAsk: false };
  }
  const mustAsk = !!opts?.confirm || (!!opts?.dangerous && dangerousAlwaysAsk);
  if (mustAsk) {
    return { mode: 'ask', mustAsk };
  }
  if (mode === 'safe') {
    return { mode: opts?.safeCommand && !opts.dangerous ? 'always' : 'ask', mustAsk: false };
  }
  return { mode, mustAsk: false };
}

/** A typed answer at an approval prompt (CLI): `y`, `a`, `n`, or `n <reason>` / `no, <reason>` to deny with feedback. */
export function parseApprovalAnswer(answer: string): { choice: 'yes' | 'always' | 'no'; feedback?: string } {
  const a = answer.trim();
  const m = /^(n|no|deny)\b[\s,:;.-]*(.*)$/is.exec(a);
  if (m) {
    const feedback = m[2].trim();
    return feedback ? { choice: 'no', feedback } : { choice: 'no' };
  }
  if (/^(a|always)$/i.test(a)) {
    return { choice: 'always' };
  }
  return /^(y|yes)$/i.test(a) ? { choice: 'yes' } : { choice: 'no' };
}
