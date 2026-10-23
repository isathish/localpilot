# Changelog

All notable changes to LocalPilot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased
### Changed
- Minimum VS Code version lowered from 1.140 to **1.104** — the oldest release with the finalized Language Model provider API (`vscode.lm.registerLanguageModelChatProvider`) that LocalPilot depends on. Fixes “not compatible with the current version of Visual Studio Code” when installing on 1.1xx builds.

## 0.1.4 — 2026-10-23
### Added
- **Persistent memory**: the agent saves and recalls durable notes (`memory_save` / `memory_read` / `memory_list` / `memory_delete`) in `.localpilot/memory/` (project, commit-able) and global storage (user). A compact index is injected into every prompt; *LocalPilot: Open Memory Notes* opens the folder.
- **Planning checklist**: `manage_todos` tool and a live **Tasks** panel with progress bar; the agent plans multi-step work first and updates each step as it goes. Plan mode now emits the checklist too.
- **`localpilot` CLI**: *Install 'localpilot' Command in PATH* writes a shim so `localpilot "fix the tests"`, `--plan`, `--ask`, `--file`, `--parallel` start agents in the current folder via a `vscode://` URI handler.
- **Multitasking tab strip** in the chat view: running sessions first with spinners, `+` to start another agent in parallel.
- **Loading & streaming UI**: top progress bar while running, typing indicator before the first token, streaming caret, shimmer on running tool steps, *Thought for Ns* timer.
- `localpilot.thinking` levels `off|on|low|medium|high` (Ollama `think`, OpenAI `reasoning_effort`); `localpilot.keepAlive` keeps the Ollama model loaded between turns; `localpilot.memory.enabled`.
- Website: **Ask AI** buttons on every docs page and in the footer — open ChatGPT, Claude, Perplexity or Gemini (Google AI Mode) with a page-aware prompt pre-filled; **Copy page as Markdown** and **View as Markdown** on docs pages; `/llms.txt` index for LLM crawlers.
- Website: full footer with Product, Documentation, Guides, Works-with and Community columns, a Topics strip linking every target keyword, and privacy/trademark notices.

### Changed
- **Caching**: identical read-only tool calls are served once per turn (including concurrent duplicates) and show a *cached* badge; mutating tools invalidate the cache. `@workspace` file tree is cached with file-watcher invalidation.
- **Context**: the prompt now carries the session's working set (files read/edited) and current checklist, so compaction no longer loses track of progress.
- Website: Google tag (gtag.js) now loads whenever `google_analytics` is configured (previously only in the `production` Jekyll environment) and reports `ask_ai`, `click_install`, `download_vsix`, `click_github` and `copy_markdown` events.

## 0.1.3 — 2026-10-23
### Changed
- New icon: amber tile with a bold graphite mark — crisp at 16–128 px and on light or dark backgrounds.
- Dedicated, concise Marketplace listing page (no duplicate logo or badge wall); shorter description; categories AI / Chat / Machine Learning.

## 0.1.2 — 2026-10-23
### Changed
- Extension identifier is now `localpilot.localpilot-agent` with Marketplace display name “LocalPilot Agent” (the previous name was already taken on the Marketplace). Settings, commands and the `@localpilot` chat participant are unchanged.
- Website: light and dark themes (follows the OS by default, manual toggle persisted, no flash on load), higher-contrast text colours, larger base type and improved line-height; per-build stylesheet cache-busting.
- Website: Google Analytics, SEO metadata, structured data, social card, robots.txt and setup guides.

### Added
- Manual *Publish to Marketplace* workflow with publisher pre-check; CI publishes automatically on release when `VSCE_PAT` is set.

## 0.1.1 — 2026-10-23
### Changed
- New restrained brand palette (graphite + amber) for the logo, marketplace banner and website; removed gradient/glow styling.
- Website: fixed hero logo alignment, replaced text glyphs with CSS icons, fixed the docs "Edit this page" link.

### Added
- `npm run release -- <version|patch|minor|major>` cuts a release end to end (version bump, changelog promotion, verification, tag, push).
- Windows-compatible smoke test runner.

## 0.1.0 — 2026-10-23

Initial public release.

### Added
- **Providers**: Ollama (native API) and any OpenAI-compatible server (LM Studio, llama.cpp, vLLM/SGLang, Unsloth GGUF, LocalAI, Jan, OpenRouter…) with automatic model discovery and capability detection.
- **Agent / Ask / Plan modes** with streaming, tool calling, approval gates, and a prompt-based tool protocol for models without native function calling.
- **Tools**: file read/edit/write/list/delete, ripgrep search, symbol & reference lookup, shell commands, diagnostics, web search (DuckDuckGo, SearXNG, Brave, Tavily), web fetch, ask-user, skills and subagent delegation.
- **Parallel agents**: concurrent sessions, *Run Tasks in Parallel*, Agents panel with live status, bounded parallel tool execution and `run_parallel_subagents`.
- **Change review**: per-session file snapshots with Diff / Keep / Undo and editor line highlights.
- **Large-context management**: token budgeting, tool-output pruning, LLM compaction, context meter.
- **Skills & subagents** (`SKILL.md`, `.localpilot/agents/*.md`), compatible with `.claude/` and `.github/skills` layouts; built-in `explore`, `coder`, `reviewer`, `researcher`.
- **Project rules** auto-loaded from `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `.github/copilot-instructions.md`, `.localpilot/rules.md`.
- **Context mentions**: `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, files, line ranges, folders; drag-and-drop attachments.
- **Screenshots & images** for vision models: OS screenshot capture, paste, drag-drop, picker, Explorer menu.
- **Editor integration**: inline edit (`⌘⌥K`), terminal command generation, light-bulb Fix/Explain actions, context-menu actions, commit-message generation, FIM inline completions.
- **VS Code platform**: `@localpilot` chat participant, Language Model Chat Provider (local models in Copilot's picker), status-bar model switcher.
- **MCP** stdio client exposing server tools to the agent.
- Multi-session persistence with fork, pin, rename, export.
