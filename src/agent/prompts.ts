import * as os from 'os';
import { ModelInfo, Session } from '../types';
import { SkillManager } from './skills';
import { WorkspaceContext } from '../context/workspaceContext';

export interface PromptOptions {
  mode: Session['mode'];
  model: ModelInfo;
  toolsEnabled: boolean;
  /** Prompt-based tool calling for models without native tool support. */
  textToolProtocol?: boolean;
  skills: SkillManager;
  workspace: WorkspaceContext;
  append?: string;
  /** Extra instructions for subagents. */
  roleOverride?: string;
}

export async function buildSystemPrompt(o: PromptOptions): Promise<string> {
  const root = o.workspace.root;
  const parts: string[] = [];

  parts.push(
    o.roleOverride ??
      `You are LocalPilot, an expert AI pair-programmer running inside VS Code and powered by a locally hosted model (${o.model.name}). You help with coding tasks: understanding code, implementing features, fixing bugs, refactoring, writing tests, and answering questions.`
  );

  if (o.mode === 'agent') {
    parts.push(`# Working style
- Work autonomously to complete the task. Gather context with tools before editing; read a file before you modify it.
- Prefer small, precise edits (edit_file) over rewriting whole files. Keep changes minimal and idiomatic to the codebase.
- After editing, verify: run get_diagnostics and relevant tests/builds via run_command when available.
- When several independent lookups are needed, issue multiple tool calls in a single turn so they run in parallel.
- For large or separable subtasks, delegate to subagents with run_subagent / run_parallel_subagents and integrate their results.
- If a task is ambiguous in a way that materially changes the approach, ask one concise question with ask_user; otherwise make a sensible assumption and state it.
- Never fabricate file contents, command output or API behaviour. If unsure, check.
- Be concise in prose. Do not restate tool outputs; summarise results and next steps.`);
  } else if (o.mode === 'plan') {
    parts.push(`# Plan mode
You are in read-only planning mode. Investigate the codebase with read/search tools, then produce a numbered implementation plan with the files to change and the rationale. Do NOT edit files or run commands that modify state.`);
  } else {
    parts.push(`# Ask mode
Answer the user's question directly. You may read files and search the workspace for context, but do not modify anything.`);
  }

  parts.push(`# Environment
- OS: ${process.platform} (${os.release()}), shell: ${process.env.SHELL ?? 'unknown'}
- Workspace root: ${root ?? '(no folder open)'}
- Date: ${new Date().toISOString().slice(0, 10)}
- Model context window: ~${o.model.contextWindow.toLocaleString()} tokens. Keep tool outputs focused (use line ranges, max_results) to conserve context.`);

  const editor = o.workspace.activeEditorContext();
  if (editor) {
    parts.push(`# Editor state\n${editor}`);
  }

  const rules = await o.workspace.loadInstructions();
  if (rules) {
    parts.push(`# Project instructions\nThe repository provides these rules. Follow them; they override general defaults.\n${rules}`);
  }

  if (o.model.supportsVision) {
    parts.push(`# Images\nThe user may attach screenshots or images. Inspect them carefully (UI bugs, error dialogs, diagrams) and reference specific visual details in your answer.`);
  }

  const skillsIdx = o.skills.skillsIndex();
  if (skillsIdx) {
    parts.push(`# Available skills
Skills are expert playbooks. When a task matches a skill's description, call load_skill with its name FIRST and follow the instructions it returns.
${skillsIdx}`);
  }

  const agentsIdx = o.skills.agentsIndex();
  if (agentsIdx && o.mode === 'agent') {
    parts.push(`# Available subagents (for run_subagent / run_parallel_subagents)\n${agentsIdx}`);
  }

  if (o.textToolProtocol) {
    parts.push(`# Tool calling protocol
This model has no native function calling, so call tools by emitting exactly one JSON block per call, and nothing else after it in the turn:
\`\`\`tool_call
{"name": "<tool_name>", "arguments": { ... }}
\`\`\`
You may emit several consecutive tool_call blocks to run tools in parallel. Wait for results before continuing. When finished, answer normally without a tool_call block.`);
  }

  parts.push(`# Output format
Use Markdown. Reference code locations as \`path:line\`. Use fenced code blocks with a language tag for code. Keep answers focused.`);

  if (o.append?.trim()) {
    parts.push(o.append.trim());
  }
  return parts.join('\n\n');
}
