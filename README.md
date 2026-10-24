<p align="center">
  <a href="https://isathish.github.io/localpilot/"><img src="media/logo.png" width="112" alt="LocalPilot logo"></a>
</p>
<h1 align="center">LocalPilot</h1>
<p align="center"><strong>The AI coding agent that runs on your machine.</strong><br>
An agent that reads your project, edits files, runs commands and tests, and shows you every diff — inside VS Code, powered entirely by models you serve with <b>Ollama</b>, <b>LM Studio</b>, <b>llama.cpp</b>, <b>vLLM</b> or <b>Docker Model Runner</b>. No accounts, no telemetry, and nothing leaves your machine unless you point it at a remote endpoint.</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/actions/workflows/ci.yml"><img src="https://github.com/isathish/localpilot/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=localpilot.localpilot-agent"><img src="https://img.shields.io/visual-studio-marketplace/v/localpilot.localpilot-agent?label=marketplace&color=0078d4" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=localpilot.localpilot-agent"><img src="https://img.shields.io/visual-studio-marketplace/i/localpilot.localpilot-agent?color=4cc38a" alt="Installs"></a>
  <a href="https://github.com/isathish/localpilot/releases/latest"><img src="https://img.shields.io/github/v/release/isathish/localpilot?label=release&color=f2a33a" alt="Latest release"></a>
  <a href="https://isathish.github.io/localpilot/"><img src="https://img.shields.io/badge/docs-website-111827" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>
<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=localpilot.localpilot-agent"><b>Install from Marketplace</b></a> ·
  <a href="https://github.com/isathish/localpilot/releases/latest/download/localpilot.vsix">Download VSIX</a> ·
  <a href="https://isathish.github.io/localpilot/">Website</a> ·
  <a href="https://isathish.github.io/localpilot/docs/getting-started/">Documentation</a> ·
  <a href="https://isathish.github.io/localpilot/#compare">Compare</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---


<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/hero-agent.png" alt="LocalPilot in VS Code: the agent fixed applyDiscount in cart.js, ran npm test (2 passing) in the LocalPilot Agent terminal and offers Accept / Reject" width="900"></p>
<p align="center"><sub>Captured from a normal session: <code>qwen2.5-coder:7b</code> in Ollama fixed a failing test, ran the suite and asked for review.</sub></p>

## Why LocalPilot?

**It costs nothing per month, and you can check for yourself that it is private.**

| Per developer | LocalPilot | GitHub Copilot Pro / Pro+ | Cursor Pro | Claude Pro / Max |
|---|---|---|---|---|
| Per month | **$0** | $10 / $39 | $20 | $20 / $100–200 |
| Team of 10, per year | **$0** | $1,200 / $4,680 | $2,400 | $2,400 / $12,000+ |
| Works with the network unplugged | **Yes** | No | No | No |
| Where your code is processed | **Your laptop** | Vendor cloud | Vendor cloud | Vendor cloud |

<sub>Published list prices for individual plans (USD) at the time of writing; vendors change plans and limits often. With LocalPilot you pay only for your own electricity — a 7B coding model needs ~8 GB RAM, 14B–32B models 16–32 GB.</sub>

**Three checks, under a minute.** Turn off Wi‑Fi: LocalPilot keeps editing and running tests. Open *Settings → Providers*: every address is `localhost` unless you added one. Read the source: it is MIT-licensed, and `npm test` runs against your own Ollama.

- **Private and offline.** Your code only reaches the model servers you list, and the defaults are `localhost`. No account, no telemetry SDK, no update check.
- **A full agent.** It reads, searches, edits, runs commands and tests, retries when something fails and asks before anything risky.
- **Written for local models.** A text fallback for models without tool calling, and context trimming so 8k to 32k windows still finish long tasks.
- **Parallel agents.** Run several at once, see every file each one touched, keep or undo per agent.
- **Pause, steer, stop.** Pause any agent after its current step, type new instructions it picks up on resume, or stop it — for the whole run or a single parallel subagent.
- **Works with your existing setup.** Reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` as they are.
- **Free, MIT licensed.**

## Install

**From the VS Code Marketplace (recommended)** — search for **LocalPilot Agent** in the Extensions view, or:

```bash
code --install-extension localpilot.localpilot-agent
```

**From a GitHub release**

```bash
curl -L -o localpilot.vsix https://github.com/isathish/localpilot/releases/latest/download/localpilot.vsix
code --install-extension localpilot.vsix
```

Requires VS Code 1.104+.

**Serve a model** — or let LocalPilot do it: with no model found it offers **Set up automatically**, which starts or installs Ollama and downloads a starter coder model sized for your machine. Any of these works too (running servers are auto-detected, including ones in Docker):

```bash
ollama pull gemma4:e4b && ollama serve               # Ollama  → :11434
# LM Studio → Developer tab → Start server             → :1234
# llama-server -m model.gguf --port 8080               → :8080
# vllm serve google/gemma-4-12B-it                     → :8000
# docker model pull ai/gemma4:e4b                      → Docker Model Runner :12434
# docker run -p 11434:11434 ollama/ollama              → any model-server container
```

Open the LocalPilot icon in the Activity Bar (or <kbd>⌘⇧L</kbd>) and ask for a change — **Auto** picks the best tool-capable model it found.

## Features

| | |
|---|---|
| **Agent · Ask · Plan modes** | Autonomous edit/run loop with approval gates; read-only Q&A; investigate-then-plan with a live **Tasks** checklist. |
| **Parallel agents & multitasking** | Chat tabs run independently; `Run Tasks in Parallel` (<kbd>⌘⇧⌥P</kbd>) spawns one agent per task. The **Agents** panel shows live status and changed files. |
| **Pause / steer / stop** | **Pause** (<kbd>⌥Esc</kbd>) holds an agent after its current step; anything you type while it is paused or running is queued and read at its next step; **Stop** (<kbd>Esc</kbd>) cancels. Each parallel subagent lane has its own pause and stop; pausing or stopping the parent reaches all of them. Also in the tab menu, background strip, Agents panel, Command Palette and the CLI (Ctrl+Z / Ctrl+C). |
| **Change review & checkpoints** | Every agent edit is snapshotted — Diff / Accept / Reject per file or per session, and **Restore checkpoint** on any message rewinds files and conversation. |
| **Zero-config providers** | Auto-detects Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Jan, SGLang, KoboldCpp and model servers running in **Docker containers**; new ones are added to your settings automatically. |
| **Model manager & auto-setup** | One-click setup installs Ollama and a smallest-first starter set sized to your RAM / GPU. **Settings → Models** shows what fits this machine, lets you enable / disable, set default or remove installed models, and installs from a curated catalog to Ollama, Docker Model Runner or LM Studio with live progress. |
| **Automatic routing** | Image turns go to a vision model, completions to the smallest FIM model, Plan mode to an optional reasoning model; an offline or disabled model falls back to the best available one. |
| **Large-context management** | Per-model token budget → prune old tool outputs → LLM compaction → truncation. Live context meter; `/compact` on demand. |
| **Memory** | Durable project and global notes (`.localpilot/memory/`) the agent saves and recalls across sessions. |
| **Skills & subagents** | `SKILL.md` playbooks loaded on demand and recommended as you chat; built-in `clarifier`, `explore`, `planner`, `coder`, `tester`, `debugger`, `reviewer`, `docs`, `researcher`; define your own with a model and tool allow-list. Recurring requests with no skill get a one-click *Create skill*. |
| **Understands terse requests** | "fix this", "make it faster": the agent reads the editor, open files, errors and git changes, states *Understood as: …* and proceeds — asking only when two readings would materially differ. |
| **Task splitting** | Big jobs become a checklist; independent items are delegated to subagents that run in parallel (`run_todos_parallel`) while the Tasks panel ticks them off. Read-only subagents route to a small fast model automatically. |
| **Browser view, screenshots & DevTools inspection** | The agent opens URLs in VS Code's Simple Browser, screenshots pages or local dev servers with a headless Chromium (desktop / phone / full-page), and inspects them over the DevTools Protocol — console errors and exceptions, network trace with failed requests, performance metrics, layout checks, optional click/type actions — rendered as a DevTools panel in the chat and attached to vision models. |
| **Screenshots & images** | Selection area, this VS Code window, pick a window, full screen or timed capture (<kbd>⌘⌥⇧S</kbd>); paste or drop images; vision models fix what they see. |
| **Inline edit & terminal** | <kbd>⌘⌥K</kbd> rewrites a selection in place; in a terminal it turns English into a reviewed command. |
| **Context mentions** | `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, `@file#L10-L20`, folders, drag-and-drop. |
| **Tools** | File ops, ripgrep search, symbols/references, shell, diagnostics, web search (DuckDuckGo / SearXNG / Brave / Tavily), web fetch, ask-user. |
| **MCP** | Any stdio MCP server's tools are exposed to the agent automatically; status and errors in Settings. |
| **Inline completions** | Ghost text from FIM models (qwen2.5-coder, codestral, starcoder2). |
| **`localpilot` CLI & API** | `localpilot "fix the tests"` from any terminal (`--plan`, `--ask`, `--parallel`); other extensions can drive agents through the exported API. |
| **VS Code platform** | `@localpilot` chat participant, local models in Copilot's model picker (Language Model API), light-bulb fixes, context-menu actions, commit-message generator, status-bar model switcher, Settings panel and setup wizard. |
| **Multi-session** | Persisted per workspace; fork, pin, rename, export to Markdown. |

## Using it

- Switch **Agent / Ask / Plan** in the composer or with `/mode`.
- Type `@` to attach context, `/` for commands: `/help`, `/model`, `/compact`, `/clear`, `/skills`, `/agents`, `/skill <name> <task>`, `/skill install <owner/repo|url>`, `/skill browse [words]`, `/agent <name> <task>`, `/context`.
- Code blocks have **Copy / Insert at cursor / Apply to file**; approvals appear inline with *Allow for session*.
- Right-click in an editor → **LocalPilot** → Explain · Fix · Refactor · Generate Tests · Add Documentation · Fix Errors in File.

## Skills, subagents and rules

```
.localpilot/skills/<name>/SKILL.md      # name + description front-matter, Markdown instructions
.localpilot/agents/<name>.md            # name, description, tools, model + system prompt body
.localpilot/rules.md · AGENTS.md · CLAUDE.md · .cursorrules · .github/copilot-instructions.md
```

Skills you do not have yet install themselves: requests are matched against a catalog of skill repositories (`anthropics/skills`, `obra/superpowers`, `github/awesome-copilot` by default — planning, design docs, debugging, PDF/Word/PowerPoint, architecture and more) and the best match is installed and loaded as the request starts (`localpilot.skills.autoInstall`: `auto` / `ask` / `off`). Browse them with **LocalPilot: Browse Skill Catalog…** or `localpilot skill search <words>`, or install anything from GitHub or a URL with **LocalPilot: Install Skill…** (`/skill install anthropics/skills/skills/pdf`, `localpilot skill install owner/repo`). Skills use progressive disclosure (only name + description are in the prompt until `load_skill` is called). Subagents run with a fresh context window and return only a final report. Full guide: [Skills & subagents](https://isathish.github.io/localpilot/docs/skills-and-agents/).

## Terminal & CLI

The agent runs its commands in a visible, branded **LocalPilot Agent** terminal (shell integration), so you watch `npm test` fail and pass while the agent fixes the code. Right-click any terminal for **Explain Terminal Output** / **Fix Failed Command**, or type `@terminal` in the chat.

The `localpilot` CLI is the same agent for your shell — same tools, skills, memory, MCP servers, approvals and undo, against your local models:

```bash
localpilot "fix the failing tests"      # agent mode, one task
localpilot --ask "what does main.ts do?"
localpilot                               # interactive session
localpilot models · localpilot doctor
```

Open it from VS Code (*LocalPilot: Open LocalPilot Terminal* — no install) or run *Install 'localpilot' CLI in PATH* for every terminal. Docs: [Terminal & CLI](https://isathish.github.io/localpilot/docs/terminal-and-cli/).

## Settings & first-run setup

LocalPilot has its own **Settings** screen (gear icon in the chat toolbar): a provider manager with **Test connection**, model and generation options, *Careful / Balanced / Autonomous* approval presets, inline completions, web search, memory & skills, and MCP servers — each value tagged with the scope it comes from and resettable individually. On first run a short **setup wizard** detects Ollama / LM Studio / llama.cpp / vLLM, recommends a model and picks an approval preset.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/settings-providers.png" alt="LocalPilot Settings — provider manager" width="800"></p>

## Configuration highlights

| Setting | Default | Purpose |
|---|---|---|
| `localpilot.providers` | Ollama, LM Studio, llama.cpp, vLLM on localhost | Model servers (`ollama` or any `openai`-compatible) |
| `localpilot.defaultModel` | auto | `provider/model`, e.g. `ollama/qwen2.5-coder:14b` |
| `localpilot.contextWindow` | 32768 | Requested context (Ollama `num_ctx`) |
| `localpilot.approvals.*` | terminal `ask` · write `always` · delete `ask` · network `always` | Autonomy level |
| `localpilot.parallel.maxConcurrency` | 4 | Concurrent tools / subagents |
| `localpilot.inlineCompletion.enabled` | false | Ghost-text completions |
| `localpilot.mcpServers` | `{}` | MCP servers (stdio) |

All settings: [Configuration](https://isathish.github.io/localpilot/docs/configuration/).

## Recommended models

| Task | Models |
|---|---|
| Agentic coding | `gemma4:e2b/e4b/12b` (recommended), `nemotron-3.5-bolt:e4b`, `devstral`, `gpt-oss`, `mistral-small`, `qwen3` |
| Inline completions | `starcoder2:3b`, `codestral`, `qwen2.5-coder:1.5b/7b-base` |
| Screenshots / vision | `gemma4`, `nemotron-3.5-bolt`, `qwen2.5vl`, `llava`, `gemma3`, `pixtral` |

## Development

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run smoke       # offline tests (mock Ollama/OpenAI servers, agent loop)
npm test            # Extension Host tests
npm run check:version      # package.json, lockfile, docs config and changelog agree
npm run release -- minor   # pick a specific bump; plain pushes to main auto-release a patch
```

Press <kbd>F5</kbd> for an Extension Development Host. Architecture notes: [Development](https://isathish.github.io/localpilot/docs/development/).

## Contributing & support

Issues and pull requests are welcome — see [open issues](https://github.com/isathish/localpilot/issues). If LocalPilot is useful to you, a GitHub star helps others find it.

LocalPilot is built and maintained by [Sathishkumar Nagarajan](https://github.com/isathish) (GitHub: [@isathish](https://github.com/isathish)).

## License

[MIT](LICENSE) © [Sathishkumar Nagarajan](https://github.com/isathish) and LocalPilot contributors.
