import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A fresh, empty workspace folder so the end-to-end tests have a real place to edit files.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-ws-'));
// Tests configure made-up providers and probe them; their metrics must land here, not in the real ~/.localpilot/telemetry.
const telemetryDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-home-')), 'telemetry');
// Auto-install records ("installed then deleted → never again") must not leak into the real ~/.localpilot either.
const skillCatalog = path.join(path.dirname(telemetryDir), 'skill-catalog.json');
// Worktrees the agent tests create stay out of the real ~/.localpilot/worktrees.
const worktreesDir = path.join(path.dirname(telemetryDir), 'worktrees');
// The secret store: a throwaway folder, unlocked by a test passphrase, never the developer's keychain or ~/.localpilot.
const secretsDir = path.join(path.dirname(telemetryDir), 'secrets');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	// The secret store and the continuity machine id (device binding) stay out of the real keychain and ~/.localpilot.
	env: { LOCALPILOT_TELEMETRY_DIR: telemetryDir, LOCALPILOT_SKILL_CATALOG: skillCatalog, LOCALPILOT_WORKTREES_DIR: worktreesDir, LOCALPILOT_KEYCHAIN: 'none', LOCALPILOT_SECRETS_PASSPHRASE: 'test-passphrase', LOCALPILOT_SECRETS_DIR: secretsDir, LOCALPILOT_MACHINE_ID_FILE: path.join(path.dirname(telemetryDir), 'machine-id') },
	mocha: { timeout: 20_000 },
});
