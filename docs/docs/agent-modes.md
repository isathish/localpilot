---
title: Agent, Multitask, Debug, Plan & Ask
description: The five LocalPilot modes, what each one may change, and how approvals decide what runs without asking.
permalink: /docs/agent-modes/
---

<p><img src="{{ '/assets/screenshots/mode-picker.png' | relative_url }}" alt="Mode picker: Agent, Multitask, Debug, Plan and Ask" width="370"></p>

LocalPilot has five modes. Agent, Multitask and Debug can change files and run commands. Plan and Ask are read-only.

| Mode | Edits files | Use it to |
|---|---|---|
| Agent | Yes | Make a change end to end |
| Multitask | Through workers only | Split a larger request across background workers |
| Debug | Yes | Find and fix a bug, starting from a reproduction |
| Plan | No | Get a plan you can review, then build |
| Ask | No | Get explanations and reviews |

Switch modes with the picker under the composer, <kbd>Shift+Tab</kbd> (cycles Agent → Multitask → Debug → Plan → Ask), or `/mode agent|multitask|debug|plan|ask`. In the CLI use `--agent`, `--multitask`, `--debug`, `--plan` or `--ask`. Editor actions pick a mode for you: Explain uses Ask; Fix, Refactor, Generate Tests and Add Documentation use Agent.

## Agent

Agent is the default. The agent works until the task is done:

1. It gathers context with read-only tools (`read_file`, `grep_search`, `find_symbol` and others). When the model requests several at once, they run in parallel.
2. It edits with `edit_file` replacements, or `write_file` for new files.
3. It checks its work with `get_diagnostics` and `run_command` (tests, builds).
4. It can hand separable work to subagents.
5. It stops when finished or at the iteration limit, and summarises what changed.

Every edited file is snapshotted first, so you can review, accept or reject it. See [Change review]({{ '/docs/parallel-agents/#change-review' | relative_url }}).

## Multitask

You describe the outcome. The agent then acts as a coordinator:

1. It splits the request into independent pieces.
2. It writes a brief for each piece and assigns a worker (coder, tester, docs, explore and so on).
3. It starts the workers together with `run_todos_parallel`. Pieces that depend on another piece wait for it.
4. It checks the combined result with read and command tools.

The coordinator has no file-editing or delete tools, so every change goes through a worker.

In the chat the fan-out appears as a **Working** card with one row per worker: its task and current step. Expand a row to see the worker's full trace. Use **Stop All** for the whole batch, or ⏸ / ■ on a row for one worker. The status line counts workers (*2 workers running · 1 queued · 1 done*).

Small models sometimes say they delegated without starting anything. LocalPilot marks that sentence as **retracted**, asks the model to act, and shows the real answer in a new block.

With isolated worktrees on (the default in a git repository), all workers share the session's worktree. You apply the result with **Apply to workspace**.

## Debug

Debug is Agent mode with a fixed method:

1. Reproduce the problem: run the failing command or test, read the code on the stack.
2. Test one hypothesis at a time.
3. Fix the root cause with the smallest change that makes the reproduction pass.
4. Re-run the reproduction.
5. Add a regression test and remove temporary logging.

Paste an error or describe what goes wrong.

## Plan

Plan mode investigates without editing, then shows a **Prepared plan** card:

- a title and one-line summary,
- the plan saved as `.localpilot/plans/<name>.plan.md` (open or copy it),
- the checklist of steps, each with the worker it will go to,
- a **Build** button (<kbd>⌘↩</kbd>).

**Build** switches the chat to Agent mode and runs the checklist, with independent steps in parallel. You can also switch to Agent and say *implement the plan*. See [Plans that execute themselves]({{ '/docs/parallel-agents/#plans-that-execute-themselves' | relative_url }}).

## Ask

Ask is read-only. The model can read and search the workspace and use web search and fetch, but cannot edit, delete or run commands. Use it for explanations, architecture questions and code review.

## Approvals

Each kind of action has its own setting:

| Action | Setting | Default |
|---|---|---|
| Run a shell command | `localpilot.approvals.terminal` | `ask` |
| Create or edit a file | `localpilot.approvals.write` | `always` |
| Delete a path | `localpilot.approvals.delete` | `ask` |
| Web search and fetch, `browser_screenshot`, MCP tools | `localpilot.approvals.network` | `always` |

Values:

- `always`: run without asking.
- `ask`: show a prompt with *Allow*, *Allow for session* and *Deny*.
- `never`: block the action.

The setup wizard's presets set these four values. *Careful* asks for everything. *Balanced* (the default) asks for commands and deletes. *Autonomous* asks only for deletes.

When a command needs approval and matches a known destructive pattern (`rm -rf /`, `sudo`, `git push --force`, `git reset --hard` and others), the prompt is titled *Potentially destructive command*. If `localpilot.approvals.terminal` is `always`, commands run without a prompt, including these. Claude Code style permission rules in `settings.json` can also allow or deny specific tools; see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).

A prompt waits until you answer. If the chat is hidden, closed or moved while an agent waits, the prompt also appears as a VS Code notification (*Allow*, *Allow for session*, *Deny*, *Show chat*). Answering in either place closes both. **Stop** denies the chat's pending prompts.

<p><img src="{{ '/assets/screenshots/approval.png' | relative_url }}" alt="Approval card: Run command git log --oneline -5, with Deny (N), Allow for session (A) and Allow once (Y)" width="420"></p>

## Models without native tool calling

If the selected model has no function calling, LocalPilot asks it to write tool calls as text:

````
```tool_call
{"name": "read_file", "arguments": {"path": "src/app.ts"}}
```
````

LocalPilot parses these blocks and returns the results as a user message. This is less reliable than native tool calling. Prefer a model with tool support for Agent mode.

## Iteration limit and stopping

A turn allows up to 40 model and tool round trips. Subagents get 25. Press **Stop** (<kbd>Esc</kbd> in the composer) at any time; tool calls in flight are cancelled. To hold an agent without cancelling it, use **Pause** (<kbd>⌥Esc</kbd>). See [Pause, steer and stop]({{ '/docs/parallel-agents/#pause-steer-and-stop' | relative_url }}).
