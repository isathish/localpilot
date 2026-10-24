import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { clampSkillBody, createSkillPrompt, namesTool, recommendSkills, skillHint, skillPreloadNote, slugFor, tokenize, topicKey, triggers } from '../agent/skillRecommender';
import { normalizeSkillName, SkillManager } from '../agent/skills';
import * as vscode from 'vscode';
import { describeSource, discoverSkills, findSkillDirs, installSkills, parseSkillSource, skillsDestination } from '../agent/skillInstaller';
import { AUTO_INSTALL_MIN_SCORE, CatalogEntry, SkillCatalog, sourceFor } from '../agent/skillCatalog';
import { routeSubagent } from '../agent/builtinAgents';
import { builtinAgents } from '../agent/builtinAgents';
import { pickForRole, scoreForRole } from '../providers/registry';
import { ModelInfo } from '../types';

const SKILLS = [
  { name: 'deploy', description: 'Dockerfile, CI, env & secrets, health checks and the release checklist. Use for "deploy", "ship to production", "docker".' },
  { name: 'test', description: 'Detect the test framework, write focused tests with edge cases, run them and fix real failures. Use for "write tests", "add coverage".' },
  { name: 'ui-design', description: 'Visual hierarchy, spacing, typography, colour tokens, states, responsive layout and accessibility for web UI.' },
  { name: 'requirements', description: 'Turn a vague idea into a short spec with goals, user stories and acceptance criteria.' },
];

suite('Skill recommendation', () => {
  test('tokenize drops stop words and stems inflections', () => {
    const t = tokenize('Please write the tests for the parsers and deployments');
    assert.ok(!t.includes('the') && !t.includes('please'));
    assert.ok(t.includes('parser'), t.join(','));
    assert.ok(t.includes('deploy'), t.join(','));
    assert.deepStrictEqual(tokenize('testing tests tested'), ['test', 'test', 'test']);
  });

  test('matches on name, quoted trigger phrases and description terms', () => {
    assert.strictEqual(recommendSkills('deploy this to production with docker', SKILLS)[0]?.name, 'deploy');
    assert.strictEqual(recommendSkills('write tests for the parser module', SKILLS)[0]?.name, 'test');
    assert.strictEqual(recommendSkills('the spacing and typography on the settings page look off, improve the layout', SKILLS)[0]?.name, 'ui-design');
    assert.strictEqual(recommendSkills('turn this idea into a spec with acceptance criteria', SKILLS)[0]?.name, 'requirements');
  });

  test('stays quiet for unrelated requests', () => {
    assert.deepStrictEqual(recommendSkills('rename getUser to fetchUser in src/api.ts', SKILLS), []);
    assert.deepStrictEqual(recommendSkills('hello', SKILLS), []);
  });

  test('apostrophes and empty trigger phrases never match everything (regression)', () => {
    const debugLike = { name: 'debug', description: `Systematic bug fixing. USE WHEN the user reports an error, "doesn't work", "broken", "fails", "why does", or flaky behaviour.` };
    const ciLike = { name: 'deploy', description: 'Make a project deployable. Use for "CI/CD", "make it do X", " ".' };
    assert.deepStrictEqual(triggers(debugLike.description), ['doesn\'t work', 'broken', 'fails', 'why does']);
    assert.deepStrictEqual(triggers(ciLike.description), ['ci/cd', 'make it do x'], 'blank phrases are dropped, the rest only match verbatim');
    assert.deepStrictEqual(triggers(`Use for 'review', 'look over' or "audit".`), ['review', 'look over', 'audit']);
    for (const req of ['hello', 'thanks', 'add a logout button', 'rename the variable x to count', 'make it faster']) {
      assert.deepStrictEqual(recommendSkills(req, [...SKILLS, debugLike, ciLike]).map((m) => m.name), [], req);
    }
    assert.strictEqual(recommendSkills("the login page doesn't work anymore", [...SKILLS, debugLike])[0]?.name, 'debug');
    assert.strictEqual(recommendSkills('fix this bug', [...SKILLS, debugLike])[0]?.name, 'debug', 'task verbs are not stop words');
    assert.strictEqual(recommendSkills('set up CI/CD for this repo', [...SKILLS, ciLike])[0]?.name, 'deploy', 'verbatim phrase match works without content words');
    assert.ok(!recommendSkills('ship the relationship diagram to the docs folder', SKILLS).some((m) => m.name === 'deploy'), 'whole-word trigger match only');
  });

  test('keeps only runners-up in the same league as the best match', () => {
    const r = recommendSkills('write tests for the deploy script', SKILLS);
    assert.strictEqual(r[0]?.name, 'test');
    assert.ok(r.every((m) => m.score >= r[0].score * 0.5), JSON.stringify(r));
  });

  test('ignores attached context blocks when matching', () => {
    const r = recommendSkills('<attachment path="Dockerfile">\nFROM node\nRUN npm test\n</attachment>\n\nrename the variable foo to bar', SKILLS);
    assert.deepStrictEqual(r.map((s) => s.name), []);
  });

  test('topicKey groups similar requests and slugFor produces a usable folder name', () => {
    const a = topicKey('deploy the api service to staging');
    const b = topicKey('please deploy api service to the staging env');
    assert.ok(a && a.startsWith('deploy|'), String(a));
    assert.strictEqual(a, b);
    assert.match(slugFor(a!), /^deploy-[a-z-]+$/);
    assert.strictEqual(topicKey('ok'), undefined);
  });

  test('strong matches (name / trigger phrase) are flagged for preloading; weak ones only get a hint', () => {
    const strong = recommendSkills('deploy this with docker', SKILLS);
    assert.ok(strong[0]?.strong, JSON.stringify(strong));
    const weak = recommendSkills('the spacing and typography on the settings page look off, improve the layout', SKILLS);
    assert.strictEqual(weak[0]?.name, 'ui-design');
    assert.ok(!weak[0]?.strong, JSON.stringify(weak));
    assert.ok(/may apply/.test(skillHint(weak)) && /Use only these names/.test(skillHint(weak)));
    // One token of a hyphenated name is not the name: "compute_total" must not make "azure-compute" mandatory.
    const partial = recommendSkills('which file defines compute_total?', [...SKILLS, { name: 'azure-compute', description: 'Azure VM/VMSS router. WHEN: create / provision VM, recommend VM size, compare VM pricing.' }]);
    assert.ok(partial.every((m) => !m.strong), JSON.stringify(partial));
  });

  test('namesTool recognises a request that prescribes a tool', () => {
    const tools = ['write_file', 'edit_file', 'read_file', 'run_command'];
    assert.ok(namesTool('Use the write_file tool to create hello.txt', tools));
    assert.ok(namesTool('fix only that line with edit_file', tools));
    assert.ok(!namesTool('write a file with the results', tools));
    assert.ok(!namesTool('read_files is not a tool', tools));
  });

  test('prompt helpers mention the skill path and the first match', () => {
    const p = createSkillPrompt({ topic: 'deploy|service|staging', slug: 'deploy-service-staging', count: 3, samples: ['deploy to staging'] });
    assert.ok(p.includes('.localpilot/skills/deploy-service-staging/SKILL.md'));
    assert.ok(skillHint(recommendSkills('deploy with docker', SKILLS)).includes('load_skill("deploy")'));
    assert.strictEqual(skillHint([]), '');
  });

  test('preload note explains why each skill is loaded and forbids re-loading or summarising; long bodies are clamped', () => {
    const body = '<skill name="deploy" dir="/x">\n# Deploy\n1. build\n2. push\n</skill>';
    const one = skillPreloadNote([{ name: 'deploy', body, reason: 'match' }]);
    assert.ok(/"deploy" is loaded below because it matches this request/.test(one), one);
    assert.ok(/do not call load_skill for it again/.test(one) && one.includes(body));
    const many = skillPreloadNote([{ name: 'a', body: '<skill name="a">A</skill>', reason: 'pinned' }, { name: 'b', body: '<skill name="b">B</skill>', reason: 'forced' }]);
    assert.ok(/"a" \(it is pinned to this chat\)/.test(many) && /"b" \(you were asked to use it\)/.test(many), many);
    assert.strictEqual(skillPreloadNote([]), '');
    const long = `<skill name="big" dir="/b">\n${'step line\n'.repeat(500)}</skill>`;
    const clamped = clampSkillBody(long, 1000);
    assert.ok(clamped.length < 1300 && /trimmed to fit the context window/.test(clamped) && clamped.trimEnd().endsWith('</skill>'), clamped.slice(-200));
    assert.strictEqual(clampSkillBody('short', 1000), 'short');
  });

  test('skill names a model mangled resolve to the installed skill; disabled skills are invisible to the agent', async function () {
    this.timeout(20_000);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-skills-'));
    const mk = async (name: string, desc: string) => {
      await fs.mkdir(path.join(tmp, name), { recursive: true });
      await fs.writeFile(path.join(tmp, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\n1. do the thing\n`);
    };
    await mk('pdf', 'Read and write PDF files. Use for "pdf"');
    await mk('azure-compute', 'Create Azure VMs');
    await mk('deploy', 'Deploy the service');
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevDisabled = cfg.inspect<string[]>('skills.disabled')?.globalValue;
    const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscode.LogOutputChannel;
    const mgr = new SkillManager(log, tmp);
    try {
      await cfg.update('skills.disabled', ['deploy'], vscode.ConfigurationTarget.Global);
      await mgr.refresh();
      assert.strictEqual(normalizeSkillName('My PDF_Skill'), 'my-pdf');
      assert.strictEqual(normalizeSkillName('Azure Compute'), 'azure-compute');
      assert.strictEqual(mgr.resolveSkill('pdf')?.exact, true);
      for (const mangled of ['PDF', 'pdf-skill', 'pdf_skill', 'pfd']) {
        assert.strictEqual(mgr.resolveSkill(mangled)?.skill.name, 'pdf', mangled);
        assert.strictEqual(mgr.resolveSkill(mangled)?.exact, false, mangled);
      }
      assert.strictEqual(mgr.resolveSkill('azure compute')?.skill.name, 'azure-compute');
      assert.strictEqual(mgr.resolveSkill('AzureCompute')?.skill.name, 'azure-compute');
      assert.strictEqual(mgr.resolveSkill('kubernetes'), undefined, 'no fuzzy match for an unrelated name');
      assert.strictEqual(mgr.resolveSkill('deploy'), undefined, 'disabled skills do not resolve');
      assert.ok(mgr.getSkill('deploy')?.disabled, 'but stay listed for Settings');
      // The host also scans the machine's own skill folders, so check membership rather than the exact set.
      const enabled = mgr.enabledSkills.map((s) => s.name);
      assert.ok(enabled.includes('pdf') && enabled.includes('azure-compute') && !enabled.includes('deploy'), enabled.join(','));
      assert.ok(!/^- deploy:/m.test(mgr.skillsIndex()) && /^- pdf:/m.test(mgr.skillsIndex()));
      assert.strictEqual(await mgr.loadSkillBody('deploy'), undefined);
      assert.match((await mgr.loadSkillBody('PDF')) ?? '', /^<skill name="pdf" dir=/);
      assert.ok(mgr.similarSkillNames('pfd').includes('pdf'));
    } finally {
      mgr.dispose();
      await cfg.update('skills.disabled', prevDisabled, vscode.ConfigurationTarget.Global);
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

suite('Subagent routing', () => {
  const agents = builtinAgents();
  const explore = agents.find((a) => a.name === 'explore')!;
  const coder = agents.find((a) => a.name === 'coder')!;
  const reviewer = agents.find((a) => a.name === 'reviewer')!;

  test('read-only agents get the fast role, mutating ones the agent role', () => {
    assert.strictEqual(routeSubagent(explore, undefined, 'ollama/big', { enabled: true }).role, 'fast');
    assert.strictEqual(routeSubagent(coder, undefined, 'ollama/big', { enabled: true }).role, 'agent');
    assert.strictEqual(routeSubagent(reviewer, undefined, 'ollama/big', { enabled: true }).role, 'agent', 'reviewer can run commands');
  });

  test('explicit and agent-file models win; routing settings fill the rest', () => {
    assert.strictEqual(routeSubagent(explore, 'ollama/x', 'ollama/big', { enabled: true }).modelRef, 'ollama/x');
    assert.strictEqual(routeSubagent({ ...coder, model: 'ollama/y' }, undefined, 'ollama/big', { enabled: true }).modelRef, 'ollama/y');
    assert.strictEqual(routeSubagent(coder, undefined, 'ollama/big', { enabled: true, coding: 'ollama/coder32b' }).modelRef, 'ollama/coder32b');
    assert.strictEqual(routeSubagent(coder, undefined, 'ollama/big', { enabled: true }).modelRef, 'ollama/big');
    assert.strictEqual(routeSubagent(explore, undefined, 'ollama/big', { enabled: true }).modelRef, undefined, 'router picks the fast model');
    assert.strictEqual(routeSubagent(explore, undefined, 'ollama/big', { enabled: true, fast: 'session' }).modelRef, 'ollama/big');
    assert.strictEqual(routeSubagent(explore, undefined, 'ollama/big', { enabled: false }).modelRef, 'ollama/big');
  });

  test('fast role prefers the smallest tool-capable instruct model', () => {
    const m = (modelId: string, sizeGb: number, tools = true): ModelInfo => ({ id: `ollama/${modelId}`, providerId: 'ollama', modelId, name: modelId, contextWindow: 32768, maxOutputTokens: 4096, supportsTools: tools, supportsVision: false, sizeBytes: sizeGb * 1024 ** 3 });
    const models = [m('qwen2.5-coder:32b', 19), m('qwen2.5-coder:7b', 4.7), m('qwen2.5-coder:1.5b-base', 1, false), m('deepseek-r1:8b', 5), m('llama3.2:3b', 2)];
    const best = pickForRole(models, 'fast');
    assert.ok(best && best.supportsTools);
    assert.ok(['llama3.2:3b', 'qwen2.5-coder:7b'].includes(best!.modelId), best!.modelId);
    assert.ok(scoreForRole(m('qwen2.5-coder:7b', 4.7), 'fast') > scoreForRole(m('qwen2.5-coder:32b', 19), 'fast'));
    assert.ok(scoreForRole(m('qwen2.5-coder:7b', 4.7), 'fast') > scoreForRole(m('deepseek-r1:8b', 5), 'fast'));
  });
});

suite('Skill installation', () => {
  test('parseSkillSource understands GitHub shorthands, URLs, SKILL.md links and local paths', () => {
    assert.deepStrictEqual(parseSkillSource('owner/repo'), { kind: 'github', owner: 'owner', repo: 'repo', ref: undefined, path: '' });
    assert.deepStrictEqual(parseSkillSource('owner/repo/skills/pdf'), { kind: 'github', owner: 'owner', repo: 'repo', ref: undefined, path: 'skills/pdf' });
    assert.deepStrictEqual(parseSkillSource('owner/repo@v2/skills/pdf/SKILL.md'), { kind: 'github', owner: 'owner', repo: 'repo', ref: 'v2', path: 'skills/pdf' });
    assert.deepStrictEqual(parseSkillSource('https://github.com/owner/repo'), { kind: 'github', owner: 'owner', repo: 'repo', ref: undefined, path: '' });
    assert.deepStrictEqual(parseSkillSource('https://github.com/owner/repo.git'), { kind: 'github', owner: 'owner', repo: 'repo', ref: undefined, path: '' });
    assert.deepStrictEqual(parseSkillSource('https://github.com/owner/repo/tree/main/skills/pdf'), { kind: 'github', owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/pdf' });
    assert.deepStrictEqual(parseSkillSource('https://github.com/owner/repo/blob/main/skills/pdf/SKILL.md'), { kind: 'github', owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/pdf' });
    assert.deepStrictEqual(parseSkillSource('https://raw.githubusercontent.com/owner/repo/refs/heads/main/skills/pdf/SKILL.md'), { kind: 'github', owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/pdf' });
    assert.deepStrictEqual(parseSkillSource('https://example.com/skills/pdf/SKILL.md'), { kind: 'url', url: 'https://example.com/skills/pdf/SKILL.md' });
    assert.deepStrictEqual(parseSkillSource('./my-skill'), { kind: 'local', path: './my-skill' });
    assert.deepStrictEqual(parseSkillSource('~/skills/x'), { kind: 'local', path: path.join(os.homedir(), 'skills', 'x') });
    assert.strictEqual(parseSkillSource('   '), undefined);
    assert.strictEqual(describeSource(parseSkillSource('owner/repo@v2/skills/pdf')!), 'owner/repo/skills/pdf@v2');
    assert.strictEqual(skillsDestination('workspace', '/ws'), path.join('/ws', '.localpilot', 'skills'));
    assert.strictEqual(skillsDestination('workspace'), path.join(os.homedir(), '.localpilot', 'skills'), 'no workspace → user folder');
  });

  test('findSkillDirs lists skill folders under a base path, exact folder first', () => {
    const files = ['README.md', 'skills/pdf/SKILL.md', 'skills/pdf/scripts/x.py', 'skills/xlsx/SKILL.md', 'other/deep/thing/SKILL.md', 'SKILL.md'];
    assert.deepStrictEqual(findSkillDirs(files), ['', 'skills/pdf', 'skills/xlsx', 'other/deep/thing']);
    assert.deepStrictEqual(findSkillDirs(files, 'skills'), ['skills/pdf', 'skills/xlsx']);
    assert.deepStrictEqual(findSkillDirs(files, 'skills/pdf'), ['skills/pdf']);
    assert.deepStrictEqual(findSkillDirs(files, 'nope'), []);
  });

  test('installs a skill collection from GitHub through the trees API (mocked) and from a local folder', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-skill-'));
    const dest = path.join(tmp, 'dest');
    const tree = [
      { path: 'README.md', type: 'blob', size: 10 },
      { path: 'skills/pdf/SKILL.md', type: 'blob', size: 80 },
      { path: 'skills/pdf/scripts/fill.py', type: 'blob', size: 20 },
      { path: 'skills/xlsx/SKILL.md', type: 'blob', size: 60 },
      { path: 'skills', type: 'tree' },
    ];
    const bodies: Record<string, string> = {
      'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Work with PDFs. Use for "pdf".\n---\n# PDF\nRun scripts/fill.py',
      'skills/pdf/scripts/fill.py': 'print(1)',
      'skills/xlsx/SKILL.md': '---\nname: Spread Sheets\ndescription: Excel files.\n---\n# XLSX',
    };
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const ok = (body: string, json = false) => new Response(body, { status: 200, headers: { 'content-type': json ? 'application/json' : 'text/plain' } });
      if (url === 'https://api.github.com/repos/acme/skills') { return ok(JSON.stringify({ default_branch: 'trunk' }), true); }
      if (url === 'https://api.github.com/repos/acme/skills/git/trees/trunk?recursive=1') { return ok(JSON.stringify({ tree }), true); }
      const m = /^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/trunk\/(.+)$/.exec(url);
      if (m && bodies[m[1]]) { return ok(bodies[m[1]]); }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const src = parseSkillSource('acme/skills')!;
    const found = await discoverSkills(src, { fetchImpl });
    assert.deepStrictEqual(found.map((f) => [f.name, f.dir, f.files]), [['pdf', 'skills/pdf', ['SKILL.md', 'scripts/fill.py']], ['spread-sheets', 'skills/xlsx', ['SKILL.md']]]);
    const installed = await installSkills(src, { dest, only: ['pdf'], fetchImpl });
    assert.deepStrictEqual(installed.map((i) => [i.name, i.files]), [['pdf', 2]]);
    assert.strictEqual(await fs.readFile(path.join(dest, 'pdf', 'scripts', 'fill.py'), 'utf8'), 'print(1)');
    assert.ok(!(await fs.stat(path.join(dest, 'spread-sheets')).catch(() => false)), 'unselected skill is not installed');
    // Existing skill: skipped unless onExists says replace.
    const again = await installSkills(src, { dest, only: ['pdf'], fetchImpl });
    assert.deepStrictEqual(again, []);
    const replaced = await installSkills(src, { dest, only: ['pdf'], fetchImpl, onExists: async () => true });
    assert.strictEqual(replaced[0]?.name, 'pdf');
    assert.ok(calls.every((c) => c.startsWith('https://api.github.com/') || c.startsWith('https://raw.githubusercontent.com/')), 'only GitHub endpoints are contacted');
    // Local folder → user/workspace folder copy.
    const local = await installSkills({ kind: 'local', path: path.join(dest, 'pdf') }, { dest: path.join(tmp, 'dest2') });
    assert.deepStrictEqual(local.map((i) => [i.name, i.files]), [['pdf', 2]]);
    await assert.rejects(discoverSkills({ kind: 'local', path: path.join(tmp, 'missing') }), /does not exist/);
    await assert.rejects(discoverSkills(parseSkillSource('acme/skills/nothing-here')!, { fetchImpl }), /No SKILL\.md found/);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

suite('Skill catalog', () => {
  const CATALOG: CatalogEntry[] = [
    { name: 'writing-plans', description: 'Write a step-by-step implementation plan before coding. Use for "write a plan", "plan this", "planning".', repo: 'acme/superskills/skills', dir: 'skills/writing-plans' },
    { name: 'systematic-debugging', description: 'Find the root cause of a bug with hypotheses, instrumentation and bisection before fixing. Use for "debug", "root cause".', repo: 'acme/superskills/skills', dir: 'skills/systematic-debugging' },
    { name: 'pdf', description: 'Read, fill and merge PDF files with scripts. Use for "pdf", "fill a form".', repo: 'acme/skills/skills', dir: 'skills/pdf' },
    { name: 'brand-guidelines', description: 'Apply the company colour palette and typography to generated artifacts.', repo: 'acme/skills/skills', dir: 'skills/brand-guidelines' },
    { name: 'playwright-automation-fill-in-form', description: 'Automate filling in web forms and clicking through pages with Playwright.', repo: 'acme/more/skills', dir: 'skills/playwright-automation-fill-in-form' },
    { name: 'add-educational-comments', description: 'Add explanatory comments to code for learners.', repo: 'acme/more/skills', dir: 'skills/add-educational-comments' },
  ];
  const catalog = () => new SkillCatalog({ cacheFile: path.join(os.tmpdir(), `lp-catalog-${Math.random().toString(36).slice(2)}.json`), repositories: () => ['acme/superskills/skills', 'acme/skills/skills', 'acme/more/skills'] });

  test('picks a catalog skill only when it beats what is installed and clears the threshold', () => {
    const c = catalog();
    assert.strictEqual(c.pick('write a plan for migrating auth to OAuth', SKILLS, CATALOG)?.name, 'writing-plans');
    assert.strictEqual(c.pick('fill this pdf form with the invoice data', SKILLS, CATALOG)?.name, 'pdf', 'exact name beats a partial match of a long name');
    assert.strictEqual(c.pick('deploy this to production with docker', SKILLS, CATALOG), undefined, 'installed deploy skill wins');
    assert.strictEqual(c.pick('hello', SKILLS, CATALOG), undefined);
    assert.strictEqual(c.pick('rename getUser to fetchUser in src/api.ts', SKILLS, CATALOG), undefined, 'no evidence → nothing to install');
    assert.strictEqual(c.pick('add a logout button to the header', SKILLS, CATALOG), undefined, 'one generic word of a long name is not a match');
    assert.strictEqual(c.pick('use playwright to fill in the login form', SKILLS, CATALOG)?.name, 'playwright-automation-fill-in-form');
    const weak = c.pick('apply some colour to the page', SKILLS, CATALOG);
    assert.ok(!weak || weak.score >= AUTO_INSTALL_MIN_SCORE, `weak description-only hits stay below the bar: ${JSON.stringify(weak)}`);
    // Already installed under the same name: never re-offered.
    assert.strictEqual(c.pick('write a plan for the migration', [...SKILLS, { name: 'writing-plans', description: 'local copy' }], CATALOG), undefined);
    assert.deepStrictEqual(sourceFor(CATALOG[0]), { kind: 'github', owner: 'acme', repo: 'superskills', ref: undefined, path: 'skills/writing-plans' });
  });

  test('indexes repositories through the trees API, caches the index, installs the match and respects removals', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-catalog-'));
    const cacheFile = path.join(tmp, 'catalog.json');
    const dest = path.join(tmp, 'skills');
    const bodies: Record<string, string> = {
      'skills/writing-plans/SKILL.md': '---\nname: writing-plans\ndescription: Write a step-by-step implementation plan before coding. Use for "write a plan", "planning".\n---\n# Plans',
      'skills/writing-plans/template.md': '# Plan template',
      'skills/systematic-debugging/SKILL.md': '---\nname: systematic-debugging\ndescription: Find the root cause of a bug before fixing. Use for "debug", "root cause".\n---\n# Debug',
    };
    const tree = Object.keys(bodies).map((p) => ({ path: p, type: 'blob', size: 50 }));
    let apiCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      const ok = (body: string, json = false) => new Response(body, { status: 200, headers: { 'content-type': json ? 'application/json' : 'text/plain' } });
      if (url === 'https://api.github.com/repos/acme/superskills') { apiCalls++; return ok(JSON.stringify({ default_branch: 'main' }), true); }
      if (url === 'https://api.github.com/repos/acme/superskills/git/trees/main?recursive=1') { apiCalls++; return ok(JSON.stringify({ tree }), true); }
      const m = /^https:\/\/raw\.githubusercontent\.com\/acme\/superskills\/main\/(.+)$/.exec(url);
      if (m && bodies[m[1]]) { return ok(bodies[m[1]]); }
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const repos = () => ['acme/superskills/skills', 'acme/missing'];
    const c = new SkillCatalog({ cacheFile, repositories: repos, fetchImpl, ttlMs: 60_000 });
    assert.strictEqual(await c.ready(), false);
    const entries = await c.refresh();
    assert.deepStrictEqual(entries.map((e) => [e.name, e.repo, e.dir]), [['systematic-debugging', 'acme/superskills/skills', 'skills/systematic-debugging'], ['writing-plans', 'acme/superskills/skills', 'skills/writing-plans']]);
    const status = await c.status();
    assert.ok(status.find((s) => s.repo === 'acme/missing')?.error, 'a broken repository is reported, not fatal');
    assert.strictEqual(status.find((s) => s.repo === 'acme/superskills/skills')?.skills, 2);

    // A second instance reads the cache instead of GitHub.
    const before = apiCalls;
    const c2 = new SkillCatalog({ cacheFile, repositories: repos, fetchImpl, ttlMs: 60_000 });
    assert.strictEqual((await c2.entries()).length, 2);
    assert.strictEqual(apiCalls, before, 'fresh cache → no API calls');

    const match = await c2.match('write a plan for splitting the monolith', SKILLS);
    assert.strictEqual(match?.name, 'writing-plans');
    const installed = await c2.install(match!, dest, { timeoutMs: 5_000, auto: true });
    assert.deepStrictEqual([installed?.name, installed?.files], ['writing-plans', 2]);
    assert.strictEqual(await fs.readFile(path.join(dest, 'writing-plans', 'template.md'), 'utf8'), '# Plan template');
    // Installed now → not matched again; removed by the user afterwards → not re-installed either.
    const local = [...SKILLS, { name: 'writing-plans', description: 'Write a step-by-step implementation plan. Use for "write a plan".' }];
    assert.strictEqual(await c2.match('write a plan for splitting the monolith', local), undefined);
    const c3 = new SkillCatalog({ cacheFile, repositories: repos, fetchImpl, ttlMs: 60_000 });
    assert.strictEqual(await c3.match('write a plan for splitting the monolith', SKILLS), undefined, 'auto-installed then deleted → left alone');
    assert.strictEqual((await c3.match('debug why the login page crashes, find the root cause', SKILLS))?.name, 'systematic-debugging');
    await c3.dismiss('systematic-debugging');
    assert.strictEqual(await c3.match('debug why the login page crashes, find the root cause', SKILLS), undefined, 'dismissed skills are not offered');
    assert.deepStrictEqual((await c3.search('debugging a crash')).map((h) => h.name), ['systematic-debugging']);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
