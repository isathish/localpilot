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

  test('intent wins over incidental nouns: a build request naming a plan, a strategy or an error is a change', () => {
    const cases: [string, string, string | undefined][] = [
      // "plan", "strategy", "approach" as the object of a build verb
      ['Implement the plan', 'agent', undefined],
      ['Implement the plan we discussed yesterday', 'agent', undefined],
      ['Add a retry strategy', 'agent', undefined],
      ['Add a retry strategy to the HTTP client', 'agent', undefined],
      ['Implement the migration strategy from docs/plan.md', 'agent', undefined],
      ['Use the strategy pattern for the exporters', 'agent', undefined],
      ['Can you implement the approach from the RFC?', 'agent', undefined],
      ['Update the pricing plan page with the new tiers', 'agent', undefined],
      // "error" / "bug" as part of what to build
      ['Add error handling', 'agent', undefined],
      ['Add error handling to the upload endpoint', 'agent', undefined],
      ['Write tests for the error parser', 'agent', 'test'],
      ['Rename the ErrorBanner component to AlertBanner', 'agent', undefined],
      ['Add debug logging to the sync worker', 'agent', undefined],
      ['Add a bug report template to .github', 'agent', undefined],
      ['Show a toast if saving fails', 'agent', undefined],
      ['Retry the request when it fails', 'agent', undefined],
      ['Refactor the error module', 'agent', 'refactor'],
      // other incidental nouns
      ['Update the project README with the new commands', 'agent', undefined],
      ['Add a code review step to the CI workflow', 'agent', undefined],
      ['Please add a dark mode toggle', 'agent', undefined],
    ];
    for (const [text, mode, specialist] of cases) {
      const r = pick(text);
      assert.deepStrictEqual([r.mode, r.specialist], [mode, specialist], `${text} → ${JSON.stringify(r)}`);
    }
  });

  test('Plan needs planning intent; Debug needs a reported failure', () => {
    const plan = ['Make a plan for the database migration', 'Plan how we should add OAuth login', 'Plan out the v2 rollout', "What's the best approach for caching API responses?", 'How should we structure the plugin loader?', 'Break this down into steps before you start', 'Create a roadmap for v2', 'Help me plan the Postgres upgrade', 'Which approach is better here, polling or webhooks?'];
    for (const text of plan) {
      assert.strictEqual(pick(text).mode, 'plan', text);
    }
    const debug = ['Fix the failing test in auth.spec.ts', 'Fix the bug in checkout', 'There is a bug where the cart empties on reload', 'I get an error when I run npm run build', 'Error: ENOENT: no such file or directory', 'Error: something weird happened in the worker', 'The login page is broken after the last deploy', 'Login fails when the password contains a space', 'The app crashes on startup with TypeError: x is undefined', 'Debug the flaky websocket reconnect', 'Uploads stopped working since yesterday', 'npm test exits with exit code 1'];
    for (const text of debug) {
      assert.strictEqual(pick(text).mode, 'debug', text);
    }
    const neither: [string, string][] = [
      ['Fix the typo in the README', 'agent'],
      ['Why does the error parser drop line numbers?', 'ask'],
      ['What does the debug flag do?', 'ask'],
      ['What is the error rate on the dashboard?', 'ask'],
      ['What happens if the request fails?', 'ask'],
      ['What is our approach to logging?', 'ask'],
    ];
    for (const [text, mode] of neither) {
      assert.strictEqual(pick(text).mode, mode, `${text} → ${JSON.stringify(pick(text))}`);
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
