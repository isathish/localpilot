<p align="center">
  <img src="media/logo.png" width="120" alt="LocalPilot logo">
</p>
<h1 align="center">LocalPilot</h1>
<p align="center"><strong>The AI coding agent that runs on your machine.</strong><br>
Copilot / Claude Code / Cursor-class agentic coding in VS Code — powered entirely by models you serve with Ollama, LM Studio, llama.cpp or vLLM.</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/actions/workflows/ci.yml"><img src="https://github.com/isathish/localpilot/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/isathish/localpilot/releases/latest"><img src="https://img.shields.io/github/v/release/isathish/localpilot?label=release&color=6366f1" alt="Release"></a>
  <a href="https://isathish.github.io/localpilot/"><img src="https://img.shields.io/badge/docs-isathish.github.io%2Flocalpilot-22d3ee" alt="Docs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/releases/latest/download/localpilot.vsix"><b>Download VSIX</b></a> ·
  <a href="https://isathish.github.io/localpilot/">Website</a> ·
  <a href="https://isathish.github.io/localpilot/docs/getting-started/">Documentation</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

| Capability | How |
|---|---|
| **Any local model server** | Ollama (native API), LM Studio, llama.cpp `llama-server`, vLLM, SGLang, Unsloth-served GGUF, LocalAI, Jan… — anything OpenAI-compatible. Add remote OpenAI-style APIs too. |
| **Agent mode** | Reads, searches, edits files, runs commands, checks diagnostics, fixes its own errors. Approval gates for terminal / delete / network. |
| **Ask & Plan modes** | Read-only Q&A and implementation planning. |
| **Multiple sessions** | Unlimited persisted sessions per workspace; several can stream **at the same time**. Fork, pin, rename, export. |
| **Large-context management** | Token budgeting per model; old tool outputs pruned first, then LLM summarisation (“compaction”), then truncation. Live context meter. |
| **Skills** | Progressive-disclosure playbooks (`SKILL.md` + front-matter) from `.localpilot/skills`, `.claude/skills`, `.github/skills`, `~/.agents/skills`. |
| **Subagents** | `explore`, `coder`, `reviewer`, `researcher` built in; define your own in `.localpilot/agents/*.md`. Each runs in its own fresh context window. |
| **Parallel processing** | Read-only tool calls in one turn run concurrently; `run_parallel_subagents` fans out work across a bounded pool. |
| **Web search & fetch** | DuckDuckGo (no key), self-hosted SearXNG, Brave, Tavily; HTML → readable text. |
| **MCP** | Plug in any stdio MCP server; its tools appear to the agent automatically. |
| **Inline completions** | Ghost text from FIM models (qwen2.5-coder, codestral, starcoder2, deepseek-coder). |
| **VS Code integration** | Sidebar chat + editor tab, `@localpilot` chat participant, local models exposed to Copilot's model picker via the Language Model API, editor context menu (Explain / Fix / Refactor / Tests / Docs), commit-message generator. |
| **Models without tool support** | Automatic fallback to a prompt-based tool protocol — small models still get agentic. |

## Quick start

1. Start a model server, e.g. `ollama serve && ollama pull qwen2.5-coder:14b`, or start the LM Studio local server.
2. Install / run the extension (F5 for development). Open the **LocalPilot** icon in the Activity Bar.
3. Pick a model from the dropdown (or the status bar item). Type a task. Done.

Default endpoints probed automatically: Ollama `:11434`, LM Studio `:1234/v1`, llama.cpp `:8080/v1`, vLLM `:8000/v1`. Edit `localpilot.providers` to add or change servers.

## Using it

- **Agent / Ask / Plan** selector in the composer; `/mode ask` also works.
- Attach context with the attach buttons or inline `@src/foo.ts`, `@src/foo.ts#L10-L40`; special mentions `@workspace`, `@selection`, `@problems`, `@git`, `@editors`.
- **Screenshots & images** (vision models): paste an image, drag one onto the composer, use the image button, or **Capture Screenshot** (`⌘⌥⇧S`) to grab a screen region straight into the chat.
- **Inline edit** (`⌘⌥K` in an editor, Cursor ⌘K-style): describe a change, the selection is rewritten in place with Keep/Undo.
- **Terminal command generation** (`⌘⌥K` in a terminal): natural language → shell command → Run / Insert / Copy.
- **Light-bulb actions**: "Fix with LocalPilot" / "Explain with LocalPilot" on any diagnostic; "Edit with LocalPilot…" on a selection.
- **Project rules** are loaded automatically from `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`.
- **Parallel agents**: `LocalPilot: Run Tasks in Parallel…` (`⌘⇧⌥P`) runs several agents at once; the **Agents** panel shows live status and per-session changed files with Diff / Keep / Undo.
- Slash commands: `/help`, `/model`, `/compact`, `/clear`, `/skills`, `/agents`, `/skill <name> <task>`, `/agent <name> <task>`, `/context`.
- Each code block has **Copy / Insert at cursor / Apply to file**.
- Approvals appear inline; "Allow for session" remembers your choice.

## Skills

```
.localpilot/skills/<name>/SKILL.md
---
name: deploy-checklist
description: Steps to safely ship a release of this service.
---
# instructions the model follows when the task matches…
```

The agent sees only the name + description up front and calls `load_skill` when relevant, so dozens of skills cost almost no context.

## Subagents

```
.localpilot/agents/<name>.md
---
name: migrator
description: Converts JS files to TypeScript one at a time.
tools: read_file, write_file, edit_file, run_command, get_diagnostics
model: ollama/qwen2.5-coder:32b
---
System prompt for the subagent…
```

The main agent delegates with `run_subagent` or `run_parallel_subagents`; a child never sees the parent's history, so each one gets a full context window.

## MCP servers

```jsonc
"localpilot.mcpServers": {
  "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } }
}
```

## Settings worth knowing

| Setting | Default | Purpose |
|---|---|---|
| `localpilot.defaultModel` | auto | `provider/model` |
| `localpilot.contextWindow` | 32768 | Requested context (Ollama `num_ctx`) |
| `localpilot.compactionThreshold` | 0.75 | When to summarise history |
| `localpilot.approvals.*` | terminal `ask`, write `always`, delete `ask`, network `always` | Autonomy level |
| `localpilot.parallel.maxConcurrency` | 4 | Concurrent tools / subagents |
| `localpilot.webSearch.provider` | duckduckgo | or `searxng`, `brave`, `tavily` |
| `localpilot.inlineCompletion.enabled` | false | Ghost-text completions |
| `localpilot.thinking` | false | Extended thinking for reasoning models |

## Development

```bash
npm install
npm run compile   # type-check + lint + bundle
npm run smoke     # offline tests with mock Ollama / OpenAI servers + agent loop
```

Press **F5** to launch an Extension Development Host.

## Recommended models

- Agentic coding with tools: `qwen2.5-coder:14b/32b`, `qwen3`, `devstral`, `llama3.3`, `mistral-small`, `gpt-oss`
- Fast FIM completions: `qwen2.5-coder:1.5b/7b-base`, `codestral`, `starcoder2`
- Vision (screenshots in chat): `qwen2.5vl`, `llava`, `gemma3`
