import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CHECKS_JSON_TEMPLATE, ensureChecksJson, healingPolicyRows, healingView } from '../ui/healingChecksView';

const HEALING_KEYS = [
  'enabled', 'autoDetect', 'autoRetry', 'autoFix', 'regressionRequired', 'maxRepairAttempts', 'maxTotalAttempts', 'extraSteps', 'taskDeadlineMinutes',
  'checkTiming', 'scopeTests', 'checkTimeoutSeconds', 'checkTimeBudgetSeconds', 'baseline', 'checks', 'policies', 'dependencyInstall', 'gitConflicts',
  'securityCheck', 'delegateFixes', 'memory',
].map((k) => `healing.${k}`);

suite('Settings page: self-healing', () => {
  const ext = () => vscode.extensions.getExtension('localpilot.localpilot-agent')!;
  const read = (rel: string) => fs.readFileSync(path.join(ext().extensionPath, rel), 'utf8');

  test('every healing setting is writable, searchable under Agent and has a row in the Agent section', () => {
    const panel = read('src/ui/settingsPanel.ts');
    const webview = read('media/settings.js');
    const settingKeys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    // The Self-healing block: healingSettings() plus the helpers it renders (checks list, retry configuration).
    const section = /function healingSettings\(\) \{([\s\S]*?)\n {2}\/\*\* A value that is fixed by design/.exec(webview)?.[1] ?? '';
    assert.ok(settingKeys && fieldIndex && section, 'SETTING_KEYS, FIELD_INDEX and healingSettings() are found');
    assert.match(webview, /function secAgent\(sec\) \{[\s\S]*?sec\.appendChild\(healingSettings\(\)\);\n {2}\}/, 'the Self-healing block is part of the Agent section');
    for (const key of HEALING_KEYS) {
      assert.ok(settingKeys.includes(`'${key}'`), `${key} is writable from Settings (SETTING_KEYS)`);
      assert.match(fieldIndex, new RegExp(`\\['agent', '${key.replace(/\./g, '\\.')}', '`), `${key} is in the settings search under Agent`);
      assert.ok(section.includes(`field('${key}', `), `${key} has a row in the Self-healing block`);
    }
    assert.match(section, /field\('healing\.checks', [^\n]*'json'/, 'healing.checks keeps "Edit in settings.json" as a secondary action');
    assert.match(section, /field\('healing\.policies', [^\n]*'json'/, 'healing.policies keeps "Edit in settings.json" as a secondary action');
    assert.match(section, /^ {6}healingChecks\(\),\n {6}healingPolicies\(\)\n {4}\);/m, 'the checks list and the retry table are part of the Self-healing card');
    assert.match(section, /field\('healing\.gitConflicts', [^\n]*off: /, 'git conflicts are shown read-only');
    assert.match(section, /lockedRow\('Security bypass', 'Disabled \(cannot be enabled\)'/, 'the security bypass is shown as a locked row');
    assert.ok(!/healing\.securityBypass|healing\.bypass/.test(webview + panel), 'there is no security bypass setting');
    assert.match(webview, /self-healing recovery retry checks tests regression/, 'the Agent section is found by the self-healing keywords');
  });

  test('the retry configuration table edits healing.policies per category, within the safety limits', () => {
    const webview = read('media/settings.js');
    const fn = /function healingPolicies\(\) \{([\s\S]*?)\n {2}\}/.exec(webview)?.[1] ?? '';
    assert.ok(fn, 'healingPolicies() is found');
    assert.match(fn, /'Retry configuration'/, 'the table has its heading');
    assert.match(fn, /for \(const p of h\.policies\)/, 'one row per category sent by the host');
    assert.match(fn, /<th scope="col">Attempts<\/th><th scope="col">Waits between retries<\/th><th scope="col">Time limit per attempt<\/th>/, 'attempts, backoff and timeout columns');
    assert.match(fn, /num\(ov\.attempts \?\? Math\.min\(p\.attempts, p\.max\), 0, p\.max, 'attempts'\)/, 'attempts are limited to the category maximum');
    assert.match(fn, /num\(ov\.timeoutSeconds \?\? p\.timeoutSeconds, 1, 3600, /, 'the timeout follows the package.json range');
    assert.match(fn, /set\('healing\.policies', next\)/, 'a change writes the merged healing.policies object');
    assert.match(fn, /const next = \{ \.\.\.cur \};/, 'other categories are kept');
    assert.match(fn, /component\(f, \['healing\.enabled', 'healing\.policies'\], healingPolicies\)/, 'the table refreshes when the setting changes');
  });

  test('the host sends the default policy table with the safety maxima', () => {
    const rows = healingPolicyRows();
    const by = Object.fromEntries(rows.map((r) => [r.category, r]));
    assert.strictEqual(rows.length, 22, 'every failure category has a row');
    assert.strictEqual(by.security.max, 3);
    assert.strictEqual(by.data_corruption.max, 0);
    assert.strictEqual(by.git_conflict.max, 0);
    assert.strictEqual(by.data_corruption.attempts, 0);
    assert.strictEqual(by.git_conflict.attempts, 0);
    assert.deepStrictEqual(by.model_unavailable.backoffMs, [1000, 2000, 4000]);
    assert.ok(rows.every((r) => r.attempts <= r.max && r.max <= 10), 'defaults never exceed the maxima');
  });

  test('detected checks are listed with their source and checks.json can be opened', () => {
    const webview = read('media/settings.js');
    const panel = read('src/ui/settingsPanel.ts');
    const fn = /function healingChecks\(\) \{([\s\S]*?)\n {2}\}/.exec(webview)?.[1] ?? '';
    assert.ok(fn, 'healingChecks() is found');
    assert.match(fn, /'Detected checks for this workspace'/, 'the list has its heading');
    assert.match(fn, /for \(const c of h\.checks\)/, 'one row per check sent by the host');
    assert.match(fn, /c\.source === 'setting'/, 'the source of each check is shown');
    assert.match(fn, /post\(\{ type: 'openChecksJson' \}\)/, 'Open checks.json posts its own message');
    assert.match(fn, /ignored in an untrusted workspace; your User value still applies\./, 'the trust note names only workspace-controlled sources');
    assert.match(panel, /\| \{ type: 'openChecksJson' \}/, 'the message is part of the allowed webview messages');
    assert.match(panel, /case 'openChecksJson':\n\s+return this\.openChecks \? this\.openChecks\(\)\.then\(\(\) => this\.pushChecks\(\)\) : this\.openChecksJson\(\);/, 'the host handles it');
    assert.match(panel, /healing,\n\s+\}\);/, 'the state carries the detected checks');
  });

  test('check discovery, overrides and trust for the Settings list', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-checks-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .', test: 'mocha' } }));
      fs.writeFileSync(path.join(root, 'yarn.lock'), '');
      fs.writeFileSync(path.join(root, 'go.mod'), 'module x\n');
      const user = [{ id: 'npm:lint', kind: 'lint', command: 'yarn run lint:strict' }];
      const workspace = [{ id: 'custom:ws', kind: 'test', command: 'make e2e' }];
      let v = await healingView(root, { user, workspace }, true);
      const ids = v.checks.map((c) => c.id);
      for (const id of ['npm:build', 'npm:lint', 'npm:test', 'go:build', 'go:vet', 'go:test', 'security', 'custom:ws']) {
        assert.ok(ids.includes(id), `${id} is listed`);
      }
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:build')?.command, 'yarn run build', 'the package manager follows the lockfile');
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:lint')?.source, 'discovered', 'a workspace value replaces the User list');
      assert.strictEqual(v.checks.find((c) => c.id === 'custom:ws')?.scope, 'workspace');
      assert.strictEqual(v.checksJson, 'missing');

      const created = await ensureChecksJson(root);
      assert.ok(created.created);
      assert.strictEqual(fs.readFileSync(created.file, 'utf8'), CHECKS_JSON_TEMPLATE);
      assert.deepStrictEqual(JSON.parse(CHECKS_JSON_TEMPLATE).checks, [], 'the template adds no checks');
      fs.writeFileSync(created.file, JSON.stringify({ checks: [{ id: 'npm:test', command: 'yarn run test:unit' }], disable: ['go:vet'] }));
      assert.strictEqual((await ensureChecksJson(root)).created, false, 'an existing file is never overwritten');

      v = await healingView(root, { user, workspace }, true);
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:test')?.source, 'checks.json', 'checks.json wins');
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:test')?.command, 'yarn run test:unit');
      assert.ok(!v.checks.some((c) => c.id === 'go:vet') && v.disabled.includes('go:vet'), 'disabled ids are dropped');

      v = await healingView(root, { user, workspace }, false);
      assert.strictEqual(v.trusted, false);
      assert.ok(!v.checks.some((c) => c.id === 'custom:ws'), 'the workspace value is ignored when untrusted');
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:test')?.source, 'discovered', 'checks.json is ignored when untrusted');
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:lint')?.command, 'yarn run lint:strict', 'the User value still applies');
      assert.strictEqual(v.checks.find((c) => c.id === 'npm:lint')?.scope, 'user');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('installs and the security check are User-only on the page', () => {
    const webview = read('media/settings.js');
    const userOnly = /const USER_ONLY = \(k\) => (.*);/.exec(webview)?.[1] ?? '';
    for (const key of ['healing.dependencyInstall', 'healing.securityCheck']) {
      assert.ok(userOnly.includes(`k === '${key}'`), `${key} is marked User only`);
    }
    assert.ok(!userOnly.includes(`'healing.checks'`) && !userOnly.includes(`'healing.enabled'`), 'other healing settings follow the selected scope');
  });
});
