/**
 * Offline smoke test: spins up mock Ollama + OpenAI-compatible servers and exercises the provider layer,
 * tool-call parsing, context management and the parallel pool without VS Code.
 * Run: npm run smoke
 */
import * as http from 'http';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAICompatProvider } from '../src/providers/openaiCompat';
import { extractTextToolCalls } from '../src/agent/agentLoop';
import { ContextManager } from '../src/context/contextManager';
import { estimateMessagesTokens } from '../src/context/tokenizer';
import { ParallelPool } from '../src/agent/parallel';
import { htmlToText } from '../src/tools/web';
import { parseFrontMatter } from '../src/agent/skills';
import { parseArgs } from '../src/tools/registry';
import { ChatMessage, StreamEvent, Session, AgentEvent, Tool } from '../src/types';
import { AgentRunner } from '../src/agent/agentLoop';
import { ProviderRegistry } from '../src/providers/registry';
import { ToolRegistry } from '../src/tools/registry';
import { SkillManager } from '../src/agent/skills';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { createAgentTools } from '../src/agent/subagents';
import { diffLines } from '../src/agent/changeTracker';
import { manageTodosTool } from '../src/agent/memory';
import { parseDockerPorts, providersFromContainers } from '../src/providers/discovery';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.log(`  ✖ ${name}`, detail ?? '');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) {
    out.push(e);
  }
  return out;
}

async function mockOllama() {
  console.log('\n[Ollama provider]');
  const srv = await listen(async (req, res) => {
    if (req.url === '/api/version') {
      return res.end(JSON.stringify({ version: '0.9.0' }));
    }
    if (req.url === '/api/tags') {
      return res.end(JSON.stringify({ models: [{ name: 'qwen2.5-coder:7b', model: 'qwen2.5-coder:7b', details: { family: 'qwen2' } }, { name: 'nomic-embed-text', model: 'nomic-embed-text' }] }));
    }
    if (req.url === '/api/show') {
      return res.end(JSON.stringify({ capabilities: ['completion', 'tools', 'insert'], model_info: { 'qwen2.context_length': 32768 }, details: { family: 'qwen2' } }));
    }
    if (req.url === '/api/chat') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'application/x-ndjson');
      const hasToolResult = body.messages.some((m: ChatMessage) => m.role === 'tool');
      if (body.tools && !hasToolResult) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/a.ts' } } }] }, done: false }) + '\n');
      } else {
        for (const w of ['Hello', ' from', ' Ollama']) {
          res.write(JSON.stringify({ message: { role: 'assistant', content: w }, done: false }) + '\n');
        }
      }
      res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 42, eval_count: 7 }) + '\n');
      return res.end();
    }
    if (req.url === '/api/generate') {
      const body = JSON.parse(await readBody(req));
      return res.end(JSON.stringify({ response: body.suffix ? '  return a + b;' : 'plain' }));
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const p = new OllamaProvider({ id: 'ollama', type: 'ollama', baseUrl: srv.url });
    check('healthCheck', await p.healthCheck());
    const models = await p.listModels();
    check('listModels filters embeddings & reads caps', models.length === 1 && models[0].supportsTools && models[0].contextWindow === 32768 && models[0].supportsFim, models);
    const ev = await collect(p.chat({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: 'hi' }] }));
    const text = ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    check('streams text', text === 'Hello from Ollama', text);
    check('reports usage', ev.some((e) => e.type === 'usage' && e.promptTokens === 42));
    const tc = await collect(p.chat({ model: 'qwen2.5-coder:7b', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: '', parameters: { type: 'object', properties: {} } }] }));
    const call = tc.find((e) => e.type === 'tool_call') as { call: { name: string; arguments: string } } | undefined;
    check('emits tool_call with JSON args', !!call && call.call.name === 'read_file' && JSON.parse(call.call.arguments).path === 'src/a.ts', call);
    check('FIM completion uses suffix', (await p.complete({ model: 'x', prompt: 'function add(a,b){\n', suffix: '\n}' })).includes('return a + b'));
  } finally {
    srv.close();
  }
}

async function mockOpenAI() {
  console.log('\n[OpenAI-compatible provider (LM Studio / llama.cpp / vLLM)]');
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder-14b-instruct', owned_by: 'lmstudio', max_context_length: 65536 }, { id: 'text-embedding-nomic', type: 'embeddings' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const hasToolResult = body.messages.some((m: { role: string }) => m.role === 'tool');
      if (body.tools && !hasToolResult) {
        // Fragmented tool-call arguments, as real servers stream them.
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep_search', arguments: '{"que' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"TODO"}' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { reasoning_content: 'thinking…' } }] });
        for (const w of ['Hi', ' there']) {
          send({ choices: [{ delta: { content: w } }] });
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.url === '/v1/completions') {
      await readBody(req);
      return res.end(JSON.stringify({ choices: [{ text: 'console.log(x);' }] }));
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const p = new OpenAICompatProvider({ id: 'lmstudio', type: 'openai', baseUrl: `${srv.url}/v1`, apiKey: 'lm-studio' });
    const models = await p.listModels();
    check('listModels reads LM Studio context length & skips embeddings', models.length === 1 && models[0].contextWindow === 65536, models);
    const ev = await collect(p.chat({ model: models[0].modelId, messages: [{ role: 'user', content: 'hi' }] }));
    check('streams text + reasoning', ev.some((e) => e.type === 'thinking') && ev.filter((e) => e.type === 'text').length === 2);
    check('usage via stream_options', ev.some((e) => e.type === 'usage' && e.promptTokens === 10));
    const tc = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'grep_search', description: '', parameters: { type: 'object', properties: {} } }] }));
    const calls = tc.filter((e) => e.type === 'tool_call') as { call: { id: string; name: string; arguments: string } }[];
    check('reassembles fragmented parallel tool calls', calls.length === 2 && calls[0].call.id === 'call_1' && JSON.parse(calls[0].call.arguments).query === 'TODO' && calls[1].call.name === 'list_dir', calls);
    check('/completions works', (await p.complete({ model: 'm', prompt: 'x' })) === 'console.log(x);');
    // Explicit model list fallback for servers with no /models
    const p2 = new OpenAICompatProvider({ id: 'llamacpp', type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', models: ['local-gguf'] });
    const m2 = await p2.listModels().catch(() => []);
    check('explicit models used when /models unreachable', m2.length === 1 && m2[0].id === 'llamacpp/local-gguf', m2);
  } finally {
    srv.close();
  }
}

async function pureLogic() {
  console.log('\n[Text tool-call protocol]');
  const a = extractTextToolCalls('Let me look.\n```tool_call\n{"name":"read_file","arguments":{"path":"x.ts"}}\n```\n<tool_call>{"name":"list_dir","arguments":{"path":"."}}</tool_call>');
  check('parses fenced + tagged tool calls', a.calls.length === 2 && a.calls[0].name === 'read_file' && a.remainder === 'Let me look.', a);
  check('ignores plain json without name', extractTextToolCalls('```json\n{"a":1}\n```').calls.length === 0);
  const bare = extractTextToolCalls('{"name": "write_file", "arguments": {"path": "a.txt", "content": "x = {\\"k\\": 1}\\n"}}', new Set(['write_file']));
  check('parses bare JSON tool call with nested braces in strings', bare.calls.length === 1 && JSON.parse(bare.calls[0].arguments).content === 'x = {"k": 1}\n' && bare.remainder === '', bare);
  check('known-tool filter rejects unknown names', extractTextToolCalls('{"name": "rm_rf", "arguments": {}}', new Set(['write_file'])).calls.length === 0);
  check('prose mentioning {"name": …} is left alone when not a real call', extractTextToolCalls('The schema is {"name": "x"} plus more text', new Set(['write_file'])).calls.length === 0);
  check('parseArgs lenient', parseArgs('{"path": "a"} trailing').path === 'a' && Object.keys(parseArgs('')).length === 0);

  console.log('\n[Docker discovery]');
  const ports = parseDockerPorts('0.0.0.0:11435->11434/tcp, [::]:11435->11434/tcp, 127.0.0.1:9000->8000/tcp');
  check('parses docker ps port mappings (first host port per container port)', ports.get(11434) === 11435 && ports.get(8000) === 9000 && ports.size === 2, [...ports]);
  const found = providersFromContainers([
    { Image: 'ollama/ollama:latest', Names: 'my-ollama', Ports: '0.0.0.0:11435->11434/tcp' },
    { Image: 'vllm/vllm-openai:v0.6', Names: 'vllm1', Ports: '0.0.0.0:8001->8000/tcp' },
    { Image: 'ghcr.io/ggml-org/llama.cpp:server', Names: 'llm', Ports: '0.0.0.0:8081->8080/tcp' },
    { Image: 'docker/model-runner:latest', Names: 'docker-model-runner', Ports: '0.0.0.0:12434->12434/tcp' },
    { Image: 'postgres:16', Names: 'db', Ports: '0.0.0.0:5432->5432/tcp' },
    { Image: 'ollama/ollama', Names: 'no-ports', Ports: '' },
  ]);
  check('maps known model-server images to providers and skips others', found.length === 4 && found.every((p) => /^docker-/.test(p.id)), found.map((p) => p.id));
  check('ollama container → ollama provider on its host port', found[0].type === 'ollama' && found[0].baseUrl === 'http://localhost:11435');
  check('vllm / llama.cpp containers → OpenAI-compatible /v1', found[1].baseUrl === 'http://localhost:8001/v1' && found[2].baseUrl === 'http://localhost:8081/v1');
  check('standalone model runner → /engines/v1', found[3].baseUrl === 'http://localhost:12434/engines/v1');

  console.log('\n[Context manager]');
  const cm = new ContextManager({ compactionThreshold: 0.75, maxToolOutputChars: 1000 });
  const big = 'x'.repeat(5000);
  check('clampToolOutput keeps head & tail', cm.clampToolOutput(big).length < 1200 && cm.clampToolOutput(big).includes('omitted'));
  const history: ChatMessage[] = [];
  for (let i = 0; i < 30; i++) {
    history.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: '{}' }] }, { role: 'tool', content: 'line1\n' + 'y'.repeat(3000), toolCallId: `c${i}` });
  }
  const before = estimateMessagesTokens(history);
  const pruned = cm.pruneToolOutputs(history, 6);
  check('pruneToolOutputs shrinks old tool results & keeps recent', pruned.saved > before * 0.5 && !pruned.messages[pruned.messages.length - 1].meta?.pruned && pruned.messages[2].meta?.pruned === true);
  const model = { id: 'm', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };
  const b = cm.budget(model, 'sys', [], history, 1024);
  check('budget flags compaction when over threshold', cm.needsCompaction(b) && b.usageRatio > 1);
  // Compaction with a fake provider that returns a summary
  const fake = {
    id: 'f', type: 'openai' as const, displayName: 'f', baseUrl: '',
    listModels: async () => [], healthCheck: async () => true, complete: async () => '',
    chat: async function* () { yield { type: 'text', text: '## Task & goals\n- summarised' } as StreamEvent; },
  };
  const c = await cm.compact(history, fake, model, undefined, 6);
  check('compact replaces older turns with summary and keeps split on user boundary', c.removed > 0 && c.messages[0].meta?.summary === true && c.messages[1].role === 'user' && c.after < c.before, { removed: c.removed, before: c.before, after: c.after });

  console.log('\n[Parallel pool]');
  const pool = new ParallelPool(3);
  let peak = 0;
  const res = await pool.map([1, 2, 3, 4, 5, 6, 7], async (n) => {
    peak = Math.max(peak, pool.active);
    await new Promise((r) => setTimeout(r, 20));
    if (n === 4) {
      throw new Error('boom');
    }
    return n * 2;
  });
  check('bounded concurrency (peak ≤ 3) and order preserved', peak === 3 && res[0].status === 'fulfilled' && (res[0] as PromiseFulfilledResult<number>).value === 2 && res[3].status === 'rejected');

  console.log('\n[Misc]');
  const txt = htmlToText('<html><head><style>x{}</style></head><body><nav>skip</nav><main><h1>Title</h1><p>Hello &amp; <code>world</code></p><pre>a\nb</pre><a href="https://x.y">link</a></main></body></html>'.repeat(1).padEnd(600, ' '));
  check('htmlToText extracts main content', txt.includes('# Title') && txt.includes('Hello & `world`') && txt.includes('[link](https://x.y)') && !txt.includes('skip'), txt);
  const fm = parseFrontMatter('---\nname: my-skill\ndescription: Does things\ntools: [read_file, grep_search]\n---\n# Body\nhi');
  check('front-matter parsing', fm.meta.name === 'my-skill' && Array.isArray(fm.meta.tools) && (fm.meta.tools as string[]).length === 2 && fm.body.startsWith('# Body'));
  const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'x', 'd']);
  check('diffLines marks modified + added lines', d.modified.join(',') === '1' && d.added.join(',') === '3', d);
  check('diffLines identical → empty', diffLines(['a'], ['a']).added.length === 0 && diffLines(['a'], ['a']).modified.length === 0);
}

async function agentLoopE2E() {
  console.log('\n[Agent loop end-to-end]');
  let calls = 0;
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'native', capabilities: ['tool_use'] }, { id: 'textonly', capabilities: [] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      calls++;
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const transcript = JSON.stringify(body.messages);
      const sawResult = transcript.includes('ECHO:');
      if (body.model === 'native') {
        if (!sawResult) {
          // Two identical read-only calls: the second must be served from the per-turn cache.
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'echo', arguments: '{"text":"one"}' } }, { index: 1, id: 'b', function: { name: 'echo', arguments: '{"text":"two"}' } }, { index: 2, id: 'c', function: { name: 'echo', arguments: '{"text":"one"}' } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: 'Final answer after tools.' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
      } else {
        // No native tools: model emits the text protocol; the system prompt must contain the protocol docs.
        const sys = body.messages[0].content as string;
        if (!sys.includes('Tool calling protocol')) {
          send({ choices: [{ delta: { content: 'MISSING PROTOCOL' } }] });
        } else if (!sawResult) {
          send({ choices: [{ delta: { content: 'Checking.\n```tool_call\n{"name":"echo","arguments":{"text":"three"}}\n```' } }] });
        } else {
          send({ choices: [{ delta: { content: 'Text-protocol done.' } }] });
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  process.env.LP_MOCK_URL = `${srv.url}/v1`;
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
  try {
    const providers = new ProviderRegistry(log);
    const tools = new ToolRegistry();
    const skills = new SkillManager(log);
    const workspace = new WorkspaceContext(log);
    let concurrent = 0;
    let peak = 0;
    let executions = 0;
    const echo: Tool = {
      parallelSafe: true,
      definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      async execute(args) {
        executions++;
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 30));
        concurrent--;
        return { content: `ECHO:${args.text}` };
      },
    };
    tools.register(echo);
    const runner = new AgentRunner(providers, tools, skills, workspace, log);
    tools.registerAll(createAgentTools(runner, skills, () => {}, async () => true));

    const mkSession = (model: string): Session => ({ id: 's1', title: '', createdAt: 0, updatedAt: 0, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] });
    const events: AgentEvent[] = [];
    const s = mkSession('mock/native');
    const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'go' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('native: final text returned', out === 'Final answer after tools.', out);
    check('native: tool calls executed in parallel', events.filter((e) => e.type === 'tool_end').length === 3 && peak >= 2, { peak });
    check('native: identical read-only call served from cache', executions === 2 && events.some((e) => e.type === 'tool_end' && (e.payload as { cached?: boolean }).cached), { executions });
    check('native: transcript shape user→assistant(tools)→tool×3→assistant', s.messages.map((m) => m.role).join(',') === 'user,assistant,tool,tool,tool,assistant', s.messages.map((m) => m.role));
    check('native: tool results carry call ids', s.messages[2].toolCallId === 'a' && s.messages[3].toolCallId === 'b' && s.messages[4].toolCallId === 'c');
    check('native: turn_end emitted', events.at(-1)?.type === 'turn_end');

    const s2 = mkSession('mock/textonly');
    const out2 = await runner.run({ session: s2, userMessage: { role: 'user', content: 'go' }, emit: () => {}, signal: new AbortController().signal, requestApproval: async () => true });
    check('text-protocol: fallback works for models without tool support', out2 === 'Text-protocol done.', out2);
    check('text-protocol: tool result fed back as user message', s2.messages[2].role === 'user' && s2.messages[2].content.includes('ECHO:three'), s2.messages[2]);
    check('text-protocol: tool_call block stripped from assistant text', s2.messages[1].content === 'Checking.' && s2.messages[1].toolCalls?.length === 1);

    // Cancellation
    const s3 = mkSession('mock/native');
    const ac = new AbortController();
    ac.abort();
    const out3 = await runner.run({ session: s3, userMessage: { role: 'user', content: 'go' }, emit: () => {}, signal: ac.signal, requestApproval: async () => true }).catch((e) => `ERR:${e.message}`);
    check('aborted signal exits loop quickly', out3 === '' || String(out3).startsWith('ERR:'), out3);
    check('total model calls as expected', calls === 4, calls);

    // manage_todos writes to the session via the tool context
    const s4 = mkSession('mock/native');
    const todoEvents: AgentEvent[] = [];
    const ctx = { sessionId: s4.id, signal: new AbortController().signal, depth: 0, progress() {}, trackChange: async () => {}, requestApproval: async () => true, todos: { get: () => s4.todos ?? [], set: (items: Session['todos']) => { s4.todos = items; todoEvents.push({ sessionId: s4.id, type: 'todos', payload: items }); } } };
    const r = await manageTodosTool.execute({ todos: [{ id: '1', title: 'Read code', status: 'done' }, { id: '2', title: 'Edit file', status: 'in_progress' }, { title: 'Run tests' }] }, ctx);
    check('manage_todos stores a sanitised list and reports progress', s4.todos?.length === 3 && s4.todos[2].status === 'pending' && r.content.includes('1/3 done') && todoEvents.length === 1, s4.todos);
  } finally {
    srv.close();
    delete process.env.LP_MOCK_URL;
  }
}

(async () => {
  await mockOllama();
  await mockOpenAI();
  await pureLogic();
  await agentLoopE2E();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
