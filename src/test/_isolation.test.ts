import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Root hook for every Extension Host suite (a top-level suiteSetup applies to all files). .vscode-test.mjs runs VS Code with a throwaway
 * HOME so tests never touch the developer's real ~/.localpilot.
 *
 * With a fresh home, VS Code's first settings write after startup can take 10–30 s while the workbench finishes its
 * own first-run work (seen on macOS with VS Code 1.146), which would eat the timeout of whichever test writes a
 * setting first. Warm that path up once here, with a generous timeout.
 */
suiteSetup(async function () {
  this.timeout(120_000);
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const prev = cfg.inspect('showWelcomeOnStartup')?.globalValue;
  await cfg.update('showWelcomeOnStartup', false, vscode.ConfigurationTarget.Global);
  await cfg.update('showWelcomeOnStartup', prev, vscode.ConfigurationTarget.Global);
});

suite('test isolation', () => {
  test('the Extension Host runs with a throwaway home folder, not the real one', function () {
    if (!process.env.LOCALPILOT_TEST_HOME) {
      this.skip(); // run without .vscode-test.mjs (a custom config)
    }
    assert.strictEqual(os.homedir(), process.env.LOCALPILOT_TEST_HOME);
    assert.ok(os.homedir().startsWith(path.resolve(os.tmpdir())) || os.homedir().includes('localpilot-test-home-'), os.homedir());
    assert.strictEqual(process.env.LOCALPILOT_KEYCHAIN, 'none');
  });
});
