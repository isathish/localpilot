/**
 * Smoke checks (bundled into scripts/smoke.ts) for automation and interop: schedules (cron parsing, crontab / launchd /
 * Task Scheduler text, reports), the ACP server (a JSON-RPC conversation against a stub agent), Claude Code and Codex
 * session import, the team board mailbox and the /team brief.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cmdSchedule, crontabLine, cronMatches, launchdCalendar, launchdPlist, makeSchedule, mergeCrontab, nextRun, parseCron, parseRunOutput, reportMarkdown, runArgs, ScheduleStore, schtasksArgs } from '../src/cli/schedule';
import { AcpHost, AcpServer, promptFromBlocks, toolKind } from '../src/cli/acp';
import { alreadyImported, claudeProjectSlug, findImportable, importInto, parseClaudeSession, parseCodexSession, readImport } from '../src/sessions/importers';
import { selectCandidates } from '../src/cli/historyImport';
import { addressedTo, BoardMailbox } from '../src/agent/teamBoard';
import { teamPrompt } from '../src/agent/teamBrief';
import { claudeTranscript, codexRollout, writeTranscriptHome } from '../src/test/fixtures/agentTranscripts';
import { Session, SessionSummary } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const plain = { bold: String, dim: String, red: String, green: String, yellow: String, amber: String, cyan: String };

export function stubSession(id: string): Session {
  return { id, title: 'New chat', createdAt: 1, updatedAt: 1, model: '', mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [] };
}

/** A stub ACP host: each run streams text, starts a command (asking for approval) and ends it. */
export function stubAcpHost(): AcpHost & { approvals: unknown[] } {
  const sessions = new Map<string, Session>();
  const approvals: unknown[] = [];
  return {
    approvals,
    version: '9.9.9',
    newSession: async () => {
      const s = stubSession(`cli-${sessions.size + 1}`);
      sessions.set(s.id, s);
      return s;
    },
    loadSession: async (id) => sessions.get(id),
    models: async () => [{ id: 'ollama/qwen', name: 'qwen' }],
    defaultModel: () => 'ollama/qwen',
    run: async (r) => {
      if (r.text.includes('wait')) {
        await new Promise<void>((resolve) => r.signal.addEventListener('abort', () => resolve(), { once: true }));
        return { text: '', completed: false };
      }
      r.session.messages.push({ role: 'user', content: r.text });
      r.emit({ sessionId: r.session.id, type: 'thinking_delta', payload: 'hmm' });
      r.emit({ sessionId: r.session.id, type: 'assistant_delta', payload: 'Running tests. ' });
      r.emit({ sessionId: r.session.id, type: 'tool_start', payload: { id: 'call_1', name: 'run_command', args: { command: 'npm test' } } });
      const ok = await r.requestApproval('Run: npm test', 'npm test', 'terminal');
      approvals.push(ok);
      r.emit({ sessionId: r.session.id, type: 'tool_end', payload: { id: 'call_1', name: 'run_command', isError: !ok, content: ok ? 'passed' : 'denied' } });
      r.emit({ sessionId: r.session.id, type: 'todos', payload: [{ id: '1', title: 'Run tests', status: 'done' }] });
      r.emit({ sessionId: r.session.id, type: 'assistant_delta', payload: 'Done.' });
      r.session.messages.push({ role: 'assistant', content: 'Running tests. Done.' });
      return { text: 'Done.', completed: true };
    },
  };
}

/** Drives an AcpServer like a client; permission requests are answered with `answer()`. */
export function acpClient(host: AcpHost, answer: () => string | undefined) {
  const out: Record<string, unknown>[] = [];
  let id = 100;
  const server: AcpServer = new AcpServer(host, (line) => {
    const m = JSON.parse(line) as Record<string, unknown>;
    out.push(m);
    if (m.method === 'session/request_permission') {
      const pick = answer();
      void server.handle(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: pick ? { outcome: 'selected', optionId: pick } : { outcome: 'cancelled' } } }));
    }
  });
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const rid = ++id;
    await server.handle(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
    const res = out.find((m) => m.id === rid && m.method === undefined) as { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined;
    return res ?? {};
  };
  return { out, call, server };
}

export async function automation(check: Check): Promise<void> {
  console.log('\n[automation: schedules, ACP, session import, team mailbox]');

  // ---- cron
  const c = parseCron('*/15 9-17 * * mon-fri');
  check('cron: steps, ranges and weekday names', JSON.stringify(c.minute) === '[0,15,30,45]' && c.hour?.length === 9 && c.dom === null && JSON.stringify(c.dow) === '[1,2,3,4,5]', c);
  check('cron: 7 is Sunday and * fields are wildcards', JSON.stringify(parseCron('0 3 * * 7').dow) === '[0]' && parseCron('* * * * *').minute === null);
  check('cron: @daily alias', JSON.stringify(parseCron('@daily')) === JSON.stringify(parseCron('0 0 * * *')));
  let bad = 0;
  for (const e of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'x * * * *']) {
    try {
      parseCron(e);
    } catch {
      bad++;
    }
  }
  check('cron: invalid expressions are refused', bad === 6, bad);
  check('cron: matches local time', cronMatches(c, new Date(2026, 10, 4, 9, 30)) && !cronMatches(c, new Date(2026, 10, 8, 9, 30)));
  check('cron: day of month OR weekday', cronMatches(parseCron('0 0 1 * 1'), new Date(2026, 10, 9, 0, 0)) && cronMatches(parseCron('0 0 1 * 1'), new Date(2026, 10, 1, 0, 0)));
  const n = nextRun(parseCron('30 3 * * *'), new Date(2026, 10, 4, 10, 0));
  check('nextRun: tomorrow 03:30', !!n && n.getDate() === 5 && n.getHours() === 3 && n.getMinutes() === 30, n);
  check('nextRun: Feb 29 is found in a leap year', nextRun(parseCron('0 0 29 2 *'), new Date(2026, 0, 1))?.getFullYear() === 2028);

  // ---- OS entries
  const l = { command: '/home/u/.local/bin/localpilot', args: [] as string[] };
  const line = crontabLine({ name: 'nightly', cron: '0 3 * * *' }, l, { PATH: '/usr/bin:/bin' });
  check('crontab line: env, command, tag', line === "0 3 * * * PATH=/usr/bin:/bin /home/u/.local/bin/localpilot schedule run nightly # localpilot-schedule:nightly", line);
  const merged = mergeCrontab(`MAILTO=x\n0 1 * * * backup\n${line}\n`, 'nightly', line.replace('0 3', '0 4'));
  check('crontab merge: replaces only its own line', merged === `MAILTO=x\n0 1 * * * backup\n${line.replace('0 3', '0 4')}\n`, merged);
  check('crontab merge: removal leaves the rest', mergeCrontab(merged, 'nightly', undefined) === 'MAILTO=x\n0 1 * * * backup\n');
  const cal = launchdCalendar(parseCron('0,30 9 * * 1-5'));
  check('launchd: calendar entries are the product of the fields', cal.length === 10 && cal[0].Minute === 0 && cal[0].Hour === 9 && cal[0].Weekday === 1, cal.length);
  check('launchd: day of month and weekday become separate entries', launchdCalendar(parseCron('0 0 1 * 1')).length === 2);
  const plist = launchdPlist({ name: 'nightly', cron: '0 3 * * *' }, { command: '/usr/bin/node', args: ['/x/cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, '/tmp/n.log');
  check('launchd plist: label, arguments, env, calendar, log', plist.includes('<string>dev.localpilot.schedule.nightly</string>') && plist.includes('<string>/x/cli.js</string>\n\t\t<string>schedule</string>\n\t\t<string>run</string>\n\t\t<string>nightly</string>') && plist.includes('<key>ELECTRON_RUN_AS_NODE</key>') && plist.includes('<key>Hour</key>\n\t\t\t<integer>3</integer>') && plist.includes('<string>/tmp/n.log</string>'));
  const win = { command: 'C:\\Users\\u\\bin\\localpilot.cmd', args: [] as string[] };
  const daily = schtasksArgs({ name: 'n', cron: '5 3 * * *' }, win);
  check('schtasks: daily', daily.join(' ').includes('/TN LocalPilot\\n') && daily.slice(-4).join(' ') === '/SC DAILY /ST 03:05', daily);
  check('schtasks: every 15 minutes, weekly, monthly', schtasksArgs({ name: 'n', cron: '*/15 * * * *' }, win).slice(-4).join(' ') === '/SC MINUTE /MO 15' && schtasksArgs({ name: 'n', cron: '0 9 * * 1,4' }, win).slice(-6).join(' ') === '/SC WEEKLY /D MON,THU /ST 09:00' && schtasksArgs({ name: 'n', cron: '0 9 1,15 * *' }, win).slice(-6).join(' ') === '/SC MONTHLY /D 1,15 /ST 09:00');
  let refused = false;
  try {
    schtasksArgs({ name: 'n', cron: '7,9 3 * * *' }, win);
  } catch {
    refused = true;
  }
  check('schtasks: inexpressible schedules are refused', refused);
  const viaCode = schtasksArgs({ name: 'n', cron: '5 3 * * *' }, { command: 'C:\\VS Code\\Code.exe', args: ['C:\\ext\\dist\\cli.js'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  const trCode = viaCode[viaCode.indexOf('/TR') + 1];
  check('schtasks: launcher env is set before the command', trCode === 'cmd /d /s /c "set "ELECTRON_RUN_AS_NODE=1"&& "C:\\VS Code\\Code.exe" C:\\ext\\dist\\cli.js schedule run n"', trCode);
  let tooLong = '';
  try {
    schtasksArgs({ name: 'n', cron: '5 3 * * *' }, { command: 'C:\\VS Code\\Code.exe', args: ['C:\\ext\\dist\\cli.js'], env: { ELECTRON_RUN_AS_NODE: '1', LOCALPILOT_VSCODE_SETTINGS: `C:\\${'x'.repeat(260)}` } });
  } catch (e) {
    tooLong = String(e);
  }
  check('schtasks: a command over the /TR limit asks for the localpilot shim', /localpilot/.test(tooLong) && /261/.test(tooLong), tooLong);

  // ---- schedules, runs, reports
  const s = makeSchedule({ name: 'nightly', cron: '0 3 * * *', prompt: 'run the tests', cwd: '/repo', mode: 'plan', model: 'ollama/qwen', timeout: '20m' });
  check('makeSchedule: timeout in seconds', s.timeoutSec === 1200 && s.mode === 'plan');
  check('runArgs: one-shot yolo json run with timeout, folder, mode, model', runArgs(s).join(' ') === `--yolo --json --timeout 1200s -C ${s.cwd} --plan -m ollama/qwen -- run the tests` && path.resolve(s.cwd) === path.resolve('/repo'), runArgs(s).join(' '));
  let badName = false;
  try {
    makeSchedule({ name: 'no spaces', cron: '0 3 * * *', prompt: 'x', cwd: '/' });
  } catch {
    badName = true;
  }
  check('makeSchedule: bad names refused', badName);
  const ndjson = [
    { type: 'assistant_delta', text: 'Tests ' },
    { type: 'tool_start', id: 't1', name: 'run_command', args: { command: 'npm test' } },
    { type: 'tool_end', id: 't1', name: 'run_command', isError: false },
    { type: 'assistant_delta', text: 'pass.' },
    { type: 'run_result', finishReason: 'completed', text: 'Tests pass.', usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 }, model: 'ollama/qwen', durationMs: 5 },
  ].map((r) => JSON.stringify(r)).join('\n');
  const parsed = parseRunOutput(ndjson, '{"type":"error","message":"warn: slow"}\nplain log line');
  check('parseRunOutput: answer, tools, errors, result', parsed.answer === 'Tests pass.' && parsed.tools[0]?.label === 'npm test' && parsed.errors[0] === 'warn: slow' && parsed.result?.finishReason === 'completed', parsed);
  const md = reportMarkdown(s, { runId: 'nightly-1', name: 'nightly', startedAt: '2026-11-04T03:00:00.000Z', finishedAt: '2026-11-04T03:01:00.000Z', exitCode: 0, finishReason: 'completed' }, parsed, 'plain log line');
  check('report: status, prompt, answer, tools, log', md.startsWith('# nightly: done') && md.includes('took 60 s') && md.includes('## Answer\n\nTests pass.') && md.includes('- ✔ run_command: `npm test`') && md.includes('plain log line'), md);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-sched-'));
  const prevSched = process.env.LOCALPILOT_SCHEDULER;
  process.env.LOCALPILOT_SCHEDULER = 'off';
  const origLog = console.log;
  const origErr = console.error;
  try {
    const store = new ScheduleStore(home);
    console.log = () => undefined;
    console.error = () => undefined;
    const created = await cmdSchedule(['create', 'nightly', '--cron', '0 3 * * *', '--prompt', 'fix lint', '-C', home], plain, l, store);
    const dup = await cmdSchedule(['create', 'nightly', '--cron', '0 3 * * *', '--prompt', 'again'], plain, l, store);
    const badCron = await cmdSchedule(['create', 'other', '--cron', 'nope', '--prompt', 'x'], plain, l, store);
    const paused = await cmdSchedule(['pause', 'nightly'], plain, l, store);
    console.log = origLog;
    console.error = origErr;
    check('schedule create/pause: saved in schedules.json', created === 0 && paused === 0 && store.get('nightly')?.prompt === 'fix lint' && store.get('nightly')?.paused === true && store.get('nightly')?.cwd === home);
    check('schedule create: duplicates and bad cron refused', dup === 2 && badCron === 1 && !store.get('other'), { dup, badCron });
    store.record({ runId: 'a', name: 'nightly', startedAt: '2026-11-01T03:00:00Z', finishedAt: '2026-11-01T03:01:00Z', exitCode: 0, report: '/r/a.md' });
    store.record({ runId: 'b', name: 'nightly', startedAt: '2026-11-02T03:00:00Z', finishedAt: '2026-11-02T03:01:00Z', exitCode: 1, report: '/r/b.md' });
    check('schedule history: newest first', store.history('nightly').map((r) => r.runId).join() === 'b,a');
    console.log = () => undefined;
    const del = await cmdSchedule(['delete', 'nightly'], plain, l, store);
    console.log = origLog;
    check('schedule delete', del === 0 && !store.get('nightly'));
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.env.LOCALPILOT_SCHEDULER = prevSched;
    if (prevSched === undefined) {
      delete process.env.LOCALPILOT_SCHEDULER;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }

  // ---- ACP
  const host = stubAcpHost();
  let reply: string | undefined = 'allow_always';
  const acp = acpClient(host, () => reply);
  const init = await acp.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
  check('acp initialize: version and loadSession', init.result?.protocolVersion === 1 && (init.result?.agentCapabilities as { loadSession?: boolean })?.loadSession === true, init);
  const created = await acp.call('session/new', { cwd: '/repo', mcpServers: [] });
  const sid = String(created.result?.sessionId);
  const modes = created.result?.modes as { currentModeId: string; availableModes: { id: string }[] };
  check('acp session/new: id, modes and config options', sid === 'cli-1' && modes.currentModeId === 'agent' && modes.availableModes.some((m) => m.id === 'plan') && (created.result?.configOptions as { id: string }[]).map((o) => o.id).join() === 'mode,model', created);
  const first = await acp.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'run the tests' }] });
  const updates = acp.out.filter((m) => m.method === 'session/update').map((m) => (m.params as { update: Record<string, unknown> }).update);
  const kinds = updates.map((u) => u.sessionUpdate);
  check('acp prompt: chunks, tool call, update, plan, end_turn', first.result?.stopReason === 'end_turn' && kinds.includes('agent_thought_chunk') && kinds.includes('agent_message_chunk') && kinds.includes('tool_call') && kinds.includes('plan'), { first, kinds });
  const perm = acp.out.find((m) => m.method === 'session/request_permission')?.params as { toolCall: { toolCallId: string; kind: string }; options: { kind: string }[] } | undefined;
  check('acp permission: for the running tool call, with once/always/reject', perm?.toolCall.toolCallId === 'call_1' && perm.toolCall.kind === 'execute' && perm.options.map((o) => o.kind).join() === 'allow_once,allow_always,reject_once', perm);
  const done = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
  check('acp tool_call_update: completed with content', !!done && JSON.stringify(done).includes('passed'));
  reply = 'reject_once';
  const permsBefore = acp.out.filter((m) => m.method === 'session/request_permission').length;
  await acp.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'again' }] });
  check('acp: "always" is remembered for the session', acp.out.filter((m) => m.method === 'session/request_permission').length === permsBefore && host.approvals[1] === true);
  const second = await acp.call('session/new', { cwd: '/repo' });
  await acp.call('session/prompt', { sessionId: String(second.result?.sessionId), prompt: [{ type: 'text', text: 'x' }] });
  check('acp: a rejection reaches the agent as a denial', JSON.stringify(host.approvals[2]) === '{"ok":false}', host.approvals);
  const setMode = await acp.call('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'plan' });
  check('acp set_config_option: mode', ((setMode.result?.configOptions as { id: string; currentValue: string }[]) ?? []).find((o) => o.id === 'mode')?.currentValue === 'plan');
  const waiting = acp.call('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  await new Promise((r) => setTimeout(r, 5));
  await acp.server.handle(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } }));
  check('acp session/cancel: stopReason cancelled', (await waiting).result?.stopReason === 'cancelled');
  const n0 = acp.out.length;
  const loaded = await acp.call('session/load', { sessionId: sid, cwd: '/repo' });
  check('acp session/load: replays the chat', !!loaded.result && acp.out.slice(n0).some((m) => JSON.stringify(m).includes('user_message_chunk')));
  check('acp unknown method: -32601', (await acp.call('nope')).error?.code === -32601);
  check('acp prompt blocks: text, resources, links, images', JSON.stringify(promptFromBlocks([{ type: 'text', text: 'see' }, { type: 'resource', resource: { uri: 'file:///a.ts', text: 'x' } }, { type: 'resource_link', uri: 'file:///b.ts', name: 'b' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }])) === JSON.stringify({ text: 'see\n\n<file path="/a.ts">\nx\n</file>\n\n@/b.ts', images: ['AAA'] }));
  check('acp tool kinds', toolKind('read_file') === 'read' && toolKind('edit_file') === 'edit' && toolKind('run_command') === 'execute' && toolKind('grep_search') === 'search');

  // ---- import
  const cs = parseClaudeSession(claudeTranscript('/repo'));
  check('claude import: title, cwd, merged assistant message, tool result, no meta/sidechain', cs.title === 'Fix add in math.ts' && cs.cwd === '/repo' && cs.messages.map((m) => m.role).join() === 'user,assistant,tool,assistant' && cs.messages[1].thinking === 'Look at the test first.' && cs.messages[1].toolCalls?.[0].name === 'Read' && cs.messages[2].toolName === 'Read' && !JSON.stringify(cs.messages).includes('subagent chatter'), cs.messages);
  const cx = parseCodexSession(codexRollout('/repo'));
  check('codex import: environment skipped, reasoning, call and output', cx.cwd === '/repo' && cx.model === 'gpt-test' && cx.messages.map((m) => m.role).join() === 'user,assistant,tool,assistant' && cx.messages[1].thinking === 'Search with rg.' && cx.messages[1].toolCalls?.[0].id === 'call_1' && cx.title === 'List the TODOs in this repo', cx.messages);
  check('claude slug', process.platform === 'win32' ? claudeProjectSlug('C:\\Users\\me\\Work\\My.App') === 'C--Users-me-Work-My-App' : claudeProjectSlug('/Users/me/Work/My.App') === '-Users-me-Work-My-App');
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-import-'));
  try {
    const ws = path.join(fake, 'repo');
    writeTranscriptHome(fake, ws);
    const found = findImportable(ws, { home: fake });
    check('findImportable: both chats of this folder, newest first, not the other folder', found.length === 2 && found[0].source === 'codex' && found[1].source === 'claude-code', found);
    const sel = selectCandidates(found, ['2']);
    check('selectCandidates: numbers, all, unknown', sel.chosen[0] === found[1] && selectCandidates(found, ['all']).chosen.length === 2 && selectCandidates(found, ['9']).unknown[0] === '9');
    const saved: Session[] = [];
    const target = {
      list: (): SessionSummary[] => saved,
      create: (model: string) => {
        const x = stubSession(`s_${saved.length}`);
        x.model = model;
        saved.push(x);
        return x;
      },
      save: () => undefined,
      flush: async () => undefined,
    };
    const r1 = await importInto(target, readImport(found[1]));
    const r2 = await importInto(target, readImport(found[1]));
    check('importInto: origin, title, messages; a second import is skipped', r1.created && !r2.created && saved.length === 1 && saved[0].origin === 'claude-code' && saved[0].messages.length === 4 && !!alreadyImported(saved, found[1]));
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }

  // ---- mailbox and /team
  const me = 'ann@box · session abcd1234';
  check('mailbox addressing: owner, suffix, held task, broadcast, never own', addressedTo({ id: '1', at: '', from: 'bob', to: me, text: '' }, me) && addressedTo({ id: '1', at: '', from: 'bob', to: 'abcd1234', text: '' }, me) && addressedTo({ id: '1', at: '', from: 'bob', to: 'fix-login', text: '' }, me, ['fix-login']) && addressedTo({ id: '1', at: '', from: 'bob', to: '*', text: '' }, me) && !addressedTo({ id: '1', at: '', from: me, to: '*', text: '' }, me) && !addressedTo({ id: '1', at: '', from: 'bob', to: 'zz', text: '' }, me));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-mail-'));
  try {
    const box = new BoardMailbox(root);
    await box.send('bob@box · session ffff0000', 'abcd1234', 'API is merged');
    await box.send('bob@box · session ffff0000', '*', 'standup in 5');
    await box.send(me, '*', 'my own');
    const inbox = await box.inbox(me);
    const again = await box.inbox(me);
    await box.send('carol', me, 'review please');
    const later = await box.inbox(me);
    check('mailbox inbox: unread once, then only new ones', inbox.map((m) => m.text).join('|') === 'API is merged|standup in 5' && again.length === 0 && later.map((m) => m.text).join() === 'review please', { inbox, again, later });
    check('mailbox file lives with the board', fs.existsSync(path.join(root, '.localpilot', 'board', 'mail.jsonl')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const brief = teamPrompt('add dark mode');
  check('/team brief: board, delegation and mailbox', brief.startsWith('Team task: add dark mode') && brief.includes('team_board add') && brief.includes('run_todos_parallel') && brief.includes('team_board send'));
}
