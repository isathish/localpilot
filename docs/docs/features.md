---
title: Features
description: Everything LocalPilot does in VS Code, from setup to models, the agent, parallel work, change review, tools, the CLI and the dashboard, with links to the details.
permalink: /docs/features/
---

![LocalPilot agent session in VS Code: read cart.js and its test, a +1/−1 edit, npm test passing in the LocalPilot Agent terminal, and Apply to workspace / Discard]({{ '/assets/screenshots/hero-agent.png' | relative_url }})

LocalPilot is a coding agent for VS Code. It reads your project, edits files, runs commands and tests, and shows you every diff before you keep it. It runs on models on your machine. You can also add a cloud model with your own key, and automatic picks keep preferring local models. This page lists every feature in the order you meet them. Each section links to the details.

## 1. Get set up

- **First-run setup.** A three-step welcome checks the usual local ports, lists the servers it found and their models, recommends a model, and sets an approval preset. No server running? It links to adding a custom endpoint or a cloud API. See [Getting started]({{ '/docs/getting-started/' | relative_url }}).
- **Automatic model setup.** With no model anywhere, one click installs or starts Ollama, without admin rights, and downloads a starter model sized for your RAM and GPU, smallest first.
- **Background services.** LocalPilot keeps a local Ollama running while VS Code is open, and Redis when Redis storage is on. Failed restarts back off. *LocalPilot: Show Background Services* shows their state. Opt in to `localpilot.supervisor.autoInstall` to install Ollama and a starter model without being asked.
- **Models are picked up as they appear.** Servers are re-checked in the background, so a model you pull or a server you start shows up within seconds.

## 2. Pick your models

![Settings → Providers: providers grouped under Local and Cloud, each card showing where it runs, its API and its status]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

- **Local servers, detected automatically:**
  - Ollama, LM Studio, llama.cpp, vLLM, SGLang, Docker Model Runner, Jan, LocalAI, KoboldCpp, GPT4All and text-generation-webui
  - model servers running in Docker containers
- **Cloud APIs with your own key:**
  - OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, DeepSeek and xAI
  - Together, Fireworks, Cerebras, Hugging Face, NVIDIA NIM, Moonshot, Alibaba Qwen, Azure OpenAI and Ollama Cloud

  Claude uses its native API, with tool use, thinking and prompt caching. See [Cloud models]({{ '/guides/cloud-models-vscode/' | relative_url }}).
- **Gateways.** OmniRoute and LiteLLM run on your machine and forward to many cloud providers. They are treated as cloud. See [OmniRoute & LiteLLM]({{ '/guides/omniroute-vscode/' | relative_url }}).
- **Keys stay out of settings.json.** A pasted key goes to your OS keychain, and settings hold only `${secret:<id>}`. A key can also come from an environment variable (`${env:OPENAI_API_KEY}`). The provider card says when a key is missing, never what it is.
- **Local first, cloud when you choose.** Cloud models are marked **cloud** everywhere. Auto, subagents, images and ghost text prefer local models and use a cloud model only when nothing local fits, or when you pick it.
- **Model manager.** **Settings → Models** shows what this machine can run (a model budget from RAM and GPU), what is installed, and which model handles which task. It installs from a curated catalog to Ollama, Docker Model Runner or LM Studio.
- **Model gallery.** Search the Ollama library, Docker Hub's `ai/` models and Hugging Face GGUF repositories. Every size is marked *fits*, *tight* or *too big*.
- **Automatic routing.** Images go to a vision model, ghost text to a small fill-in-the-middle model, Plan mode to an optional reasoning model, and read-only subagents to a small fast model. An offline model falls back to the best available one.
- **Thinking chosen per task** (`localpilot.thinking`: `auto`). More reasoning for Plan and Debug, medium for the agent, light for Ask and subagents, none for quick helpers.
- **Learns which models work for you.** Local run history (finished runs, speed, errors, accepted completions) ranks your installed models per role. Auto routing follows the rankings, with Undo (`localpilot.models.autoTune`).
- **Fast local starts.** The model loads when you focus the chat box. Models already in memory are preferred. Ollama starts with flash attention and a q8_0 KV cache, which uses about half the memory of f16.
- **Huge MoE models with colibri.** A running `coli serve` is detected. Memory fit uses only the part that stays in RAM. See the [colibri guide]({{ '/guides/colibri-vscode/' | relative_url }}).
- **Failures handled for you.**
  - Cloud rate limits are waited out as long as the provider asks.
  - Parameters a model rejects are adjusted, and the fix is remembered.
  - A rejected key or an exhausted quota is reported at once, with where to fix it.

See [Models & providers]({{ '/docs/models/' | relative_url }}).

## 3. Work with the agent

- **Five modes.**
  - **Agent** edits and runs commands.
  - **Multitask** splits work across background workers.
  - **Debug** reproduces a bug before fixing it.
  - **Plan** writes a plan without editing.
  - **Ask** answers read-only.

  See [Agent modes]({{ '/docs/agent-modes/' | relative_url }}).
- **Questions before it starts.** For a new feature or an open-ended request, the agent reads the code first. Then it asks up to four questions in one card. Each option explains itself and one is marked **Recommended**. You answer with <kbd>1</kbd>–<kbd>9</kbd> and <kbd>Enter</kbd>, or **Skip**. Clear requests start at once (`localpilot.clarify.questions`).
- **Understands terse requests.** "fix this" or "make it faster" gets a snapshot of your editor, errors and git state. The agent states how it understood the request before acting.
- **Improve prompt** (<kbd>⌘I</kbd> / <kbd>Ctrl+I</kbd>). It rewrites your draft into a precise request that names the real file, function or selection. It never adds requirements. <kbd>⌘Z</kbd> brings your original back.
- **Misspelled names corrected.** `dicee.py` → `dice.py`, `rollDise` → `rollDice`, matched against your workspace before the agent starts (`localpilot.prompts.autoCorrect`).
- **A transcript you can follow.**
  - Reasoning, steps and status stream live.
  - A one-line work strip says what the agent is doing.
  - Bursts of reads and searches fold into one row.
  - Web results show as link cards.
- **Every answer shows its model and speed,** with Copy, **Regenerate** and Open as document. A failed answer keeps **Retry** and **Change model**.
- **Sessions.** Chats are saved per workspace, with a history panel, fork, pin, rename and export to Markdown. **Edit** any of your messages, or **Restore checkpoint** to rewind files and conversation.
- **Slash commands.** `/help`, `/model`, `/mode`, `/compact`, `/clear`, `/skills`, `/agents`, `/commands`, `/skill`, `/agent`, `/memory`, `/permissions`, `/hooks`, `/context`.
- **The chat goes where you want it.** Primary or Secondary Side Bar, bottom Panel or an editor tab (**Move Chat To…**). It works the same in each, down to narrow widths.

![A finished agent turn: a step summary (read, searched, edited +6 −4, ran pytest), the answer with a list, inline code and a syntax-highlighted code block with Copy, Insert and Save actions]({{ '/assets/screenshots/chat-rendering.png' | relative_url }})

## 4. Stay in control

- **Approvals.** Commands and deletes ask first by default, while edits and web access are allowed. Each action can be set to Always, Ask or Never, or use a preset: *Careful*, *Balanced* or *Autonomous*.
- **Auto mode** (⚡ in the status bar). A small local model reviews actions that would ask for approval, and approves the ones that clearly serve your request inside the project. Pushes, `sudo`, recursive deletes, publishing and writes to secrets or `.git` always ask. The reviewer can only approve, never deny.
- **Pause, steer, stop.** Pause after the current step, type a correction the agent reads when it resumes, or stop. Works for the whole run or a single subagent.
- **Permission rules and hooks.** Claude Code `settings.json` allow, ask and deny rules and hooks apply as written.
- **Safe commands.** Destructive commands are detected. Stop and timeouts kill the whole process tree.

## 5. Run work in parallel

![Three agents running in parallel: a tab per task, pause and stop for each, the Agents panel and the status bar count]({{ '/assets/screenshots/parallel-agents.png' | relative_url }})

- **Run Tasks in Parallel** (<kbd>⌘⇧⌥P</kbd>) starts one agent per task, each in its own tab.
- **Isolated worktrees.** In a git repository each agent works in its own git worktree (`localpilot.worktrees.mode`). You **Apply to workspace** or **Discard** its result.
- **Best of N.** Run one task on 2 to 8 models, compare the results and keep the best.
- **Task queue.** *LocalPilot: Queue Agent Task…* lines tasks up, each with its own mode and model, optionally waiting for others to succeed first. They run one at a time or side by side (`localpilot.queue.concurrency`). The queue survives a reload.
- **Several models at once.** A busy model's extra work goes to a comparable idle model that fits alongside it (`localpilot.routing.parallelModels`).
- **Agents panel.** Running, queued and idle work, the files each run changed, and Stop, Keep and Undo.

See [Parallel agents & change review]({{ '/docs/parallel-agents/' | relative_url }}).

## 6. Review every change

![Side-by-side diff of the agent's edit, opened from the changed-file list in the chat]({{ '/assets/screenshots/review-diff.png' | relative_url }})

- Each file is snapshotted before the agent edits it. Changed lines are highlighted in open editors.
- The changes card above the chat box lists every changed file. Open a diff, or accept or reject per file or all at once.
- Changes are tracked per session, so rejecting one agent's work never touches another's.

## 7. Context, memory, tools and skills

- **Long tasks in small windows.** A per-model token budget prunes old tool output first, then summarises older turns. An 8k model still finishes. See [Context]({{ '/docs/context/' | relative_url }}).
- **@ mentions.** `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, `@terminal`, files, `file#L10-L20` ranges and folders.
- **Your rules, as they are.** `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `.github/copilot-instructions.md` and `.localpilot/rules.md`.
- **Memory.** Project and global notes the agent saves and recalls in later sessions, with size limits so they stay useful. See [Memory & planning]({{ '/docs/memory-and-planning/' | relative_url }}).
- **Tools:**
  - files: read, edit, write, list, delete
  - search: ripgrep, symbols and references, a repository map
  - shell, diagnostics, and a checklist
  - web search (DuckDuckGo, SearXNG, Brave, Tavily) and fetch
  - a headless browser for screenshots and DevTools inspection
  - subagents, and any MCP server's tools

  Models without native tool calling use a text protocol. See [MCP]({{ '/docs/mcp/' | relative_url }}).
- **Skills and subagents.** 14 built-in skills load when a request matches them. Install more from GitHub, or let a recurring request become a new skill. Nine subagents are built in: `clarifier`, `explore`, `planner`, `coder`, `tester`, `debugger`, `reviewer`, `docs` and `researcher`. Add your own in `.localpilot/agents/`. See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).
- **Claude Code compatibility.** Skills, agents, custom commands, plugins, permission rules and hooks from `.claude/` work unchanged. See [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).
- **Images and browser.** Capture a region, window or screen (<kbd>⌘⌥⇧S</kbd>), or paste or drop an image. Images go to a vision model. The agent can screenshot and inspect web pages and local dev servers. See [Screenshots & images]({{ '/docs/images/' | relative_url }}).

## 8. In the editor, terminal and CLI

- **Inline edit** (<kbd>⌘⌥K</kbd>) rewrites a selection in place, with Keep and Undo. In a terminal, the same key writes a command.
- **Light bulb and context menu.** Explain, Fix, Refactor, Generate Tests, Add Documentation, Fix Errors in File.
- **Inline completions.** Ghost text from a small fill-in-the-middle model. A cloud model is used only if you choose one for completions; then the code around the cursor goes through chat.
- **Commit messages** from the Source Control view, and a **Markdown reader** for long answers and the plans and reports the agent writes.
- **Agent terminal.** Commands run in a visible **LocalPilot Agent** terminal. Right-click any terminal for **Explain Terminal Output**, **Fix Failed Command** or **Add Terminal Output to Chat**.
- **The `localpilot` CLI.** It is the same agent in any shell, with approvals, a REPL, isolation in a worktree, skills, `models` and `doctor`. `localpilot providers` adds and checks local and cloud providers and sets keys; it keeps its own key file because the CLI cannot read the keychain. See [Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}).

## 9. Measure, configure, extend

- **Dashboard.** Runs, tokens, speed and first-token time per model, tool failures, accepted completions, provider health, **Model tuning** and a live log. Everything stays in `~/.localpilot/telemetry`, or optionally in your own Redis. See [Dashboard]({{ '/docs/dashboard/' | relative_url }}).
- **Settings.** The gear in the chat toolbar opens one page for everything. **Search settings** (<kbd>⌘F</kbd> or <kbd>/</kbd>) jumps to any setting. Each value shows whether it comes from User or Workspace settings. See [Configuration]({{ '/docs/configuration/' | relative_url }}).
- **Provider manager.**
  - Configured providers grouped under Local and Cloud, with live status.
  - **Add a provider** by kind (On this machine, Cloud APIs, Gateways) or by search.
  - A **Get an API key** link for each cloud provider, and **Test connection** to list a provider's models.
- **VS Code platform.**
  - `@localpilot` in the built-in Chat view (`/agent`, `/ask`, `/plan`).
  - Your models in VS Code's language-model picker, with cloud ones labelled.
  - An extension API: `runPrompt`, `runParallel`, `runBestOfN`, `send`, `stop`, `applyWorktree`, `listModels`. See [Development]({{ '/docs/development/' | relative_url }}).
- **Private by default.** No account and no telemetry upload. Code goes only to the providers you configure. See [Privacy]({{ '/privacy/' | relative_url }}).

Small local models are weaker than frontier cloud models. Give them precise instructions and review more. Or pick a cloud model for the hard tasks and keep local models for the rest.
