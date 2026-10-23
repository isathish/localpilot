# LocalPilot — the AI coding agent that runs on your machine

Copilot-class agentic coding in VS Code, powered entirely by models you serve with **Ollama**, **LM Studio**, **llama.cpp** or **vLLM**. No accounts. No telemetry. Nothing leaves your computer.

## What it does

- **Agent mode** — reads your project, edits files, runs commands and tests, checks diagnostics and fixes its own mistakes. You approve anything risky.
- **Ask & Plan modes** — read-only answers, or a reviewed implementation plan before any code changes.
- **Parallel agents** — run several tasks at once; the Agents panel shows live status and every file each agent touched.
- **Review every change** — diff, keep or undo per file or per agent, with changed lines highlighted in the editor.
- **Skills & subagents** — reusable `SKILL.md` playbooks and specialised `explore` / `coder` / `reviewer` / `researcher` agents, or define your own.
- **Screenshots & images** — capture a screen region, paste or drop an image and let a vision model fix what it sees.
- **Inline edit (⌘⌥K)** — describe a change and the selection is rewritten in place. In a terminal, it turns English into a reviewed command.
- **Context on demand** — `@workspace`, `@selection`, `@problems`, `@git`, `@file#L10-L20`; smart compaction keeps long tasks inside small context windows.
- **Web search & MCP** — DuckDuckGo / SearXNG / Brave / Tavily search, readable page fetch, and any MCP server's tools.
- **Inline completions** — ghost text from FIM models such as qwen2.5-coder or codestral.
- **Fits your setup** — honours `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` automatically.

## Get started in two minutes

1. Start a model server — for example:
   ```bash
   ollama pull qwen2.5-coder:14b
   ollama serve
   ```
   LM Studio, llama.cpp and vLLM are detected on their default ports too.
2. Open the **LocalPilot** icon in the Activity Bar (or press `Ctrl/⌘ ⇧ L`).
3. Pick a model from the dropdown and ask for a change. Review the diff, keep it, ship it.

## Works with

| Server | Endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| vLLM / SGLang | `http://localhost:8000/v1` |
| Any OpenAI-compatible API | add it under `localpilot.providers` |

Models without native tool calling still work in agent mode thanks to a built-in prompt-based fallback.

## Recommended models

- **Agent work:** `qwen2.5-coder:14b` / `:32b`, `qwen3`, `devstral`, `llama3.3`, `mistral-small`
- **Inline completions:** `qwen2.5-coder:1.5b-base`, `codestral`, `starcoder2`
- **Screenshots:** `qwen2.5vl`, `llava`, `gemma3`

## Also in VS Code

`@localpilot` in the built-in Chat view · local models in Copilot's model picker · light-bulb *Fix / Explain with LocalPilot* · right-click Explain, Fix, Refactor, Generate Tests, Add Docs · commit-message generator.

## Learn more

[Documentation](https://isathish.github.io/localpilot/docs/getting-started/) · [Website](https://isathish.github.io/localpilot/) · [Source & issues](https://github.com/isathish/localpilot) · [Changelog](https://github.com/isathish/localpilot/blob/main/CHANGELOG.md)

Free and open source under the MIT license.
