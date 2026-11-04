import * as assert from 'assert';
import * as vscode from 'vscode';
import { deepLinkParams } from '../ui/cli';

suite('LocalPilot activation', () => {
  test('extension activates and registers its commands', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.ok(ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'localpilot.openChat',
      'localpilot.newSession',
      'localpilot.selectModel',
      'localpilot.refreshModels',
      'localpilot.setProviderApiKey',
      'localpilot.explainSelection',
      'localpilot.fixDiagnostics',
      'localpilot.commitMessage',
      'localpilot.reloadSkills',
      'localpilot.editMcpConfig',
      'localpilot.authenticateMcpServer',
      'localpilot.telemetry.testOtlp',
      'localpilot.importSessions',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('chat participant contribution is present', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const contributes = ext.packageJSON.contributes;
    assert.strictEqual(contributes.chatParticipants[0].id, 'localpilot.agent');
    assert.strictEqual(contributes.languageModelChatProviders[0].vendor, 'localpilot');
    assert.strictEqual(contributes.views.localpilot[0].id, 'localpilot.chatView');
  });

  test('chat view can be focused without throwing', async function () {
    this.timeout(15_000);
    await vscode.commands.executeCommand('localpilot.openChat');
    await vscode.commands.executeCommand('localpilot.newSession');
  });

  test('model selection with no servers shows a graceful error path', async function () {
    this.timeout(15_000);
    // Should not throw even when no local server is reachable.
    await vscode.commands.executeCommand('localpilot.refreshModels');
  });
});

suite('Deep links', () => {
  test('a CLI (v=2) prompt keeps its "&", "|", "=", "%" and "+"', () => {
    const prompt = 'fix login & add tests | b=1 %2 +x';
    // VS Code hands the handler a query that is decoded once.
    const query = decodeURIComponent(`mode=ask&prompt=${encodeURIComponent(encodeURIComponent(prompt))}&v=2`);
    const params = deepLinkParams(query);
    assert.strictEqual(params.get('prompt'), prompt);
    assert.strictEqual(params.get('mode'), 'ask');
  });

  test('a plain prompt keeps "+" and "%"', () => {
    assert.strictEqual(deepLinkParams('prompt=a+b%').get('prompt'), 'a+b%');
  });
});
