# Changelog

All notable changes to LocalPilot are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## Unreleased
### Changed
- **Chat UI polish**: a consistent design system for the webview — one type scale (13 / 12 / 11 px, tabular numerals for stats), unified radii (6 / 8 / 12 px), theme-derived soft borders and tint layers instead of hard-coded greys, and LocalPilot's amber used sparingly as the brand accent (empty-state tile, progress bar, thinking step, running tab, task in progress, context ring). Cards (diff, terminal, approvals, Tasks, Changes) share the same header height, hover states and shadows; approvals use a left accent instead of a loud full border; exit codes are pills; keyboard hints render as key caps; the composer has a softer focus ring, borderless context chip and a rounded-square send button; popover and toasts match. Verified in light and dark themes.
- **Settings UI polish & responsiveness**: the Settings / setup webview now shares the chat's tokens (type scale, radii, soft borders, tint layers, brand accent) — unified card, badge, toggle, segmented-control and field styling with a soft focus ring; installed-model rows, activity jobs and catalog variants align in grids with consistent control widths; on narrow panels the sidebar becomes a scrollable pill bar under a compact sticky header, the hardware card, routing fields, catalog rows and setup footer reflow to one column, and nothing overflows horizontally. Includes a settings preview harness (`scripts/settings-preview.html`) for checking light/dark and widths.

## 0.2.4 — 2026-10-23
### Added
- **Zero-config auto-detection of model servers.** At startup and on *Refresh models*, LocalPilot probes the configured providers, the well-known local ports (Ollama, LM Studio, llama.cpp, vLLM, **Docker Model Runner** `12434`, Jan, SGLang, KoboldCpp) and **running Docker containers** (`docker ps` — Ollama, vLLM, llama.cpp, LocalAI, TGI, SGLang, model-runner, KoboldCpp images, using each container's published host port). Every reachable server that isn't configured yet is added to `localpilot.providers` automatically (existing entries are never changed) and a notification says what was found. If the configured default model is offline, LocalPilot uses the best available one and offers to make it the default.
- **Docker-based models**: a *Docker Model Runner* provider preset (`http://localhost:12434/engines/v1`, models like `docker/ai/qwen2.5-coder`), container discovery as above, and a one-click **Enable** prompt when the Model Runner is active but host (TCP) access is off. The setup wizard lists Docker servers too and marks newly found ones.
- MCP client tests that launch a real stdio MCP server and round-trip a tool call, and verify that an un-launchable server fails fast with its error shown in **Settings → MCP servers** ("failed to start" badge with the reason).
- `@localpilot` / Language Model API: image attachments (`LanguageModelDataPart`) are forwarded to vision models instead of being dropped; non-image attachments are inlined as text.

### Changed
- MCP servers that cannot be spawned (bad command, missing `npx`) fail immediately instead of hanging 30 s; on Windows they are launched through the shell so `npx`/`.cmd` launchers resolve.

## 0.2.3 — 2026-10-23
### Added
- **Settings screen** (*LocalPilot: Settings*, gear icon in the chat toolbar): a dedicated panel for every option — **Providers** (add from presets for Ollama, LM Studio, llama.cpp, vLLM, Jan, LocalAI, SGLang or a custom endpoint; edit URL/key/context/models; enable/disable; *Test connection* shows latency and the live model list), **Models & generation**, **Agent & approvals** with *Careful / Balanced / Autonomous* presets, **Inline completions**, **Web search**, **Memory & skills** (skill folders, discovered skills and subagents, open/clear notes), **MCP servers** (add/edit/remove, connection status and tool counts) and **Advanced**. Each value shows whether it comes from User or Workspace settings and can be reset individually; a scope toggle chooses where edits are written.
- **Welcome / Setup wizard** (*LocalPilot: Welcome / Setup*): detects running model servers, lists their models with a recommended default, and picks an approval preset and inline completions. Opens automatically on first run when no server is reachable (`localpilot.showWelcomeOnStartup`).
- **Getting Started walkthrough** in VS Code's Welcome page; commands *Manage Model Providers…* and *Clear Memory Notes…*; the Agents view and the chat's "no models" notice link straight to setup/providers.

- Deep links `vscode://localpilot.localpilot-agent/settings?section=…` and `/setup`, and matching `localpilot --settings` / `--setup` CLI flags.
- Integration tests (`npm test`, real VS Code) covering the settings panel commands, provider probing against an Ollama-style server, input sanitisation and configuration round-trips.
- **Real end-to-end tests** against a local Ollama server (skipped when none is running): the agent writes a file through a real tool call, two sessions run **in parallel** and each finishes its own task, and `stop()` aborts a streaming run. Tests run in a fresh temporary workspace folder.
- **Extension API** (`vscode.extensions.getExtension('localpilot.localpilot-agent').exports`): `runPrompt`, `runParallel`, `send`, `stop`, `getSession`, `runningSessionIds`, `onDidChangeRuns`, `listModels`, `version` — drive LocalPilot agents from other extensions or scripts.

### Fixed
- **Tool calls printed as text are now executed.** Small models (e.g. 1.5B coders) often emit `{"name": …, "arguments": …}` as plain text instead of using the tool channel; the agent loop now parses fenced, tagged and bare JSON calls for known tools whenever no native call arrives, so the run continues instead of stopping with a dead answer.
- `write_file` reports a clear error when given a directory path (such as `.`) instead of a raw filesystem failure; the system prompt now states how paths are resolved and that tools must be invoked, not described.
- Versions are no longer hard-coded: the MCP client advertises the real extension version, `package-lock.json` is bumped by the release script and the docs refer to `X.Y.Z` instead of a stale number.

### Changed
- "Open settings" in the chat and the no-model fallback now open the LocalPilot Settings panel instead of the generic VS Code settings editor.
- Finishing the setup wizard merges newly detected servers into `localpilot.providers` instead of replacing the list; MCP server entries are validated before being written; the first-run wizard never replaces a Settings panel the user already opened.

## 0.2.2 — 2026-10-23
### Added
- **Screenshot tool with capture modes** — the camera/attach button, the **@ Add context** menu and *LocalPilot: Capture Screenshot to Chat* now offer **Selection area** (drag a rectangle), **This VS Code window** (captured instantly, no interaction), **Pick a window**, **Full screen** and **Full screen in 5 s** (time to switch apps or open a menu). macOS uses `screencapture` (window id lookup via CoreGraphics, no screen-recording prompt); Linux uses gnome-screenshot / spectacle / scrot / grim+slurp / import+xdotool; Windows gets a translucent drag-to-select overlay, foreground-window capture and virtual-screen capture via PowerShell.

## 0.2.1 — 2026-10-23
### Changed
- **Responsive composer**: the bottom row never wraps. Below ~420px the mode picker, context button and attach button collapse to icons; below ~260px the model picker collapses to its icon too. Placeholder text adapts to the available width and the duplicated focus ring on the textarea is gone.
- **Multitasking tab bar is always visible**: running chats first (with spinners), then the active and recent ones; `+` starts another agent in parallel and a **History** button (badge = number of chats) opens a searchable popover with *New chat*, *Run tasks in parallel…*, running chats and recent chats.
- Permission prompts and the *Accept all / Reject all* bar collapse to compact buttons on narrow panels; the redundant kind label on approvals is hidden when it equals the title.

## 0.2.0 — 2026-10-23
### Changed
- **Chat UI redesigned** in the style of Cursor / Claude Code: custom Agent/Ask/Plan picker and searchable model picker (with *Auto*), an **@ Add context** menu (files, active selection, @workspace/@problems/@git/@editors, images, screenshots), consecutive read/search tools grouped as *Explored codebase · N files, M searches*, **diff cards** for edits with +/− counts and inline line diff, **terminal cards** for commands with exit codes, Claude-style permission prompts with *Allow once / Allow for session / Deny* and Y/A/N keys, hover actions on messages, prompt history (↑/↓), Esc to stop, ⌘I to add context, and a greeting-based empty state.
- **Restore checkpoint** on any user message: reverts files changed since that turn, truncates the conversation and puts the prompt back in the composer (per-turn snapshots in the change tracker).
- Changes bar renamed to *Accept all / Reject all*; new panel styling for Tasks and Changes.

## 0.1.5 — 2026-10-23
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
