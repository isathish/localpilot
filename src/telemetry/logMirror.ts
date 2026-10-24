import * as vscode from 'vscode';
import { LogLevel, Telemetry } from './telemetry';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * Returns a `LogOutputChannel` that writes to `log` and mirrors every line into the telemetry store, so the dashboard
 * can show and search the log (VS Code offers no API to read an output channel back). Everything else is forwarded.
 */
export function mirrorLog(log: vscode.LogOutputChannel, telemetry: Telemetry): vscode.LogOutputChannel {
  const format = (msg: unknown, args: unknown[]): string => {
    const head = msg instanceof Error ? msg.stack ?? msg.message : String(msg);
    return args.length ? `${head} ${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}` : head;
  };
  return new Proxy(log, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (LEVELS as string[]).includes(prop)) {
        const level = prop as LogLevel;
        return (msg: unknown, ...args: unknown[]) => {
          telemetry.log(level, format(msg, args));
          (target[level] as (m: unknown, ...a: unknown[]) => void).call(target, msg, ...args);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
