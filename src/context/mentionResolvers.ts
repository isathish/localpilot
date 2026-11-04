import * as vscode from 'vscode';
import { getConfig } from '../config';
import { runCmd } from '../tools/git';
import { fetchReadable } from '../tools/web';
import { flooredApproval, getManagedPolicy } from '../agent/managedPolicy';
import { attachmentKind, extractDocumentText, formatSize, looksBinary } from './extractors';
import { commitBlock, FOLDER_CHARS, FolderChild, formatFolderContent, isCommitRef, parseCommitLog, URL_CHARS, urlBlock } from './mentionRefs';

/** Non-image files over this size are refused as attachments (PDFs have their own `localpilot.pdf.maxReadSizeMB`). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Children of an attached folder over this size are listed, not inlined. */
const MAX_CHILD_BYTES = 2 * 1024 * 1024;

/** `@folder`: a one-level tree plus the text of every direct child file (see `formatFolderContent` for the caps). */
export async function readFolderContent(uri: vscode.Uri, rel: string, log?: { warn(m: string): void }): Promise<string> {
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const children: FolderChild[] = [];
  let read = 0;
  for (const [name, type] of entries) {
    if (type & vscode.FileType.Directory) {
      children.push({ name, dir: true });
      continue;
    }
    const child = vscode.Uri.joinPath(uri, name);
    const kind = attachmentKind(name);
    try {
      const { size } = await vscode.workspace.fs.stat(child);
      if (kind === 'image' || kind === 'binary' || kind === 'pdf') {
        children.push({ name, note: `${kind === 'pdf' ? 'PDF' : kind}, ${formatSize(size)}${kind === 'pdf' ? '; attach it on its own to read it' : ''}` });
      } else if (size > MAX_CHILD_BYTES) {
        children.push({ name, note: `${formatSize(size)}, too large to inline; read it with read_file` });
      } else if (read >= FOLDER_CHARS) {
        children.push({ name, skipped: true });
      } else {
        const data = await vscode.workspace.fs.readFile(child);
        if (kind === 'text' && looksBinary(data.subarray(0, 8192))) {
          children.push({ name, note: `binary, ${formatSize(size)}` });
          continue;
        }
        const text = kind === 'text' ? Buffer.from(data).toString('utf8') : ((await extractDocumentText(name, data, kind)) ?? '');
        read += text.length;
        children.push({ name, text });
      }
    } catch (e) {
      log?.warn(`folder attachment: ${name}: ${String(e)}`);
      children.push({ name, note: 'unreadable' });
    }
  }
  return formatFolderContent(rel, children);
}

/** `@<sha>`: the commit's header, stat and patch from the first root that has it; undefined when none does. */
export async function readCommit(sha: string, roots: readonly string[]): Promise<string | undefined> {
  for (const cwd of new Set(roots)) {
    const ok = await runCmd('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd, undefined, 10_000);
    if (ok.code !== 0) {
      continue;
    }
    const full = ok.out.trim();
    const show = await runCmd('git', ['show', '--stat', '--patch', '--format=fuller', '--no-color', full], cwd, undefined, 20_000);
    if (show.code === 0) {
      return commitBlock(full.slice(0, 12), show.out);
    }
  }
  return undefined;
}

/**
 * Commits for the `@` menu: the one a typed hash names (7+ hex digits), then recent commits whose message matches
 * `query` (case-insensitive).
 */
export async function searchCommits(query: string, root: string | undefined, max = 10): Promise<{ sha: string; subject: string }[]> {
  if (!root) {
    return [];
  }
  const out: { sha: string; subject: string }[] = [];
  if (isCommitRef(query)) {
    const r = await runCmd('git', ['log', '-n', '1', '--format=%h %s', '--no-color', `${query}^{commit}`, '--'], root, undefined, 5_000);
    if (r.code === 0) {
      out.push(...parseCommitLog(r.out));
    }
  }
  const args = ['log', '-n', String(max), '-i', '--fixed-strings', '--format=%h %s', '--no-color'];
  if (query) {
    args.push(`--grep=${query}`);
  }
  const r = await runCmd('git', args, root, undefined, 5_000);
  if (r.code === 0) {
    out.push(...parseCommitLog(r.out).filter((c) => !out.some((o) => o.sha === c.sha)));
  }
  return out.slice(0, max);
}

/**
 * `@https://…`: the page as readable text, through the same conversion as `web_fetch`. Refused when web access is off
 * (managed policy or `localpilot.webSearch.enabled`) or network approvals are `never`; `ask` goes through `approve`.
 */
export async function readUrl(url: string, approve?: (url: string) => Promise<boolean>): Promise<string> {
  const policy = getManagedPolicy();
  if (!policy.allowWebAccess || !getConfig().webEnabled) {
    return urlBlock(url, '(Web access is turned off, so the page was not fetched.)', 'web access off');
  }
  const mode = flooredApproval(policy, 'network', getConfig().approvals.network);
  if (mode === 'never' || (mode === 'ask' && !(await approve?.(url)))) {
    return urlBlock(url, `(Fetching ${url} was not approved.)`, 'declined');
  }
  try {
    const r = await fetchReadable(url, URL_CHARS);
    return r.error ? urlBlock(url, `(Could not fetch the page: ${r.error})`, 'unreadable') : urlBlock(url, r.text);
  } catch (e) {
    return urlBlock(url, `(Could not fetch the page: ${e instanceof Error ? e.message : String(e)})`, 'unreadable');
  }
}
