import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { OtlpSettings, OtlpTransport } from '../telemetry/otlp';
import { attachOtlp } from '../telemetry/otlpSetup';
import { Telemetry } from '../telemetry/telemetry';
import { endRunSpan, startRunSpan, Tracer, traceTool, type SpanData } from '../telemetry/tracing';

const settings = (o: Partial<OtlpSettings> = {}): OtlpSettings => ({ enabled: true, endpoint: 'http://127.0.0.1:4318', headers: {}, metricsInterval: 60, exporters: ['otlp', 'traces'], traceSamplePercent: 100, recordContent: false, ...o });

suite('OTLP privacy', () => {
  test('a failed tool or run span carries no output or error text without recordContent', async () => {
    const ended: SpanData[] = [];
    const tracer = new Tracer((s) => ended.push(s));
    tracer.configure({ enabled: true, samplePercent: 100, recordContent: false });
    const run = startRunSpan(tracer, { sid: 's', mode: 'agent', depth: 0 });
    await tracer.with(run, () => traceTool(tracer, { id: '1', name: 'run_command' }, { command: 'make' }, async () => ({ isError: true, msg: { content: 'cc: /home/me/secret/main.c: no such file\nmore' } })));
    endRunSpan(run, { outcome: 'failed', error: 'read /home/me/secret failed', steps: 1, toolCalls: 1, promptTokens: 1, completionTokens: 1 });
    await assert.rejects(tracer.inSpan('boom', {}, async () => {
      throw new Error('/home/me/secret/x: EACCES');
    }));
    const tool = ended.find((s) => s.name === 'execute_tool run_command')!;
    assert.strictEqual(tool.status, 'error');
    assert.strictEqual(tool.statusMessage, 'tool error');
    const runSpan = ended.find((s) => s.name === 'invoke_agent localpilot')!;
    assert.strictEqual(runSpan.status, 'error');
    assert.strictEqual(runSpan.statusMessage, 'failed');
    assert.strictEqual(ended.find((s) => s.name === 'boom')?.statusMessage, 'error');
    assert.strictEqual(JSON.stringify(ended).includes('secret'), false);

    ended.length = 0;
    tracer.configure({ recordContent: true });
    const run2 = startRunSpan(tracer, { sid: 's', mode: 'agent', depth: 0 });
    endRunSpan(run2, { outcome: 'failed', error: 'model unreachable', steps: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0 });
    assert.strictEqual(ended[0].statusMessage, 'model unreachable', 'with recordContent the error text is kept');
  });

  test('OTLP export needs telemetry.enabled: nothing is exported, a warning says why', async () => {
    const sent: string[] = [];
    const transport: OtlpTransport = async (url) => {
      sent.push(url);
      return { status: 200 };
    };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-otlp-priv-'));
    let enabled = false;
    const warnings: string[] = [];
    const t = new Telemetry({ dir, retentionDays: () => 0, enabled: () => enabled });
    const ctl = attachOtlp(t, { settings: () => settings(), version: '1', out: () => undefined, warn: (m) => warnings.push(m), env: {}, transport });
    try {
      await ctl.sync();
      assert.ok(!t.sinkNames().includes('otlp'), 'no sink while telemetry is off');
      assert.strictEqual(t.tracing.enabled, false, 'no spans while telemetry is off');
      assert.strictEqual(ctl.offBecause, 'localpilot.telemetry.enabled');
      assert.ok(warnings.some((w) => w.includes('localpilot.telemetry.enabled')), warnings.join());
      t.log('info', 'a log line');
      t.record({ type: 'tool', sid: 's', name: 'read_file', mode: 'agent', durationMs: 1, error: false });
      await t.flush();
      assert.deepStrictEqual(sent, [], 'not even log lines are exported');

      enabled = true;
      assert.strictEqual(await ctl.sync(), true, 'turning telemetry on re-applies the export');
      assert.ok(t.sinkNames().includes('otlp'));
      assert.strictEqual(ctl.offBecause, undefined);
      assert.strictEqual(t.tracing.enabled, true);
    } finally {
      await ctl.dispose();
      await t.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
