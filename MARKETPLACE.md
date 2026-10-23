# LocalPilot: a coding agent for VS Code that runs on your own machine

LocalPilot does what Copilot, Cursor and Claude Code do. It reads your project, edits files, runs tests and shows you the diff. The difference is where the model runs: every token comes from a server you host with **Ollama**, **LM Studio**, **llama.cpp**, **vLLM** or **Docker Model Runner** — or any OpenAI-compatible endpoint you choose to point it at. No subscription, no account, no telemetry.

**It costs nothing per month.** Cloud assistants charge $10 to $200 per developer and meter usage on top. LocalPilot runs on the laptop you already have and keeps working with the network unplugged. To check for yourself, open *Settings → Providers*: every address is `localhost` unless you added one. The source is MIT-licensed on GitHub.

## What it does

- **Agent mode** — reads your project, keeps a live task checklist, edits files, runs commands and tests, checks diagnostics and retries when something fails. You approve anything risky.
- **Ask & Plan modes** — read-only answers, or a reviewed implementation plan before any code changes.
- **Parallel agents & chat tabs** — run several tasks at once in independent tabs; the Agents panel shows live status and every file each agent touched.
- **Review every change** — diff, accept or reject per file or per agent, with changed lines highlighted; restore a checkpoint to rewind files and conversation.
- **Zero configuration** — auto-detects Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Jan, SGLang, KoboldCpp and model servers running in Docker containers, and picks the best tool-capable model.
- **Memory** — durable project and personal notes the agent saves and recalls across sessions.
- **Skills & subagents** — reusable `SKILL.md` playbooks (14 ship built in, from `requirements` to `deploy`) and nine specialised subagents (`explore`, `coder`, `reviewer`, `researcher`, `clarifier`, `planner`, `tester`, `debugger`, `docs`), or define your own.
- **Screenshots & images** — capture a selection, this VS Code window, another window or the full screen (optionally timed), paste or drop an image, and let a vision model fix what it sees.
- **Inline edit (⌘⌥K)** — describe a change and the selection is rewritten in place. In a terminal, it turns English into a reviewed command.
- **Context on demand** — `@workspace`, `@selection`, `@problems`, `@git`, `@file#L10-L20`; smart compaction keeps long tasks inside small context windows.
- **Web search & MCP** — DuckDuckGo / SearXNG / Brave / Tavily search, readable page fetch, and any MCP server's tools.
- **Inline completions** — ghost text from FIM models such as qwen2.5-coder or codestral.
- **`localpilot` CLI** — `localpilot "fix the failing tests"` from any terminal; `--plan`, `--ask`, `--parallel`.
- **Fits your setup** — reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` as they are.

## Get started in two minutes

1. Start a model server — for example:
   ```bash
   ollama pull gemma4:e4b
   ollama serve
   ```
   LM Studio, llama.cpp, vLLM, Docker Model Runner and model-server containers are detected automatically too.
2. Open the **LocalPilot** icon in the Activity Bar (or press `Ctrl/⌘ ⇧ L`).
3. Ask for a change. **Auto** picks the best model it found. Read the diff and accept it.

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

Models without native tool calling still work in agent mode; LocalPilot falls back to a text protocol and reads the tool calls out of the reply.

## Recommended models

- **Agent work:** `gemma4:e2b` / `:e4b` / `:12b` (recommended), `nemotron-3.5-bolt:e4b`, `devstral`, `gpt-oss`, `mistral-small`
- **Inline completions:** `starcoder2:3b`, `codestral`, `qwen2.5-coder:1.5b-base`
- **Screenshots:** `gemma4`, `nemotron-3.5-bolt`, `qwen2.5vl`, `llava`

## Also in VS Code

`@localpilot` in the built-in Chat view · local models in Copilot's model picker · light-bulb *Fix / Explain with LocalPilot* · right-click Explain, Fix, Refactor, Generate Tests, Add Docs · commit-message generator.

## Learn more

[Documentation](https://isathish.github.io/localpilot/docs/getting-started/) · [Website](https://isathish.github.io/localpilot/) · [Source & issues](https://github.com/isathish/localpilot) · [Changelog](https://github.com/isathish/localpilot/blob/main/CHANGELOG.md)

Free and open source under the MIT license. Built and maintained by [Sathishkumar Nagarajan](https://github.com/isathish).
