/**
 * Smoke checks (bundled into scripts/smoke.ts) for the Plan/Ask command guard, basic compaction, the transcript
 * archive helpers, the web access switch and the response language, partly against a scripted OpenAI-compatible server.
 */
import * as http from 'http';
import * as os from 'os';
import { AgentRunner } from '../src/agent/agentLoop';
import { checkReadOnlyCommand } from '../src/agent/commandGuard';
import { languageInstruction } from '../src/agent/prompts';
import { SkillManager } from '../src/agent/skills';
import { basicSummary } from '../src/context/basicCompaction';
import { ContextManager } from '../src/context/contextManager';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { ProviderRegistry } from '../src/providers/registry';
import { carryArchiveMarks, rebuildBefore } from '../src/sessions/transcriptArchive';
import { COMMAND_GUARD_CASES } from '../src/test/commandGuardCases';
import { ToolRegistry } from '../src/tools/registry';
import { runCommandTool } from '../src/tools/terminal';
import { AgentEvent, ChatMessage, ModelInfo, Session, Tool } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

export async function agentModes(check: Check): Promise<void> {
  console.log('\n[Plan-mode guard, compaction, web switch, language]');
  const wrong = COMMAND_GUARD_CASES.filter(([cmd, ok, windows]) => checkReadOnlyCommand(cmd, { windows: !!windows }).ok !== ok).map(([cmd]) => cmd);
  check(`command guard: ${COMMAND_GUARD_CASES.length} read-only / mutating cases`, !wrong.length, wrong);

  const turn = (i: number): ChatMessage[] => [
    { role: 'user', content: `request ${i}` },
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `f${i}.ts` }) }] },
    { role: 'tool', toolCallId: `c${i}`, toolName: 'read_file', content: `body ${i} ${'x'.repeat(300)}` },
    { role: 'assistant', content: `done ${i}` },
  ];
  const history: ChatMessage[] = [];
  for (let i = 0; i < 50; i++) {
    history.push(...turn(i));
  }
  const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };
  const cm = new ContextManager({ compactionThreshold: 0.5, maxToolOutputChars: 1000, keepRecent: 4, strategy: 'basic' });
  const started = Date.now();
  const res = await cm.compact(history, { chat() { throw new Error('no model call expected'); } } as never, model);
  const ms = Date.now() - started;
  check('basic compaction: 200 messages in under 50 ms, no model call, every user message kept', ms < 50 && res.removed > 0 && history.filter((m) => m.role === 'user').every((u) => res.messages.some((m) => m.content.includes(u.content))), { ms, removed: res.removed });
  check('basic compaction: one line per tool call', basicSummary([...turn(1), { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'run_command', arguments: '{"command":"npm test"}' }] }, { role: 'tool', toolCallId: 'x', content: '$ npm test\nboom\n[exit code 2]' }]).includes('• run_command npm test (exit 2, 1 line of error)') && basicSummary(turn(1)).includes('• read_file f1.ts (ok)'));

  const before = [...turn(1), ...turn(2)];
  before.forEach((m, i) => (m.meta = { ...m.meta, archived: i }));
  const after: ChatMessage[] = [{ role: 'user', content: 's', meta: { summary: true } }, { ...before[6], meta: {} }, before[7]];
  carryArchiveMarks(before, after);
  const rebuilt = rebuildBefore(before.map((message, seq) => ({ seq, compaction: 0, at: 0, message })), 4);
  check('archive: marks follow pruned copies, rewinding rebuilds the originals', after[1].meta?.archived === 6 && rebuilt?.length === 4 && rebuilt[2].content.startsWith('body 1'));
  check('language: one line for a language, none for auto', /^Always respond in French\./.test(languageInstruction('French')) && languageInstruction('auto') === '');

  let firstTools: string[] = [];
  let system = '';
  let step = 0;
  const results: string[] = [];
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'planner', capabilities: ['tool_use'] }] }));
    }
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      return res.end();
    }
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'text/event-stream');
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!step) {
      firstTools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
      system = String(body.messages[0]?.content ?? '');
    } else {
      results.push(String(body.messages[body.messages.length - 1]?.content ?? ''));
    }
    step++;
    const cmd = step === 1 ? 'rm -rf build' : step === 2 ? 'git -C . commit -m x' : step === 3 ? 'echo planned' : undefined;
    if (cmd) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `r${step}`, function: { name: 'run_command', arguments: JSON.stringify({ command: cmd }) } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: 'Plan ready.' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const prevMock = process.env.LP_MOCK_URL;
  const prevConfig = process.env.LP_CONFIG;
  process.env.LP_MOCK_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
  process.env.LP_CONFIG = JSON.stringify({ 'webSearch.enabled': false, preferredLanguage: 'German', 'approvals.terminal': 'ask' });
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
  try {
    const providers = new ProviderRegistry(log);
    const tools = new ToolRegistry();
    const stub = (name: string, approvalKind?: Tool['approvalKind']): Tool => ({ approvalKind, parallelSafe: true, definition: { name, description: name, parameters: { type: 'object', properties: {} } }, async execute() { return { content: 'ok' }; } });
    tools.registerAll([stub('read_file'), stub('web_search', 'network'), stub('web_fetch', 'network'), stub('browser_screenshot', 'network'), stub('write_file', 'write'), runCommandTool]);
    const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
    const approvals: string[] = [];
    const session: Session = { id: 'am-plan', title: '', createdAt: 0, updatedAt: 0, model: 'mock/planner', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'plan', attachments: [] };
    const events: AgentEvent[] = [];
    const out = await runner.run({ session, userMessage: { role: 'user', content: 'plan the cleanup' }, emit: (e) => events.push(e), signal: new AbortController().signal, workspaceRoot: os.tmpdir(), requestApproval: async (title, detail) => (approvals.push(`${title}: ${detail.split('\n')[0]}`), true) });
    check('plan mode: run_command offered, write and web tools not (webSearch.enabled = false)', firstTools.includes('run_command') && !firstTools.includes('write_file') && !firstTools.some((t) => /^(web_|browser_)/.test(t)), firstTools);
    check('plan mode: rm and git commit refused without an approval card, the run continues', /^Plan mode: `rm` changes files\. Only read-only commands run in Plan mode\./.test(results[0] ?? '') && /git commit/.test(results[1] ?? '') && out === 'Plan ready.', { results, out });
    check('plan mode: a read-only command still asks for terminal approval and runs', approvals.length === 1 && /echo planned/.test(approvals[0]) && /planned/.test(results[2] ?? ''), { approvals, r: results[2] });
    check('preferredLanguage: the system prompt says which language to answer in', system.includes('Always respond in German.') && /Web access is turned off/.test(system));
    providers.dispose();
  } finally {
    if (prevMock === undefined) {
      delete process.env.LP_MOCK_URL;
    } else {
      process.env.LP_MOCK_URL = prevMock;
    }
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    srv.close();
  }
}
