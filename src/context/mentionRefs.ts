/**
 * Pure parts of the `@folder/`, `@<commit>` and `@https://…` mentions: recognising the refs and shaping the blocks the
 * model sees. No `vscode` import, so the smoke test checks them offline; the I/O lives in `mentionResolvers.ts`.
 */

export const FOLDER_FILE_CHARS = 20_000;
export const FOLDER_CHARS = 60_000;
export const COMMIT_CHARS = 30_000;
export const URL_CHARS = 20_000;
/** Children listed in a folder's tree; the rest are counted. */
const TREE_ENTRIES = 300;

/** 7 to 40 hex digits: an abbreviated or full commit hash. */
export function isCommitRef(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref.replace(/^@/, ''));
}

export function isUrlRef(ref: string): boolean {
  return /^https?:\/\/[^\s"<>]+$/i.test(ref.replace(/^@/, ''));
}

export const xmlAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export interface FolderChild {
  name: string;
  dir?: boolean;
  /** Text of a readable file (cut by `formatFolderContent`). */
  text?: string;
  /** Why a file has no text (binary, too large …), shown in the tree. */
  note?: string;
  /** Not read because the folder limit was already reached. */
  skipped?: boolean;
}

const clip = (text: string, max: number, hint: string) =>
  text.length > max ? `${text.slice(0, max)}\n… [cut at ${max.toLocaleString()} of ${text.length.toLocaleString()} characters; ${hint}]` : text;

/**
 * A folder as attached context: a one-level tree (folders first, then files, by name) and the text of every direct
 * child file, each cut at `fileChars` and all of them together at `folderChars`. Subfolders are only listed.
 */
export function formatFolderContent(rel: string, children: readonly FolderChild[], limits: { fileChars?: number; folderChars?: number } = {}): string {
  const fileChars = limits.fileChars ?? FOLDER_FILE_CHARS;
  const folderChars = limits.folderChars ?? FOLDER_CHARS;
  const sorted = [...children].sort((a, b) => Number(!!b.dir) - Number(!!a.dir) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shown = sorted.slice(0, TREE_ENTRIES);
  const tree = shown.map((c, i) => {
    const last = i === shown.length - 1 && sorted.length <= TREE_ENTRIES;
    return `${last ? '└──' : '├──'} ${c.name}${c.dir ? '/' : ''}${c.note ? ` (${c.note})` : ''}`;
  });
  if (sorted.length > TREE_ENTRIES) {
    tree.push(`└── … ${sorted.length - TREE_ENTRIES} more`);
  }
  const prefix = rel && rel !== '.' ? `${rel.replace(/\/+$/, '')}/` : '';
  const blocks: string[] = [];
  const left: string[] = [];
  let budget = folderChars;
  for (const c of sorted) {
    if (c.skipped) {
      left.push(c.name);
    }
    if (c.dir || c.text === undefined) {
      continue;
    }
    const path = `${prefix}${c.name}`;
    let text = clip(c.text, fileChars, `read the rest with read_file`);
    if (budget < Math.min(500, text.length)) {
      left.push(c.name);
      continue;
    }
    text = clip(text, budget, `the folder limit was reached; attach ${c.name} on its own`);
    budget -= Math.min(text.length, budget);
    blocks.push(`<file_content path="${xmlAttr(path)}">\n${text}\n</file_content>`);
  }
  if (left.length) {
    blocks.push(`(Not included, over the ${folderChars.toLocaleString()}-character folder limit: ${left.join(', ')}. Attach or read them individually.)`);
  }
  const body = [tree.length ? tree.join('\n') : '(empty folder)', ...blocks].join('\n\n');
  return `<folder_content path="${xmlAttr(rel || '.')}">\n${body}\n</folder_content>`;
}

/** `git log --format=%h %s` output as menu entries. */
export function parseCommitLog(out: string): { sha: string; subject: string }[] {
  return out
    .split('\n')
    .map((l) => /^([0-9a-f]{7,40}) (.*)$/i.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ sha: m[1], subject: m[2] }));
}

/** `git show --stat --patch --format=fuller` output for one commit, cut at `max` characters. */
export function commitBlock(sha: string, show: string, max = COMMIT_CHARS): string {
  return `<git_commit hash="${xmlAttr(sha)}">\n${clip(show.trimEnd(), max, `run git show ${sha} -- <path> for one file`)}\n</git_commit>`;
}

export function urlBlock(url: string, body: string, error?: string): string {
  return `<url_content url="${xmlAttr(url)}"${error ? ` error="${xmlAttr(error)}"` : ''}>\n${body}\n</url_content>`;
}
