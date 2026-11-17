// Downloads the VS Code build the Extension Host tests run in, retrying on network errors.
// A shared CI runner sometimes cannot reach update.code.visualstudio.com for a minute (ETIMEDOUT while
// "Resolving version…"), which failed the whole test job before a single test ran. Once the build is in
// .vscode-test/, `vscode-test` falls back to it if the version lookup fails again.
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const attempts = 5;
for (let i = 1; i <= attempts; i++) {
  try {
    const exe = await downloadAndUnzipVSCode({ version: 'stable', timeout: 60_000 });
    console.log(`VS Code ready: ${exe}`);
    process.exit(0);
  } catch (e) {
    const wait = Math.min(60, 10 * i);
    console.warn(`Download attempt ${i}/${attempts} failed: ${e instanceof Error ? e.message : e}${i < attempts ? `; retrying in ${wait} s` : ''}`);
    if (i < attempts) {
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}
console.error('::error::Could not download VS Code for the Extension Host tests');
process.exit(1);
