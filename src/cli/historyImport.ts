import { ageLabel } from './sessions';
import { Style } from './providers';
import { alreadyImported, findImportable, ImportCandidate, ImportSource, importInto, ImportTarget, readImport, SOURCE_LABEL } from '../sessions/importers';

/** Pure: which candidates a selection names: `all`, list numbers (`1,3`, `2-4`) or session id prefixes. */
export function selectCandidates(list: ImportCandidate[], picks: string[]): { chosen: ImportCandidate[]; unknown: string[] } {
  const chosen = new Set<ImportCandidate>();
  const unknown: string[] = [];
  for (const raw of picks.flatMap((p) => p.split(',')).map((p) => p.trim()).filter(Boolean)) {
    if (raw === 'all') {
      list.forEach((c) => chosen.add(c));
      continue;
    }
    const range = /^(\d+)(?:-(\d+))?$/.exec(raw);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2] ?? range[1]);
      const hits = list.slice(Math.max(0, Math.min(a, b) - 1), Math.max(a, b));
      if (!hits.length) {
        unknown.push(raw);
      }
      hits.forEach((c) => chosen.add(c));
      continue;
    }
    const byId = list.filter((c) => c.id.startsWith(raw));
    if (byId.length === 1) {
      chosen.add(byId[0]);
    } else {
      unknown.push(raw);
    }
  }
  return { chosen: list.filter((c) => chosen.has(c)), unknown };
}

/**
 * `localpilot history import [claude|codex] [all | 1,3 | <id>] [--json]`: the Claude Code and Codex chats of this folder,
 * imported into its saved sessions (then `localpilot -r` resumes them). Without a selection it lists them and, at a
 * terminal, asks which. Returns the exit code.
 */
export async function cmdHistoryImport(store: ImportTarget, words: string[], opts: { json: boolean; home?: string }, st: Style, cwd: string, ask?: (q: string) => Promise<string | undefined>): Promise<number> {
  const src: Record<string, ImportSource> = { claude: 'claude-code', 'claude-code': 'claude-code', codex: 'codex' };
  const sources = words[0] && src[words[0].toLowerCase()] ? [src[words.shift()!.toLowerCase()]] : undefined;
  const list = findImportable(cwd, { home: opts.home, sources });
  const known = store.list();
  if (!words.length) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(list.map((c) => ({ source: c.source, id: c.id, title: c.title, createdAt: new Date(c.createdAt).toISOString(), updatedAt: new Date(c.updatedAt).toISOString(), messages: c.messageCount, imported: !!alreadyImported(known, c), file: c.file })), null, 2)}\n`);
      return 0;
    }
    if (!list.length) {
      console.log(st.dim(`No ${sources ? SOURCE_LABEL[sources[0]] : 'Claude Code or Codex'} chats for ${cwd}.`));
      return 0;
    }
    const width = String(list.length).length;
    console.log(list.map((c, i) => `  ${st.amber(String(i + 1).padStart(width))}. ${st.bold(c.title)}  ${st.dim(`${SOURCE_LABEL[c.source]} · ${ageLabel(c.updatedAt)} · ${c.messageCount} message${c.messageCount === 1 ? '' : 's'}${alreadyImported(known, c) ? ' · imported' : ''}`)}`).join('\n'));
    const answer = ask ? (await ask(`${st.amber('?')} Import which? ${st.dim('(numbers like 1,3 or 2-5, all; Enter to cancel)')} `))?.trim() : undefined;
    if (!answer) {
      if (!ask) {
        console.log(st.dim('\nImport with: localpilot history import <numbers|all>'));
      }
      return 0;
    }
    words = [answer];
  }
  const { chosen, unknown } = selectCandidates(list, words);
  if (unknown.length) {
    console.error(st.red(`not in the list: ${unknown.join(', ')} — localpilot history import lists them`));
    return 2;
  }
  const results: { id: string; source: ImportSource; title: string; session: string; created: boolean }[] = [];
  for (const c of chosen) {
    const r = await importInto(store, readImport(c));
    results.push({ id: c.id, source: c.source, title: c.title, session: r.session.id, created: r.created });
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  for (const r of results) {
    console.log(`${r.created ? st.green('✔') : st.dim('·')} ${r.title} ${st.dim(`(${SOURCE_LABEL[r.source]}${r.created ? '' : ', already imported'} → ${r.session})`)}`);
  }
  console.log(st.dim(`Resume one with: localpilot -r <id>`));
  return 0;
}
