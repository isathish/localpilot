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
- **LocalPilot: Open Memory Notes** opens the folder; `localpilot.memory.enabled` turns the feature off.

Ask explicitly too: *"remember that we deploy with `make release` and tests need `DATABASE_URL`"*.

## Planning with a live checklist

For any multi-step task the agent calls `manage_todos` first, then updates items as it works. The **Tasks** panel above the composer shows the checklist with a progress bar, a spinner on the in-progress step and strike-through on completed ones. The list persists with the session and is re-injected after compaction so the agent always knows where it left off.

**Plan mode** produces the checklist plus a written plan without touching files; switch to **Agent** and say *"implement the plan"*.

## Thinking

`localpilot.thinking`: `off` · `on` · `low` · `medium` · `high`. Maps to Ollama's `think` and OpenAI-compatible `reasoning_effort`. Reasoning streams into a collapsed **Thinking…** step with an elapsed-time counter and becomes *"Thought for Ns"* when the answer starts.

## Caching & latency

- **Per-turn tool cache** — identical read-only calls (same tool, same arguments) run once per turn, including when a model requests duplicates in parallel. Any mutating tool (edit, write, delete, shell) clears the cache. Cached results show a *cached* badge.
- **Model keep-alive** — `localpilot.keepAlive` (default `30m`) keeps the Ollama model loaded so follow-up turns skip the reload.
- **Workspace tree cache** — `@workspace` listings are cached for 5 minutes and invalidated when files are created or deleted.
- **Working set** — files read or edited in the session are listed in the prompt, so after compaction the model still knows what it touched.

## Multitasking

Every session is an independent agent. A **tab strip** at the top of the chat lists running sessions first (with a spinner) and recent ones after; `+` starts another agent while the current one keeps working. The **Agents** panel shows the same information with per-session changed files. Use **Run Tasks in Parallel…** (<kbd>⌘⇧⌥P</kbd>) or the CLI's `--parallel` flag to fan out several tasks at once.

## The `localpilot` CLI

Run **LocalPilot: Install 'localpilot' Command in PATH** once. It writes a small shim to `~/.local/bin/localpilot` (Windows: `%USERPROFILE%\bin\localpilot.cmd`) that hands tasks to the extension in the current folder — like the `cursor` or `claude` CLIs.

```bash
localpilot "fix the failing tests in src/api"          # agent mode in the current folder
localpilot --plan "migrate the auth module to JWT"     # read-only plan + checklist
localpilot --ask "how does the retry logic work?"
localpilot --file src/db.ts "add connection pooling"   # attach context files
localpilot --parallel "write tests for utils | fix lint errors | update README"
localpilot --settings                                   # open LocalPilot Settings
localpilot --setup                                      # rerun the setup wizard
localpilot                                             # just open a new chat
```

Under the hood it opens `vscode://localpilot.localpilot-agent/run?prompt=…`, so it works from any terminal, script or alias. Set `LOCALPILOT_CODE_BIN` to point at a different VS Code build (Insiders, VSCodium).
