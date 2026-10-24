---
title: Parallel agents & change review
description: Run many agents at once, watch them in the Agents panel, and keep or undo what each one did.
permalink: /docs/parallel-agents/
---

## Every chat is an agent

Each LocalPilot session runs independently with its own context window, model and mode. Start another chat while one is still working — both stream at the same time.

## Chat tabs

The bar at the top of the chat is a browser-style tab strip — **one tab per agent**, in a stable order (pinned first, then creation order) so nothing jumps around while agents start and finish. The state of every agent is visible in the tab itself:

| Indicator | Meaning |
|---|---|
| Underlined, highlighted tab | The chat you are looking at |
| Shimmering title | You clicked the tab and its chat is loading |
| Breathing orange dot · ■ | Agent running — ■ (shown on the active or hovered tab) stops it without leaving the current tab |
| Green dot · bold title | Finished while you were in another tab — new results to read |
| Pulsing ⚠ | Waiting for your approval (the prompt is also shown in the current tab with a link) |
| Pin | Pinned: always first, never closed by "Close other tabs" or retention |

- **✕** closes a tab (the chat stays in **All chats**); middle-click or <kbd>Delete</kbd> on a focused tab does the same. Closing the active tab moves to the neighbour.
- **Double-click** (or <kbd>F2</kbd>) renames inline. **Right-click** for Rename · Pin · Fork · Export · Pause / Resume · Stop / Clear messages · Close · Delete.
- Agents working in *other* tabs appear in a strip under the tab bar with their current step; click to switch, ⏸ to pause / resume, ■ to stop.
- Keyboard: <kbd>Alt↑</kbd>/<kbd>Alt↓</kbd> cycle tabs, <kbd>Alt1…9</kbd> jump, <kbd>←</kbd>/<kbd>→</kbd> move between focused tabs.
- **Several at once:** ⌘/Ctrl-click or Shift-click to select tabs, then ✕ / <kbd>Delete</kbd> / right-click → *Close N selected*, *Stop and close all* or *Delete selected chats*. Right-click any tab for *Close other tabs*, *Close tabs to the right*, *Close finished tabs*, *Stop and close* and *Stop all agents*.
- **Isolation:** every tab keeps its own draft, attachments, scroll position and status line; every agent has its own context window, abort switch, tool cache and model. The model is shown in the tab tooltip and the background strip. Two chats using the same local model are served one at a time by the server — the waiting chat shows *Waiting for <model> — busy with N other chats…* instead of a silent stall.
- Open tabs persist when the view is hidden and restored; at most 12 are shown — the rest live under **+N** / **All chats**.

## Multitask: several agents at once

The simplest way is the **Multitask mode** in the composer: describe what you want and the agent splits it across background workers itself — see [Agent modes → Multitask](/docs/agent-modes/#multitask). The launcher below is for when *you* want to decide the split or try one task on several models.

Press the clock icon → **Multitask…** (or **Command Palette → LocalPilot: Run Tasks in Parallel…**, <kbd>⌘⇧⌥P</kbd>). The launcher is built so you do not have to think in prompts:

- **Split the work** — one row per task; each becomes its own agent in its own tab, all running at once. Press <kbd>Enter</kbd> for another row, paste a list to fill several, <kbd>⌘Enter</kbd> to start.
- **Try several models** — the same task runs on every model you tick (2–8), each agent isolated; when they finish you **Compare results** and keep the one you like.
- **Ideas for this project** — ready-made tasks worked out from your workspace right now: the errors VS Code shows, your uncommitted changes, missing README or tests, TODO notes, dependencies, plus your recent prompts. Click one to add it. **More ideas** asks the model for suggestions tailored to this codebase.
- **Autocomplete** — start typing and matching ideas and recent prompts appear; <kbd>Tab</kbd> accepts.
- The footer says in plain words what will happen ("3 agents will start, each in its own copy of your project").

From the CLI: `localpilot --ide --parallel "a | b | c"`. When the last agent of a batch finishes, a notification offers **Review results** (or **Compare results** for Best of N), which lists each agent with its file counts and lets you apply its changes.

## Isolated worktrees

By default every agent chat works in its **own copy of the repository** — a git worktree under `~/.localpilot/worktrees/`, started from your checkout *including uncommitted work*. Several agents can therefore edit the same files at once without clobbering each other or the files you have open. While an agent works, the changes panel reads **N files changed in isolated copy**: click a file for a before/after diff, **Apply to workspace** to bring everything over as ordinary uncommitted edits (3-way merged if you changed the same lines meanwhile; conflicts are marked and listed), or **Discard** to throw the copy away. The **Agents** panel offers the same actions, plus *Open Agent's Worktree in New Window*.

Setup commands for new worktrees (installing dependencies, generating code) go in `.localpilot/worktrees.json`:

```json
{ "setup": ["npm ci"], "setup-unix": [], "setup-windows": [] }
```

`localpilot.worktrees.mode` chooses when to isolate: `always` (default), `parallel` (only agents started together) or `off` (edit the workspace directly). Outside a git repository agents always edit directly. Worktrees of deleted chats are removed automatically.

While an agent is busy you can still type: <kbd>⌘⇧Enter</kbd> (<kbd>Ctrl⇧Enter</kbd>) **sends the draft in a new tab**, and pressing <kbd>Enter</kbd> offers *Add to this agent* (queued and read at its next step), *Send in a new tab* or *Stop this agent first* instead of blocking.

## Pause, steer and stop

Every running agent has two buttons next to the composer: **Pause** (<kbd>⌥Esc</kbd>) and **Stop** (<kbd>Esc</kbd>).

- **Pause** is cooperative: the agent finishes the step it is in — the current model call or tool batch — then holds before the next one. The status line shows *Pausing after this step…* and then *Paused*; the tab shows a ⏸ glyph and the progress bar freezes. Press the button again (now **Resume**) to continue exactly where it left off.
- **While paused, type.** Anything you send is queued inline in the transcript (a *queued* row) and appended to the conversation when the agent resumes, so you can correct course — "use the existing helper instead", "skip the README" — without losing the work done so far. The same works while the agent is running: pick *Add to this agent* and the message is taken into account at the next step.
- **Stop** cancels the run; files already changed stay in the **changes** panel to keep or undo.
- **Subagents.** Pausing or stopping the main agent pauses or stops every subagent it spawned. Each lane of a parallel fan-out also has its own ⏸ / ■ on the right of its pill: pausing holds just that subagent; stopping ends it and the main agent carries on, receiving a *stopped by the user* report for that task instead of a failure.
- The same controls live in the tab's right-click menu, the background-agents strip, the **Agents** panel (running sessions and their subagents have inline Pause / Resume / Stop) and the Command Palette (*LocalPilot: Pause Agent*, *Resume Agent*, *Pause or Resume Agent*, *Pause All Agents*, *Resume All Agents*, *Stop Agent*, *Stop All Agents*).

## The Agents panel

Below the chat view (collapsed by default) — and still under the LocalPilot activity bar icon when the chat has been moved to the Secondary Side Bar or the Panel; its title bar has **Open Chat**:

- **Running** — live status line (`Running grep_search…`), inline **Stop**, badge with the count.
- **Idle** — recent sessions with mode, message count and changed-file count.
- Expand a session to see the **files it changed**; click a file for a side-by-side diff.
- Inline **Keep** / **Undo** on sessions and files; **Keep All / Undo All Agent Changes** in the title menu.

## Change review

Before an agent modifies a file, LocalPilot stores the original content. From then on:

- The **files changed** bar appears above the composer: expand it, click a file for a diff, hover for per-file Keep/Undo, or use **Undo all / Keep all**.
- Changed lines are highlighted in open editors.
- Undo restores the exact pre-agent content (new files are moved to the trash).
- Keeping simply forgets the snapshot — your normal Git workflow takes over.

Changes are tracked **per session**, so reverting one agent's work never touches another's.

## Reading the transcript

The agent's work is shown as a timeline of concise rows, one per step: **Read** `file`, lines a to b · **Searched** for `query` · **Edited** `file`, 2 other steps `+4 −2` · **Ran** `command` (with the exit code) · **Opened** `url`. Rows read in the present tense while in flight (*Reading…*, *Editing…*) and settle to the past tense. File chips are language-tagged and open the file on click; expanding a row shows the file excerpt, diff or terminal output. Reasoning is summarised to a one-line **Thought …** row. Subagents appear as `agent · task · model` pills with their own nested rows, folding into **Finished with N steps** and a collapsible report.

## Subagents inside a session

A single agent can also fan out: `run_subagent` runs one child, `run_parallel_subagents` runs several concurrently (bounded by `localpilot.parallel.maxConcurrency`). Children have fresh context windows and report back only their final message, keeping the parent's context small.

### Plans that execute themselves

For large tasks the agent **splits the work into checklist items first** (`manage_todos`). Every item can carry an `agent` (coder, tester, docs, explore…), a self-contained `prompt`, and `dependsOn` — the ids it needs finished first. One call to `run_todos_parallel` then executes the whole checklist in **dependency waves**:

1. every pending item whose prerequisites are done runs now, concurrently (up to `maxConcurrency`);
2. when a wave finishes, the items that were waiting on it start, with the prerequisites' reports attached to their brief;
3. an item whose prerequisite failed is skipped (and says why); a circular `dependsOn` is reported instead of deadlocking; items without an agent are left for the main agent.

Each item flips to *in progress* and then *done* in the Tasks panel, with the delegated agent and its `after 1, 2` dependencies shown on the item. The main agent only keeps the final integration (combined diagnostics/tests, summary).

**Plan mode → Agent mode.** A plan produced in Plan mode is already in this shape — each step has an agent, a complete brief and its dependencies. Switch to Agent mode and say *implement the plan* (or *go ahead*, *run the checklist*): LocalPilot makes `run_todos_parallel` the first step of that turn instead of relying on the model to remember it.

### Whole-workspace analysis

Repository-wide questions ("review the whole codebase", "where is the auth logic", "audit error handling") no longer read files one by one. The agent calls **`analyze_workspace`** first — a fast scan with no model call that returns languages and test locations per folder, manifest summaries (name, scripts, dependency counts) and a **balanced split of the repository into shards** sized for `maxConcurrency` — then fans out one `explore` or `reviewer` subagent per shard with `run_parallel_subagents` and merges the reports. Plan and Ask mode can do the same with read-only subagents.

Read-only subagents (`explore`, `clarifier`, `researcher`) are routed to a small, fast tool-capable model by default (`localpilot.routing.fast`), and implementing ones can be sent to a stronger coding model (`localpilot.routing.coding`). See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Parallel requests

Parallel subagents are only as parallel as the model server. **Ollama serves one request per model at a time by default** (`OLLAMA_NUM_PARALLEL` unset), so four subagents would queue behind each other — the status line shows *Waiting for <model> — queued behind N other requests…* and the first-token timeout grows with the queue so queued requests are not mistaken for stalls.

- When LocalPilot **starts Ollama itself** (automatic setup, *Start* in Settings → Models, the installer scripts) it sets `OLLAMA_NUM_PARALLEL` to `localpilot.parallel.maxConcurrency` (capped at 4).
- When LocalPilot notices requests queuing at a server, it says so once and offers **Restart Ollama with parallel slots** (also *LocalPilot: Restart Ollama with Parallel Request Slots* in the Command Palette). A systemd-managed Ollama on Linux needs `sudo systemctl edit ollama` → `Environment="OLLAMA_NUM_PARALLEL=4"` → `sudo systemctl restart ollama`; a remote server needs the variable set where it runs.
- Each slot keeps its own KV cache, so memory use grows with slots × `localpilot.contextWindow`. If a model becomes slow or spills to CPU after enabling slots, lower `maxConcurrency` (fewer slots) or the context window. Gemma 4's sliding-window attention keeps per-slot memory small, which is one reason it is the recommended local model.
- LM Studio, llama.cpp (`--parallel N`), vLLM and Docker Model Runner have their own concurrency settings; LocalPilot's detection and status messages work the same way with them.

## Limits

- `localpilot.parallel.maxConcurrency` (default 4) bounds concurrent tool calls and subagents per session, and is the number of Ollama slots LocalPilot asks for.
- `localpilot.parallel.maxSubagentDepth` (default 2) prevents runaway nesting.
- Your model server's own concurrency ultimately decides how many requests run truly simultaneously — see [Parallel requests](#parallel-requests).
