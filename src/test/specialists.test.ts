import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { builtinAgents, SPECIALISTS, specialistFor, specialistSection } from '../agent/builtinAgents';
import { createAgentPrompt } from '../agent/commands';
import { buildSystemPrompt } from '../agent/prompts';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { ModelInfo, SPECIALIST_IDS } from '../types';
import { ChatController } from '../ui/chatController';
import { miniDocument } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const CHAT_JS = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });
const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

/** A two-space-indented `const NAME = {…};` or `function name(…)` out of the chat webview's IIFE. */
function lift(name: string, kind: 'const' | 'function'): string {
  const start = CHAT_JS.indexOf(kind === 'const' ? `  const ${name} = {` : `  function ${name}(`);
  assert.ok(start > 0, `${name} not found in media/chat.js`);
  const line = CHAT_JS.slice(start, CHAT_JS.indexOf('\n', start));
  if (kind === 'function' && line.trimEnd().endsWith('}')) {
    return line;
  }
  const end = CHAT_JS.indexOf(kind === 'const' ? '\n  };\n' : '\n  }\n', start);
  assert.ok(end > start, `end of ${name} not found`);
  return CHAT_JS.slice(start, end + (kind === 'const' ? 5 : 4));
}

/** The webview's MODES / SPECIALISTS tables and the helpers that read them, with icons stubbed. */
function webviewModes() {
  const sandbox: Record<string, unknown> = { I: new Proxy({}, { get: (_t, k) => `<svg data-i="${String(k)}"></svg>` }) };
  vm.runInNewContext([lift('MODES', 'const'), lift('SPECIALISTS', 'const'), lift('specOf', 'function'), lift('modeView', 'function'), 'this.MODES = MODES; this.SPECIALISTS = SPECIALISTS; this.specOf = specOf; this.modeView = modeView;'].join('\n'), sandbox);
  return sandbox as { MODES: Record<string, { label: string; tag: string }>; SPECIALISTS: Record<string, { label: string; base: string; placeholder: string; icon: string }>; specOf: (s: unknown) => string; modeView: (s: unknown) => { label: string; baseLabel: string; tag: string; placeholder: string } };
}

suite('Mode picker: core modes and specialists', () => {
  test('core modes run from least to most autonomous, each tagged with whether it edits files', () => {
    const { MODES } = webviewModes();
    assert.deepStrictEqual(Object.keys(MODES), ['ask', 'agent', 'plan', 'debug', 'multitask']);
    assert.deepStrictEqual(Object.values(MODES).map((m) => m.tag), ['read-only', 'edits files', 'read-only', 'edits files', 'edits files']);
  });

  test('the webview and host specialist tables agree, and every playbook agent exists', () => {
    const { SPECIALISTS: web } = webviewModes();
    assert.deepStrictEqual(Object.keys(web), [...SPECIALIST_IDS]);
    const agents = new Set(builtinAgents().map((a) => a.name));
    for (const id of SPECIALIST_IDS) {
      assert.strictEqual(web[id].base, SPECIALISTS[id].base, `${id}: base mode`);
      assert.strictEqual(web[id].label, SPECIALISTS[id].label, `${id}: label`);
      assert.ok(web[id].placeholder && web[id].icon, `${id}: placeholder and icon`);
      const agent = SPECIALISTS[id].agent;
      assert.ok(!agent || agents.has(agent), `${id}: built-in agent ${agent}`);
    }
    // Permissions come from the base mode: review stays read-only, test edits.
    assert.strictEqual(SPECIALISTS.review.base, 'ask');
    assert.strictEqual(SPECIALISTS.architect.base, 'plan');
    assert.strictEqual(SPECIALISTS.test.base, 'agent');
  });

  test('the chip shows a specialist only while the chat is in its base mode', () => {
    const { specOf, modeView } = webviewModes();
    assert.strictEqual(specOf({ mode: 'ask', specialist: 'review' }), 'review');
    assert.strictEqual(specOf({ mode: 'agent', specialist: 'review' }), '', 'the chat moved on to Agent: plain Agent');
    assert.strictEqual(specOf({ mode: 'ask', specialist: 'nope' }), '');
    const v = modeView({ mode: 'ask', specialist: 'review' });
    assert.strictEqual(v.label, 'Review');
    assert.strictEqual(v.baseLabel, 'Ask');
    assert.strictEqual(v.tag, 'read-only');
    assert.strictEqual(modeView({ mode: 'debug' }).label, 'Debug');
    assert.strictEqual(modeView({ mode: 'debug' }).baseLabel, '');
  });

  test('a specialist adds its brief and its agent playbook to the system prompt, in its base mode only', async () => {
    const base = { model, toolsEnabled: true, skills: new SkillManager(log), workspace: new WorkspaceContext(log), project: false };
    const review = await buildSystemPrompt({ ...base, mode: 'ask', specialist: 'review' });
    assert.ok(review.includes('# Specialist: Review'));
    assert.ok(review.includes('meticulous code reviewer'), 'the reviewer agent playbook');
    assert.ok(!review.includes('the only thing the parent agent sees'), 'subagent report rules are dropped');
    assert.ok(review.indexOf('# Ask mode') < review.indexOf('# Specialist: Review'), 'after the mode section');
    const moved = await buildSystemPrompt({ ...base, mode: 'agent', specialist: 'review' });
    assert.ok(!moved.includes('# Specialist'), 'not in another mode');
    const sub = await buildSystemPrompt({ ...base, mode: 'ask', specialist: 'review', roleOverride: 'You are a subagent.' });
    assert.ok(!sub.includes('# Specialist'), 'subagents keep their own role');
    const terminal = await buildSystemPrompt({ ...base, mode: 'agent', specialist: 'terminal' });
    assert.ok(terminal.includes('# Specialist: Terminal') && !terminal.includes('<playbook>'), 'Terminal has a brief and no agent');
    assert.strictEqual(specialistFor('architect', 'plan')?.agent, 'planner');
    assert.strictEqual(specialistFor('architect', 'agent'), undefined);
    assert.ok(specialistSection(SPECIALISTS.test, { name: 'tester', systemPrompt: 'Custom tester.' }).includes('Custom tester.'), 'a workspace agent file replaces the built-in playbook');
  });

  function slashController() {
    const c = Object.create(ChatController.prototype) as any;
    Object.assign(c, {
      skills: { enabledSkills: [], getAgent: (n: string) => (n === 'reviewer' ? { name: 'reviewer' } : undefined) },
      _commands: { get: () => undefined, all: [] },
      workspace: { root: '/w' },
      store: { save() {}, get: () => undefined },
      broadcast() {},
      sessionMsg: () => ({ type: 'session' }),
    });
    return c;
  }

  test('/mode switches to a specialist (its base mode) and back; other modes clear it', () => {
    const c = slashController();
    const s: any = { id: 's1', messages: [], mode: 'agent' };
    assert.strictEqual(c.handleSlash(s, '/mode review'), '');
    assert.deepStrictEqual([s.mode, s.specialist], ['ask', 'review']);
    assert.strictEqual(c.handleSlash(s, '/mode architect'), '');
    assert.deepStrictEqual([s.mode, s.specialist], ['plan', 'architect']);
    assert.strictEqual(c.handleSlash(s, '/mode debug'), '');
    assert.deepStrictEqual([s.mode, s.specialist], ['debug', undefined]);
    assert.match(String(c.handleSlash(s, '/mode wizard')), /Usage/);
  });

  test('setMode keeps a specialist only with its own base mode', async () => {
    const s: any = { id: 's1', messages: [], mode: 'agent' };
    const c = Object.create(ChatController.prototype) as any;
    Object.assign(c, { store: { get: () => s, save() {} } });
    await c.handle({ type: 'setMode', sessionId: 's1', mode: 'agent', specialist: 'test' });
    assert.deepStrictEqual([s.mode, s.specialist], ['agent', 'test']);
    await c.handle({ type: 'setMode', sessionId: 's1', mode: 'ask', specialist: 'test' });
    assert.deepStrictEqual([s.mode, s.specialist], ['ask', undefined], 'Test does not run in Ask');
    await c.handle({ type: 'setMode', sessionId: 's1', mode: 'ask', specialist: 'explain' });
    assert.deepStrictEqual([s.mode, s.specialist], ['ask', 'explain']);
    await c.handle({ type: 'setMode', sessionId: 's1', mode: 'ask' });
    assert.strictEqual(s.specialist, undefined);
  });

  test('/agent new writes a subagent file request; a real agent called "new" still wins', () => {
    const c = slashController();
    const s: any = { id: 's1', messages: [], mode: 'agent' };
    assert.deepStrictEqual(c.handleSlash(s, '/agent new review SQL migrations'), { rewrite: createAgentPrompt('review SQL migrations', true) });
    assert.match(createAgentPrompt('x', true), /\.localpilot\/agents\/<name>\.md/);
    assert.match(createAgentPrompt('x', false), /~\/\.localpilot\/agents/);
    assert.match(String(c.handleSlash(s, '/agent new')), /Usage/);
    c.skills.getAgent = (n: string) => (n === 'new' ? { name: 'new' } : undefined);
    assert.notDeepStrictEqual(c.handleSlash(s, '/agent new do it'), { rewrite: createAgentPrompt('do it', true) });
  });
});

suite('Welcome screen: context strip', () => {
  function strip(state: Record<string, unknown>) {
    const doc = miniDocument();
    const el = doc.createElement('div');
    const sandbox: Record<string, unknown> = {
      state: { models: [{ id: 'a' }], modelsLoading: false, ...state },
      els: { messages: { querySelector: () => null } },
      I: new Proxy({}, { get: () => '<svg></svg>' }),
      esc: (t: string) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    };
    vm.runInNewContext(`${lift('ctxStatus', 'function')}\n${lift('renderCtxStrip', 'function')}\nrenderCtxStrip(target);`, { ...sandbox, target: el });
    return el;
  }

  test('folder, branch and Ready', () => {
    const el = strip({ workspace: { name: 'dice', folders: 1, branch: 'main' } });
    assert.strictEqual(el.querySelector('.folder .t')?.textContent, 'dice');
    assert.strictEqual(el.querySelector('.branch .t')?.textContent, 'main');
    assert.ok(el.querySelector('.status.ok'));
    assert.strictEqual(el.querySelector('.status .t')?.textContent, 'Ready');
  });

  test('the status that needs attention wins: no model, then waiting tasks, then offline', () => {
    assert.strictEqual(strip({ models: [], workspace: { name: 'd', folders: 1, interventions: 2 } }).querySelector('[data-a="setup"]')?.textContent, 'No model, set one up');
    assert.ok(strip({ models: [], modelsLoading: true, workspace: { name: 'd', folders: 1 } }).querySelector('.status.busy .spinner'));
    assert.strictEqual(strip({ workspace: { name: 'd', folders: 1, interventions: 2 } }).querySelector('[data-a="interventions"]')?.textContent, '2 tasks need you · Review');
    assert.strictEqual(strip({ workspace: { name: 'd', folders: 1, interventions: 1 } }).querySelector('[data-a="interventions"]')?.textContent, '1 task needs you · Review');
    assert.strictEqual(strip({ offline: true, models: [{ id: 'a' }], workspace: { name: 'd', folders: 1 } }).querySelector('.status .t')?.textContent, 'Offline · local models only');
  });

  test('no folder: chat only, with Open folder', () => {
    const el = strip({ workspace: { name: '', folders: 0 } });
    assert.strictEqual(el.querySelector('.folder .t')?.textContent, 'No folder open · chat only');
    assert.ok(el.querySelector('[data-a="openFolder"]'));
    assert.strictEqual(el.querySelector('.branch'), null);
  });
});
