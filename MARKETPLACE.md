<h1 align="center">LocalPilot</h1>
<p align="center"><strong>The AI coding agent that runs on your machine.</strong></p>
<p align="center">Reads your project, edits files, runs tests, shows you every diff — in VS Code, on models you serve with <b>Ollama</b>, <b>LM Studio</b>, <b>llama.cpp</b>, <b>vLLM</b> or <b>Docker Model Runner</b>.<br>No subscription. No account. Your code never leaves your laptop.</p>
<p align="center">
  <a href="https://github.com/isathish/localpilot/actions/workflows/ci.yml"><img src="https://github.com/isathish/localpilot/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/isathish/localpilot/releases/latest"><img src="https://img.shields.io/github/v/release/isathish/localpilot?label=release&color=f2a33a" alt="Latest release"></a>
  <a href="https://github.com/isathish/localpilot/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <a href="https://isathish.github.io/localpilot/"><img src="https://img.shields.io/badge/docs-website-111827" alt="Documentation"></a>
</p>
<p align="center">
  <a href="https://isathish.github.io/localpilot/docs/getting-started/"><b>Getting started</b></a> ·
  <a href="https://isathish.github.io/localpilot/">Website</a> ·
  <a href="https://isathish.github.io/localpilot/#compare">Compare with Copilot &amp; Cursor</a> ·
  <a href="https://github.com/isathish/localpilot">Source</a>
</p>

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/hero-agent.png" alt="LocalPilot agent session in VS Code: it read cart.js and its test, fixed applyDiscount with a one-line edit, ran npm test (2 passing) in the LocalPilot Agent terminal and offers Apply to workspace / Discard" width="900"></p>
<p align="center"><sub>A real session: <code>gpt-oss:20b</code> in Ollama fixed a failing test in 37 s, ran the suite and asked for review.</sub></p>

<br>

<table align="center">
  <tr>
    <td align="center" width="33%"><b>$0 per month</b><br><sub>Cloud assistants cost $10–200 per developer. LocalPilot runs on hardware you already own.</sub></td>
    <td align="center" width="33%"><b>Private by construction</b><br><sub>Every provider address is <code>localhost</code> unless you add one. No telemetry leaves the disk.</sub></td>
    <td align="center" width="33%"><b>Works offline</b><br><sub>Unplug the network: it keeps editing, running tests and reviewing diffs.</sub></td>
  </tr>
</table>

<br>

## How it works

### 1 · Install, and it finds your model server

Open the **LocalPilot** icon in the Activity Bar (<kbd>Ctrl/⌘ ⇧ L</kbd>). A one-minute setup checks the usual local ports and lists every server it finds. Nothing running? **Set up automatically** installs Ollama and pulls a coder model sized for your machine.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/setup-detect.png" alt="Setup step 1: LocalPilot found a running Ollama at localhost:11434 with 4 models" width="880"></p>

### 2 · Pick a model and how careful the agent should be

Choose a default model (the recommended one calls tools and reads images), then a preset. **Careful** asks before every edit and command. **Balanced** (default) asks only for risky actions. **Autonomous** runs through. Both are one click to change later.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/setup-approvals.png" alt="Setup step 3: Careful, Balanced (the default) or Autonomous, and an optional switch for inline completions" width="880"></p>

### 3 · Describe the change, pick a mode

Type what you want — <i>"The discount test fails. Fix it."</i> **Agent** edits and runs. **Plan** investigates and writes a plan you approve first. **Ask** answers read-only. **Debug** reproduces, fixes, verifies. **Multitask** splits the work across background agents. **Auto** picks the best tool-capable model it found.

<table align="center">
  <tr>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/mode-picker.png" alt="Mode picker: Agent, Multitask, Debug, Plan and Ask, each with a one-line description" width="340"></td>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/model-picker.png" alt="Model picker: Auto plus every Ollama model with its context window, tool support and vision badge" width="340"></td>
  </tr>
  <tr>
    <td align="center"><sub>Five modes</sub></td>
    <td align="center"><sub>Every local model, with context size, tools and vision badges</sub></td>
  </tr>
</table>

### 4 · Watch it work. Approve what matters.

Every read, search, edit and command shows up as it happens. Before anything risky the agent stops: **Allow once**, **Allow for session** or **Deny**. Type while it runs to steer it, or **Pause** and **Stop** at any time.

<table align="center">
  <tr>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/approval.png" alt="The agent waits for approval before running git log --oneline -5, with Deny, Allow for session and Allow once" width="430"></td>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/pause-steer.png" alt="A paused agent with a queued steering message and a Resume button" width="430"></td>
  </tr>
  <tr>
    <td align="center"><sub>Approval gate</sub></td>
    <td align="center"><sub>Pause, steer, resume</sub></td>
  </tr>
</table>

### 5 · Review the diff. Apply or discard.

Every edit is snapshotted. Open a side-by-side diff per file, accept or reject per file or per session, and **Restore checkpoint** on any message to rewind files and conversation together. Tests run in a real terminal you can read.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/review-diff.png" alt="Side-by-side diff of cart.js: the agent's one-line fix to applyDiscount, with Apply to workspace and Discard in the chat" width="880"></p>

### 6 · Run several agents at once

Each tab is an independent agent in its own git worktree, so nothing collides. **Run Tasks in Parallel** (<kbd>Ctrl/⌘ ⇧ ⌥ P</kbd>) starts one agent per task — or runs one task on several models and lets you keep the best. The **Agents** panel shows live status and every file each one touched.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/parallel-agents.png" alt="Three agents running in parallel: a tab per task, pause and stop for each, the Agents panel and the status bar count" width="880"></p>

<table align="center">
  <tr>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/multitask-launcher.png" alt="The Multitask launcher: three tasks, one per row, with Add another task and ideas for this project" width="430"></td>
    <td align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/best-of-n-compare.png" alt="Compare Best-of-N results: gpt-oss:20b changed 1 file and passed the tests; qwen3:14b timed out. Pick one to apply it" width="430"></td>
  </tr>
  <tr>
    <td align="center"><sub>Split the work</sub></td>
    <td align="center"><sub>Try several models, keep the best</sub></td>
  </tr>
</table>

### 7 · Same agent in the terminal

`localpilot "fix the failing tests"` from any shell, with `--plan`, `--ask` and `--parallel`.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/terminal-cli.png" alt="The localpilot CLI in a terminal: it reads the code, edits test/cart.test.js, runs npm test (3 passing), prints a summary and lists the changed file" width="880"></p>

### 8 · See exactly where your code goes

**Settings → Providers** lists every server LocalPilot talks to, with live status. Every address is `localhost` unless you added one yourself.

<p align="center"><img src="https://isathish.github.io/localpilot/assets/screenshots/settings-providers.png" alt="LocalPilot Settings: Providers page with live connection status (Ollama and Docker Model Runner reachable, LM Studio not running) and one-click presets to add more" width="880"></p>

<br>

## Everything included

| Feature | What you get |
|---|---|
| **Agent · Plan · Ask · Debug · Multitask** | Autonomous edit-and-run loop with approval gates, a live task checklist, diagnostics checks and retries. |
| **Parallel agents** | Independent tabs, one worktree each, Best-of-N across models, live Agents panel, per-agent pause and stop. |
| **Change review & checkpoints** | Side-by-side diffs, accept or reject per file or session, restore any checkpoint. |
| **Zero-config providers** | Auto-detects Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Jan, SGLang, KoboldCpp and model servers in Docker. |
| **Memory** | Durable project and personal notes the agent saves and recalls across sessions. |
| **Skills & subagents** | 14 built-in `SKILL.md` playbooks and 9 subagents (`explore`, `coder`, `reviewer`, `tester`, `debugger`…). Install any skill from GitHub in one step; matching skills from `anthropics/skills`, `obra/superpowers` and `github/awesome-copilot` install themselves when needed. |
| **Screenshots & images** | Capture a selection, window or screen, paste or drop an image, and let a vision model fix what it sees. |
| **Inline edit** <kbd>⌘⌥K</kbd> | Describe a change and the selection is rewritten in place. In a terminal, English becomes a reviewed command. |
| **Context on demand** | `@workspace`, `@selection`, `@problems`, `@git`, `@file#L10-L20`; smart compaction keeps long tasks inside 8k–32k windows. |
| **Web search & MCP** | DuckDuckGo / SearXNG / Brave / Tavily, readable page fetch, and any MCP server's tools. |
| **Inline completions** | Ghost text from FIM models such as `qwen2.5-coder` or `codestral`. |
| **Markdown reader & movable chat** | A distraction-free reader for specs and plans; chat in the Primary or Secondary Side Bar, the Panel or an editor tab. |
| **Fits your setup** | Reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` and `.claude/agents` as they are. |
| **Also in VS Code** | `@localpilot` in the built-in Chat view, local models in Copilot's model picker, light-bulb fixes, right-click Explain / Fix / Refactor / Tests / Docs, commit-message generator. |

## Works with

| Server | Endpoint |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| vLLM / SGLang | `http://localhost:8000/v1` |
| Docker Model Runner | `http://localhost:12434/engines/v1` |
| Ollama / vLLM / llama.cpp in Docker | discovered from the container's published port |
| Any OpenAI-compatible API | add it under **Settings → Providers** |

Models without native tool calling still work in agent mode: LocalPilot falls back to a text protocol and reads the tool calls out of the reply.

## Recommended models

| Use | Models |
|---|---|
| **Agent work** | `gemma4:e2b` / `:e4b` / `:12b` (recommended), `nemotron-3.5-bolt:e4b`, `devstral`, `gpt-oss`, `mistral-small` |
| **Inline completions** | `starcoder2:3b`, `codestral`, `qwen2.5-coder:1.5b-base` |
| **Screenshots & images** | `gemma4`, `nemotron-3.5-bolt`, `qwen2.5vl`, `llava` |

A 7B coding model needs about 8 GB of RAM; 14B–32B models 16–32 GB.

## Quick start

```bash
ollama pull gemma4:e4b && ollama serve     # or LM Studio, llama.cpp, vLLM, Docker Model Runner
code --install-extension localpilot.localpilot-agent
```

Then press <kbd>Ctrl/⌘ ⇧ L</kbd>, follow the three setup steps and ask for a change.

<br>

<p align="center">
  <a href="https://isathish.github.io/localpilot/docs/getting-started/">Documentation</a> ·
  <a href="https://isathish.github.io/localpilot/">Website</a> ·
  <a href="https://github.com/isathish/localpilot/issues">Issues</a> ·
  <a href="https://github.com/isathish/localpilot/blob/main/CHANGELOG.md">Changelog</a>
</p>
<p align="center"><sub>Free and open source under the MIT license. Built and maintained by <a href="https://github.com/isathish">Sathishkumar Nagarajan</a>.</sub></p>
