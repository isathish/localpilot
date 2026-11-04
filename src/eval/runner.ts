import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentRunner } from '../agent/agentLoop';
import { runCmd } from '../tools/git';
import { AgentEvent, Session } from '../types';
import { BUILTIN_SUITE, EvalSuite, EvalTask } from './suite';

/**
 * Runs benchmark tasks against models with the real agent loop (same tools, prompts and context management as the
 * chat), each in a fresh temporary workspace, and checks the outcome by running the task's verification. Results are
 * kept under ~/.localpilot/evals so later runs can be compared with earlier ones.
 */

export interface EvalResult {
  task: string;
  category: EvalTask['category'];
  model: string;
  pass: boolean;
  skipped?: string;
  /** Why it failed: the verification's output or the run's error. */
  reason?: string;
  durationMs: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  promptTokens: number;
  completionTokens: number;
}

export interface EvalRun {
  suite: string;
  startedAt: string;
  host: string;
  results: EvalResult[];
}

let pythonExe: string | null | undefined;
async function python(): Promise<string | null> {
  if (pythonExe === undefined) {
    pythonExe = null;
    for (const c of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
      const r = await runCmd(c, c === 'py' ? ['-3', '--version'] : ['--version'], undefined, undefined, 10_000);
      if (r.code === 0 && /Python 3/.test(r.out + r.err)) {
        pythonExe = c;
        break;
      }
    }
  }
  return pythonExe;
}

async function missing(task: EvalTask): Promise<string | undefined> {
  for (const n of task.needs ?? []) {
    if (n === 'python3' ? !(await python()) : (await runCmd(n, ['--version'], undefined, undefined, 10_000)).code !== 0) {
      return `${n} is not installed`;
    }
  }
  return undefined;
}

/** A name that is safe in a file name. */
const slug = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'suite';

const escapes = (dir: string, rel: string) => path.isAbsolute(rel) || path.relative(dir, path.join(dir, rel)).startsWith('..');

/** Writes a task's files into its workspace; a path that would land outside it is rejected. */
export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    if (escapes(dir, rel)) {
      throw new Error(`${rel}: file paths must stay inside the task folder`);
    }
    const f = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(f), { recursive: true });
    await fs.promises.writeFile(f, text);
  }
}

/** Pure part of verification that needs no process: file patterns and the answer. */
export function checkStatic(task: EvalTask, read: (rel: string) => string | undefined, answer: string): string | undefined {
  for (const f of task.verify.files ?? []) {
    const text = read(f.path);
    const hit = text !== undefined && new RegExp(f.pattern, 'm').test(text);
    if (f.absent ? hit : !hit) {
      return f.absent ? `${f.path} still matches /${f.pattern}/` : `${f.path} ${text === undefined ? 'is missing' : `does not match /${f.pattern}/`}`;
    }
  }
  if (task.verify.answer && !new RegExp(task.verify.answer, 'i').test(answer.replace(/\\/g, '/'))) {
    return `the answer does not match /${task.verify.answer}/: ${answer.replace(/\s+/g, ' ').slice(0, 200)}`;
  }
  return undefined;
}

export async function verifyTask(task: EvalTask, dir: string, answer: string): Promise<string | undefined> {
  const stat = checkStatic(task, (rel) => {
    if (escapes(dir, rel)) {
      return undefined;
    }
    try {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      return undefined;
    }
  }, answer);
  if (stat) {
    return stat;
  }
  if (task.verify.command) {
    const py = (await python()) ?? 'python3';
    const [cmd, ...args] = task.verify.command.map((a) => (a === '{python}' ? py : a));
    const r = await runCmd(cmd, py === 'py' && cmd === 'py' ? ['-3', ...args] : args, dir, undefined, 60_000);
    if (r.code !== 0) {
      // The last lines that say something (separator rules and blank lines dropped).
      const tail = (r.err || r.out).split('\n').map((l) => l.trim()).filter((l) => l && !/^[-=]{5,}$/.test(l)).slice(-3).join(' | ');
      return `\`${[cmd, ...args].join(' ')}\` exited ${r.code}: ${tail.slice(0, 300)}`;
    }
    if (task.verify.stdout && !new RegExp(task.verify.stdout, 'm').test(r.out)) {
      return `\`${[cmd, ...args].join(' ')}\` printed ${JSON.stringify(r.out.trim().slice(0, 200))}, expected /${task.verify.stdout}/`;
    }
  }
  return undefined;
}

export interface RunTaskOptions {
  signal?: AbortSignal;
  /** Keep the workspace after the run (its path is reported). */
  keep?: boolean;
  onEvent?: (e: AgentEvent) => void;
}

export async function runTask(runner: AgentRunner, task: EvalTask, model: string, opts: RunTaskOptions = {}): Promise<EvalResult & { workspace?: string }> {
  const base: EvalResult = { task: task.id, category: task.category, model, pass: false, durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0, promptTokens: 0, completionTokens: 0 };
  const skip = await missing(task);
  if (skip) {
    return { ...base, skipped: skip };
  }
  if (opts.signal?.aborted) {
    return { ...base, skipped: 'cancelled' };
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `lp-eval-${slug(task.id)}-`));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (task.timeoutSec ?? 300) * 1000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) {
    ctl.abort();
  }
  const started = Date.now();
  try {
    await writeFiles(dir, task.files ?? {});
    // A repository, as most real workspaces are (some tools and models look for one).
    await runCmd('git', ['init', '-q'], dir);
    const now = Date.now();
    const session: Session = { id: `eval-${task.id}-${now.toString(36)}`, title: task.title, createdAt: now, updatedAt: now, model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: task.mode ?? 'agent', attachments: [], todos: [], workingSet: [] };
    let answer = '';
    try {
      answer = await runner.run({
        session,
        userMessage: { role: 'user', content: task.prompt },
        modelRef: model,
        workspaceRoot: dir,
        signal: ctl.signal,
        // A throwaway workspace: everything the agent asks for is approved, nobody is there to answer questions.
        requestApproval: async () => true,
        unattended: true,
        scratch: true,
        emit: (e) => {
          const p = e.payload as Record<string, unknown> | undefined;
          if (e.type === 'tool_end' && !p?.childId) {
            base.toolCalls++;
            base.toolErrors += p?.isError ? 1 : 0;
          } else if (e.type === 'turn_end' && p) {
            base.steps = Number(p.steps) || 0;
            base.promptTokens = Number(p.promptTokens) || 0;
            base.completionTokens = Number(p.completionTokens) || 0;
            answer = String(p.text ?? answer);
          }
          opts.onEvent?.(e);
        },
      });
    } catch (e) {
      base.reason = ctl.signal.aborted && !opts.signal?.aborted ? `timed out after ${task.timeoutSec ?? 300} s` : e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
    base.durationMs = Date.now() - started;
    // Stopped by the user: not a result of the model, so nothing is verified.
    if (opts.signal?.aborted) {
      return { ...base, pass: false, reason: undefined, skipped: 'cancelled', workspace: opts.keep ? dir : undefined };
    }
    // The time limit aborts the run, which then ends quietly: say so, with what the check found at that point.
    const timedOut = ctl.signal.aborted;
    if (!base.reason) {
      const why = await verifyTask(task, dir, answer);
      base.pass = !why && !timedOut;
      base.reason = timedOut ? `timed out after ${task.timeoutSec ?? 300} s${why ? ` (${why})` : ''}` : why;
    }
  } catch (e) {
    base.pass = false;
    base.reason = e instanceof Error ? e.message : String(e);
    base.durationMs = Date.now() - started;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (!opts.keep) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { ...base, workspace: opts.keep ? dir : undefined };
}

const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

function checkRegex(id: string, what: string, pattern: unknown): void {
  if (typeof pattern !== 'string') {
    throw new Error(`task ${id}: ${what} must be a string`);
  }
  try {
    new RegExp(pattern);
  } catch (e) {
    throw new Error(`task ${id}: ${what} is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Throws, naming the task, when a task in a suite file is malformed; fills in defaults. */
function validateTask(t: Partial<EvalTask> | null, i: number): EvalTask {
  if (!t || typeof t !== 'object') {
    throw new Error(`task #${i + 1}: expected an object`);
  }
  if (typeof t.id !== 'string' || !t.id) {
    throw new Error(`task #${i + 1}: "id" must be a non-empty string`);
  }
  const id = t.id;
  if (typeof t.prompt !== 'string') {
    throw new Error(`task ${id}: "prompt" must be a string`);
  }
  if (!t.verify || typeof t.verify !== 'object') {
    throw new Error(`task ${id}: "verify" must be an object`);
  }
  const files = t.files ?? {};
  if (typeof files !== 'object' || Array.isArray(files) || !Object.values(files).every((v) => typeof v === 'string')) {
    throw new Error(`task ${id}: "files" must map paths to text`);
  }
  if (t.needs !== undefined && !isStrings(t.needs)) {
    throw new Error(`task ${id}: "needs" must be a list of program names`);
  }
  const v = t.verify;
  if (v.command !== undefined && !isStrings(v.command)) {
    throw new Error(`task ${id}: "verify.command" must be a list of strings`);
  }
  if (v.files !== undefined) {
    if (!Array.isArray(v.files) || !v.files.every((f) => f && typeof f.path === 'string' && typeof f.pattern === 'string')) {
      throw new Error(`task ${id}: "verify.files" must be a list of { "path", "pattern" }`);
    }
    v.files.forEach((f) => checkRegex(id, `pattern for ${f.path}`, f.pattern));
  }
  if (v.answer !== undefined) {
    checkRegex(id, '"verify.answer"', v.answer);
  }
  if (v.stdout !== undefined) {
    checkRegex(id, '"verify.stdout"', v.stdout);
  }
  return { ...t, files } as EvalTask;
}

/** A suite from a JSON file (`{ "name", "tasks": [...] }`) or the built-in one. */
export async function loadSuite(spec?: string): Promise<EvalSuite> {
  if (!spec || spec === 'builtin') {
    return BUILTIN_SUITE;
  }
  const raw = JSON.parse(await fs.promises.readFile(spec, 'utf8')) as Partial<EvalSuite>;
  if (!Array.isArray(raw.tasks)) {
    throw new Error(`${spec}: expected { "name": "...", "tasks": [{ "id", "title", "category", "files", "prompt", "verify" }] }`);
  }
  let tasks: EvalTask[];
  try {
    tasks = raw.tasks.map((t, i) => validateTask(t as Partial<EvalTask> | null, i));
  } catch (e) {
    throw new Error(`${spec}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { name: typeof raw.name === 'string' && raw.name ? raw.name : path.basename(spec, '.json'), tasks };
}

/** Suites a project keeps in `.localpilot/evals/*.json` (by name; files without a `tasks` list, such as saved runs, are left out). */
export async function projectSuites(root: string): Promise<string[]> {
  const dir = path.join(root, '.localpilot', 'evals');
  // From the home folder that is where run results are saved, not suites.
  if (path.resolve(dir) === path.resolve(historyDir())) {
    return [];
  }
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(dir, n), 'utf8')) as { tasks?: unknown };
      if (Array.isArray(raw?.tasks)) {
        out.push(path.join(dir, n));
      }
    } catch {
      /* not a suite */
    }
  }
  return out;
}

export const historyDir = () => path.join(os.homedir(), '.localpilot', 'evals');

export async function saveRun(run: EvalRun): Promise<string> {
  await fs.promises.mkdir(historyDir(), { recursive: true });
  const file = path.join(historyDir(), `${run.startedAt.replace(/[:.]/g, '-')}-${slug(run.suite)}.json`);
  await fs.promises.writeFile(file, JSON.stringify(run, null, 2));
  return file;
}

/** The latest earlier run of the same suite that included `model`, for the comparison column. */
export async function previousRun(suite: string, model: string, before: string): Promise<EvalRun | undefined> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(historyDir())).filter((f) => f.endsWith(`-${slug(suite)}.json`)).sort().reverse();
  } catch {
    return undefined;
  }
  for (const f of files) {
    try {
      const run = JSON.parse(await fs.promises.readFile(path.join(historyDir(), f), 'utf8')) as EvalRun;
      if (run.suite === suite && run.startedAt < before && run.results.some((r) => r.model === model && !r.skipped)) {
        return run;
      }
    } catch {
      /* unreadable entry */
    }
  }
  return undefined;
}

export interface ModelSummary {
  model: string;
  passed: number;
  total: number;
  skipped: number;
  avgSeconds: number;
  avgSteps: number;
  avgToolCalls: number;
  tokens: number;
  toolErrorRate: number;
}

/** Pure: per-model totals, best pass rate first. */
export function summarize(results: EvalResult[]): ModelSummary[] {
  const by = new Map<string, EvalResult[]>();
  for (const r of results) {
    by.set(r.model, [...(by.get(r.model) ?? []), r]);
  }
  return [...by].map(([model, rs]) => {
    const ran = rs.filter((r) => !r.skipped);
    const avg = (f: (r: EvalResult) => number) => (ran.length ? ran.reduce((n, r) => n + f(r), 0) / ran.length : 0);
    const calls = ran.reduce((n, r) => n + r.toolCalls, 0);
    return {
      model,
      passed: ran.filter((r) => r.pass).length,
      total: ran.length,
      skipped: rs.length - ran.length,
      avgSeconds: avg((r) => r.durationMs / 1000),
      avgSteps: avg((r) => r.steps),
      avgToolCalls: avg((r) => r.toolCalls),
      tokens: ran.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0),
      toolErrorRate: calls ? ran.reduce((n, r) => n + r.toolErrors, 0) / calls : 0,
    };
  }).sort((a, b) => b.passed / Math.max(1, b.total) - a.passed / Math.max(1, a.total) || a.avgSeconds - b.avgSeconds);
}

/** Pure: the Markdown report (summary table, then a task × model matrix with the failure reasons). */
export function formatReport(run: EvalRun, previous?: Map<string, EvalRun>): string {
  const sums = summarize(run.results);
  const pct = (s: ModelSummary) => (s.total ? Math.round((s.passed / s.total) * 100) : 0);
  const delta = (s: ModelSummary) => {
    const prev = previous?.get(s.model);
    if (!prev) {
      return '';
    }
    const p = summarize(prev.results.filter((r) => r.model === s.model))[0];
    const d = pct(s) - (p ? pct(p) : 0);
    return d ? ` (${d > 0 ? '+' : ''}${d})` : ' (=)';
  };
  const models = sums.map((s) => s.model);
  const tasks = [...new Set(run.results.map((r) => r.task))];
  const cell = (task: string, model: string) => {
    const r = run.results.find((x) => x.task === task && x.model === model);
    return !r ? '' : r.skipped ? 'skipped' : r.pass ? `✔ ${(r.durationMs / 1000).toFixed(0)} s` : '✖';
  };
  const failures = run.results.filter((r) => !r.pass && !r.skipped);
  return [
    `# LocalPilot benchmark: ${run.suite}`,
    `${run.startedAt.slice(0, 16).replace('T', ' ')} · ${run.host} · ${tasks.length} task${tasks.length === 1 ? '' : 's'} × ${models.length} model${models.length === 1 ? '' : 's'}`,
    '',
    '| Model | Passed | Avg time | Avg steps | Avg tool calls | Tool errors | Tokens |',
    '|---|---|---|---|---|---|---|',
    ...sums.map((s) => `| ${s.model} | ${s.passed}/${s.total} (${pct(s)}%${delta(s)})${s.skipped ? `, ${s.skipped} skipped` : ''} | ${s.avgSeconds.toFixed(0)} s | ${s.avgSteps.toFixed(1)} | ${s.avgToolCalls.toFixed(1)} | ${(s.toolErrorRate * 100).toFixed(0)}% | ${s.tokens.toLocaleString()} |`),
    '',
    `| Task | ${models.join(' | ')} |`,
    `|---|${models.map(() => '---').join('|')}|`,
    ...tasks.map((t) => `| ${t} | ${models.map((m) => cell(t, m)).join(' | ')} |`),
    ...(failures.length ? ['', '**Failures**', ...failures.map((r) => `- ${r.task} · ${r.model}: ${r.reason}`)] : []),
  ].join('\n');
}
