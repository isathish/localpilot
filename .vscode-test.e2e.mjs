import * as fs from 'fs';
export default {
  files: 'out/test/e2e.test.js',
  workspaceFolder: fs.mkdtempSync('/tmp/lp-e2e/ws-'),
  launchArgs: ['--user-data-dir', '/tmp/lp-e2e/ud'],
  env: { LOCALPILOT_TELEMETRY_DIR: '/tmp/lp-e2e/telemetry', LOCALPILOT_SKILL_CATALOG: '/tmp/lp-e2e/cat.json', LOCALPILOT_E2E_MODEL: 'ollama/gemma4:12b' },
  mocha: { timeout: 300000 },
};
