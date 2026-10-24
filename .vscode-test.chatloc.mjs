import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const workspaceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'localpilot-test-ws-'));

export default defineConfig({
  files: 'out/test/e2e.test.js',
  workspaceFolder,
  mocha: { timeout: 40_000 },
  env: { LOCALPILOT_E2E_MODEL: 'ollama/qwen2.5-coder:7b' },
});
