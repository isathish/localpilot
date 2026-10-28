---
title: Context & mentions
description: Attach exactly the context you want with @ mentions, and see how LocalPilot fits long tasks into a model's context window.
permalink: /docs/context/
---

<p><img src="{{ '/assets/screenshots/context-menu.png' | relative_url }}" alt="@ menu: @workspace, @selection, @problems, @git, @editors and @terminal" width="370"></p>

## Attaching context

| How | What it attaches |
|---|---|
| Paper-clip button | The active file, or only the selection as `file#L10-L20` |
| Folder button, drag and drop, or the Explorer context menu | Any files. Images become image attachments |
| `@path/to/file` or `@path/to/file#L10-L40` | A file or line range. Autocomplete offers open editors |
| `@folder/` | A directory listing |
| `@workspace` | The project file tree, cut at 400 entries |
| `@selection` | The current selection, or the whole active file if nothing is selected |
| `@problems` | Current errors and warnings from language servers |
| `@git` | `git status --short --branch`, the unstaged diff stat and the staged diff |
| `@editors` | The list of open editors |
| `@terminal` | The last command and output of the active terminal (VS Code only, not the CLI) |

Type `@` to open the mention picker. Use <kbd>↑</kbd> / <kbd>↓</kbd> to move and <kbd>Tab</kbd> to pick. <kbd>⌘I</kbd> / <kbd>Ctrl+I</kbd> opens the **Add context** menu.

## The context meter

The ring at the bottom right of the composer shows how much of the model's context window is in use. It turns amber above 65% and red above 85%. Click it to compact the conversation now; `/compact` does the same. `/context` prints the token count, window size, message count and number of compactions.

## What every request includes

Besides your message and the conversation, each request carries short sections that help the model orient itself before its first tool call:

- the active file and selection,
- a **project map**: top-level folders with file counts and their subfolders, root files, and detected stack markers such as Node, Python or Docker,
- project rules files (see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}#claudemd-and-instruction-files)),
- the memory index,
- the working set (files already read or edited this session),
- the current checklist,
- the one-line index of available skills.

The full file list is only included when you add `@workspace`.

## Automatic context management

Before every model call, LocalPilot adds up the system prompt, tool schemas, history and reserved output tokens. It compares that with the **effective** context window: `localpilot.contextWindow`, capped by what the model supports (`0` means the model's maximum). The same number is sent as the request's `num_ctx`, so LocalPilot trims the history itself instead of letting the server cut it silently.

When usage crosses `localpilot.compactionThreshold` (default `0.75`), LocalPilot applies these steps in order until the history fits:

1. **Prune tool outputs.** Older tool results are replaced with a one-line stub. Recent turns are untouched.
2. **Compact.** The model summarises the older part of the conversation into a structured note: task, decisions, files touched, findings, next steps. The split always lands on a user turn, so tool calls stay paired with their results.
3. **Tighten and compact again.** If the recent messages alone still overflow, the number kept word for word shrinks from 8 to 4 to 2, with their tool outputs pruned, and the rest goes into the summary. Each pass shows a *Context compacted* note.
4. **Truncate.** If summarising fails, the oldest turns are dropped.

Each tool output is also clamped to `localpilot.maxToolOutputChars` (default 24,000 characters; the start and end are kept). The model is told to read files by line range.

## Larger context windows

- `localpilot.contextWindow` is the window requested per call (Ollama's `num_ctx`). The default is 32768.
- Set it to `0` (*Model maximum* under **Settings → Models → Generation**) to use everything the model supports. A 128k model then runs at 128k, if the machine has the memory for the KV cache.
- The context meter, the model picker and the model tooltip show the window the model actually gets, for example *32k of 128k*, with a hint when the model supports more than the setting allows.
- Memory use grows roughly in line with the window, and with parallel slots × window. If a model slows down or spills to CPU after you raise the window, lower it or lower `localpilot.parallel.maxConcurrency`.

## Tips for small windows

- For agent work, prefer models with 32k or more context and set `localpilot.contextWindow` to match.
- Use subagents for exploration. Their output never enters the parent's history, and each has its own fresh window. A big task split with `run_parallel_subagents` is worked on in several context windows at once.
- Start a new chat for each task. Sessions are cheap and keep each context focused.
