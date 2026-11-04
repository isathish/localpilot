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
   - One `read_file` call reads up to 8 files (`"files": [{"path", "start_line", "end_line"}]`). Each file shows at most 2,000 lines or 48,000 characters, ending with `[Showing lines A-B of N …]` while more remain.
   - Images (PNG, JPEG, GIF, WebP up to 10 MB) reach vision models as images; other models get an error. Binary files are reported by size, and files over 100 MB are refused.
   - File names with unusual spaces, such as the narrow no-break space in macOS screenshot names, are still found.
2. It edits with `edit_file` replacements, or `write_file` for new files.
   - `edit_file` can also insert at a line (`insert_line`; the line count + 1 appends). It keeps the file's CRLF or LF line endings.
   - Each result includes a unified diff of the change (at most 200 lines). Text over 6,000 characters is refused, with a request to split the edit.
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

Plan mode investigates without editing, then shows a **Prepared plan** card. MCP tools run in Plan only when their server marks them read-only (`readOnlyHint`).

### Read-only commands in Plan and Ask

`run_command` stays available in Plan and Ask, but only for commands that cannot change anything: `git log -5`, `git diff`, `ls`, `npm test` and the like run (after the usual terminal approval). Before a command runs, LocalPilot checks every part of it, including commands chained with `;`, `&&`, `|` or inside `$(…)`, and looks through `sudo`, `env`, `xargs`, `nice`, `time` and `VAR=` prefixes. Quoted text, heredoc bodies and comments are ignored. It refuses:

- file commands: `rm`, `mv`, `cp`, `touch`, `mkdir`, `chmod`, `ln`, `dd`, `tee`, `rsync`, `patch` and similar, plus `sed -i` and `perl -i`;
- redirection into a file (`>`, `>>`); `2>&1` and `>/dev/null` are fine;
- git commands that change the repository (`add`, `commit`, `checkout`, `reset`, `push`, `stash`, `tag v1` …), also through `git -C`;
- installing or removing packages with npm, pnpm, yarn, bun, pip, cargo, gem, composer, go, dotnet, brew, apt, winget or nuget;
- on Windows, `del`, `move`, `copy`, `xcopy`, `robocopy`, `New-Item`, `Set-Content`, `Out-File` and their aliases.

A refused command does not show an approval card. The model gets *"Plan mode: `rm` changes files. Only read-only commands run in Plan mode."* and carries on.

The card has:

- a title and one-line summary,
- the plan saved as `.localpilot/plans/<name>.plan.md` (open or copy it),
- the checklist of steps, each with the worker it will go to,
- a **Build** button (<kbd>⌘↩</kbd>).

**Build** switches the chat to Agent mode and runs the checklist, with independent steps in parallel. You can also switch to Agent and say *implement the plan*. See [Plans that execute themselves]({{ '/docs/parallel-agents/#plans-that-execute-themselves' | relative_url }}).

## Ask

Ask is read-only. The model can read and search the workspace, use web search and fetch, and run [read-only commands](#read-only-commands-in-plan-and-ask), but cannot edit or delete anything. MCP tools run in Ask only when their server marks them read-only (`readOnlyHint`). Use it for explanations, architecture questions and code review.

## Questions before it starts

For a new feature or an open-ended or larger request, the agent first reads the relevant code. Then it asks up to four questions in one card before it builds anything:

<p><img src="{{ '/assets/screenshots/questions.png' | relative_url }}" alt="A questions card: 3 questions before I start — where saved dice rolls should be kept (SQLite file recommended, JSON file, in memory only, or something else) and which extras the history view should include (choose any)" width="420"></p>

- **Each option explains what picking it means.** The agent's choice is marked **Recommended**.
- **Some questions allow several answers** ("choose any"). **Something else…** always lets you answer in your own words.
- **Keyboard:** <kbd>1</kbd>–<kbd>9</kbd> pick an option, <kbd>Enter</kbd> submits. **Skip** (or <kbd>Esc</kbd>) lets the agent go with its recommendations.
- **After your answers,** it states a short plan and starts. Clear, specific requests start right away without questions.
- **Queued tasks** never stop to ask. **In the CLI,** the questions appear in the terminal.

`localpilot.clarify.questions` sets how often it asks:

| Value | Behaviour |
|---|---|
| `smart` (default) | New features and open-ended or large requests: questions, a short plan, then it starts. Clear requests start at once. |
| `interview` | Every change: questions first, then the plan, and it waits for your OK before editing. |
| `minimal` | Only when two readings of the request would lead to materially different work. |

## Approvals

Each kind of action has its own setting:

| Action | Setting | Default |
|---|---|---|
| Run a shell command | `localpilot.approvals.terminal` | `ask` |
| Create or edit a file | `localpilot.approvals.write` | `always` |
| Delete a path | `localpilot.approvals.delete` | `ask` |
| Web search and fetch, `browser_screenshot` | `localpilot.approvals.network` | `always` |
| Tools from MCP servers | `localpilot.approvals.mcp` | `always` |

Values:

- `always`: run without asking.
- `ask`: show a prompt with *Allow*, *Allow for session* and *Deny*.
- `never`: block the action.

The setup wizard's presets set these four values. *Careful* asks for everything. *Balanced* (the default) asks for commands and deletes. *Autonomous* asks only for deletes.

When a command needs approval and matches a known destructive pattern (`rm -rf /`, `sudo`, `git push --force`, `git reset --hard` and others), the prompt is titled *Potentially destructive command*. If `localpilot.approvals.terminal` is `always`, commands run without a prompt, including these. Claude Code style permission rules in `settings.json` can also allow or deny specific tools; see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).

A prompt waits until you answer. If the chat is hidden, closed or moved while an agent waits, the prompt also appears as a VS Code notification (*Allow*, *Allow for session*, *Deny*, *Show chat*). Answering in either place closes both. **Stop** denies the chat's pending prompts.

<p><img src="{{ '/assets/screenshots/approval.png' | relative_url }}" alt="Approval card: Run command python -m pytest -q, with Deny (N), Allow for session (A) and Allow once (Y), above the Tasks and changed-files panels" width="420"></p>

## Models without native tool calling

If the selected model has no function calling, LocalPilot asks it to write tool calls as text:

````
```tool_call
{"name": "read_file", "arguments": {"path": "src/app.ts"}}
```
````

LocalPilot parses these blocks and returns the results as a user message. This is less reliable than native tool calling. Prefer a model with tool support for Agent mode.

## Iteration limit and stopping

A turn allows up to 40 model and tool round trips. Subagents get 25.

A run also stops when it keeps failing. After 6 steps in a row in which every tool call failed, or a tool call had to be sent back because it did not parse, the chat shows *LocalPilot ran into 6 errors in a row and stopped* with the latest error. Send a message to guide the agent and it continues normally. Any successful tool call resets the count. Change the limit with `localpilot.maxConsecutiveMistakes` (`0` = no limit).

When a reply stops at the output limit (`localpilot.maxOutputTokens`), LocalPilot recovers on its own. A tool call cut off mid-arguments is not run: the model is asked to resend it more concisely, splitting a large `write_file` into several `edit_file` calls, up to 3 times in a row. A text answer that was cut off is continued once and joined into one message.

Press **Stop** (<kbd>Esc</kbd> in the composer) at any time; tool calls in flight are cancelled. To hold an agent without cancelling it, use **Pause** (<kbd>⌥Esc</kbd>). See [Pause, steer and stop]({{ '/docs/parallel-agents/#pause-steer-and-stop' | relative_url }}).
