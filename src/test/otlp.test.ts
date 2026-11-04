import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { eventRecord, MetricStore, OTLP_BATCH_SIZE, OTLP_MAX_QUEUE, OtlpSettings, OtlpSink, OtlpTransport, parseKeyValues, resolveOtlpConfig, signalUrl } from '../telemetry/otlp';
import { attachOtlp } from '../telemetry/otlpSetup';
import { Telemetry } from '../telemetry/telemetry';
import { recordModelSpan, Tracer, traceTool, type SpanData } from '../telemetry/tracing';

type Received = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };

/** A minimal OTLP/HTTP JSON receiver that records every request. */
async function collector(status = 200): Promise<{ url: string; received: Received[]; status: number; close(): Promise<void> }> {
  const received: Received[] = [];
  const state = { status };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown> });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    get status() {
      return state.status;
    },
    set status(s: number) {
      state.status = s;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const settings = (o: Partial<OtlpSettings> = {}): OtlpSettings => ({ enabled: true, endpoint: 'http://localhost:4318', headers: {}, metricsInterval: 60, exporters: ['otlp'], traceSamplePercent: 100, recordContent: false, ...o });

type Json = Record<string, unknown>;
const logRecords = (r: Received[]) => r.filter((x) => x.path === '/v1/logs').flatMap((x) => ((x.body.resourceLogs as Json[])[0].scopeLogs as Json[])[0].logRecords as Json[]);
const metricNames = (r: Received[]) => r.filter((x) => x.path === '/v1/metrics').flatMap((x) => (((x.body.resourceMetrics as Json[])[0].scopeMetrics as Json[])[0].metrics as Json[]).map((m) => m.name));
const spans = (r: Received[]) => r.filter((x) => x.path === '/v1/traces').flatMap((x) => ((x.body.resourceSpans as Json[])[0].scopeSpans as Json[])[0].spans as Json[]);
const attr = (o: Json, key: string) => ((o.attributes as { key: string; value: Json }[]).find((a) => a.key === key)?.value);

suite('OTLP export', () => {
  test('environment variables override the settings; other protocols warn', () => {
    const c = resolveOtlpConfig(settings({ headers: { a: '1', b: '2' }, metricsInterval: 30 }), { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'b=x%20y,Authorization=Basic%20abc', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc', OTEL_METRIC_EXPORT_INTERVAL: '5000' }, '9.9.9');
    assert.strictEqual(c.urls.logs, 'https://otel.example:4318/v1/logs');
    assert.strictEqual(c.urls.traces, 'https://otel.example:4318/v1/traces');
    assert.deepStrictEqual(c.headers, { a: '1', b: 'x y', Authorization: 'Basic abc' });
    assert.strictEqual(c.metricsIntervalMs, 5000);
    assert.ok(c.warnings.some((w) => w.includes('grpc')), c.warnings.join());
    assert.strictEqual(c.resource['service.name'], 'localpilot');
    assert.strictEqual(c.resource['service.version'], '9.9.9');
    assert.ok(c.fromEnv.includes('OTEL_EXPORTER_OTLP_ENDPOINT'));
    const plain = resolveOtlpConfig(settings({ metricsInterval: 30 }), {});
    assert.strictEqual(plain.metricsIntervalMs, 30_000);
    assert.strictEqual(plain.traces, false);
    assert.strictEqual(resolveOtlpConfig(settings(), { OTEL_SDK_DISABLED: 'true' }).enabled, false);
    assert.strictEqual(resolveOtlpConfig(settings({ endpoint: 'ftp://nope' }), {}).enabled, false);
    assert.strictEqual(signalUrl('http://h:4318/v1/logs', 'metrics'), 'http://h:4318/v1/metrics');
    assert.deepStrictEqual(parseKeyValues('k=v=w, x = 1 ,bad'), { k: 'v=w', x: '1' });
  });

  test('a collector receives events and log lines as logs, and metrics', async () => {
    const col = await collector();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-otlp-'));
    const t = new Telemetry({ dir, retentionDays: () => 0 });
    const ctl = attachOtlp(t, { settings: () => settings({ endpoint: col.url, headers: { 'x-team': 'core' } }), version: '1.2.3', out: () => undefined, warn: () => undefined, env: {} });
    try {
      assert.ok(t.sinkNames().includes('otlp'));
      t.record({ type: 'model', sid: 's', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, promptTokens: 100, completionTokens: 20, durationMs: 1200, outcome: 'ok' });
      t.record({ type: 'tool', sid: 's', name: 'read_file', mode: 'agent', durationMs: 12, error: true });
      t.log('warn', 'something odd');
      t.counter('localpilot.custom', 2, { k: 'v' });
      await t.flush();
      const logs = logRecords(col.received);
      assert.deepStrictEqual(logs.map((l) => (l.body as Json).stringValue), ['localpilot.model', 'localpilot.tool', 'something odd']);
      assert.strictEqual(logs[1].severityText, 'WARN', 'a failed tool is a warning');
      assert.deepStrictEqual(attr(logs[0], 'promptTokens'), { intValue: '100' });
      assert.strictEqual(logs[2].severityNumber, 13);
      const resource = ((col.received[0].body.resourceLogs as Json[])[0].resource as Json);
      assert.deepStrictEqual(attr(resource, 'service.name'), { stringValue: 'localpilot' });
      assert.deepStrictEqual(attr(resource, 'service.version'), { stringValue: '1.2.3' });
      assert.strictEqual(col.received[0].headers['x-team'], 'core');
      assert.strictEqual(col.received[0].headers['content-type'], 'application/json');
      const names = metricNames(col.received);
      for (const n of ['localpilot.events', 'localpilot.model.requests', 'localpilot.model.duration', 'localpilot.tokens', 'localpilot.tool.calls', 'localpilot.custom']) {
        assert.ok(names.includes(n), `${n} missing from ${names.join(',')}`);
      }
      assert.strictEqual(spans(col.received).length, 0, 'no traces unless exporters include traces');
    } finally {
      await ctl.dispose();
      await t.shutdown();
      await col.close();
    }
  });

  test('test() reports the HTTP status, and failures', async () => {
    const col = await collector(200);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-otlp-'));
    const t = new Telemetry({ dir, retentionDays: () => 0 });
    let s = settings({ endpoint: col.url, enabled: false });
    const ctl = attachOtlp(t, { settings: () => s, version: '1', out: () => undefined, warn: () => undefined, env: {} });
    try {
      assert.ok(!t.sinkNames().includes('otlp'), 'disabled: no sink');
      const ok = await ctl.test();
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.error, undefined);
      assert.deepStrictEqual(logRecords(col.received).map((l) => (l.body as Json).stringValue), ['localpilot.test.connection']);
      col.status = 401;
      const denied = await ctl.test();
      assert.strictEqual(denied.status, 401);
      assert.match(denied.error ?? '', /HTTP 401/);
      s = settings({ endpoint: 'http://127.0.0.1:1' });
      assert.strictEqual(await ctl.sync(), true);
      assert.ok(t.sinkNames().includes('otlp'));
      const down = await ctl.test();
      assert.strictEqual(down.status, undefined);
      assert.ok(down.error);
    } finally {
      await ctl.dispose();
      await t.shutdown();
      await col.close();
    }
  });

  test('spans nest, carry gen_ai attributes, and stamp events with their ids', async () => {
    const col = await collector();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-otlp-'));
    const t = new Telemetry({ dir, retentionDays: () => 0 });
    const ctl = attachOtlp(t, { settings: () => settings({ endpoint: col.url, exporters: ['otlp', 'traces'] }), version: '1', out: () => undefined, warn: () => undefined, env: {} });
    try {
      await t.tracing.inSpan('invoke_agent localpilot', { 'gen_ai.operation.name': 'invoke_agent' }, async () => {
        const ids = recordModelSpan(t.tracing, { sid: 's', model: 'qwen', provider: 'ollama', startMs: Date.now() - 50, outcome: 'ok', promptTokens: 10, completionTokens: 3, finishReason: 'stop', input: () => [{ role: 'user', content: 'secret prompt' }], output: 'secret reply' });
        t.record({ type: 'model', sid: 's', model: 'qwen', provider: 'ollama', mode: 'agent', depth: 0, durationMs: 50, outcome: 'ok', ...ids });
        await traceTool(t.tracing, { id: 'c1', name: 'read_file' }, { path: 'a.ts' }, async () => {
          t.record({ type: 'tool', sid: 's', name: 'read_file', mode: 'agent', durationMs: 1, error: false });
          return { isError: false, msg: { content: 'file text' } };
        });
      });
      await t.flush();
      const got = spans(col.received);
      const run = got.find((s) => s.name === 'invoke_agent localpilot')!;
      const chat = got.find((s) => s.name === 'chat qwen')!;
      const tool = got.find((s) => s.name === 'execute_tool read_file')!;
      assert.ok(run && chat && tool, got.map((s) => s.name).join());
      assert.strictEqual(chat.parentSpanId, run.spanId);
      assert.strictEqual(tool.parentSpanId, run.spanId);
      assert.strictEqual(chat.traceId, run.traceId);
      assert.match(String(run.traceId), /^[0-9a-f]{32}$/);
      assert.strictEqual(chat.kind, 3);
      assert.deepStrictEqual(attr(chat, 'gen_ai.usage.input_tokens'), { intValue: '10' });
      assert.deepStrictEqual(attr(chat, 'gen_ai.response.finish_reasons'), { arrayValue: { values: [{ stringValue: 'stop' }] } });
      assert.deepStrictEqual(attr(tool, 'gen_ai.tool.name'), { stringValue: 'read_file' });
      assert.strictEqual(JSON.stringify(got).includes('secret'), false, 'no content without recordContent');
      const logs = logRecords(col.received);
      assert.strictEqual(logs.find((l) => (l.body as Json).stringValue === 'localpilot.model')?.spanId, chat.spanId);
      assert.strictEqual(logs.find((l) => (l.body as Json).stringValue === 'localpilot.tool')?.spanId, tool.spanId);
    } finally {
      await ctl.dispose();
      await t.shutdown();
      await col.close();
    }
  });

  test('recordContent puts prompts and results on spans; sampling drops whole traces', async () => {
    const ended: SpanData[] = [];
    const tracer = new Tracer((s) => ended.push(s), () => 0.5);
    tracer.configure({ enabled: true, samplePercent: 100, recordContent: true });
    await tracer.inSpan('run', {}, async () => {
      recordModelSpan(tracer, { sid: 's', model: 'm', provider: 'p', startMs: Date.now(), outcome: 'ok', input: () => [{ role: 'user', content: 'hello' }], output: 'hi' });
      await traceTool(tracer, { id: '1', name: 'grep' }, { q: 'x' }, async () => ({ isError: true, msg: { content: 'no match\nmore' } }));
    });
    const chat = ended.find((s) => s.name === 'chat m')!;
    assert.match(String(chat.attributes['gen_ai.input.messages']), /hello/);
    assert.strictEqual(chat.attributes['output.value'], 'hi');
    const tool = ended.find((s) => s.name === 'execute_tool grep')!;
    assert.strictEqual(tool.attributes['gen_ai.tool.call.arguments'], '{"q":"x"}');
    assert.strictEqual(tool.status, 'error');
    assert.strictEqual(tool.statusMessage, 'no match');
    ended.length = 0;
    tracer.configure({ samplePercent: 40 });
    await tracer.inSpan('run', {}, async () => {
      recordModelSpan(tracer, { sid: 's', model: 'm', provider: 'p', startMs: Date.now(), outcome: 'ok' });
    });
    assert.strictEqual(ended.length, 0, '0.5 is outside a 40% sample: the run and its children are dropped');
    tracer.configure({ enabled: false });
    assert.strictEqual(tracer.start('x').recording, false);
  });

  test('batches of 512, at most 2048 queued, retried after a 503', async () => {
    const sent: { url: string; n: number }[] = [];
    let status = 200;
    const transport: OtlpTransport = async (url, body) => {
      const parsed = JSON.parse(body) as Json;
      const n = parsed.resourceLogs ? logRecords([{ path: '/v1/logs', headers: {}, body: parsed }]).length : 0;
      sent.push({ url, n });
      return { status };
    };
    const sink = new OtlpSink(resolveOtlpConfig(settings(), {}), { version: '1', transport });
    try {
      const ev = { t: Date.now(), type: 'completion', action: 'shown' } as const;
      await sink.write({ events: Array.from({ length: OTLP_MAX_QUEUE + 100 }, () => ev), logs: [] });
      await sink.flush();
      const logBatches = sent.filter((s) => s.url.endsWith('/v1/logs')).map((s) => s.n);
      assert.strictEqual(logBatches.reduce((a, b) => a + b, 0), OTLP_MAX_QUEUE);
      assert.ok(logBatches.every((n) => n <= OTLP_BATCH_SIZE), logBatches.join());
      assert.strictEqual(sink.dropped, 100);
      sent.length = 0;
      status = 503;
      await sink.write({ events: [ev, ev], logs: [] });
      await sink.flush();
      status = 200;
      await sink.flush();
      assert.deepStrictEqual(sent.filter((s) => s.url.endsWith('/v1/logs')).map((s) => s.n), [2, 2], 'the failed batch is sent again');
    } finally {
      await sink.shutdown();
    }
  });

  test('metrics are cumulative and events never carry their timestamps as attributes', () => {
    const m = new MetricStore(1000);
    m.add('localpilot.events', 1, { type: 'tool' });
    m.add('localpilot.events', 2, { type: 'tool' });
    m.record('localpilot.tool.duration', 7, { tool: 'grep' });
    m.record('localpilot.tool.duration', 700, { tool: 'grep' });
    const metrics = (((m.payload({ resource: {} }, '1', 2000) as Json).resourceMetrics as Json[])[0].scopeMetrics as Json[])[0].metrics as Json[];
    const sum = metrics.find((x) => x.name === 'localpilot.events')!.sum as Json;
    assert.strictEqual(((sum.dataPoints as Json[])[0]).asInt, '3');
    assert.strictEqual(sum.aggregationTemporality, 2);
    const h = ((metrics.find((x) => x.name === 'localpilot.tool.duration')!.histogram as Json).dataPoints as Json[])[0];
    assert.strictEqual(h.count, '2');
    assert.strictEqual(h.max, 700);
    const rec = eventRecord({ t: 5, type: 'slash', command: 'compact', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    assert.deepStrictEqual(Object.keys(rec.attributes).sort(), ['command', 'event.name']);
    assert.strictEqual(rec.traceId, 'a'.repeat(32));
  });
});
