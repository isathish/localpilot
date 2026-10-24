/**
 * Offline smoke test: spins up mock Ollama + OpenAI-compatible servers and exercises the provider layer,
 * tool-call parsing, context management and the parallel pool without VS Code.
 * Run: npm run smoke
 */
import * as http from 'http';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAICompatProvider } from '../src/providers/openaiCompat';
import { claimsChange, extractTextToolCalls, looksLikeBareClaim, looksLikeUnfulfilledIntent, showsToolCallAsText } from '../src/agent/agentLoop';
import { postProcess, shouldTrigger } from '../src/ui/inlineCompletion';
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
import { callKey, classifyModelError, ModelStallError, withWatchdog } from '../src/agent/resilience';
import { HttpError } from '../src/providers/http';
import { StreamEvent } from '../src/types';
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
  const broken = extractTextToolCalls('```tool_call\n{"name": "read_file", "arguments": {"path": "x.ts",}}\n```', new Set(['read_file']));
  check('explicit tool_call block with invalid JSON is reported, not swallowed', broken.calls.length === 0 && broken.malformed.length === 1 && /invalid JSON/.test(broken.malformed[0]), broken);
  const unknown = extractTextToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', new Set(['read_file']));
  check('explicit tool_call with unknown tool is reported', unknown.calls.length === 0 && /unknown tool "rm_rf"/.test(unknown.malformed[0] ?? ''), unknown);
  check('plain json fence that fails to parse is not a malformed call', extractTextToolCalls('```json\n{oops}\n```').malformed.length === 0);

  console.log('\n[Inline completion post-processing]');
  check('mid-line: single line only', postProcess('bar)\nnext line', ')') === 'bar');
  check('mid-line: overlapping tail with text after cursor trimmed', postProcess('bar(x))', ')') === 'bar(x)');
  check('mid-line: verbatim suffix removed', postProcess('x, y) {', ') {') === 'x, y');
  check('end of line: multi-line kept, sentinels stripped', postProcess('a\nb<|endoftext|>', '') === 'a\nb');
  check('trigger: skipped inside identifier', !shouldTrigger('fo', 'o', false));
  check('trigger: skipped while deleting', !shouldTrigger('foo', '', true));
  check('trigger: allowed at end of line and before punctuation', shouldTrigger('foo(', ')', false) && shouldTrigger('  return ', '', false));

  console.log('\n[Completion nudge heuristic]');
  check('"done" to a create request is a bare claim', looksLikeBareClaim('done', 'Use write_file to create a.txt'));
  check('"fixed" to an edit request is a bare claim', looksLikeBareClaim('Fixed.', 'Please fix the bug in calc.py'));
  check('an explanation with code is not', !looksLikeBareClaim('Here is the change:\n```py\nx = 1\n```\nDone.', 'fix the bug'));
  const tools = ['read_file', 'edit_file', 'write_file'];
  check('pseudo tool call in a code fence is an unfulfilled intent', looksLikeUnfulfilledIntent('Understood as: fix add().\n\nHere is the change:\n\n```python\nedit_file path:calc.py old_text:a - b new_text:a + b\n```\n\nfixed', tools));
  check('announcing an action without doing it is an unfulfilled intent', looksLikeUnfulfilledIntent("Understood as: Fix the error in src/mathutil.py.\n\nAssumptions:\n- The error is in the active file.\n\nLet's proceed with fixing the error in `src/mathutil.py`.", tools));
  check('a finished answer that offers more is not', !looksLikeUnfulfilledIntent('All tests pass now. Let me know if you want me to update the README too.', tools));
  check('a question back to the user is not', !looksLikeUnfulfilledIntent("I can fix it two ways. Would you like me to proceed with the regex approach?", tools));
  check('prose mentioning a tool name is not', !looksLikeUnfulfilledIntent('I used edit_file to change one line; the tests are green.', tools));
  check('a unified diff shown instead of applied is an unfulfilled intent', looksLikeUnfulfilledIntent('Here is the change I will make:\n\n```diff\n--- a/calc.py\n+++ b/calc.py\n@@ -1 +1 @@\n-    return a - b\n+    return a + b\n```\n\nfixed', tools));
  check('a plain code sample is not', !looksLikeUnfulfilledIntent('Use it like this:\n\n```python\nadd(1, 2)\n```', tools));
  check('tool name with a colon inside a fence is a shown call', showsToolCallAsText('Here is the updated code:\n\n```python\nedit_file: path:calc.py old_text:return a - b new_text:return a + b\n```\n\nFixed', tools));
  check('tool-style call on its own line is a shown call', showsToolCallAsText('write_file("a.txt", "hello")', tools));
  check('"I\'ve edited" with code shown is a claimed change', claimsChange("Here is the updated code:\n\n```python\ndef add(a, b):\n    return a + b\n```\n\nI've edited the `add()` function to return `a + b`. The `mul()` function remains unchanged.\n\nFixed.", 'calc.py has a bug, fix it with edit_file'));
  check('a trailing "Fixed." is a claimed change', claimsChange('The bug was in add().\n\nFixed.', 'fix the bug'));
  check('a question is not a claimed change', !claimsChange("I've found the bug in add(). Should I fix it?", 'fix the bug'));
  check('an explanation to a question is not a claimed change', !claimsChange('add() returns a - b; the file has been like this since the first commit.', 'why does add() return the wrong value?'));
  check('a clarifying question is not', !looksLikeBareClaim('Which file should I update?', 'update the config'));
  check('a question-type request is not nudged', !looksLikeBareClaim('It returns the sum.', 'what does add do?'));
  check('a long substantive answer is not', !looksLikeBareClaim('I reviewed the module. '.repeat(20), 'fix the module'));

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

  console.log('\n[Resilience helpers]');
  check('classify: ECONNREFUSED → network', classifyModelError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })) === 'network');
  check('classify: HTTP 503 → server, 429 → ratelimit, 400 → other', classifyModelError(new HttpError(503, 'overloaded', 'u')) === 'server' && classifyModelError(new HttpError(429, '', 'u')) === 'ratelimit' && classifyModelError(new HttpError(400, 'bad request', 'u')) === 'other');
  check('classify: context-length message → overflow', classifyModelError(new HttpError(400, "This model's maximum context length is 32768 tokens", 'u')) === 'overflow' && classifyModelError(new Error('the input length exceeds num_ctx')) === 'overflow');
  check('callKey ignores argument order', callKey('read_file', { path: 'a', start_line: 1 }) === callKey('read_file', { start_line: 1, path: 'a' }) && callKey('read_file', { path: 'a' }) !== callKey('read_file', { path: 'b' }));
  {
    let aborted = false;
    async function* slow(): AsyncGenerator<StreamEvent> { await new Promise((r) => setTimeout(r, 400)); yield { type: 'text', text: 'late' }; }
    let err: unknown;
    try { for await (const _ of withWatchdog(slow(), { firstTokenMs: 60, idleMs: 60, abort: () => (aborted = true) })) { /* never */ } } catch (e) { err = e; }
    check('watchdog: no first token within the limit → ModelStallError + abort', err instanceof ModelStallError && (err as ModelStallError).phase === 'first-token' && aborted);
    async function* ok(): AsyncGenerator<StreamEvent> { yield { type: 'text', text: 'a' }; await new Promise((r) => setTimeout(r, 20)); yield { type: 'text', text: 'b' }; }
    const got: string[] = [];
    for await (const ev of withWatchdog(ok(), { firstTokenMs: 500, idleMs: 500, abort: () => undefined })) { if (ev.type === 'text') { got.push(ev.text); } }
    check('watchdog: passes events through when the stream keeps moving', got.join('') === 'ab');
    async function* stallsLater(): AsyncGenerator<StreamEvent> { yield { type: 'text', text: 'a' }; await new Promise((r) => setTimeout(r, 300)); yield { type: 'text', text: 'b' }; }
    let err2: unknown;
    try { for await (const _ of withWatchdog(stallsLater(), { firstTokenMs: 500, idleMs: 60, abort: () => undefined })) { /* consume */ } } catch (e) { err2 = e; }
    check('watchdog: mid-stream silence → ModelStallError(mid-stream)', err2 instanceof ModelStallError && (err2 as ModelStallError).phase === 'mid-stream');
  }
}

async function agentLoopE2E() {
  console.log('\n[Agent loop end-to-end]');
  let calls = 0;
  let flakyHits = 0;
  let emptyHits = 0;
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'native', capabilities: ['tool_use'] }, { id: 'textonly', capabilities: [] }, { id: 'flaky', capabilities: ['tool_use'] }, { id: 'empty', capabilities: ['tool_use'] }, { id: 'looper', capabilities: ['tool_use'] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      calls++;
      if (body.model === 'flaky' && flakyHits++ === 0) {
        res.statusCode = 503;
        return res.end('upstream overloaded');
      }
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const transcript = JSON.stringify(body.messages);
      const sawResult = transcript.includes('ECHO:');
      if (body.model === 'flaky') {
        send({ choices: [{ delta: { content: 'Recovered after a retry.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else if (body.model === 'empty') {
        if (emptyHits++ === 0) {
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); // nothing at all
        } else {
          send({ choices: [{ delta: { content: 'Second time lucky.' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
      } else if (body.model === 'looper') {
        // Keeps asking for the same thing until the loop guard refuses, then answers.
        if (transcript.includes('Refused: this exact call')) {
          send({ choices: [{ delta: { content: 'Okay, stopping the loop.' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        } else {
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `l${calls}`, function: { name: 'echo', arguments: '{"text":"same"}' } }] } }] });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        }
      } else if (body.model === 'native') {
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
    // Hidden steering messages (clarification snapshots, completion nudges) are plumbing, not transcript shape.
    const visible = (s: Session) => s.messages.filter((m) => !m.meta?.hidden);
    const events: AgentEvent[] = [];
    const s = mkSession('mock/native');
    const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'go' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('native: final text returned', out === 'Final answer after tools.', out);
    check('native: tool calls executed in parallel', events.filter((e) => e.type === 'tool_end').length === 3 && peak >= 2, { peak });
    check('native: identical read-only call served from cache', executions === 2 && events.some((e) => e.type === 'tool_end' && (e.payload as { cached?: boolean }).cached), { executions });
    const v1 = visible(s);
    check('native: transcript shape user→assistant(tools)→tool×3→assistant', v1.map((m) => m.role).join(',') === 'user,assistant,tool,tool,tool,assistant', v1.map((m) => m.role));
    check('native: tool results carry call ids', v1[2].toolCallId === 'a' && v1[3].toolCallId === 'b' && v1[4].toolCallId === 'c');
    check('native: turn_end emitted', events.at(-1)?.type === 'turn_end');

    const s2 = mkSession('mock/textonly');
    const out2 = await runner.run({ session: s2, userMessage: { role: 'user', content: 'go' }, emit: () => {}, signal: new AbortController().signal, requestApproval: async () => true });
    const v2 = visible(s2);
    check('text-protocol: fallback works for models without tool support', out2 === 'Text-protocol done.', out2);
    check('text-protocol: tool result fed back as user message', v2[2].role === 'user' && v2[2].content.includes('ECHO:three'), v2[2]);
    check('text-protocol: tool_call block stripped from assistant text', v2[1].content === 'Checking.' && v2[1].toolCalls?.length === 1);

    // Resilience: a 5xx before the first token is retried transparently.
    const sFlaky = mkSession('mock/flaky');
    const evFlaky: AgentEvent[] = [];
    const outFlaky = await runner.run({ session: sFlaky, userMessage: { role: 'user', content: 'go' }, emit: (e) => evFlaky.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('resilience: HTTP 503 before first token is retried and recovers', outFlaky === 'Recovered after a retry.' && flakyHits === 2, { outFlaky, flakyHits });
    check('resilience: retry is announced with reason=server', evFlaky.some((e) => e.type === 'retry' && (e.payload as { reason: string }).reason === 'server') && !evFlaky.some((e) => e.type === 'error'));
    // An empty completion is asked again instead of being accepted as the answer.
    const sEmpty = mkSession('mock/empty');
    const evEmpty: AgentEvent[] = [];
    const outEmpty = await runner.run({ session: sEmpty, userMessage: { role: 'user', content: 'go' }, emit: (e) => evEmpty.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('resilience: empty completion is retried', outEmpty === 'Second time lucky.' && emptyHits === 2 && evEmpty.some((e) => e.type === 'retry' && (e.payload as { reason: string }).reason === 'empty'), { outEmpty, emptyHits });
    // The same tool call over and over is refused after MAX_IDENTICAL_CALLS, which breaks the loop.
    const sLoop = mkSession('mock/looper');
    const beforeLoop = executions;
    const outLoop = await runner.run({ session: sLoop, userMessage: { role: 'user', content: 'go' }, emit: () => {}, signal: new AbortController().signal, requestApproval: async () => true });
    const refused = sLoop.messages.filter((m) => m.role === 'tool' && /Refused: this exact call/.test(m.content)).length;
    check('resilience: identical tool call loop is cut off', outLoop === 'Okay, stopping the loop.' && refused >= 1 && executions - beforeLoop <= 3, { outLoop, refused, ran: executions - beforeLoop });

    // Cancellation
    const s3 = mkSession('mock/native');
    const ac = new AbortController();
    ac.abort();
    const out3 = await runner.run({ session: s3, userMessage: { role: 'user', content: 'go' }, emit: () => {}, signal: ac.signal, requestApproval: async () => true }).catch((e) => `ERR:${e.message}`);
    check('aborted signal exits loop quickly', out3 === '' || String(out3).startsWith('ERR:'), out3);
    // native 2 + textonly 2 + flaky 2 (503 then ok) + empty 2 + looper 5 (3 served calls, 1 refused, final answer); the aborted run makes none.
    check('total model calls as expected', calls === 13, calls);

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
