import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { applyHookResult, execHook, hookMatches, HookOutcome } from '../agent/hooks';
import { canonicalToolName, claudeToolInput, defaultModeDecision, evaluatePermission, fromClaudeToolInput, globToRegExp, matchCommandRule, matchPathRule, parseRule, splitCommandChain } from '../agent/permissions';
import { emptySettings, loadProjectSettings, mergeSettings, normalizeSettings, parseJsonc } from '../agent/settings';
import { discoverCommands, expandCommand, indexCommands, parseCommandFile, splitArgs, splitRules } from '../agent/commands';
import { buildInstructions, collectInstructionFiles, resolveImports } from '../context/instructions';
import { discoverPlugins, pluginSource } from '../agent/plugins';
import { parseFrontMatter } from '../agent/frontMatter';

const tmp = async (name: string) => fs.mkdtemp(path.join(os.tmpdir(), `localpilot-${name}-`));
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const posix = process.platform !== 'win32';

suite('Claude Code compatibility: settings.json', () => {
  test('parses JSON with comments and trailing commas', () => {
    const v = parseJsonc('{\n  // comment\n  "a": 1, /* block */ "b": [1, 2,],\n}') as { a: number; b: number[] };
    assert.strictEqual(v.a, 1);
    assert.deepStrictEqual(v.b, [1, 2]);
    // URLs inside strings are not comments.
    assert.strictEqual((parseJsonc('{"u": "http://x.y/z"}') as { u: string }).u, 'http://x.y/z');
  });

  test('normalises permissions, hooks, env and enabledPlugins', () => {
    const s = normalizeSettings(
      {
        permissions: { allow: ['Bash(npm run *)', 'Read'], deny: 'Read(.env)', defaultMode: 'acceptEdits', junk: 1 },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }, { command: 'echo two' }, { type: 'prompt', command: 'x' }] }], Bogus: [] },
        env: { A: '1', B: 2, C: { nested: true } },
        enabledPlugins: { 'foo@bar': false, baz: true, nope: 'yes' },
        model: 'ollama/x',
      },
      '/tmp/s.json'
    );
    assert.deepStrictEqual(s.permissions.allow, ['Bash(npm run *)', 'Read']);
    assert.deepStrictEqual(s.permissions.deny, ['Read(.env)']);
    assert.strictEqual(s.permissions.defaultMode, 'acceptEdits');
    assert.strictEqual(s.hooks.PreToolUse?.length, 1);
    assert.strictEqual(s.hooks.PreToolUse?.[0].hooks.length, 2);
    assert.strictEqual(s.hooks.PreToolUse?.[0].hooks[0].timeout, 5);
    assert.deepStrictEqual(s.env, { A: '1', B: '2' });
    assert.deepStrictEqual(s.enabledPlugins, { 'foo@bar': false, baz: true });
    assert.strictEqual(s.model, 'ollama/x');
  });

  test('merges layers: lists concatenate (deduped), scalars take the highest layer', () => {
    const a = normalizeSettings({ permissions: { allow: ['Bash(ls)'], defaultMode: 'default' }, hooks: { Stop: [{ hooks: [{ command: 'a' }] }] }, env: { X: '1' } }, 'a');
    const b = normalizeSettings({ permissions: { allow: ['Bash(ls)', 'Read'], deny: ['Bash(rm:*)'], defaultMode: 'acceptEdits' }, hooks: { Stop: [{ hooks: [{ command: 'b' }] }] }, env: { X: '2', Y: '3' } }, 'b');
    const m = mergeSettings([a, b]);
    assert.deepStrictEqual(m.permissions.allow, ['Bash(ls)', 'Read']);
    assert.deepStrictEqual(m.permissions.deny, ['Bash(rm:*)']);
    assert.strictEqual(m.permissions.defaultMode, 'acceptEdits');
    assert.strictEqual(m.hooks.Stop?.length, 2);
    assert.deepStrictEqual(m.env, { X: '2', Y: '3' });
    assert.deepStrictEqual(m.sources, ['a', 'b']);
  });

  test('loads .claude and .localpilot files with .local.json on top and user files below', async () => {
    const home = await tmp('home');
    const root = await tmp('root');
    await write(path.join(home, '.claude', 'settings.json'), '{"permissions":{"allow":["WebFetch"]},"env":{"L":"user"}}');
    await write(path.join(root, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(npm test)"]},"env":{"L":"claude"}}');
    await write(path.join(root, '.localpilot', 'settings.json'), '{"permissions":{"deny":["Read(.env)"]},"env":{"L":"localpilot"}}');
    await write(path.join(root, '.localpilot', 'settings.local.json'), '{"permissions":{"ask":["Bash(git push:*)"]},"env":{"L":"local"}}');
    await write(path.join(root, '.claude', 'settings.local.json'), 'not json {{{');
    const warnings: string[] = [];
    const s = await loadProjectSettings([root], { home, log: { warn: (m) => warnings.push(m) } });
    assert.deepStrictEqual(s.permissions.allow, ['WebFetch', 'Bash(npm test)']);
    assert.deepStrictEqual(s.permissions.deny, ['Read(.env)']);
    assert.deepStrictEqual(s.permissions.ask, ['Bash(git push:*)']);
    assert.strictEqual(s.env.L, 'local');
    assert.strictEqual(s.sources.length, 4);
    assert.ok(warnings.some((w) => w.includes('settings.local.json')), 'the broken file is reported, not fatal');
  });
});

suite('Claude Code compatibility: permission rules', () => {
  const root = posix ? '/work/proj' : 'C:\\work\\proj';
  const home = posix ? '/Users/me' : 'C:\\Users\\me';

  test('parses Tool and Tool(specifier)', () => {
    assert.deepStrictEqual(parseRule('Bash'), { raw: 'Bash', tool: 'Bash', specifier: undefined });
    assert.deepStrictEqual(parseRule('Bash(npm run test:*)'), { raw: 'Bash(npm run test:*)', tool: 'Bash', specifier: 'npm run test:*' });
    assert.deepStrictEqual(parseRule('mcp__github__get_issue'), { raw: 'mcp__github__get_issue', tool: 'mcp__github__get_issue', specifier: undefined });
    assert.strictEqual(parseRule('Edit(*)')?.specifier, undefined);
    assert.strictEqual(parseRule(''), undefined);
  });

  test('command specifiers: exact, prefix (:*), wildcards, chained commands', () => {
    assert.ok(matchCommandRule('npm run build', 'npm run build'));
    assert.ok(!matchCommandRule('npm run build', 'npm run build --watch'));
    assert.ok(matchCommandRule('npm run test:*', 'npm run test:unit -- --watch'));
    assert.ok(matchCommandRule('git *', 'git status'));
    assert.ok(!matchCommandRule('git *', 'gitk'));
    assert.deepStrictEqual(splitCommandChain('npm ci && npm test; echo "a;b" | tee x || true'), ['npm ci', 'npm test', 'echo "a;b"', 'tee x', 'true']);
    const perm = { ...emptySettings().permissions, allow: ['Bash(npm:*)'], deny: ['Bash(rm:*)'] };
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm ci && npm test' }).decision, 'allow');
    // Every segment must be allowed for the chain to be allowed…
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm ci && curl x' }).decision, 'none');
    // …and any denied segment denies it.
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm ci && rm -rf dist' }).decision, 'deny');
  });

  test('path specifiers: relative, root-anchored, home, absolute, directory prefix, any-depth basenames', () => {
    assert.ok(globToRegExp('src/**/*.ts').test('src/a/b.ts'));
    assert.ok(globToRegExp('src/**/*.ts').test('src/b.ts'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
    assert.ok(globToRegExp('*.{ts,js}').test('x.js'));
    assert.ok(matchPathRule('src/**', path.join(root, 'src', 'a', 'b.ts'), root, home));
    assert.ok(matchPathRule('/docs/**', 'docs/readme.md', root, home));
    assert.ok(matchPathRule('docs', 'docs/readme.md', root, home), 'a directory name covers its contents');
    assert.ok(matchPathRule('.env', 'config/.env', root, home), 'a bare file name matches at any depth');
    assert.ok(matchPathRule('~/.zshrc', path.join(home, '.zshrc'), root, home));
    assert.ok(matchPathRule(`//${posix ? 'etc/**' : 'C:/etc/**'}`, posix ? '/etc/hosts' : 'C:\\etc\\hosts', root, home));
    assert.ok(!matchPathRule('src/**', path.join(root, 'test', 'a.ts'), root, home));
  });

  test('tool aliases: our tools answer to Claude Code names, Read covers search tools, Edit covers writes', () => {
    assert.strictEqual(canonicalToolName('run_command'), 'Bash');
    assert.strictEqual(canonicalToolName('edit_file'), 'Edit');
    assert.strictEqual(canonicalToolName('mcp_github_get_issue'), 'mcp__github__get_issue');
    const perm = { ...emptySettings().permissions, deny: ['Read(.env)', 'Edit(dist/**)'], allow: ['Read', 'mcp__github'] };
    assert.strictEqual(evaluatePermission(perm, 'read_file', { path: '.env' }, { root }).decision, 'deny');
    assert.strictEqual(evaluatePermission(perm, 'read_file', { path: 'src/x.ts' }, { root }).decision, 'allow');
    assert.strictEqual(evaluatePermission(perm, 'grep_search', { query: 'x', include_pattern: 'src/**' }, { root }).decision, 'allow');
    assert.strictEqual(evaluatePermission(perm, 'write_file', { path: 'dist/out.js', content: '' }, { root }).decision, 'deny');
    assert.strictEqual(evaluatePermission(perm, 'edit_file', { path: 'src/a.ts' }, { root }).decision, 'none');
    assert.strictEqual(evaluatePermission(perm, 'mcp_github_get_issue', {}, { root }).decision, 'allow');
    assert.strictEqual(evaluatePermission(perm, 'mcp_jira_get_issue', {}, { root }).decision, 'none');
    // Our own names work in rules too.
    assert.strictEqual(evaluatePermission({ ...emptySettings().permissions, allow: ['run_command(git status)'] }, 'run_command', { command: 'git status' }).decision, 'allow');
  });

  test('deny beats ask beats allow; per-run extra allow rules; defaultMode fallbacks', () => {
    const perm = { ...emptySettings().permissions, allow: ['Bash'], ask: ['Bash(git push:*)'], deny: ['Bash(git push --force:*)'] };
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'git status' }).decision, 'allow');
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'git push origin main' }).decision, 'ask');
    assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'git push --force origin main' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(emptySettings().permissions, 'run_command', { command: 'git add .' }, {}, ['Bash(git add:*)']).decision, 'allow');
    assert.strictEqual(defaultModeDecision('bypassPermissions', 'run_command'), 'allow');
    assert.strictEqual(defaultModeDecision('acceptEdits', 'edit_file'), 'allow');
    assert.strictEqual(defaultModeDecision('acceptEdits', 'run_command'), 'none');
    assert.strictEqual(defaultModeDecision('dontAsk', 'run_command'), 'deny');
    assert.strictEqual(defaultModeDecision(undefined, 'run_command'), 'none');
  });

  test('WebFetch domain rules', () => {
    const perm = { ...emptySettings().permissions, allow: ['WebFetch(domain:github.com)'], deny: ['WebFetch(domain:evil.example)'] };
    assert.strictEqual(evaluatePermission(perm, 'web_fetch', { url: 'https://api.github.com/repos' }).decision, 'allow');
    assert.strictEqual(evaluatePermission(perm, 'web_fetch', { url: 'https://evil.example/x' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(perm, 'web_fetch', { url: 'https://example.org' }).decision, 'none');
  });

  test('tool_input is shaped like Claude Code (and mapped back)', () => {
    const input = claudeToolInput('edit_file', { path: 'a.ts', old_text: 'x', new_text: 'y' });
    assert.strictEqual(input.file_path, 'a.ts');
    assert.strictEqual(input.old_string, 'x');
    assert.strictEqual(input.new_string, 'y');
    const back = fromClaudeToolInput('edit_file', { new_string: 'z' }, { path: 'a.ts', old_text: 'x', new_text: 'y' });
    assert.strictEqual(back.new_text, 'z');
    assert.strictEqual(back.path, 'a.ts');
  });
});

suite('Claude Code compatibility: hooks', () => {
  test('matchers: empty / * / exact / regex, and our native names', () => {
    assert.ok(hookMatches(undefined, ['Bash']));
    assert.ok(hookMatches('*', ['Bash']));
    assert.ok(hookMatches('Bash', ['Bash', 'run_command']));
    assert.ok(hookMatches('run_command', ['Bash', 'run_command']));
    assert.ok(hookMatches('Edit|Write', ['Write', 'write_file']));
    assert.ok(hookMatches('mcp__.*', ['mcp__github__x']));
    assert.ok(!hookMatches('Bash', ['Edit']));
  });

  test('result folding: exit 2 blocks with stderr, JSON verdicts, plain stdout context', () => {
    const fresh = (): HookOutcome => ({ block: false, reasons: [], context: [], messages: [], ran: 0 });
    let o = fresh();
    applyHookResult(o, 'PreToolUse', { code: 2, stdout: '', stderr: 'rm is not allowed', timedOut: false }, 'h');
    assert.ok(o.block);
    assert.strictEqual(o.permission, 'deny');
    assert.deepStrictEqual(o.reasons, ['rm is not allowed']);
    o = fresh();
    applyHookResult(o, 'PreToolUse', { code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'ls -la' } } }), stderr: '', timedOut: false }, 'h');
    assert.strictEqual(o.permission, 'allow');
    assert.deepStrictEqual(o.updatedInput, { command: 'ls -la' });
    assert.ok(!o.block);
    o = fresh();
    applyHookResult(o, 'Stop', { code: 0, stdout: JSON.stringify({ decision: 'block', reason: 'tests not run' }), stderr: '', timedOut: false }, 'h');
    assert.ok(o.block);
    assert.deepStrictEqual(o.reasons, ['tests not run']);
    o = fresh();
    applyHookResult(o, 'UserPromptSubmit', { code: 0, stdout: 'Remember: branch is main', stderr: '', timedOut: false }, 'h');
    assert.deepStrictEqual(o.context, ['Remember: branch is main']);
    o = fresh();
    applyHookResult(o, 'PostToolUse', { code: 0, stdout: JSON.stringify({ continue: false, stopReason: 'budget', systemMessage: 'note' }), stderr: '', timedOut: false }, 'h');
    assert.strictEqual(o.stop, 'budget');
    assert.deepStrictEqual(o.messages, ['note']);
    o = fresh();
    applyHookResult(o, 'PostToolUse', { code: 1, stdout: '', stderr: 'oops', timedOut: false }, 'h');
    assert.ok(!o.block, 'other exit codes are non-blocking');
    assert.ok(o.messages[0].includes('oops'));
  });

  (posix ? test : test.skip)('runs a real command with the event JSON on stdin and the project dir in the environment', async function () {
    this.timeout(10_000);
    const dir = await tmp('hook');
    const r = await execHook({ type: 'command', command: `cat > "$CLAUDE_PROJECT_DIR/in.json"; echo "cwd=$PWD"; echo "plugin=$CLAUDE_PLUGIN_ROOT"`, pluginRoot: '/plug' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { cwd: dir, env: { CLAUDE_PROJECT_DIR: dir } });
    assert.strictEqual(r.code, 0, r.stderr);
    const input = JSON.parse(await fs.readFile(path.join(dir, 'in.json'), 'utf8')) as { tool_name: string };
    assert.strictEqual(input.tool_name, 'Bash');
    assert.ok(r.stdout.includes(`cwd=${await fs.realpath(dir)}`) || r.stdout.includes(`cwd=${dir}`));
    assert.ok(r.stdout.includes('plugin=/plug'));
    const blocked = await execHook({ type: 'command', command: 'echo nope >&2; exit 2' }, {}, { cwd: dir });
    assert.strictEqual(blocked.code, 2);
    assert.strictEqual(blocked.stderr.trim(), 'nope');
    const slow = await execHook({ type: 'command', command: 'sleep 5', timeout: 1 }, {}, { cwd: dir });
    assert.ok(slow.timedOut);
  });
});

suite('Claude Code compatibility: custom slash commands', () => {
  test('front-matter: block lists, allowed-tools with parentheses, argument-hint, model', () => {
    const fm = parseFrontMatter('---\nname: x\nallowed-tools:\n  - Bash(git add:*)\n  - "Bash(git status:*)"\n---\nbody');
    assert.deepStrictEqual(fm.meta['allowed-tools'], ['Bash(git add:*)', 'Bash(git status:*)']);
    assert.deepStrictEqual(splitRules('Bash(git add:*), Bash(git commit:*),Read'), ['Bash(git add:*)', 'Bash(git commit:*)', 'Read']);
    const c = parseCommandFile('/p/.claude/commands/fix-issue.md', '---\ndescription: Fix a GitHub issue\nargument-hint: [issue-number]\nallowed-tools: Bash(gh issue view:*)\nmodel: ollama/qwen3\n---\nFix issue #$1 following our standards. Context: !`gh issue view $1`\nRead @README.md first.', { source: 'project' });
    assert.strictEqual(c.invoke, '/fix-issue');
    assert.strictEqual(c.description, 'Fix a GitHub issue');
    assert.strictEqual(c.argumentHint, '[issue-number]');
    assert.deepStrictEqual(c.allowedTools, ['Bash(gh issue view:*)']);
    assert.strictEqual(c.model, 'ollama/qwen3');
    assert.deepStrictEqual(splitArgs('123 "two words" x'), ['123', 'two words', 'x']);
  });

  test('expansion: $ARGUMENTS and $n, permitted !`cmd` runs, unpermitted is skipped, @file inlines', async () => {
    const root = await tmp('cmd');
    await write(path.join(root, 'README.md'), '# Hello');
    const ran: string[] = [];
    const runShell = async (command: string) => {
      ran.push(command);
      return `out of ${command}`;
    };
    const c = parseCommandFile('/x/review.md', '---\nallowed-tools: Bash(git diff:*)\n---\nReview $ARGUMENTS (first: $1).\nDiff: !`git diff HEAD~$2`\nStatus: !`git status`\nDocs: @README.md and @missing.md', { source: 'project' });
    const { prompt, notes } = await expandCommand(c, 'src 3', { root, runShell });
    assert.ok(prompt.startsWith('Review src 3 (first: src).'));
    assert.deepStrictEqual(ran, ['git diff HEAD~3'], 'only the allowed command runs');
    assert.ok(prompt.includes('out of git diff HEAD~3'));
    assert.ok(prompt.includes('[skipped `git status`'));
    assert.strictEqual(notes.length, 1);
    assert.ok(prompt.includes('<file path="README.md">\n# Hello\n</file>'));
    assert.ok(prompt.includes('@missing.md'), 'unknown paths are left as typed');
  });

  test('discovery: project beats user, subfolders namespace, plugins are /plugin:name', async () => {
    const home = await tmp('cmdhome');
    const root = await tmp('cmdroot');
    await write(path.join(home, '.claude', 'commands', 'review.md'), 'user review');
    await write(path.join(home, '.localpilot', 'commands', 'only-user.md'), 'user only');
    await write(path.join(root, '.claude', 'commands', 'review.md'), 'project review');
    await write(path.join(root, '.localpilot', 'commands', 'frontend', 'component.md'), '---\ndescription: comp\n---\nmake a component');
    await write(path.join(root, '.claude', 'plugins', 'tools', '.claude-plugin', 'plugin.json'), '{"name":"tools","description":"t"}');
    await write(path.join(root, '.claude', 'plugins', 'tools', 'commands', 'deploy.md'), 'deploy it');
    const plugins = await discoverPlugins([root], { home });
    const list = await discoverCommands([root], { home, plugins: pluginSource(plugins) });
    const by = Object.fromEntries(indexCommands(list));
    assert.strictEqual(by['/review'].body, 'project review');
    assert.strictEqual(by['/only-user'].source, 'user');
    assert.strictEqual(by['/frontend:component'].description, 'comp');
    assert.strictEqual(by['/component'], by['/frontend:component']);
    assert.strictEqual(by['/tools:deploy'].plugin, 'tools');
    assert.strictEqual(by['/deploy'].plugin, 'tools');
  });
});

suite('Claude Code compatibility: CLAUDE.md hierarchy and imports', () => {
  test('collects user, ancestor, project and local files in order; resolves @imports outside code', async () => {
    const home = await tmp('memhome');
    const parent = await tmp('memparent');
    const root = path.join(parent, 'app');
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'USER RULES');
    await write(path.join(parent, 'CLAUDE.md'), 'MONOREPO RULES');
    await write(path.join(root, 'CLAUDE.md'), 'PROJECT RULES\nSee @docs/style.md and @~/.claude/extra.md\n`@not/an/import` and\n```\n@also/not.md\n```\nmail me@example.com');
    await write(path.join(root, 'docs', 'style.md'), 'STYLE: 2 spaces\n@../CLAUDE.md');
    await write(path.join(home, '.claude', 'extra.md'), 'EXTRA');
    await write(path.join(root, '.claude', 'CLAUDE.md'), 'DOT CLAUDE RULES');
    await write(path.join(root, 'CLAUDE.local.md'), 'LOCAL RULES');
    await write(path.join(root, '.claude', 'rules', 'a.md'), '---\ndescription: x\n---\nRULE A');
    const files = await collectInstructionFiles([root], home);
    assert.deepStrictEqual(
      files.map((f) => `${f.scope}:${f.label}`),
      ['user:~/.claude/CLAUDE.md', `ancestor:../CLAUDE.md`, 'project:CLAUDE.md', 'project:.claude/CLAUDE.md', 'project:.claude/rules/a.md', 'local:CLAUDE.local.md']
    );
    const { text } = await buildInstructions([root], { home });
    const order = ['USER RULES', 'MONOREPO RULES', 'PROJECT RULES', 'STYLE: 2 spaces', 'EXTRA', 'DOT CLAUDE RULES', 'RULE A', 'LOCAL RULES'].map((s) => text.indexOf(s));
    assert.ok(order.every((i) => i >= 0), `all parts present: ${order}`);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'prompt order is user → ancestor → project → local');
    assert.ok(text.includes('`@not/an/import`'), 'inline code is untouched');
    assert.ok(text.includes('@also/not.md'), 'fenced code is untouched');
    assert.ok(text.includes('me@example.com'));
    assert.ok(!text.includes('description: x'), 'rule-file front-matter is stripped');
    // The style file imports the parent back: the cycle is cut.
    assert.strictEqual(text.split('PROJECT RULES').length, 2);
  });

  test('import depth is bounded', async () => {
    const dir = await tmp('deep');
    for (let i = 0; i < 8; i++) {
      await write(path.join(dir, `f${i}.md`), `L${i} @f${i + 1}.md`);
    }
    const out = await resolveImports('@f0.md', path.join(dir, 'root.md'));
    assert.ok(out.includes('L4'));
    assert.ok(!out.includes('L6'));
  });
});

suite('Claude Code compatibility: plugins', () => {
  test('discovers manifests (nested, marketplace), reads parts, honours enabledPlugins and ${CLAUDE_PLUGIN_ROOT}', async () => {
    const home = await tmp('plughome');
    const root = await tmp('plugroot');
    const p1 = path.join(root, '.localpilot', 'plugins', 'alpha');
    await write(path.join(p1, '.claude-plugin', 'plugin.json'), '{"name":"alpha","description":"A","version":"1.0.0"}');
    await write(path.join(p1, 'commands', 'go.md'), 'go');
    await write(path.join(p1, 'agents', 'helper.md'), '---\nname: helper\ndescription: h\n---\nyou help');
    await write(path.join(p1, 'skills', 'sk', 'SKILL.md'), '---\nname: sk\ndescription: s\n---\nbody');
    await write(path.join(p1, 'hooks', 'hooks.json'), '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/check.sh"}]}]}}');
    await write(path.join(p1, '.mcp.json'), '{"mcpServers":{"srv":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"],"env":{"ROOT":"${CLAUDE_PLUGIN_ROOT}"}}}}');
    // Marketplace checkout under the user folder, two levels deep.
    const market = path.join(home, '.claude', 'plugins', 'repos', 'acme');
    await write(path.join(market, '.claude-plugin', 'marketplace.json'), '{"name":"acme","plugins":[{"name":"beta","source":"./plugins/beta"}]}');
    await write(path.join(market, 'plugins', 'beta', '.claude-plugin', 'plugin.json'), '{"name":"beta"}');
    const list = await discoverPlugins([root], { home, enabledPlugins: { 'beta@acme': false } });
    const alpha = list.find((p) => p.name === 'alpha')!;
    const beta = list.find((p) => p.name === 'beta')!;
    assert.ok(alpha && beta, `found ${list.map((p) => p.name)}`);
    assert.strictEqual(alpha.commandFiles.length, 1);
    assert.strictEqual(alpha.agentDirs.length, 1);
    assert.strictEqual(alpha.skillDirs.length, 1);
    assert.strictEqual(alpha.hooks.PreToolUse?.[0].hooks[0].pluginRoot, p1);
    assert.strictEqual(alpha.mcpServers.srv.args?.[0], path.join(p1, 'server.js'));
    assert.strictEqual(alpha.mcpServers.srv.env?.ROOT, p1);
    assert.strictEqual(alpha.enabled, true);
    assert.strictEqual(beta.enabled, false);
    const src = pluginSource(list);
    assert.deepStrictEqual(Object.keys(src.mcpServers()), ['alpha:srv']);
    assert.strictEqual(src.settingsLayers().length, 1);
    assert.strictEqual(src.commandFiles()[0].plugin.name, 'alpha');
  });
});
