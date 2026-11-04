import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDuration } from './headless';
import { Style } from './providers';

/**
 * Scheduled agents: `localpilot schedule create nightly --cron "0 3 * * *" --prompt "…"`. Schedules live in
 * ~/.localpilot/schedules.json; the operating system's scheduler runs them (a crontab line on Linux, a launchd agent on
 * macOS, a Task Scheduler task on Windows), each calling `localpilot schedule run <name>`, which runs the prompt as a
 * one-shot `--yolo --json --timeout` task and writes a Markdown report plus a line of JSONL history. No daemon.
 */

export type ScheduleMode = 'agent' | 'plan' | 'ask';

export interface Schedule {
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  mode: ScheduleMode;
  model?: string;
  /** Seconds before the run is stopped (exit code 124). */
  timeoutSec: number;
  paused?: boolean;
  createdAt: string;
}

export interface ScheduleRun {
  runId: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  finishReason?: string;
  /** The report file of this run. */
  report: string;
  /** A run started while the previous one was still going is skipped. */
  skipped?: boolean;
  tokens?: number;
  costUsd?: number;
}

/** How to start the CLI: the `localpilot` shim when installed, else a Node (or VS Code runtime) plus dist/cli.js. */
export interface Launcher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_SEC = 30 * 60;
const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

// ------------------------------------------------------------------ cron

export interface Cron {
  /** null = every value (`*`). */
  minute: number[] | null;
  hour: number[] | null;
  dom: number[] | null;
  month: number[] | null;
  /** 0 = Sunday (7 is read as 0). */
  dow: number[] | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS: { key: keyof Cron; label: string; min: number; max: number; names?: string[]; base?: number }[] = [
  { key: 'minute', label: 'minute', min: 0, max: 59 },
  { key: 'hour', label: 'hour', min: 0, max: 23 },
  { key: 'dom', label: 'day of month', min: 1, max: 31 },
  { key: 'month', label: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { key: 'dow', label: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
];
const ALIASES: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };

/** Pure: a 5-field cron expression (lists, ranges, steps, month and weekday names, @daily…); throws on a bad one. */
export function parseCron(expr: string): Cron {
  const text = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expr}"`);
  }
  const out = {} as Cron;
  FIELDS.forEach((f, i) => {
    const num = (s: string): number => {
      const k = f.names?.indexOf(s.toLowerCase()) ?? -1;
      const n = k >= 0 ? k + (f.base ?? 0) : /^\d+$/.test(s) ? Number(s) : NaN;
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        throw new Error(`bad ${f.label} "${s}" in "${expr}" (${f.min}-${f.max})`);
      }
      return n;
    };
    const values = new Set<number>();
    for (const item of parts[i].split(',')) {
      const m = /^([^/]+)(?:\/(\d+))?$/.exec(item);
      if (!m || (m[2] !== undefined && Number(m[2]) < 1)) {
        throw new Error(`bad ${f.label} "${item}" in "${expr}"`);
      }
      const step = m[2] ? Number(m[2]) : 1;
      let lo: number;
      let hi: number;
      if (m[1] === '*') {
        lo = f.min;
        hi = f.key === 'dow' ? 6 : f.max;
      } else if (m[1].includes('-')) {
        const [a, b] = m[1].split('-');
        lo = num(a);
        hi = num(b);
        if (hi < lo) {
          throw new Error(`bad ${f.label} range "${m[1]}" in "${expr}"`);
        }
      } else {
        lo = num(m[1]);
        hi = m[2] ? (f.key === 'dow' ? 6 : f.max) : lo;
      }
      for (let v = lo; v <= hi; v += step) {
        values.add(f.key === 'dow' && v === 7 ? 0 : v);
      }
    }
    const full = (f.key === 'dow' ? 7 : f.max - f.min + 1) === values.size;
    out[f.key] = full ? null : [...values].sort((a, b) => a - b);
  });
  return out;
}

/** Pure: whether `d` (local time) is a minute the expression fires on. Day of month and weekday are OR-ed like cron. */
export function cronMatches(c: Cron, d: Date): boolean {
  const has = (list: number[] | null, v: number) => !list || list.includes(v);
  if (!has(c.minute, d.getMinutes()) || !has(c.hour, d.getHours()) || !has(c.month, d.getMonth() + 1)) {
    return false;
  }
  if (c.dom && c.dow) {
    return c.dom.includes(d.getDate()) || c.dow.includes(d.getDay());
  }
  return has(c.dom, d.getDate()) && has(c.dow, d.getDay());
}

/** Pure: the next minute after `from` the expression fires on (within about four years), or undefined. */
export function nextRun(c: Cron, from: Date): Date | undefined {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = from.getTime() + 4 * 366 * 86_400_000;
  while (d.getTime() < end) {
    const dayOk = (!c.month || c.month.includes(d.getMonth() + 1)) && (c.dom && c.dow ? c.dom.includes(d.getDate()) || c.dow.includes(d.getDay()) : (!c.dom || c.dom.includes(d.getDate())) && (!c.dow || c.dow.includes(d.getDay())));
    if (!dayOk) {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      continue;
    }
    if (c.hour && !c.hour.includes(d.getHours())) {
      d.setMinutes(0);
      d.setHours(d.getHours() + 1);
      continue;
    }
    if (cronMatches(c, d)) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

// ------------------------------------------------------------------ OS scheduler entries (pure text)

const MARK = '# localpilot-schedule:';

/** Pure: POSIX shell quoting. */
export function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pure: the shell command an OS entry runs for `name`, with the launcher's environment in front. */
export function runCommandLine(l: Launcher, name: string, env: Record<string, string> = {}): string {
  const vars = Object.entries({ ...env, ...l.env }).map(([k, v]) => `${k}=${shQuote(v)}`);
  return [...vars, ...[l.command, ...l.args, 'schedule', 'run', name].map(shQuote)].join(' ');
}

/** Pure: the crontab line of a schedule (tagged so it can be found and replaced). */
export function crontabLine(s: Pick<Schedule, 'name' | 'cron'>, l: Launcher, env: Record<string, string> = {}): string {
  const cron = ALIASES[s.cron.trim().toLowerCase()] ?? s.cron.trim().split(/\s+/).join(' ');
  return `${cron} ${runCommandLine(l, s.name, env)} ${MARK}${s.name}`;
}

/** Pure: `existing` crontab text with the line of `name` replaced by `line` (removed when `line` is undefined). */
export function mergeCrontab(existing: string, name: string, line: string | undefined): string {
  const kept = existing.split('\n').filter((l) => !l.trimEnd().endsWith(`${MARK}${name}`));
  while (kept.length && !kept[kept.length - 1].trim()) {
    kept.pop();
  }
  if (line) {
    kept.push(line);
  }
  return kept.length ? `${kept.join('\n')}\n` : '';
}

/** Pure: launchd StartCalendarInterval entries for an expression (day of month and weekday OR-ed, like cron). */
export function launchdCalendar(c: Cron): Record<string, number>[] {
  const product = (dims: [string, number[] | null][]): Record<string, number>[] => {
    let rows: Record<string, number>[] = [{}];
    for (const [key, list] of dims) {
      if (list) {
        rows = rows.flatMap((r) => list.map((v) => ({ ...r, [key]: v })));
      }
    }
    return rows;
  };
  const common: [string, number[] | null][] = [['Minute', c.minute], ['Hour', c.hour], ['Month', c.month]];
  const rows = c.dom && c.dow ? [...product([...common, ['Day', c.dom]]), ...product([...common, ['Weekday', c.dow]])] : product([...common, ['Day', c.dom], ['Weekday', c.dow]]);
  if (rows.length > 1000) {
    throw new Error(`this expression needs ${rows.length} launchd calendar entries; use a simpler one (at most 1000)`);
  }
  return rows;
}

export const launchdLabel = (name: string) => `dev.localpilot.schedule.${name}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Pure: the launchd agent of a schedule. */
export function launchdPlist(s: Pick<Schedule, 'name' | 'cron'>, l: Launcher, logFile: string, env: Record<string, string> = {}): string {
  const cal = launchdCalendar(parseCron(s.cron));
  const dict = (r: Record<string, number>) => `\t\t<dict>\n${Object.entries(r).map(([k, v]) => `\t\t\t<key>${k}</key>\n\t\t\t<integer>${v}</integer>`).join('\n')}${Object.keys(r).length ? '\n' : ''}\t\t</dict>`;
  const vars = { ...env, ...l.env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(launchdLabel(s.name))}</string>
\t<key>ProgramArguments</key>
\t<array>
${[l.command, ...l.args, 'schedule', 'run', s.name].map((a) => `\t\t<string>${xml(a)}</string>`).join('\n')}
\t</array>
${Object.keys(vars).length ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${Object.entries(vars).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join('\n')}\n\t</dict>\n` : ''}\t<key>StartCalendarInterval</key>
\t<array>
${cal.map(dict).join('\n')}
\t</array>
\t<key>StandardOutPath</key>
\t<string>${xml(logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

const winQuote = (s: string) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** Pure: `schtasks /Create` arguments for the expressions Task Scheduler can express; throws for the others. */
export function schtasksArgs(s: Pick<Schedule, 'name' | 'cron'>, l: Launcher): string[] {
  const c = parseCron(s.cron);
  const tr = [l.command, ...l.args, 'schedule', 'run', s.name].map(winQuote).join(' ');
  const base = ['/Create', '/F', '/TN', `LocalPilot\\${s.name}`, '/TR', tr];
  const pad = (n: number) => String(n).padStart(2, '0');
  const step = (list: number[] | null, size: number): number | undefined => {
    if (!list) {
      return 1;
    }
    const d = list.length > 1 ? list[1] - list[0] : size;
    return list[0] === 0 && size % d === 0 && list.length === size / d && list.every((v, i) => v === i * d) ? d : undefined;
  };
  const one = (list: number[] | null) => (list && list.length === 1 ? list[0] : undefined);
  const rest = !c.dom && !c.month && !c.dow;
  const m = one(c.minute);
  const h = one(c.hour);
  if (rest && !c.hour && step(c.minute, 60) !== undefined) {
    return [...base, '/SC', 'MINUTE', '/MO', String(step(c.minute, 60))];
  }
  if (rest && m !== undefined && step(c.hour, 24) !== undefined) {
    return [...base, '/SC', 'HOURLY', '/MO', String(step(c.hour, 24)), '/ST', `00:${pad(m)}`];
  }
  if (m !== undefined && h !== undefined) {
    const st = ['/ST', `${pad(h)}:${pad(m)}`];
    if (rest) {
      return [...base, '/SC', 'DAILY', ...st];
    }
    if (c.dow && !c.dom && !c.month) {
      return [...base, '/SC', 'WEEKLY', '/D', c.dow.map((d) => DAYS[d].toUpperCase()).join(','), ...st];
    }
    if (c.dom && !c.dow) {
      return [...base, '/SC', 'MONTHLY', '/D', c.dom.join(','), ...(c.month ? ['/M', c.month.map((x) => MONTHS[x - 1].toUpperCase()).join(',')] : []), ...st];
    }
  }
  throw new Error(`Windows Task Scheduler cannot express "${s.cron}"; use every N minutes (*/15 * * * *), hourly (5 * * * *), daily (0 3 * * *), weekly (0 3 * * 1,4) or monthly (0 3 1,15 * *)`);
}

// ------------------------------------------------------------------ store

export function schedulesHome(): string {
  return process.env.LOCALPILOT_SCHEDULES_HOME || path.join(os.homedir(), '.localpilot');
}

export class ScheduleStore {
  constructor(readonly home = schedulesHome()) {}

  get file(): string {
    return path.join(this.home, 'schedules.json');
  }
  get dir(): string {
    return path.join(this.home, 'schedules');
  }
  get reportsDir(): string {
    return path.join(this.dir, 'reports');
  }
  get historyFile(): string {
    return path.join(this.dir, 'history.jsonl');
  }
  logFile(name: string): string {
    return path.join(this.dir, 'logs', `${name}.log`);
  }

  list(): Schedule[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { schedules?: Schedule[] };
      return Array.isArray(raw.schedules) ? raw.schedules.filter((s) => s && typeof s.name === 'string') : [];
    } catch {
      return [];
    }
  }

  get(name: string): Schedule | undefined {
    return this.list().find((s) => s.name === name);
  }

  private write(all: Schedule[]): void {
    fs.mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ schedules: all }, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  put(s: Schedule): void {
    this.write([...this.list().filter((x) => x.name !== s.name), s].sort((a, b) => a.name.localeCompare(b.name)));
  }

  remove(name: string): boolean {
    const all = this.list();
    this.write(all.filter((s) => s.name !== name));
    return all.some((s) => s.name === name);
  }

  history(name?: string, limit = 20): ScheduleRun[] {
    let lines: string[];
    try {
      lines = fs.readFileSync(this.historyFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    const runs: ScheduleRun[] = [];
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as ScheduleRun;
        if (!name || r.name === name) {
          runs.push(r);
        }
      } catch {
        /* a torn line */
      }
    }
    return runs.slice(-limit).reverse();
  }

  record(r: ScheduleRun): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.historyFile, `${JSON.stringify(r)}\n`);
  }
}

/** Pure: a schedule from its fields, checked; throws with a message for the user. */
export function makeSchedule(input: { name: string; cron: string; prompt: string; cwd: string; mode?: string; model?: string; timeout?: string | number }, now = new Date()): Schedule {
  const name = input.name.trim();
  if (!NAME.test(name)) {
    throw new Error(`schedule names use letters, digits, - and _ (up to 48), got "${input.name}"`);
  }
  parseCron(input.cron);
  if (!input.prompt.trim()) {
    throw new Error('a schedule needs a prompt (--prompt "…")');
  }
  const mode = (input.mode ?? 'agent') as ScheduleMode;
  if (!['agent', 'plan', 'ask'].includes(mode)) {
    throw new Error(`--mode is agent, plan or ask (got "${input.mode}")`);
  }
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (input.timeout !== undefined && input.timeout !== '') {
    const ms = typeof input.timeout === 'number' ? input.timeout * 1000 : parseDuration(input.timeout);
    if (!ms || ms <= 0) {
      throw new Error(`--timeout takes a duration (90s, 20m, 1h; got "${input.timeout}")`);
    }
    timeoutSec = Math.max(1, Math.round(ms / 1000));
  }
  return { name, cron: input.cron.trim(), prompt: input.prompt.trim(), cwd: path.resolve(input.cwd), mode, ...(input.model?.trim() ? { model: input.model.trim() } : {}), timeoutSec, createdAt: now.toISOString() };
}

// ------------------------------------------------------------------ OS scheduler

function exec(cmd: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = cp.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Which scheduler this machine uses; `LOCALPILOT_SCHEDULER=off` keeps schedules in the file only. */
export function schedulerKind(platform = process.platform): 'cron' | 'launchd' | 'schtasks' | 'off' {
  if (process.env.LOCALPILOT_SCHEDULER === 'off') {
    return 'off';
  }
  return platform === 'darwin' ? 'launchd' : platform === 'win32' ? 'schtasks' : 'cron';
}

/** cron and launchd start jobs with a bare PATH: keep the one this was created with, so node, git and the tools resolve. */
const runEnv = (): Record<string, string> => (process.env.PATH ? { PATH: process.env.PATH } : {});

const plistPath = (name: string) => path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel(name)}.plist`);

/** Adds (or replaces) the OS scheduler entry of a schedule. */
export async function installEntry(s: Schedule, l: Launcher, store: ScheduleStore): Promise<void> {
  const kind = schedulerKind();
  if (kind === 'off') {
    return;
  }
  if (kind === 'cron') {
    const cur = await exec('crontab', ['-l']);
    const r = await exec('crontab', ['-'], mergeCrontab(cur.code === 0 ? cur.stdout : '', s.name, crontabLine(s, l, runEnv())));
    if (r.code !== 0) {
      throw new Error(`crontab failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return;
  }
  if (kind === 'launchd') {
    const file = plistPath(s.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(store.logFile(s.name)), { recursive: true });
    fs.writeFileSync(file, launchdPlist(s, l, store.logFile(s.name), runEnv()));
    const domain = `gui/${process.getuid?.() ?? 501}`;
    await exec('launchctl', ['bootout', `${domain}/${launchdLabel(s.name)}`]);
    const r = await exec('launchctl', ['bootstrap', domain, file]);
    if (r.code !== 0) {
      throw new Error(`launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return;
  }
  const r = await exec('schtasks', schtasksArgs(s, l));
  if (r.code !== 0) {
    throw new Error(`schtasks failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
}

/** Removes the OS scheduler entry of a schedule (nothing when there is none). */
export async function removeEntry(name: string): Promise<void> {
  const kind = schedulerKind();
  if (kind === 'cron') {
    const cur = await exec('crontab', ['-l']);
    if (cur.code === 0 && cur.stdout.includes(`${MARK}${name}`)) {
      await exec('crontab', ['-'], mergeCrontab(cur.stdout, name, undefined));
    }
  } else if (kind === 'launchd') {
    await exec('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${launchdLabel(name)}`]);
    fs.rmSync(plistPath(name), { force: true });
  } else if (kind === 'schtasks') {
    await exec('schtasks', ['/Delete', '/F', '/TN', `LocalPilot\\${name}`]);
  }
}

/** The CLI that runs scheduled tasks: the installed `localpilot` shim (it follows extension updates), else this process. */
export function cliLauncher(script = process.argv[1]): Launcher {
  const shim = process.platform === 'win32' ? path.join(os.homedir(), 'bin', 'localpilot.cmd') : path.join(os.homedir(), '.local', 'bin', 'localpilot');
  if (fs.existsSync(shim)) {
    return { command: shim, args: [] };
  }
  return { command: process.execPath, args: [path.resolve(script)], env: process.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : undefined };
}

// ------------------------------------------------------------------ runs

/** Pure: the arguments of the one-shot run a schedule starts. */
export function runArgs(s: Schedule): string[] {
  return ['--yolo', '--json', '--timeout', `${s.timeoutSec}s`, '-C', s.cwd, ...(s.mode !== 'agent' ? [`--${s.mode}`] : []), ...(s.model ? ['-m', s.model] : []), '--', s.prompt];
}

/** Pure: the run id for a start time (sortable, unique per minute and schedule plus a suffix). */
export function runIdFor(name: string, at: Date): string {
  return `${name}-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${Math.random().toString(36).slice(2, 6)}`;
}

interface ParsedRun {
  answer: string;
  tools: { name: string; label: string; error: boolean }[];
  errors: string[];
  result?: Record<string, unknown>;
}

/** Pure: what a `--json` run printed (NDJSON on stdout, error records on stderr). */
export function parseRunOutput(stdout: string, stderr = ''): ParsedRun {
  const out: ParsedRun = { answer: '', tools: [], errors: [] };
  const started = new Map<string, { name: string; label: string }>();
  let text = '';
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!r || typeof r !== 'object' || r.childId) {
      continue;
    }
    if (r.type === 'assistant_delta') {
      text += String(r.text ?? '');
    } else if (r.type === 'tool_start') {
      const args = (r.args ?? {}) as Record<string, unknown>;
      const what = args.command ?? args.path ?? args.query ?? args.pattern ?? args.url ?? '';
      started.set(String(r.id), { name: String(r.name), label: String(what).replace(/\s+/g, ' ').slice(0, 120) });
    } else if (r.type === 'tool_end') {
      const t = started.get(String(r.id)) ?? { name: String(r.name), label: '' };
      out.tools.push({ ...t, error: !!r.isError });
    } else if (r.type === 'error') {
      out.errors.push(String(r.message ?? 'error'));
    } else if (r.type === 'run_result') {
      out.result = r;
    }
  }
  out.answer = (typeof out.result?.text === 'string' && out.result.text.trim() ? out.result.text : text).trim();
  return out;
}

/** Pure: the Markdown report of one run. */
export function reportMarkdown(s: Schedule, run: Omit<ScheduleRun, 'report'>, parsed: ParsedRun, stderrTail = ''): string {
  const secs = Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000);
  const usage = parsed.result?.usage as { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number } | undefined;
  const lines = [
    `# ${s.name}: ${run.skipped ? 'skipped' : run.exitCode === 0 ? 'done' : `failed (${run.finishReason ?? `exit ${run.exitCode}`})`}`,
    '',
    `- Run: \`${run.runId}\``,
    `- Started: ${run.startedAt} · took ${secs} s`,
    `- Exit code: ${run.exitCode}${run.finishReason ? ` (${run.finishReason})` : ''}`,
    `- Folder: \`${s.cwd}\` · mode ${s.mode}${parsed.result?.model ? ` · model ${String(parsed.result.model)}` : s.model ? ` · model ${s.model}` : ''}`,
    ...(usage ? [`- Tokens: ${(usage.promptTokens ?? 0) + (usage.cacheReadTokens ?? 0)} in, ${usage.completionTokens ?? 0} out${typeof parsed.result?.costUsd === 'number' ? ` · $${parsed.result.costUsd.toFixed(4)}` : ''}`] : []),
    `- Schedule: \`${s.cron}\``,
    '',
    '## Prompt',
    '',
    s.prompt,
    '',
    '## Answer',
    '',
    parsed.answer || (run.skipped ? '_The previous run of this schedule was still going._' : '_No answer._'),
  ];
  if (parsed.tools.length) {
    lines.push('', `## Tools (${parsed.tools.length})`, '', ...parsed.tools.map((t) => `- ${t.error ? '✖' : '✔'} ${t.name}${t.label ? `: \`${t.label.replace(/`/g, "'")}\`` : ''}`));
  }
  if (parsed.errors.length) {
    lines.push('', '## Errors', '', ...parsed.errors.map((e) => `- ${e}`));
  }
  const tail = stderrTail.split('\n').filter((l) => l.trim() && !l.trim().startsWith('{')).slice(-20);
  if (tail.length) {
    lines.push('', '## Log', '', '```', ...tail, '```');
  }
  return `${lines.join('\n')}\n`;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Spawns the CLI in a way that also works for a `.cmd` shim on Windows. */
function spawnCli(l: Launcher, args: string[], env: NodeJS.ProcessEnv): cp.ChildProcess {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(l.command)) {
    const line = [l.command, ...l.args, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ');
    return cp.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true, windowsHide: true });
  }
  return cp.spawn(l.command, [...l.args, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** Runs a schedule now: the one-shot task, its report, and a history line. Overlapping runs of one schedule are skipped. */
export async function runSchedule(s: Schedule, l: Launcher, store: ScheduleStore, opts: { signal?: AbortSignal } = {}): Promise<ScheduleRun> {
  const started = new Date();
  const runId = runIdFor(s.name, started);
  const report = path.join(store.reportsDir, `${runId}.md`);
  fs.mkdirSync(store.reportsDir, { recursive: true });
  const lock = path.join(store.dir, 'running', `${s.name}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const finish = (base: Omit<ScheduleRun, 'report'>, parsed: ParsedRun, stderr = ''): ScheduleRun => {
    const run: ScheduleRun = { ...base, report };
    fs.writeFileSync(report, reportMarkdown(s, base, parsed, stderr));
    store.record(run);
    return run;
  };
  let fd: number;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid && alive(pid)) {
      return finish({ runId, name: s.name, startedAt: started.toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, finishReason: 'skipped', skipped: true }, { answer: '', tools: [], errors: [] });
    }
    fs.rmSync(lock, { force: true });
    fd = fs.openSync(lock, 'wx');
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawnCli(l, runArgs(s), { ...process.env, ...l.env, LOCALPILOT_SCHEDULE: s.name });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => (stdout += b.toString()));
      child.stderr?.on('data', (b: Buffer) => (stderr = (stderr + b.toString()).slice(-200_000)));
      // The run stops itself at --timeout; this is the backstop for a process that hangs anyway.
      const guard = setTimeout(() => child.kill(), (s.timeoutSec + 120) * 1000);
      const onAbort = () => child.kill();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        stderr += `\n${e.message}`;
      });
      child.on('close', (c) => {
        clearTimeout(guard);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ code: c ?? 1, stdout, stderr });
      });
    });
    const parsed = parseRunOutput(stdout, stderr);
    const usage = parsed.result?.usage as { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number } | undefined;
    return finish(
      {
        runId,
        name: s.name,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        exitCode: code,
        finishReason: typeof parsed.result?.finishReason === 'string' ? parsed.result.finishReason : code === 0 ? 'completed' : 'error',
        ...(usage ? { tokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) + (usage.cacheReadTokens ?? 0) } : {}),
        ...(typeof parsed.result?.costUsd === 'number' ? { costUsd: parsed.result.costUsd } : {}),
      },
      parsed,
      stderr
    );
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Starts `schedule run <name>` in the background (the agent tool's run_now) and returns at once. */
export function startDetached(name: string, l: Launcher): void {
  const child = spawnCli(l, ['schedule', 'run', name], { ...process.env, ...l.env });
  child.stdout?.resume();
  child.stderr?.resume();
  child.unref();
}

// ------------------------------------------------------------------ shared operations (CLI and agent tool)

export async function createSchedule(input: Parameters<typeof makeSchedule>[0], l: Launcher, store = new ScheduleStore()): Promise<Schedule> {
  const s = makeSchedule(input);
  if (schedulerKind() === 'schtasks') {
    schtasksArgs(s, l); // refuse what Task Scheduler cannot run before saving anything
  }
  await installEntry(s, l, store);
  store.put(s);
  return s;
}

export async function deleteSchedule(name: string, store = new ScheduleStore()): Promise<boolean> {
  await removeEntry(name);
  return store.remove(name);
}

export async function setPaused(name: string, paused: boolean, l: Launcher, store = new ScheduleStore()): Promise<Schedule | undefined> {
  const s = store.get(name);
  if (!s) {
    return undefined;
  }
  const next = { ...s, paused: paused || undefined };
  if (paused) {
    await removeEntry(name);
  } else {
    await installEntry(next, l, store);
  }
  store.put(next);
  return next;
}

/** Pure: one schedule as a list row. */
export function scheduleRow(s: Schedule, last: ScheduleRun | undefined, now = new Date()): string {
  const next = s.paused ? 'paused' : (() => {
    const n = nextRun(parseCron(s.cron), now);
    return n ? `next ${n.toLocaleString()}` : 'never fires';
  })();
  return `${s.name}  "${s.cron}"  ${next}${last ? ` · last ${last.skipped ? 'skipped' : last.exitCode === 0 ? 'ok' : `exit ${last.exitCode}`} ${last.startedAt.slice(0, 16).replace('T', ' ')}` : ''} · ${s.mode} in ${s.cwd}\n    ${s.prompt.replace(/\s+/g, ' ').slice(0, 100)}`;
}

// ------------------------------------------------------------------ `localpilot schedule …`

export const SCHEDULE_HELP = `localpilot schedule create <name> --cron "<m h dom mon dow>" --prompt "<task>" [--cwd dir] [--mode agent|plan|ask] [--model provider/model] [--timeout 30m]
localpilot schedule list [--json]          schedules with their next run and last result
localpilot schedule run <name>             run one now (what the OS scheduler calls); writes a report
localpilot schedule pause|resume|delete <name>
localpilot schedule history <name> [--limit N] [--json]   past runs and their report files`;

/** `localpilot schedule …`; returns the exit code. */
export async function cmdSchedule(argv: string[], st: Style, l: Launcher = cliLauncher(), store = new ScheduleStore()): Promise<number> {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const eq = /^--([\w-]+)=(.*)$/s.exec(x);
    if (eq) {
      flags[eq[1]] = eq[2];
    } else if (x === '--json') {
      json = true;
    } else if (x === '-C') {
      flags.cwd = argv[++i] ?? '';
    } else if (x === '-m') {
      flags.model = argv[++i] ?? '';
    } else if (x.startsWith('--') && x.length > 2) {
      flags[x.slice(2)] = argv[++i] ?? '';
    } else {
      words.push(x);
    }
  }
  const [action = 'list', name = ''] = words;
  const fail = (msg: string, code = 2) => {
    console.error(`${st.red('✖')} ${msg}`);
    return code;
  };
  const known = ['cron', 'prompt', 'cwd', 'mode', 'model', 'timeout', 'limit'];
  const unknown = Object.keys(flags).find((k) => !known.includes(k));
  if (unknown) {
    return fail(`unknown option --${unknown}\n${st.dim(SCHEDULE_HELP)}`);
  }
  try {
    switch (action) {
      case 'help':
        console.log(SCHEDULE_HELP);
        return 0;
      case 'list':
      case 'ls': {
        const all = store.list();
        if (json) {
          process.stdout.write(`${JSON.stringify(all.map((s) => ({ ...s, next: s.paused ? undefined : nextRun(parseCron(s.cron), new Date())?.toISOString(), last: store.history(s.name, 1)[0] })), null, 2)}\n`);
          return 0;
        }
        if (!all.length) {
          console.log(st.dim('No schedules yet. Create one with: localpilot schedule create nightly --cron "0 3 * * *" --prompt "run the tests and fix what fails"'));
          return 0;
        }
        console.log(all.map((s) => `  ${scheduleRow(s, store.history(s.name, 1)[0])}`).join('\n'));
        console.log(st.dim(`\nRuns by: ${schedulerKind()} · reports in ${store.reportsDir}`));
        return 0;
      }
      case 'create':
      case 'add': {
        if (!name) {
          return fail(`usage: ${SCHEDULE_HELP.split('\n')[0]}`);
        }
        if (store.get(name)) {
          return fail(`a schedule "${name}" exists; delete it first (localpilot schedule delete ${name})`);
        }
        const prompt = flags.prompt ?? words.slice(2).join(' ');
        const s = await createSchedule({ name, cron: flags.cron ?? '', prompt, cwd: flags.cwd || process.cwd(), mode: flags.mode, model: flags.model, timeout: flags.timeout }, l, store);
        const next = nextRun(parseCron(s.cron), new Date());
        console.log(`${st.green('✔')} Scheduled "${s.name}" (${s.cron}) in ${s.cwd}${next ? ` — next run ${next.toLocaleString()}` : ''}${schedulerKind() === 'off' ? st.dim(' (LOCALPILOT_SCHEDULER=off: not added to the OS scheduler)') : st.dim(` via ${schedulerKind()}`)}`);
        return 0;
      }
    }
    if (!name) {
      return fail(`usage: localpilot schedule ${action} <name>`);
    }
    const s = store.get(name);
    if (!s && action !== 'delete' && action !== 'rm') {
      return fail(`no schedule "${name}" — localpilot schedule list shows them`);
    }
    switch (action) {
      case 'run': {
        const run = await runSchedule(s!, l, store);
        if (json) {
          process.stdout.write(`${JSON.stringify(run)}\n`);
        } else {
          console.log(`${run.skipped ? st.yellow('!') : run.exitCode === 0 ? st.green('✔') : st.red('✖')} ${name}: ${run.skipped ? 'skipped (the previous run is still going)' : run.exitCode === 0 ? 'done' : `failed (${run.finishReason ?? `exit ${run.exitCode}`})`}\n  ${st.dim(run.report)}`);
        }
        return run.skipped ? 0 : run.exitCode;
      }
      case 'pause':
      case 'resume': {
        await setPaused(name, action === 'pause', l, store);
        console.log(`${st.green('✔')} ${action === 'pause' ? 'Paused' : 'Resumed'} "${name}"`);
        return 0;
      }
      case 'delete':
      case 'rm':
      case 'remove': {
        const had = await deleteSchedule(name, store);
        return had ? (console.log(`${st.green('✔')} Deleted "${name}"`), 0) : fail(`no schedule "${name}"`);
      }
      case 'history': {
        const runs = store.history(name, Math.max(1, Number(flags.limit) || 20));
        if (json) {
          process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
          return 0;
        }
        if (!runs.length) {
          console.log(st.dim(`"${name}" has not run yet. Run it now with: localpilot schedule run ${name}`));
          return 0;
        }
        console.log(runs.map((r) => `  ${r.skipped ? st.yellow('skipped') : r.exitCode === 0 ? st.green('ok') : st.red(`exit ${r.exitCode}`)}  ${r.startedAt.slice(0, 19).replace('T', ' ')}  ${st.dim(`${Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)} s${r.finishReason && r.exitCode ? ` · ${r.finishReason}` : ''}`)}\n     ${st.dim(r.report)}`).join('\n'));
        return 0;
      }
    }
    return fail(`unknown schedule action "${action}"\n${st.dim(SCHEDULE_HELP)}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 1);
  }
}
