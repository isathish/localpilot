# LocalPilot — the AI coding agent that runs on your machine

Copilot-class agentic coding in VS Code, powered entirely by models you serve with **Ollama**, **LM Studio**, **llama.cpp**, **vLLM** or **Docker Model Runner**. No subscription. No accounts. No telemetry. Nothing leaves your computer.

**$0 per month instead of $10–$200 per developer.** Cloud assistants bill every seat every month and meter your usage; LocalPilot uses the laptop you already own — unplug the network and it keeps working. Check it yourself: *Settings → Providers* lists every address it talks to (all `localhost` unless you add a server), and the source is MIT-licensed on GitHub.

## What it does

- **Agent mode** — reads your project, plans with a live task checklist, edits files, runs commands and tests, checks diagnostics and fixes its own mistakes. You approve anything risky.
- **Ask & Plan modes** — read-only answers, or a reviewed implementation plan before any code changes.
- **Parallel agents & chat tabs** — run several tasks at once in independent tabs; the Agents panel shows live status and every file each agent touched.
- **Review every change** — diff, accept or reject per file or per agent, with changed lines highlighted; restore a checkpoint to rewind files and conversation.
- **Zero configuration** — auto-detects Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Jan, SGLang, KoboldCpp and model servers running in Docker containers, and picks the best tool-capable model.
- **Memory** — durable project and personal notes the agent saves and recalls across sessions.
- **Skills & subagents** — reusable `SKILL.md` playbooks and specialised `explore` / `coder` / `reviewer` / `researcher` agents, or define your own.
- **Screenshots & images** — capture a selection, this VS Code window, another window or the full screen (optionally timed), paste or drop an image, and let a vision model fix what it sees.
- **Inline edit (⌘⌥K)** — describe a change and the selection is rewritten in place. In a terminal, it turns English into a reviewed command.
- **Context on demand** — `@workspace`, `@selection`, `@problems`, `@git`, `@file#L10-L20`; smart compaction keeps long tasks inside small context windows.
- **Web search & MCP** — DuckDuckGo / SearXNG / Brave / Tavily search, readable page fetch, and any MCP server's tools.
- **Inline completions** — ghost text from FIM models such as qwen2.5-coder or codestral.
- **`localpilot` CLI** — `localpilot "fix the failing tests"` from any terminal; `--plan`, `--ask`, `--parallel`.
- **Fits your setup** — honours `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` automatically.

## Get started in two minutes

1. Start a model server — for example:
   ```bash
   ollama pull qwen2.5-coder:14b
   ollama serve
   ```
   LM Studio, llama.cpp, vLLM, Docker Model Runner and model-server containers are detected automatically too.
2. Open the **LocalPilot** icon in the Activity Bar (or press `Ctrl/⌘ ⇧ L`).
3. Ask for a change — **Auto** picks the best model it found. Review the diff, accept it, ship it.

## Works with

| Server | Endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| vLLM / SGLang | `http://localhost:8000/v1` |
| Docker Model Runner | `http://localhost:12434/engines/v1` |
| Ollama / vLLM / llama.cpp in Docker | discovered from the container's published port |
| Any OpenAI-compatible API | add it under **Settings → Providers** or `localpilot.providers` |

Models without native tool calling still work in agent mode thanks to a built-in prompt-based fallback.

## Recommended models

- **Agent work:** `qwen2.5-coder:14b` / `:32b`, `qwen3`, `devstral`, `llama3.3`, `mistral-small`
- **Inline completions:** `qwen2.5-coder:1.5b-base`, `codestral`, `starcoder2`
- **Screenshots:** `qwen2.5vl`, `llava`, `gemma3`

## Also in VS Code

`@localpilot` in the built-in Chat view · local models in Copilot's model picker · light-bulb *Fix / Explain with LocalPilot* · right-click Explain, Fix, Refactor, Generate Tests, Add Docs · commit-message generator.

## Learn more

[Documentation](https://isathish.github.io/localpilot/docs/getting-started/) · [Website](https://isathish.github.io/localpilot/) · [Source & issues](https://github.com/isathish/localpilot) · [Changelog](https://github.com/isathish/localpilot/blob/main/CHANGELOG.md)

Free and open source under the MIT license. Built and maintained by [Sathishkumar Nagarajan](https://github.com/isathish).
