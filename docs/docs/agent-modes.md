---
title: Agent, Multitask, Debug, Plan & Ask
description: The five LocalPilot modes, what each one may change, and how approvals decide what runs without asking.
permalink: /docs/agent-modes/
---

<p><img src="{{ '/assets/screenshots/mode-picker.png' | relative_url }}" alt="Mode picker: Agent, Multitask, Debug, Plan and Ask" width="370"></p>

LocalPilot has five modes. Agent, Multitask and Debug can change files and run commands. Plan and Ask are read-only.

| Mode | Edits files | Use it to |
|---|---|---|
| Ask | No | Get explanations and reviews |
| Agent | Yes | Make a change end to end |
| Plan | No | Get a plan you can review, then build |
| Debug | Yes | Find and fix a bug, starting from a reproduction |
| Multitask | Through workers only | Split a larger request across background workers |

Switch modes with the picker under the composer, <kbd>Shift+Tab</kbd> or <kbd>Ctrl+.</kbd> (<kbd>Cmd+.</kbd> on macOS), which cycle Ask → Agent → Plan → Debug → Multitask, or `/mode ask|agent|plan|debug|multitask`. The picker tags each mode **read-only** or **edits files**. In the CLI use `--agent`, `--multitask`, `--debug`, `--plan` or `--ask`. Editor actions pick a mode for you: Explain uses Ask; Fix, Refactor, Generate Tests and Add Documentation use Agent.

## Agent

Agent is the default. The agent works until the task is done:

1. It gathers context with read-only tools (`read_file`, `grep_search`, `find_symbol` and others). When the model requests several at once, they run in parallel.
   - One `read_file` call reads up to 8 files (`"files": [{"path", "start_line", "end_line"}]`). Each file shows at most 2,000 lines or 48,000 characters, ending with `[Showing lines A-B of N …]` while more remain.
   - A Jupyter notebook (`.ipynb`) reads as its cells, not the JSON: `# [code] cell 3 (exec 12)` then the source and its text outputs (cut at 2,000 characters per cell); image outputs are left out. Line numbers count this view. The agent changes cells with `notebook_edit` (insert, replace or delete by cell number), not by editing the JSON.
   - Images (PNG, JPEG, GIF, WebP up to 10 MB) reach vision models as images; other models get an error. Binary files are reported by size, and files over 100 MB are refused.
   - File names with unusual spaces, such as the narrow no-break space in macOS screenshot names, are still found.
2. It edits with `edit_file` replacements, or `write_file` for new files.
   - `edit_file` can also insert at a line (`insert_line`; the line count + 1 appends). It keeps the file's CRLF or LF line endings.
   - After an edit or write, LocalPilot waits up to 1.5 s for the language server and adds the errors the change introduced in that file to the result (`New problems:` then `<line>: <message>`, at most 10), so the agent can fix them right away. Turn this off with `localpilot.edit.reportNewErrors`.
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
- on Windows, `del`, `move`, `copy`, `xcopy`, `robocopy`, `New-Item`, `Set-Content`, `Out-File` and their aliases;
- commands whose name comes from a variable or substitution (`$x -rf y`, `$(echo rm) y`), because what they run cannot be checked.

A refused command does not show an approval card. The model gets *"Plan mode: `rm` changes files. Only read-only commands run in Plan mode."* and carries on.

The card has:

- a title and one-line summary,
- the plan saved as `.localpilot/plans/<name>.plan.md` (open or copy it),
- the checklist of steps, each with the worker it will go to,
- a **Build** button (<kbd>⌘↩</kbd>).

**Build** switches the chat to Agent mode and runs the checklist, with independent steps in parallel. You can also switch to Agent and say *implement the plan*. See [Plans that execute themselves]({{ '/docs/parallel-agents/#plans-that-execute-themselves' | relative_url }}).

## More modes (specialists)

The picker's **More modes** section has seven specialists. Each one runs in one of the core modes, which decides what it may change, and adds the instructions of a [built-in subagent]({{ '/docs/skills-and-agents/' | relative_url }}) to the chat's system prompt. If a workspace or user agent file has the same name as that subagent, its instructions are used instead.

| Specialist | Runs in | Built-in agent | What it does |
|---|---|---|---|
| Architect | Plan | planner | Designs the change: modules, interfaces, risks and ordered steps |
| Review | Ask | reviewer | Reviews your uncommitted changes, or a file you name, and reports findings by severity |
| Test | Agent | tester | Writes and runs tests, then fixes failures |
| Refactor | Agent | coder | Restructures code without changing what it does, and checks this with the project's tests |
| Explain | Ask | explore | Walks through code, data flow and concepts |
| Terminal | Agent | (none) | Shell tasks; each command is shown with a one-line explanation before it runs |
| Project | Ask | explore | Gives a project overview: structure, entry points, and how to build, run and test it |

Pick one in the picker or type `/mode review` (or another specialist's name). The mode chip shows the specialist's name, and its tooltip names the mode it runs in, for example "Review · runs in Ask (read-only)". Switching to a core mode turns the specialist off. **Manage modes…** at the bottom of the picker opens Settings → Skills & subagents.

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
- `safe` (commands only): run read-only commands (`ls`, `cat`, `grep`, `git status`, `git log`, `git diff`…) and routine test, lint and build commands (`npm test`, `npm run lint`, `pnpm build`, `tsc`, `pytest`, `cargo build|test|check`, `go test|build|vet`, `make test|check`) without asking. Every other command asks, as do unknown programs, redirections into files, `sudo`, a command that sets environment variables (`PATH=. ls`, `GIT_EXTERNAL_DIFF=./x git diff`) and git's `-c`, `--config-env`, `--exec-path`, `--git-dir` and `--work-tree` options.
- `ask`: show a prompt with *Allow*, *Allow for session* and *Deny*.
- `never`: block the action.

The setup wizard's presets set these four values. *Careful* asks for everything. *Balanced* (the default) asks for commands and deletes. *Autonomous* asks only for deletes.

When a command matches a known destructive pattern (`rm -rf /`, `sudo`, `git push --force`, `git reset --hard` and others), the prompt is titled *Potentially destructive command*. Such a command asks even when `localpilot.approvals.terminal` is `always`, and *Allow for session* or auto mode does not answer it, unless you turn `localpilot.approvals.dangerousAlwaysAsk` off. The model can also set `requires_approval` on a command it considers impactful; that command asks even under `always` or `safe`. Claude Code style permission rules in `settings.json` can also allow or deny specific tools; see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).

A prompt waits until you answer. If the chat is hidden, closed or moved while an agent waits, the prompt also appears as a VS Code notification (*Allow*, *Allow for session*, *Deny*, *Show chat*). Answering in either place closes both. **Stop** denies the chat's pending prompts.

### Deny with a reason

To tell the agent what to do instead, deny with a reason. Type it in the message box and click **Deny**, or click **Deny with reason…** (or press Shift+N), type it in the box that opens and press Enter. The agent gets "The user denied this action: *your reason*" in place of a plain refusal, and the step shows as *Denied* rather than as a failure. In the terminal CLI, answer `n` followed by the reason, for example `n edit src/b.ts instead`.

### Edit a command, allow it everywhere, and see why it asked

A command prompt shows the command with shell highlighting. Click **Edit** to change it before it runs: **Allow edited** runs your version (in Ask and Plan mode it must still be read-only), and the agent is told what actually ran. The arrow next to the *Allow all … in this chat* button also offers **Always allow in this workspace…**, which asks you to confirm and then sets `localpilot.approvals.<kind>` to `always` in the workspace settings (destructive commands still ask). It is not offered for prompts that always ask. A line at the bottom of the prompt says why it asked, for example *Asked because Terminal commands = Ask*, with **Change in Settings**. The step the prompt belongs to reads *Needs approval · Review* in the transcript.

### Failed steps, stops and slow models

A failed step gets a row of actions under it: **Retry**, **Edit & retry** (change the command or arguments first), and while the run lasts **Skip** and **Stop run**. LocalPilot sends your choice to the agent as a message, so it runs through the same tools and approval rules. A command row has **Rerun** and **Open in terminal** (puts the command in a terminal at the same folder without running it), shows the folder when it is not the workspace root, and a test run shows its result, for example *6 passed · 1 failed*, with the failing tests listed first and **Re-run failed** and **Fix failures**.

A run you stop reads *Stopped by you after 1m 02s* with **Continue** and **Discard changes**, not as a failure. A paused run reads *Paused after step N* with its timer stopped and **Resume**. A step running longer than 30 seconds turns amber with its elapsed time (Esc stops the run). While a local model loads or reads a long prompt, a row such as *Loading gemma4:12b into memory · 24s · times out at 3:00* shows in the transcript, with **Switch model** and **Stop** after 20 seconds. When another model answers because the chosen one is unavailable, a note at the top of the turn says so, with **Use for this chat** and **Retry with** the original model. If VS Code closes or reloads during a run, the chat shows **Run interrupted** next time, with **Resume**, **Restore checkpoint** and **Dismiss**.

### Auto-approve bar

The line above the message box reads **Auto-approve:** followed by the categories that run without asking, for example *Edit, Web*. Click it to change them: Edit files, Delete, Commands (Ask, Safe only, Always, Never), Web, MCP and Auto Mode. A change writes the user setting and applies at once, also to a run in progress: switch Commands to *Always* and the agent's next command runs without a prompt. Choices your organization's policy rules out are disabled and marked *policy*.

### Notifications

When a chat finishes while the chat view is hidden or VS Code is not focused, LocalPilot shows a notification with **Open**. A command that was approved automatically and is still running after 30 seconds adds a status-bar item and a notification, once per command. Set `localpilot.notifications` to `always` to be notified even while you watch the chat, or to `off`. The terminal CLI rings the terminal bell when a run that took more than 10 seconds finishes.

<p><img src="{{ '/assets/screenshots/approval.png' | relative_url }}" alt="Approval card: Run command python -m pytest -q, with Deny (N), Allow for session (A) and Allow once (Y), above the Tasks and changed-files panels" width="420"></p>

## Models without native tool calling

If the selected model has no function calling, LocalPilot asks it to write tool calls as text:

````
```tool_call
{"name": "read_file", "arguments": {"path": "src/app.ts"}}
```
````

LocalPilot parses these blocks and returns the results as a user message. This is less reliable than native tool calling. Prefer a model with tool support for Agent mode.

## Self-healing in each mode

The [self-healing engine]({{ '/docs/self-healing/' | relative_url }}) works in every mode, but how much it does depends on what the mode may change:

| Mode | Self-healing |
|---|---|
| Agent, Debug | Full: when files changed, the project checks run before the task is reported done; failures are diagnosed, fixed and re-checked within the budgets |
| Multitask | Full, after the workers report. Independent failures can be fixed by parallel **fixer** workers; the coordinator then runs the full suite once |
| Plan, Ask | Detection and retry of transient model failures only. They change no files, so no checks run |

A turn that only reads code, runs `git log`, or edits only documentation and assets runs no checks. The outcome (*Completed*, *Not verified*, *Incomplete* or *Blocked*) shows in the answer's footer and on the recovery card.

## Iteration limit and stopping

A turn allows up to 40 model and tool round trips. Subagents get 25. While a recovery is active, self-healing may add up to 16 more (`localpilot.healing.extraSteps`), and with self-healing on, a run stopped by a limit ends with a root-cause report and the next action instead of a bare error.

A run also stops when it keeps failing. After 6 steps in a row in which every tool call failed, or a tool call had to be sent back because it did not parse, the chat shows *LocalPilot ran into 6 errors in a row and stopped* with the latest error. Send a message to guide the agent and it continues normally. Any successful tool call resets the count. A step you deny at a prompt is not counted; a call refused by a `never` setting, the organization's policy or a non-interactive `localpilot -p` run is. Change the limit with `localpilot.maxConsecutiveMistakes` (`0` = no limit).

When a reply stops at the output limit (`localpilot.maxOutputTokens`), LocalPilot recovers on its own. A tool call cut off mid-arguments is not run: the model is asked to resend it more concisely, splitting a large `write_file` into several `edit_file` calls, up to 3 times in a row. A text answer that was cut off is continued once and joined into one message.

Press **Stop** (<kbd>Esc</kbd> in the composer) at any time; tool calls in flight are cancelled. To hold an agent without cancelling it, use **Pause** (<kbd>⌥Esc</kbd>). See [Pause, steer and stop]({{ '/docs/parallel-agents/#pause-steer-and-stop' | relative_url }}).
