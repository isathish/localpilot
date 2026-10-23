# Changelog

All notable changes to LocalPilot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

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
