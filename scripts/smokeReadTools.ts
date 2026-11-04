/**
 * Smoke checks for the read and edit tools (bundled into scripts/smoke.ts): read_file argument normalization and
 * windows, the edit diff, and the cache that keeps the full text of cut tool output (lp-cache://).
 */
import { ContextManager } from '../src/context/contextManager';
import { CACHE_EXPIRED, ToolResultCache, toolResultCache } from '../src/context/toolResultCache';
import { lenientMatch, normalizeReadArgs, renderWindow } from '../src/tools/readArgs';
import { unifiedDiff } from '../src/tools/lineDiff';
import { parseArgs } from '../src/tools/registry';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function readTools(check: Check): Promise<void> {
  console.log('\n[read_file / edit_file / tool output cache]');
  const one = normalizeReadArgs({ path: 'a.ts', start_line: '4', end_line: '8' });
  check('normalizeReadArgs: path with string line numbers', Array.isArray(one) && one[0].path === 'a.ts' && one[0].start === 4 && one[0].end === 8, one);
  const many = normalizeReadArgs({ files: [{ path: 'a' }, { path: 'b', start_line: 3 }, 'c'] });
  check('normalizeReadArgs: files batch', Array.isArray(many) && many.length === 3 && many[1].start === 3, many);
  const aliases = [normalizeReadArgs({ file_path: 'x' }), normalizeReadArgs({ filePath: 'x' }), normalizeReadArgs({ paths: ['x'] }), normalizeReadArgs({ file_paths: 'x' }), normalizeReadArgs(parseArgs('"x"'))];
  check('normalizeReadArgs: aliases and a bare string', aliases.every((a) => Array.isArray(a) && a.length === 1 && a[0].path === 'x'), aliases);
  check('normalizeReadArgs: more than 8 files is an error', typeof normalizeReadArgs({ paths: Array.from({ length: 9 }, (_, i) => `f${i}`) }) === 'string');
  const lines = Array.from({ length: 2500 }, (_, i) => `l${i + 1}`);
  const w = renderWindow((i) => lines[i], lines.length);
  check('read window: 2,000 lines and a continue footer', w.end === 2000 && w.text.endsWith('[Showing lines 1-2000 of 2500. Use start_line/end_line to read more.]'), w.text.slice(-120));
  check('read window: long lines end with [line truncated]', renderWindow(() => 'z'.repeat(3000), 1).text.endsWith(' [line truncated]'));
  check('lenientMatch: U+202F in a screenshot name', lenientMatch('Shot 9.41 AM.png', ['Shot 9.41\u202FAM.png']) === 'Shot 9.41\u202FAM.png');
  check('unifiedDiff: one changed line', unifiedDiff('a\nb\nc', 'a\nB\nc') === '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');

  const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 300, sessionId: 'smoke' });
  const full = Array.from({ length: 200 }, (_, i) => `out ${i}`).join('\n');
  const cut = cm.clampToolOutput(full);
  const ref = /lp-cache:\/\/smoke\/[0-9a-z]+\.txt/.exec(cut)?.[0];
  check('clampToolOutput stores the full text and names its lp-cache reference', !!ref && toolResultCache.get(ref) === full && /read_file path="lp-cache:/.test(cut), cut);
  const c = new ToolResultCache(1000, 5);
  const a = c.put('s', 'a'.repeat(300));
  c.put('s', 'b'.repeat(300));
  check('tool output cache: LRU eviction past the size cap', c.get(a) === undefined && c.size('s') <= 1000);
  const d = c.put('s', 'd');
  for (let i = 0; i < 6; i++) {
    c.tick('s');
  }
  check('tool output cache: idle entries expire after 5 iterations', c.get(d) === undefined && /DO NOT repeat side-effecting commands/.test(CACHE_EXPIRED));
}
