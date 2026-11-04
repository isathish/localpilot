import * as fs from 'fs';
import * as path from 'path';

/** Fixture transcripts in the on-disk formats of Claude Code and Codex, for the session importers. */

const j = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

export function claudeTranscript(cwd: string, sessionId = '6cccdc78-deaf-4210-8063-00cab3e92e4d'): string {
  const base = { sessionId, cwd, userType: 'external', version: '2.1.0', gitBranch: 'main' };
  return j([
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-01T09:00:00.000Z', sessionId },
    { ...base, type: 'user', uuid: 'u1', isSidechain: false, timestamp: '2026-10-01T09:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix the failing test in src/math.ts' }] } },
    { ...base, type: 'user', uuid: 'u1m', isMeta: true, timestamp: '2026-10-01T09:00:01.100Z', message: { role: 'user', content: '<system-reminder>context</system-reminder>' } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-01T09:00:02.000Z', message: { id: 'msg_1', role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: 'Look at the test first.' }] } },
    { ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-10-01T09:00:02.500Z', message: { id: 'msg_1', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Reading the file.' }] } },
    { ...base, type: 'assistant', uuid: 'a3', timestamp: '2026-10-01T09:00:03.000Z', message: { id: 'msg_1', role: 'assistant', model: 'claude-test', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/math.ts' } }] } },
    { ...base, type: 'user', uuid: 'u2', timestamp: '2026-10-01T09:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const add = (a, b) => a - b;' }] } },
    { ...base, type: 'assistant', uuid: 'a4', isSidechain: true, timestamp: '2026-10-01T09:00:04.500Z', message: { id: 'msg_side', role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
    { ...base, type: 'assistant', uuid: 'a5', timestamp: '2026-10-01T09:00:05.000Z', message: { id: 'msg_2', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Fixed: add used subtraction.' }] } },
    { type: 'ai-title', aiTitle: 'Fix add in math.ts', sessionId },
  ]);
}

export function codexRollout(cwd: string, id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'): string {
  return j([
    { timestamp: '2026-10-02T10:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-10-02T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.40.0' } },
    { timestamp: '2026-10-02T10:00:00.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } },
    { timestamp: '2026-10-02T10:00:00.200Z', type: 'turn_context', payload: { cwd, model: 'gpt-test' } },
    { timestamp: '2026-10-02T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the TODOs in this repo' }] } },
    { timestamp: '2026-10-02T10:00:01.500Z', type: 'event_msg', payload: { type: 'user_message', message: 'List the TODOs in this repo' } },
    { timestamp: '2026-10-02T10:00:02.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Search with rg.' }] } },
    { timestamp: '2026-10-02T10:00:02.500Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["rg","TODO"]}', call_id: 'call_1' } },
    { timestamp: '2026-10-02T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: '{"output":"src/a.ts:3: // TODO","metadata":{"exit_code":0}}' } },
    { timestamp: '2026-10-02T10:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One TODO: src/a.ts line 3.' }] } },
  ]);
}

/** Writes both transcripts for `cwd` into a fake home folder, plus a Codex chat of another folder. */
export function writeTranscriptHome(home: string, cwd: string): { claude: string; codex: string } {
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const claudeDir = path.join(home, '.claude', 'projects', slug);
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '10', '02');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  const claude = path.join(claudeDir, '6cccdc78-deaf-4210-8063-00cab3e92e4d.jsonl');
  const codex = path.join(codexDir, 'rollout-2026-10-02T10-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl');
  fs.writeFileSync(claude, claudeTranscript(cwd));
  fs.writeFileSync(codex, codexRollout(cwd));
  fs.writeFileSync(path.join(codexDir, 'rollout-2026-10-02T11-00-00-other.jsonl'), codexRollout(path.join(cwd, '..', 'elsewhere'), 'other'));
  return { claude, codex };
}
