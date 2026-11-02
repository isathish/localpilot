/**
 * The built-in benchmark: small, real coding tasks a local model should handle, each in its own throwaway workspace
 * and each checked by running something, not by asking a model whether the answer looks right. They need only Python 3
 * and Node.js (tasks whose interpreter is missing are skipped, not failed).
 */

export interface EvalTask {
  id: string;
  title: string;
  category: 'fix' | 'implement' | 'refactor' | 'edit' | 'understand';
  /** Workspace files, relative path → content. */
  files: Record<string, string>;
  prompt: string;
  mode?: 'agent' | 'ask';
  /** Programs that must be on PATH (`python3`, `node`). */
  needs?: string[];
  verify: {
    /** argv run in the workspace; passes on exit code 0. `{python}` is replaced with the Python 3 executable found. */
    command?: string[];
    /** Files that must (or, with `absent`, must not) match. */
    files?: { path: string; pattern: string; absent?: boolean }[];
    /** The final answer must match (case-insensitive). */
    answer?: string;
  };
  timeoutSec?: number;
}

export interface EvalSuite {
  name: string;
  tasks: EvalTask[];
}

const PY_TEST = (mod: string, body: string) => `import unittest\nfrom ${mod} import *\n\nclass T(unittest.TestCase):\n${body}\n\nif __name__ == '__main__':\n    unittest.main()\n`;

export const BUILTIN_SUITE: EvalSuite = {
  name: 'builtin',
  tasks: [
    {
      id: 'py-off-by-one',
      title: 'Fix an off-by-one bug so the tests pass',
      category: 'fix',
      needs: ['python3'],
      files: {
        'pager.py': 'def page(items, n, size):\n    """Return page n (1-based) of items, size items per page."""\n    start = n * size\n    return items[start:start + size]\n',
        'test_pager.py': PY_TEST('pager', '    def test_first(self):\n        self.assertEqual(page(list(range(10)), 1, 3), [0, 1, 2])\n\n    def test_last(self):\n        self.assertEqual(page(list(range(10)), 4, 3), [9])'),
      },
      prompt: 'The tests in test_pager.py fail. Fix the bug in pager.py (do not change the tests) and run the tests to confirm.',
      verify: { command: ['{python}', '-m', 'unittest', '-q', 'test_pager'] },
    },
    {
      id: 'js-implement-slugify',
      title: 'Implement a function from its tests',
      category: 'implement',
      needs: ['node'],
      files: {
        'slug.js': "// Turn a title into a URL slug. See test.js for the exact rules.\nfunction slugify(text) {\n  throw new Error('not implemented');\n}\nmodule.exports = { slugify };\n",
        'test.js': "const assert = require('assert');\nconst { slugify } = require('./slug');\nassert.strictEqual(slugify('Hello World'), 'hello-world');\nassert.strictEqual(slugify('  Trim   me  '), 'trim-me');\nassert.strictEqual(slugify('Ünïcödé & Co!'), 'unicode-co');\nassert.strictEqual(slugify('a--b__c'), 'a-b-c');\nconsole.log('ok');\n",
      },
      prompt: 'Implement slugify in slug.js so that `node test.js` passes. Read test.js for the rules.',
      verify: { command: ['node', 'test.js'] },
    },
    {
      id: 'py-rename-across-files',
      title: 'Rename a function everywhere it is used',
      category: 'refactor',
      needs: ['python3'],
      files: {
        'geo/__init__.py': '',
        'geo/calc.py': 'import math\n\n\ndef dist(a, b):\n    return math.hypot(a[0] - b[0], a[1] - b[1])\n',
        'geo/route.py': 'from geo.calc import dist\n\n\ndef length(points):\n    return sum(dist(p, q) for p, q in zip(points, points[1:]))\n',
        'main.py': 'from geo.calc import dist\nfrom geo.route import length\n\nprint(round(dist((0, 0), (3, 4)), 1), round(length([(0, 0), (3, 4), (3, 0)]), 1))\n',
      },
      prompt: 'Rename the function `dist` in geo/calc.py to `euclidean_distance` and update every place that uses it. `python3 main.py` must still print "5.0 9.0".',
      verify: { command: ['{python}', 'main.py'], files: [{ path: 'geo/calc.py', pattern: 'def euclidean_distance\\(' }, { path: 'geo/route.py', pattern: '\\bdist\\(', absent: true }, { path: 'main.py', pattern: '\\bdist\\(', absent: true }] },
    },
    {
      id: 'js-signature-change',
      title: 'Change a shared function and update its callers',
      category: 'refactor',
      needs: ['node'],
      files: {
        'src/money.js': "// Format cents as a price.\nfunction format(cents) {\n  return '$' + (cents / 100).toFixed(2);\n}\nmodule.exports = { format };\n",
        'src/cart.js': "const { format } = require('./money');\nexports.total = (items) => format(items.reduce((s, i) => s + i.cents, 0));\n",
        'src/receipt.js': "const { format } = require('./money');\nexports.line = (name, cents) => `${name}: ${format(cents)}`;\n",
        'test.js': "const assert = require('assert');\nconst { format } = require('./src/money');\nconst { total } = require('./src/cart');\nconst { line } = require('./src/receipt');\nassert.strictEqual(format(1999, 'EUR'), '€19.99');\nassert.strictEqual(format(500, 'USD'), '$5.00');\nassert.strictEqual(total([{ cents: 250 }, { cents: 100 }], 'EUR'), '€3.50');\nassert.strictEqual(line('Tea', 300, 'EUR'), 'Tea: €3.00');\nconsole.log('ok');\n",
      },
      prompt: 'Add a currency parameter to format in src/money.js: format(cents, currency) where currency is "USD" ($) or "EUR" (€). Pass the currency through every caller (total(items, currency), line(name, cents, currency)). `node test.js` must pass.',
      verify: { command: ['node', 'test.js'] },
    },
    {
      id: 'json-config-edit',
      title: 'Edit a config file precisely',
      category: 'edit',
      needs: ['python3'],
      files: {
        'config.json': '{\n  "server": { "port": 8080, "host": "0.0.0.0" },\n  "features": { "beta": false, "search": true },\n  "retries": 3\n}\n',
      },
      prompt: 'In config.json change the port to 9090, turn the beta feature on, and add "timeoutMs": 5000 at the top level. Keep everything else as it is and keep the file valid JSON.',
      verify: { command: ['{python}', '-c', "import json; c=json.load(open('config.json')); assert c['server']=={'port':9090,'host':'0.0.0.0'}, c; assert c['features']=={'beta':True,'search':True}, c; assert c['retries']==3 and c['timeoutMs']==5000, c"] },
    },
    {
      id: 'js-async-bug',
      title: 'Fix a missing await in async code',
      category: 'fix',
      needs: ['node'],
      files: {
        'store.js': "const db = new Map();\nexports.save = async (k, v) => { await new Promise((r) => setTimeout(r, 5)); db.set(k, v); };\nexports.load = async (k) => db.get(k);\nexports.saveAll = async (pairs) => {\n  for (const [k, v] of pairs) {\n    exports.save(k, v);\n  }\n};\n",
        'test.js': "const assert = require('assert');\nconst s = require('./store');\n(async () => {\n  await s.saveAll([['a', 1], ['b', 2]]);\n  assert.strictEqual(await s.load('a'), 1);\n  assert.strictEqual(await s.load('b'), 2);\n  console.log('ok');\n})().catch((e) => { console.error(e); process.exit(1); });\n",
      },
      prompt: '`node test.js` fails: values saved with saveAll are not there when it returns. Find and fix the cause in store.js.',
      verify: { command: ['node', 'test.js'], files: [{ path: 'test.js', pattern: "assert.strictEqual\\(await s.load\\('a'\\), 1\\)" }] },
    },
    {
      id: 'ask-where-defined',
      title: 'Answer where something is handled',
      category: 'understand',
      mode: 'ask',
      files: {
        'app/routes.py': 'from app.handlers import users, orders\n\nROUTES = {"/users": users.list_users, "/orders": orders.create_order}\n',
        'app/handlers/users.py': 'def list_users():\n    return []\n',
        'app/handlers/orders.py': 'from app.payments import charge\n\n\ndef create_order(cart):\n    charge(cart.total)\n    return {"ok": True}\n',
        'app/payments.py': 'def charge(amount):\n    if amount <= 0:\n        raise ValueError("amount must be positive")\n',
        'app/__init__.py': '', 'app/handlers/__init__.py': '',
      },
      prompt: 'Which file contains the check that rejects a non-positive payment amount? Answer with the file path.',
      verify: { answer: 'app/payments\\.py' },
    },
    {
      id: 'ask-impact',
      title: 'Say what breaks if a module changes',
      category: 'understand',
      mode: 'ask',
      files: {
        'lib/units.ts': 'export const toKm = (m: number) => m / 1000;\n',
        'lib/trip.ts': "import { toKm } from './units';\nexport const tripKm = (meters: number[]) => meters.map(toKm).reduce((a, b) => a + b, 0);\n",
        'app/summary.ts': "import { tripKm } from '../lib/trip';\nexport const summary = (m: number[]) => `${tripKm(m)} km`;\n",
        'app/other.ts': 'export const hello = () => "hi";\n',
      },
      prompt: 'If I change lib/units.ts, which other files could be affected? List them.',
      verify: { answer: '(?=[\\s\\S]*lib/trip\\.ts)(?=[\\s\\S]*app/summary\\.ts)(?![\\s\\S]*app/other\\.ts)' },
    },
  ],
};
