import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A fresh, empty workspace folder so the end-to-end tests have a real place to edit files.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-ws-'));
// Tests configure made-up providers and probe them; their metrics must land here, not in the real ~/.localpilot/telemetry.
const telemetryDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-home-')), 'telemetry');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	env: { LOCALPILOT_TELEMETRY_DIR: telemetryDir },
	mocha: { timeout: 20_000 },
});
