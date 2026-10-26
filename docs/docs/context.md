---
title: Context & mentions
description: How LocalPilot fits large tasks into small context windows, and how to attach exactly the context you want.
permalink: /docs/context/
---

<p><img src="{{ '/assets/screenshots/context-menu.png' | relative_url }}" alt="@ context menu with files, selection, workspace, problems, git, editors" width="420"></p>

## Attaching context

| How | What it does |
|---|---|
| Paper-clip button | Attaches the active file, or just the selection as `file#L10-L20` |
| Folder button / drag-and-drop / Explorer menu | Attaches arbitrary files (images become image attachments) |
| `@path/to/file` or `@path/to/file#L10-L40` | Inline file reference with autocomplete of open editors |
| `@folder/` | Attaches a directory listing |
| `@workspace` | Project file tree (truncated at 400 entries) |
| `@selection` | Current selection, or the whole active file |
| `@problems` | Current errors and warnings from language servers |
| `@git` | `git status`, unstaged diff stat and the staged diff |
| `@editors` | List of open editors |

Type `@` to open the mention picker; <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Tab</kbd> to pick.

## The context meter

The ring at the bottom-right of the composer shows how much of the model's window is in use. It turns amber at 65% and red at 85%. Click it to compact immediately (`/compact` does the same).

## What is always in the prompt

Besides your message and the conversation, every call carries a few compact sections so the model can orient itself before its first tool call: the active file and selection, a **project map** (top-level folders with file counts and their subfolders, root files, detected stack markers such as Node / Python / Docker), any project rules files, the memory index, the working set and the current checklist, and the one-line index of available skills. The full file list is only attached when you add `@workspace`.

## Automatic context management

Before every model call LocalPilot computes a budget: system prompt + tool schemas + history + reserved output tokens vs. the **effective** context window — the `localpilot.contextWindow` setting capped by what the model supports (`0` = the model's maximum). The same number is sent as the request's `num_ctx`, so the history is split *before* the server would have to truncate it silently. When usage crosses `localpilot.compactionThreshold` (default 0.75) it applies, in order:

1. **Prune tool outputs** — older tool results are collapsed to a one-line stub. Cheap and lossless for recent turns.
2. **Compact** — the older part of the conversation is summarised by the model into a structured note (task, decisions, files touched, findings, next steps). The split always lands on a user turn so tool calls stay paired with their results.
3. **Tighten and compact again** — if the most recent messages alone still overflow (a few huge tool results, or a window much smaller than the one the chat was built under), the verbatim window shrinks (8 → 4 → 2 messages, their tool outputs pruned) and the rest is folded into the summary. The loop keeps splitting until the history fits; each pass shows as a *Context compacted* note.
4. **Truncate** — if summarisation fails, oldest turns are dropped.

Tool outputs are also individually clamped to `localpilot.maxToolOutputChars` (head + tail kept), and the model is instructed to read files by line range.

## Larger windows

- `localpilot.contextWindow` is the window **requested** per call (Ollama `num_ctx`). The default 32k is a safe choice for most machines; set it to **0** (*Model maximum* in Settings → Generation) to ask for everything the model supports — a 128k model then runs at 128k, provided the machine has the memory for the KV cache.
- The context meter, the model picker and the model tooltip show the window the model is actually given, e.g. *32k of 128k*, with a hint when the model supports more than the setting allows.
- Memory grows roughly linearly with the window (and with parallel slots × window). If a model gets slow or spills to CPU after raising it, lower the window or `localpilot.parallel.maxConcurrency`.

## Tips for small windows

- Prefer 32k+ context models for agent work; set `localpilot.contextWindow` accordingly.
- Use subagents for exploration — their output never enters the parent's history. Each child has its own fresh window, so a big task split across `run_parallel_subagents` is effectively worked on with several context windows at once.
- Start a new chat per task; sessions are cheap and keep each context focused.
