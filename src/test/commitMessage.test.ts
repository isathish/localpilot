import * as assert from 'assert';
import * as vscode from 'vscode';
import { cleanCommitMessage, commitMessagePrompt, commitRules, GitRepository, truncateDiff, writeCommitMessage } from '../ui/commitMessage';
import { ProviderRegistry } from '../providers/registry';
import { ChatRequestOptions, LLMProvider, StreamEvent } from '../types';

/** A registry whose only model replies with `chunks` and records the request. */
function stubProviders(chunks: string[], seen: ChatRequestOptions[] = []): ProviderRegistry {
  const provider = {
    id: 'stub',
    async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
      seen.push(opts);
      for (const text of chunks) {
        yield { type: 'text', text };
      }
      yield { type: 'done', finishReason: 'stop' };
    },
  } as unknown as LLMProvider;
  return { resolve: async () => ({ provider, model: { id: 'stub/m', modelId: 'm', providerId: 'stub' } }) } as unknown as ProviderRegistry;
}

function fakeRepo(staged: string, unstaged: string, input = ''): GitRepository & { values: string[] } {
  const values: string[] = [];
  let value = input;
  return {
    values,
    rootUri: vscode.Uri.file('/tmp/lp-fake-repo'),
    inputBox: {
      get value() {
        return value;
      },
      set value(v: string) {
        value = v;
        values.push(v);
      },
    },
    state: { indexChanges: [], workingTreeChanges: [{ uri: vscode.Uri.file('/tmp/lp-fake-repo/new.txt'), status: 7 }] },
    diff: async (cached?: boolean) => (cached ? staged : unstaged),
  };
}

suite('One-shot commit message', () => {
  test('truncateDiff cuts at 5,000 characters with a note', () => {
    assert.strictEqual(truncateDiff('short'), 'short');
    const long = Array.from({ length: 400 }, (_, i) => `+line ${i} ${'x'.repeat(20)}`).join('\n');
    const cut = truncateDiff(long);
    assert.ok(cut.length < 5100, String(cut.length));
    assert.match(cut, /\[diff truncated: showing [\d,]+ of [\d,]+ characters\]$/);
  });

  test('commitRules keeps commit sections and lines only', () => {
    const rules = '<!-- AGENTS.md -->\n# Style\nUse tabs.\n- Commit messages use the imperative mood.\n\n## Commits\nPrefix with the ticket id.\nKeep it short.\n\n## Tests\nRun npm test.';
    const out = commitRules(rules);
    assert.match(out, /imperative mood/);
    assert.match(out, /## Commits\nPrefix with the ticket id\.\nKeep it short\./);
    assert.ok(!/tabs|npm test|AGENTS/.test(out), out);
    assert.strictEqual(commitRules('# Style\nUse tabs.'), '');
  });

  test('the prompt carries the diff, the input-box notes, untracked files and the rules', () => {
    const [sys, user] = commitMessagePrompt('+a', { notes: 'fixes login', rules: 'Prefix with JIRA-1', untracked: ['new.txt'], staged: true });
    assert.match(sys.content, /Prefix with JIRA-1/);
    assert.match(user.content, /fixes login[\s\S]*new\.txt[\s\S]*Staged changes:\n```diff\n\+a\n```/);
    assert.match(commitMessagePrompt('+a')[0].content, /Conventional Commits/);
  });

  test('cleanCommitMessage strips reasoning, fences and labels, also mid-stream', () => {
    assert.strictEqual(cleanCommitMessage('<think>hmm</think>```\nfeat: add x\n\n- body\n```'), 'feat: add x\n\n- body');
    assert.strictEqual(cleanCommitMessage('Commit message: fix: y'), 'fix: y');
    assert.strictEqual(cleanCommitMessage('<think>still thinking'), '');
  });

  test('writes the staged diff message into the input box in one call with thinking off', async () => {
    const seen: ChatRequestOptions[] = [];
    const repo = fakeRepo('diff --git a/x b/x\n+x', 'ignored', 'my note');
    const ok = await writeCommitMessage(stubProviders(['```\nfeat: add', ' x\n```'], seen), repo, new AbortController().signal);
    assert.ok(ok);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].think, false);
    assert.ok(!seen[0].tools?.length, 'no tools');
    const user = seen[0].messages[1].content;
    assert.match(user, /my note/);
    assert.match(user, /Staged changes/);
    assert.ok(!/new\.txt/.test(user), 'untracked files are listed only without a staged diff');
    assert.strictEqual(repo.inputBox.value, 'feat: add x');
    assert.ok(repo.values.length >= 2, 'streamed in steps');
  });

  test('falls back to all changes, and reports nothing to describe', async () => {
    const seen: ChatRequestOptions[] = [];
    const repo = fakeRepo('', '+y');
    await writeCommitMessage(stubProviders(['fix: y'], seen), repo, new AbortController().signal);
    assert.match(seen[0].messages[1].content, /nothing is staged[\s\S]*\+y/);
    assert.match(seen[0].messages[1].content, /new\.txt/);
    const empty = fakeRepo('', '');
    empty.state.workingTreeChanges = [];
    assert.strictEqual(await writeCommitMessage(stubProviders(['x']), empty, new AbortController().signal), false);
  });

  test('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.commitMessage', 'localpilot.commitMessage.stop', 'localpilot.commitWithAgent']) {
      assert.ok(all.includes(id), id);
    }
  });
});
