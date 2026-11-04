// Wires `localpilot.telemetry.otlp.*` (and the OTEL_* variables) to a Telemetry: attaches or replaces the `otlp` sink
// and turns trace spans on or off. Shared by the extension and the CLI.
import { describeOtlpConfig, OtlpConfig, OtlpExportResult, OtlpSettings, OtlpSink, OtlpTransport, resolveOtlpConfig } from './otlp';
import type { Telemetry } from './telemetry';

export const OTLP_SINK = 'otlp';

export interface OtlpController {
  readonly config: OtlpConfig;
  readonly sink: OtlpSink | undefined;
  /** The setting that keeps export off (`localpilot.telemetry.otlp.enabled`, or `localpilot.telemetry.enabled`), if any. */
  readonly offBecause: string | undefined;
  /** Re-reads the settings; true when the export target changed. */
  sync(): Promise<boolean>;
  /** Sends a `localpilot.test.connection` record with the current settings (even while export is off). */
  test(): Promise<OtlpExportResult>;
  dispose(): Promise<void>;
}

export interface AttachOtlpOptions {
  settings: () => OtlpSettings;
  version: string;
  /** Where the `console` exporter and debug lines go. Must not be a log that is mirrored into telemetry. */
  out: (line: string) => void;
  warn: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
  transport?: OtlpTransport;
}

export function attachOtlp(telemetry: Telemetry, o: AttachOtlpOptions): OtlpController {
  const env = o.env ?? process.env;
  const debug = env.LOCALPILOT_OTEL_DEBUG === '1' || env.LOCALPILOT_OTEL_DEBUG === 'true' ? o.out : undefined;
  const sinkFor = (config: OtlpConfig) => new OtlpSink(config, { version: o.version, transport: o.transport, out: o.out, debug });
  let config = resolveOtlpConfig(o.settings(), env, o.version);
  let sink: OtlpSink | undefined;
  let key = '';
  let recording = true;
  const apply = async (): Promise<boolean> => {
    config = resolveOtlpConfig(o.settings(), env, o.version);
    // Export needs local recording: with telemetry off nothing (events, metrics, spans or log lines) leaves the machine.
    recording = telemetry.enabled;
    const next = JSON.stringify({ config, recording });
    if (next === key) {
      return false;
    }
    const first = !key;
    key = next;
    for (const w of config.warnings) {
      o.warn(`Telemetry: ${w}`);
    }
    if (config.enabled && !recording) {
      o.warn('Telemetry: OTLP export is on but localpilot.telemetry.enabled is off, so nothing is exported. Turn telemetry on to export.');
    }
    debug?.(describeOtlpConfig(config));
    const on = recording && config.enabled && (config.otlp || config.console || config.traces);
    telemetry.tracing.configure({ enabled: on && config.traces, samplePercent: config.traceSamplePercent, recordContent: config.recordContent });
    if (sink) {
      sink = undefined;
      await telemetry.remove(OTLP_SINK);
    }
    if (on) {
      sink = sinkFor(config);
      telemetry.add(OTLP_SINK, sink);
    }
    return !first;
  };
  const ready = apply();
  return {
    get config() {
      return config;
    },
    get sink() {
      return sink;
    },
    get offBecause() {
      return !config.enabled ? 'localpilot.telemetry.otlp.enabled' : !recording ? 'localpilot.telemetry.enabled' : undefined;
    },
    sync: async () => {
      await ready;
      return apply();
    },
    test: async () => {
      await ready;
      const c = resolveOtlpConfig(o.settings(), env, o.version);
      const probe = sink && JSON.stringify({ config: c, recording }) === key ? sink : sinkFor({ ...c, console: false });
      try {
        return await probe.test();
      } finally {
        if (probe !== sink) {
          await probe.shutdown();
        }
      }
    },
    dispose: async () => {
      await ready;
      telemetry.tracing.configure({ enabled: false });
      if (sink) {
        sink = undefined;
        await telemetry.remove(OTLP_SINK);
      }
    },
  };
}
