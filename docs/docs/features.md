---
title: Features
description: A tour of everything LocalPilot can do.
permalink: /docs/features/
---

## Chat & agent

- **Agent mode** — autonomous loop: read → search → edit → run → verify, with approval gates for terminal, delete and network actions.
- **Ask mode** — read-only Q&A about your code.
- **Plan mode** — investigates and produces a numbered implementation plan without editing.
- **Streaming** responses with live tool steps, thinking (for reasoning models) and status.
- **Multiple sessions** persisted per workspace; several can run concurrently. Fork, pin, rename, export to Markdown.
- **Slash commands** — `/help`, `/model`, `/mode`, `/compact`, `/clear`, `/skills`, `/agents`, `/skill`, `/agent`, `/context`.

## Parallel agents & change review

- **Run Tasks in Parallel** (<kbd>⌘⇧⌥P</kbd>) spawns one agent per task.
- **Agents panel** lists running/idle sessions with live status, badge counts and inline Stop.
- **Change tracker** snapshots files before edits — Diff / Keep / Undo per file or per session, highlighted lines in editors.

## Context

- Per-model **token budgeting**; prunes old tool outputs, then **summarises** history (compaction), then truncates as a last resort.
- `@` mentions: `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, any file or `file#L10-L20`, folders.
- Attach via buttons, drag-and-drop, or the Explorer context menu.
- Project rules auto-loaded from `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `.localpilot/rules.md`.

## Tools

File read/edit/write/list/delete · ripgrep search · symbol & reference lookup · shell with destructive-command detection · diagnostics · open file · ask user · web search (DuckDuckGo, SearXNG, Brave, Tavily) · web fetch (HTML → readable text) · `load_skill` · `run_subagent` · `run_parallel_subagents` · any MCP server's tools.

## Skills & subagents

- Skills (`SKILL.md`) are loaded on demand via progressive disclosure.
- Built-in subagents: `explore`, `coder`, `reviewer`, `researcher`; define your own in `.localpilot/agents/*.md`.

## Images

- Capture a screenshot region (<kbd>⌘⌥⇧S</kbd>), paste, drag-drop, pick a file, or right-click an image in the Explorer.
- Client-side downscaling; thumbnails in chat; warns if the model lacks vision.

## Editor integration

- **Inline edit** <kbd>⌘⌥K</kbd> — Cursor-style in-place rewrite with Keep/Undo.
- **Terminal command generation** <kbd>⌘⌥K</kbd> in a terminal.
- **Light-bulb** actions: Fix / Explain with LocalPilot on diagnostics; Edit with LocalPilot on selections.
- Context menu: Explain, Fix, Refactor, Generate Tests, Add Documentation, Fix Errors in File.
- **Commit message** generator in the Source Control view.
- **Inline completions** from FIM models.

## VS Code platform

- `@localpilot` participant in the built-in Chat view (`/agent`, `/ask`, `/plan`).
- Local models registered through the **Language Model Chat Provider API** — they appear in Copilot's model picker.
- Status bar model switcher.
