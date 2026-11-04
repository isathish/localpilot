import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildRepoGraph, fileKey, parseSource } from '../context/repoGraph';
import { answerRepoGraph } from '../tools/repoGraph';

/** Builds the graph of a temporary folder holding `files` (path → content). */
async function graphOf(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-graph-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  try {
    return await buildRepoGraph(root, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const list = (s: Set<string> | undefined) => [...(s ?? [])].sort();

suite('LocalPilot repo graph', () => {
  test('Java (Maven layout): imports resolve by declared package, and the root package is not external', async () => {
    const g = await graphOf({
      'src/main/java/com/acme/app/Main.java': 'package com.acme.app;\n\nimport com.acme.app.util.Helper;\nimport java.util.List;\n\npublic class Main {}\n',
      'src/main/java/com/acme/app/util/Helper.java': 'package com.acme.app.util;\n\npublic class Helper {}\n',
    });
    assert.deepStrictEqual(list(g.deps.get('src/main/java/com/acme/app/Main.java')), ['src/main/java/com/acme/app/util/Helper.java']);
    assert.ok(!g.external.has('com'));
    assert.ok(g.external.has('java'));
  });

  test('C#: `using A.B;` links to the files declaring that namespace', async () => {
    const g = await graphOf({
      'Program.cs': 'using System;\nusing MyApp.Services;\n\nnamespace MyApp;\n\npublic class Program {}\n',
      'Services/UserService.cs': 'namespace MyApp.Services;\n\npublic class UserService {}\n',
    });
    assert.deepStrictEqual(list(g.deps.get('Program.cs')), ['Services/UserService.cs']);
  });

  test('Go: an import links every file of the package, and its tests depend on all of them', async () => {
    const g = await graphOf({
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
      'internal/store/a.go': 'package store\n',
      'internal/store/b.go': 'package store\n',
      'internal/store/c.go': 'package store\n',
      'internal/store/b_test.go': 'package store\n',
      'cmd/main.go': 'package main\n\nimport "example.com/demo/internal/store"\n',
    });
    assert.ok(g.rdeps.get('internal/store/b.go')?.has('cmd/main.go'));
    assert.ok(g.rdeps.get('internal/store/c.go')?.has('cmd/main.go'));
    assert.ok(g.rdeps.get('internal/store/a.go')?.has('internal/store/b_test.go'));
  });

  test('Python: `from pkg import module` next to the importing file links the module', async () => {
    const g = await graphOf({
      'backend/pkg/__init__.py': '',
      'backend/pkg/db.py': 'def connect():\n    pass\n',
      'backend/app.py': 'from pkg import db\n',
    });
    assert.deepStrictEqual(list(g.deps.get('backend/app.py')), ['backend/pkg/__init__.py', 'backend/pkg/db.py']);
    assert.ok(!g.external.has('pkg'));
  });

  test('Python: parenthesised multi-line imports record every name', () => {
    const p = parseSource('from . import (\n  a,\n  b,  # comment\n)\nfrom x import (y,\n  z as w)\n', 'py');
    assert.ok(p.imports.includes('.a') && p.imports.includes('.b'));
    assert.ok(p.imports.includes('x'));
    assert.deepStrictEqual(p.optionalImports, ['x.y', 'x.z']);
  });

  test('fileKey: a path with a directory must match it; folders are reported, not resolved to a file', async () => {
    const g = await graphOf({ 'src/a.ts': "import { b } from './lib/b';\n", 'src/lib/b.ts': 'export const b = 1;\n' });
    assert.strictEqual(fileKey(g, 'wrong/dir/a.ts').key, undefined);
    assert.strictEqual(fileKey(g, 'a.ts').key, 'src/a.ts');
    assert.strictEqual(fileKey(g, 'lib/b.ts').key, 'src/lib/b.ts');
    assert.strictEqual(fileKey(g, '../src/a.ts').key, undefined);
    const dir = answerRepoGraph(g, 'dependents', 'src/lib');
    assert.ok(dir.isError && /is a folder/.test(dir.content) && dir.content.includes('src/lib/b.ts'));
    assert.ok(answerRepoGraph(g, 'dependents', 'b.ts').content.startsWith('Resolved "b.ts" to src/lib/b.ts.'));
  });
});
