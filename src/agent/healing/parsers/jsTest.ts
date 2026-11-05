import { relativePath } from '../signature';
import { excerpt, finish, isPackageSpecifier, lines, looksIntegration, make, packageName, stackFrames, type ParsedFailure } from './common';

const MISSING_MODULE = /(?:Cannot find (?:module|package) ['"]([^'"]+)['"]|Failed to (?:load|resolve) (?:url|import) ['"]?([^'"\s]+)['"]?)/;
const STATUS = /expected (?:status(?: code)?|response(?: status)?)\b.*?\b[1-5]\d\d\b|\bstatus(?: code)?\b.*expected.*\b[1-5]\d\d\b|\bexpected [1-5]\d\d\b.*\b(?:got|received)\b/i;
const SUMMARY = /^\s*(?:Tests?|Test Suites|Test Files|Snapshots|Time|Ran all test suites|Duration|Start at)\b/;

interface Block {
  test: string;
  /** Test file named by the runner (FAIL line, location). */
  file?: string;
  body: string[];
  from: number;
  to: number;
}

/** The first meaningful line of a failure body: the error/assertion, not blank lines or code frames. */
function firstMessage(body: readonly string[]): string {
  for (const l of body) {
    const t = l.trim();
    if (!t || /^at\s/.test(t) || /^[>|]?\s*\d+\s*\|/.test(t) || /^\|/.test(t) || /^[-+]{3}\s/.test(t) || /^❯\s/.test(t) || /^[⎯─-]{3,}/.test(t)) {
      continue;
    }
    return t.replace(/\s*\/\/ Object\.is equality$/, '');
  }
  return 'test failed';
}

function toFailure(b: Block, ls: readonly string[], root: string): ParsedFailure {
  const evidence = excerpt(ls, b.from, b.to);
  const message = firstMessage(b.body);
  const frames = stackFrames(b.body.join('\n'), root);
  const testFile = b.file ? relativePath(b.file, root) : undefined;
  const inTest = testFile ? frames.find((f) => f.file === testFile) : undefined;
  const file = testFile ?? frames[0]?.file;
  const line = inTest?.line ?? (testFile ? undefined : frames[0]?.line);
  const missing = MISSING_MODULE.exec(b.body.join('\n'));
  const spec = missing ? missing[1] ?? missing[2] : undefined;
  if (spec && isPackageSpecifier(spec)) {
    return make('dependency', { code: 'MODULE_NOT_FOUND', message: missing![0], file, line, test: b.test, symbol: packageName(spec), evidence }, root);
  }
  const body = b.body.join('\n');
  const crossModule = /is not a function/.test(message) && !!frames[0] && !!testFile && frames[0].file !== testFile;
  const integration = looksIntegration(testFile, b.test) || STATUS.test(body) || /ECONNREFUSED/.test(body) || crossModule;
  const code = /AssertionError|expect\(|Expected|toBe|toEqual|assert/.test(body) ? 'assertion' : /^(\w*Error)\b/.exec(message)?.[1];
  return make(integration ? 'integration_test' : 'unit_test', { code, message, file, line, test: b.test, evidence }, root);
}

/** Jest/vitest (`● Suite › test`, ` FAIL  file > suite > test`), mocha (`N failing`, `1) suite test:`) and node:test (TAP `not ok`, spec `✖`). */
export function parseJsTest(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const blocks: Block[] = [];
  let failFile: string | undefined;
  let mochaFailing = false;
  let nodeFailing = false;
  let nodeTestAt: string | undefined;
  const close = (b: Block | undefined, to: number) => {
    if (b) {
      b.to = to;
      b.body = ls.slice(b.from + 1, to);
      blocks.push(b);
    }
  };
  let open: Block | undefined;
  let openKind: 'jest' | 'vitest' | 'mocha' | 'node' | 'tap' | undefined;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const t = l.trim();
    // Jest file header; vitest's has the test path after ' > '.
    const fail = /^\s*FAIL\s+(\S+?\.[cm]?[jt]sx?)(?:\s+>\s+(.+?))?(?:\s+\[.*\])?(?:\s+\([^)]*\))?\s*$/.exec(l);
    if (fail) {
      if (fail[2]) {
        close(open, i);
        open = { test: fail[2].replace(/\s+>\s+/g, ' › '), file: fail[1], body: [], from: i, to: i };
        openKind = 'vitest';
      } else {
        if (openKind === 'jest') {
          close(open, i);
          open = undefined;
        }
        failFile = fail[1];
      }
      continue;
    }
    if (/^\s*PASS\s+\S/.test(l) || SUMMARY.test(l)) {
      if (open && (openKind === 'jest' || openKind === 'vitest')) {
        close(open, i);
        open = undefined;
      }
      continue;
    }
    const jest = /^\s*● (.+)$/.exec(l);
    if (jest && !/^Console$/.test(jest[1].trim())) {
      close(open, i);
      open = { test: jest[1].trim(), file: failFile, body: [], from: i, to: i };
      openKind = 'jest';
      continue;
    }
    if (/^\s*\d+ failing\s*$/.test(l)) {
      close(open, i);
      open = undefined;
      mochaFailing = true;
      continue;
    }
    if (mochaFailing) {
      const m = /^(\s*)(\d+)\) (.+)$/.exec(l);
      if (m) {
        close(open, i);
        // The title runs on until a line ending with ':' (suite and test on separate lines).
        const title = [m[3].trim()];
        let j = i;
        while (!title[title.length - 1].endsWith(':') && j + 1 < ls.length && ls[j + 1].trim() && j - i < 6) {
          j++;
          title.push(ls[j].trim());
        }
        open = { test: title.join(' ').replace(/:$/, ''), body: [], from: j, to: j };
        openKind = 'mocha';
        i = j;
        continue;
      }
    }
    // node:test spec reporter: "✖ failing tests:" then "test at file:l:c" + "✖ name (ms)".
    if (/^✖ failing tests:/.test(t)) {
      close(open, i);
      open = undefined;
      nodeFailing = true;
      continue;
    }
    if (nodeFailing) {
      const at = /^test at (.+?):(\d+):(\d+)$/.exec(t);
      if (at) {
        close(open, i);
        open = undefined;
        nodeTestAt = at[1];
        continue;
      }
      const x = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(t);
      if (x) {
        close(open, i);
        open = { test: x[1], file: nodeTestAt, body: [], from: i, to: i };
        openKind = 'node';
        nodeTestAt = undefined;
        continue;
      }
    }
    // TAP (node:test with --test-reporter=tap, tap/tape).
    const tap = /^(\s*)not ok \d+ - (.+?)(?:\s+#\s.*)?$/.exec(l);
    if (tap) {
      close(open, i);
      open = { test: tap[2].trim(), body: [], from: i, to: i };
      openKind = 'tap';
      continue;
    }
    if (openKind === 'tap' && open && (/^\s*(?:ok|not ok) \d+/.test(l) || /^\s*# (?:tests|pass|fail|Subtest)\b/.test(l))) {
      close(open, i);
      open = undefined;
    }
  }
  close(open, ls.length);

  const out: ParsedFailure[] = [];
  for (const b of blocks) {
    if (/^Test suite failed to run$/.test(b.test)) {
      b.test = '';
    }
    const body = b.body.join('\n');
    if (b.body.length && /failureType: '?subtestsFailed'?/.test(body)) {
      continue;
    }
    if (b.body.some((x) => /^\s*---\s*$/.test(x))) {
      // node:test TAP diagnostics: location + error.
      const loc = /location: '([^']+?):(\d+):(\d+)'/.exec(body);
      b.file = loc?.[1];
      const msgLines: string[] = [];
      const at = b.body.findIndex((x) => /^\s*error:/.test(x));
      if (at >= 0) {
        const inline = /^\s*error:\s*(?:[|>]-?\s*)?(.*?)\s*$/.exec(b.body[at])![1].replace(/^'(.*)'$/, '$1');
        const next = b.body.slice(at + 1).find((x) => x.trim());
        const msg = inline || next?.trim();
        if (msg) {
          msgLines.push(msg);
        }
      }
      b.body = [...msgLines, ...b.body];
      const f = toFailure(b, ls, root);
      if (loc && !f.line) {
        f.line = Number(loc[2]);
      }
      out.push(f);
      continue;
    }
    out.push(toFailure(b, ls, root));
  }
  return finish(out, root);
}
