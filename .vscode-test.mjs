import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A fresh, empty workspace folder so the end-to-end tests have a real place to edit files.
const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-ws-'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	mocha: { timeout: 20_000 },
});
