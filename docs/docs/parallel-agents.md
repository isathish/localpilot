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
| Orange spinner · ■ | Agent running — ■ stops it without leaving the current tab |
| Green dot · bold title | Finished while you were in another tab — new results to read |
| Pulsing ⚠ | Waiting for your approval (the prompt is also shown in the current tab with a link) |
| Pin | Pinned: always first, never closed by "Close other tabs" or retention |

- **✕** closes a tab (the chat stays in **All chats**); middle-click or <kbd>Delete</kbd> on a focused tab does the same. Closing the active tab moves to the neighbour.
- **Double-click** (or <kbd>F2</kbd>) renames inline. **Right-click** for Rename · Pin · Fork · Export · Stop / Clear messages · Close · Delete.
- Agents working in *other* tabs appear in a strip under the tab bar with their current step; click to switch, ■ to stop.
- Keyboard: <kbd>Alt↑</kbd>/<kbd>Alt↓</kbd> cycle tabs, <kbd>Alt1…9</kbd> jump, <kbd>←</kbd>/<kbd>→</kbd> move between focused tabs.
- Open tabs persist when the view is hidden and restored; at most 12 are shown — the rest live under **+N** / **All chats**.

## Run Tasks in Parallel

Press the clock icon → **Run tasks in parallel…**, type one task per line and hit **Run N agents** (<kbd>⌘Enter</kbd>). Each task becomes its own agent in its own tab, all streaming at once. The same launcher is available as **Command Palette → LocalPilot: Run Tasks in Parallel…** (<kbd>⌘⇧⌥P</kbd>) with tasks separated by ` | `, and from the CLI with `localpilot --ide --parallel "a | b | c"`.

While an agent is busy you can still type: <kbd>⌘⇧Enter</kbd> (<kbd>Ctrl⇧Enter</kbd>) **sends the draft in a new tab**, and pressing <kbd>Enter</kbd> offers the same choice instead of blocking.

## The Agents panel

Below the chat view (collapsed by default):

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

For large tasks the agent is asked to **split the work into checklist items first**: independent items get an `agent` and a self-contained `prompt` in `manage_todos`, and `run_todos_parallel` runs them concurrently — each item flips to *in progress* and then *done* in the Tasks panel, with the delegated agent shown on the item — while the main agent keeps the dependent steps, then integrates and verifies the combined change. Read-only subagents (`explore`, `clarifier`, `researcher`) are routed to a small, fast tool-capable model by default (`localpilot.routing.fast`), and implementing ones can be sent to a stronger coding model (`localpilot.routing.coding`). See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Limits

- `localpilot.parallel.maxConcurrency` (default 4) bounds concurrent tool calls and subagents per session.
- `localpilot.parallel.maxSubagentDepth` (default 2) prevents runaway nesting.
- Your model server's own concurrency (e.g. `OLLAMA_NUM_PARALLEL`) ultimately decides how many requests run truly simultaneously.
