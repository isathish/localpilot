/**
 * Smoke checks for the agent-loop safety items (bundled into scripts/smoke.ts): the consecutive-mistake limit,
 * output-limit cut-off recovery and `localpilot.disabledTools`, against a scripted OpenAI-compatible server.
 */
import * as http from 'http';
import { AgentRunner } from '../src/agent/agentLoop';
import { MistakeCounter } from '../src/agent/mistakes';
import { hasUnterminatedToolCall, joinContinuation, lengthAction } from '../src/agent/outputLimit';
import { localToolNames } from '../src/agent/builtinAgents';
import { mapToolNames, toolDisabled } from '../src/agent/toolAliases';
import { SkillManager } from '../src/agent/skills';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { ProviderRegistry } from '../src/providers/registry';
import { ToolRegistry } from '../src/tools/registry';
import { AgentEvent, Session, Tool } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

export async function loopSafety(check: Check): Promise<void> {
  console.log('\n[Agent loop safety]');
  // Pure logic first.
  const m = new MistakeCounter(2);
  check('mistakes: all-failed steps count, a success resets', !m.recordStep([{ isError: true, content: 'a' }]) && !m.recordStep([{ isError: false, content: 'ok' }]) && !m.recordStep([{ isError: true, content: 'b' }]) && m.recordRepair('bad json') && m.count === 2);
  check('length: cut-off call retried, prose continued once', lengthAction({ finish: 'length', truncatedCall: true, text: '', retries: 0, continuing: false }) === 'retry' && lengthAction({ finish: 'length', truncatedCall: true, text: '', retries: 3, continuing: false }) === 'give_up' && lengthAction({ finish: 'length', truncatedCall: false, text: 'x', retries: 0, continuing: false }) === 'continue' && lengthAction({ finish: 'length', truncatedCall: false, text: 'x', retries: 0, continuing: true }) === 'none');
  const known = new Set(['write_file']);
  check('length: cut-off text-protocol calls detected', hasUnterminatedToolCall('<tool_call>\n{"name":"write_file","arguments":{"path":"a","content":"abc', known) && hasUnterminatedToolCall('```json\n{"name": "write_file", "arguments": {"path": "a"', known) && hasUnterminatedToolCall('Writing it: {"name":"write_file","arguments":{"path":"a","content":"x}', known) && !hasUnterminatedToolCall('{"name":"write_file","arguments":{}} and ```js\nconst a = 1;', known) && !hasUnterminatedToolCall('{"name":"Ada","age": 3', known));
  check('length: continuation joined without the repeated overlap', joinContinuation('alpha beta gamma', 'beta gamma delta') === 'alpha beta gamma delta');
  check('tool names: Claude and Cline names map to ours', mapToolNames(['Read', 'Grep']).join() === 'read_file,grep_search' && mapToolNames(['execute_command', 'read_files']).join() === 'run_command,read_file' && localToolNames(['Read', 'Grep']).includes('grep_search'));
  check('disabledTools: globs and foreign names', toolDisabled('mcp_x_y', ['mcp_*']) && toolDisabled('run_command', ['Bash']) && !toolDisabled('read_file', ['Bash']));

  let blunderCalls = 0;
  let firstTools: string[] = [];
  let cutterCalls = 0;
  let ramblerCalls = 0;
  let ramblerSawNudge = false;
  let texterCalls = 0;
  let texterSawNudge = false;
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [...['blunder', 'cutter', 'rambler'].map((id) => ({ id, capabilities: ['tool_use'] })), { id: 'texter', capabilities: ['completion'] }] }));
    }
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      return res.end();
    }
    const body = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'text/event-stream');
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const call = (id: string, name: string, args: string, finish: string) => {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: finish }] });
    };
    const say = (text: string, finish: string) => {
      send({ choices: [{ delta: { content: text } }] });
      send({ choices: [{ delta: {}, finish_reason: finish }] });
    };
    if (body.model === 'blunder') {
      // Always reads a file that does not exist.
      if (!blunderCalls) {
        firstTools = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
      }
      blunderCalls++;
      call(`b${blunderCalls}`, 'read_file', JSON.stringify({ path: `missing-${blunderCalls}.txt` }), 'tool_calls');
    } else if (body.model === 'cutter') {
      cutterCalls++;
      if (cutterCalls === 1) {
        call('c1', 'write_file', '{"path":"a.txt","content":"first half of a very long fi', 'length');
      } else if (!JSON.stringify(body.messages).includes('WROTE:a.txt')) {
        call('c2', 'write_file', JSON.stringify({ path: 'a.txt', content: 'short' }), 'tool_calls');
      } else {
        say('Done.', 'stop');
      }
    } else if (body.model === 'texter') {
      // No native tools: calls arrive as <tool_call> text, the first one cut off mid-content.
      texterCalls++;
      texterSawNudge = texterSawNudge || /Be concise/.test(String(body.messages[body.messages.length - 1]?.content ?? ''));
      if (texterCalls === 1) {
        say('<tool_call>\n{"name":"write_file","arguments":{"path":"b.txt","content":"first half of a very long fi', 'length');
      } else if (!JSON.stringify(body.messages).includes('WROTE:b.txt')) {
        say('<tool_call>\n{"name":"write_file","arguments":{"path":"b.txt","content":"brief"}}\n</tool_call>', 'stop');
      } else {
        say('Done.', 'stop');
      }
    } else {
      ramblerCalls++;
      const last = body.messages[body.messages.length - 1];
      ramblerSawNudge = ramblerSawNudge || /cut off at the output limit/.test(String(last?.content ?? ''));
      say(ramblerCalls === 1 ? 'The answer starts here and runs' : ' on to its end.', ramblerCalls === 1 ? 'length' : 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const prevMock = process.env.LP_MOCK_URL;
  const prevConfig = process.env.LP_CONFIG;
  process.env.LP_MOCK_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
  process.env.LP_CONFIG = JSON.stringify({ disabledTools: ['secret_tool', 'mcp_*'] });
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
  try {
    const providers = new ProviderRegistry(log);
    const tools = new ToolRegistry();
    let writes: string[] = [];
    const schema = (props: string[]) => ({ type: 'object' as const, properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])), required: props });
    const stubs: Tool[] = [
      { parallelSafe: true, definition: { name: 'read_file', description: 'read', parameters: schema(['path']) }, async execute(a) { return { content: `File not found: ${a.path}`, isError: true }; } },
      { approvalKind: 'write', definition: { name: 'write_file', description: 'write', parameters: schema(['path', 'content']) }, async execute(a) { writes.push(String(a.content)); return { content: `WROTE:${a.path}` }; } },
      { parallelSafe: true, definition: { name: 'secret_tool', description: 'never offered', parameters: schema([]) }, async execute() { return { content: 'secret' }; } },
      { parallelSafe: true, readOnly: true, definition: { name: 'mcp_fake_tool', description: 'never offered', parameters: schema([]) }, async execute() { return { content: 'mcp' }; } },
    ];
    tools.registerAll(stubs);
    const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
    const session = (id: string, model: string, mode: Session['mode'] = 'agent'): Session => ({ id, title: '', createdAt: 0, updatedAt: 0, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode, attachments: [] });
    const run = async (s: Session, events: AgentEvent[]) => runner.run({ session: s, userMessage: { role: 'user', content: 'go' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });

    const recorded: { type: string; action?: string; sid?: string }[] = [];
    runner.telemetry = { record: (e: { type: string; action?: string; sid?: string }) => recorded.push(e) } as unknown as AgentRunner['telemetry'];
    const evB: AgentEvent[] = [];
    const sB = session('ls-blunder', 'mock/blunder');
    const outB = await run(sB, evB);
    const outcomes = recorded.filter((e) => e.type === 'task' && e.sid === 'ls-blunder' && e.action !== 'created').map((e) => e.action);
    check('mistake limit: the task records exactly one outcome, mistake_limit', outcomes.join() === 'mistake_limit', outcomes);
    const err = evB.find((e) => e.type === 'error')?.payload as { kind?: string; count?: number; latest?: string } | undefined;
    check('mistake limit: a model that keeps reading a missing file stops after exactly 6 steps', blunderCalls === 6 && err?.kind === 'mistake_limit' && err.count === 6, { blunderCalls, err });
    check('mistake limit: the turn ends with the latest reason and how to continue', /^LocalPilot ran into 6 errors in a row and stopped\. Latest: File not found: missing-6\.txt\. Send a message/.test(outB) && sB.messages.at(-1)?.meta?.error === outB, outB);
    check('disabledTools: switched-off tools are never sent to the model', firstTools.includes('read_file') && !firstTools.includes('secret_tool') && !firstTools.includes('mcp_fake_tool'), firstTools);

    const evC: AgentEvent[] = [];
    const sC = session('ls-cutter', 'mock/cutter');
    const outC = await run(sC, evC);
    check('cut-off tool call: not run, nudged with reason=length, recovered', outC === 'Done.' && writes.join() === 'short' && evC.some((e) => e.type === 'nudge' && (e.payload as { reason?: string }).reason === 'length') && cutterCalls === 3, { outC, writes, cutterCalls });
    writes = [];

    const evT: AgentEvent[] = [];
    const outT = await run(session('ls-texter', 'mock/texter'), evT);
    check('cut-off text-protocol call: not run, nudged to shorten, recovered', outT === 'Done.' && writes.join() === 'brief' && texterSawNudge && texterCalls === 3 && evT.some((e) => e.type === 'nudge' && (e.payload as { reason?: string; continued?: boolean }).reason === 'length' && !(e.payload as { continued?: boolean }).continued), { outT, writes, texterCalls, texterSawNudge });
    writes = [];

    const evR: AgentEvent[] = [];
    const sR = session('ls-rambler', 'mock/rambler', 'ask');
    const outR = await run(sR, evR);
    const assistants = sR.messages.filter((x) => x.role === 'assistant');
    check('cut-off prose: continued once and joined into one message', outR === 'The answer starts here and runs on to its end.' && ramblerSawNudge && ramblerCalls === 2 && assistants.length === 1 && assistants[0].content === outR && !sR.messages.some((x) => x.meta?.nudge === 'length'), { outR, ramblerCalls, assistants: assistants.map((a) => a.content) });
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
