import * as assert from 'assert';
import { createSkillPrompt, recommendSkills, skillHint, slugFor, tokenize, topicKey } from '../agent/skillRecommender';
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

  test('prompt helpers mention the skill path and the first match', () => {
    const p = createSkillPrompt({ topic: 'deploy|service|staging', slug: 'deploy-service-staging', count: 3, samples: ['deploy to staging'] });
    assert.ok(p.includes('.localpilot/skills/deploy-service-staging/SKILL.md'));
    assert.ok(skillHint(recommendSkills('deploy with docker', SKILLS)).includes('load_skill("deploy")'));
    assert.strictEqual(skillHint([]), '');
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
