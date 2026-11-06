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
| <kbd>⌘'</kbd> / <kbd>Ctrl+'</kbd> or **Add Selection to Chat** in the editor context menu or light bulb | The selection as `file#L10-L20` in the current chat, with any problems (errors, warnings) inside it drafted below as a **Problems:** list. Nothing is sent; the input gets focus |
| Folder button, drag and drop, or the Explorer context menu (**Add File/Folder to Chat**) | Any files. Images become image attachments. Files dragged from the Explorer or an editor tab (hold <kbd>Shift</kbd> while dropping) are inserted as `@path` mentions; dropped text is inserted as text |
| `@docs/spec.pdf`, `@docs/spec.pdf#page=3` or `#page=3-7` | The text of a PDF (or of those pages; `#L3-L7` also means pages here), up to `localpilot.pdf.maxChars` characters |
| `@path/to/file` or `@path/to/file#L10-L40` | A file or line range. Autocomplete searches the whole workspace |
| `@"docs/my file.md"` | A path with spaces, in quotes |
| `@folder/` | A one-level tree of the folder plus the text of each file directly inside it (up to 20,000 characters per file and 60,000 for the folder). Subfolders are only listed; binaries and PDFs are only noted |
| `@1a2b3c4` (7 to 40 hex digits) | A commit: `git show --stat --format=fuller` with the patch, up to 30,000 characters. The picker also offers recent commits whose message matches what you type |
| `@https://example.com/page` | The page as readable text, converted as `web_fetch` does. Refused when web access is off, and asks first when `localpilot.approvals.network` is `ask` |
| `#codebase` (or `@codebase`) | An overview of the whole project: the workspace folders, the project map, the import graph's summary (most-imported files, external packages, cycles), a file list cut at 300 entries, and the files whose names or top-level symbols match words in your message. About 24,000 characters at most |
| `@workspace` | The project file tree, cut at 400 entries |
| `@selection` | The current selection, or the whole active file if nothing is selected |
| `@problems` | Current errors and warnings from language servers |
| `@git` | `git status --short --branch`, the unstaged diff stat and the staged diff |
| `@editors` | The list of open editors |
| `@terminal` | The last command and output of the active terminal (VS Code only, not the CLI) |

**Limits.** A message takes at most 20 images and files together. Images larger than 7,680 pixels on a side and other files larger than 20 MB are refused with a message. When the selected model cannot read images and no vision model is available for routing, the image button is greyed out and its tooltip says why.

**Documents and binaries.** PDFs, Word documents (`.docx`) and Jupyter notebooks (`.ipynb`, as cells with their text outputs; image outputs become `[image output]`) are attached as text. Scanned PDF pages have no text layer and say so. Other binary files, such as a `.zip`, are attached as a note with the file name and size, and the chat shows the same note. The agent reads PDFs on its own with the `read_pdf` tool (20 pages or `localpilot.pdf.maxChars` characters per call); `read_file` on a `.pdf` is redirected to it. For a scanned page, open the PDF in the [PDF viewer]({{ '/docs/viewers/' | relative_url }}) and use **⋯ → Attach page as image** with a vision model; **Ask about selection** there attaches the page (`docs/spec.pdf#page=3`) and quotes the selected text.

Type `@` to open the mention picker. Use <kbd>↑</kbd> / <kbd>↓</kbd> to move and <kbd>Tab</kbd> to pick.

Type `#` for the context you attach by name: `#codebase`, `#workspace`, `#selection`, `#problems`, `#git`, `#editors` and `#terminal` attach the same as their `@` forms. The **#** in the hint row under an empty message box attaches `#codebase`. The CLI accepts `#codebase` too.

**There is no semantic index.** LocalPilot does not build embeddings of your code. `#codebase` matches related files by file name and by the names of top-level functions, classes and types (from the [repository graph](#repository-graph)), and says so in what it attaches. The agent finds the rest with `grep_search`, `find_symbol` and `repo_graph`.

The picker fuzzy-matches what you type after `@` against every file and folder in the workspace (`node_modules`, `.git`, build output and similar folders are skipped), so `@chatctl` finds `src/ui/chatController.ts`. Open editors are listed first and files you attached recently next; the matched letters are highlighted. In a multi-root workspace each result shows its folder as `name:/path`, and the chat's own folder is searched first.

**Large repositories.** The picker lists up to 5,000 files. LocalPilot scans the workspace folder by folder when the chat opens: the welcome screen, the **Add context** menu and a status bar item show *Indexing 1,240 files… 38%* meanwhile. When the workspace has more files than the picker lists, they show *Large repo: 5,000 of 12,400 files listed* (counting stops at 200,000). Files past the limit can still be attached by typing their path, and the agent's search tools cover every file. When files are created or deleted, the list is refreshed quietly up to the 5,000-file limit and the count stays as it was; click the status bar item or the note, or run **LocalPilot: Rebuild File Index**, to count again.

Mentions in the input are highlighted. <kbd>Backspace</kbd> right after a mention removes the whole mention. In a sent message, click a context chip to open it: a file opens in the editor, `@problems` opens the Problems panel, `@terminal` the terminal and `@git` Source Control. While an input method editor (Japanese, Chinese, Korean) is composing, <kbd>Enter</kbd> confirms the text and never sends the message. <kbd>⌘I</kbd> / <kbd>Ctrl+I</kbd> opens the **Add context** menu when focus is elsewhere in the chat; in the input it runs **Improve prompt**.

## The context meter

The ring at the bottom right of the composer shows how much of the model's context window is in use. It turns amber above 65% and red above 85%. Hover it (or focus it with the keyboard) for a breakdown: tokens used, the window, what remains, this chat's prompt and output tokens, cache reads and writes, and where auto-compaction starts (`localpilot.compactionThreshold`, or *off*). Click it and confirm **Compact** to compact the conversation now; `/compact` does the same. While the agent is running the ring is dimmed and compacting waits until it finishes. `/context` prints the token count, window size, message count, number of compactions and the list below.

**What fills it.** The card also lists what the last request was made of, largest first, each with a bar for its share of the window:

| Part | What it is | Where to trim it |
|---|---|---|
| System prompt | LocalPilot's instructions: mode, environment, project map, skills index | |
| Rules | AGENTS.md, CLAUDE.md, `.localpilot/rules` and other instruction files | **Manage** opens Settings → Customize |
| Memory | Saved memory notes | **Manage** opens Settings → Memory |
| Tools / MCP tools | Tool definitions, built-in and from MCP servers | **Manage** (MCP) opens Settings → MCP |
| Conversation | Your requests and the replies | |
| Attached files | Files, folders, `#codebase`, `@git` and other attachments, images included | |
| Tool output | What the agent read, searched and ran | **Compact** |
| Compaction summary | Summaries standing in for older messages | |

The counts are estimates scaled to the model's tokenizer; after a request the model reports its real prompt size and the parts are scaled to match. The list appears after the chat's first request.

Next to the ring, `↑12.3k ↓1.1k` shows the tokens this chat has sent (cached input included) and received, and `$0.0123` its cost on a cloud model with a known price. Hover the ring or the pill for the breakdown: cache reads and writes, requests, subagents' share, or *local · free* for models on your machine. The CLI prints the same after each turn, for example `(13.4k tok · $0.0100)`.

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

## Multi-root workspaces

With several folders open, each chat works in one of them. The welcome screen shows the chat's folder and that folder's git branch; click the folder name, or the folder chip next to **Add context**, to pick another. The chat's folder is where its file tools, terminal commands, checkpoints and hooks run, what `@` searches first, what `#codebase` and `@git` describe, and whose problems `get_diagnostics` lists first. A chat keeps its folder once it has messages; picking another folder then starts a new chat there. New chats start in the folder of the chat you were in. **Add folder to workspace…** in the same menu runs VS Code's command.

Each request lists the folders as `name — path — git <branch>@<short sha>`. Relative paths in tool calls resolve against the chat's folder (or its isolated worktree). To reach another folder, prefix the path with its name: `read_file backend:src/x.ts`. A bare relative path that is missing from the first folder but exists in exactly one other folder resolves there, and the tool result (and the approval prompt of an edit) says so; if several folders have it, the tool returns an error listing `name:path` candidates. Files being created (`write_file`, an added file or move target in `apply_patch`) never fall back: a bare path stays in the first folder, so use `name:path` to create one elsewhere. `grep_search` and `file_search` search every folder (an `include_pattern` such as `src/**/*.ts` applies inside each folder), and `git_status`, `git_commit`, `git_push`, `pull_request`, `ci_status`, `security_scan` and `repo_graph` take an optional `root` argument naming the folder (or a registered repository) to run in.

## Keeping files out of the agent's context

A `.localpilotignore` file at the root of a workspace folder lists files the agent should leave alone. LocalPilot also reads Cline's `.clineignore` and Cursor's `.cursorignore`. The syntax is that of `.gitignore`: one pattern per line, `#` comments, `!` to re-include, a trailing `/` for folders and a leading `/` to anchor to the folder. A line `!include <file>` adds the patterns of another file, for example `!include .gitignore`. Changes apply right away.

```gitignore
.env*
!.env.example
secrets/
!include .gitignore
```

For matching files:

- `list_dir` and the `@workspace` tree mark them with 🔒; `file_search` and `grep_search` leave them out.
- `read_file`, `edit_file`, `write_file` and `apply_patch` refuse with "*path* is excluded by .localpilotignore".
- Automatic context skips them: the active file and selection, open editors and the working set.
- An explicit `@` mention still attaches the file, with a note that it is excluded.

The ignore file is not a security boundary. Shell commands run by `run_command` are not checked against it, so the agent could still print an excluded file with `cat`. Keep real secrets out of the workspace or use [permission rules]({{ '/docs/claude-code-compatibility/' | relative_url }}#permission-rules) to deny commands.

## Automatic context management

Before every model call, LocalPilot adds up the system prompt, tool schemas, history and reserved output tokens. It compares that with the **effective** context window: `localpilot.contextWindow`, capped by what the model supports (`0` means the model's maximum). The same number is sent as the request's `num_ctx`, so LocalPilot trims the history itself instead of letting the server cut it silently.

When usage crosses `localpilot.compactionThreshold` (default `0.75`), LocalPilot applies these steps in order until the history fits:

1. **Prune tool outputs.** Older tool results are replaced with a one-line stub that points to the full text (see below). Recent turns are untouched.
2. **Compact.** The model summarises the older part of the conversation into a structured note: task, decisions, files touched, findings, next steps. The split always lands on a user turn, so tool calls stay paired with their results.
3. **Tighten and compact again.** If the recent messages alone still overflow, the number kept word for word shrinks from 8 to 4 to 2, with their tool outputs pruned, and the rest goes into the summary. Each pass shows a *Context compacted* note. Expand it to see what was kept as it was (the latest messages, and the request in progress when the split fell inside a turn), what went into the summary (requests, replies, tool calls and outputs, and the files they involved), whether the model or a plain digest wrote it, and the summary itself.
4. **Truncate.** If summarising fails, the oldest turns are dropped.

Each tool output is also clamped to `localpilot.maxToolOutputChars` (default 24,000 characters; the start and end are kept). The model is told to read files by line range.

The full text of a clamped or pruned output is kept in memory: up to 16 MB per chat, dropped after 5 agent steps without being read. The cut text names it, for example `lp-cache://<chat>/<id>.txt`, and the agent reads the missing part with `read_file` and a `start_line`. A `read_file` result is sized to fit this limit (split across the files of a batched read), so it is never cut again; its footer says which line to continue from. Once it has expired, the agent is told to make a new tool call and not to repeat commands with side effects.

## Repository graph

For a large codebase the agent does not need to read files one by one to know how they connect. The `repo_graph` tool builds an import graph and an index of top-level symbols straight from the source (TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin and C#). It needs no language server, so it also works in the [CLI](terminal-and-cli.md). It indexes a repository of a few hundred files in well under a second and afterwards re-reads only files that changed.

The agent uses it to answer questions such as:

| Action | Answers |
|---|---|
| `impact` | What could break if this file changes: every file that imports it, directly or through others, plus the tests among them to run. |
| `dependents` / `dependencies` | Which files import this one, and what it imports (including external packages). |
| `symbol` | Where a function, class or type is defined, and how many files import that file. |
| `hubs` | The most-imported files, the ones where a change ripples furthest. |
| `cycles` | Files that import each other. |
| `external` | Which files use a package. |
| `overview` | A summary of all of the above. |

Ask "what breaks if I change `src/util.ts`?" and the agent answers from the graph instead of guessing from text searches. Before it edits a shared file, it checks the impact the same way.

## Larger context windows

- `localpilot.contextWindow` is the window requested per call (Ollama's `num_ctx`). The default is 32768.
- Set it to `0` (*Model maximum* under **Settings → Models → Generation**) to use everything the model supports. A 128k model then runs at 128k, if the machine has the memory for the KV cache.
- The context meter, the model picker and the model tooltip show the window the model actually gets, for example *32k of 128k*, with a hint when the model supports more than the setting allows.
- Memory use grows roughly in line with the window, and with parallel slots × window. If a model slows down or spills to CPU after you raise the window, lower it or lower `localpilot.parallel.maxConcurrency`.

## Tips for small windows

- For agent work, prefer models with 32k or more context and set `localpilot.contextWindow` to match.
- Use subagents for exploration. Their output never enters the parent's history, and each has its own fresh window. A big task split with `run_parallel_subagents` is worked on in several context windows at once.
- Start a new chat for each task. Sessions are cheap and keep each context focused.
