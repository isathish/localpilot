import * as path from 'path';
import * as vscode from 'vscode';
import { buildInstructions } from '../context/instructions';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage } from '../types';
import { quickPrompt } from './inlineEdit';

/** The parts of the built-in Git extension's API (`vscode.git`, version 1) this command uses. */
interface GitChange {
  uri: vscode.Uri;
  status: number;
}
export interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: { indexChanges: GitChange[]; workingTreeChanges: GitChange[]; untrackedChanges?: GitChange[] };
  diff(cached?: boolean): Promise<string>;
}
interface GitApi {
  repositories: GitRepository[];
}

export const MAX_DIFF_CHARS = 5000;
/** `Status.UNTRACKED` in the Git extension API. */
const UNTRACKED = 7;

/** The diff cut to `max` characters (at a line break when one is near), with a note saying how much was left out. */
export function truncateDiff(diff: string, max = MAX_DIFF_CHARS): string {
  if (diff.length <= max) {
    return diff;
  }
  const cut = diff.lastIndexOf('\n', max);
  const kept = diff.slice(0, cut > max * 0.8 ? cut : max);
  return `${kept}\n… [diff truncated: showing ${kept.length.toLocaleString('en-US')} of ${diff.length.toLocaleString('en-US')} characters]`;
}

const COMMIT_WORDS = /\bcommit(s|ted|ting)?\b|\bconventional[- ]commits?\b|\bchangelog\b|\bsigned-off-by\b|\bco-authored-by\b|\bsubject line\b/i;

/**
 * The project-rule lines about commits: whole sections whose heading mentions commits, otherwise single matching lines
 * (a bullet in a longer list). Empty when the rules say nothing about commits.
 */
export function commitRules(rules: string, max = 1500): string {
  const out: string[] = [];
  for (const section of rules.split(/\n(?=#{1,6} )/)) {
    const [head, ...rest] = section.split('\n');
    if (/^#{1,6} /.test(head) && COMMIT_WORDS.test(head)) {
      out.push(section.trim());
    } else {
      out.push(...[head, ...rest].filter((l) => !/^<!--/.test(l) && COMMIT_WORDS.test(l)).map((l) => l.trim()));
    }
  }
  const text = out.filter(Boolean).join('\n');
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** The single request that writes the message: the diff, the user's notes from the input box and the commit rules. */
export function commitMessagePrompt(diff: string, opts: { notes?: string; rules?: string; untracked?: string[]; staged?: boolean } = {}): ChatMessage[] {
  const system = [
    'You write git commit messages. Reply with the message only: no code fences, no preamble, no commentary.',
    'Format: a subject line of at most 72 characters in the imperative mood, then, only if the change needs it, a blank line and a short body (bullets are fine) saying what changed and why.',
    opts.rules ? `Follow the project's commit conventions:\n${opts.rules}` : 'Use the Conventional Commits style (`type(scope): subject`) unless the diff shows the project uses another.',
  ].join('\n\n');
  const user = [
    opts.notes?.trim() ? `Notes from the author (use them; they may be a draft of the message):\n${opts.notes.trim()}` : '',
    opts.untracked?.length ? `New files not shown in the diff: ${opts.untracked.join(', ')}` : '',
    `${opts.staged ? 'Staged changes' : 'Changes (nothing is staged)'}:\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``,
  ].filter(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: user.join('\n\n') },
  ];
}

/** The model's reply as a commit message: reasoning tags, fences and a "Commit message:" label removed. Works on partial text. */
export function cleanCommitMessage(text: string): string {
  let t = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  t = t.replace(/^\s*(\*\*)?commit message:?(\*\*)?:?\s*/i, '');
  t = t.replace(/^\s*(```|~~~)[\w-]*[ \t]*\n?/, '').replace(/\n?(```|~~~)\s*$/, '');
  return t.replace(/[ \t]+$/gm, '').trim();
}

async function gitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    return (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  } catch {
    return undefined;
  }
}

const changeCount = (r: GitRepository) => r.state.indexChanges.length + r.state.workingTreeChanges.length + (r.state.untrackedChanges?.length ?? 0);
const samePath = (a: vscode.Uri, b: vscode.Uri) => path.relative(a.fsPath, b.fsPath) === '';

/**
 * The repositories to write messages for: the Source Control title argument's, else the ones with changes (a QuickPick,
 * with "All", when there are several). Undefined when the user cancels.
 */
async function pickRepositories(api: GitApi, arg: unknown): Promise<GitRepository[] | undefined> {
  const root = (arg as { rootUri?: unknown } | undefined)?.rootUri;
  if (root instanceof vscode.Uri) {
    const hit = api.repositories.find((r) => samePath(r.rootUri, root));
    if (hit) {
      return [hit];
    }
  }
  const changed = api.repositories.filter((r) => changeCount(r) > 0);
  const pool = changed.length ? changed : api.repositories;
  if (pool.length <= 1) {
    return pool;
  }
  type Item = vscode.QuickPickItem & { repos: GitRepository[] };
  const items: Item[] = [
    ...pool.map((r) => ({ label: path.basename(r.rootUri.fsPath), description: vscode.workspace.asRelativePath(r.rootUri, true), detail: `${changeCount(r)} change${changeCount(r) === 1 ? '' : 's'}`, repos: [r] })),
    { label: 'All', description: `${pool.length} repositories`, repos: pool },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Generate commit message for…', placeHolder: 'Repository' });
  return pick?.repos;
}

let running: AbortController | undefined;

async function setRunning(ac: AbortController | undefined): Promise<void> {
  running = ac;
  await vscode.commands.executeCommand('setContext', 'localpilot.generatingCommit', !!ac);
}

/** Stops a commit message that is being written (the Source Control Stop button). */
export function stopCommitMessage(): void {
  running?.abort();
}

/** Writes one repository's message, streaming it into its Source Control input box. False when there is nothing to describe. */
export async function writeCommitMessage(providers: ProviderRegistry, repo: GitRepository, signal: AbortSignal): Promise<boolean> {
  let diff = await repo.diff(true);
  const staged = !!diff.trim();
  if (!staged) {
    diff = await repo.diff(false);
  }
  const untracked = staged ? [] : [...(repo.state.untrackedChanges ?? []), ...repo.state.workingTreeChanges.filter((c) => c.status === UNTRACKED)].map((c) => path.relative(repo.rootUri.fsPath, c.uri.fsPath).split(path.sep).join('/'));
  const uniqueUntracked = [...new Set(untracked)].slice(0, 50);
  if (!diff.trim() && !uniqueUntracked.length) {
    return false;
  }
  const rules = commitRules(await buildInstructions([repo.rootUri.fsPath]).then((r) => r.text, () => ''));
  const notes = repo.inputBox.value;
  const messages = commitMessagePrompt(diff, { notes, rules, untracked: uniqueUntracked, staged });
  let raw = '';
  try {
    raw = await quickPrompt(providers, messages, {
      signal,
      maxTokens: 400,
      temperature: 0.2,
      onDelta: (t) => {
        raw += t;
        const shown = cleanCommitMessage(raw);
        if (shown) {
          repo.inputBox.value = shown;
        }
      },
    });
  } catch (e) {
    if (!signal.aborted) {
      repo.inputBox.value = notes;
      throw e;
    }
  }
  const message = cleanCommitMessage(raw).trim();
  repo.inputBox.value = message || notes;
  return true;
}

/**
 * Generates commit messages into the Source Control input boxes with one model call per repository (no agent, no
 * tools). Returns false when the Git extension is unavailable, so the caller can fall back to the agent.
 */
export async function generateCommitMessage(providers: ProviderRegistry, arg?: unknown): Promise<boolean> {
  if (running) {
    return true;
  }
  const api = await gitApi();
  if (!api) {
    return false;
  }
  if (!api.repositories.length) {
    void vscode.window.showInformationMessage('No Git repository is open.');
    return true;
  }
  const repos = await pickRepositories(api, arg);
  if (!repos?.length) {
    return true;
  }
  const ac = new AbortController();
  await setRunning(ac);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Generating commit message' }, async () => {
      const empty: string[] = [];
      for (const repo of repos) {
        if (ac.signal.aborted) {
          break;
        }
        if (!(await writeCommitMessage(providers, repo, ac.signal))) {
          empty.push(path.basename(repo.rootUri.fsPath));
        }
      }
      if (empty.length) {
        void vscode.window.showInformationMessage(`No changes to describe in ${empty.join(', ')}.`);
      }
    });
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot: commit message failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await setRunning(undefined);
  }
  return true;
}
