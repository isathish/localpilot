/**
 * Smoke checks (bundled into scripts/smoke.ts) for the CLI's headless flags (exit codes, --timeout, <stdin>, @refs,
 * -P/-k), the NDJSON stream, the REPL status line and completion, /settings masking and the version notice.
 */
import * as path from 'path';
import { completeCommand, completionToken } from '../src/cli/completer';
import { exitSummary, nextMode, statusLineText, sumNumstat } from '../src/cli/statusLine';
import { eventRecord, NdjsonWriter } from '../src/cli/ndjson';
import { atRefs, exitCodeFor, finishReasonFor, parseDuration, runProviderList, withStdin } from '../src/cli/headless';
import { compareVersions, extensionVersion, versionNotice } from '../src/cli/versionCheck';
import { redactSecrets, settingKey } from '../src/cli/settingsView';
import { contextPercent, memoryReport } from '../src/agent/reports';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, amber: (s: string) => s, cyan: (s: string) => s };

export function cliParity(check: Check): void {
  console.log('\n[CLI headless flags / NDJSON / REPL status line]');
  check('exit codes: 0 done, 1 error, 3 mistake limit, 124 timeout, 130 stopped', [exitCodeFor({}), exitCodeFor({ error: 'x' }), exitCodeFor({ error: 'x', errorKind: 'mistake_limit' }), exitCodeFor({ aborted: true, timedOut: true }), exitCodeFor({ aborted: true })].join() === '0,1,3,124,130');
  check('finish reasons', [finishReasonFor({}), finishReasonFor({ completed: false }), finishReasonFor({ aborted: true, timedOut: true })].join() === 'completed,max_steps,timeout');
  check('--timeout durations', parseDuration('90') === 90_000 && parseDuration('2m') === 120_000 && parseDuration('x') === undefined);
  check('piped stdin goes in a <stdin> block', withStdin('review', 'abc') === 'review\n\n<stdin>\nabc\n</stdin>');
  const shot = path.resolve('/w', 'shot.png');
  const src = path.resolve('/w', 'src/a.ts');
  const refs = atRefs('see @shot.png and @src/a.ts plus @someone', path.resolve('/w'), (p) => p === shot || p === src);
  check('@refs: images and files that exist, other @words left alone', refs.images.join() === shot && refs.files.join() === src, refs);
  const run = runProviderList([{ id: 'x', type: 'openai', baseUrl: 'http://h/v1', enabled: false }], 'x', undefined, '${secret:localpilot-run-x}');
  check('-P enables the provider for the run with the run-only key reference', run.list[0].enabled === true && run.list[0].apiKey === '${secret:localpilot-run-x}');
  const lines: string[] = [];
  const errs: string[] = [];
  const w = new NdjsonWriter({ write: (s: string) => lines.push(s) } as unknown as NodeJS.WritableStream, { write: (s: string) => errs.push(s) } as unknown as NodeJS.WritableStream, () => 1);
  w.event({ sessionId: 's', type: 'status', payload: 'Thinking…' });
  w.event({ sessionId: 's', type: 'error', payload: 'boom' });
  check('NDJSON: one object per line on stdout, errors on stderr', lines.length === 1 && JSON.parse(lines[0]).message === 'Thinking…' && JSON.parse(errs[0]).type === 'error' && JSON.parse(errs[0]).message === 'boom');
  check('NDJSON: internal events are not streamed', eventRecord({ sessionId: 's', type: 'approval_request', payload: {} }) === undefined);
  check('status line', statusLineText({ model: 'm', mode: 'agent', ctxPercent: 34, git: { branch: 'main', added: 3, removed: 1 }, auto: false, costUsd: 0.02 }) === 'm · agent · ctx 34% · main +3 −1 · auto:off · $0.02');
  check('numstat sums and mode cycle', sumNumstat('1\t2\ta\n3\t4\tb').added === 4 && nextMode('plan') === 'ask' && nextMode('ask') === 'agent');
  check('exit summary names the resume command', /localpilot -r cli-1/.test(exitSummary({ id: 'cli-1', messages: [{ role: 'user', content: 'x' }] }, plain)));
  check('completion tokens', completionToken('/he')?.kind === 'command' && completionToken('x @sr')?.token === '@sr' && completeCommand('/m', ['/mode', '/mcp', '/help']).join() === '/mode,/mcp');
  check('/settings masks keys but keeps ${env:}/${secret:} references', JSON.stringify(redactSecrets({ apiKey: 'sk-1', token: '${env:T}' })) === '{"apiKey":"••••","token":"${env:T}"}' && settingKey('localpilot.thinking') === 'thinking');
  check('/memory text is shared (CLI points at the files)', /\.localpilot\/memory/.test(memoryReport([], [{ name: 'n', scope: 'project', summary: 's', updatedAt: 0, chars: 1 }], true, 'cli')) && contextPercent(50, 200) === 25);
  check('version notice only when the CLI is older', extensionVersion('localpilot.localpilot-agent-2.0.1') === '2.0.1' && compareVersions('1.9.0', '1.10.0') < 0 && !!versionNotice('1.0.0', { version: '1.1.0', dir: '/x' }) && !versionNotice('1.1.0', { version: '1.1.0', dir: '/x' }));
}
