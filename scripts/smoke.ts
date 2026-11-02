/**
 * Offline smoke test: spins up mock Ollama + OpenAI-compatible servers and exercises the provider layer,
 * tool-call parsing, context management and the parallel pool without VS Code.
 * Run: npm run smoke
 */
import * as http from 'http';
import { OllamaProvider } from '../src/providers/ollama';
import { OpenAICompatProvider } from '../src/providers/openaiCompat';
import { AnthropicProvider, thinkingStyle, toAnthropicMessages } from '../src/providers/anthropic';
import { completeViaChat, isCloudProvider, isRemoteUrl, resolveApiKey, setSecretValues, stripFences } from '../src/providers/cloud';
import { retryAfter } from '../src/providers/http';
import { retryDelayMs } from '../src/agent/resilience';
import { pickForRole } from '../src/providers/registry';
import { buildProfile } from '../src/providers/system';
import { PROVIDER_PRESETS } from '../src/providers/presets';
import { checkGatewayPrereqs, classifyGatewayModels, gatewayEnv, gatewayModels, installCommand as gatewayInstall, needsProviders, nodeVersionOk, startCommand as gatewayStart } from '../src/providers/gatewaySetup';
import { checkPrereqs, coliCommand, findColibri, freePort, installCommand, launcherIn, modelChoices, probePort, setupArgs, statusProgress } from '../src/providers/colibriSetup';
import * as nodeFs from 'fs';
import * as nodeOs from 'os';
import * as nodePath from 'path';
import { ModelInfo } from '../src/types';
import { claimsChange, extractTextToolCalls, looksLikeBareClaim, looksLikeStaleDelegation, looksLikeUnfulfilledIntent, showsToolCallAsText } from '../src/agent/agentLoop';
import { postProcess, shouldTrigger } from '../src/ui/inlineCompletion';
import { ContextManager, effectiveContextWindow, TokenCalibration } from '../src/context/contextManager';
import { asksToRemember } from '../src/agent/skillRecommender';
import { buildRepoGraph, findCycles, parseSource } from '../src/context/repoGraph';
import { describePolicy, flooredApproval, getManagedPolicy, managedPolicyPath, mcpServerAllowed, normalizePolicy, policyVerdict, providerAllowed, resetManagedPolicyCache, toolAllowed } from '../src/agent/managedPolicy';
import { answerRepoGraph } from '../src/tools/repoGraph';
import { formatPr, gitCommitTool, gitPushTool, gitStatusTool, runCmd, summarizeFailedLog, validBranch } from '../src/tools/git';
import { builtinCommands } from '../src/agent/commands';
import { BUILTIN_SUITE } from '../src/eval/suite';
import { parseMemoryNotes, runDigest } from '../src/agent/autoMemory';
import { irrelevantTools } from '../src/agent/toolRelevance';
import { getEventListeners } from 'events';
import { onAbort, sleep as rsleep } from '../src/agent/resilience';
import { withTimeout } from '../src/providers/http';
import { McpManager } from '../src/mcp/mcpManager';
import { claimable, formatBoard, parseTask, serializeTask, TeamBoard } from '../src/agent/teamBoard';
import { teamBoardTool } from '../src/tools/teamBoard';
import { collectRepos, findRepo } from '../src/agent/repos';
import { reposTool } from '../src/tools/repos';
import { describePlugin as describePluginP, gitUrl, installPlugin, loadMarketplace, parseMarketplace, removePlugin, scaffoldPlugin, searchPlugins, setPluginEnabled, validatePlugin } from '../src/agent/pluginInstaller';
import { checkDependencies, entropy, osvFixes, osvSeverity, parseLockfile, scanText, toSarif } from '../src/security/scan';
import { McpClient } from '../src/mcp/mcpManager';
import { SseParser, transportKind } from '../src/mcp/transports';
import * as nodeHttp from 'http';
import { checkStatic, formatReport, summarize as summarizeEval, verifyTask } from '../src/eval/runner';
import { estimateMessagesTokens } from '../src/context/tokenizer';
import { ParallelPool } from '../src/agent/parallel';
import { htmlToText } from '../src/tools/web';
import { parseFrontMatter } from '../src/agent/skills';
import { parseArgs } from '../src/tools/registry';
import { ChatMessage, StreamEvent, Session, AgentEvent, Tool } from '../src/types';
import { AgentRunner } from '../src/agent/agentLoop';
import { RunControl } from '../src/agent/runControl';
import { WorktreeManager } from '../src/agent/worktrees';
import { percentiles, Samples, SAMPLE_CAP, summarize, Telemetry, TelemetryEvent } from '../src/telemetry/telemetry';
import { completeTask, parseModelSuggestions, quickSuggestions } from '../src/agent/taskSuggestions';
import { ProviderRegistry } from '../src/providers/registry';
import { ToolRegistry } from '../src/tools/registry';
import { SkillManager } from '../src/agent/skills';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { createAgentTools } from '../src/agent/subagents';
import { ChatController, ToWebview } from '../src/ui/chatController';
import { SessionStore } from '../src/sessions/sessionStore';
import { ChangeTracker, diffLines } from '../src/agent/changeTracker';
import { callKey, classifyModelError, ModelStallError, withWatchdog } from '../src/agent/resilience';
import { HttpError } from '../src/providers/http';
import { StreamEvent } from '../src/types';
import { manageTodosTool } from '../src/agent/memory';
import { parseDockerPorts, providersFromContainers } from '../src/providers/discovery';
import { parseRedisUrl, parseReply, redactRedisUrl, RedisClient, RedisError } from '../src/storage/redis';
import { RedisTelemetry, samplesOf } from '../src/storage/redisTelemetry';

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

async function cloudProviders() {
  console.log('Cloud providers');
  check('local and private hosts are not remote', ['http://localhost:11434', 'http://127.0.0.1:1234/v1', 'http://192.168.1.5:8000', 'http://10.0.0.2', 'http://gpu-box:8080', 'http://[::1]:1234'].every((u) => !isRemoteUrl(u)));
  check('cloud APIs are remote', ['https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'https://ollama.com'].every(isRemoteUrl));
  process.env.LP_SMOKE_KEY = 'sk-from-env';
  check('${env:NAME} keys are expanded', resolveApiKey({ apiKey: '${env:LP_SMOKE_KEY}' }) === 'sk-from-env' && resolveApiKey({ apiKey: '${env:LP_SMOKE_UNSET}' }) === undefined && resolveApiKey({ apiKey: ' sk-1 ' }) === 'sk-1');

  const conv = toAnthropicMessages([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call:1', name: 'read_file', arguments: '{"path":"a"}' }, { id: 'call_2', name: 'list', arguments: 'oops' }] },
    { role: 'tool', content: 'A', toolCallId: 'call:1' },
    { role: 'tool', content: '', toolCallId: 'call_2' },
    { role: 'user', content: 'go on' },
  ]);
  const blocks = conv.messages[2]?.content as { type: string; tool_use_id?: string; text?: string }[];
  check('anthropic: system lifted, roles alternate, tool results grouped with the next user text', conv.system === 'be brief' && conv.messages.map((m) => m.role).join() === 'user,assistant,user' && blocks.map((b) => b.type).join() === 'tool_result,tool_result,text' && blocks[0].tool_use_id === 'call_1', conv);

  let anthropicHeaders: http.IncomingHttpHeaders = {};
  let anthropicBody: Record<string, unknown> = {};
  const ant = await listen(async (req, res) => {
    anthropicHeaders = req.headers;
    if (req.url?.startsWith('/v1/models')) {
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-x', display_name: 'Claude Sonnet X' }], has_more: false }));
      return;
    }
    anthropicBody = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'text/event-stream');
    const ev = (o: unknown) => res.write(`event: x\ndata: ${JSON.stringify(o)}\n\n`);
    ev({ type: 'message_start', message: { usage: { input_tokens: 12 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading.' } });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } });
    ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
    ev({ type: 'message_stop' });
    res.end();
  });
  try {
    const p = new AnthropicProvider({ id: 'anthropic', type: 'anthropic', baseUrl: `${ant.url}/v1`, apiKey: '${env:LP_SMOKE_KEY}' });
    const models = await p.listModels();
    check('anthropic: models listed with key and version headers', models[0]?.id === 'anthropic/claude-sonnet-x' && models[0].supportsTools && anthropicHeaders['x-api-key'] === 'sk-from-env' && !!anthropicHeaders['anthropic-version'], models);
    const evs = await collect(p.chat({ model: 'claude-sonnet-x', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'read a.ts' }], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }] }));
    const call = evs.find((e) => e.type === 'tool_call');
    check('anthropic: streamed text, tool call and usage', evs.some((e) => e.type === 'text' && e.text === 'Reading.') && call?.type === 'tool_call' && call.call.arguments === '{"path":"a.ts"}' && evs.some((e) => e.type === 'usage' && e.promptTokens === 12 && e.completionTokens === 7), evs);
    check('anthropic: request has system, max_tokens and input_schema tools', anthropicBody.system === 'sys' && typeof anthropicBody.max_tokens === 'number' && (anthropicBody.tools as { input_schema?: unknown }[])[0].input_schema !== undefined, anthropicBody);
  } finally {
    ant.close();
  }

  // An OpenAI reasoning model rejects max_tokens and temperature: the provider renames/drops them and remembers.
  const bodies: Record<string, unknown>[] = [];
  const oai = await listen(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'mistral-large', capabilities: { completion_chat: true, function_calling: true, vision: false } }, { id: 'mistral-embed', capabilities: { completion_chat: false } }] }));
      return;
    }
    const b = JSON.parse(await readBody(req));
    bodies.push(b);
    if ('max_tokens' in b) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }));
      return;
    }
    if ('temperature' in b) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  try {
    const p = new OpenAICompatProvider({ id: 'mistral', type: 'openai', baseUrl: `${oai.url}/v1` });
    const models = await p.listModels();
    check('openai: Mistral-style capability flags parsed, non-chat models dropped', models.length === 1 && models[0].supportsTools && !models[0].supportsVision, models);
    const first = await collect(p.chat({ model: 'o-reasoner', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }));
    const n = bodies.length;
    const second = await collect(p.chat({ model: 'o-reasoner', messages: [{ role: 'user', content: 'again' }], maxTokens: 100 }));
    check('openai: rejected parameters are fixed and retried', first.some((e) => e.type === 'text' && e.text === 'ok') && bodies[n - 1].max_completion_tokens === 100 && !('temperature' in bodies[n - 1]), bodies);
    check('openai: fixes are remembered for the model', second.some((e) => e.type === 'text') && bodies.length === n + 1, bodies.length - n);
  } finally {
    oai.close();
  }

  const mk = (id: string, remote: boolean, tools = true): ModelInfo => ({ id, providerId: id.split('/')[0], modelId: id.split('/')[1], name: id, contextWindow: 128000, maxOutputTokens: 8192, supportsTools: tools, supportsVision: remote, remote: remote || undefined });
  const local = mk('ollama/qwen2.5-coder:7b', false);
  const cloud = mk('openai/gpt-5', true);
  check('routing: Auto prefers a local model over a cloud one', pickForRole([cloud, local], 'agent')?.id === local.id);
  check('routing: a cloud model is used when nothing local is available', pickForRole([cloud], 'agent')?.id === cloud.id);
  // GitHub's macOS runners have 7 GB: the 7B model is "too big" there and the cloud one needs no memory at all.
  const small = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 3, ramGb: 7, vramGb: 0 });
  check('routing: on a 7 GB machine a tight local model (even without tools) still beats the cloud', pickForRole([cloud, local], 'agent', small)?.id === local.id && pickForRole([cloud, mk('local/qwen2.5-coder-7b', false, false)], 'agent', small)?.id === 'local/qwen2.5-coder-7b');
}

/**
 * Cloud providers end to end through the real registry and agent loop: Claude (key from secret storage, thinking replayed
 * in the tool loop, recovery when the API rejects a replayed block), a local cloud gateway (OmniRoute) and a local server.
 */
async function cloudAgentE2E() {
  console.log('\n[Cloud providers end-to-end]');
  const claudeBodies: Record<string, unknown>[] = [];
  const claudeKeys: (string | undefined)[] = [];
  let rejectedReplay = false;
  const srv = await listen(async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/anthropic/')) {
      claudeKeys.push(req.headers['x-api-key'] as string | undefined);
      if (req.headers['x-api-key'] !== 'sk-from-keychain') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      if (url.startsWith('/anthropic/v1/models')) {
        return res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000, max_tokens: 64000 }], has_more: false }));
      }
      const body = JSON.parse(await readBody(req));
      claudeBodies.push(body);
      const msgs = body.messages as { role: string; content: { type: string; signature?: string }[] }[];
      const afterTool = msgs.some((m) => m.content.some((b) => b.type === 'tool_result'));
      const replayed = msgs.some((m) => m.role === 'assistant' && m.content[0]?.type === 'thinking');
      if (afterTool && replayed && !rejectedReplay) {
        // The history was edited since the block was produced: the API rejects it before any output.
        rejectedReplay = true;
        res.statusCode = 400;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }));
      }
      res.setHeader('content-type', 'text/event-stream');
      const ev = (o: { type: string }) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      ev({ type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 2 } } } as never);
      if (!afterTool) {
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } as never);
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should echo first.' } } as never);
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } } as never);
        ev({ type: 'content_block_stop', index: 0 } as never);
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'echo', input: {} } } as never);
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"text":"from claude"}' } } as never);
        ev({ type: 'content_block_stop', index: 1 } as never);
        ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } } as never);
      } else {
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as never);
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude finished after the tool.' } } as never);
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } as never);
      }
      ev({ type: 'message_stop' });
      return res.end();
    }
    const list = url.startsWith('/omni/') ? [{ id: 'auto', owned_by: 'omniroute' }, { id: 'cc/claude-sonnet-4-5' }, { id: 'tts-1' }] : [{ id: 'qwen2.5-coder-7b', capabilities: ['tool_use'] }];
    if (url.endsWith('/v1/models')) {
      return res.end(JSON.stringify({ data: list }));
    }
    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(await readBody(req));
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${url.startsWith('/omni/') ? 'Gateway' : 'Local'} answer from ${body.model}.` }, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404;
    res.end();
  });
  const prevConfig = process.env.LP_CONFIG;
  process.env.LP_CONFIG = JSON.stringify({
    providers: [
      { id: 'local', type: 'openai', baseUrl: `${srv.url}/local/v1` },
      { id: 'omniroute', type: 'openai', baseUrl: `${srv.url}/omni/v1`, cloud: true },
      { id: 'claude', type: 'anthropic', baseUrl: `${srv.url}/anthropic/v1`, apiKey: '${secret:claude}' },
    ],
  });
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
  try {
    setSecretValues({ claude: undefined });
    const providers = new ProviderRegistry(log);
    const before = await providers.listModels(true);
    check('secret key missing: Claude unreachable, others listed', !before.some((m) => m.providerId === 'claude') && before.some((m) => m.providerId === 'omniroute'), before.map((m) => m.id));
    setSecretValues({ claude: 'sk-from-keychain' });
    const models = await providers.listModels();
    const claude = models.find((m) => m.providerId === 'claude');
    check('secret key loaded: providers rebuilt and Claude listed with its 1M context', claude?.contextWindow === 1_000_000 && claude.supportsThinking === true && claudeKeys.at(-1) === 'sk-from-keychain', claude);
    check('gateway marked cloud: its models are remote, speech models hidden', models.filter((m) => m.providerId === 'omniroute').every((m) => m.remote) && !models.some((m) => m.modelId === 'tts-1'));
    check('local server stays local', models.some((m) => m.providerId === 'local') && models.filter((m) => m.providerId === 'local').every((m) => !m.remote));
    check('Claude is cloud even behind a proxy on this machine', !!claude?.remote);
    const auto = await providers.route({ role: 'agent' });
    check('Auto routes to the local model, not Claude or the gateway', auto.model.id === 'local/qwen2.5-coder-7b', { picked: auto.model.id, reason: auto.reason, models: models.map((m) => `${m.id}${m.remote ? ' (remote)' : ''}${m.disabled ? ' (disabled)' : ''}`), providers: providers.all.map((p) => p.id) });

    const tools = new ToolRegistry();
    tools.register({ parallelSafe: true, definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, async execute(args) { return { content: `ECHO:${args.text}` }; } });
    const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
    const session = (model: string): Session => ({ id: `c-${model}`, title: '', createdAt: 0, updatedAt: 0, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] });
    const events: AgentEvent[] = [];
    const s = session('claude/claude-sonnet-4-6');
    const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'echo something' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('Claude agent run: tool executed and final answer returned', out === 'Claude finished after the tool.' && s.messages.some((m) => m.role === 'tool' && m.content === 'ECHO:from claude'), out);
    check('Claude: reasoning streamed to the UI', events.some((e) => e.type === 'thinking' || JSON.stringify(e).includes('I should echo first.')));
    const replay = claudeBodies.find((b) => JSON.stringify(b).includes('sig-1') && JSON.stringify(b).includes('tool_result'));
    check('Claude: thinking block (with signature) replayed before the tool call', !!replay, claudeBodies.length);
    const retried = claudeBodies.at(-1)!;
    check('Claude: rejected replay recovered by resending without thinking blocks', rejectedReplay && !JSON.stringify(retried.messages).includes('"type":"thinking"'));
    check('Claude: no temperature sent; tools and prompt caching sent', claudeBodies.every((b) => !('temperature' in b) && b.cache_control !== undefined) && Array.isArray(claudeBodies[0].tools));

    const g = session('omniroute/auto');
    const gOut = await runner.run({ session: g, userMessage: { role: 'user', content: 'hi' }, emit: () => {}, signal: new AbortController().signal, requestApproval: async () => true });
    check('OmniRoute chosen explicitly: answers through the gateway', gOut === 'Gateway answer from auto.', gOut);
    providers.dispose();
  } finally {
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    setSecretValues({ claude: undefined });
    srv.close();
  }

  // The CLI's presets (src/providers/presets.ts) and the Settings page's (media/settings.js) must stay the same list.
  const webview = nodeFs.readFileSync('media/settings.js', 'utf8');
  const drift = PROVIDER_PRESETS.filter((p) => !webview.includes(`'${p.key}'`) || !webview.includes(`'${p.cfg.baseUrl}'`) || (p.env && !webview.includes(`'${p.env}'`)));
  const webKeys = [...webview.matchAll(/\[\s*'([a-z0-9-]+)',\s*'[^']+',\s*'[^']*',\s*'(?:ollama|openai|anthropic)'/g)].map((m) => m[1]);
  check('CLI and Settings provider presets are the same list', !drift.length && webKeys.every((k) => PROVIDER_PRESETS.some((p) => p.key === k)), { drift: drift.map((p) => p.key), extra: webKeys.filter((k) => !PROVIDER_PRESETS.some((p) => p.key === k)) });
  check('thinking style per Claude model', thinkingStyle('claude-opus-5-5') === 'always' && thinkingStyle('claude-fable-5-1') === 'always' && thinkingStyle('claude-sonnet-4-6') === 'adaptive' && thinkingStyle('claude-haiku-5-5') === 'adaptive' && thinkingStyle('claude-sonnet-4-5') === 'budget' && thinkingStyle('claude-3-7-sonnet-latest') === 'budget' && thinkingStyle('claude-3-5-haiku-latest') === 'none');
  check('local gateways marked cloud count as cloud; URLs decide otherwise', isCloudProvider({ baseUrl: 'http://localhost:20128/v1', cloud: true }) && !isCloudProvider({ baseUrl: 'http://localhost:1234/v1' }) && isCloudProvider({ baseUrl: 'https://api.openai.com/v1' }));
  process.env.LOCALPILOT_KEY_MY_GATEWAY = 'cli-key';
  check('${secret:NAME} falls back to LOCALPILOT_KEY_<NAME> outside VS Code', resolveApiKey({ apiKey: '${secret:my-gateway}' }) === 'cli-key');
}

/** Cloud failure handling and ghost text: retry-after, rejected keys, exhausted quota, fill-in-the-middle through chat. */
async function cloudResilience() {
  console.log('\n[Cloud resilience & ghost text]');
  const h = (o: Record<string, string>) => new Headers(o);
  check('retry-after: seconds, milliseconds and HTTP dates', retryAfter(h({ 'retry-after': '7' })) === 7000 && retryAfter(h({ 'retry-after-ms': '1500' })) === 1500 && Math.abs((retryAfter(h({ 'retry-after': new Date(Date.now() + 3000).toUTCString() })) ?? 0) - 3000) < 1500 && retryAfter(h({})) === undefined);
  const e429 = new HttpError(429, '{"error":{"message":"Rate limit reached"}}', 'x', h({ 'retry-after': '7' }));
  const quota = new HttpError(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', 'x');
  const credit = new HttpError(400, '{"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}', 'x');
  check('classified: rate limit, quota (OpenAI and Anthropic), rejected key', classifyModelError(e429) === 'ratelimit' && classifyModelError(quota) === 'quota' && classifyModelError(credit) === 'quota' && classifyModelError(new HttpError(401, 'invalid x-api-key', 'x')) === 'auth');
  check('rate-limit wait follows retry-after, defaults to 5 s, capped at 60 s', retryDelayMs('ratelimit', e429, 1, [800, 2500]) === 7000 && retryDelayMs('ratelimit', new HttpError(429, '', 'x'), 1, [800, 2500]) === 5000 && retryDelayMs('ratelimit', new HttpError(429, '', 'x', h({ 'retry-after': '600' })), 1, [800]) === 60000 && retryDelayMs('network', e429, 1, [800, 2500]) === 800);
  check('fences stripped from a fill-in-the-middle reply', stripFences('```ts\nreturn a + b;\n```') === 'return a + b;' && stripFences('a + b') === 'a + b');

  let fimBody: { messages?: { content: string }[] } = {};
  let antFim: { messages?: { content: { text?: string }[] }[]; system?: string } = {};
  let rateHits = 0;
  let rateFirstAt = 0;
  let rateSecondAt = 0;
  const srv = await listen(async (req, res) => {
    const url = req.url ?? '';
    if (url.endsWith('/models')) {
      return res.end(JSON.stringify(url.startsWith('/ant') ? { data: [{ id: 'claude-haiku-4-5' }], has_more: false } : { data: [{ id: 'gpt-x', capabilities: ['tool_use'] }] }));
    }
    const b = JSON.parse(await readBody(req));
    if (url.startsWith('/ant')) {
      antFim = b;
      res.setHeader('content-type', 'text/event-stream');
      res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x * 2' } })}\n\n`);
      return res.end(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
    }
    if (url.startsWith('/limited')) {
      rateHits++;
      if (rateHits === 1) {
        rateFirstAt = Date.now();
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
        return res.end('{"error":{"message":"Rate limit reached for requests"}}');
      }
      rateSecondAt = rateSecondAt || Date.now();
    }
    if (url.startsWith('/badkey')) {
      res.statusCode = 401;
      return res.end('{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}');
    }
    if (url.startsWith('/broke')) {
      res.statusCode = 429;
      return res.end('{"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}');
    }
    fimBody = b;
    res.setHeader('content-type', 'text/event-stream');
    const fim = JSON.stringify(b.messages).includes('<CURSOR>');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: fim ? '```js\nreturn a + b;\n```' : 'Recovered after waiting.' }, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  const prevConfig = process.env.LP_CONFIG;
  try {
    const gpt = new OpenAICompatProvider({ id: 'oai', type: 'openai', baseUrl: `${srv.url}/v1`, cloud: true });
    const ins = await gpt.complete({ model: 'gpt-x', prompt: 'function add(a, b) {\n  ', suffix: '\n}', maxTokens: 40 });
    const sent = fimBody.messages?.map((m) => m.content).join('\n') ?? '';
    check('cloud ghost text: code around the cursor sent through chat, insertion returned without fences', ins === 'return a + b;' && sent.includes('function add(a, b) {\n  <CURSOR>\n}'), { ins, sent });
    const claude = new AnthropicProvider({ id: 'ant', type: 'anthropic', baseUrl: `${srv.url}/ant/v1`, apiKey: 'k' });
    const cIns = await completeViaChat(claude, { model: 'claude-haiku-4-5', prompt: 'const y = ', suffix: ';' });
    check('Claude ghost text uses the suffix too', cIns === 'x * 2' && JSON.stringify(antFim.messages).includes('const y = <CURSOR>;') && !!antFim.system, antFim);

    process.env.LP_CONFIG = JSON.stringify({ providers: [
      { id: 'limited', type: 'openai', baseUrl: `${srv.url}/limited/v1`, cloud: true },
      { id: 'badkey', type: 'openai', baseUrl: `${srv.url}/badkey/v1`, cloud: true },
      { id: 'broke', type: 'openai', baseUrl: `${srv.url}/broke/v1`, cloud: true },
    ] });
    const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
    const providers = new ProviderRegistry(log);
    const runner = new AgentRunner(providers, new ToolRegistry(), new SkillManager(log), new WorkspaceContext(log), log);
    const run = async (model: string) => {
      const events: AgentEvent[] = [];
      const s: Session = { id: `r-${model}`, title: '', createdAt: 0, updatedAt: 0, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'ask', attachments: [] };
      const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'hi' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true }).catch((e) => `THREW ${e}`);
      return { out, events, text: JSON.stringify(events) };
    };
    const limited = await run('limited/gpt-x');
    check('429 with retry-after: the agent waits as asked, then succeeds', limited.out === 'Recovered after waiting.' && rateSecondAt - rateFirstAt >= 950 && limited.events.some((e) => e.type === 'retry'), { out: limited.out, waited: rateSecondAt - rateFirstAt });
    const bad = await run('badkey/gpt-x');
    check('rejected key: no retries, a message that says where to set the key', !bad.events.some((e) => e.type === 'retry') && /rejected the API key/.test(bad.text) && /Settings → Providers/.test(bad.text), bad.text.slice(0, 400));
    const broke = await run('broke/gpt-x');
    check('exhausted quota: not retried, says the account is out of credits', !broke.events.some((e) => e.type === 'retry') && /out of credits or quota/.test(broke.text), broke.text.slice(0, 400));
    providers.dispose();
  } finally {
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    srv.close();
  }
}

/** Start colibri: finding it, the commands it gets on each platform, prerequisites, port conflicts, model ranking. */
async function colibriSetupChecks() {
  console.log('\n[colibri setup]');
  const has = (...files: string[]) => (p: string) => files.includes(p);
  const none = () => undefined;
  check('configured folder: a checkout runs c/coli', findColibri({ configured: '/opt/colibri', platform: 'linux', exists: has('/opt/colibri/c/coli'), which: none })?.command === '/opt/colibri/c/coli');
  check('configured folder that is not colibri: not found (no silent fallback)', findColibri({ configured: '/tmp/x', platform: 'linux', exists: has(), which: () => '/usr/local/bin/coli' }) === undefined);
  check('nothing configured: coli on PATH first', findColibri({ platform: 'darwin', exists: has(), which: (n) => (n === 'coli' ? '/usr/local/bin/coli' : undefined) })?.kind === 'path');
  check('then a checkout in ~/colibri', findColibri({ platform: 'linux', exists: has('/home/u/colibri/c/coli'), which: none, home: '/home/u' })?.folder === '/home/u/colibri');
  check('~ in the configured folder is expanded', findColibri({ configured: '~/tools/colibri', platform: 'linux', exists: has('/home/u/tools/colibri/c/coli'), which: none, home: '/home/u' })?.kind === 'checkout');
  check('Windows checkout runs py -3 c\\coli; a release runs coli.cmd', launcherIn('C:\\c', 'win32', has('C:\\c\\c\\coli'))?.command === 'py' && launcherIn('C:\\r', 'win32', has('C:\\r\\coli.cmd'))?.kind === 'release');

  check('setup: never interactive or a browser, configured port', setupArgs({ port: 8011 }).join(' ') === 'setup --yes --no-browser --host 127.0.0.1 --port 8011');
  check('setup: a catalog id is --model, a folder is --model-dir', setupArgs({ model: 'glm-5.2', exists: () => false }).includes('--model') && setupArgs({ model: '/nvme/qwen36', exists: () => true }).join(' ').includes('--model-dir /nvme/qwen36'));
  check('setup: models folder, backend, switch model', setupArgs({ modelsDir: '/big/models', backend: 'vulkan', reconfigure: true }).join(' ').endsWith('--dir /big/models --backend vulkan --reconfigure') && !setupArgs({ backend: 'auto' }).includes('--backend'));
  check('paths with spaces are quoted per shell', coliCommand({ kind: 'checkout', command: '/My Tools/colibri/c/coli', prefix: [] }, ['stop'], 'darwin') === "'/My Tools/colibri/c/coli' stop" && coliCommand({ kind: 'checkout', command: 'py', prefix: ['-3', 'C:\\My Tools\\colibri\\c\\coli'] }, ['stop'], 'win32') === "py -3 'C:\\My Tools\\colibri\\c\\coli' stop");
  const unixInstall = installCommand('/home/u/colibri', ['setup', '--yes'], 'linux');
  const winInstall = installCommand('C:\\Users\\u\\colibri', ['setup', '--yes'], 'win32');
  check('install: shallow clone, then setup from the checkout (bash && / PowerShell $?)', unixInstall === 'git clone --depth 1 https://github.com/JustVugg/colibri /home/u/colibri && /home/u/colibri/c/coli setup --yes' && /^git clone --depth 1 \S+ 'C:\\Users\\u\\colibri'; if \(\$\?\) \{ py -3 'C:\\Users\\u\\colibri\\c\\coli' setup --yes \}$/.test(winInstall), { unixInstall, winInstall });

  const missing = checkPrereqs('linux', (n) => (n === 'git' ? '/usr/bin/git' : undefined));
  check('prerequisites: missing Python is reported with the install command; a compiler is optional', missing.missing.join() === 'Python 3' && /apt install/.test(missing.hint ?? '') && !missing.compiler && checkPrereqs('darwin', (n) => '/bin/' + n).missing.length === 0);
  check('Windows accepts py for Python', checkPrereqs('win32', (n) => (n === 'git' || n === 'py' ? 'x' : undefined)).missing.length === 0);

  const coli = await listen((req, res) => res.end(req.url?.startsWith('/v1/models') ? JSON.stringify({ data: [{ id: 'glm-5.2', owned_by: 'colibri' }] }) : '{}'));
  const vllm = await listen((req, res) => res.end(req.url?.startsWith('/v1/models') ? JSON.stringify({ data: [{ id: 'Qwen/Qwen3-8B', owned_by: 'vllm' }] }) : 'not found'));
  try {
    const port = (u: string) => Number(new URL(u).port);
    check('port probe: colibri, another server (vLLM on 8000), or free', (await probePort(port(coli.url))) === 'colibri' && (await probePort(port(vllm.url))) === 'other' && (await probePort(1)) === 'free');
    const next = await freePort(port(vllm.url));
    check('a free port is found next to a taken one', !!next && next !== port(vllm.url));
  } finally {
    coli.close();
    vllm.close();
  }

  const ranked = modelChoices(36, 300);
  check('models for 36 GB RAM: ones that run from RAM first, then disk-streamed; manual-conversion ones left out', ranked[0].fit === 'ram' && ranked.some((c) => c.fit === 'streams') && !ranked.some((c) => ['olmoe', 'qwen38-27b', 'glm-5.3-flash', 'deepseek-v4.1-flash'].includes(c.spec.name)), ranked.map((c) => `${c.spec.name}:${c.fit}`));
  check('not enough disk is flagged on the model', modelChoices(64, 30).find((c) => c.spec.name === 'glm-5.2')?.enoughDisk === false);
  check('a 1.6 TB model on 16 GB RAM is too big', modelChoices(16, 5000).find((c) => c.spec.name === 'kimi-k3')?.fit === 'too-big');
  check('status progress from colibri JSON of any shape', statusProgress('{"install":{"phase":"downloading","progress":0.42}}') === 'downloading · 42%' && statusProgress('{"state":"running"}') === 'running' && statusProgress('not json') === undefined && statusProgress('{"a":1}') === undefined);
}

/**
 * OmniRoute end to end against a faithful mock of its API: /v1/models is never key-gated and lists its `auto` routes
 * first, then provider models once a provider is connected; chat needs `Bearer <key>` with REQUIRE_API_KEY, and with
 * no provider connected it fails with a no-route error. Driven through LocalPilot's real provider and agent loop.
 */
async function gatewayChecks() {
  console.log('\n[gateways: OmniRoute / LiteLLM]');
  check('start: OmniRoute on its port, no browser, no prompts; LiteLLM on 127.0.0.1 with its config', gatewayStart('omniroute', { port: 20128, exe: '/usr/local/bin/omniroute', platform: 'darwin' }) === '/usr/local/bin/omniroute --port 20128 --no-open --non-interactive' && gatewayStart('litellm', { port: 4000, exe: '/u/bin/litellm', config: '/cfg/proxy config.yaml', platform: 'linux' }) === "/u/bin/litellm --host 127.0.0.1 --port 4000 --config '/cfg/proxy config.yaml'");
  check('OmniRoute is bound to 127.0.0.1 (its default is every interface)', gatewayEnv('omniroute').OMNIROUTE_SERVER_HOST === '127.0.0.1');
  check('install commands: npm for OmniRoute, pip for LiteLLM', gatewayInstall('omniroute') === 'npm install -g omniroute' && /pip install --user 'litellm\[proxy\]'/.test(gatewayInstall('litellm', 'linux')));
  check("Node versions OmniRoute accepts (>=22.22.2 <23, 24-26)", nodeVersionOk('v24.21.0') && nodeVersionOk('v22.22.2') && !nodeVersionOk('v22.21.9') && !nodeVersionOk('v20.18.0') && !nodeVersionOk('v27.0.0'));
  check('prerequisites: missing Node, old Node, missing Python', !checkGatewayPrereqs('omniroute', () => undefined).ok && /too old/.test(checkGatewayPrereqs('omniroute', (n) => n, 'v20.1.0').problem ?? '') && checkGatewayPrereqs('omniroute', (n) => n, 'v24.1.0').ok && !checkGatewayPrereqs('litellm', () => undefined, undefined, 'linux').ok);
  const split = classifyGatewayModels(['auto', 'auto/coding', 'auto/fast', 'openai/gpt-5.4', 'glm/glm-5.2']);
  check('model list split into gateway routes and provider models', split.routes.length === 3 && split.models.join() === 'openai/gpt-5.4,glm/glm-5.2' && !needsProviders(split) && needsProviders(classifyGatewayModels(['auto', 'auto/coding'])));

  const state = { providers: false, requireKey: false, chats: 0 };
  const omni = await listen(async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/monitoring/health')) {
      return res.end(JSON.stringify({ status: 'healthy' }));
    }
    if (url.startsWith('/v1/models')) {
      const routes = ['auto', 'auto/coding', 'auto/fast'].map((id) => ({ id, object: 'model', owned_by: 'omniroute' }));
      const models = state.providers ? [{ id: 'openai/gpt-5.4', object: 'model', owned_by: 'openai' }, { id: 'glm/glm-5.2', object: 'model', owned_by: 'glm' }] : [];
      return res.end(JSON.stringify({ object: 'list', data: [...routes, ...models] }));
    }
    if (url.startsWith('/v1/chat/completions')) {
      state.chats++;
      const body = JSON.parse(await readBody(req));
      if (state.requireKey && req.headers.authorization !== 'Bearer sk-omni-local') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'Invalid or missing API key', type: 'invalid_request_error' } }));
      }
      if (!state.providers) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { message: `No eligible route for model ${body.model}: no providers connected` } }));
      }
      const sawTool = JSON.stringify(body.messages).includes('ECHO:');
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (!sawTool && Array.isArray(body.tools) && body.tools.length) {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_gw1', function: { name: 'echo', arguments: '{"text":"via omniroute"}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ delta: { content: `OmniRoute (${body.model}) answered.` } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      }
      return res.end('data: [DONE]\n\n');
    }
    res.statusCode = 404;
    res.end();
  });
  const port = Number(new URL(omni.url).port);
  const prevConfig = process.env.LP_CONFIG;
  const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
  try {
    const fresh = await gatewayModels(port);
    check('fresh OmniRoute: up, but only its auto routes, so it needs a provider', !!fresh && needsProviders(fresh) && fresh.routes.includes('auto/coding'), fresh);

    const setup = (apiKey?: string) => {
      process.env.LP_CONFIG = JSON.stringify({ providers: [{ id: 'local', type: 'openai', baseUrl: `${omni.url}/nope/v1` }, { id: 'omniroute', type: 'openai', baseUrl: `${omni.url}/v1`, cloud: true, ...(apiKey ? { apiKey } : {}) }] });
      const providers = new ProviderRegistry(log);
      const tools = new ToolRegistry();
      tools.register({ parallelSafe: true, definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, async execute(args) { return { content: `ECHO:${args.text}` }; } });
      return { providers, runner: new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log) };
    };
    const run = async (runner: AgentRunner, model: string) => {
      const events: AgentEvent[] = [];
      const sess: Session = { id: `gw-${Math.random()}`, title: '', createdAt: 0, updatedAt: 0, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] };
      const out = await runner.run({ session: sess, userMessage: { role: 'user', content: 'echo something' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true }).catch((e) => `THREW ${e}`);
      return { out, events, text: JSON.stringify(events), sess };
    };

    let { providers, runner } = setup();
    let models = await providers.listModels(true);
    check('LocalPilot lists the gateway routes as cloud models', models.filter((m) => m.providerId === 'omniroute').map((m) => m.modelId).join() === 'auto,auto/coding,auto/fast' && models.filter((m) => m.providerId === 'omniroute').every((m) => m.remote), models.map((m) => m.id));
    const noRoute = await run(runner, 'omniroute/auto');
    check('no provider connected: a clear message, no retries', /no provider it can send this request to/.test(noRoute.text) && /dashboard/.test(noRoute.text) && !noRoute.events.some((e) => e.type === 'retry') && state.chats === 1, noRoute.text.slice(0, 300));
    providers.dispose();

    state.providers = true;
    ({ providers, runner } = setup());
    models = await providers.listModels(true);
    check('provider connected: its models appear next to the routes', models.some((m) => m.id === 'omniroute/openai/gpt-5.4') && models.some((m) => m.id === 'omniroute/glm/glm-5.2'));
    const auto = await run(runner, 'omniroute/auto/coding');
    check('agent run through the gateway: tool call executed, answer streamed', auto.out === 'OmniRoute (auto/coding) answered.' && auto.sess.messages.some((m) => m.role === 'tool' && m.content === 'ECHO:via omniroute'), auto.out);
    const direct = await run(runner, 'omniroute/openai/gpt-5.4');
    check('a provider-prefixed model id passes through unchanged', direct.out === 'OmniRoute (openai/gpt-5.4) answered.', direct.out);
    providers.dispose();

    state.requireKey = true;
    ({ providers, runner } = setup());
    const locked = await run(runner, 'omniroute/auto');
    check('REQUIRE_API_KEY without a key: models still list, chat says the key was rejected', (await providers.listModels(true)).some((m) => m.providerId === 'omniroute') && /rejected the API key/.test(locked.text), locked.text.slice(0, 300));
    providers.dispose();
    ({ providers, runner } = setup('sk-omni-local'));
    const keyed = await run(runner, 'omniroute/auto');
    check('with its key, the gateway answers', keyed.out === 'OmniRoute (auto) answered.', keyed.out);
    providers.dispose();
  } finally {
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    omni.close();
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
  const defs = [
    { name: 'run_todos_parallel', description: '', parameters: { type: 'object', properties: { ids: {}, tasks: {} } } },
    { name: 'run_parallel_subagents', description: '', parameters: { type: 'object', properties: { tasks: {} }, required: ['tasks'] } },
    { name: 'write_file', description: '', parameters: { type: 'object', properties: { path: {}, content: {} }, required: ['path', 'content'] } },
    { name: 'read_file', description: '', parameters: { type: 'object', properties: { path: {}, start_line: {}, end_line: {} }, required: ['path'] } },
  ];
  const argsOnly = extractTextToolCalls('Delegating.\n```json\n{"tasks": [{"agent": "coder", "prompt": "make alpha.txt"}]}\n```', undefined, defs);
  check('argument-only JSON fence resolves to the tool whose required parameters it satisfies', argsOnly.calls.length === 1 && argsOnly.calls[0].name === 'run_parallel_subagents' && JSON.parse(argsOnly.calls[0].arguments).tasks.length === 1 && argsOnly.remainder === 'Delegating.', argsOnly);
  const wf = extractTextToolCalls('```json\n{"path": "a.txt", "content": "hi"}\n```', undefined, defs);
  check('argument-only fence with path+content is a write_file call', wf.calls.length === 1 && wf.calls[0].name === 'write_file');
  check('argument-only fence with unknown keys stays prose', extractTextToolCalls('```json\n{"foo": 1}\n```', undefined, defs).calls.length === 0);

  console.log('\n[Task suggestions]');
  const facts = { projectMap: 'src/ (12 files)\n  tests/ (3 files)\npackage.json tsconfig.json', gitSummary: '## main\n M src/a.ts\n?? src/b.ts', errors: { count: 3, files: 2, sample: 'src/a.ts' }, todos: 7, recent: ['Add a dark mode to the settings page'] };
  const quick = quickSuggestions(facts);
  check('quick suggestions lead with the concrete problems (errors, uncommitted changes)', quick[0].title.startsWith('Fix the 3 errors') && quick.some((s) => /uncommitted changes/.test(s.title)) && quick.some((s) => /7 TODO/.test(s.title)), quick.map((s) => s.title));
  check('quick suggestions know the project has tests and dependencies and remember recent prompts', quick.some((s) => /Run the test suite/.test(s.title)) && quick.some((s) => /dependencies/.test(s.title)) && quick.some((s) => s.title === 'Add a dark mode to the settings page') && !quick.some((s) => /README/.test(s.title)) === false, quick.map((s) => s.title));
  const noTests = quickSuggestions({ ...facts, projectMap: 'src/ (3 files)\nREADME.md', errors: { count: 0, files: 0 }, todos: 0, gitSummary: '' });
  check('without tests or problems the ideas shift to adding tests, and README is not suggested when one exists', noTests.some((s) => /Add tests/.test(s.title)) && !noTests.some((s) => /README/.test(s.title)) && !noTests.some((s) => /Fix the/.test(s.title)), noTests.map((s) => s.title));
  const parsed = parseModelSuggestions('Here you go:\n[{"title":"Let players save a game.","detail":"Adds a save file","kind":"feature"},{"title":"x","kind":"fix"},{"title":"Stop the crash on empty input","kind":"bogus"}]');
  check('model suggestions are parsed leniently, trimmed, deduplicated and given a valid kind', parsed.length === 2 && parsed[0].title === 'Let players save a game' && parsed[1].kind === 'feature', parsed);
  check('autocomplete: finished words must match whole words, the current word a word prefix', completeTask('write a re', quick, []).every((t) => /^Write a README/.test(t)) && completeTask('write a re', quick, []).length === 1 && completeTask('fix', quick, []).some((t) => /^Fix the 3 errors/.test(t)) && completeTask('zz', quick, ['zz top']).join() === 'zz top', completeTask('write a re', quick, []));

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
  check('"Delegated to N background workers" without a call is a claimed change', claimsChange("Understood as: create two files.\n\nDelegated to 2 background workers. I'll report back when they finish.", 'create two files with background workers'));
  check('"I\'ll delegate this to workers" is an unfulfilled intent', looksLikeUnfulfilledIntent("Understood as: create two files.\n\nI'll delegate this task to background workers.", tools));
  check('a question is not a claimed change', !claimsChange("I've found the bug in add(). Should I fix it?", 'fix the bug'));
  check('re-announcing a finished hand-off is a stale delegation', looksLikeStaleDelegation("Delegated to 3 background workers. I'll report back when they finish."));
  check('a real report after the workers ran is not stale', !looksLikeStaleDelegation('Both files were created by the workers; alpha-worker.txt contains "alpha".'));
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
  const onlySummary = await cm.compact([c.messages[0], { role: 'user', content: 'next' }, { role: 'assistant', content: 'ok' }], fake, model, undefined, 2);
  check('compact: nothing but a prior summary to fold → no model call, history unchanged', onlySummary.removed === 0);

  console.log('\n[Token calibration: real counts correct the estimate]');
  {
    const cal = new TokenCalibration();
    check('unknown model: estimate used as is', cal.scale('m') === 1);
    // Measured on Gemma 4: 18k chars of code were 8,695 real tokens against an estimate of 6,088.
    check('a plausible server count is recorded', cal.record('m', 6088, 8695) && Math.abs(cal.scale('m') - 8695 / 6088) < 1e-9);
    check('later samples blend in, the latest weighing most', cal.record('m', 1000, 1200) && Math.abs(cal.scale('m') - ((8695 / 6088) * 0.3 + 1.2 * 0.7)) < 1e-9);
    check('implausible counts (only the uncached part, tiny prompts, none) are ignored', !cal.record('m', 10000, 900) && !cal.record('m', 100, 300) && !cal.record('m', 5000, undefined) && Math.abs(cal.scale('m') - ((8695 / 6088) * 0.3 + 1.2 * 0.7)) < 1e-9);
    check('models are calibrated separately', cal.scale('other') === 1);
    const scaled = new ContextManager({ compactionThreshold: 0.75, maxToolOutputChars: 1000, scale: () => 1.5 });
    const plain = cm.budget(model, 'sys', [], history.slice(0, 6), 1024);
    const real = scaled.budget(model, 'sys', [], history.slice(0, 6), 1024);
    check('budget is in real tokens: scaled by the calibration, raw estimate kept for the next sample', Math.abs(real.historyTokens - plain.historyTokens * 1.5) <= 1 && real.rawPromptTokens === plain.rawPromptTokens && real.usageRatio > plain.usageRatio * 1.45, { plain: plain.historyTokens, real: real.historyTokens });
  }

  console.log('\n["Remember …" goes to the built-in memory, not to a skill]');
  check('remember / memorise / keep in mind / forget / in project memory are memory requests', ['Remember that tests run with make check-all', 'please memorize my preferred style', "Don't forget: no type hints", 'Keep in mind the API is v2', 'forget that rule about tabs', 'save this to project memory'].every(asksToRemember));
  check('ordinary requests are not', !['Write tests for utils', 'Fix the memory leak in the cache', 'Add a remember-me checkbox to the login form', 'Store sessions in memory instead of Redis'].some(asksToRemember));

  console.log('\n[Manual compaction never loses history]');
  {
    const broken = { ...fake, chat: async function* (): AsyncGenerator<StreamEvent> { throw new Error('connection refused'); } };
    let threw = '';
    try { await cm.compact(history, broken, model, undefined, 6, false); } catch (e) { threw = String(e); }
    check('a failed summary throws instead of truncating when asked to', /connection refused/.test(threw));
    const mid = await cm.compact(history, broken, model, undefined, 6);
    check('mid-run, a failed summary still falls back to a truncation note so the run goes on', mid.removed > 0 && /truncated/.test(mid.summary));
    const empty = { ...fake, chat: async function* (): AsyncGenerator<StreamEvent> { yield { type: 'text', text: '  ' } as StreamEvent; } };
    let emptyThrew = false;
    try { await cm.compact(history, empty, model, undefined, 6, false); } catch { emptyThrew = true; }
    check('an empty summary counts as a failure, not as a summary', emptyThrew);
  }

  console.log('\n[Repository graph: imports, impact, cycles, symbols]');
  {
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-graph-'));
    const put = (rel: string, text: string) => { nodeFs.mkdirSync(nodePath.dirname(nodePath.join(root, rel)), { recursive: true }); nodeFs.writeFileSync(nodePath.join(root, rel), text); };
    put('tsconfig.json', '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }, }');
    put('src/util.ts', "export function add(a: number, b: number) { return a + b; }\nexport const PI = 3.14;\n");
    put('src/math/index.ts', "import { add } from '../util';\nexport class Calc { sum = add; }\n");
    put('src/app.ts', "import { Calc } from './math';\nimport type { X } from '@/types';\nimport express from 'express';\nimport { join } from 'node:path';\nconst lazy = () => import('./a.js');\n");
    put('src/types.ts', "export interface X { a: number }\n");
    put('src/a.ts', "import { b } from './b';\nexport const a = 1;\n");
    put('src/b.ts', "import { a } from './a';\nexport const b = 2;\n");
    put('test/app.test.ts', "import '../src/app';\nimport { describe } from 'vitest';\n");
    put('py/pkg/__init__.py', '');
    put('py/pkg/core.py', 'import os\nfrom .helpers import fmt\n\ndef run():\n    return fmt()\n');
    put('py/pkg/helpers.py', 'def fmt():\n    return "x"\n');
    put('go.mod', 'module example.com/demo\n\ngo 1.22\n');
    put('cmd/main.go', 'package main\n\nimport (\n\t"fmt"\n\t"example.com/demo/internal/store"\n)\n\nfunc main() { fmt.Println(store.Get()) }\n');
    put('internal/store/store.go', 'package store\n\nfunc Get() string { return "" }\n');
    put('src/lib.rs', 'mod db;\nuse crate::db::Conn;\n');
    put('src/db.rs', 'pub struct Conn;\n');
    const g = await buildRepoGraph(root, 0);
    const deps = (f: string) => [...(g.deps.get(f) ?? [])].sort().join(',');
    check('TS: relative, folder index, tsconfig paths, ./x.js → x.ts and dynamic import resolve', deps('src/app.ts') === 'src/a.ts,src/math/index.ts,src/types.ts' && deps('src/math/index.ts') === 'src/util.ts', deps('src/app.ts'));
    check('TS: packages are external, scoped/node: prefixes normalised', g.external.has('express') && g.external.has('path') && g.external.get('vitest')?.has('test/app.test.ts') === true);
    check('Python: relative "from .x import" resolves; stdlib is external', deps('py/pkg/core.py') === 'py/pkg/helpers.py' && g.external.has('os'));
    check('Go: module-local package imports resolve through go.mod', deps('cmd/main.go') === 'internal/store/store.go' && g.external.has('fmt'));
    check('Rust: mod and use crate:: resolve', deps('src/lib.rs') === 'src/db.rs');
    check('impact is transitive and names the tests to run', /can affect 3 files/.test(answerRepoGraph(g, 'impact', 'src/util.ts').content) && /Tests to run \(1\):\ntest\/app\.test\.ts/.test(answerRepoGraph(g, 'impact', 'src/util.ts').content), answerRepoGraph(g, 'impact', 'src/util.ts').content);
    check('cycles: a ↔ b found', findCycles(g).some((c) => c.join() === 'src/a.ts,src/b.ts'));
    check('symbol index across languages', g.symbols.get('Calc')?.[0].file === 'src/math/index.ts' && g.symbols.get('run')?.[0].file === 'py/pkg/core.py' && g.symbols.get('Get')?.[0].kind === 'function' && g.symbols.get('Conn')?.[0].kind === 'struct');
    check('a bare file name resolves when unique; ambiguity lists candidates', /util\.ts/.test(answerRepoGraph(g, 'dependents', 'util.ts').content) && answerRepoGraph(g, 'dependents', 'index').isError !== true);
    nodeFs.writeFileSync(nodePath.join(root, 'src/types.ts'), "import { add } from './util';\nexport interface X { a: number }\n");
    nodeFs.utimesSync(nodePath.join(root, 'src/types.ts'), new Date(), new Date(Date.now() + 5000));
    const g2 = await buildRepoGraph(root, 0);
    check('incremental: a changed file is re-parsed', g2.deps.get('src/types.ts')?.has('src/util.ts') === true);
    check('parser survives broken syntax', parseSource('import { from "x"\nexport function ok( {', 'ts').symbols[0]?.name === 'ok');
    nodeFs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n[Organization policy (managed-settings.json)]');
  {
    check('system locations per platform; env override wins', managedPolicyPath('darwin', {}) === '/Library/Application Support/LocalPilot/managed-settings.json' && managedPolicyPath('linux', {}) === '/etc/localpilot/managed-settings.json' && /ProgramData[\\/]LocalPilot[\\/]managed-settings\.json$/.test(managedPolicyPath('win32', { ProgramData: 'C:\\ProgramData' })) && managedPolicyPath('linux', { LOCALPILOT_MANAGED_SETTINGS: '/x.json' }) === '/x.json');
    const p = normalizePolicy({ permissions: { deny: ['Bash(curl:*)', 'Read(.env)'], ask: ['Bash(git push:*)'] }, approvals: { terminal: 'ask', delete: 'never', write: 'bogus' }, disableBypassPermissions: true, allowCloudProviders: false, allowedProviderHosts: ['localhost', '127.0.0.1', '*.corp.example'], allowWebAccess: false, allowedMcpServers: ['github'], allowSkillInstall: false, auditLog: '~/audit.jsonl', message: 'ask IT' }, '/etc/localpilot/managed-settings.json');
    check('deny rules block regardless of project settings', policyVerdict(p, 'run_command', { command: 'curl https://x' }).decision === 'deny' && policyVerdict(p, 'read_file', { path: '.env' }, '/w').decision === 'deny');
    check('ask rules force a prompt; other calls are left to the project', policyVerdict(p, 'run_command', { command: 'git push origin main' }).decision === 'ask' && policyVerdict(p, 'run_command', { command: 'npm test' }).decision === 'none');
    check('approval floor: "always" becomes "ask", "never" refuses, unknown values ignored', flooredApproval(p, 'terminal', 'always') === 'ask' && flooredApproval(p, 'delete', 'always') === 'never' && flooredApproval(p, 'write', 'always') === 'always');
    check('providers: cloud off, host allowlist with wildcards', !providerAllowed(p, 'https://api.openai.com/v1', true).ok && providerAllowed(p, 'http://localhost:11434', false).ok && providerAllowed(p, 'http://gpu1.corp.example:8000/v1', false).ok && !providerAllowed(p, 'http://10.0.0.5:8000', false).ok);
    check('web tools removed, MCP allowlist', !toolAllowed(p, 'web_fetch') && !toolAllowed(p, 'browser_inspect') && toolAllowed(p, 'read_file') && mcpServerAllowed(p, 'github') && !mcpServerAllowed(p, 'filesystem'));
    check('no policy deployed: nothing is restricted', policyVerdict(normalizePolicy({}), 'run_command', { command: 'curl x' }).decision === 'none' && providerAllowed(normalizePolicy({}), 'https://api.openai.com', true).ok && describePolicy(normalizePolicy({})).length === 0);
    check('described for /permissions and doctor', describePolicy(p).length === 10 && describePolicy(p).some((l) => /Cloud providers are off/.test(l)));
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-policy-'));
    const file = nodePath.join(dir, 'managed-settings.json');
    const prev = process.env.LOCALPILOT_MANAGED_SETTINGS;
    process.env.LOCALPILOT_MANAGED_SETTINGS = file;
    resetManagedPolicyCache();
    nodeFs.writeFileSync(file, '{ "allowWebAccess": false, }');
    check('loaded from the deployed file (JSONC)', getManagedPolicy().source === file && getManagedPolicy().allowWebAccess === false);
    nodeFs.writeFileSync(file, '{ not json');
    nodeFs.utimesSync(file, new Date(), new Date(Date.now() + 10_000));
    resetManagedPolicyCache();
    const broken = getManagedPolicy();
    check('an unreadable policy fails closed (cloud, web and downloads off), never open', broken.source === file && !broken.allowCloudProviders && !broken.allowWebAccess && !broken.allowSkillInstall);
    process.env.LOCALPILOT_MANAGED_SETTINGS = prev;
    resetManagedPolicyCache();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n[Source control: git, pull requests, CI]');
  {
    check('branch names: options and traversal refused', validBranch('fix/greeting') && validBranch('feat/a.b_c-1') && !validBranch('--force') && !validBranch('a..b') && !validBranch('x y') && !validBranch('main.lock') && !validBranch('a/'));
    const pr = formatPr({ number: 7, title: 'Fix greeting', state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/7', headRefName: 'fix/greeting', baseRefName: 'main', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ workflowName: 'CI', name: 'test (macos)', conclusion: 'FAILURE' }, { workflowName: 'CI', name: 'test (linux)', conclusion: 'SUCCESS' }, { name: 'lint', status: 'IN_PROGRESS' }], reviews: [{ author: { login: 'ana' }, state: 'CHANGES_REQUESTED', body: 'Please add a test' }] });
    check('PR summary: failed checks first, review asks, next step', /1 passed, 1 failed, 1 pending/.test(pr) && /✖ CI \/ test \(macos\) \(failure\)/.test(pr) && /changes requested/.test(pr) && /ana \(changes_requested\): Please add a test/.test(pr) && /ci_status action "logs"/.test(pr), pr);
    const log = ['build\tRun tests\t2026-11-02T07:21:47.5Z   ✔ summary: provider health with last state and error', 'build\tRun tests\t2026-11-02T07:21:48.8Z   ✖ Auto routes to the local model', 'build\tRun tests\t2026-11-02T07:21:48.9Z   picked: claude', 'build\tRun tests\t2026-11-02T07:21:55.7Z 1 check(s) FAILED', 'build\tRun tests\t2026-11-02T07:21:55.8Z ##[error]Process completed with exit code 1.'].join('\n');
    const sum = summarizeFailedLog(log);
    check('CI log summary keeps the failure and its context, not passing lines that say "error"', /✖ Auto routes/.test(sum) && /##\[error\]/.test(sum) && /^## build › Run tests/m.test(sum) && !/2026-11-02T/.test(sum), sum);
    const cmds = builtinCommands();
    check('built-in /pr and /fix-ci commands', cmds.some((c) => c.invoke === '/pr' && /pull_request "create"/.test(c.body)) && cmds.some((c) => c.invoke === '/fix-ci' && /ci_status "logs"/.test(c.body)) && cmds.every((c) => c.source === 'builtin'));
    if ((await runCmd('git', ['--version'], undefined)).code === 0) {
      const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-git-'));
      const ws = nodePath.join(base, 'ws');
      const remote = nodePath.join(base, 'remote.git');
      const g = (args: string[], cwd = ws) => runCmd('git', args, cwd);
      await runCmd('git', ['init', '-q', '--bare', '-b', 'main', remote], base);
      await runCmd('git', ['init', '-q', '-b', 'main', ws], base);
      await g(['config', 'user.email', 't@example.com']);
      await g(['config', 'user.name', 'Tester']);
      nodeFs.writeFileSync(nodePath.join(ws, 'a.txt'), 'one\n');
      await g(['add', '.']);
      await g(['commit', '-qm', 'init']);
      await g(['remote', 'add', 'origin', remote]);
      await g(['push', '-q', '-u', 'origin', 'main']);
      nodeFs.writeFileSync(nodePath.join(ws, 'a.txt'), 'two\n');
      const asked: string[] = [];
      const tctx = { sessionId: 's', workspaceRoot: ws, signal: new AbortController().signal, requestApproval: async (t: string) => { asked.push(t); return true; }, progress() {}, trackChange: async () => {}, depth: 0 } as unknown as import('../src/types').ToolContext;
      const st = await gitStatusTool.execute({ action: 'status' }, tctx);
      check('git_status: branch, default branch and changed files', /Branch: main/.test(st.content) && /default branch: main/.test(st.content) && /M a\.txt/.test(st.content), st.content);
      const onMain = await gitPushTool.execute({}, tctx);
      check('git_push refuses the default branch unless asked', !!onMain.isError && /default branch/.test(onMain.content));
      const c = await gitCommitTool.execute({ message: 'fix: two instead of one\n\nBecause.', branch: 'fix/two' }, tctx);
      const msg = (await g(['log', '-1', '--pretty=%B'])).out;
      check('git_commit: new branch, staged, message passed verbatim (no shell)', !c.isError && /on fix\/two/.test(c.content) && msg.trim() === 'fix: two instead of one\n\nBecause.' && asked.some((t) => /Commit on new branch fix\/two/.test(t)), c.content);
      const pushed = await gitPushTool.execute({}, tctx);
      check('git_push: the branch reaches the remote with its upstream set', !pushed.isError && (await runCmd('git', ['branch', '--list', 'fix/two'], remote)).out.includes('fix/two') && /origin\/fix\/two/.test((await g(['status', '-sb'])).out), pushed.content);
      const bad = await gitCommitTool.execute({ message: 'x', branch: '--orphan' }, tctx);
      check('git_commit refuses an option-looking branch name', !!bad.isError);
      nodeFs.rmSync(base, { recursive: true, force: true });
    }
  }

  console.log('\n[Benchmark: every task fails as shipped and passes with a reference solution]');
  {
    const solutions: Record<string, Record<string, string> | string> = {
      'py-off-by-one': { 'pager.py': 'def page(items, n, size):\n    start = (n - 1) * size\n    return items[start:start + size]\n' },
      'js-implement-slugify': { 'slug.js': "function slugify(t) { return t.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }\nmodule.exports = { slugify };\n" },
      'py-rename-across-files': { 'geo/calc.py': 'import math\n\n\ndef euclidean_distance(a, b):\n    return math.hypot(a[0] - b[0], a[1] - b[1])\n', 'geo/route.py': 'from geo.calc import euclidean_distance\n\n\ndef length(points):\n    return sum(euclidean_distance(p, q) for p, q in zip(points, points[1:]))\n', 'main.py': 'from geo.calc import euclidean_distance\nfrom geo.route import length\n\nprint(round(euclidean_distance((0, 0), (3, 4)), 1), round(length([(0, 0), (3, 4), (3, 0)]), 1))\n' },
      'js-signature-change': { 'src/money.js': "function format(cents, currency = 'USD') { return (currency === 'EUR' ? '€' : '$') + (cents / 100).toFixed(2); }\nmodule.exports = { format };\n", 'src/cart.js': "const { format } = require('./money');\nexports.total = (items, currency) => format(items.reduce((s, i) => s + i.cents, 0), currency);\n", 'src/receipt.js': "const { format } = require('./money');\nexports.line = (name, cents, currency) => `${name}: ${format(cents, currency)}`;\n" },
      'json-config-edit': { 'config.json': '{"server":{"port":9090,"host":"0.0.0.0"},"features":{"beta":true,"search":true},"retries":3,"timeoutMs":5000}' },
      'js-async-bug': { 'store.js': "const db = new Map();\nexports.save = async (k, v) => { await new Promise((r) => setTimeout(r, 5)); db.set(k, v); };\nexports.load = async (k) => db.get(k);\nexports.saveAll = async (pairs) => { for (const [k, v] of pairs) { await exports.save(k, v); } };\n" },
      'ask-where-defined': 'The check is in app/payments.py (charge raises ValueError).',
      'ask-impact': 'lib/trip.ts imports it directly, and app/summary.ts depends on it through trip.ts.',
    };
    check('every built-in task has a reference solution', BUILTIN_SUITE.tasks.every((t) => solutions[t.id] !== undefined), BUILTIN_SUITE.tasks.map((t) => t.id).filter((id) => !solutions[id]));
    const runnable = async (t: typeof BUILTIN_SUITE.tasks[number]) => !(t.needs ?? []).length || (await Promise.all((t.needs ?? []).map(async (n) => (await runCmd(n === 'python3' ? (process.platform === 'win32' ? 'python' : 'python3') : n, ['--version'], undefined)).code === 0))).every(Boolean);
    let failsAsShipped = 0;
    let passesSolved = 0;
    let ran = 0;
    const bad: string[] = [];
    for (const t of BUILTIN_SUITE.tasks) {
      if (!(await runnable(t))) {
        continue;
      }
      ran++;
      const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `lp-evalchk-${t.id}-`));
      const put = (files: Record<string, string>) => Object.entries(files).forEach(([rel, text]) => { nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dir, rel)), { recursive: true }); nodeFs.writeFileSync(nodePath.join(dir, rel), text); });
      put(t.files);
      const sol = solutions[t.id];
      if (await verifyTask(t, dir, '')) {
        failsAsShipped++;
      } else {
        bad.push(`${t.id} passes untouched`);
      }
      if (typeof sol === 'object') {
        put(sol);
      }
      const why = await verifyTask(t, dir, typeof sol === 'string' ? sol : 'done');
      if (!why) {
        passesSolved++;
      } else {
        bad.push(`${t.id}: ${why}`);
      }
      nodeFs.rmSync(dir, { recursive: true, force: true });
    }
    check(`all ${ran} runnable tasks fail as shipped and pass when solved`, ran > 0 && failsAsShipped === ran && passesSolved === ran, bad);
    check('ask tasks reject a wrong answer', !!checkStatic(BUILTIN_SUITE.tasks.find((t) => t.id === 'ask-impact')!, () => undefined, 'lib/trip.ts, app/summary.ts and app/other.ts'));
    const results = [
      { task: 'a', category: 'fix' as const, model: 'm1', pass: true, durationMs: 20_000, steps: 3, toolCalls: 4, toolErrors: 0, promptTokens: 1000, completionTokens: 100 },
      { task: 'b', category: 'fix' as const, model: 'm1', pass: false, reason: 'tests failed', durationMs: 40_000, steps: 6, toolCalls: 8, toolErrors: 2, promptTokens: 3000, completionTokens: 300 },
      { task: 'a', category: 'fix' as const, model: 'm2', pass: true, durationMs: 10_000, steps: 2, toolCalls: 2, toolErrors: 0, promptTokens: 500, completionTokens: 50 },
      { task: 'b', category: 'fix' as const, model: 'm2', pass: false, skipped: 'node is not installed', durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0 },
    ];
    const sums = summarizeEval(results);
    check('summary: pass rate first, skipped tasks not counted, tool error rate', sums[0].model === 'm2' && sums[0].total === 1 && sums[0].skipped === 1 && sums[1].passed === 1 && sums[1].total === 2 && Math.abs(sums[1].toolErrorRate - 2 / 12) < 1e-9 && sums[1].tokens === 4400);
    const rep = formatReport({ suite: 's', startedAt: '2026-11-02T10:00:00Z', host: 'h', results }, new Map([['m1', { suite: 's', startedAt: '2026-11-01T10:00:00Z', host: 'h', results: [{ ...results[0], pass: false, reason: 'x' }, results[1]] }]]));
    check('report: summary table with change since the last run, task matrix, failure reasons', /\| m1 \| 1\/2 \(50% \(\+50\)\)/.test(rep) && /\| a \| ✔ 10 s \| ✔ 20 s \|/.test(rep) && /- b · m1: tests failed/.test(rep) && /skipped/.test(rep), rep);
  }

  console.log('\n[Remote MCP: Streamable HTTP, SSE, sessions, auth, fallback]');
  {
    check('transport inferred from command / url / type', transportKind({ command: 'npx' }) === 'stdio' && transportKind({ url: 'https://x/mcp' }) === 'http' && transportKind({ url: 'https://x/sse' }) === 'sse' && transportKind({ url: 'https://x/mcp', type: 'sse' }) === 'sse' && transportKind({ url: 'https://x', type: 'streamable-http' }) === 'http' && transportKind({}) === undefined);
    const evs: { event: string; data: string }[] = [];
    const sp = new SseParser();
    sp.push('event: endpoint\r\ndata: /m?s=1\r\n\r\n: comment\n\ndata: {"a":', (e) => evs.push(e));
    sp.push('1}\ndata: 2\n\n', (e) => evs.push(e));
    check('SSE parser: CRLF, comments, events split across chunks, multi-line data', evs.length === 2 && evs[0].event === 'endpoint' && evs[0].data === '/m?s=1' && evs[1].event === 'message' && evs[1].data === '{"a":1}\n2');
    const reply = (id: unknown, method: string, params: Record<string, unknown> | undefined) => {
      if (method === 'initialize') {
        return { jsonrpc: '2.0', id, result: { protocolVersion: String(params?.protocolVersion ?? '2024-11-05'), capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } };
      }
      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } };
      }
      if (method === 'tools/call') {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `echo: ${(params?.arguments as { text?: string })?.text}` }] } };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'no' } };
    };
    const seen = { sessionOk: true, protocolOk: true, auth: [] as string[] };
    const sseClients = new Map<string, nodeHttp.ServerResponse>();
    const server = nodeHttp.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const url = req.url ?? '';
        const msg = body ? JSON.parse(body) : undefined;
        if (url.startsWith('/auth')) {
          seen.auth.push(String(req.headers.authorization));
          if (req.headers.authorization !== 'Bearer t0ken') {
            res.writeHead(401).end('unauthorized');
            return;
          }
        }
        if (/^\/(json|stream|auth)/.test(url) && req.method === 'POST') {
          if (msg.method !== 'initialize') {
            seen.sessionOk &&= req.headers['mcp-session-id'] === 'sess-1';
            seen.protocolOk &&= req.headers['mcp-protocol-version'] === '2025-06-18';
          }
          if (msg.id === undefined) {
            res.writeHead(202).end();
            return;
          }
          const r = reply(msg.id, msg.method, msg.params);
          const h: Record<string, string> = msg.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
          if (url.startsWith('/stream')) {
            res.writeHead(200, { ...h, 'content-type': 'text/event-stream' });
            res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
            res.end(`event: message\ndata: ${JSON.stringify(r)}\n\n`);
          } else {
            res.writeHead(200, { ...h, 'content-type': 'application/json' }).end(JSON.stringify(r));
          }
          return;
        }
        // Legacy HTTP+SSE: /legacy/sse (explicit) and /old (found by the fallback after the POST is refused).
        if ((url === '/legacy/sse' || url === '/old') && req.method === 'GET') {
          const sid = String(sseClients.size + 1);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: endpoint\ndata: /legacy/messages?sid=${sid}\n\n`);
          sseClients.set(sid, res);
          return;
        }
        if (url === '/old' && req.method === 'POST') {
          res.writeHead(405).end();
          return;
        }
        if (url.startsWith('/legacy/messages')) {
          const sid = new URL(url, 'http://x').searchParams.get('sid')!;
          res.writeHead(202).end();
          if (msg.id !== undefined) {
            sseClients.get(sid)?.write(`event: message\ndata: ${JSON.stringify(reply(msg.id, msg.method, msg.params))}\n\n`);
          }
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const mlog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
    const tryServer = async (cfg: Record<string, unknown>) => {
      const c = new McpClient('t', cfg as never, mlog, '1');
      try {
        await c.start();
        const r = await c.callTool('echo', { text: 'hi' });
        return { kind: c.kind, tools: c.tools.length, text: r.text };
      } catch (e) {
        return { error: String(e) };
      } finally {
        c.dispose();
      }
    };
    const j = await tryServer({ url: `${base}/json/mcp` });
    check('Streamable HTTP, JSON replies: initialize, tools, call', j.kind === 'http' && j.tools === 1 && j.text === 'echo: hi', j);
    check('session id and negotiated protocol version sent on every later request', seen.sessionOk && seen.protocolOk);
    const st = await tryServer({ url: `${base}/stream/mcp` });
    check('Streamable HTTP, event-stream replies (with a notification first)', st.kind === 'http' && st.text === 'echo: hi', st);
    const sse = await tryServer({ url: `${base}/legacy/sse` });
    check('legacy HTTP+SSE: endpoint event, POSTs, replies on the stream', sse.kind === 'sse' && sse.text === 'echo: hi', sse);
    const fb = await tryServer({ url: `${base}/old` });
    check('a refused Streamable HTTP POST falls back to SSE at the same URL', fb.kind === 'sse' && fb.text === 'echo: hi', fb);
    process.env.LP_SMOKE_MCP_TOKEN = 't0ken';
    const au = await tryServer({ url: `${base}/auth/mcp`, headers: { Authorization: 'Bearer ${env:LP_SMOKE_MCP_TOKEN}' } });
    const noAuth = await tryServer({ url: `${base}/auth/mcp` });
    check('headers with ${env:…} authenticate; 401 is reported, not retried as SSE', au.text === 'echo: hi' && /401/.test(String(noAuth.error)) && seen.auth[0] === 'Bearer t0ken', { au, noAuth });
    for (const r of sseClients.values()) {
      r.end();
    }
    server.closeAllConnections?.();
    server.close();
  }

  console.log('\n[Shared board: claims, leases, dependencies, notes]');
  {
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-board-'));
    const board = new TeamBoard(root);
    const api = await board.add({ title: 'Add the /health endpoint', brief: 'Return {"ok": true} from GET /health.\nTest it.', priority: 2 }, 'ana@box');
    const docs = await board.add({ title: 'Document /health', brief: 'Add it to README.', dependsOn: [api.id] }, 'ana@box');
    const again = await board.add({ title: 'Add the /health endpoint', brief: 'dup' }, 'bo@box');
    check('ids from titles, unique; unknown dependencies dropped', api.id === 'add-the-health-endpoint' && again.id === 'add-the-health-endpoint-2' && docs.dependsOn[0] === api.id);
    const round = parseTask(api.id, serializeTask({ ...api, notes: [{ at: '2026-11-02T10:00:00.000Z', by: 'ana@box', text: 'start with the router' }], result: 'done in routes.ts' }));
    check('task file round-trips (title with quotes, multi-line brief, notes, result)', round.title === api.title && round.brief === api.brief && round.notes[0].text === 'start with the router' && round.result === 'done in routes.ts' && round.priority === 2);
    // Five workers race for the same task: exactly one gets it.
    const wins = (await Promise.all([1, 2, 3, 4, 5].map((n) => board.claim(`w${n}`, api.id)))).filter(Boolean);
    check('concurrent claims of one task: exactly one wins', wins.length === 1, wins.map((w) => w?.owner));
    const winner = wins[0]!.owner!;
    check('a task waiting for an unfinished dependency is not claimable', !claimable((await board.get(docs.id))!, await board.list()) && (await board.claim('w9', docs.id)) === undefined);
    const stolen = await board.update(api.id, 'intruder', { status: 'done', result: 'x' });
    const noted = await board.update(api.id, 'intruder', { note: 'the router moved to src/http' });
    check('only the owner closes a claim; anyone can leave a note', !!stolen.error && !noted.error && (await board.get(api.id))!.notes.some((n) => n.by === 'intruder'));
    const closed = await board.update(api.id, winner, { status: 'done', result: 'GET /health returns {"ok":true}; test added', note: 'completed' });
    check('owner completes it; the dependent task becomes claimable', closed.task?.status === 'done' && !!(await board.claim('w2', docs.id)));
    // Lease expiry: a crashed worker's claim is taken over, with a note saying so.
    const stale = await board.claim('crashed', again.id, -1000);
    const taken = await board.claim('fresh');
    check('an expired lease can be taken over, and the takeover is recorded', !!stale && taken?.id === again.id && taken.owner === 'fresh' && /took over/.test(taken.notes.at(-1)!.text));
    const text = formatBoard(await board.list());
    check('board listing: state, owner, waiting dependencies', /add-the-health-endpoint \[done\] p2/.test(text) && /document-health \[claimed\]/.test(text), text);
    // Hand-edited file with an unknown status and list-style dependencies still parses.
    nodeFs.writeFileSync(nodePath.join(root, '.localpilot', 'board', 'manual.md'), '---\nid: manual\ntitle: Tidy imports\nstatus: someday\ndependsOn: [document-health]\n---\nRemove unused imports.\n');
    const manual = (await board.get('manual'))!;
    check('hand-written task files are accepted', manual.status === 'open' && manual.dependsOn[0] === 'document-health' && manual.title === 'Tidy imports');
    const tctx = { sessionId: 'sess-abcdef12', workspaceRoot: root, signal: new AbortController().signal, requestApproval: async () => true, progress() {}, trackChange: async () => {}, depth: 0 } as unknown as import('../src/types').ToolContext;
    const added = await teamBoardTool.execute({ action: 'add', title: 'Write tests', brief: 'Cover /health', priority: 1 }, tctx);
    const claimed = await teamBoardTool.execute({ action: 'claim', id: 'write-tests' }, tctx);
    const completed = await teamBoardTool.execute({ action: 'complete', id: 'write-tests', text: 'tests pass' }, tctx);
    check('team_board tool: add, claim and complete under the chat identity', /Added "write-tests"/.test(added.content) && /Claimed "write-tests"/.test(claimed.content) && /Completed/.test(completed.content) && (await board.get('write-tests'))!.status === 'done', [added.content, claimed.content, completed.content]);
    nodeFs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n[Multi-repository: registry, list, search, exec]');
  {
    // Paths through path.resolve, so the same expectations hold on Windows (drive letters, backslashes).
    const P = (p: string) => nodePath.resolve(p);
    const r = collectRepos({ folders: ['/w/app', '/w/app'], file: { base: '/w/app', map: { api: '../api', gone: '../nope', dup: '.' } }, setting: { web: '/w/web', api: '/elsewhere/api' } }, (p) => p !== P('/w/nope'));
    check('registry: workspace folders, repos.json (relative), setting; duplicates and missing folders dropped; names unique', r.map((x) => `${x.name}=${x.path}`).join(' ') === `app=${P('/w/app')} api=${P('/w/api')} web=${P('/w/web')} api-2=${P('/elsewhere/api')}` && findRepo(r, 'API')?.path === P('/w/api'), r);
    const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-repos-'));
    const mk = async (name: string, files: Record<string, string>) => {
      const dir = nodePath.join(base, name);
      nodeFs.mkdirSync(dir, { recursive: true });
      for (const [f, t] of Object.entries(files)) {
        nodeFs.writeFileSync(nodePath.join(dir, f), t);
      }
      await runCmd('git', ['init', '-q', '-b', 'main'], dir);
      await runCmd('git', ['add', '.'], dir);
      await runCmd('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir);
      return dir;
    };
    const hub = await mk('hub', { 'README.md': 'hub\n' });
    await mk('api', { 'server.js': 'const PORT = 3000;\n' });
    await mk('web', { 'config.js': 'export const API = "http://localhost:3000";\n' });
    nodeFs.mkdirSync(nodePath.join(hub, '.localpilot'), { recursive: true });
    nodeFs.writeFileSync(nodePath.join(hub, '.localpilot', 'repos.json'), '{ "repos": { "api": "../api", "web": "../web" } }');
    nodeFs.writeFileSync(nodePath.join(base, 'web', 'config.js'), 'export const API = "http://localhost:3000"; // edited\n');
    const asked: string[] = [];
    const rctx = { sessionId: 's', workspaceRoot: hub, signal: new AbortController().signal, requestApproval: async (t: string) => { asked.push(t); return true; }, progress() {}, trackChange: async () => {}, depth: 0 } as unknown as import('../src/types').ToolContext;
    const list = await reposTool.execute({ action: 'list' }, rctx);
    check('list: every repository with branch and changes', /^hub .*main\s+· 1 changed/m.test(list.content) && /^api .*main\s+· clean/m.test(list.content) && /^web .*· 1 changed/m.test(list.content), list.content);
    const search = await reposTool.execute({ action: 'search', query: '3000' }, rctx);
    check('search across repositories', /## api\nserver\.js:1:const PORT = 3000/.test(search.content) && /## web\nconfig\.js/.test(search.content) && !/## hub/.test(search.content), search.content);
    const ex = await reposTool.execute({ action: 'exec', command: 'git rev-parse --abbrev-ref HEAD', repos: ['api', 'web'] }, rctx);
    check('exec in chosen repositories, after one approval', /All 2 succeeded/.test(ex.content) && /## api — exit 0\nmain/.test(ex.content) && asked.length === 1 && /Run in 2 repositories/.test(asked[0]), ex.content);
    const bad = await reposTool.execute({ action: 'exec', command: 'true', repos: ['nope'] }, rctx);
    check('unknown repository names are refused with the known ones', !!bad.isError && /Known: hub, api, web/.test(bad.content));
    const { resolveWorkspacePath } = await import('../src/tools/fs');
    let outside = '';
    try { resolveWorkspacePath('../elsewhere/x.js', rctx); } catch (e) { outside = String(e); }
    check('file paths reach registered repositories, not other folders', resolveWorkspacePath('../api/server.js', rctx).fsPath === nodePath.join(base, 'api', 'server.js') && /outside the workspace/.test(outside));
    const ro = await reposTool.execute({ action: 'exec', command: 'true' }, { ...rctx, readOnly: true } as never);
    check('exec refused in read-only modes', !!ro.isError);
    nodeFs.rmSync(base, { recursive: true, force: true });
  }

  console.log('\n[Security scan: lockfiles, OSV, secrets, risky code, SARIF]');
  {
    const names = (f: string, t: string) => parseLockfile(f, t).map((d) => `${d.ecosystem}:${d.name}@${d.version}`).sort().join(' ');
    check('npm package-lock v3 (nested copies, links skipped) and v1', names('package-lock.json', '{"packages":{"":{},"node_modules/a":{"version":"1.0.0"},"node_modules/b/node_modules/a":{"version":"2.0.0"},"node_modules/l":{"link":true}}}') === 'npm:a@1.0.0 npm:a@2.0.0' && names('package-lock.json', '{"dependencies":{"x":{"version":"1.2.3","dependencies":{"y":{"version":"0.1.0"}}}}}') === 'npm:x@1.2.3 npm:y@0.1.0');
    check('yarn.lock classic and berry', names('yarn.lock', '"@s/p@^1.0.0", "@s/p@^1.1":\n  version "1.2.0"\n  resolved "x"\n\nlodash@^4:\n  version "4.17.21"\n') === 'npm:@s/p@1.2.0 npm:lodash@4.17.21' && names('yarn.lock', '"react@npm:^18.0.0":\n  version: 18.2.0\n  resolution: "react@npm:18.2.0"\n') === 'npm:react@18.2.0');
    check('requirements (pinned only), poetry.lock, Pipfile.lock', names('requirements-dev.txt', 'Requests[socks]==2.19.0\nflask>=2\n# c\n') === 'PyPI:requests@2.19.0' && names('poetry.lock', '[[package]]\nname = "Django"\nversion = "3.2.0"\n') === 'PyPI:django@3.2.0' && names('Pipfile.lock', '{"default":{"jinja2":{"version":"==2.10"}},"develop":{}}') === 'PyPI:jinja2@2.10');
    check('go.mod (block and single, +incompatible), Cargo.lock (registry crates only), Gemfile.lock', names('go.mod', 'module x\nrequire (\n\tgithub.com/a/b v1.2.3 // indirect\n\tgolang.org/x/net v0.0.1\n)\nrequire github.com/c/d v2.0.0+incompatible\n') === 'Go:github.com/a/b@v1.2.3 Go:github.com/c/d@v2.0.0 Go:golang.org/x/net@v0.0.1' && names('Cargo.lock', '[[package]]\nname = "mine"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "registry+x"\n') === 'crates.io:serde@1.0.1' && names('Gemfile.lock', 'GEM\n  specs:\n    rack (2.0.1)\n    nokogiri (1.10.0-x86_64-linux)\n\nPLATFORMS\n') === 'RubyGems:nokogiri@1.10.0 RubyGems:rack@2.0.1');
    const vuln = { id: 'GHSA-x', aliases: ['CVE-1'], database_specific: { severity: 'MODERATE' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }, { package: { name: 'other' }, ranges: [{ events: [{ fixed: '9' }] }] }] };
    check('OSV severity (GitHub label, CVSS score fallback) and fixed versions for the right package', osvSeverity(vuln) === 'medium' && osvSeverity({ id: 'y', severity: [{ type: 'CVSS_V3', score: '9.8' }] }) === 'critical' && osvSeverity({ id: 'z' }) === 'medium' && osvFixes(vuln, { name: 'lodash', ecosystem: 'npm' }).join() === '4.17.21');
    const fakeOsv = (async (url: string) => ({ ok: true, json: async () => (String(url).includes('querybatch') ? { results: [{ vulns: [{ id: 'GHSA-x' }, { id: 'PYSEC-1' }] }, {}] } : String(url).includes('GHSA-x') ? vuln : { id: 'PYSEC-1', aliases: ['GHSA-x'] }) })) as unknown as typeof fetch;
    const deps = await checkDependencies([{ ecosystem: 'npm', name: 'lodash', version: '4.17.15', file: 'package-lock.json' }, { ecosystem: 'npm', name: 'ok', version: '1.0.0', file: 'package-lock.json' }], { fetchImpl: fakeOsv });
    check('dependency check: one finding per advisory (aliases merged), with the fix', deps.length === 1 && deps[0].id === 'GHSA-x' && deps[0].fix === 'upgrade lodash to 4.17.21' && deps[0].aliases?.[0] === 'CVE-1', deps);
    const sec = scanText('src/conf.ts', ['const k = "AKIAIOSFODNN7EXAMPLQ";', 'const password = "changeme12345";', 'const apiKey = "x9Fq2LmZ8vR1tY6wB3nC";', 'const token = process.env.TOKEN || "abc";', 'key = "-----BEGIN RSA PRIVATE KEY-----"', 'const t = "ghp_' + 'a'.repeat(36) + '"; // localpilot-scan: ignore'].join('\n'), { secrets: true, code: false });
    check('secrets: real keys found and masked; placeholders, env reads and ignored lines skipped', sec.map((f) => `${f.id}:${f.line}`).join(' ') === 'aws-access-key:1 hardcoded-credential:3 private-key:5' && sec.every((f) => !f.title.includes('AKIAIOSFODNN7EXAMPLQ')) && /AKIA…LQ/.test(sec[0].title), sec.map((f) => `${f.id}:${f.line} ${f.title}`)); // localpilot-scan: ignore (security test fixtures)
    check('entropy separates random strings from words', entropy('x9Fq2LmZ8vR1tY6wB3nC') > 4 && entropy('aaaaaaaaaaaa') === 0);
    const code = scanText('app/db.py', ['import subprocess', 'subprocess.run(cmd, shell=True)', 'cur.execute(f"SELECT * FROM t WHERE id = {i}")', 'cur.execute("SELECT * FROM t WHERE id = %s", (i,))', 'requests.get(u, verify=False)', '# subprocess.run(x, shell=True)', 'yaml.load(f, Loader=yaml.SafeLoader)', 'yaml.load(f)'].join('\n'), { secrets: false, code: true }); // localpilot-scan: ignore (security test fixtures)
    check('risky code: shell=True, f-string SQL, verify=False, unsafe yaml; parameterised SQL, comments and SafeLoader not flagged', code.map((f) => `${f.id}:${f.line}`).join(' ') === 'shell-injection:2 sql-concat:3 tls-verify-off:5 unsafe-deserialization:8', code.map((f) => `${f.id}:${f.line}`)); // localpilot-scan: ignore (security test fixtures)
    check('the same pattern in a test file is low severity', scanText('tests/test_db.py', 'requests.get(u, verify=False)', { secrets: false, code: true })[0].severity === 'low'); // localpilot-scan: ignore (security test fixtures)
    const sarif = toSarif({ root: '/r', findings: [...deps, ...sec], dependencies: 2, files: 1, skipped: [] }, '1.0.0') as { version: string; runs: { results: { ruleId: string; level: string; locations: { physicalLocation: { region?: { startLine: number } } }[] }[]; tool: { driver: { rules: unknown[] } } }[] };
    check('SARIF 2.1.0: one rule per id, levels from severity, line regions', sarif.version === '2.1.0' && sarif.runs[0].results.length === 4 && sarif.runs[0].tool.driver.rules.length === 4 && sarif.runs[0].results.find((r) => r.ruleId === 'aws-access-key')?.level === 'error' && sarif.runs[0].results.find((r) => r.ruleId === 'aws-access-key')?.locations[0].physicalLocation.region?.startLine === 1);
  }

  console.log('\n[Plugins: marketplaces, install, enable, remove, authoring]');
  {
    check('marketplace specs: owner/repo → GitHub, URLs kept, folders local', gitUrl('anthropics/claude-plugins-official') === 'https://github.com/anthropics/claude-plugins-official.git' && gitUrl('git@host:a/b.git') === 'git@host:a/b.git' && gitUrl('/tmp/market') === undefined);
    const mk = parseMarketplace('{ "name": "acme", // jsonc\n "plugins": [ { "name": "lint-kit", "description": "Lint fixes", "category": "quality", "keywords": ["eslint"], "source": "./plugins/lint-kit" }, { "name": "deploy", "description": "Ship it", "source": { "source": "git-subdir", "url": "https://x/y.git", "path": "p" } }, { "description": "no name" } ] }');
    check('marketplace.json parsed (JSONC; entries without a name dropped)', mk.name === 'acme' && mk.plugins.length === 2);
    const fakeMarket = { spec: 'x', name: 'acme', dir: '/m', plugins: mk.plugins };
    check('search ranks by name, then keywords and description; all words must match', searchPlugins([fakeMarket], 'eslint')[0]?.entry.name === 'lint-kit' && searchPlugins([fakeMarket], 'ship')[0]?.entry.name === 'deploy' && searchPlugins([fakeMarket], 'lint ship').length === 0 && searchPlugins([fakeMarket], '').length === 2);
    const base = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-plug-'));
    const market = nodePath.join(base, 'market');
    const put = (rel: string, text: string) => { nodeFs.mkdirSync(nodePath.dirname(nodePath.join(market, rel)), { recursive: true }); nodeFs.writeFileSync(nodePath.join(market, rel), text); };
    put('.claude-plugin/marketplace.json', JSON.stringify({ name: 'local', plugins: [{ name: 'guard', source: './plugins/guard' }, { name: 'bare', description: 'No manifest', version: '2.0.0', strict: false, source: './plugins/bare' }, { name: 'escape', source: '../../etc' }] }));
    put('plugins/guard/.claude-plugin/plugin.json', '{"name":"guard-tools","version":"1.0.0","description":"g"}');
    put('plugins/guard/commands/check.md', '---\ndescription: Check\n---\nRun the checks.');
    put('plugins/guard/hooks/hooks.json', '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/guard.sh"}]}]}}');
    put('plugins/guard/.mcp.json', '{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}');
    put('plugins/bare/commands/hi.md', '---\ndescription: Hi\n---\nSay hi.');
    const m = await loadMarketplace(market);
    const dest = nodePath.join(base, 'installed');
    let shown: string[] = [];
    const declined = await installPlugin(m.plugins[0], m, dest, { confirm: async (_p, d) => { shown = d.runs; return false; } });
    check('install shows the hooks and MCP servers it will run, and installs nothing when declined', declined === undefined && shown.some((r) => /PreToolUse \(Bash\): .*guard\.sh/.test(r)) && shown.some((r) => /MCP server docs: https:\/\/docs\.example\/mcp/.test(r)) && !nodeFs.existsSync(nodePath.join(dest, 'guard')), shown);
    const ok = await installPlugin(m.plugins[0], m, dest, { confirm: async () => true });
    check('installed copy loads, with its manifest name and parts', ok?.plugin.name === 'guard-tools' && describePluginP(ok.plugin).summary === 'guard-tools 1.0.0: 1 command, 1 hook, 1 MCP server', ok && describePluginP(ok.plugin).summary);
    const bare = await installPlugin(m.plugins[1], m, dest);
    check('a non-strict entry gets a manifest from the marketplace entry', bare?.plugin.name === 'bare' && bare.plugin.version === '2.0.0' && bare.plugin.commandFiles.length === 1);
    let escaped = '';
    try { await installPlugin(m.plugins[2], m, dest); } catch (e) { escaped = String(e); }
    check('a source path that leaves the marketplace is refused', /leaves its repository/.test(escaped), escaped);
    const settingsFile = nodePath.join(base, 'settings.json');
    nodeFs.writeFileSync(settingsFile, '{ "permissions": { "allow": ["Bash(npm test)"] } }');
    await setPluginEnabled(settingsFile, 'guard-tools', false);
    const st = JSON.parse(nodeFs.readFileSync(settingsFile, 'utf8'));
    await setPluginEnabled(settingsFile, 'guard-tools', true);
    check('enable/disable writes enabledPlugins and keeps other settings', st.enabledPlugins['guard-tools'] === false && st.permissions.allow[0] === 'Bash(npm test)' && !('guard-tools' in JSON.parse(nodeFs.readFileSync(settingsFile, 'utf8')).enabledPlugins));
    check('remove by manifest name (folder name differs)', (await removePlugin('guard-tools', dest)) && !nodeFs.existsSync(nodePath.join(dest, 'guard')) && !(await removePlugin('nothing', dest)));
    const files = await scaffoldPlugin(base, 'My Tools');
    const v = await validatePlugin(nodePath.join(base, 'my-tools'));
    check('scaffolded plugin validates cleanly', files.length === 6 && v.errors.length === 0 && v.warnings.length === 0, v);
    nodeFs.writeFileSync(nodePath.join(base, 'my-tools', 'hooks', 'hooks.json'), '{"hooks":{"BeforeAll":[]}}');
    nodeFs.writeFileSync(nodePath.join(base, 'my-tools', 'agents', 'reviewer.md'), 'no front matter');
    const v2 = await validatePlugin(nodePath.join(base, 'my-tools'));
    check('validate reports unknown hook events and incomplete subagents', v2.errors.some((e) => /unknown event "BeforeAll"/.test(e)) && v2.errors.some((e) => /agents\/reviewer\.md: a subagent needs/.test(e)), v2.errors);
    nodeFs.rmSync(base, { recursive: true, force: true });
  }

  console.log('\n[edit_file: read_file line numbers copied into old_text]');
  {
    const { stripGutter } = await import('../src/tools/fs');
    check('gutter removed when every line has it (blank numbered lines included)', stripGutter('    2 |   "server": { "port": 8080 },\n    3 | \n   10 |   x') === '  "server": { "port": 8080 },\n\n  x');
    check('text without a gutter, or only partly numbered, is left alone', stripGutter('a | b\nplain') === undefined && stripGutter('  port: 1') === undefined && stripGutter('    2 | x\nplain') === undefined);
  }

  console.log('\n[Stability: no listeners left on a long run signal; crashed MCP servers restart]');
  {
    const run = new AbortController();
    for (let i = 0; i < 30; i++) {
      await runCmd('git', ['--version'], undefined, run.signal);
      withTimeout(5_000, run.signal);
      await rsleep(1, run.signal);
      onAbort(run.signal, () => undefined)();
    }
    // AbortSignal.any keeps no listener once its result is collected; force a GC when exposed, else count the rest.
    (globalThis as { gc?: () => void }).gc?.();
    const left = getEventListeners(run.signal, 'abort').length;
    check('30 commands, timeouts and sleeps on one run signal leave no abort listeners behind', left === 0 || (left <= 30 && !(globalThis as { gc?: unknown }).gc), left);
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lp-mcp-crash-'));
    const server = nodePath.join(dir, 'server.js');
    nodeFs.writeFileSync(server, `const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); const out = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r }) + '\\n');
  if (m.method === 'initialize') out({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'crashy', version: '1' } });
  else if (m.method === 'tools/list') out({ tools: [{ name: 'boom', description: 'crash', inputSchema: { type: 'object', properties: {} } }] });
  else if (m.method === 'tools/call') process.exit(3); });`);
    const prevCfg = process.env.LP_CONFIG;
    process.env.LP_CONFIG = JSON.stringify({ mcpServers: { crashy: { command: process.execPath, args: [server] } } });
    const reg = new ToolRegistry();
    const mlog2 = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as import('vscode').LogOutputChannel;
    const mgr = new McpManager(reg, mlog2, '1');
    await mgr.reload();
    const before = reg.list().some((t) => t.definition.name === 'mcp_crashy_boom');
    const call = await reg.execute('mcp_crashy_boom', {}, { sessionId: 's', signal: new AbortController().signal, requestApproval: async () => true, progress() {}, trackChange: async () => {}, depth: 0 } as unknown as import('../src/types').ToolContext);
    await new Promise((r) => setTimeout(r, 300));
    const down = mgr.status.find((x) => x.name === 'crashy');
    const toolsGone = !reg.list().some((t) => t.definition.name === 'mcp_crashy_boom');
    await new Promise((r) => setTimeout(r, 2_800));
    const back = mgr.status.find((x) => x.name === 'crashy');
    check('a crashed MCP server: the call fails, its tools are withdrawn, it is restarted and its tools return', before && !!call.isError && /restarting/.test(String(down?.error)) && toolsGone && back?.tools === 1 && !back.error && reg.list().some((t) => t.definition.name === 'mcp_crashy_boom'), { before, call: call.content.slice(0, 80), down, toolsGone, back });
    mgr.dispose();
    if (prevCfg === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevCfg;
    }
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n[Situational tools: offered only when relevant]');
  {
    const plain = irrelevantTools('fix the off-by-one in pager.py', undefined, 1);
    check('a plain coding request leaves out git/CI, board, repos and security tools', ['git_commit', 'git_push', 'pull_request', 'ci_status', 'team_board', 'repos', 'security_scan'].every((n) => plain.has(n)) && !plain.has('git_status') && !plain.has('repo_graph'));
    check('the conversation brings them in: "open a PR", "is this secure?", "split it on the board", "across repositories"', !irrelevantTools('commit this and open a PR', undefined, 1).has('pull_request') && !irrelevantTools('is this code secure?', undefined, 1).has('security_scan') && !irrelevantTools('split it on the board', undefined, 1).has('team_board') && !irrelevantTools('change it across both repositories', undefined, 1).has('repos'));
    check('so does the workspace: several registered repositories', !irrelevantTools('rename the port constant', undefined, 3).has('repos'));
  }

  console.log('\n[Automatic memory: digest of the run, notes filtered]');
  {
    const turn: ChatMessage[] = [
      { role: 'user', content: 'fix the failing test' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'run_command', arguments: '{"command":"make check-all"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"src/x.py"}' }] },
      { role: 'tool', content: 'Ran 12 tests\nOK', toolCallId: 'a' },
      { role: 'tool', content: 'Tool read_file failed: ENOENT', toolCallId: 'b' },
    ];
    const dg = runDigest('fix the failing test', turn, 'Fixed it; make check-all passes.');
    check('digest: request, each call with its argument and outcome, command output tail, answer', /- run_command make check-all → ok: Ran 12 tests OK/.test(dg) && /- read_file src\/x\.py → failed/.test(dg) && /Answer: Fixed it/.test(dg), dg);
    const notes = parseMemoryNotes('```json\n{"notes":[{"name":"Build & Test","content":"- `make check-all` runs the tests"},{"name":"x","content":"short"},{"name":"keys","content":"- deploy with AKIAIOSFODNN7EXAMPLQ as the key"},{"name":"a","content":"- one fact here"},{"name":"b","content":"- another fact"},{"name":"c","content":"- a third fact"}]}\n```'); // localpilot-scan: ignore (test fixture)
    check('notes: fenced JSON read, names normalised, too-short and secret-bearing notes dropped, at most three', notes.length === 3 && notes[0].name === 'build-test' && !notes.some((n) => n.name === 'keys' || n.name === 'x'), notes);
    check('nothing worth keeping and invalid replies give no notes', parseMemoryNotes('{"notes":[]}').length === 0 && parseMemoryNotes('I think nothing.').length === 0 && parseMemoryNotes('{"notes": "no"}').length === 0);
  }

  console.log('\n[Release versions: each part counts 0–9 and carries]');
  {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nextVersion } = require('./next-version.js') as { nextVersion: (v: string, l: string) => string };
    check('patch after 9 promotes the minor: 1.2.9 → 1.3.0, 1.3.9 → 1.4.0', nextVersion('1.2.9', 'patch') === '1.3.0' && nextVersion('1.3.9', 'patch') === '1.4.0');
    check('ordinary patch: 1.3.4 → 1.3.5; a part already past 9 carries: 1.3.11 → 1.4.0', nextVersion('1.3.4', 'patch') === '1.3.5' && nextVersion('1.3.11', 'patch') === '1.4.0');
    check('minor after 9 promotes the major: 1.9.9 → 2.0.0 (patch), 1.9.3 → 2.0.0 (minor)', nextVersion('1.9.9', 'patch') === '2.0.0' && nextVersion('1.9.3', 'minor') === '2.0.0');
    check('minor and major as usual: 1.3.4 → 1.4.0, → 2.0.0', nextVersion('1.3.4', 'minor') === '1.4.0' && nextVersion('1.3.4', 'major') === '2.0.0');
  }

  console.log('\n[Effective context window]');
  const wide = { contextWindow: 131072 };
  check('setting caps the native window', effectiveContextWindow(wide, 32768) === 32768);
  check('0 = the model\'s full native window (largest)', effectiveContextWindow(wide, 0) === 131072 && effectiveContextWindow(wide, -1) === 131072);
  check('a small model is never asked for more than it has', effectiveContextWindow({ contextWindow: 8192 }, 32768) === 8192);
  check('floor at 4k, unknown native falls back to 32k', effectiveContextWindow(wide, 1000) === 4096 && effectiveContextWindow({ contextWindow: 0 }, 0) === 32768);

  console.log('\n[Fit: keep splitting until it fits]');
  {
    // 30 turns, each with a 3k-char tool result, into an 8k window: prune old results, then one summary pass.
    const budgetOf = (h: ChatMessage[]) => cm.budget(model, 'sys', [], h, 1024);
    let calls = 0;
    const counting = { ...fake, chat: async function* () { calls++; yield { type: 'text', text: '## Task & goals\n- summarised' } as StreamEvent; } };
    const fit = await cm.fit(history, counting, model, budgetOf);
    check('fit: pruning old tool results alone is enough here — no model call is spent', !cm.needsCompaction(fit.budget) && fit.compactions.length === 0 && calls === 0 && fit.messages.some((m) => m.meta?.pruned), { ratio: fit.budget.usageRatio, passes: fit.compactions.length, calls });
    check('fit: the newest turn is kept verbatim', fit.messages[fit.messages.length - 1].content === history[history.length - 1].content);
    // Recent results alone overflow a tiny window: the verbatim window is tightened and summarised again rather than giving up.
    const tiny = { ...model, contextWindow: 4096 };
    const heavy: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      heavy.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: '', toolCalls: [{ id: `h${i}`, name: 'read_file', arguments: '{}' }] }, { role: 'tool', content: 'line1\n' + 'z'.repeat(6000), toolCallId: `h${i}` });
    }
    const tightBudget = (h: ChatMessage[]) => cm.budget(tiny, 'sys', [], h, 1024);
    const fit2 = await cm.fit(heavy, counting, tiny, tightBudget);
    check('fit: tightens the window in later passes until the history fits', !cm.needsCompaction(fit2.budget) && fit2.compactions.length >= 1 && fit2.messages.filter((m) => m.meta?.summary).length === 1, { ratio: fit2.budget.usageRatio, passes: fit2.compactions.length, left: fit2.messages.length });
    const already = await cm.fit(fit.messages, counting, model, budgetOf);
    check('fit: a history that already fits is returned untouched', already.compactions.length === 0 && already.messages === fit.messages);
  }

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
  check('classify: Ollama could not parse the model\'s tool call → toolcall', classifyModelError(new HttpError(500, '{"error":"error parsing tool call: raw=\'{\\"path\\":\\"src\\",\\"}\', err=unexpected end of JSON input"}', 'u')) === 'toolcall');
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
  const overthinkerEfforts: (string | undefined)[] = [];
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'native', capabilities: ['tool_use'] }, { id: 'textonly', capabilities: [] }, { id: 'flaky', capabilities: ['tool_use'] }, { id: 'empty', capabilities: ['tool_use'] }, { id: 'looper', capabilities: ['tool_use'] }, { id: 'overthinker', capabilities: ['tool_use'] }] }));
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
      } else if (body.model === 'overthinker') {
        // Asked to reason, it reasons until the output limit and never answers; asked not to, it answers at once.
        overthinkerEfforts.push(body.reasoning_effort);
        if (body.reasoning_effort) {
          send({ choices: [{ delta: { reasoning_content: 'Hmm, let me weigh every option again… '.repeat(20) } }] });
          send({ choices: [{ delta: {}, finish_reason: 'length' }] });
        } else {
          send({ choices: [{ delta: { content: 'Answered without thinking.' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
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
    // A reply that is all reasoning (thinking ran to the output limit) is asked again with thinking off, not repeated.
    const sOver = mkSession('mock/overthinker');
    const evOver: AgentEvent[] = [];
    const outOver = await runner.run({ session: sOver, userMessage: { role: 'user', content: 'go' }, emit: (e) => evOver.push(e), signal: new AbortController().signal, requestApproval: async () => true });
    check('resilience: reasoning-only reply is retried without thinking', outOver === 'Answered without thinking.' && overthinkerEfforts.length === 2 && !!overthinkerEfforts[0] && overthinkerEfforts[1] === undefined, { outOver, overthinkerEfforts });
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
    // native 2 + textonly 2 + flaky 2 (503 then ok) + empty 2 + looper 5 (3 served calls, 1 refused, final answer) + overthinker 2 (reasoning only, then without thinking); the aborted run makes none.
    check('total model calls as expected', calls === 15, calls);

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


async function pauseAndSteer() {
  console.log('\n[Pause, steer and subagent controls]');
  // RunControl semantics on their own.
  {
    const root = new RunControl('root');
    const kid = root.child('kid', 'explore');
    root.pause();
    check('control: parent pause reaches the child', root.paused && kid.paused && !kid.pausedBySelf);
    root.resume();
    kid.pause();
    check('control: child pause stays local', kid.paused && !root.paused);
    let woke = false;
    const waiting = kid.waitWhilePaused().then(() => { woke = true; });
    await new Promise((r) => setTimeout(r, 20));
    check('control: waitWhilePaused holds while paused', !woke && kid.holding);
    kid.resume();
    await waiting;
    check('control: resume wakes the waiter', woke && !kid.holding);
    const changes: string[] = [];
    root.onDidChange((c) => changes.push(c.id));
    kid.stop();
    check('control: child stop does not abort the parent and bubbles to parent listeners', kid.aborted && !root.aborted && changes.includes('kid'));
    const kid2 = root.child('kid2');
    root.stop();
    check('control: parent stop aborts children', kid2.aborted && root.aborted);
    kid2.dispose();
    check('control: dispose unregisters the child', !root.children.has('kid2') && root.find('kid2') === undefined);
  }

  let calls = 0;
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'ctl', capabilities: ['tool_use'] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      calls++;
      const transcript = JSON.stringify(body.messages);
      // The first user message tells runs apart: a child's is its prompt, the parent's is 'PARENT-GO' (its tool call *mentions* CHILD-A/B).
      const task = String((body.messages as { role: string; content: string }[]).find((m) => m.role === 'user')?.content ?? '');
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = (t: string) => { send({ choices: [{ delta: { content: t } }] }); send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); };
      const tool = (id: string, name: string, args: unknown) => { send({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }); send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }); };
      if (task.includes('CHILD-A')) {
        await new Promise((r) => setTimeout(r, 600)); // slow child: the test stops it while this request is in flight
        text('A-REPORT');
      } else if (task.includes('CHILD-B')) {
        text('B-REPORT');
      } else if (task.includes('PARENT-GO')) {
        if (transcript.includes('B-REPORT')) { text('Parent done.'); } else { tool('p1', 'run_parallel_subagents', { tasks: [{ agent: 'explore', prompt: 'CHILD-A task' }, { agent: 'explore', prompt: 'CHILD-B task' }] }); }
      } else if (task.includes('CLAIM-GO')) {
        // Small-model failure mode: announces the delegation without a tool call; acts only after the nudge.
        if (transcript.includes('ECHO:two')) { text('Created both.'); } else if (transcript.includes('no worker exists')) { tool('e2', 'echo', { text: 'two' }); } else { text("Delegated to 2 background workers. I'll report back when they finish."); }
      } else if (transcript.includes('FINISH-GO')) {
        text(transcript.includes('STEER2') ? 'Second answer.' : 'First answer.');
      } else if (!transcript.includes('ECHO:')) {
        tool('e1', 'echo', { text: 'one' });
      } else {
        text(transcript.includes('STEER-MSG') && !transcript.includes('ACK steer') ? 'ACK steer' : 'Done.');
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
    await skills.refresh(); // loads the built-in subagent definitions (explore, coder, …)
    const workspace = new WorkspaceContext(log);
    let executions = 0;
    tools.register({ parallelSafe: true, definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, async execute(args) { executions++; return { content: `ECHO:${args.text}` }; } });
    const runner = new AgentRunner(providers, tools, skills, workspace, log);
    const sink: AgentEvent[] = [];
    let onEvent: ((e: AgentEvent) => void) | undefined;
    const emit = (e: AgentEvent) => { sink.push(e); onEvent?.(e); };
    tools.registerAll(createAgentTools(runner, skills, emit, async () => true));
    const mkSession = (id: string): Session => ({ id, title: '', createdAt: 0, updatedAt: 0, model: 'mock/ctl', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] });
    const visible = (s: Session) => s.messages.filter((m) => !m.meta?.hidden);
    const statuses = () => sink.filter((e) => e.type === 'status').map((e) => String(e.payload));

    // 1. Pause requested during the first model call → the loop holds before running the tool; steer while held; resume.
    {
      const s = mkSession('p1');
      const control = new RunControl(s.id);
      onEvent = (e) => { if (e.sessionId === s.id && e.type === 'model_request' && !control.paused) { control.pause(); } };
      const run = runner.run({ session: s, userMessage: { role: 'user', content: 'go' }, emit, signal: control.signal, control, requestApproval: async () => true });
      await new Promise((r) => setTimeout(r, 400));
      check('pause: loop holds before the tool batch (tool not executed, status Paused)', control.holding && executions === 0 && statuses().includes('Paused'), { holding: control.holding, executions });
      control.steer({ role: 'user', content: 'STEER-MSG', meta: { steerId: 'x1' } });
      await new Promise((r) => setTimeout(r, 50));
      check('pause: steering while held does not run anything', executions === 0 && control.pendingSteering === 1);
      onEvent = undefined;
      control.resume();
      const out = await run;
      const v = visible(s);
      check('resume: tool ran, steer injected after its result, model acknowledged it', out === 'ACK steer' && executions === 1 && v.map((m) => m.role).join(',') === 'user,assistant,tool,user,assistant', { out, roles: v.map((m) => m.role) });
      check('steer: injected message carries steer meta and a steer event names it', v[3].meta?.steer === true && v[3].content === 'STEER-MSG' && sink.some((e) => e.type === 'steer' && JSON.stringify(e.payload).includes('x1')));
      check('steer: Resuming status emitted after the hold', statuses().includes('Resuming…'));
    }

    // 2. A steer queued while the model is producing its final answer continues the turn instead of ending it.
    {
      const s = mkSession('p2');
      const control = new RunControl(s.id);
      let steered = false;
      onEvent = (e) => { if (e.sessionId === s.id && e.type === 'model_request' && !steered) { steered = true; control.steer({ role: 'user', content: 'STEER2' }); } };
      const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'FINISH-GO' }, emit, signal: control.signal, control, requestApproval: async () => true });
      onEvent = undefined;
      const v = visible(s);
      check('steer after a final answer continues the turn with a second model call', out === 'Second answer.' && v.map((m) => m.role).join(',') === 'user,assistant,user,assistant' && v[1].content === 'First answer.', { out, roles: v.map((m) => m.role) });
    }

    // 3. Stop one parallel subagent: the parent keeps going and gets a "stopped" report; the sibling finishes.
    {
      const s = mkSession('p3');
      const control = new RunControl(s.id);
      let stoppedChild = '';
      onEvent = (e) => {
        if (e.sessionId === s.id && e.type === 'subagent_start') {
          const p = e.payload as { childId: string; prompt: string };
          if (p.prompt.includes('CHILD-A')) { setTimeout(() => { const c = control.find(p.childId); stoppedChild = c ? c.id : ''; c?.stop(); }, 120); }
        }
      };
      const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'PARENT-GO' }, emit, signal: control.signal, control, requestApproval: async () => true });
      onEvent = undefined;
      const toolMsg = s.messages.find((m) => m.role === 'tool' && m.toolName === 'run_parallel_subagents');
      check('child stop: the child control was found through the parent', !!stoppedChild && stoppedChild.includes('explore'));
      check('child stop: parent finishes and sees a stopped report for A and the real report for B', out === 'Parent done.' && !control.aborted && !!toolMsg && /stopped by the user/.test(toolMsg.content) && /B-REPORT/.test(toolMsg.content) && !/A-REPORT/.test(toolMsg.content), { out, tool: toolMsg?.content.slice(0, 300) });
      check('child stop: subagent_end reports the stop for that child only', sink.filter((e) => e.sessionId === s.id && e.type === 'subagent_end').map((e) => (e.payload as { error?: string }).error).filter(Boolean).join() === 'Stopped by user');
      check('child controls are disposed when their runs end', control.children.size === 0);
    }

    // 4. Pausing the parent while children run pauses the children too.
    {
      const s = mkSession('p4');
      const control = new RunControl(s.id);
      let seen = 0; let childPausedUnderParent = false;
      onEvent = (e) => {
        if (e.sessionId === s.id && e.type === 'subagent_start' && ++seen === 2) {
          control.pause();
          childPausedUnderParent = control.descendants().length === 2 && control.descendants().every((c) => c.paused && !c.pausedBySelf);
          setTimeout(() => control.resume(), 150);
        }
      };
      const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'PARENT-GO' }, emit, signal: control.signal, control, requestApproval: async () => true });
      onEvent = undefined;
      check('parent pause: both children were paused through the parent and the run completed after resume', childPausedUnderParent && out === 'Parent done.', { childPausedUnderParent, out });
    }

    // 5. A reply that only *claims* the delegation is retracted: the loop emits `nudge`, tags the hidden message and the model then acts.
    {
      const s = mkSession('p5');
      const control = new RunControl(s.id);
      const out = await runner.run({ session: s, userMessage: { role: 'user', content: 'CLAIM-GO create two files' }, emit, signal: control.signal, control, requestApproval: async () => true });
      const nudges = sink.filter((e) => e.sessionId === s.id && e.type === 'nudge').map((e) => (e.payload as { reason: string }).reason);
      // Skills found on the machine may add their own hidden hint first; the nudge is the tagged one.
      const hidden = s.messages.find((m) => m.role === 'user' && m.meta?.hidden && m.meta?.nudge);
      const order = sink.filter((e) => e.sessionId === s.id && (e.type === 'nudge' || e.type === 'tool_start')).map((e) => e.type);
      check('nudge: emitted once with reason=claimed before the tool finally runs', nudges.join() === 'claimed' && order.join() === 'nudge,tool_start', { nudges, order });
      check('nudge: hidden steering message is tagged and names a fan-out tool for a delegation claim', !!hidden && hidden.meta?.nudge === 'claimed' && /run_todos_parallel|run_parallel_subagents/.test(hidden.content), hidden?.content.slice(0, 120));
      check('nudge: run completes with the real answer after acting', out === 'Created both.' && visible(s).filter((m) => m.role === 'assistant').length === 3, out);
    }
    check('pause/steer: model calls as expected', calls === 2 + 2 + 4 + 4 + 3, calls);
  } finally {
    srv.close();
    delete process.env.LP_MOCK_URL;
  }
}


async function worktrees() {
  console.log('\n[Isolated worktrees]');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const cp = await import('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-wt-'));
  const repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(repo);
  const sh = (cmd: string, cwd = repo) => cp.execSync(cmd, { cwd, stdio: 'pipe' }).toString();
  // Git for Windows defaults to core.autocrlf=true, which would check the worktree out with CRLF while this test
  // writes LF files straight to disk and compares bytes; pin LF so the comparisons mean the same on every OS.
  sh('git init -q -b main && git config user.email a@b && git config user.name a && git config core.autocrlf false');
  // Canonical form of the repo path (long names, native separators) — what repoRoot() promises to return.
  const canonical = fs.realpathSync.native(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
  fs.mkdirSync(path.join(repo, '.localpilot'));
  fs.writeFileSync(path.join(repo, '.localpilot', 'worktrees.json'), JSON.stringify({ setup: ['echo setup-ran > setup.marker'] }));
  sh('git add -A && git commit -q -m init');
  // Work in progress in the main checkout: a tracked edit, an untracked file and an ignored file.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b changed\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'nope\n');
  const mgr = new WorktreeManager(home);
  try {
    check('repoRoot finds the repository, undefined outside one', (await mgr.repoRoot(path.join(repo, '.localpilot'))) === canonical && (await mgr.repoRoot(os.tmpdir())) === undefined, { got: await mgr.repoRoot(path.join(repo, '.localpilot')), canonical });
    const progress: string[] = [];
    const wt = await mgr.create(canonical, 's_one', { progress: (t) => progress.push(t) });
    check('worktree lives outside the repository', wt.path.startsWith(home) && !wt.path.startsWith(repo));
    check('worktree carries the uncommitted edit and the untracked file, not the ignored one', fs.readFileSync(path.join(wt.path, 'b.txt'), 'utf8') === 'b changed\n' && fs.readFileSync(path.join(wt.path, 'new.txt'), 'utf8') === 'untracked\n' && !fs.existsSync(path.join(wt.path, 'ignored.txt')));
    check('setup hook from .localpilot/worktrees.json ran inside the worktree', fs.existsSync(path.join(wt.path, 'setup.marker')) && progress.some((p) => p.includes('echo setup-ran')));
    check('fresh worktree reports no changes (setup output is part of the base)', (await mgr.changes(wt)).length === 0, await mgr.changes(wt));
    // The agent works in the worktree: edits a tracked file, creates one, deletes one.
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'line1\nline2 edited\nline3\nline4\n');
    fs.writeFileSync(path.join(wt.path, 'c.txt'), 'created\n');
    fs.rmSync(path.join(wt.path, 'b.txt'));
    const changes = await mgr.changes(wt);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    check('changes: modify / create / delete with line counts', byPath['a.txt']?.kind === 'modify' && byPath['a.txt'].added === 2 && byPath['a.txt'].removed === 1 && byPath['c.txt']?.kind === 'create' && byPath['b.txt']?.kind === 'delete', changes);
    check('baseContent returns the file as it was before the agent touched it', (await mgr.baseContent(wt, 'a.txt')) === 'line1\nline2\nline3\n' && (await mgr.baseContent(wt, 'c.txt')) === '');
    check('main checkout is untouched while the agent works', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'line1\nline2\nline3\n' && fs.existsSync(path.join(repo, 'b.txt')));
    // Apply back as uncommitted changes.
    const snapshots: string[] = [];
    const res = await mgr.apply(wt, async (p) => { snapshots.push(path.basename(p)); });
    check('apply: main checkout now has the edit, the new file and the deletion, uncommitted', fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'line1\nline2 edited\nline3\nline4\n' && fs.readFileSync(path.join(repo, 'c.txt'), 'utf8') === 'created\n' && !fs.existsSync(path.join(repo, 'b.txt')) && /M a.txt|A c.txt|D b.txt|\?\? c.txt/.test(sh('git status --short')) && !sh('git log --oneline').includes('LocalPilot'), sh('git status --short'));
    check('apply: no conflicts, snapshot hook called for every affected file', res.conflicts.length === 0 && snapshots.sort().join() === 'a.txt,b.txt,c.txt', { res, snapshots });
    check('apply: untracked work in progress survives', fs.readFileSync(path.join(repo, 'new.txt'), 'utf8') === 'untracked\n');
    // Conflict: a second worktree edits the same line the main checkout has since changed.
    const wt2 = await mgr.create(canonical, 's_two', {});
    fs.writeFileSync(path.join(wt2.path, 'a.txt'), 'line1\nline2 from agent two\nline3\nline4\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'line1\nline2 from the user\nline3\nline4\n');
    const res2 = await mgr.apply(wt2);
    const after = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8');
    check('apply with a conflicting edit falls back to a 3-way merge and reports the file', res2.conflicts.includes('a.txt') && /<<<<<<<|>>>>>>>/.test(after), { res2, after });
    const listed = await mgr.list(canonical);
    check('list sees both worktrees', listed.map((l) => l.id).sort().join() === 's_one,s_two', listed.map((l) => l.id));
    const pruned = await mgr.prune(canonical, new Set(['s_two']));
    check('prune removes worktrees whose session is gone', pruned === 1 && !fs.existsSync(wt.path) && fs.existsSync(wt2.path) && !sh('git worktree list').includes('s_one'));
    await mgr.remove(wt2);
    check('remove deletes the worktree and git forgets it', !fs.existsSync(wt2.path) && !sh('git worktree list').includes('s_two') && (await mgr.list(canonical)).length === 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function telemetry() {
  console.log('\n--- telemetry store & dashboard aggregation');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-tm-'));
  const DAY = 86400_000;
  let now = Date.parse('2026-10-24T12:00:00');
  let retention = 0; // auto-prune after a write must not remove the 10-day-old file we are about to assert on
  const t = new Telemetry({ dir: tmp, retentionDays: () => retention, now: () => now, logBuffer: 5 });
  try {
    check('percentiles: p50/p95/avg', JSON.stringify(percentiles([10, 20, 30, 40, 100])) === JSON.stringify({ p50: 30, p95: 100, avg: 40 }) && percentiles([]).p95 === 0);
    // Bounded samples: exact below the cap, a close estimate above it, memory flat either way.
    const exact = new Samples(); for (let i = 1; i <= 100; i++) { exact.add(i); }
    check('Samples: exact percentiles below the cap', percentiles(exact).p50 === 50 && percentiles(exact).p95 === 95 && percentiles(exact).avg === 51 && exact.count === 100);
    const big = new Samples(); for (let i = 1; i <= 200_000; i++) { big.add(i); }
    const bp = percentiles(big);
    // A random reservoir: the median of 4,096 samples has σ ≈ 0.8 % of the range, so allow 5σ to never flake.
    check('Samples: reservoir keeps memory flat and percentiles within ~4%', big.values.length === SAMPLE_CAP && big.count === 200_000 && Math.abs(bp.p50 - 100_000) < 8000 && Math.abs(bp.p95 - 190_000) < 8000 && bp.avg === 100_001, { len: big.values.length, ...bp });
    // Events across three days, one of them older than the window.
    t.record({ type: 'model', sid: 's1', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, promptTokens: 1000, completionTokens: 200, ttftMs: 500, durationMs: 2500, outcome: 'ok' });
    t.record({ type: 'model', sid: 's1', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, durationMs: 90000, outcome: 'error', reason: 'stall' });
    t.record({ type: 'model', sid: 's1', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, durationMs: 100, outcome: 'retry', reason: 'empty' });
    t.record({ type: 'tool', sid: 's1', name: 'read_file', mode: 'agent', durationMs: 12, error: false });
    t.record({ type: 'tool', sid: 's1', name: 'read_file', mode: 'agent', durationMs: 0, error: false, cached: true });
    t.record({ type: 'tool', sid: 's1', name: 'edit_file', mode: 'agent', durationMs: 40, error: true });
    t.record({ type: 'run', sid: 's1', mode: 'agent', model: 'ollama/qwen', depth: 0, outcome: 'done', durationMs: 4000, steps: 3, toolCalls: 3, promptTokens: 1000, completionTokens: 200 });
    t.record({ type: 'run', sid: 's1::explore', mode: 'agent', model: 'ollama/qwen', depth: 1, outcome: 'failed', durationMs: 900, steps: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0 });
    t.record({ type: 'completion', action: 'requested', language: 'ts' });
    t.record({ type: 'completion', action: 'shown', language: 'ts', durationMs: 300, model: 'ollama/small' });
    t.record({ type: 'completion', action: 'accepted', language: 'ts', model: 'ollama/small' });
    t.record({ type: 'completion', action: 'cached', language: 'ts' });
    t.record({ type: 'health', provider: 'ollama', ok: true, durationMs: 10, models: 3 });
    t.record({ type: 'health', provider: 'lmstudio', ok: false, durationMs: 5, error: 'ECONNREFUSED' });
    t.record({ type: 'worktree', action: 'create' });
    t.record({ type: 'worktree', action: 'apply', files: 4, conflicts: 1 });
    t.record({ type: 'run', sid: 'old', mode: 'ask', model: 'm', depth: 0, outcome: 'done', durationMs: 1, steps: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, t: now - 10 * DAY });
    t.log('info', 'hello');
    t.log('error', 'boom\nsecond line');
    await t.flush();
    const files = fs.readdirSync(tmp).sort();
    check('events and logs are written to daily files', files.includes('events-2026-10-24.jsonl') && files.includes('events-2026-10-14.jsonl') && files.includes('localpilot-2026-10-24.log'), files);
    check('log lines are single-line with ISO time and level', /^2026-10-24T\S+ \[error\] boom\\nsecond line$/m.test(fs.readFileSync(path.join(tmp, 'localpilot-2026-10-24.log'), 'utf8')));
    const s = await t.summary(7);
    check('summary: totals count only the window', s.totals.runs === 2 && s.totals.done === 1 && s.totals.failed === 1 && s.totals.subagentRuns === 1 && s.totals.modelCalls === 3 && s.totals.modelErrors === 1 && s.totals.retries === 1, s.totals);
    check('summary: tokens and tok/s per model', s.models.length === 1 && s.models[0].promptTokens === 1000 && s.models[0].completionTokens === 200 && s.models[0].tokPerSec === 100 && s.models[0].ttft.p50 === 500 && s.models[0].errors === 1, s.models[0]);
    check('summary: tools with cached and error counts', s.tools.find((x) => x.name === 'read_file')?.calls === 2 && s.tools.find((x) => x.name === 'read_file')?.cached === 1 && s.tools.find((x) => x.name === 'edit_file')?.errors === 1 && s.totals.toolErrors === 1, s.tools);
    check('summary: completions acceptance = accepted / (shown + cached)', s.completions.acceptanceRate === 50 && s.completions.requested === 1 && s.completions.latency.p50 === 300 && s.completions.byLanguage[0]?.language === 'ts', s.completions);
    check('summary: provider health with last state and error', s.health.length === 2 && s.health.find((h) => h.provider === 'ollama')?.up === true && s.health.find((h) => h.provider === 'lmstudio')?.lastError === 'ECONNREFUSED' && s.health.find((h) => h.provider === 'ollama')?.models === 3, s.health);
    check('summary: worktrees, recent problems newest first, one point per day', s.worktrees.applied === 1 && s.worktrees.conflicts === 1 && s.errors.length === 3 && s.series.length === 7 && s.series[6].day === '2026-10-24' && s.series[6].runs === 2, { w: s.worktrees, e: s.errors.length, d: s.series.length });
    check('summary: storage reports files and bytes', s.storage.files === 3 && s.storage.bytes > 0 && s.storage.dir === tmp, s.storage);
    const all = await t.summary(0);
    check('summary(0) includes everything on disk', all.totals.runs === 3 && all.modes.find((m) => m.mode === 'ask')?.runs === 1);
    check('logs(): ring buffer keeps the newest, filters by level and text', t.logs().length === 2 && t.logs({ level: 'error' }).length === 1 && t.logs({ q: 'HELLO' })[0]?.msg === 'hello');
    for (let i = 0; i < 10; i++) { t.log('debug', `line ${i}`); }
    check('logs(): bounded by logBuffer', t.logs().length === 5 && t.logs()[4].msg === 'line 9');
    const exported = JSON.parse(await t.exportJson());
    check('export bundles events and the log buffer', Array.isArray(exported.events) && exported.events.length === 17 && exported.logs.length === 5, { e: exported.events?.length, l: exported.logs?.length });
    const exportFile = path.join(os.tmpdir(), `lp-export-${process.pid}.json`);
    const written = await t.exportTo(exportFile);
    const streamed = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    fs.rmSync(exportFile, { force: true });
    check('streaming export writes the same document', written === 17 && streamed.events.length === 17 && streamed.logs.length === 5 && JSON.stringify(streamed.events) === JSON.stringify(exported.events));
    check('retention 0 keeps everything', (await t.prune()) === 0);
    retention = 7;
    const removed = await t.prune();
    check('prune removes files older than the retention window', removed === 1 && !fs.existsSync(path.join(tmp, 'events-2026-10-14.jsonl')), removed);
    retention = 0;
    const t2 = new Telemetry({ dir: tmp, retentionDays: () => 0, now: () => now });
    await t2.loadRecentLogs();
    check('loadRecentLogs seeds the viewer from today\'s file', t2.logs().length === 12 && t2.logs()[1].msg === 'boom\nsecond line' && t2.logs()[1].level === 'error', t2.logs().length);
    const off = new Telemetry({ dir: tmp, retentionDays: () => 0, enabled: () => false, now: () => now });
    off.record({ type: 'worktree', action: 'discard' });
    await off.flush();
    check('disabled telemetry records nothing', (await off.summary(1)).worktrees.discarded === 0);
    await t.clear();
    check('clear removes every file and empties the log buffer', fs.readdirSync(tmp).length === 0 && t.logs().length === 0);
    // Aggregation is pure: a stream of events from a torn write is tolerated by events().
    fs.writeFileSync(path.join(tmp, 'events-2026-10-24.jsonl'), '{"t":1,"type":"worktree","action":"create"}\n{"t":2,"ty');
    check('torn trailing line is skipped', (await t.summary(0)).worktrees.created === 1);
    now += DAY;
    const empty = summarize([] as TelemetryEvent[], { days: 1, from: now, to: now });
    check('summarize([]) yields zeros and one series point', empty.totals.runs === 0 && empty.series.length === 1 && empty.completions.acceptanceRate === 0);
    // The dashboard passes the enabled provider ids: a disabled or made-up provider disappears along with its calls.
    const mixed: TelemetryEvent[] = [
      { t: now, type: 'health', provider: 'ollama', ok: true, durationMs: 5, models: 2 },
      { t: now, type: 'health', provider: 'fake', ok: true, durationMs: 5, models: 3 },
      { t: now, type: 'model', sid: 's', model: 'a', provider: 'ollama', mode: 'agent', depth: 0, promptTokens: 10, completionTokens: 5, durationMs: 50, outcome: 'ok' },
      { t: now, type: 'model', sid: 's', model: 'b', provider: 'fake', mode: 'agent', depth: 0, promptTokens: 100, completionTokens: 50, durationMs: 50, outcome: 'ok' },
    ];
    const everyProvider = summarize(mixed, { days: 1, from: now, to: now });
    const only = summarize(mixed, { days: 1, from: now, to: now }, { providers: ['ollama'] });
    check('unfiltered summary keeps every provider', everyProvider.health.length === 2 && everyProvider.models.length === 2 && everyProvider.totals.promptTokens === 110);
    check('provider filter drops other providers from health, models and totals', only.health.length === 1 && only.health[0].provider === 'ollama' && only.models.length === 1 && only.totals.modelCalls === 1 && only.totals.promptTokens === 10);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function skillsInHarness() {
  console.log('\n[Skills in the agent harness: preload, subagent inheritance, swarm, dedupe]');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-skills-'));
  const mk = (name: string, description: string, body: string) => {
    fs.mkdirSync(path.join(tmp, name), { recursive: true });
    fs.writeFileSync(path.join(tmp, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n${body}\n`);
  };
  mk('zorblax-release', 'Cut a zorblax release end to end. Use for "cut a zorblax release".', '1. bump\n2. tag ZORBLAX-RELEASE-STEPS\n3. publish');
  mk('quuxaudit', 'Audit code for quuxaudit findings.', '1. scan QUUXAUDIT-STEPS\n2. report');
  mk('offlimits', 'A skill the user switched off. Use for "offlimits".', 'SHOULD-NEVER-APPEAR');
  process.env.LP_SKILLS_DISABLED = 'offlimits';
  const seen: Record<string, string> = {};
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'sk', capabilities: ['tool_use'] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      const msgs = body.messages as { role: string; content: string }[];
      const transcript = JSON.stringify(msgs);
      const task = String(msgs.find((m) => m.role === 'user')?.content ?? '');
      const system = String(msgs.find((m) => m.role === 'system')?.content ?? '');
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = (t: string) => { send({ choices: [{ delta: { content: t } }] }); send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); };
      const tool = (id: string, name: string, args: unknown) => { send({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }); send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }); };
      const has = (re: RegExp) => re.test(transcript);
      if (task.includes('CHILD-X')) {
        seen.x = `release=${has(/<skill name=\\"zorblax-release\\"/)} audit=${has(/<skill name=\\"quuxaudit\\"/)} offlimits=${has(/SHOULD-NEVER-APPEAR/)} loadSkillTool=${JSON.stringify(body.tools ?? []).includes('"load_skill"')} indexHasOfflimits=${/- offlimits:/.test(system)}`;
        text('X-REPORT');
      } else if (task.includes('CHILD-Y')) {
        seen.y = `release=${has(/<skill name=\\"zorblax-release\\"/)} audit=${has(/<skill name=\\"quuxaudit\\"/)} inherited=${has(/delegated this task is working with it/)}`;
        text('Y-REPORT');
      } else if (task.includes('SWARM-GO')) {
        seen.parent = `preloaded=${has(/<skill name=\\"zorblax-release\\"/)} reason=${has(/because it matches this request/)}`;
        if (has(/Y-REPORT/)) { text('Swarm done.'); } else { tool('s1', 'run_parallel_subagents', { tasks: [{ agent: 'explore', prompt: 'CHILD-X look around the repo' }, { agent: 'coder', prompt: 'CHILD-Y run the quuxaudit on src' }] }); }
      } else if (task.includes('DEDUPE-GO')) {
        if (has(/items completed/)) { text('Dedupe done.'); } else { tool('d1', 'run_todos_parallel', { tasks: [{ title: 'Create ONE', agent: 'coder', prompt: 'make ONE' }, { title: 'Create TWO', agent: 'coder', prompt: 'make TWO' }] }); }
      } else if (task.includes('make ONE') || task.includes('make TWO')) {
        text('made');
      } else if (task.includes('MANGLED-GO')) {
        if (has(/Resolved \\"Zorblax Release\\"/)) { text(`loaded:${has(/ZORBLAX-RELEASE-STEPS/)}`); } else { tool('m1', 'load_skill', { name: 'Zorblax Release' }); }
      } else if (task.includes('BOGUS-GO')) {
        if (has(/Unknown skill \\"turbo-wizard\\"/)) { text(`refused:${has(/Only these skills exist/)}:${has(/Do not invent skill names/)}`); } else { tool('b1', 'load_skill', { name: 'turbo-wizard' }); }
      } else if (task.includes('DISABLED-GO')) {
        if (has(/disabled by the user/)) { text(`refused:${!has(/SHOULD-NEVER-APPEAR/)}`); } else { tool('x1', 'load_skill', { name: 'offlimits' }); }
      } else if (task.includes('BRIEF-GO') || task.includes('LONG-GO')) {
        seen[task.includes('BRIEF-GO') ? 'brief' : 'long'] = `preloaded=${has(/<skill name=\\"quuxaudit\\"/)} hinted=${has(/Skills that may apply/)}`;
        text('Audit done.');
      } else {
        text('?');
      }
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
    const skills = new SkillManager(log, tmp);
    await skills.refresh();
    const workspace = new WorkspaceContext(log);
    tools.register({ parallelSafe: true, definition: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }, async execute(args) { return { content: `ECHO:${args.text}` }; } });
    const runner = new AgentRunner(providers, tools, skills, workspace, log);
    const events: AgentEvent[] = [];
    tools.registerAll(createAgentTools(runner, skills, (e) => events.push(e), async () => true));
    const mkSession = (id: string, extra: Partial<Session> = {}): Session => ({ id, title: '', createdAt: 0, updatedAt: 0, model: 'mock/sk', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [], ...extra });
    const run = (s: Session, content: string) => runner.run({ session: s, userMessage: { role: 'user', content }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });

    const names = skills.enabledSkills.map((k) => k.name);
    check('disabled skill is loaded from disk but hidden from the agent', names.includes('zorblax-release') && names.includes('quuxaudit') && !names.includes('offlimits') && !!skills.getSkill('offlimits')?.disabled, names);
    check('load_skill definition lists only enabled skills', (() => { const d = tools.get('load_skill')!.definition; const desc = JSON.stringify(d.parameters); return desc.includes('zorblax-release') && !desc.includes('offlimits'); })());

    // 1. Parent: a trigger phrase preloads the skill; the swarm inherits it, and a worker also gets its own strong match.
    const s1 = mkSession('sk1');
    const out1 = await run(s1, 'SWARM-GO please cut a zorblax release for v2');
    check('parent: strong trigger-phrase match preloads the skill body into the request', seen.parent === 'preloaded=true reason=true' && out1 === 'Swarm done.', { seen: seen.parent, out1 });
    check('parent: Using skill status + skill_suggestions carries preloaded', events.some((e) => e.type === 'status' && /Using skill zorblax-release/.test(String(e.payload))) && events.some((e) => e.type === 'skill_suggestions' && JSON.stringify((e.payload as { preloaded?: unknown }).preloaded).includes('zorblax-release')));
    check('worker X (explore): inherits the parent skill, not the disabled one; has load_skill; index hides disabled', seen.x === 'release=true audit=false offlimits=false loadSkillTool=true indexHasOfflimits=false', seen.x);
    check('worker Y (coder): inherits the parent skill AND gets its own strong match, marked as inherited', seen.y === 'release=true audit=true inherited=true', seen.y);

    // 2. run_todos_parallel with inline tasks that repeat pending checklist items runs those items instead of duplicating them.
    const s2 = mkSession('sk2', { todos: [{ id: '1', title: 'Create ONE', status: 'pending', agent: 'coder', prompt: 'make ONE' }, { id: '2', title: 'Create TWO', status: 'pending', agent: 'coder', prompt: 'make TWO' }] });
    const out2 = await run(s2, 'DEDUPE-GO');
    const fan = s2.messages.find((m) => m.role === 'tool' && m.toolName === 'run_todos_parallel');
    check('run_todos_parallel: inline tasks matching pending items run them in place (no duplicates, both done)', out2 === 'Dedupe done.' && s2.todos?.length === 2 && s2.todos.every((t) => t.status === 'done' && t.result === 'made') && /2\/2 items completed/.test(fan?.content ?? ''), { out2, todos: s2.todos, fan: fan?.content.slice(0, 120) });

    // 3. load_skill tolerates a mangled name, refuses invented and disabled ones with guidance.
    const out3 = await run(mkSession('sk3'), 'MANGLED-GO');
    check('load_skill: "Zorblax Release" resolves to zorblax-release and returns the body', out3 === 'loaded:true', out3);
    const out4 = await run(mkSession('sk4'), 'BOGUS-GO');
    check('load_skill: an invented name is refused with the real list and an anti-hallucination note', out4 === 'refused:true:true', out4);
    const out5 = await run(mkSession('sk5'), 'DISABLED-GO');
    check('load_skill: a disabled skill is refused and its body never reaches the model', out5 === 'refused:true', out5);

    // 4. A loose match (description words only, no name / trigger phrase) is preloaded for a brief request, hinted for a long one.
    const out6 = await run(mkSession('sk6'), 'BRIEF-GO audit src for findings');
    check('brief request + single loose match: skill preloaded, no load_skill round trip needed', out6 === 'Audit done.' && seen.brief === 'preloaded=true hinted=false', { out6, seen: seen.brief });
    const out7 = await run(mkSession('sk7'), `LONG-GO audit src for findings ${'and also look very carefully at every single module in the tree '.repeat(2)}then report`);
    check('long request + loose match: only hinted (model decides)', out7 === 'Audit done.' && seen.long === 'preloaded=false hinted=true', { out7, seen: seen.long });
  } finally {
    srv.close();
    delete process.env.LP_SKILLS_DISABLED;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Chat surface closed and reopened while an agent runs: the new webview must get the run in flight back — the live
 * turn's events, the approval the agent is waiting on — without the surfaces that stayed open receiving anything
 * twice, and `session` messages must tell the UI where the live turn starts so a tab switch never shows steps twice.
 */
async function reopenReplay() {
  console.log('\n[Chat reopen: replay of a run in flight]');
  const vscode = await import('vscode');
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'reopen', capabilities: ['tool_use'] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      const transcript = JSON.stringify(body.messages);
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (transcript.includes('GATE-PASSED')) {
        send({ choices: [{ delta: { content: 'All ' } }] });
        send({ choices: [{ delta: { content: 'clear.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else {
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'g1', function: { name: 'gate', arguments: '{}' } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
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
    await skills.refresh();
    const workspace = new WorkspaceContext(log);
    // A tool that needs permission: the run holds inside requestApproval until the UI answers.
    tools.register({ parallelSafe: true, definition: { name: 'gate', description: 'gated', parameters: { type: 'object', properties: {} } }, async execute(_args, ctx) { const ok = await ctx.requestApproval('Open the gate', 'gate --now', 'delete'); return { content: ok ? 'GATE-PASSED' : 'GATE-DENIED' }; } });
    const runner = new AgentRunner(providers, tools, skills, workspace, log);
    const store = new SessionStore({ storageUri: vscode.Uri.file('/tmp/lp-smoke-reopen') } as unknown as import('vscode').ExtensionContext, log);
    const tracker = { onDidChange: new vscode.EventEmitter<void>().event, beginTurn() {}, forSession: () => [], keep() {}, restoreToTurn: async () => 0 } as unknown as ChangeTracker;
    const controller = new ChatController(store, runner, providers, skills, workspace, tracker, log);

    const first: ToWebview[] = [];
    let firstVisible = true;
    controller.attach({ post: (m) => first.push(m), visible: () => firstVisible });
    const session = store.create('mock/reopen');
    const has = (list: ToWebview[], type: string) => list.filter((m) => m.type === type);

    const run = controller.send(session.id, 'APPROVE-GO', []);
    for (let i = 0; i < 100 && !has(first, 'approval').length; i++) { await new Promise((r) => setTimeout(r, 50)); }
    const approval = has(first, 'approval')[0] as Extract<ToWebview, { type: 'approval' }> | undefined;
    check('run holds at the approval prompt in the attached chat', !!approval && controller.isRunning(session.id), approval);

    // The chat is closed (view disposed) and reopened: a brand-new webview announces `ready`.
    const second: ToWebview[] = [];
    const firstBefore = first.length;
    let secondVisible = true;
    const secondSink = { post: (m: ToWebview) => second.push(m), visible: () => secondVisible };
    controller.attach(secondSink);
    await controller.sendInit(secondSink);
    const init = has(second, 'init')[0] as Extract<ToWebview, { type: 'init' }> | undefined;
    const sess = has(second, 'session')[0] as Extract<ToWebview, { type: 'session' }> | undefined;
    const replay = has(second, 'replay')[0] as Extract<ToWebview, { type: 'replay' }> | undefined;
    check('reopen: init lists the run as running', !!init && init.running.includes(session.id), init?.running);
    check('reopen: session says where the live turn starts (after the user message)', !!sess && sess.liveFrom === 1 && sess.session.messages[0]?.role === 'user' && sess.session.messages.length > 1, { liveFrom: sess?.liveFrom, len: sess?.session.messages.length });
    const kinds = (replay?.items ?? []).map((m) => (m.type === 'event' ? m.event.type : m.type));
    check('reopen: replay carries the tool_start and the pending approval, in order', !!replay && kinds.includes('tool_start') && kinds.indexOf('tool_start') < kinds.indexOf('approval') && (replay.items.find((m) => m.type === 'approval') as { id?: string } | undefined)?.id === approval?.id && replay.startedAt > 0 && !replay.truncated, kinds);
    check('reopen: the surface that stayed open received nothing again', first.length === firstBefore, first.slice(firstBefore).map((m) => m.type));

    // Hiding every surface while the prompt waits mirrors it as a notification exactly once.
    const notes = (vscode.window as unknown as { notifications: string[] }).notifications;
    const n0 = notes.length;
    firstVisible = false; secondVisible = false;
    controller.surfaceVisibilityChanged();
    controller.surfaceVisibilityChanged();
    check('hidden chat: the pending approval is mirrored as one notification', notes.length === n0 + 1 && /Open the gate/.test(notes[n0] ?? ''), notes.slice(n0));

    // Answer from the webview: the run continues, both surfaces see the prompt resolved, replay forgets it.
    await controller.handle({ type: 'approval', id: approval!.id, approved: true });
    const out = await run;
    check('approval answered: run completes with the gated answer', out === 'All clear.', out);
    check('approval answered: both surfaces get approvalResolved', has(first, 'approvalResolved').length === 1 && has(second, 'approvalResolved').length === 1);
    check('run finished: running:false broadcast and no replay kept', has(second, 'running').some((m) => m.type === 'running' && !m.running) && !controller.isRunning(session.id));

    // After the run, `session` messages carry the whole transcript (no liveFrom): the settled turn is drawn from the store.
    second.length = 0;
    await controller.handle({ type: 'selectSession', id: session.id });
    const settled = has(second, 'session')[0] as Extract<ToWebview, { type: 'session' }> | undefined;
    check('settled: session has no liveFrom and the full transcript', !!settled && settled.liveFrom === undefined && settled.session.messages.filter((m) => !m.meta?.hidden).map((m) => m.role).join(',') === 'user,assistant,tool,assistant', settled?.session.messages.map((m) => m.role));

    // Stopping a run denies its pending prompt and takes it down everywhere (a fresh chat: the loop caches identical tool calls per session).
    first.length = 0; second.length = 0;
    const other = store.create('mock/reopen');
    const run2 = controller.send(other.id, 'APPROVE-GO', []);
    for (let i = 0; i < 100 && !has(first, 'approval').length; i++) { await new Promise((r) => setTimeout(r, 50)); }
    check('stop: a second chat raises its own prompt', has(first, 'approval').length === 1);
    controller.stop(other.id);
    await run2;
    check('stop: pending approval resolved as denied and removed from both surfaces', has(first, 'approvalResolved').length === 1 && has(second, 'approvalResolved').length === 1 && !controller.isRunning(other.id), { first: first.map((m) => m.type), second: second.map((m) => m.type) });
    controller.dispose();
  } finally {
    srv.close();
    delete process.env.LP_MOCK_URL;
  }
}

async function parallelModels() {
  console.log('\n[Parallel models: a fan-out on a serial model spreads workers to a comparable idle model]');
  const used: Record<string, string> = {};
  const srv = await listen(async (req, res) => {
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:3b', capabilities: ['tool_use'] }, { id: 'qwen2.5-coder:1.5b', capabilities: ['tool_use'] }] }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req));
      const msgs = body.messages as { role: string; content: string }[];
      const transcript = JSON.stringify(msgs);
      const task = String(msgs.find((m) => m.role === 'user')?.content ?? '');
      res.setHeader('content-type', 'text/event-stream');
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const text = (t: string) => { send({ choices: [{ delta: { content: t } }] }); send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); };
      const tool = (id: string, name: string, args: unknown) => { send({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }); send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }); };
      if (task.includes('SPREAD-GO')) {
        used.parent = body.model;
        if (/W1-REPORT/.test(transcript) && /W2-REPORT/.test(transcript)) { text('Spread done.'); } else { tool('p1', 'run_parallel_subagents', { tasks: [{ agent: 'coder', prompt: 'W1 do the first half' }, { agent: 'coder', prompt: 'W2 do the second half' }] }); }
      } else if (/^W[12] /.test(task)) {
        const w = task.slice(0, 2);
        used[w] = body.model;
        // Keep the lane busy for a moment so the second worker routes while the first still holds its model.
        await new Promise((r) => setTimeout(r, 250));
        text(`${w}-REPORT`);
      } else {
        text('?');
      }
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
    await skills.refresh();
    const workspace = new WorkspaceContext(log);
    const runner = new AgentRunner(providers, tools, skills, workspace, log);
    const events: AgentEvent[] = [];
    tools.registerAll(createAgentTools(runner, skills, (e) => events.push(e), async () => true));
    const mkSession = (id: string): Session => ({ id, title: '', createdAt: 0, updatedAt: 0, model: 'mock/qwen2.5-coder:3b', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] });
    const run = (s: Session, content: string) => runner.run({ session: s, userMessage: { role: 'user', content }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true });

    // 1. Nothing known about the server: both workers inherit the parent's model (no spreading on a guess).
    const out0 = await run(mkSession('pm0'), 'SPREAD-GO');
    check('unknown server: workers stay on the inherited model', out0 === 'Spread done.' && used.W1 === 'qwen2.5-coder:3b' && used.W2 === 'qwen2.5-coder:3b', { out0, used: { ...used } });

    // 2. The model is known to answer one request at a time: the second worker runs on the comparable idle model.
    runner.markServedSerially('mock/qwen2.5-coder:3b');
    events.length = 0;
    const out1 = await run(mkSession('pm1'), 'SPREAD-GO');
    const models = [used.W1, used.W2].sort();
    check('serial model: the two workers run on two different models', out1 === 'Spread done.' && models.join(',') === 'qwen2.5-coder:1.5b,qwen2.5-coder:3b', { out1, used: { ...used } });
    check('the parent itself stayed on its own model', used.parent === 'qwen2.5-coder:3b', used.parent);
    const reasons = events.filter((e) => e.type === 'status' && typeof e.payload === 'object' && e.payload && /busy with 1 other request — running this on qwen2.5-coder:1.5b alongside/.test(String((e.payload as { data?: unknown }).data)));
    check('the spread is announced on the worker lane', reasons.length === 1, events.filter((e) => e.type === 'status').map((e) => JSON.stringify(e.payload)).slice(0, 8));
    const req = events.filter((e) => e.type === 'model_request' && (e.payload as { childId?: string }).childId).map((e) => ((e.payload as { data: { model: string } }).data.model));
    check("each worker's model_request names the model that really answers it", req.sort().join(',') === 'mock/qwen2.5-coder:1.5b,mock/qwen2.5-coder:3b', req);
    check('once the run ends no model is left assigned', runner.load.assigned.size === 0, [...runner.load.assigned]);

    // 3. Setting off: everything queues on the inherited model again.
    process.env.LP_CONFIG = JSON.stringify({ 'routing.parallelModels': false });
    const out2 = await run(mkSession('pm2'), 'SPREAD-GO');
    check('routing.parallelModels off: no spreading', out2 === 'Spread done.' && used.W1 === 'qwen2.5-coder:3b' && used.W2 === 'qwen2.5-coder:3b', { ...used });
    delete process.env.LP_CONFIG;
  } finally {
    srv.close();
    delete process.env.LP_MOCK_URL;
  }
}

/** A tiny in-process Redis: just the commands the telemetry backend uses, with real RESP framing on a TCP socket. */
async function fakeRedis(opts: { timeseries: boolean; password?: string }): Promise<{ url: string; close(): void; streams: Map<string, [string, string[]][]>; ts: Map<string, number[][]>; commands: string[][] }> {
  const net = await import('net');
  const streams = new Map<string, [string, string[]][]>();
  const ts = new Map<string, number[][]>();
  const commands: string[][] = [];
  let seq = 0;
  const bulk = (s: string | null) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
  const arr = (items: string[]) => `*${items.length}\r\n${items.join('')}`;
  const idMs = (id: string) => Number(id.split('-')[0]);
  const answer = (a: string[], authed: { ok: boolean }): string => {
    const cmd = a[0].toUpperCase();
    if (opts.password && !authed.ok && cmd !== 'AUTH') { return '-NOAUTH Authentication required.\r\n'; }
    switch (cmd) {
      case 'AUTH': authed.ok = a[a.length - 1] === opts.password; return authed.ok ? '+OK\r\n' : '-WRONGPASS invalid password\r\n';
      case 'PING': return '+PONG\r\n';
      case 'INFO': return bulk(a[1] === 'memory' ? 'used_memory_human:1.2M\r\n' : 'redis_version:7.4.0\r\n');
      case 'XADD': {
        const key = a[1]; const list = streams.get(key) ?? []; streams.set(key, list);
        let i = 2;
        if (a[i] === 'MINID') { const min = Number(a[i + 2]); i += 3; for (let k = list.length - 1; k >= 0; k--) { if (idMs(list[k][0]) < min) { list.splice(k, 1); } } }
        else if (a[i] === 'MAXLEN') { const max = Number(a[i + 2]); i += 3; while (list.length >= max) { list.shift(); } }
        const id = `${Date.now()}-${seq++}`; list.push([id, a.slice(i + 1)]); return bulk(id);
      }
      case 'XRANGE': {
        const list = streams.get(a[1]) ?? []; const start = a[2]; const count = Number(a[5] ?? Infinity);
        const excl = start.startsWith('('); const s = excl ? start.slice(1) : start;
        const cmp = (id: string) => { const [m1, q1] = id.split('-').map(Number); const [m2, q2] = (s.includes('-') ? s : `${s}-0`).split('-').map(Number); return m1 - m2 || q1 - q2; };
        const rows = list.filter(([id]) => start === '-' || (excl ? cmp(id) > 0 : cmp(id) >= 0)).slice(0, count);
        return arr(rows.map(([id, f]) => arr([bulk(id), arr(f.map(bulk))])));
      }
      case 'XREVRANGE': { const list = streams.get(a[1]) ?? []; const count = Number(a[5] ?? Infinity); const rows = list.slice().reverse().slice(0, count); return arr(rows.map(([id, f]) => arr([bulk(id), arr(f.map(bulk))]))); }
      case 'XLEN': return `:${(streams.get(a[1]) ?? []).length}\r\n`;
      case 'MEMORY': return `:${JSON.stringify(streams.get(a[2]) ?? []).length}\r\n`;
      case 'XTRIM': { const list = streams.get(a[1]) ?? []; const min = Number(a[4]); const before = list.length; streams.set(a[1], list.filter(([id]) => idMs(id) >= min)); return `:${before - (streams.get(a[1]) ?? []).length}\r\n`; }
      case 'DEL': { let n = 0; for (const k of a.slice(1)) { n += Number(streams.delete(k)) + Number(ts.delete(k)); } return `:${n}\r\n`; }
      case 'SCAN': return arr([bulk('0'), arr([...ts.keys()].map(bulk))]);
      case 'TS.INFO': return opts.timeseries ? '-ERR TSDB: the key does not exist\r\n' : `-ERR unknown command 'TS.INFO'\r\n`;
      case 'TS.ALTER': return ts.has(a[1]) ? '+OK\r\n' : '-ERR TSDB: the key does not exist\r\n';
      case 'TS.ADD': { if (!opts.timeseries) { return `-ERR unknown command 'TS.ADD'\r\n`; } const pts = ts.get(a[1]) ?? []; ts.set(a[1], pts); pts.push([Number(a[2]), Number(a[3])]); return `:${a[2]}\r\n`; }
      default: return `-ERR unknown command '${a[0]}'\r\n`;
    }
  };
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0); const authed = { ok: false };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]); let at = 0; let out = '';
      for (;;) { const r = parseReply(buf, at); if (!r) { break; } at = r.next; const a = (r.value as string[]).map(String); commands.push(a); out += answer(a, authed); }
      buf = buf.subarray(at);
      if (out) { sock.write(out); }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as import('net').AddressInfo).port;
  return { url: `redis://${opts.password ? `:${opts.password}@` : ''}127.0.0.1:${port}`, close: () => srv.close(), streams, ts, commands };
}

async function redisStorage() {
  console.log('\n--- optional Redis Stack storage');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  // RESP framing: partial buffers wait, nested arrays and errors parse.
  const whole = Buffer.from('*2\r\n$5\r\nhello\r\n*2\r\n:42\r\n-ERR bad\r\n');
  const parsed = parseReply(whole)?.value as unknown[];
  check('RESP: nested arrays, integers and error replies', parsed?.[0] === 'hello' && (parsed?.[1] as unknown[])[0] === 42 && (parsed?.[1] as unknown[])[1] instanceof RedisError);
  check('RESP: an incomplete reply waits for more bytes', parseReply(whole.subarray(0, 12)) === undefined && parseReply(Buffer.from('$-1\r\n'))?.value === null);
  check('Redis URL: auth, db, TLS and redaction', JSON.stringify(parseRedisUrl('rediss://u:p%40ss@h:6380/2')) === JSON.stringify({ host: 'h', port: 6380, tls: true, username: 'u', password: 'p@ss', db: 2 }) && redactRedisUrl('redis://:secret@h:1') === 'redis://:***@h:1' && (() => { try { parseRedisUrl('http://x'); return false; } catch { return true; } })());
  const ev = { t: 1, type: 'model', sid: 's', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, promptTokens: 10, completionTokens: 5, ttftMs: 100, durationMs: 900, outcome: 'ok' } as TelemetryEvent;
  check('time series samples: model latency, ttft and token counts with labels', samplesOf(ev).map((s) => s.key.replace('localpilot:ts:', '')).join(',') === 'model:ollama/qwen:duration_ms,model:ollama/qwen:ttft_ms,model:ollama/qwen:completion_tokens,model:ollama/qwen:prompt_tokens' && samplesOf(ev)[0].labels.metric === 'duration_ms');

  const red = await fakeRedis({ timeseries: true, password: 'pw' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-redis-'));
  const remote = new RedisTelemetry(red.url);
  let remoteErrors = 0;
  let up = true;
  const now = Date.now();
  const t = new Telemetry({ dir: tmp, retentionDays: () => 30, now: () => now, remote: () => (up ? remote : undefined), onRemoteError: () => remoteErrors++ });
  try {
    const client = new RedisClient(red.url);
    // Several callers racing on a cold connection must all wait for AUTH; none may reach the server unauthenticated.
    const raced = await Promise.all([client.command('PING'), client.command('PING'), client.command('INFO', 'server')]);
    const firstCmds = red.commands.slice(0, 2).map((c) => c[0]);
    check('RedisClient: concurrent first commands share one authenticated connection', raced[0] === 'PONG' && raced[1] === 'PONG' && firstCmds[0] === 'AUTH' && red.commands.filter((c) => c[0] === 'AUTH').length === 1 && !red.commands.some((c, i) => i > 0 && c[0] !== 'AUTH' && red.commands.slice(0, i).every((p) => p[0] !== 'AUTH')), { firstCmds, auths: red.commands.filter((c) => c[0] === 'AUTH').length });
    check('RedisClient: AUTH then commands in order over one connection', (await client.command('PING')) === 'PONG' && red.commands[0][0] === 'AUTH');
    const bad = new RedisClient(red.url.replace(':pw@', ':nope@'));
    let authError = '';
    await bad.command('PING').catch((e) => (authError = String(e)));
    check('RedisClient: a wrong password fails clearly', /WRONGPASS/.test(authError), authError);
    client.close(); bad.close();
    const probe = await remote.probe();
    check('probe: reachable Redis Stack with RedisTimeSeries', probe.ok && probe.timeseries && probe.version === '7.4.0' && probe.usedMemory === '1.2M', probe);

    t.record(ev);
    t.record({ type: 'tool', sid: 's', name: 'read_file', mode: 'agent', durationMs: 12, error: false });
    t.record({ type: 'run', sid: 's', mode: 'agent', model: 'ollama/qwen', depth: 0, outcome: 'done', durationMs: 4000, steps: 3, toolCalls: 1, promptTokens: 10, completionTokens: 5 });
    t.log('info', 'hello redis');
    await t.flush();
    check('events and log lines go to Redis streams, not files', red.streams.get('localpilot:events')?.length === 3 && red.streams.get('localpilot:logs')?.length === 1 && !fs.readdirSync(tmp).length, { files: fs.readdirSync(tmp), n: red.streams.get('localpilot:events')?.length });
    check('stream writes are trimmed by retention (MINID)', red.commands.some((c) => c[0] === 'XADD' && c[2] === 'MINID'));
    check('metrics become labelled time series', red.ts.has('localpilot:ts:model:ollama/qwen:ttft_ms') && red.ts.has('localpilot:ts:tool:read_file:duration_ms') && red.commands.some((c) => c[0] === 'TS.ADD' && c.includes('LABELS') && c.includes('localpilot')));
    const s = await t.summary(7);
    check('dashboard summary reads the history back from Redis', s.totals.runs === 1 && s.totals.modelCalls === 1 && s.models[0]?.ttft.p50 === 100 && s.storage.events === 3 && /Redis/.test(s.storage.dir) && s.storage.backend === 'redis', { runs: s.totals.runs, ev: s.storage.events, dir: s.storage.dir, backend: s.storage.backend });
    const beforePrune = red.commands.length;
    await remote.prune(Date.now() - 7 * 86400_000);
    const alters = red.commands.slice(beforePrune).filter((c) => c[0] === 'TS.ALTER' && c[2] === 'RETENTION');
    check('prune re-applies the retention to every time series (TS.ALTER)', alters.length === red.ts.size && alters.every((c) => Math.abs(Number(c[3]) - 7 * 86400_000) < 5000), { alters: alters.length, series: red.ts.size });
    t.log('info', 'tail line from redis');
    await t.flush();
    const t3 = new Telemetry({ dir: tmp, retentionDays: () => 30, now: () => now, remote: () => remote });
    await t3.loadRecentLogs(10);
    check('the log viewer seeds from the Redis log stream', t3.logs().some((l) => l.msg === 'tail line from redis') && t3.logs().some((l) => l.msg === 'hello redis'));

    // Redis goes away: the batch lands in files and nothing is lost; the summary merges both.
    red.close();
    remote.dispose();
    t.record({ type: 'worktree', action: 'create' });
    await t.flush();
    check('Redis down: the batch falls back to files', remoteErrors >= 1 && fs.readdirSync(tmp).some((f) => f.startsWith('events-')), { remoteErrors, files: fs.readdirSync(tmp) });
    const errorsBefore = remoteErrors;
    const down = await t.summary(7);
    check('Redis down: the summary says so, with the reason, and does not retry on every refresh', down.storage.backend === 'fallback' && !!down.storage.remoteError && /unreachable/.test(down.storage.dir) && remoteErrors === errorsBefore, { backend: down.storage.backend, err: down.storage.remoteError, retries: remoteErrors - errorsBefore });
    up = false;
    check('files-only summary still works after a fallback', (await t.summary(7)).worktrees.created === 1);

    // Plain Redis without the TimeSeries module: streams only, no TS.ADD.
    const plain = await fakeRedis({ timeseries: false });
    const plainRemote = new RedisTelemetry(plain.url);
    const t2 = new Telemetry({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lp-redis2-')), retentionDays: () => 0, now: () => now, remote: () => plainRemote });
    t2.record(ev);
    await t2.flush();
    check('plain Redis: events stored, no time-series commands sent', plain.streams.get('localpilot:events')?.length === 1 && !plain.commands.some((c) => c[0] === 'TS.ADD') && !(await plainRemote.probe()).timeseries);
    await t2.clear();
    check('clear() empties the Redis streams too', !plain.streams.get('localpilot:events')?.length);
    plainRemote.dispose();
    plain.close();
  } finally {
    remote.dispose();
    red.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await telemetry();
  await redisStorage();
  await worktrees();
  await mockOllama();
  await mockOpenAI();
  await cloudProviders();
  await cloudAgentE2E();
  await cloudResilience();
  await colibriSetupChecks();
  await gatewayChecks();
  await pureLogic();
  await agentLoopE2E();
  await pauseAndSteer();
  await reopenReplay();
  await skillsInHarness();
  await parallelModels();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
