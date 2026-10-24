---
title: Agent, Multitask, Debug, Plan & Ask
description: The five interaction modes and how approvals keep you in control.
permalink: /docs/agent-modes/
---

<p><img src="{{ '/assets/screenshots/mode-picker.png' | relative_url }}" alt="Mode picker: Agent, Ask, Plan" width="420"></p>

## Agent

The default. LocalPilot works autonomously until the task is done:

1. Gathers context (`read_file`, `grep_search`, `find_symbol`, …) — read-only tools run **in parallel** when the model requests several at once.
2. Edits with precise `edit_file` replacements (or `write_file` for new files).
3. Verifies with `get_diagnostics` and `run_command` (tests, builds).
4. Delegates separable work to subagents when useful.
5. Stops when finished or after the iteration limit, and summarises what changed.

Every edited file is snapshotted so you can **Keep / Undo / Diff** afterwards.

## Multitask

You describe the outcome — *"Coordinate parallel tasks…"* — and the agent **coordinates instead of typing**: it splits the request into independent pieces, briefs a background worker for each (coder, tester, docs, explore…) and starts them together with `run_todos_parallel`. The coordinator deliberately has **no file-editing tools**, so every change really goes through a worker; it keeps the read and command tools to verify the combined result.

In the chat the fan-out appears as a **N Working** card: one row per worker with its task and current step (*Reading README.md*, *Searching for roll_dice*), **Stop All** on the right, each row expandable to the worker's full trace, and **N Done** when they finish. Pieces that depend on another piece's result wait for it automatically. Pause / stop apply to the whole batch or to one worker (⏸ / ■ on its row). With isolated worktrees on (the default), the whole batch works in the session's copy of the repository and you **Apply to workspace** when you are happy.

## Debug

Agent mode with a debugging discipline: reproduce first (run the failing command or test, read the code on the stack), one hypothesis at a time, fix the root cause with the smallest change that makes the reproduction pass, re-run, add a regression test, remove temporary logging. Paste an error or describe what goes wrong.

## Plan

Read-only investigation, then a plan you can build with one click. The result is a **Prepared plan** card: title, one-line summary, the plan saved as `.localpilot/plans/<name>.plan.md` (open or copy it), the checklist of todos with their workers, and **Build** (<kbd>⌘↩</kbd>) — which switches the chat to Agent mode and runs the checklist, independent items in parallel. You can also just say *"implement the plan"*.

## Ask

Read-only. The model may read and search the workspace and the web but never modifies anything. Ideal for explanations, architecture questions and code review.

Switch modes with the picker in the composer or `/mode agent|multitask|debug|plan|ask` (CLI: `--multitask`, `--debug`, `--plan`, `--ask`). Editor actions pick a sensible default (Explain → Ask, Fix → Debug/Agent).

## Approvals

| Action | Setting | Default |
|---|---|---|
| Run a shell command | `localpilot.approvals.terminal` | `ask` |
| Create / edit a file | `localpilot.approvals.write` | `always` |
| Delete a path | `localpilot.approvals.delete` | `ask` |
| Web search / fetch, `browser_screenshot` / MCP tools | `localpilot.approvals.network` | `always` |

Values: `always` (auto-approve), `ask` (inline prompt with *Allow* / *Allow for session* / *Deny*), `never` (block).

Potentially destructive commands (`rm -rf /`, `sudo`, `git push --force`, …) are flagged in the approval card even when the policy is `always`-for-writes.

## Models without native tool calling

If the selected model lacks function calling, LocalPilot injects a text protocol:

````
```tool_call
{"name": "read_file", "arguments": {"path": "src/app.ts"}}
```
````

Tool calls are parsed from the response and results are fed back as a user message. Works well with most 7B+ instruct models.

## Iteration limits & cancellation

Each turn allows up to 40 model↔tool iterations (25 for subagents). Press **Stop** at any time; in-flight tool calls are cancelled.
