/**
 * Smoke checks (bundled into scripts/smoke.ts) for the chat's What's new card and the path-link existence check.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { changelogHighlights, LAST_SEEN_VERSION, WhatsNew } from '../src/ui/whatsNew';
import { checkPathsExist, pathCandidates } from '../src/ui/chatUiExtras';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const LOG = ['# Changelog', '', '## Unreleased', '- **Not yet.** x', '', '## 1.2.0 — 2026-01-01', '', '### Added', '- **Task header.** Shows the first prompt.', '- Plain bullet. With more text.', '', '## 1.1.0', '- **Old.**'].join('\n');

function memento(init: Record<string, unknown> = {}) {
  const data = { ...init };
  return { data, get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => { data[k] = v; }, keys: () => Object.keys(data) };
}

export async function chatUxSmoke(check: Check): Promise<void> {
  console.log('\n[chat UX: what\'s new / path links]');
  const h = changelogHighlights(LOG, '1.2.0');
  check('changelogHighlights: bold titles and first sentences of the version section', h.join('|') === 'Task header.|Plain bullet.', h);
  check('changelogHighlights: no section, nothing', changelogHighlights(LOG, '9.9.9').length === 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-chatux-'));
  try {
    const log = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(log, LOG);
    const fresh = memento();
    check('WhatsNew: a fresh install shows nothing and remembers the version', !new WhatsNew(fresh, '1.2.0', log).pending && fresh.data[LAST_SEEN_VERSION] === '1.2.0');
    const updated = memento({ [LAST_SEEN_VERSION]: '1.1.0' });
    const w = new WhatsNew(updated, '1.2.0', log);
    check('WhatsNew: an update shows the card', w.pending?.version === '1.2.0' && w.pending.bullets.length === 2, w.pending);
    await w.dismiss();
    check('WhatsNew: dismissed for good', !w.pending && !new WhatsNew(updated, '1.2.0', log).pending);

    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), '');
    const roots = { folders: [{ name: 'ws', fsPath: dir }] };
    check('pathCandidates: ".." is never resolved', pathCandidates('../etc/passwd', roots).length === 0);
    const r = await checkPathsExist(['src/a.ts', 'src/missing.ts', 'src/a.ts#L3', path.join(dir, 'src')], roots);
    check('checkPathsExist: existing files, folders and anchors', r['src/a.ts'] === true && r['src/missing.ts'] === false && r['src/a.ts#L3'] === true && r[path.join(dir, 'src')] === true, r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
