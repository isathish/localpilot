---
title: Chat experience (UX spec)
description: The design spec for LocalPilot's chat panel. It covers the modes, every screen and failure scenario with its status today, and the roadmap for building the rest.
permalink: /docs/chat-experience/
keywords: LocalPilot UX, chat panel design, agent run cards, file-by-file review, mode picker, failure handling, approvals
---

This page is the design spec for the LocalPilot chat panel. It is written for contributors and for users who want to know where the UI is heading. Each scenario has a **status** that describes the code today:

- **exists**: shipped and working.
- **partial**: some of it ships, and the gap is described.
- **missing**: not built yet.

It also has a **phase**, which says when the remaining work is planned (see [Roadmap](#roadmap)). If a row says *missing*, the feature is not in the extension yet. The rest of the docs only describe what ships.

The chat is a vanilla-JS webview. Markup lives in `src/ui/chatViewProvider.ts`, styles in `media/chat.css`, behaviour in `media/chat.js`, and the host side with its `ToWebview`/`FromWebview` message unions in `src/ui/chatController.ts`. Settings is a separate webview (`src/ui/settingsPanel.ts`, `media/settings.*`). Screenshots come from `scripts/ui-preview.html`, which keeps its own copy of the markup. The UI rules are in `.claude/skills/vscode-extension-ui/SKILL.md`.

## Principles

1. **VS Code native.** Use only `--vscode-*` theme tokens and the extension's own tokens built on them. Light, dark and high contrast all follow the VS Code theme, and there are no hard-coded colours. Prefer native surfaces where they fit: diff editor, merge editor, terminal, notifications, status bar, Keyboard Shortcuts editor.
2. **One accent.** The button/focus accent marks the single primary action in a view. Status uses the semantic tokens: error, warning, `--vscode-testing-icon*`, `--vscode-gitDecoration-*`.
3. **Fewer boxes.** Use rows, dividers and muted text, not nested cards. A run card is one strip with rows under it, not a stack of panels.
4. **Narrow first.** The panel is often 300–480 px wide. Every element has a defined form at 300, 360 and 480 px, driven by container queries (`@container`), not viewport media queries. Short panels (height under about 520 px) hide secondary text.
5. **Reliable execution is the product.** The differentiator is a run you can trust from start to finish. LocalPilot detects failures, retries what is transient, heals what it can, and asks a human when it should. Every failure the agent sees should be visible in the transcript, explained in one plain sentence, and come with the next action (retry, edit, skip, stop, restore, change model). Nothing should fail or fall back silently.
6. **Humans approve, and it is clear what they are approving.** Approval prompts say what will run, why LocalPilot asked (which policy applies), and how far an "always" reaches (this chat or this workspace).
7. **Accessible.** Everything works from the keyboard and has a visible focus. Icon-only buttons have an `aria-label`. Live regions announce run state. There are no inline handlers (CSP).
8. **Evolve, don't rewrite.** New UI reuses the existing pieces: `.step` rows, `.note`, `.work` strip, `errorBox`/`errorActions`, `openMenu`, `.pick` chips, the `.rec` recovery card and the Changes panel.

## Modes

### Core modes

The picker lists five core modes, ordered from least to most autonomous. "Chat" in the brief is **Ask**, and "Code" is **Agent**.

| Mode | Edits files | What it does | Backed by | Picker tag |
|---|---|---|---|---|
| Ask | No | Answers questions about the code, read-only | `MODES.ask`, read-only tool set | read-only |
| Agent | Yes | Edits files, runs commands, verifies the result | `MODES.agent`, full agent loop | edits files |
| Plan | No | Investigates and writes a plan you can build with one click | `MODES.plan`, plan card | read-only |
| Debug | Yes | Reproduces the problem, finds the cause, fixes it and verifies | `MODES.debug`, debug prompt in `src/agent/prompts.ts` | edits files |
| Multitask | Through workers | Splits the work across background workers that run in parallel | `MODES.multitask`, worker lanes | edits files |

Status: **exists**. `MODES` in `media/chat.js` is ordered Ask, Agent, Plan, Debug, Multitask, which is also the cycle order of the mode shortcut and `/mode`. The picker has the "Modes" group header, the read-only/edits-files tags and a footer hint for the switch shortcut. The details of each mode are in [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }}).

### Specialist modes ("More modes")

Specialists are **not** new host modes. Each one maps to a core mode (which decides permissions, so `WRITE_MODES` and the approval logic do not change) plus a built-in subagent prompt from `src/agent/builtinAgents.ts`. The session stores this in a new optional `session.specialist` field. When it is set, the host appends that agent's system prompt.

| Specialist | Base mode | Built-in agent | What it does | Icon |
|---|---|---|---|---|
| Architect | Plan | planner | Designs the change: modules, interfaces, risks, ordered steps | plan |
| Review | Ask | reviewer | Reviews uncommitted changes or a file and reports findings by severity | diff |
| Test | Agent | tester | Writes and runs tests, then fixes failures | check |
| Refactor | Agent | coder + behaviour-preserving preamble | Restructures code without changing what it does, and verifies with tests | edit |
| Explain | Ask | explore / docs | Walks through code, data flow and concepts | ask |
| Terminal | Agent | preamble: prefer `run_command`, show each command first | Shell-centred tasks with each command visible before it runs | term |
| Project | Ask | researcher / explore | Gives a project overview: structure, entry points, how to build and test | folder |

Status: **exists**. `SPECIALISTS` in `src/agent/builtinAgents.ts` (mirrored in `media/chat.js`) maps each specialist to its base mode and agent; `buildSystemPrompt` adds a "Specialist" section with the brief and the agent's playbook (a workspace agent file of the same name wins). `/mode <specialist>` works in the chat and the CLI.

### Picker layout

```
┌ Modes ─────────────────────────────┐
│ ? Ask        Answer questions   read-only   │
│ ▸ Agent      Edit, run, verify  edits files │ ✓
│ ☰ Plan       Plan first         read-only   │
│ ! Debug      Reproduce and fix  edits files │
│ ≡ Multitask  Parallel workers   edits files │
├ More modes ────────────────────────┤
│ Architect · Review · Test · Refactor        │
│ Explain · Terminal · Project                │
├────────────────────────────────────┤
│ Manage modes…              Mod+. to switch  │
└────────────────────────────────────┘
```

- The chip under the composer shows the specialist label when one is active (for example "Review"). Its tooltip names the base mode: "Review · runs in Ask (read-only)".
- `/mode review` and the other specialists appear in `/` completion.
- **Manage modes…** opens Settings → Skills & subagents.
- Narrow widths: the label stays visible down to about 330 px. Below that the chip shows only the icon, with an `aria-label` that names the mode.

## Screens and scenarios

Each section lists the layout, the states, the copy and the narrow-width rules, followed by a status table.

### 01 New conversation

```
┌──────────────────────────────────────┐
│ What are we building today?          │
│ Ask a question, or describe a task:  │
│ LocalPilot plans it, edits files,    │
│ runs commands and checks the result. │
│ Agent mode: edits files… · change    │
│                                      │
│ ▢ my-project  ⎇ main  ● Ready        │  ← ctx strip
│                                      │
│ START                                │
│ ✦ Build a feature            Agent   │
│ ! Fix a bug              3 errors    │
│ ◎ Create an agent            Skill   │
│ ⌕ Understand codebase          Ask   │
│ FOR dice.py                          │
│ Explain dice.py                Ask   │
│ Write tests for dice.py      Agent   │
│                                      │
│ RECENT                Search all chats│
│ ▸ Fix flaky upload test       2h     │
│ ? How does routing work       1d     │
├──────────────────────────────────────┤
│ Ask anything, or describe a task…    │
│ @ file · # codebase · / command      │
│ [▸ Agent] [Ollama · Auto]       [↑]  │
│ AI can make mistakes. Review         │
│ generated changes before applying.   │
└──────────────────────────────────────┘
```

States of the ctx strip:

| State | Copy | Token |
|---|---|---|
| Ready | `● Ready` | `--ok` dot |
| Discovering | `Finding models…` | spinner |
| No model | `No model, set one up` (opens setup) | warning |
| Indexing | `Indexing 1,240 files…` | spinner |
| Offline | `Offline · local models only` (or `Offline · no local model`), from the host's `connectivity` message | muted |
| No folder | `No folder open · chat only` + **Open folder…** | muted |
| Needs you | `1 task needs you · Review` (pending recovery interventions) | warning |

Behaviour:

- **Build a feature** switches to Agent and prefills `Build ` without sending. **Fix a bug** switches to Debug and prefills `Fix: `. Its tag shows the diagnostics count when there are errors. **Create an agent** starts the skill/agent creation flow. **Understand codebase** sends the overview prompt in Ask.
- The file-aware picks ("For dice.py") keep today's behaviour and send at once.
- Recent rows use the chat's mode icon, or a live dot when the chat is running.
- The model chip reads `<provider> · <model|Auto>`. With Auto it shows the resolved model, for example `Auto · qwen2.5-coder`, with the tooltip "Auto picks a model per task; now: …". A dot marks the model as local or cloud.
- Narrow widths: at 420 px and wider the Start group is a 2×2 grid, and a list below that. Under 360 px the model chip drops the provider. On short panels the hero subtitle and the disclaimer are hidden. The hint row hides once the input has text.

| Element | Status | Phase |
|---|---|---|
| Heading + subtitle | exists | — |
| Intent starters (Build / Fix / Create agent / Understand) | exists (Create agent runs `/agent new`) | — |
| Recent conversations | exists (5 rows, 3 on short panels, mode icons, Search all chats) | — |
| Model chip `provider · Auto` | exists | — |
| Workspace + status line | exists (multi-root: the folder is a picker; Indexing and the large-repo note come from the file index scan) | — |
| Placeholder + hint row, `#codebase` | exists (typing `#` opens the context variables; the hint row's `#` attaches `#codebase`) | — |
| Footer disclaimer | exists | — |
| Mode line under the hero | exists | — |
| Pending interventions row | exists (as the strip's "N tasks need you · Review" status) | — |

### 02 Code generation

Code blocks have a header row with the language or a file path link, the line count, **Copy**, **Insert at cursor** and **Apply** (or **Create**). Linked file paths open the file. The block's file comes from the fence info (```` ```ts src/a.ts ````, `title=`), else from a path standing alone on the line before the fence (`` `src/a.ts`: ``, `**src/a.ts**`, `### src/a.ts`, ``Add this to `src/a.ts`:``), else from a first-line comment that is only a path (`// src/a.ts`).

| Scenario | Status | Phase | Notes |
|---|---|---|---|
| Highlighting, copy, insert | exists | — | Insert and Apply are icon-only buttons with an `aria-label` |
| Apply changes | exists | — | **Apply** (aria-label "Apply to dice.py"; a block with no file targets the active editor) opens the proposed-edit diff and a non-modal "Replace … with this code block?" prompt, then writes through `ChangeTracker.beforeChange`, so the file joins the review queue (**M**) and the latest message's checkpoint. `planCodeApply` (`src/agent/codeApplyPlan.ts`): a block that looks like the whole file replaces it; a fragment replaces the region its unique first line anchors (closing line at the same depth, or the indented block); otherwise "Merge into dice.py" offers **Ask the agent to merge it** (a steer or a new turn; write modes only) or **Replace the whole file**. `diffPreview: off` skips the preview and prompt |
| File creation from a block | exists | — | When `pathsExist` says the block's file does not exist, the button becomes **Create** (aria-label "Create src/new.ts"). An input box confirms (or changes) the path inside the workspace, the file is created through the tracker and shows in review as **A** |
| Per-edit cards in the run | exists | — | Edit cards have a path, ±stat, an inline diff, **Diff** (opens the file's review diff) and Open, and a state tag from the review queue (Accepted / Rejected, "edited by you") |
| Generation failure (edit not applied) | partial | 3 | Raw tool errors show as-is, with the step's Retry / Edit & retry / Skip bar. Target: one plain sentence ("The text to replace was not found in dice.py; the file probably changed since it was read"), raw output under Details, "retried ✓" when a later edit succeeds, and **Retry this edit** at the end of the turn |

### 03 Agent execution (run card)

```
✓ Worked for 1m 02s · 6 steps · 2 files edited · 1 task failed
  ⌕ Explored 4 files
  ✎ Edited dice.py                     +12 −3   [Diff] [Open]
  ▸ Ran python -m pytest -q        6 passed · 1 failed
  ✕ edit_file utils.py: text not found          4s
     [Retry] [Edit & retry] [Skip] [Stop run]
  ◷ run_command npm install       Needs approval · Review
```

States of the work strip: running (spinner, elapsed time, tok/s), **paused** (pause icon, "Paused after step 6", frozen timer, **Resume**), **waiting** (a step needs approval), **stopped by you** (muted stop icon, "Stopped by you after 1m 02s" with **Continue** and **Discard changes**), **failed** (error colour, which also applies when a task failed), **done**.

| Scenario | Status | Phase | Change |
|---|---|---|---|
| Task breakdown (Tasks panel, plan card, work strip) | exists | — | — |
| Link todos to the steps that ran them, show a failed/skipped todo with its reason | exists (links are live-only: rows replayed from the transcript carry no todo id) | — | `todoId` on `tool_start`, `dataset.todo` on rows, click a todo to scroll to its step, done/failed/skipped glyphs, "· 1 task failed" in the strip |
| Elapsed time on running steps | exists | — | `tickWork` updates running rows. After 30 s a row turns `slow` (warning colour) with the tooltip "Still running; Esc stops the run" |
| Cancellation | exists | — | A stop by the user settles as "Stopped by you", not as a failure. **Continue** / **Discard changes**. Cancelled rows use the neutral denied style |
| Pause / resume | exists | — | The work strip shows the paused state and the timer freezes |
| Approvals: allow once, deny, deny with reason, allow in chat | exists | — | Keys Y / N / Shift+N / A |
| Approvals: always allow in workspace, edit command before allowing, tie to waiting row, explain why it asked | exists | — | Split menu "Always allow in this workspace…" (hidden for dangerous commands; kept in the extension's workspace state, because the approval settings are User-only and VS Code refuses a workspace write; `src/agent/workspaceApprovals.ts`). **Edit** turns the command into a textarea (`editedArgs`). The waiting row reads "Needs approval · Review". Footer: "Asked because Terminal commands = Ask · Change in Settings" |
| Saved allow/block command patterns | exists | — | Stored as the `Bash(<pattern>)` permission rules the gate already reads (`src/agent/commandRules.ts`), not new `approvals.*` keys: Workspace in `.localpilot/settings.local.json` (added to `.git/info/exclude`), User in `~/.localpilot/settings.json`. The split menu adds "Always allow "npm test"" and "Always block "npm test"" for one simple command (a destructive one gets a block-only chevron). Settings → Agent & approvals → **Command rules** lists Allow / Ask / Block rules with edit, delete and add; rules in other files are read-only with **Open** |
| Tool failure: retry, edit arguments, skip, abort | exists | — | `.tool-fail` bar on failed rows. Posts `toolFailureAction`, which the host turns into a steer while running or a new turn when idle |
| Automatic retries (transient model errors) | exists | — | One retry row per turn, updated in place: "Retrying 2/3 in 4s: connection dropped", then "Recovered on attempt 2" |
| Self-healing recovery card | exists | — | Patch rows open their diff, failed check chips expand to show the failure excerpt, **Details** links to the recovery dashboard |
| Parallel workers | exists | — | Retry on a failed lane, live "1 failed" in the header |
| Steering vs queueing | exists | — | While a run lasts, a hint row under the message box (`#runHint`): "↩ adds to this run · ⌥↩ sends after it · More…". Enter steers the run directly (no menu), Alt+Enter queues the draft for after the turn, **More…** opens the send choices (new tab, stop first). Each part is a button for the same action; paused runs read "read when it resumes"; narrow panels show "steer · after" |
| Run-level error box | exists | — | Title row by error kind ("Model stopped responding", "Out of credits", "Prompt too large"). The host sends `kind` instead of the webview guessing it from text. **Copy error**. The mistake-limit box gets **Continue with guidance**, **Restore checkpoint** and **Show log** |

### 04 Terminal execution

```
▸ Ran npm test                       exit 1
  ~/pkg/api                     [Copy] [Rerun] [Open in terminal]
  │ FAIL src/upload.test.ts
  │ … Show all 84 lines
  Exit 1 · the agent will read the output and try a fix
```

| Scenario | Status | Phase | Change |
|---|---|---|---|
| Command preview, live output (last 5 lines), exit chip, ANSI colour, detach, stop | exists | — | — |
| Permission approval | exists | — | Syntax-highlight the command in the approval prompt and allow editing it (see 03) |
| cwd chip, next-step line after a non-zero exit | exists | — | cwd shown when it is not the workspace root. "Exit 1 · the agent will read the output and try a fix" or "Exit 1 · run stopped" |
| Rerun / open in terminal | exists (Rerun asks the agent, so the approval rules apply) | — | `rerunCommand` goes through the same tool and approval gate. `openInTerminal` sends the text without running it |
| Errors | exists | — | Failed commands expand automatically |

### 05 Diff and review

The Changes panel above the composer becomes a **review queue**:

```
5 files changed · 2 reviewed  ▬▬▬▬░░░░░   [Review] [Reject all] [Accept all]
  M dice.py           +12 −3      ✓ accepted
  A tests/test_dice.py +40         [Accept] [Reject]
  M utils.py          +2 −2      ↺ reverted  [Restore edits]
  D old_helpers.py    −58          [Accept] [Reject]
```

- **Review** opens the first unreviewed file in the side-by-side diff. The diff title reads `dice.py: original ↔ LocalPilot (editable)`.
- The diff editor title bar gets **Accept file** (Mod+Enter), **Reject file**, **Next / Previous changed file** (Alt+F5 / Shift+Alt+F5). Accepting or rejecting moves to the next unreviewed file. When the queue is empty the toast reads "All 5 files reviewed: 4 accepted, 1 rejected" with **Undo**.
- Reviewed rows stay in the list, dimmed, until the next turn or **Clear reviewed**. Rejected rows keep **Restore edits** for as long as the redo buffer holds them. After that the tooltip reads "No longer kept: use Restore checkpoint on the message".
- Deleted files open their original read-only.
- Keyboard on the list: j/k move, a accepts, r rejects, Enter opens the diff.
- The "N files" chip under an answer starts the same queue, scoped to that turn. The one-tab multi-diff becomes a secondary action.
- Narrow widths: under 360 px the per-row Accept/Reject buttons collapse to icon buttons with `aria-label`s, and the meter takes the full width under the header.

| Scenario | Status | Phase |
|---|---|---|
| Per-file Accept/Reject, Review all (multi-diff), Accept/Reject all, Undo toast | exists | — |
| Reviewed state, progress, next/previous, accepted rows that stay listed | exists (reviewed rows stay dimmed until the next turn or **Clear reviewed**) | — |
| Accept/reject inside the diff editor | exists (`localpilot.review.acceptFile` / `rejectFile` / `nextFile` / `prevFile` in the diff title bar, Mod+Enter, Alt+F5) | — |
| Turn chip opens the review queue | exists (scoped to that turn; the multi-diff is the secondary action) | — |
| Restore after reject | exists (rejected rows stay in the queue with **Restore edits** while the redo buffer holds them; checkpoints after that) | — |
| Edit before accepting ("edited by you" tag) | exists (typing in the file while its change is pending, outside the 3 s after an agent or restore write, sets `userEdited`; the queue row and the edit card say "edited by you") | — |
| Isolated worktree / Multitask per-file apply | exists (per-row **Apply** / **Discard**, keys a / r, **Apply all** / **Discard all** in the head; blocked while the agent edits the copy) | — |
| Git conflicts after a worktree apply (C rows, banner, merge editor) | exists (C rows first with **Resolve** → merge editor; the head and its narrow form count the conflicts; per-file applies add to the list) | — |
| Git conflict during a run (file list, per-file merge editor, Resume after resolving) | exists | — |

### 06 Debug and test

| Scenario | Status | Phase | Change |
|---|---|---|---|
| Debug mode, fix/explain diagnostics and terminal commands | exists | — | — |
| Test result summary in the run | exists | — | Host attaches `tests:{passed,failed,skipped,failures[]}` from the healing parsers. The row shows "6 passed · 1 failed" in `--vscode-testing-icon*` colours. Expanding lists the failing tests first with path links. "Self-healing is fixing this" links to the recovery card |
| Re-run failed tests / Fix failures | exists | — | Buttons on the test summary row |
| Automatic retry of failing tests | exists (self-healing) | — | Failure excerpts on check chips, patch diffs |
| Stack-trace linking in code blocks, structured debug report, debug starters | partial (the three debug starters are not built) | 3 | `linkify` turns frames into `file:line` links, absolute and Windows paths included (Node, Python, Java, .NET, Go, Rust, Ruby), in answers and tool output; a fenced trace renders as a *stack trace* block without Apply, and frames `pathsExist` cannot confirm become plain text. Debug mode ends with `## Debug report` (Symptom, Root cause, Fix, Verified), drawn as a card with *Verified* / *Not verified*. Starters still to add: "Fix current problems (N)", "Explain last terminal error", "Paste a stack trace" |
| Test specialist mode | exists | — | See [Specialist modes](#specialist-modes-more-modes) |

### Advanced scenarios

| Scenario | Status | Phase | Target behaviour and copy |
|---|---|---|---|
| Local LLM slow | exists | — | Wait text moves from the footer into the transcript: "Loading gemma4:12b into memory · 24s", muted "times out at 3:00". After 20 s: **Keep waiting** (another full limit for the request in flight, `keepWaiting`), **Use <first fallback model>** (when `routing.fallbackModels` has one that is up), **Switch model**, **Stop**. The host emits a structured `waiting` event. `localpilot.firstTokenTimeoutSeconds` (default 180, `0` = no limit) sets the limit |
| Model unavailable (fallback) | exists | — | A `route` event renders a note at the top of the turn: "ollama/gemma4 is not answering. This turn uses Claude Sonnet." **Use for this chat**, **Retry with gemma4**, cloud badge, warning dot on the chip. `localpilot.routing.fallbackModels` (Settings → Models → Routing → **Fallback order**) is tried in order before the best fit; a local model falls back to a cloud one only when that cloud model is listed, which replaces a separate "Never fall back to a cloud model" switch |
| Tool failure | exists | — | Retry / Edit & retry / Skip / Stop run (see 03) |
| Code generation failure | partial | 3 | Plain-language edit errors, Retry this edit (see 02) |
| Multiple files modified | exists | — | Review queue (see 05) |
| Context limit | partial (the expandable compaction note and the breakdown of what fills the context exist; a reply cut off at the output limit shows a status line, not a "continued (output limit reached)" divider in the transcript) | 3 | Context ring, compact, "Compact and retry", expandable compaction note, breakdown of what fills the context. To add: the divider |
| Large codebase | partial (no semantic index: there is no embedding backend, and `#codebase` and the status bar tooltip say so) | 3 | Index status in the ctx strip, the context menu and the status bar: "Indexing 1,240 files… 38%", "Large repo: 5,000 of 12,400 files listed". A semantic index is separate backend work |
| Approval | exists | — | See 03 |
| Tests failing | exists | — | Test summary, Re-run failed, Fix failures, self-healing link |
| Agent interrupted | exists | — | Only self-healing recoveries can resume today. Target: a running flag that survives a reload. The "Run interrupted" card reads "Stopped during step 7 · Tasks 3/6 · 2 files edited" with **Resume**, **Restore checkpoint**, **Dismiss** |
| Network disconnected | exists | — | `ConnectivityMonitor` (`src/providers/connectivity.ts`: interfaces, then the cloud providers' DNS, two misses in a row) sends `connectivity`. Banner under the tabs "Offline: using local models only" (or "no local model available" with **Models**), **Check again**, then "Back online" for 5 s; status-bar item `$(debug-disconnect) Offline` (`localpilot.checkConnection`). While offline the router skips cloud models when a local one exists, so a cloud chat falls back per turn with the usual route note (no separate **Use local model** button is needed) |
| Long-running | exists | — | Tasks n/m and elapsed time on background rows. Native notifications with **Open chat** (`localpilot.notifications`, `whenHidden` by default): a run longer than 20 s finished (with its duration), any run that failed or needs attention, and one notice per run when it waits for an approval or a question |
| Git conflicts | exists | — | See 05 |
| No workspace | exists | — | "No folder open · chat only" + **Open folder…**, chat-only starters, Ask by default, Agent/Debug/Multitask (and their specialists) marked "Needs a folder" |
| Multiple workspaces | exists | — | Folder picker in the ctx strip and a folder chip in the composer; the chat's folder (`Session.folder`) drives tools, @ search, git, checkpoints and hooks and is locked after the first message. The history's folder menu (multi-root only) shows the chats of one folder; a chat that never picked one counts in the first folder (`HistoryQuery.folder` / `defaultFolder`) |

### Additional screens

Most management screens already exist in Settings. The work is mostly linking them from chat.

| Screen | Status | Phase | Notes |
|---|---|---|---|
| History + search | exists | — | Date groups, full-text search, sorts, pin, rename, multi-select, and a filter row: mode chips (only the modes the history holds, with counts; a specialist counts while it applies, `historyModeKey`) and, in a multi-root workspace, a folder menu. Filters carry over between openings like the sort, and the host applies them to the paged list (`HistoryQuery.mode`, `folder`) |
| Model / provider management | exists | — | Health badges per provider (*reachable* · latency, *slow*, *down*, *no key*) on Settings cards and as tags on the model picker's provider headings, from the registry's own discovery rounds (`providerHealth()`, `src/providers/health.ts`); a provider that is down or has no key gets a picker row that opens its card |
| Local model download / config | exists | — | Download progress on the chat model chip, tok/s badge. colibri: Settings → Providers shows the free space under **Models folder** (amber when even the smallest model would not fit), and **Start colibri** runs a disk-space preflight (`diskPreflight`) before any download: "glm-5.2 needs about 431 GB (a 429 GB download plus 2 GB to work in), but the disk that holds ~/colibri-models has 120 GB free: 311 GB short." with **Choose another folder…** (saved as `colibri.modelsDir`), **Use <smaller model>**, **Pick another model…** and **Download anyway**. A model already in the folder is not checked |
| MCP server management | exists | — | Timeout field per server. Per-tool *Default* / **Allow** / **Ask** / **Block** on a connected server's Tools tab (`localpilot.mcp.toolApprovals`, User only), honoured by the approval gate (`approvalModeFor`); Block refuses before any prompt, Ask overrides the server's `autoApprove` list |
| Agent and skill marketplace | partial (no subagent on/off switch: subagents have no disabled state yet) | 3 | Settings → **Marketplace** (also ⋯ → **Marketplace…**): one search over skills (the skill registry), MCP servers (bundled catalog, MCP registry on request), plugins (the configured marketplaces, `pluginCatalog`) and subagents. Kind chips with counts and a Show filter (installed or not). Rows say where each comes from and whether it is installed (and for whom); plugin rows say what they add when the files are in the marketplace checkout; subagents carry a "used by Review" badge for the specialist modes that follow them. Install reuses each kind's own flow |
| Prompt library | exists | — | A sheet over the chat (⋯ → **Prompt library…**, `/prompts [words]`): search, scope chips (All, Workspace, You, Plugins), click or Enter inserts the prompt into the message box, edit and delete (host asks first) on editable rows, Open file on all. **Save as prompt…** (⋯ menu, and the bookmark on a sent message) names it from its first words and saves to `.localpilot/commands/<name>.md` (workspace) or `~/.localpilot/commands` (just me); a taken name offers **Replace it**. Every prompt is a custom command, so it also runs as `/name`; front matter the library does not edit (`allowed-tools`, `argument-hint`, `model`) is kept. The welcome screen lists the first three under **Saved prompts** |
| Context and token usage | exists | — | Context ring + hover card with a breakdown (system, rules, memory, tools, MCP tools, conversation, files, tool output, summaries) and fix links; `/context` prints it |
| Execution logs and tracing | partial (no Dashboard → Runs list yet; the CLI records no traces) | 3 | Logs + OTLP export, and a local per-run trace: `RunTraceRecorder` (`src/telemetry/runTrace.ts`) builds it from the run's events and approvals, `TraceStore` keeps the last 20 per chat. **Trace** in the answer footer opens a sheet: model calls (first-token time), tools, retries, fallbacks, approvals, hooks and subagent rows with durations and a timeline bar, filters (All, Model calls, Tools, Problems) and **Export JSON** |
| Permissions and security | partial | 3 | Presets, per-kind Ask/Allow/Block, command rules and this workspace's "always allow" grants (with **Ask again**) exist. To add: the per-chat grants of every open chat in one list |
| Settings | exists | — | New settings get `FIELD_INDEX` entries. Failure actions deep-link to a specific field |
| Keyboard shortcuts | exists | — | Settings → **Keyboard shortcuts** and `/keys`, both built from `shortcutGroups()` (`src/ui/shortcuts.ts`: the manifest's keybindings plus the chat's fixed keys), with a macOS / Windows switch. **Change…** opens VS Code's Keyboard Shortcuts editor filtered to the command. Also on the [Keyboard shortcuts]({{ '/docs/shortcuts/' | relative_url }}) docs page |
| Error recovery dashboard | exists | — | The Settings dashboard has 8 tabs with counts; **Details** on recovery cards opens it, and the welcome strip shows "N tasks need you" for pending interventions |

## Roadmap

### Phase 1 (shipped in 1.5.8 and 1.5.9)

**A. Welcome screen and mode picker.** Hero, intent starters, ctx strip with workspace/branch/status, model chip `provider · Auto`, hint row, disclaimer, mode line, reordered modes with tags, the "More modes" specialists, Manage modes…, pending interventions row, Search all chats.

**B. Agent-run cards and failure handling.** Tool-failure actions, rerun and open in terminal, a "Stopped by you" state with Continue, paused state in the strip, elapsed time on running steps, a structured slow-model wait, visible model fallback, in-place retry note, typed error box, mistake-limit actions, a "Run interrupted" card for any run, approval upgrades (workspace-wide always allow, edit command, waiting row, policy footer), todo↔step links, test result summaries, recovery card diffs and excerpts, conflict file list, dashboard and settings-field deep links, worker lane retry.

**C. File-by-file review.** Review queue with progress and per-file states, accept/reject/next in the diff editor, Diff button and state tags on edit cards, the turn chip opens the queue, Restore edits on rejected rows, deleted files viewable.

### Phase 2 (shipped, not yet released)

- **Workspace and context:** no-workspace chats (Ask by default, write modes marked "Needs a folder"), multi-root chats with a per-chat folder, `#codebase` and the `#` context menu, the context breakdown (ring card and `/context`), compaction details, index status in the strip, the menus and the status bar (`localpilot.rebuildFileIndex`).
- **Code blocks and changes:** Apply through the proposed-edit diff and the ChangeTracker, Create a file from a block, per-file Apply / Discard for isolated worktrees, the "edited by you" tag.
- **Runs:** the debug report card and stack-trace links, long-run and waiting notifications, the steer/queue hint, the offline banner and status bar item (`localpilot.checkConnection`), per-run traces with export.
- **Settings and safety:** saved command allow/block rules, a working "Always allow in this workspace", per-tool MCP approval (`localpilot.mcp.toolApprovals`), fallback order (`localpilot.routing.fallbackModels`) and first-token timeout (`localpilot.firstTokenTimeoutSeconds`), provider health badges, the keyboard shortcut table and `/keys`.
- **Library and marketplace:** the prompt library and `/prompts`, Settings → Marketplace.
- **Phase 3 items done early:** history mode and folder filters, the colibri disk-space preflight.

### Phase 3 (what is left)

- Edit failures in plain language with **Retry this edit** at the end of the turn (02, Advanced scenarios).
- Debug starters: "Fix current problems (N)", "Explain last terminal error", "Paste a stack trace" (06).
- A "continued (output limit reached)" divider in the transcript (Context limit).
- A semantic index for large repositories, once an embedding backend exists.
- A Dashboard → Runs list of stored traces, and traces and offline detection in the CLI.
- An on/off switch for subagents in the Marketplace.
- One list of the per-chat approval grants of every open chat (Permissions and security).
- Per-file worktree Apply in the Agents view and `localpilot.applyWorktree` (they still apply everything at once).
- Command palette entries for the prompt library and the Marketplace.
- Trying the phase 2 native surfaces in a real VS Code window: status bar items, notifications, the merge editor, the Keyboard Shortcuts filter, Add folder to workspace, the trace save dialog and the colibri dialogs.
