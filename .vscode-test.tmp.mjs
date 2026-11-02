import * as fs from 'fs';
export default {
  files: 'out/test/**/*.test.js',
  workspaceFolder: fs.mkdtempSync('/tmp/lp-test-IjF9/ws-'),
  launchArgs: ['--user-data-dir', '/tmp/lp-test-IjF9/ud'],
  env: { LOCALPILOT_TELEMETRY_DIR: '/tmp/lp-test-IjF9/telemetry', LOCALPILOT_SKILL_CATALOG: '/tmp/lp-test-IjF9/cat.json' },
  mocha: { timeout: 60000 },
};
