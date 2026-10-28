---
title: Memory, planning & the CLI
description: How LocalPilot keeps notes across sessions, tracks multi-step work in a checklist, stores chat history, and caches tool results.
permalink: /docs/memory-and-planning/
---

## Persistent memory

The agent can save notes and reads them back at the start of every session. Notes are plain Markdown files you can edit and commit.

| Scope | Location | Use for |
|---|---|---|
| project | `<workspace>/.localpilot/memory/<name>.md` | Build and test commands, conventions, architecture facts. Commit it to share with your team |
| global | VS Code global storage, `memory/<name>.md` | Your personal preferences across all workspaces |

How it works:

- The agent uses `memory_save` (replace or append), `memory_read`, `memory_list` and `memory_delete`. Its instructions tell it to record verified facts and never secrets.
- Every system prompt includes an index of notes (name and first line). Notes of 1,200 characters or less are included in full, within a 6,000-character budget. Larger notes are read on demand.
- You can ask directly: *"remember that we deploy with `make release` and tests need `DATABASE_URL`"*.

To manage notes, open **Settings → Memory & history**. It lists every note with scope, size and age, and lets you open or delete notes or clear a whole scope. *LocalPilot: Open Memory Notes* opens the folder. Set `localpilot.memory.enabled` to `false` to turn memory off.

## Planning with a checklist

For multi-step work the agent calls `manage_todos` first and updates items as it goes. The **Tasks** panel above the composer shows the checklist with a progress bar, a marker on the current step and strike-through on finished ones.

The checklist is saved with the session and included in every request, so the agent keeps track of it after the conversation is summarised.

**Plan mode** writes the checklist and a plan file without touching your files. Click **Build**, or switch to **Agent** and say *implement the plan*. See [Agent modes → Plan]({{ '/docs/agent-modes/#plan' | relative_url }}) and [Plans that execute themselves]({{ '/docs/parallel-agents/#plans-that-execute-themselves' | relative_url }}).

## Chat history

Chats are stored per workspace in VS Code's workspace storage on your machine. See [Privacy]({{ '/privacy/' | relative_url }}) for what leaves your machine.

Open the history with **All chats** in the tab bar (or **+N** when there are more chats than tabs):

- Chats are grouped by Running, Pinned, Today, Yesterday, Previous 7 / 30 days and Older.
- Search matches titles and message text. Type two or more characters to see matching lines.
- Each row has pin, rename, delete (with confirmation) and **more…** (open, fork, export as Markdown, clear messages).
- Keys: <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Enter</kbd>, <kbd>F2</kbd> and <kbd>Delete</kbd> act on the selected row.

A chat's title is your first message until you rename it. Empty chats you never used do not appear in the history, and **New chat** on an empty chat reuses it.

**Settings → Memory & history** shows how many chats exist and how much disk they use. You can:

- set **Keep at most** (`localpilot.sessions.retention`, default 50). The oldest idle chats are removed when a new chat starts. Pinned and running chats do not count.
- set **Transcripts in memory** (`localpilot.storage.sessionsInMemory`, default 16). Every chat stays in the list, but only the most recently used transcripts are held in RAM; the others load from disk when you open or search them. The page shows how many are loaded.
- run **Clear chat history…** (also in the All chats menu and the Command Palette). It deletes idle chats and can keep pinned ones. Running agents keep going.

## Thinking

`localpilot.thinking` sets reasoning effort: `off` (default), `on`, `low`, `medium` or `high`. It maps to Ollama's `think` and to `reasoning_effort` on OpenAI-compatible servers. Only reasoning models use it.

Reasoning streams into a collapsed **Thinking…** step with a timer. It becomes *Thought for Ns* when the answer starts.

## Caching and latency

| Feature | Setting | What it does |
|---|---|---|
| Per-turn tool cache | none | Identical read-only calls (same tool and arguments) run once per turn, even when requested in parallel. Any edit, write, delete or shell command clears the cache. Cached results show a *cached* badge |
| Model keep-alive | `localpilot.keepAlive` (default `30m`) | Ollama keeps the model loaded between turns, so follow-ups skip the reload |
| Pre-warm | `localpilot.prewarm` (default `true`) | Loads the chat's model when you focus the composer or switch models. Ollama only; at most once every few minutes per model, and never while a run is in progress |
| Workspace tree cache | none | `@workspace` listings are cached for 5 minutes and refreshed when files are created or deleted |
| Working set | none | Files read or edited in the session are listed in the prompt, so the model still knows them after summarisation |

## Several agents at once

Every chat is an independent agent with its own tab. Start another with `+` while the current one works, or press <kbd>⌘⇧Enter</kbd> to send the draft in a new tab. Use **Run Tasks in Parallel…** (<kbd>⌘⇧⌥P</kbd>) or `localpilot --ide --parallel "a | b | c"` to start several tasks. See [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }}).

## The `localpilot` CLI

The `localpilot` command runs the agent in your shell. See [Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}).
