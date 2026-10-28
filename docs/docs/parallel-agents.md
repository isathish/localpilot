---
title: Parallel agents & change review
description: Run several agents at once in isolated git worktrees, compare models with Best of N, pause and steer agents, and review every change.
permalink: /docs/parallel-agents/
---

## Every chat is an agent

Each chat runs independently, with its own context window, model and mode. Start another chat while one is working, and both stream at the same time.

How many requests really run at once depends on your model server. See [Parallel requests](#parallel-requests).

## Chat tabs

The bar at the top of the chat has one tab per agent. Tabs keep a stable order (pinned first, then creation order), so nothing jumps while agents start and finish.

| Indicator | Meaning |
|---|---|
| Underlined, highlighted tab | The chat you are looking at |
| Shimmering title | The chat is loading after you clicked it |
| Breathing orange dot, ■ | Agent running. ■ (on the active or hovered tab) stops it |
| Green dot, bold title | Finished while you were in another tab |
| Pulsing warning icon | Waiting for your approval. The prompt also shows in the current tab |
| ⏸ | Paused |
| Pin | Pinned: always first, never closed by bulk actions or retention |

Working with tabs:

- **Close:** ✕, middle-click or <kbd>Delete</kbd> on a focused tab. The chat stays in **All chats**.
- **Rename:** double-click or <kbd>F2</kbd>.
- **Right-click:** Rename, Pin, Fork, Export, Pause / Resume, Stop, Clear messages, Close, Delete, and bulk actions (*Close other tabs*, *Close tabs to the right*, *Close finished tabs*, *Stop all agents*).
- **Select several:** ⌘/Ctrl-click or Shift-click, then close, stop or delete them together.
- **Keyboard:** <kbd>Alt↑</kbd> / <kbd>Alt↓</kbd> cycle tabs, <kbd>Alt1…9</kbd> jump, <kbd>←</kbd> / <kbd>→</kbd> move between focused tabs.
- **Background strip:** agents running in other tabs appear under the tab bar with their current step. Click to switch, ⏸ to pause or resume, ■ to stop.

Each tab keeps its own draft, attachments, scroll position and status line. Up to 12 tabs are shown; the rest are under **+N** / **All chats**.

## Starting several agents

There are three ways:

- **Multitask mode.** Describe the outcome and the agent splits it across background workers. See [Agent modes → Multitask]({{ '/docs/agent-modes/#multitask' | relative_url }}).
- **Run Tasks in Parallel** (<kbd>⌘⇧⌥P</kbd>, or the clock icon → **Multitask…**). You decide the split: one row per task, each becomes its own agent and tab.
- **Best of N.** One task on several models. See [Best of N](#best-of-n).

In the launcher:

1. Choose **Split the work** or **Try several models**.
2. Type a task per row. <kbd>Enter</kbd> adds a row, pasting a list fills several rows, <kbd>Tab</kbd> accepts an autocomplete suggestion.
3. Optionally click an idea from **Ideas for this project**. These come from your workspace: current errors, uncommitted changes, missing README or tests, TODO notes, dependencies and recent prompts. **More ideas** asks the model for suggestions.
4. Check the footer, which says what will happen (for example *3 agents will start, each in its own copy of your project*).
5. Press <kbd>⌘Enter</kbd> to start.

From the CLI: `localpilot --ide --parallel "a | b | c"`.

When the last agent of a batch finishes, a notification offers **Review results**. It lists each agent with its changed files and lets you apply its changes.

![The Multitask launcher on Split the work: three tasks, one per row, with Add another task and ideas for this project]({{ '/assets/screenshots/multitask-launcher.png' | relative_url }})

## Best of N

Best of N runs the same task on 2 to 8 models at once, so you can keep the best result.

1. Open the launcher and choose **Try several models**, or run *LocalPilot: Best of N: Run One Task on Several Models…*.
2. Enter the task and tick at least two models. The command lists only models with tool calling.
3. Wait for the agents to finish. Each runs in its own tab.
4. Click **Compare results** in the notification, or run *LocalPilot: Compare Best-of-N Results…*.
5. Pick a result and choose **Apply this result** or **Apply and discard the others**.

Each Best-of-N agent works in its own worktree when `localpilot.worktrees.mode` is `always` or `parallel`. With `off`, or outside a git repository, all agents would edit the same files. Use Best of N in a git repository with worktrees on.

<p><img src="{{ '/assets/screenshots/best-of-n-launcher.png' | relative_url }}" alt="Try several models: one task, with gpt-oss:20b and qwen3:14b selected" width="420"></p>

![Compare Best-of-N Results: gpt-oss:20b changed 1 file (+3) and passed the tests; qwen3:14b produced nothing and timed out. Pick one to apply it]({{ '/assets/screenshots/best-of-n-compare.png' | relative_url }})

The comparison above is a real run on one laptop: with both models loaded at once, qwen3:14b never got its first token and was stopped after 180 s. Best of N is most useful when the models fit in memory together.

## Isolated worktrees

In a git repository each agent chat works in its own copy of the repository by default. The copy is a git worktree under `~/.localpilot/worktrees/` (change with `localpilot.worktrees.location`). It starts from your checkout, including uncommitted and untracked files. Several agents can edit the same files without overwriting each other or the files you have open.

While an agent works, the changes bar reads *N files changed in isolated copy*. From there:

- Click a file for a before/after diff.
- **Apply to workspace** brings the changes into your folder as ordinary uncommitted edits. If you changed the same lines meanwhile, they are 3-way merged; conflicts are marked in the files and listed.
- **Discard** deletes the copy and its changes.

The **Agents** panel has the same actions, plus *Open Agent's Worktree in New Window*.

`localpilot.worktrees.mode` decides when to isolate:

| Value | Behaviour |
|---|---|
| `always` (default) | Every agent chat gets its own worktree |
| `parallel` | Only agents started together (Run Tasks in Parallel, Best of N) are isolated |
| `off` | Agents edit the workspace directly |

Outside a git repository agents always edit directly. Worktrees of deleted chats are removed automatically.

To run setup commands in each new worktree (install dependencies, generate code), add `.localpilot/worktrees.json`:

```json
{ "setup": ["npm ci"], "setup-unix": [], "setup-windows": [] }
```

## Pause, steer and stop

A running agent has two buttons next to the composer:

| Button | Key | Effect |
|---|---|---|
| **Pause** / **Resume** | <kbd>⌥Esc</kbd> | Hold the agent after its current step, then continue |
| **Stop** | <kbd>Esc</kbd> | Cancel the run |

**Pause** waits for the current model call or tool batch to finish. The status line shows *Pausing after this step…*, then *Paused*. The tab shows ⏸. **Resume** continues where it stopped.

**Steering.** You can type while an agent is paused or running:

- While paused, a message you send appears as a *queued* row. It is added to the conversation when the agent resumes. Use it to correct course, for example "use the existing helper instead".
- While running, pressing <kbd>Enter</kbd> offers *Add to this agent* (read at its next step), *Send in a new tab* or *Stop this agent first*.
- <kbd>⌘⇧Enter</kbd> (<kbd>Ctrl+Shift+Enter</kbd>) sends the draft in a new tab.

**Stop** cancels the run. Files already changed stay in the changes bar for you to accept or reject.

**Subagents.** Pausing or stopping the main agent also pauses or stops every subagent it started. Each lane of a parallel fan-out has its own ⏸ and ■:

- Pausing a lane holds only that subagent.
- Stopping a lane ends that subagent. The main agent continues and gets a *stopped by the user* report for that task, not a failure.

The same controls are in the tab's right-click menu, the background strip, the **Agents** panel and the Command Palette: *LocalPilot: Pause Agent*, *Resume Agent*, *Pause or Resume Agent*, *Pause All Agents*, *Resume All Agents*, *Stop Agent*, *Stop All Agents*.

<p><img src="{{ '/assets/screenshots/pause-steer.png' | relative_url }}" alt="A paused agent: status Paused, message waiting, a queued steering message and the Resume button" width="420"></p>

## The Agents panel

The **Agents** view sits below the chat view (collapsed by default). It stays in the Primary Side Bar when you move the chat elsewhere, and its title bar has **Open Chat**.

- **Running:** live status line (for example `Running grep_search…`), Pause / Resume / Stop, and a count badge.
- **Idle:** recent sessions with mode, message count and changed-file count.
- Expand a session to see the files it changed. Click a file for a side-by-side diff.
- Inline **Keep** / **Undo** on sessions and files, and **Keep All** / **Undo All Agent Changes** in the title menu.

## Change review

Before an agent changes a file, LocalPilot stores the original content. Then:

- The changes bar appears above the composer. Click a file for a diff.
- Without a worktree, accept or reject per file, or use **Accept all** / **Reject all**. With a worktree, use **Apply to workspace** / **Discard**.
- Changed lines are highlighted in open editors.
- Rejecting restores the exact original content. New files are moved to the trash.
- Accepting drops the snapshot. Your normal git workflow takes over.

Changes are tracked per session, so rejecting one agent's work never touches another's.

![Diff of a README section written by one of three parallel agents, opened from its worktree, with Discard and Apply to workspace]({{ '/assets/screenshots/parallel-review.png' | relative_url }})

## Reading the transcript

Each step is one row: **Read** `file` (lines a to b), **Searched** for `query`, **Edited** `file` `+4 −2`, **Ran** `command` (with exit code), **Opened** `url`. Rows use the present tense while running and the past tense when done. Expand a row for the file excerpt, diff or terminal output. Reasoning shows as a one-line **Thought …** row.

Subagents show as `agent · task · model` pills with their own rows. They fold into *Finished with N steps* and a collapsible report.

## Subagents inside a session

One agent can also fan out:

- `run_subagent` runs one child.
- `run_parallel_subagents` runs several at once, up to `localpilot.parallel.maxConcurrency`.

Children start with a fresh context window and return only their final message, which keeps the parent's context small.

Read-only subagents (`explore`, `clarifier`, `researcher`) go to a small, fast tool-capable model by default (`localpilot.routing.fast`). Coding subagents can go to a stronger model (`localpilot.routing.coding`). See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

### Plans that execute themselves

For large tasks the agent first writes a checklist with `manage_todos`. Each item can have an `agent` (coder, tester, docs, explore and so on), a self-contained `prompt`, and `dependsOn` (ids that must finish first). One `run_todos_parallel` call then runs the checklist in waves:

1. Every pending item whose prerequisites are done runs now, up to `maxConcurrency` at once.
2. When a wave finishes, items waiting on it start. Their brief includes the prerequisites' reports.
3. An item whose prerequisite failed is skipped, with the reason. A circular `dependsOn` is reported instead of hanging. Items without an agent are left for the main agent.

Items move to *in progress* and then *done* in the Tasks panel, which shows each item's agent and dependencies (*after 1, 2*). The main agent keeps the final integration: combined diagnostics, tests and summary.

A plan from Plan mode already has this shape. Click **Build**, or switch to Agent and say *implement the plan* (or *go ahead*, *run the checklist*). LocalPilot then makes `run_todos_parallel` the first step of that turn.

### Whole-workspace analysis

For repository-wide questions ("review the whole codebase", "where is the auth logic"), the agent calls `analyze_workspace` first. It is a scan with no model call. It returns languages and test locations per folder, manifest summaries, and a split of the repository into shards sized for `maxConcurrency`. The agent then runs one `explore` or `reviewer` subagent per shard and merges the reports. Plan and Ask modes can do the same with read-only subagents.

## Parallel requests

Parallel agents are only as parallel as the model server. Ollama serves one request per model at a time unless `OLLAMA_NUM_PARALLEL` is set. Four subagents on one model then queue. The status line shows *Waiting for <model> — queued behind N other requests…*, and the first-token timeout grows with the queue so a queued request is not treated as a stall.

### Several models at once

LocalPilot can spread parallel work across models. Each run holds a slot on its model, and the router tracks those counts. If a worker or an *Auto* chat would land on a model that is full, the router picks a comparable idle model and says so on the worker's lane, for example *qwen2.5-coder:14b is busy with 1 other request — running this on gemma4:12b alongside*.

A model counts as comparable when it has:

- the same required capabilities (tool calling, and vision when the turn has images),
- a role score within a few points of the intended model,
- at least a third of its parameters,
- and, when sizes are known, enough free memory to load next to the models already in use.

If nothing qualifies, the run queues. Two workers routed at the same moment cannot take the same last slot.

What never gets swapped: a model you chose for a chat, and a model named in a `run_subagent` call or an agent file. Workers that inherit the parent's model can be spread, and so can *Auto* chats. If a spread worker's stand-in stalls, it is retried on the parent's model.

This behaviour is `localpilot.routing.parallelModels` (default `true`) and needs `localpilot.routing.enabled`. The *Auto* entry in the model picker names the model the router would use right now.

### More slots on one model

- When LocalPilot starts Ollama itself (automatic setup, *Start* in **Settings → Models**, the installer scripts), it sets `OLLAMA_NUM_PARALLEL` to `localpilot.parallel.maxConcurrency`, capped at 4.
- When LocalPilot sees requests queuing, it offers **Restart Ollama with parallel slots** (also *LocalPilot: Restart Ollama with Parallel Request Slots*).
- A systemd-managed Ollama on Linux needs `sudo systemctl edit ollama`, then `Environment="OLLAMA_NUM_PARALLEL=4"`, then `sudo systemctl restart ollama`. A remote server needs the variable set where it runs.
- Each slot keeps its own KV cache, so memory grows with slots × `localpilot.contextWindow`. If a model slows down or spills to CPU, lower `maxConcurrency` or the context window.
- LM Studio, llama.cpp (`--parallel N`), vLLM and Docker Model Runner have their own concurrency settings.
- colibri reports its KV-slot count, and LocalPilot uses it for parallel work. *LocalPilot: Start colibri* passes `localpilot.colibri.kvSlots` (default 2). See [Models & providers]({{ '/docs/models/' | relative_url }}).

## Limits

| Setting | Default | Effect |
|---|---|---|
| `localpilot.parallel.maxConcurrency` | 4 (max 16) | Concurrent tool calls and subagents per session; also the Ollama slot count LocalPilot requests (capped at 4) |
| `localpilot.parallel.maxSubagentDepth` | 2 (max 4) | How deep subagents may nest |

Your model server's own concurrency decides how many requests truly run at the same time.
