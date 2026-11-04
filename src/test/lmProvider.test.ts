import * as assert from 'assert';
import * as vscode from 'vscode';
import { convertMessage } from '../ui/lmProvider';

suite('LocalPilot LM API provider messages', () => {
  test('every tool result becomes its own tool message, followed by the remaining user text', () => {
    const out = convertMessage({
      role: vscode.LanguageModelChatMessageRole.User,
      name: undefined,
      content: [
        new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('first')]),
        new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('second')]),
        new vscode.LanguageModelTextPart('now continue'),
      ],
    });
    assert.deepStrictEqual(
      out.map((m) => [m.role, m.toolCallId, m.content]),
      [
        ['tool', 'call-1', 'first'],
        ['tool', 'call-2', 'second'],
        ['user', undefined, 'now continue'],
      ]
    );
  });

  test('the System role is sent as a system message', () => {
    const out = convertMessage({ role: 3 as vscode.LanguageModelChatMessageRole, name: undefined, content: [new vscode.LanguageModelTextPart('be brief')] });
    assert.deepStrictEqual(out.map((m) => [m.role, m.content]), [['system', 'be brief']]);
  });
});
