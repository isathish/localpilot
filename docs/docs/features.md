---
title: Features
description: Overview of what LocalPilot does in VS Code, with links to the detailed page for each area.
permalink: /docs/features/
---

![LocalPilot agent session in VS Code: read cart.js and its test, a +1/−1 edit, npm test passing in the LocalPilot Agent terminal, and Apply to workspace / Discard]({{ '/assets/screenshots/hero-agent.png' | relative_url }})

This page lists what LocalPilot can do. Each section links to the page with the details.

## Chat and agent

- **Five modes.** Agent edits and runs commands. Multitask splits work across background workers. Debug reproduces a bug before fixing it. Plan writes a plan without editing. Ask answers read-only. See [Agent modes]({{ '/docs/agent-modes/' | relative_url }}).
- **Approvals.** Shell commands and deletes ask first by default; file edits and web access are allowed. Each action can be set to `always`, `ask` or `never`.
- **Streaming transcript.** Tool steps, reasoning ("thinking") and status stream as they happen. The turn header shows the model's output speed (for example `~38 tok/s · 12s`).
- **Work strip.** Each turn opens with one line that says what the agent is doing, how many steps, files and commands so far, and for how long. When the turn ends it becomes *Worked for 1m 12s · 9 steps · …*.
- **Folded steps.** A burst of reads and searches collapses into one row (*Read a.ts, b.ts +2 more · Searched 3 times*). Edits group the same way. Web search results show as link cards.
- **Sessions.** Chats are saved per workspace. Several can run at once in the tab bar. You can fork, pin, rename and export a chat to Markdown.
- **Edit and restore.** **Edit** on one of your messages removes it and later turns and puts the text back in the composer. **Restore checkpoint** also rewinds the files changed since that turn.
- **Slash commands.** `/help`, `/model`, `/mode`, `/compact`, `/clear`, `/skills`, `/agents`, `/commands`, `/skill`, `/agent`, `/memory`, `/permissions`, `/hooks`, `/context`.
- **Chat location.** Put the chat in the Primary Side Bar, Secondary Side Bar, bottom Panel or an editor tab with **Move Chat To…** (`localpilot.chat.location`). The Agents view and the activity bar icon stay in the Primary Side Bar, so you can always get back.

## Parallel agents

![Three agents running in parallel: a tab per task, pause and stop for each, the Agents panel and the status bar count]({{ '/assets/screenshots/parallel-agents.png' | relative_url }})

- **Run Tasks in Parallel** (<kbd>⌘⇧⌥P</kbd>) starts one agent per task, each in its own tab.
- **Isolated worktrees.** In a git repository each agent chat works in its own git worktree by default (`localpilot.worktrees.mode`: `always`, `parallel` or `off`). You review its changes and **Apply to workspace** or **Discard**.
- **Best of N.** Run one task on 2 to 8 models at once, compare the results and apply the one you prefer.
- **Pause, steer, stop.** Pause an agent after its current step, type a correction, then resume. Each subagent lane has its own pause and stop.
- **Model spreading.** When a model is busy, parallel workers can run on a comparable idle model (`localpilot.routing.parallelModels`, default on).
- **Agents panel.** Running and idle sessions, the files each one changed, and inline Stop, Keep and Undo.

See [Parallel agents & change review]({{ '/docs/parallel-agents/' | relative_url }}).

## Change review

![Side-by-side diff of the agent's edit, opened from the changed-file list in the chat]({{ '/assets/screenshots/review-diff.png' | relative_url }})

- LocalPilot snapshots each file before the agent edits it.
- The changes bar above the composer lists every changed file. Click one for a diff, or accept or reject per file or all at once.
- Changed lines are highlighted in open editors.
- Changes are tracked per session, so rejecting one agent's work does not touch another's.

## Models

- **Auto-detection.** At startup LocalPilot probes the default local ports (Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Jan, SGLang, KoboldCpp) and running Docker containers of known model servers.
- **Automatic setup.** With no model anywhere, LocalPilot can install or start Ollama and download a starter model sized for your RAM and GPU. See [Automatic setup]({{ '/docs/models/#automatic-setup' | relative_url }}).
- **Model manager and catalog.** **Settings → Models** shows your hardware budget and marks each catalog size as fits, tight or too big. Install to Ollama, Docker Model Runner or LM Studio.
- **Automatic routing.** Image turns go to a vision model, completions to a small fill-in-the-middle model, and Plan mode optionally to a reasoning model. If the chosen model is offline, LocalPilot falls back to another.
- **colibri support.** LocalPilot detects a running `coli serve` from [colibri](https://github.com/JustVugg/colibri), which runs very large mixture-of-experts models by streaming experts from disk. Models that stream from disk are slow (about 1 token per second or less). See [Models & providers]({{ '/docs/models/' | relative_url }}) and the [colibri guide]({{ '/guides/colibri-vscode/' | relative_url }}).
- **Usage-based model tuning.** LocalPilot learns from your local run history which installed model works best for each role, and adjusts routing (`localpilot.models.autoTune`: `auto`, `suggest` or `off`). Manual picks are respected, and every automatic change has Undo. See [Models & providers]({{ '/docs/models/' | relative_url }}).

Small local models are weaker than frontier cloud models. Expect to give more precise instructions and to review more.

## Context

- Per-model token budget. Old tool output is pruned first, then history is summarised, then truncated as a last resort.
- `@` mentions: `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, `@terminal`, files, `file#L10-L20` ranges and folders.
- Project rules load from `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md` and `.localpilot/rules.md`.
- Memory notes in `.localpilot/memory/` (project) or user storage (global) are recalled in later sessions. See [Memory & planning]({{ '/docs/memory-and-planning/' | relative_url }}).

See [Context]({{ '/docs/context/' | relative_url }}).

## Tools

The agent can use:

- Files: read, edit, write, list, delete.
- Search: ripgrep search, symbol and reference lookup, `analyze_workspace` (a repository map that needs no model call).
- Shell: commands with destructive-command detection, diagnostics.
- Planning: `manage_todos`, memory save/read/list/delete.
- Web: search (DuckDuckGo, SearXNG, Brave, Tavily) and fetch.
- Browser: `open_browser`, `browser_screenshot`, `browser_inspect`.
- Delegation: `load_skill`, `run_subagent`, `run_parallel_subagents`, `run_todos_parallel`.
- Any tool from an MCP server you add. See [MCP]({{ '/docs/mcp/' | relative_url }}).

## Skills and subagents

- 14 built-in skills (`SKILL.md` files) load on demand. A workspace or user skill with the same name overrides a built-in one.
- Requests are matched against installed skills, and matches show as chips under the turn. Force one with `/skill <name> <task>`.
- Install skills from GitHub, a URL or a local folder with *LocalPilot: Install Skill…* or `/skill install <source>`.
- 9 built-in subagents: `clarifier`, `explore`, `planner`, `coder`, `tester`, `debugger`, `reviewer`, `docs`, `researcher`. Define your own in `.localpilot/agents/*.md`.

See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Claude Code compatibility

LocalPilot reads Claude Code `settings.json` permissions, hooks (including `SessionEnd`), custom commands and plugins. See [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).

## Images and browser

- Screenshot modes (<kbd>⌘⌥⇧S</kbd>): selection area, this VS Code window, pick a window, full screen, full screen after 5 s. You can also paste, drag and drop, or pick a file.
- Images are downscaled before sending. LocalPilot warns if the model has no vision support.
- The agent can screenshot web pages and local dev servers with headless Chromium and run a DevTools inspection (console, network, performance, layout).

See [Screenshots & images]({{ '/docs/images/' | relative_url }}).

## Editor integration

- **Inline edit** (<kbd>⌘⌥K</kbd>): rewrite in place with Keep / Undo. In a terminal, the same key generates a command.
- **Light bulb**: Fix or Explain diagnostics; Edit a selection.
- **Context menu**: Explain, Fix, Refactor, Generate Tests, Add Documentation, Fix Errors in File.
- **Commit message** generator in the Source Control view.
- **Inline completions** from fill-in-the-middle models.
- **Markdown reader**: a reading panel for long answers and documents the agent writes (plans, reports, notes).

![An Ask-mode answer: numbered steps, inline code, and a syntax-highlighted code block with Copy, Insert and Save actions]({{ '/assets/screenshots/chat-rendering.png' | relative_url }})

## Terminal and CLI

- Agent commands run in a visible **LocalPilot Agent** terminal.
- Right-click a terminal for **Explain Terminal Output**, **Fix Failed Command** and **Add Terminal Output to Chat**.
- The `localpilot` CLI runs the agent in any shell, with approvals, a REPL, `models`, `doctor` and skill commands.

See [Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}).

## Dashboard

*LocalPilot: Open Dashboard* shows what LocalPilot did on this machine: runs, tokens, speed per model, tool failures, completion acceptance and provider health. It also has a **Model tuning** card and a log viewer. The data is local JSONL in `~/.localpilot/telemetry`. See [Dashboard]({{ '/docs/dashboard/' | relative_url }}) and [Privacy]({{ '/privacy/' | relative_url }}).

## Settings and setup

- **Welcome / Setup** wizard on first run: detects servers, recommends a model, sets an approval preset.
- **Settings screen** (gear icon in the chat toolbar): the Dashboard on top, then collapsible groups for models (providers, models, model gallery), the agent (approvals, skills and subagents, inline completions), tools (MCP servers, web search) and data (memory and history, advanced). The sidebar folds to an icon rail. Each value shows whether it comes from User or Workspace settings.
- **Approval presets**: *Careful*, *Balanced*, *Autonomous*, or per-action Ask / Allow / Block.
- **Provider manager**: add a server from a preset, edit it, and **Test connection** to see latency and models.

![Memory & history page: chat count, messages and size on disk, how many chats to keep and how many transcripts stay in memory]({{ '/assets/screenshots/settings-memory.png' | relative_url }})

## VS Code platform

- `@localpilot` participant in the built-in Chat view (`/agent`, `/ask`, `/plan`).
- Local models are registered through the Language Model Chat Provider API, so they appear in Copilot's model picker.
- Extension API: `activate()` exports functions such as `runPrompt`, `runParallel`, `runBestOfN`, `send`, `stop`, `applyWorktree` and `listModels`. See [Development]({{ '/docs/development/' | relative_url }}).
