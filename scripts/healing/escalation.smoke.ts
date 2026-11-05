/**
 * Smoke checks for src/agent/healing/escalation.ts (design §11).
 *   node scripts/healing/run.js scripts/healing/escalation.smoke.ts
 */
import { buildIntervention, cliNextCommands, outcomeFor, report } from '../../src/agent/healing/escalation';
import type { AttemptRecord, EscalationReason, Failure, RecoveryState } from '../../src/agent/healing/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const state = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  version: 1, rev: 0, sessionId: 's1', turnKey: 2, phase: 'escalating', startedAt: 0, updatedAt: 0,
  owner: { pid: 1, host: 'h', kind: 'cli' }, baseline: undefined, checks: {}, changedFiles: [], agentWrites: {},
  approvals: [], acceptedRisks: [], attempts: [], perCategory: {}, seen: {}, active: [], extraStepsUsed: 0, ...over,
});
const failure = (over: Partial<Failure> = {}): Failure => ({
  id: 'f', category: 'unit_test', cls: 'deterministic', severity: 'high', message: 'expected 10:00 got 09:00',
  evidence: '  AssertionError: expected 10:00 got 09:00\n    at date.test.ts:12  ', source: { kind: 'check', checkId: 'npm:test' },
  signature: 'sig', generic: 'g', file: 'src/utils/date.ts', line: 18, ...over,
});
const attempt = (n: number, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  n, category: 'unit_test', signature: 'sig', strategy: 'fix', mode: 'inline', patches: [], startedAt: 0, ...over,
});

const ALL: EscalationReason[] = [
  'exhausted', 'duplicate', 'deadline', 'loop', 'mistake_limit', 'approval_needed', 'credentials', 'git_conflict', 'security',
  'data_corruption', 'model_blocked', 'user_edit_conflict', 'model_unavailable',
];

export async function escalationSmoke(check: Check): Promise<void> {
  // ---- outcomes ----
  const blocked: EscalationReason[] = ['approval_needed', 'credentials', 'git_conflict', 'security', 'model_blocked', 'data_corruption'];
  check('blocked reasons', blocked.every((r) => outcomeFor(r) === 'blocked'));
  check('model_unavailable -> failed', outcomeFor('model_unavailable') === 'failed');
  check('budget reasons -> incomplete', (['exhausted', 'duplicate', 'deadline', 'loop', 'mistake_limit', 'user_edit_conflict'] as EscalationReason[]).every((r) => outcomeFor(r) === 'incomplete'));

  // ---- next actions per reason ----
  const acts = (r: EscalationReason) => buildIntervention(state(), r, { now: 1 }).nextActions.map((a) => a.action).join(',');
  check('approval_needed actions', acts('approval_needed') === 'approveInstall,resume');
  check('git_conflict actions', acts('git_conflict') === 'openMergeEditor,resume');
  check('security actions', acts('security') === 'resume,acceptRisk');
  check('credentials actions', acts('credentials') === 'setApiKey,pickModel');
  check('data_corruption actions', acts('data_corruption') === 'restoreCheckpoint,dismiss');
  check('model_unavailable actions', acts('model_unavailable') === 'retry,startServer');
  for (const r of ['exhausted', 'duplicate', 'deadline', 'loop', 'mistake_limit', 'model_blocked', 'user_edit_conflict'] as EscalationReason[]) {
    check(`${r} actions`, acts(r) === 'retryWithGuidance,resume,rollback,dismiss', acts(r));
  }
  const risk = buildIntervention(state(), 'security', { now: 1 }).nextActions.find((a) => a.action === 'acceptRisk');
  check('accept risk is user only and has no CLI shortcut', !!risk && /user only/.test(risk.label) && !risk.command, risk);

  // ---- exhausted record + report ----
  const patch = { attempt: 2, file: 'src/utils/date.ts', added: 3, removed: 1, diffHash: 'h', preview: '+x', result: 'rolled_back' as const };
  const st = state({
    taskId: 'task-9',
    perCategory: { unit_test: 3 },
    active: [failure({ preexisting: true, severity: 'critical', signature: 'old' }), failure()],
    attempts: [
      attempt(1, { rootCause: 'convert in formatter', result: 'not_fixed' }),
      attempt(2, { rootCause: 'change parseDate signature', result: 'rolled_back', patches: [patch] }),
      attempt(3, { rootCause: 'parseDate() returns UTC but the test expects local time', result: 'duplicate' }),
    ],
  });
  const rec = buildIntervention(st, 'exhausted', { now: 5000, command: 'npm test', budget: 3 });
  check('record basics', rec.sessionId === 's1' && rec.taskId === 'task-9' && rec.reason === 'exhausted' && rec.category === 'unit_test' && rec.createdAt === 5000, rec);
  check('non-preexisting failure preferred over a severer preexisting one', rec.evidence?.startsWith('AssertionError') === true, rec.evidence);
  check('root cause from the last attempt with location', rec.rootCause === 'parseDate() returns UTC but the test expects local time (src/utils/date.ts:18)', rec.rootCause);
  check('patches flattened', rec.patches.length === 1 && rec.patches[0].file === 'src/utils/date.ts');
  check('id is deterministic', rec.id === buildIntervention(st, 'exhausted', { now: 5000, command: 'npm test', budget: 3 }).id && rec.id.startsWith('int_'));
  check('id differs by reason', rec.id !== buildIntervention(st, 'duplicate', { now: 5000 }).id);
  check('explicit id kept', buildIntervention(st, 'exhausted', { now: 1, id: 'X' }).id === 'X');
  const text = report(st, rec);
  const lines = text.split('\n');
  check('exhausted heading', lines[0] === 'Incomplete: `npm test` still fails after 3 fix attempts (budget for unit_test: 3).', lines[0]);
  check('root cause line', lines[1] === 'Root cause: parseDate() returns UTC but the test expects local time (src/utils/date.ts:18)', lines[1]);
  check('tried line', lines[2] === 'Tried: 1) convert in formatter (not fixed) 2) change parseDate signature (made it worse, reverted) 3) parseDate() returns UTC but the test expects local time (same error).', lines[2]);
  check('next line mentions Resume', lines[3].startsWith('Next: ') && /"Resume"/.test(lines[3]), lines[3]);
  check('custom next', report(st, rec, { next: 'decide whether dates should be local or UTC.' }).endsWith('Next: decide whether dates should be local or UTC.'));
  const total = buildIntervention(st, 'exhausted', { now: 1, command: 'npm test', maxTotalAttempts: 3 });
  check('total budget named when reached', /total budget: 3/.test(total.title), total.title);

  // ---- per-reason wording ----
  const dl = buildIntervention(state({ recoveryStartedAt: 0, deadlineAt: 60 * 60_000, active: [failure()] }), 'deadline', { now: 1, command: 'npm test' });
  check('deadline wording', report(state(), dl).startsWith('Incomplete: Recovery deadline of 60 min reached while `npm test` still fails.'), report(state(), dl));
  check('deadline from ctx', /recovery deadline of 15 min/.test(buildIntervention(state(), 'deadline', { now: 1, deadlineMinutes: 15 }).title));
  const loop = buildIntervention(state(), 'loop', { now: 1, steps: { model: 40, recovery: 16 } });
  check('loop names the budget', loop.title === 'stopped: 40 model steps + 16 recovery steps used', loop.title);
  const un = buildIntervention(state(), 'approval_needed', { now: 1, unattended: true, installCommand: 'pip install PyYAML' });
  const unText = report(state(), un, { installCommand: 'pip install PyYAML' });
  check('unattended approval text', /install was not attempted because the task ran unattended/.test(unText) && unText.startsWith('Blocked: `pip install PyYAML` needs approval'), unText);
  check('unattended next names the command', /run `pip install PyYAML` yourself/.test(unText), unText);
  const unStored = report(state(), un);
  check('stored next survives without ctx', /run `pip install PyYAML` yourself/.test(unStored), unStored);
  const unRoundTrip = report(state(), JSON.parse(JSON.stringify(un)));
  check('stored next survives a JSON round trip', /run `pip install PyYAML` yourself/.test(unRoundTrip), unRoundTrip);
  const att = buildIntervention(state(), 'approval_needed', { now: 1, installCommand: 'npm i left-pad' });
  check('attended approval text', !/unattended/.test(att.title) && /not approved/.test(att.title), att.title);
  const gc = buildIntervention(state(), 'git_conflict', { now: 1, files: ['a.ts'] });
  check('git conflict preserves user changes', /a\.ts/.test(gc.title) && /preserved/.test(gc.title) && report(state(), gc).startsWith('Blocked:'));
  const dc = report(state(), buildIntervention(state(), 'data_corruption', { now: 1, detail: 'database disk image is malformed' }));
  check('data corruption: no writes', dc.startsWith('Blocked: Data corruption detected (database disk image is malformed)') && /No automatic writes/.test(dc), dc);
  const mu = report(state(), buildIntervention(state(), 'model_unavailable', { now: 1, model: 'qwen3:8b', detail: 'ECONNREFUSED' }));
  check('model unavailable -> Failed', mu.startsWith('Failed: The model server is unavailable (qwen3:8b): ECONNREFUSED.'), mu);
  check('no Tried line without attempts', !/Tried:/.test(mu));
  check('every reason produces a report', ALL.every((r) => {
    const t = report(state(), buildIntervention(state(), r, { now: 1 }));
    return /^(Blocked|Incomplete|Failed): \S/.test(t) && /\nNext: \S/.test(t);
  }));
  const long = buildIntervention(state({ active: [failure({ evidence: 'x'.repeat(5000) })] }), 'exhausted', { now: 1 });
  check('evidence capped at 2 KB', long.evidence?.length === 2048);

  // ---- CLI commands ----
  const cmds = cliNextCommands(rec);
  check('cli commands for exhausted', cmds.some((c) => c.startsWith('/recovery resume')) && cmds.some((c) => c.startsWith('/recovery rollback')) && cmds.some((c) => c.startsWith('localpilot -c "')) && cmds.some((c) => c.startsWith('localpilot recovery clear s1')), cmds);
  const sidCmds = cliNextCommands(buildIntervention(state({ sessionId: 'cli-m1x2y3' }), 'exhausted', { now: 1 }));
  check('cli retry-with-guidance targets the session', sidCmds.some((c) => c.startsWith('localpilot -r cli-m1x2y3 "<your guidance>"')) && !sidCmds.some((c) => c.startsWith('localpilot -c')), sidCmds);
  const retryCmds = cliNextCommands(buildIntervention(state({ sessionId: 's_abc123' }), 'model_unavailable', { now: 1 }));
  check('cli retry targets the session', retryCmds.some((c) => c.startsWith('localpilot -r s_abc123  #')), retryCmds);
  const apCmds = cliNextCommands(un);
  check('duplicate commands merged', apCmds.length === 1 && apCmds[0] === '/recovery resume  # Approve install / Install manually and Resume', apCmds);
  check('provider key command', cliNextCommands(buildIntervention(state(), 'credentials', { now: 1, provider: 'openai' }))[0] === 'localpilot providers key openai  # Set API key');
  check('security cli omits accept risk', cliNextCommands(buildIntervention(state(), 'security', { now: 1 })).length === 1);
}
