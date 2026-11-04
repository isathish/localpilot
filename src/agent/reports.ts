import { InstructionFile } from '../context/instructions';
import { MemoryNote } from './memory';
import { ModelInfo, Session } from '../types';

/**
 * The `/memory` and `/context` texts (Markdown), shared by the chat and the terminal REPL. `surface` only changes
 * where the user is told to edit memory notes.
 */
export function memoryReport(files: readonly InstructionFile[], notes: readonly MemoryNote[], memoryEnabled: boolean, surface: 'vscode' | 'cli' = 'vscode'): string {
  const filesPart = files.length
    ? `**Instruction files in force** (in prompt order)\n${files.map((f) => `- \`${f.label}\` (${f.scope}${f.paths ? `, conditional: ${f.paths.length ? f.paths.map((g) => `\`${g}\``).join(', ') : 'never'}${f.applied ? ', applied last turn' : ''}` : ''}${f.note ? `, ${f.note}: over the instruction size cap` : ''})`).join('\n')}`
    : 'No instruction files found. Create `CLAUDE.md` or `AGENTS.md` in the workspace, `.claude/CLAUDE.md`, `CLAUDE.local.md` for personal notes, or `~/.claude/CLAUDE.md` for every project. Lines with `@path` import other files.';
  const shown = notes.slice(0, 30);
  const edit = surface === 'cli' ? 'Edit or delete them as Markdown in `.localpilot/memory/` (project) or `~/.localpilot/` (global).' : 'Edit or delete them in **Settings → Memory**, or as Markdown in `.localpilot/memory/`.';
  const notesPart = !memoryEnabled
    ? '**Memory notes** are off (`localpilot.memory.enabled`).'
    : notes.length
      ? `**Memory notes** (${notes.length}, newest first; the agent sees an index and the short ones in full)\n${shown.map((n) => `- \`${n.name}\` (${n.scope}, ${n.chars.toLocaleString()} chars): ${n.summary}`).join('\n')}${notes.length > shown.length ? `\n- …and ${notes.length - shown.length} more` : ''}\n\n${edit}`
      : '**Memory notes**: none yet. The agent saves durable facts (build commands, conventions, your preferences) with `memory_save`; you can also ask it to "remember" something.';
  return `${filesPart}\n\n${notesPart}`;
}

/** `model` is the session's model as listed (undefined when unknown); `window` its effective context window. */
export function contextReport(session: Pick<Session, 'contextTokens' | 'messages' | 'compactions' | 'model'>, model?: Pick<ModelInfo, 'contextWindow'>, window?: number): string {
  const of = window ? ` of ${window.toLocaleString()}${model && model.contextWindow > window ? ` (model supports ${model.contextWindow.toLocaleString()}; raise \`localpilot.contextWindow\` or set it to 0 for the model's maximum)` : ''}` : '';
  return `Context: ~${session.contextTokens.toLocaleString()}${of} tokens · ${session.messages.length} messages · ${session.compactions} compactions · model ${session.model || '(default)'}`;
}

/** Share of the context window in use, 0–100 (undefined without a known window). */
export function contextPercent(tokens: number, window: number | undefined): number | undefined {
  return window && window > 0 ? Math.min(100, Math.round((Math.max(0, tokens) / window) * 100)) : undefined;
}
