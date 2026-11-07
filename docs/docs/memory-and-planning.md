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

Since 1.7 these are two of **six memory types**: project, developer (the "global" notes; `global` still works
everywhere), conversation (one chat's summary and notes), task (a running plan's checklist; expires
`localpilot.memory.taskExpiryDays` after it is done), knowledge (reference you look up with `#memory:<name>`) and agent
(pitfalls and fixes the agent learned). The memory tools take an optional `type`, `memory_search` searches every type, and
**Memory manager** edits, moves, pins, versions and trashes them. See
[Conversations, memory & sync]({{ '/docs/continuity/' | relative_url }}#memory).

How it works:

- The agent uses `memory_save` (replace or append), `memory_read`, `memory_list` and `memory_delete`. Its instructions tell it to record verified facts and never secrets.
- Every system prompt includes an index of notes (name and first line), newest first, and the full text of notes of 1,200 characters or less, within about 5% of the context window (1,500 to 12,000 characters). Notes that do not fit are counted and stay reachable with `memory_list` and `memory_read`.
- You can ask directly: *"remember that we deploy with `make release` and tests need `DATABASE_URL`"*.
- **Saved automatically.** Small local models rarely save notes on their own. After a run with at least three tool calls in which the agent saved nothing, LocalPilot asks the same model, in the background once the answer is out, whether the run revealed durable facts: a build or test command that worked, a convention, a pitfall and its fix, a stated preference. It appends at most three short notes to project memory (since 1.7 a pitfall and its fix is kept as an agent lesson instead) and shows **Saved to memory: …**; most runs save nothing. Anything that looks like a credential is dropped, and benchmark and other unattended runs never save. Set `localpilot.memory.autoSave` to `false` to turn this off.
- `/memory` in the chat lists the saved notes along with the instruction files in force: `CLAUDE.md`, `AGENTS.md`, and rules from `.localpilot/rules/`, `.claude/rules/`, `.cursor/rules/`, `.clinerules` and `.cline/rules/` (see [instruction files]({{ '/docs/claude-code-compatibility/' | relative_url }}#claudemd-and-instruction-files)). Rules switched off with `disabled: true` are not listed; conditional rules (`paths:` / `globs:`) are marked as such, with whether they applied last turn.

To manage every type, open **Memory manager** (*LocalPilot: Open Memory Manager*). For the note files, open **Settings → Memory & history**. It lists every note with scope, size and age, and lets you open or delete notes or clear a whole scope. *LocalPilot: Open Memory Notes* opens the folder. Set `localpilot.memory.enabled` to `false` to turn memory off.

## Planning with a checklist

For multi-step work the agent calls `manage_todos` first and updates items as it goes. The **Tasks** panel above the composer shows the checklist with a progress bar, a marker on the current step and strike-through on finished ones.

The checklist is saved with the session and included in every request, so the agent keeps track of it after the conversation is summarised.

**Plan mode** writes the checklist and a plan file without touching your files. Click **Build**, or switch to **Agent** and say *implement the plan*. See [Agent modes → Plan]({{ '/docs/agent-modes/#plan' | relative_url }}) and [Plans that execute themselves]({{ '/docs/parallel-agents/#plans-that-execute-themselves' | relative_url }}).

`/deep-planning <task>` runs one turn in Plan mode, whatever mode the chat is in: the agent investigates the code without narrating, asks up to four questions if the code leaves design choices open, and writes a plan (overview, files, functions, implementation order, testing, risks) that is saved as `implementation_plan.md` in the workspace. Only a finished answer is saved: an error, the step limit or a stop leaves an existing plan file as it was. `/deep-planning` is built in, so a custom command or skill of the same name does not replace it. The chat then returns to its mode; say *implement the plan* to carry it out. It also works in the CLI.

## Chat history

Chats are stored per workspace in VS Code's workspace storage on your machine, and (since 1.7) in the conversation log
shared by every project and the CLI. The navigator adds Favorites, Archived and Trash with counts, every project, search
in code and errors, tags, branches and versions, export, import and secure share: see
[Conversations, memory & sync]({{ '/docs/continuity/' | relative_url }}). See [Privacy]({{ '/privacy/' | relative_url }})
for what leaves your machine.

Open the history with **All chats** in the tab bar (or **+N** when there are more chats than tabs):

- Chats are grouped by Running, Pinned, Today, Yesterday, Previous 7 / 30 days and Older.
- Each row also shows the model, the tokens in and out, the cost when it is known, and the chat's size on disk.
- **Sort** by Newest, Oldest, Most tokens, Most expensive, Largest or Relevance. **Pinned** shows pinned chats only.
- **Filter by mode:** chips above the list show the modes your chats use (Agent, Ask, Plan, Debug, Multitask and specialists such as Review or Test), each with its count; click one to show only those chats, **All** to show every chat. A Review chat counts as Review while it runs in Ask; moved to another mode it counts there.
- **Filter by folder:** in a workspace with several folders, the folder menu shows only the chats that work in one folder. A chat that never picked a folder belongs to the first one. The mode and folder filters stay set the next time you open the history.
- Search matches titles and message text. Title matching is fuzzy and tolerates a typo or two. Typing switches the sort to Relevance; clearing the search restores the previous sort.
- A history of more than 200 chats loads 50 at a time as you scroll.
- Each row has pin, rename, delete (with confirmation) and **more…** (open, fork, export as Markdown, clear messages).
- **Select** deletes several chats at once: tick rows (or use **Select all** / **Select none**), then **Delete N selected**, which shows their total size.
- Keys: <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Enter</kbd>, <kbd>F2</kbd> and <kbd>Delete</kbd> act on the selected row. In selection mode <kbd>Enter</kbd> ticks the selected row, <kbd>Delete</kbd> deletes the ticked ones (after a confirmation) and <kbd>Esc</kbd> leaves selection mode.

Deleting a chat moves it to Trash (with Undo); deleting it permanently from Trash also removes its transcript archive,
its checkpoints and the logs of its detached commands. Without conversation storage a delete is immediate, as in 1.6.

Each chat also records its token usage: uncached input, output, prompt-cache reads and writes, the number of model requests, and the cost when the provider reports one (OpenRouter). Subagent requests count towards the chat that started them and are also kept as a separate breakdown. The totals are saved in the chat's session file. Anthropic and OpenAI-compatible servers report cache tokens. Ollama does not.

A chat's title is your first message until you rename it. Empty chats you never used do not appear in the history, and **New chat** on an empty chat reuses it.

**Settings → Memory & history** shows how many chats exist and how much disk they use. You can:

- set **Keep at most** (`localpilot.sessions.retention`, default 50). The oldest idle chats move to **Archived** when a new chat starts (still searchable and openable from the navigator; removed only without conversation storage). Pinned and running chats do not count.
- set **Transcripts in memory** (`localpilot.storage.sessionsInMemory`, default 16). Every chat stays in the list, but only the most recently used transcripts are held in RAM; the others load from disk when you open or search them. The page shows how many are loaded.
- run **Clear chat history…** (also in the All chats menu and the Command Palette). It moves idle chats to Trash, shows how much disk they take, and can keep pinned ones. Running agents keep going.

## Compaction

When a conversation fills `localpilot.compactionThreshold` of the context window (default 75%), old tool outputs are shortened first. If that is not enough, the older part of the conversation is replaced by a summary and the most recent messages stay word for word. `localpilot.compaction.strategy` picks how the summary is made:

| Strategy | What happens |
|---|---|
| `agentic` (default) | The chat's model writes a structured summary: goals, decisions, files touched, findings, next steps. When the model fails, or the transcript is too big for it to read, LocalPilot uses `basic` instead of dropping the messages |
| `basic` | No model call, so it finishes instantly and always gives the same result. It keeps every message you wrote, the last 3 assistant replies word for word, and one line per earlier tool call, such as `• read_file src/a.ts (ok)` or `• run_command npm test (exit 1, 3 lines of error)`. The digest takes at most about 40% of the context window: a very long message keeps its start and end, and when that is not enough the oldest entries are left out |
| `off` | Never compacts automatically. A conversation that outgrows the window ends with an error; start a new chat or run `/compact` |

`/compact` (also `/smol`, or a click on the context meter) uses `basic` when that is the setting, and the model otherwise. `/newtask [note]` summarises the whole chat the same way and opens a new chat that starts from that summary (plus your note), linked to the old one as its parent, so long work can go on in a fresh context. If the model cannot write the summary (the chat is too long for it, or the call fails or times out), the new chat starts from the size-capped `basic` digest instead. In the CLI, `--compaction agentic|basic|off` overrides the setting for one run.

**Nothing is lost.** Before a compaction replaces messages, the full transcript is appended to `<chat id>.archive.jsonl` next to the chat's session file. When you **Edit** or **Restore checkpoint** on a message from before a compaction, LocalPilot rebuilds the conversation from the archive, so the model sees the original messages again instead of the summary. Deleting a chat deletes its archive. **Settings → Memory & history** counts archives and checkpoints in the disk usage.

## Thinking

`localpilot.thinking` sets reasoning effort: `auto` (default), `off`, `on`, `low`, `medium`, `high` or `max`. `auto` picks per task: high for Plan and Debug, medium for Agent and Multitask, low for Ask and subagents, none for quick helpers. `off` explicitly tells thinking models not to reason. It maps to Ollama's `think`, to `reasoning_effort` on OpenAI-compatible servers, to OpenRouter's `reasoning` object and, for Claude, to the effort level or a thinking budget (a share of 32,000 tokens, at least 1,024 and within the model's output limit). `max` is the largest Claude budget or effort and `high` elsewhere. Only reasoning models use it.

**Per chat.** When the selected model reports that it reasons, the composer shows a **Think** chip. Pick `Auto`, `Off`, `Low`, `Medium`, `High` or `Max` for this chat, or **Inherit global** to follow the setting again. In the CLI, `--thinking [level]` sets it for the run (a bare `--thinking` means `medium`) and `/thinking <level>` changes it in a session; the last choice is remembered in `~/.localpilot/config.json`.

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
