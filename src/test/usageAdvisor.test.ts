import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { watchdogFor } from '../agent/agentLoop';
import { modelFootprintGb } from '../providers/catalog';
import { colibriRoot, colibriServeCommand, colibriSlots, colibriSpec, coliLauncher, streamsFromDisk } from '../providers/colibri';
import { probeProvider, providersFromContainers } from '../providers/discovery';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { isSaturated, pickForRole, scoreForRole } from '../providers/registry';
import { buildProfile } from '../providers/system';
import { analyzeUsage, evidenceCount, runRole, suggestModels, successRate, usageBonus } from '../providers/usageAdvisor';
import { TelemetryEvent } from '../telemetry/telemetry';
import { ModelInfo } from '../types';

const NOW = Date.UTC(2026, 9, 27, 12);
const profile = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 10, ramGb: 32, vramGb: 0 });

function model(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  const slash = id.indexOf('/');
  return { id, providerId: id.slice(0, slash), modelId: id.slice(slash + 1), name: id.slice(slash + 1), contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: false, ...extra };
}

let t = NOW - 3600_000;
function run(m: string, outcome: 'done' | 'failed' | 'stopped', extra: Partial<Extract<TelemetryEvent, { type: 'run' }>> = {}): TelemetryEvent {
  return { type: 'run', t: (t += 1000), sid: 's', mode: 'agent', model: m, depth: 0, outcome, durationMs: 20_000, steps: 4, toolCalls: 3, promptTokens: 1000, completionTokens: 200, ...extra };
}
function call(m: string, tps: number, extra: Partial<Extract<TelemetryEvent, { type: 'model' }>> = {}): TelemetryEvent {
  const slash = m.indexOf('/');
  return { type: 'model', t: (t += 1000), sid: 's', provider: m.slice(0, slash), model: m.slice(slash + 1), mode: 'agent', depth: 0, promptTokens: 800, completionTokens: 200, ttftMs: 1000, durationMs: 1000 + (200 / tps) * 1000, outcome: 'ok', ...extra };
}
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

suite('Usage advisor', () => {
  test('infers the routing role of runs recorded before roles were logged', () => {
    assert.strictEqual(runRole(run('a/x', 'done') as Extract<TelemetryEvent, { type: 'run' }>), 'agent');
    assert.strictEqual(runRole(run('a/x', 'done', { mode: 'plan' }) as Extract<TelemetryEvent, { type: 'run' }>), 'reasoning');
    assert.strictEqual(runRole(run('a/x', 'done', { depth: 1, agent: 'explore' }) as Extract<TelemetryEvent, { type: 'run' }>), 'fast');
    assert.strictEqual(runRole(run('a/x', 'done', { depth: 1, agent: 'coder' }) as Extract<TelemetryEvent, { type: 'run' }>), 'coding');
    assert.strictEqual(runRole(run('a/x', 'done', { depth: 1, role: 'fast' }) as Extract<TelemetryEvent, { type: 'run' }>), 'fast');
  });

  test('aggregates speed, errors, runs per role and completion acceptance per model', () => {
    const events: TelemetryEvent[] = [
      ...times(4, () => call('ollama/fast:7b', 40)),
      call('ollama/fast:7b', 40, { outcome: 'error', reason: 'boom' }),
      ...times(3, () => run('ollama/fast:7b', 'done')),
      run('ollama/fast:7b', 'failed', { mode: 'plan' }),
      { type: 'completion', t: NOW, action: 'shown', model: 'ollama/fim:1b', durationMs: 300 },
      { type: 'completion', t: NOW, action: 'accepted', model: 'ollama/fim:1b' },
    ];
    const u = analyzeUsage(events, { now: NOW });
    const fast = u.models.get('ollama/fast:7b')!;
    assert.strictEqual(fast.calls, 5);
    assert.strictEqual(fast.errors, 1);
    assert.ok(Math.abs(fast.completionTokens / fast.genMs * 1000 - 40) < 0.5);
    assert.strictEqual(fast.roles.agent?.runs, 3);
    assert.strictEqual(fast.roles.reasoning?.failed && fast.roles.reasoning.runs, 1);
    assert.deepStrictEqual(u.models.get('ollama/fim:1b')!.completions, { shown: 1, accepted: 1, latency: [300] });
    assert.strictEqual(u.runs, 4);
  });

  test('older runs weigh less than recent ones', () => {
    const old = analyzeUsage([{ ...run('a/x', 'failed'), t: NOW - 14 * 86400_000 } as TelemetryEvent], { now: NOW });
    assert.ok(old.models.get('a/x')!.roles.agent!.failed < 0.3);
  });

  test('reliable fast models earn a bonus, failing ones lose more than a few points', () => {
    const events = [...times(8, () => run('a/good', 'done')), ...times(6, () => call('a/good', 60)), ...times(6, () => run('a/bad', 'failed')), ...times(2, () => run('a/bad', 'done')), ...times(6, () => call('a/bad', 15))];
    const u = analyzeUsage(events, { now: NOW });
    const good = usageBonus(u.models.get('a/good'), 'agent', u);
    const bad = usageBonus(u.models.get('a/bad'), 'agent', u);
    assert.ok(good > 2, `good ${good}`);
    assert.ok(bad < -6, `bad ${bad}`);
    // Speed matters most for read-only subagents.
    assert.ok(usageBonus(u.models.get('a/good'), 'fast', u) > good);
    assert.strictEqual(usageBonus(undefined, 'agent', u), 0);
    assert.ok(successRate(undefined) > 0.5);
  });

  test('a single failure does not sink a model', () => {
    const u = analyzeUsage([run('a/x', 'failed')], { now: NOW });
    assert.ok(usageBonus(u.models.get('a/x'), 'agent', u) > -6);
  });

  test('suggests replacing a struggling default with a reliable installed model', () => {
    const models = [model('ollama/qwen2.5-coder:14b'), model('ollama/llama3.1:8b')];
    const events = [...times(6, () => run('ollama/qwen2.5-coder:14b', 'failed')), run('ollama/qwen2.5-coder:14b', 'done'), ...times(8, () => run('ollama/llama3.1:8b', 'done', { depth: 1, agent: 'coder' })), ...times(5, () => call('ollama/llama3.1:8b', 30)), ...times(5, () => call('ollama/qwen2.5-coder:14b', 10))];
    const u = analyzeUsage(events, { now: NOW });
    const s = suggestModels(models, u, { defaultModel: 'ollama/qwen2.5-coder:14b', routing: {} }, profile);
    const agent = s.find((x) => x.role === 'agent');
    assert.ok(agent, JSON.stringify(s));
    assert.strictEqual(agent.suggested, 'ollama/llama3.1:8b');
    assert.strictEqual(agent.kind, 'setting');
    assert.ok(agent.currentIsSetting && agent.currentStruggling);
    assert.ok(agent.confidence !== 'low');
    assert.match(agent.reason, /finished/);
  });

  test('stays quiet without evidence, and never on static score alone', () => {
    const models = [model('ollama/qwen2.5-coder:14b'), model('ollama/llama3.2:1b')];
    assert.deepStrictEqual(suggestModels(models, analyzeUsage([], { now: NOW }), { defaultModel: 'ollama/llama3.2:1b', routing: {} }, profile), []);
  });

  test('a strong usage record never makes a tool-less model the agent or a blind model the vision pick', () => {
    const models = [model('ollama/qwen2.5-coder:7b'), model('ollama/chatty:7b', { supportsTools: false })];
    const u = analyzeUsage([...times(30, () => run('ollama/chatty:7b', 'done')), ...times(10, () => call('ollama/chatty:7b', 200))], { now: NOW });
    assert.strictEqual(pickForRole(models, 'agent', profile, false, (m, r) => usageBonus(u.models.get(m.id), r, u))?.id, 'ollama/qwen2.5-coder:7b');
    assert.ok(!suggestModels(models, u, { routing: {} }, profile).some((s) => s.suggested === 'ollama/chatty:7b' && s.role !== 'completion'));
  });

  test('completion picks follow acceptance', () => {
    const models = [model('ollama/qwen2.5-coder:1.5b-base', { supportsFim: true }), model('ollama/starcoder2:3b', { supportsFim: true })];
    const ev: TelemetryEvent[] = [];
    for (let i = 0; i < 30; i++) {
      ev.push({ type: 'completion', t: NOW, action: 'shown', model: 'ollama/starcoder2:3b', durationMs: 300 });
      if (i % 2) {
        ev.push({ type: 'completion', t: NOW, action: 'accepted', model: 'ollama/starcoder2:3b' });
      }
      ev.push({ type: 'completion', t: NOW, action: 'shown', model: 'ollama/qwen2.5-coder:1.5b-base', durationMs: 2800 });
    }
    const u = analyzeUsage(ev, { now: NOW });
    assert.strictEqual(evidenceCount(u.models.get('ollama/starcoder2:3b'), 'completion'), 30);
    const s = suggestModels(models, u, { routing: {}, completionModel: 'ollama/qwen2.5-coder:1.5b-base' }, profile).find((x) => x.role === 'completion');
    assert.strictEqual(s?.suggested, 'ollama/starcoder2:3b');
  });

  test('read-only subagents pinned to the session model are left alone', () => {
    const models = [model('a/one:7b'), model('a/two:7b')];
    const u = analyzeUsage([...times(10, () => run('a/two:7b', 'done', { depth: 1, agent: 'explore' })), ...times(8, () => run('a/one:7b', 'failed', { depth: 1, agent: 'explore' }))], { now: NOW });
    assert.ok(!suggestModels(models, u, { routing: { fast: 'session' } }, profile).some((s) => s.role === 'fast'));
  });
});

suite('colibri runtime', () => {
  test('maps served model ids to their resident RAM and disk size', () => {
    assert.strictEqual(colibriSpec('glm-5.2-colibri')?.name, 'glm-5.2');
    assert.strictEqual(colibriSpec('glm-5.3-flash')?.name, 'glm-5.3-flash');
    assert.strictEqual(colibriSpec('qwen3-coder-30b')?.coder, true);
    assert.strictEqual(colibriSpec('deepseek-v4-flash')?.diskGb, 167);
    assert.strictEqual(colibriSpec('deepseek-v4-flash-reap')?.name, 'deepseek-v4-flash-reap');
    assert.strictEqual(colibriSpec('mimo-v2.6-pro')?.name, 'mimo-v2.6-pro');
    assert.strictEqual(colibriSpec('something-else'), undefined);
  });

  test('a 744B model streaming from disk fits by its resident size, but is kept away from snappy roles', () => {
    const glm = model('vllm/glm-5.2-colibri', { runtime: 'colibri', residentGb: 16, diskGb: 429, parameterSize: '744B' });
    const coder = model('ollama/qwen2.5-coder:7b');
    assert.strictEqual(modelFootprintGb(glm), 16);
    assert.ok(streamsFromDisk(glm, profile.modelBudgetGb));
    assert.ok(!streamsFromDisk(coder, profile.modelBudgetGb));
    assert.ok(scoreForRole(glm, 'fast', profile) < scoreForRole(coder, 'fast', profile) - 20);
    assert.ok(scoreForRole(glm, 'completion', profile) < -30);
    assert.strictEqual(pickForRole([glm, coder], 'fast', profile)?.id, coder.id);
    // Small MoE models that run from RAM are not penalised.
    const q = model('colibri/qwen3-coder-30b', { runtime: 'colibri', residentGb: 8, diskGb: 19 });
    assert.ok(!streamsFromDisk(q, profile.modelBudgetGb));
  });

  test('watchdog is patient with colibri, and most patient when it streams from disk', () => {
    assert.deepStrictEqual(watchdogFor(model('a/b'), 20), { first: 1, idle: 1 });
    assert.deepStrictEqual(watchdogFor(model('a/b', { runtime: 'colibri', diskGb: 19 }), 20), { first: 2, idle: 2 });
    assert.deepStrictEqual(watchdogFor(model('a/b', { runtime: 'colibri', diskGb: 429 }), 20), { first: 4, idle: 4 });
  });

  test('saturation uses the server-reported KV slots', () => {
    const m = model('colibri/glm-5.2', { runtime: 'colibri', parallelSlots: 2 });
    const load = (n: number) => ({ assigned: new Map([[m.id, n]]), serial: new Set<string>(), slots: 4 });
    assert.ok(!isSaturated(m, load(1)));
    assert.ok(isSaturated(m, load(2)));
  });

  test('launch command, launcher path, health parsing and Docker detection', () => {
    assert.strictEqual(colibriServeCommand({ folder: '/opt/colibri', model: 'qwen3-coder-30b', port: 8001, kvSlots: 3, platform: 'linux' }), '/opt/colibri/c/coli serve --host 127.0.0.1 --port 8001 --model qwen3-coder-30b --kv-slots 3');
    assert.strictEqual(colibriServeCommand({ platform: 'darwin' }), 'coli serve --host 127.0.0.1 --port 8000');
    assert.match(colibriServeCommand({ folder: 'C:\\My Tools\\colibri', platform: 'win32' }), /^& "C:\\My Tools\\colibri\\c\\coli\.cmd" serve/);
    assert.strictEqual(coliLauncher('/x/colibri/', 'linux'), '/x/colibri/c/coli');
    assert.strictEqual(colibriRoot('http://localhost:8000/v1/'), 'http://localhost:8000');
    assert.strictEqual(colibriSlots({ scheduler: { capacity: 4 } }), 4);
    assert.strictEqual(colibriSlots({ status: 'ok' }), 1);
    assert.strictEqual(colibriSlots(undefined), 1);
    const [p] = providersFromContainers([{ Image: 'ghcr.io/justvugg/colibri:latest', Names: 'coli', Ports: '0.0.0.0:8100->8000/tcp' }]);
    assert.strictEqual(p.baseUrl, 'http://localhost:8100/v1');
  });

  test('a running coli serve is identified, labelled and its non-chat models hidden', async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') {
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.2-colibri', object: 'model', owned_by: 'colibri', input_modalities: ['text'], capabilities: ['chat', 'systemone'] }, { id: 'laya', object: 'model', owned_by: 'colibri', capabilities: ['systemone', 'decision'] }] }));
      }
      if (req.url === '/health') {
        return res.end(JSON.stringify({ status: 'ok', kv_slots: 2, scheduler: { active: 0, queued: 0, capacity: 2 } }));
      }
      res.statusCode = 404;
      return res.end('{}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
      const p = new OpenAICompatProvider({ id: 'vllm', type: 'openai', baseUrl, displayName: 'vLLM / Unsloth' });
      const models = await p.listModels();
      assert.deepStrictEqual(models.map((m) => m.modelId), ['glm-5.2-colibri']);
      const [m] = models;
      assert.strictEqual(m.runtime, 'colibri');
      assert.strictEqual(m.residentGb, 16);
      assert.strictEqual(m.diskGb, 429);
      assert.strictEqual(m.parallelSlots, 2);
      assert.strictEqual(m.supportsVision, false);
      assert.strictEqual(m.supportsFim, false);
      assert.strictEqual(p.displayName, 'colibri');
      // A provider the user named keeps its name.
      const named = new OpenAICompatProvider({ id: 'big', type: 'openai', baseUrl, displayName: 'Big box' });
      await named.listModels();
      assert.strictEqual(named.displayName, 'Big box');
      const probe = await probeProvider({ id: 'vllm', type: 'openai', baseUrl, displayName: 'vLLM / Unsloth' }, false, 'known');
      assert.strictEqual(probe.engine, 'colibri');
      assert.strictEqual(probe.displayName, 'colibri');
    } finally {
      srv.close();
    }
  });
});
