---
title: Agent, Ask & Plan
description: The three interaction modes and how approvals keep you in control.
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

## Ask

Read-only. The model may read and search the workspace and the web but never modifies anything. Ideal for explanations, architecture questions and code review.

## Plan

Read-only investigation followed by a numbered implementation plan with the files to change and the rationale. Switch to Agent and say *"implement the plan"* when happy.

Switch modes with the picker in the composer or `/mode agent|ask|plan`. Editor actions pick a sensible default (Explain → Ask, Fix → Agent).

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
