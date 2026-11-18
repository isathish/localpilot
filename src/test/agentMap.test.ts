import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AgentMapPanel } from '../ui/agentMap';
import { waitFor } from './waitFor';

const mapTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && (t.input as vscode.TabInputWebview).viewType.includes('localpilot.agentMap'));

suite('Agent map panel', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test('opens one panel, and a skill toggle from the map writes skills.disabled', async function () {
    this.timeout(30_000);
    const panel = (await vscode.commands.executeCommand('localpilot.openAgentMap')) as AgentMapPanel;
    assert.ok(panel && typeof panel.handle === 'function', 'the command returns the panel');
    await waitFor(() => mapTabs().length === 1, 10_000, 'the Agent map tab opens');
    await vscode.commands.executeCommand('localpilot.openAgentMap');
    assert.strictEqual(mapTabs().length, 1, 'a second open reveals the same panel');

    const before = await panel.snapshot();
    const skill = before.nodes.find((n) => n.kind === 'skill' && n.status !== 'off' && !n.badges.includes('always on'));
    assert.ok(skill, 'the bundled skills are on the map');
    const name = skill.label;
    const disabled = () => vscode.workspace.getConfiguration('localpilot').get<string[]>('skills.disabled', []);
    try {
      await panel.handle({ type: 'action', id: 'toggleSkill', arg: name, value: false });
      assert.ok(disabled().includes(name), 'skills.disabled lists the skill');
      const after = await panel.snapshot();
      assert.strictEqual(after.nodes.find((n) => n.id === skill.id)?.status, 'off', 'the map shows it off');
      assert.strictEqual(after.counts.skillsOn, before.counts.skillsOn - 1);
      await panel.handle({ type: 'action', id: 'toggleSkill', arg: name, value: true });
      assert.ok(!disabled().includes(name), 'switched back on');
    } finally {
      await vscode.workspace.getConfiguration('localpilot').update('skills.disabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('role, approval and tool actions go through the settings', async function () {
    this.timeout(30_000);
    const panel = (await vscode.commands.executeCommand('localpilot.openAgentMap')) as AgentMapPanel;
    const c = () => vscode.workspace.getConfiguration('localpilot');
    try {
      await panel.handle({ type: 'action', id: 'setRole', arg: 'fast', value: 'session' });
      assert.strictEqual(c().get('routing.fast'), 'session');
      await panel.handle({ type: 'action', id: 'setRole', arg: 'fast', value: '' });
      assert.strictEqual(c().inspect('routing.fast')?.globalValue, undefined, 'empty = back to automatic');
      await panel.handle({ type: 'action', id: 'setApproval', arg: 'delete', value: 'never' });
      assert.strictEqual(c().get('approvals.delete'), 'never');
      await assert.rejects(panel.handle({ type: 'action', id: 'setApproval', arg: 'write', value: 'safe' }), /Invalid approval/, 'safe exists only for the terminal');
      await panel.handle({ type: 'action', id: 'toggleTool', arg: 'web_fetch', value: false });
      assert.ok(c().get<string[]>('disabledTools', []).includes('web_fetch'));
      const m = await panel.snapshot();
      assert.ok(m.nodes.find((n) => n.id === 'tools:network')?.items?.some((t) => t.name === 'web_fetch' && !t.on));
      await panel.handle({ type: 'action', id: 'toggleTool', arg: 'web_fetch', value: true });
      assert.ok(!c().get<string[]>('disabledTools', []).includes('web_fetch'));
      await assert.rejects(panel.handle({ type: 'action', id: 'openFile', arg: '/etc/passwd' }), /Only skill files/);
    } finally {
      for (const key of ['routing.fast', 'approvals.delete', 'disabledTools']) {
        await c().update(key, undefined, vscode.ConfigurationTarget.Global);
      }
    }
  });
});
