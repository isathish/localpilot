/**
 * Smoke checks for the `vscode-lm` provider (bundled into scripts/smoke.ts): transcript conversion, model mapping,
 * settings sanitising, and that the provider stays out of the CLI, which has no `vscode.lm`.
 */
import { isCloudProvider } from '../src/providers/cloud';
import { sanitizeProviderConfig } from '../src/providers/sanitize';
import { vscodeLmAvailable } from '../src/providers/vscodeLm';
import { isOwnVendor, lmIdsChangeGate, lmModelInfo, toLmTurns, VSCODE_LM_BASE_URL } from '../src/providers/vscodeLmMessages';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function vscodeLm(check: Check): void {
  console.log('\n[VS Code language models]');
  const turns = toLmTurns([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
    { role: 'tool', content: 'body', toolCallId: 'c1' },
  ]);
  check('vscode-lm: turns alternate, system text leads the first user turn', turns.map((t) => t.role).join() === 'user,assistant,user' && turns[0].parts.length === 2, turns);
  check('vscode-lm: tool results are user-turn parts', turns[2].parts[0].kind === 'result', turns[2]);
  const m = lmModelInfo('copilot', { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'copilot', family: 'claude-sonnet-4', maxInputTokens: 0 });
  check('vscode-lm: models are cloud, tool-capable and unpriced', m.remote === true && m.supportsTools && !m.pricing && m.contextWindow > 0, m);
  check('vscode-lm: LocalPilot vendor is excluded', isOwnVendor('localpilot') && !isOwnVendor('copilot'));
  const p = sanitizeProviderConfig({ id: 'copilot', type: 'vscode-lm', baseUrl: 'http://x' });
  check('vscode-lm: sanitize keeps the type and the placeholder URL', p.type === 'vscode-lm' && p.baseUrl === VSCODE_LM_BASE_URL && isCloudProvider(p), p);
  check('vscode-lm: unavailable outside VS Code', !vscodeLmAvailable());
  check('vscode-lm: another type drops the placeholder URL', sanitizeProviderConfig({ id: 'x', type: 'openai', baseUrl: VSCODE_LM_BASE_URL }).baseUrl === '');
  const gate = lmIdsChangeGate(['copilot/a', 'copilot/b']);
  check('vscode-lm: an unchanged model set does not trigger rediscovery', !gate(['copilot/b', 'copilot/a']) && gate(['copilot/a']) && !gate(['copilot/a']));
}
