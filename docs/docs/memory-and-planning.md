---
title: Memory, planning & the CLI
description: How LocalPilot remembers across sessions, plans multi-step work with a live checklist, caches tool results, and runs from your terminal.
permalink: /docs/memory-and-planning/
---

## Persistent memory

The agent can save durable notes and reads them back at the start of every session — like Cursor Memories or Claude's `CLAUDE.md`, but stored as plain Markdown you can edit and commit.

| Scope | Location | Use for |
|---|---|---|
| **project** | `<workspace>/.localpilot/memory/<name>.md` | Build/test commands, conventions, architecture facts, gotchas — commit it to share with the team |
| **global** | VS Code global storage `memory/<name>.md` | Your personal preferences across all workspaces |

- The agent uses `memory_save` (replace or append), `memory_read`, `memory_list` and `memory_delete`. The system prompt instructs it to record verified facts and never secrets.
- Every system prompt includes a compact **index** (name + first line) and inlines small notes (≤1200 chars) within a 6k budget; larger notes are fetched on demand.
- **Settings → Memory & history** lists every note with its scope, size and age — open or delete notes individually, or clear a whole scope. **LocalPilot: Open Memory Notes** opens the folder; `localpilot.memory.enabled` turns the feature off.

## Chat history

Chats are stored per workspace in VS Code's workspace storage (never sent anywhere). The **All chats** button in the tab bar (also **+N** when more chats exist than fit as tabs) opens the history panel: chats grouped by **Running · Pinned · Today · Yesterday · Previous 7 / 30 days · Older**, searchable by title *and by what was said* — type two or more characters and chats whose messages contain the text appear with the matching line. Every row has **pin**, **rename**, **more…** (open, fork, export as Markdown, clear messages) and **delete** (with an inline confirmation), so a chat does not have to be opened to be managed; <kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>Enter</kbd>, <kbd>F2</kbd> and <kbd>Delete</kbd> work on the selected row. Untouched empty chats never show up here, pressing **New chat** on an empty chat re-uses it, and leftovers from earlier windows are discarded on startup. A chat's title is its first message (your own words, without attachments or context blocks) until you rename it.

**Settings → Memory & history** shows how many chats and messages exist, how much disk they use, and lets you:

- set **Keep at most** (`localpilot.sessions.retention`, default 50) — the oldest idle chats are pruned automatically whenever a new chat starts; pinned and running chats never count;
- **Clear chat history…** (also in the chat's All-chats menu and the Command Palette) — deletes idle chats, optionally keeping pinned ones; running agents keep going.

Ask explicitly too: *"remember that we deploy with `make release` and tests need `DATABASE_URL`"*.

## Planning with a live checklist

For any multi-step task the agent calls `manage_todos` first, then updates items as it works. The **Tasks** panel above the composer shows the checklist with a progress bar, a spinner on the in-progress step and strike-through on completed ones. The list persists with the session and is re-injected after compaction so the agent always knows where it left off.

**Plan mode** produces the checklist plus a written plan without touching files; switch to **Agent** and say *"implement the plan"*.

## Thinking

`localpilot.thinking`: `off` · `on` · `low` · `medium` · `high`. Maps to Ollama's `think` and OpenAI-compatible `reasoning_effort`. Reasoning streams into a collapsed **Thinking…** step with an elapsed-time counter and becomes *"Thought for Ns"* when the answer starts.

## Caching & latency

- **Per-turn tool cache** — identical read-only calls (same tool, same arguments) run once per turn, including when a model requests duplicates in parallel. Any mutating tool (edit, write, delete, shell) clears the cache. Cached results show a *cached* badge.
- **Model keep-alive** — `localpilot.keepAlive` (default `30m`) keeps the Ollama model loaded so follow-up turns skip the reload.
- **Pre-warm** — `localpilot.prewarm` (default on) loads the chat's model as soon as you focus the composer or switch models, so the first token of your first message is not preceded by a 5–30 s weight load. Ollama only (an empty `/api/chat` request); throttled to once every few minutes per model and never while a run is in flight.
- **Workspace tree cache** — `@workspace` listings are cached for 5 minutes and invalidated when files are created or deleted.
- **Working set** — files read or edited in the session are listed in the prompt, so after compaction the model still knows what it touched.

## Multitasking

Every session is an independent agent. A **tab strip** at the top of the chat shows one tab per agent with its live state (running, finished, needs approval); `+` starts another agent while the current one keeps working, and <kbd>⌘⇧Enter</kbd> sends the draft in a new tab. See [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }}). The **Agents** panel shows the same information with per-session changed files. Use **Run Tasks in Parallel…** (<kbd>⌘⇧⌥P</kbd>) or `localpilot --ide --parallel "a | b | c"` to fan out several tasks at once.

## The `localpilot` CLI

The `localpilot` command runs the full agent in your shell — see [Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}).
