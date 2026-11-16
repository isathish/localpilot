import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A fresh, empty workspace folder so the end-to-end tests have a real place to edit files.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-ws-'));
// The Extension Host runs with its own throwaway home folder, so nothing a test does (MCP servers, keys and secrets,
// plugins, MCP trust, handoffs, evals, memory, skills, worktrees, telemetry…) can read or write the developer's
// real ~/.localpilot. VS Code itself is unaffected: the test runner passes --user-data-dir and --extensions-dir.
const realHome = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-home-'));
const lp = path.join(home, '.localpilot');
fs.mkdirSync(lp, { recursive: true });

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	env: {
		HOME: home,
		USERPROFILE: home,
		LOCALPILOT_TEST_HOME: home,
		// Explicit overrides as well, for modules that have one. LOCALPILOT_DATA_DIR and LOCALPILOT_CONTINUITY_DIR stay
		// unset on purpose: the home folder already covers them, and without them each continuity test gets its own
		// throwaway folder and the extension does not import CLI chats (see src/ui/continuityData.ts).
		LOCALPILOT_MCP_SETTINGS_PATH: path.join(lp, 'mcp.json'),
		LOCALPILOT_SCHEDULES_HOME: lp,
		// telemetry.test.ts asserts this folder ends in "telemetry".
		LOCALPILOT_TELEMETRY_DIR: path.join(lp, 'telemetry'),
		LOCALPILOT_SKILL_CATALOG: path.join(lp, 'skill-catalog.json'),
		LOCALPILOT_WORKTREES_DIR: path.join(lp, 'worktrees'),
		// Never touch the OS keychain; the encrypted secret store uses this passphrase instead.
		LOCALPILOT_KEYCHAIN: 'none',
		LOCALPILOT_SECRETS_PASSPHRASE: 'test-passphrase',
		LOCALPILOT_SECRETS_DIR: path.join(lp, 'secrets'),
		// The continuity machine id (device binding) stays in the throwaway home too.
		LOCALPILOT_MACHINE_ID_FILE: path.join(lp, 'machine-id'),
		// Opt-in real-model tests (LOCALPILOT_E2E_MODEL) keep finding the models already downloaded under the real home.
		OLLAMA_MODELS: process.env.OLLAMA_MODELS || path.join(realHome, '.ollama', 'models'),
	},
	mocha: { timeout: 20_000 },
});
