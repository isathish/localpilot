import * as assert from 'assert';
import { autoLabel, classifyTask } from '../agent/taskRouter';

suite('Auto mode: task classification', () => {
  const pick = (text: string, extra: Partial<Parameters<typeof classifyTask>[0]> = {}) => classifyTask({ text, hasFolder: true, ...extra });

  test('each kind of message picks its mode, specialist and model role', () => {
    const cases: [string, string, string | undefined, string][] = [
      ['What does the useAuth hook return?', 'ask', 'explain', 'agent'],
      ['Is this function pure?', 'ask', undefined, 'fast'],
      ['Explain how the router decides which model to use', 'ask', 'explain', 'agent'],
      ['Give me an overview of this project', 'ask', 'project', 'agent'],
      ['Plan how we should add OAuth login', 'plan', undefined, 'reasoning'],
      ['Design the architecture for a plugin system with trade-offs', 'plan', 'architect', 'reasoning'],
      ['Review my changes before I open the PR', 'ask', 'review', 'reasoning'],
      ['TypeError: cannot read properties of undefined in checkout.ts', 'debug', undefined, 'agent'],
      ['The login page is broken after the last deploy', 'debug', undefined, 'agent'],
      ['Write unit tests for the date parser', 'agent', 'test', 'agent'],
      ['Refactor the payment module into smaller functions', 'agent', 'refactor', 'agent'],
      ['Run npm install and start the dev server', 'agent', 'terminal', 'agent'],
      ['Add a dark mode toggle to the settings page', 'agent', undefined, 'agent'],
    ];
    for (const [text, mode, specialist, role] of cases) {
      const r = pick(text);
      assert.deepStrictEqual([r.mode, r.specialist, r.role], [mode, specialist, role], `${text} → ${JSON.stringify(r)}`);
      assert.ok(r.reason, 'every pick says why');
    }
  });

  test('several independent tasks go to Multitask; a question about a fix stays a question', () => {
    assert.strictEqual(pick('1. Add a login form\n2. Write tests for the API client\n3. Update the README examples').mode, 'multitask');
    assert.strictEqual(pick('Update the docs and the changelog in parallel').mode, 'multitask');
    const q = pick('How would I add caching here?');
    assert.deepStrictEqual([q.mode, q.kind], ['ask', 'question']);
  });

  test('errors in the workspace make "fix this" a debugging task; no folder means read-only', () => {
    assert.strictEqual(pick('can you look at these', { diagnostics: 3 }).mode, 'debug');
    const r = pick('Add a dark mode toggle', { hasFolder: false });
    assert.strictEqual(r.mode, 'ask');
    assert.match(r.reason, /no folder open/);
    assert.strictEqual(pick('Review the auth module', { hasFolder: false }).specialist, 'review', 'read-only specialists still apply without a folder');
  });

  test('a short question with an attachment or image is not routed to the small model', () => {
    assert.strictEqual(pick('What is in this file?').role, 'fast');
    assert.strictEqual(pick('What is in this file?', { attachments: 1 }).role, 'agent');
    assert.strictEqual(pick('What is in this screenshot?', { images: 1 }).role, 'agent');
  });

  test('labels for the chat', () => {
    assert.strictEqual(autoLabel({ mode: 'debug' }), 'Debug');
    assert.strictEqual(autoLabel({ mode: 'ask', specialist: 'review' }), 'Review');
  });
});
