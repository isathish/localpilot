/** Smoke checks for approvals: deny with feedback, the `safe` command level and notifications (bundled into scripts/smoke.ts; no VS Code needed). */
import { deniedResultText, effectiveApproval, parseApprovalAnswer, toDecision } from '../src/agent/approvalLevel';
import { isReadOnlyOrSafe } from '../src/agent/commandGuard';
import { shouldNotify, shouldRingBell } from '../src/ui/notifyPolicy';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function approvals(check: Check): void {
  console.log('\n— approvals —');
  check('a denial reason replaces the fixed refusal', deniedResultText('User declined the edit.', 'edit src/b.ts instead').startsWith('The user denied this action: edit src/b.ts instead'));
  check('handlers answering a boolean still work', toDecision(true).ok && !toDecision(false).ok && toDecision({ ok: false, feedback: ' x ' }).feedback === 'x');
  const n = parseApprovalAnswer('n use b.ts');
  check('CLI: `n <reason>` denies with feedback', n.choice === 'no' && n.feedback === 'use b.ts', n);
  const safe = ['git status', 'npm test', 'tsc --noEmit', 'pytest -q', 'cargo test', 'go vet ./...', 'make test', 'ls | wc -l'];
  const asks = ['npm install', 'node x.js', 'rm -rf dist', 'echo x > f', 'sudo ls', 'git push', 'git -c core.fsmonitor=x status', 'PATH=. ls', 'GIT_EXTERNAL_DIFF=./x git diff', 'git --exec-path=. status'];
  check('safe level: read-only and routine test/build commands', safe.every((c) => isReadOnlyOrSafe(c, { windows: false }).ok), safe.filter((c) => !isReadOnlyOrSafe(c, { windows: false }).ok));
  check('safe level: everything else asks', asks.every((c) => !isReadOnlyOrSafe(c, { windows: false }).ok), asks.filter((c) => isReadOnlyOrSafe(c, { windows: false }).ok));
  check('a destructive command asks under always unless dangerousAlwaysAsk is off', effectiveApproval('always', { dangerous: true }, true).mode === 'ask' && effectiveApproval('always', { dangerous: true }, false).mode === 'always');
  check('requires_approval asks under always and safe', effectiveApproval('always', { confirm: true }, true).mustAsk && effectiveApproval('safe', { safeCommand: true, confirm: true }, true).mode === 'ask');
  check('notifications only while hidden or unfocused by default', !shouldNotify('whenHidden', true, true) && shouldNotify('whenHidden', false, true) && !shouldNotify('off', false, false));
  check('CLI bell after 10 s on a TTY', shouldRingBell('whenHidden', true, 11_000) && !shouldRingBell('whenHidden', true, 9_000) && !shouldRingBell('whenHidden', false, 60_000));
}
