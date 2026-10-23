<p align="center">
  <a href="https://isathish.github.io/localpilot/"><img src="media/logo.png" width="112" alt="LocalPilot logo"></a>
</p>
<h1 align="center">LocalPilot</h1>
<p align="center"><strong>The AI coding agent that runs on your machine.</strong><br>
Copilot / Claude Code / Cursor-class agentic coding in VS Code — powered entirely by models you serve with <b>Ollama</b>, <b>LM Studio</b>, <b>llama.cpp</b> or <b>vLLM</b>. No accounts, no telemetry, no cloud.</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/actions/workflows/ci.yml"><img src="https://github.com/isathish/localpilot/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/isathish/localpilot/releases/latest"><img src="https://img.shields.io/github/v/release/isathish/localpilot?label=release&color=f2a33a" alt="Latest release"></a>
  <a href="https://github.com/isathish/localpilot/releases"><img src="https://img.shields.io/github/downloads/isathish/localpilot/total?color=4cc38a" alt="Downloads"></a>
  <a href="https://isathish.github.io/localpilot/"><img src="https://img.shields.io/badge/docs-website-111827" alt="Documentation"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/releases/latest/download/localpilot.vsix"><b>Download VSIX</b></a> ·
  <a href="https://isathish.github.io/localpilot/">Website</a> ·
  <a href="https://isathish.github.io/localpilot/docs/getting-started/">Documentation</a> ·
  <a href="https://isathish.github.io/localpilot/#compare">Compare</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## Why LocalPilot?

- **Private & offline** — your code only ever reaches the model servers you configure (localhost by default).
- **Frontier-style agent** — reads, searches, edits, runs commands and tests, fixes its own mistakes, asks before anything risky.
- **Built for local models** — automatic tool-calling fallback for models without function calling, aggressive context management so 8k–32k windows still finish long tasks.
- **Parallel by design** — run many agents at once, review every file each one touched, keep or undo per agent.
- **Drop-in for your existing setup** — honours `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` out of the box.
- **Free & MIT licensed.**

## Install

**From a release (recommended)**

```bash
curl -L -o localpilot.vsix https://github.com/isathish/localpilot/releases/latest/download/localpilot.vsix
code --install-extension localpilot.vsix
```

Or in VS Code: *Extensions → ··· → Install from VSIX…*. Requires VS Code 1.140+. The Marketplace listing is coming soon.

**Serve a model** (any one of these; default ports are auto-detected)

```bash
ollama pull qwen2.5-coder:14b && ollama serve        # Ollama  → :11434
# LM Studio → Developer tab → Start server             → :1234
# llama-server -m model.gguf --port 8080               → :8080
# vllm serve Qwen/Qwen2.5-Coder-32B-Instruct           → :8000
```

Open the LocalPilot icon in the Activity Bar (or <kbd>⌘⇧L</kbd>), pick a model, and ask for a change.

## Features

| | |
|---|---|
| **Agent · Ask · Plan modes** | Autonomous edit/run loop with approval gates; read-only Q&A; investigate-then-plan. |
| **Parallel agents** | `Run Tasks in Parallel` (<kbd>⌘⇧⌥P</kbd>) spawns one agent per task. The **Agents** panel shows live status and changed files. |
| **Change review** | Every agent edit is snapshotted — Diff / Keep / Undo per file or per session, with highlighted lines in the editor. |
| **Large-context management** | Per-model token budget → prune old tool outputs → LLM compaction → truncation. Live context meter. |
| **Skills & subagents** | `SKILL.md` playbooks loaded on demand; built-in `explore`, `coder`, `reviewer`, `researcher`; define your own with a model and tool allow-list. |
| **Screenshots & images** | Capture a screen region (<kbd>⌘⌥⇧S</kbd>), paste or drop images; vision models fix what they see. |
| **Inline edit & terminal** | <kbd>⌘⌥K</kbd> rewrites a selection in place; in a terminal it turns English into a reviewed command. |
| **Context mentions** | `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, `@file#L10-L20`, folders, drag-and-drop. |
| **Tools** | File ops, ripgrep search, symbols/references, shell, diagnostics, web search (DuckDuckGo / SearXNG / Brave / Tavily), web fetch, ask-user. |
| **MCP** | Any stdio MCP server's tools are exposed to the agent automatically. |
| **Inline completions** | Ghost text from FIM models (qwen2.5-coder, codestral, starcoder2). |
| **VS Code platform** | `@localpilot` chat participant, local models in Copilot's model picker (Language Model API), light-bulb fixes, context-menu actions, commit-message generator, status-bar model switcher. |
| **Multi-session** | Persisted per workspace; fork, pin, rename, export to Markdown. |

## Using it

- Switch **Agent / Ask / Plan** in the composer or with `/mode`.
- Type `@` to attach context, `/` for commands: `/help`, `/model`, `/compact`, `/clear`, `/skills`, `/agents`, `/skill <name> <task>`, `/agent <name> <task>`, `/context`.
- Code blocks have **Copy / Insert at cursor / Apply to file**; approvals appear inline with *Allow for session*.
- Right-click in an editor → **LocalPilot** → Explain · Fix · Refactor · Generate Tests · Add Documentation · Fix Errors in File.

## Skills, subagents and rules

```
.localpilot/skills/<name>/SKILL.md      # name + description front-matter, Markdown instructions
.localpilot/agents/<name>.md            # name, description, tools, model + system prompt body
.localpilot/rules.md · AGENTS.md · CLAUDE.md · .cursorrules · .github/copilot-instructions.md
```

Skills use progressive disclosure (only name + description are in the prompt until `load_skill` is called). Subagents run with a fresh context window and return only a final report. Full guide: [Skills & subagents](https://isathish.github.io/localpilot/docs/skills-and-agents/).

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
| Agentic coding | `qwen2.5-coder:14b/32b`, `qwen3`, `devstral`, `llama3.3`, `mistral-small`, `gpt-oss` |
| Inline completions | `qwen2.5-coder:1.5b/7b-base`, `codestral`, `starcoder2` |
| Screenshots / vision | `qwen2.5vl`, `llava`, `gemma3`, `pixtral` |

## Development

```bash
npm install
npm run compile     # type-check + lint + bundle
npm run smoke       # offline tests (mock Ollama/OpenAI servers, agent loop)
npm test            # Extension Host tests
npm run release -- patch   # bump, changelog, tag, push → GitHub Release
```

Press <kbd>F5</kbd> for an Extension Development Host. Architecture notes: [Development](https://isathish.github.io/localpilot/docs/development/).

## Contributing & support

Issues and pull requests are welcome — see [open issues](https://github.com/isathish/localpilot/issues). If LocalPilot is useful to you, a GitHub star helps others find it.

## License

[MIT](LICENSE) © Sathish and LocalPilot contributors.
