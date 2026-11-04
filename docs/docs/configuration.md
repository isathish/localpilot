---
title: Configuration
description: Every LocalPilot setting with its default value, grouped as in the LocalPilot Settings screen.
permalink: /docs/configuration/
---

The easiest way to configure LocalPilot is its own **Settings** screen. Click the gear icon in the chat toolbar or run *LocalPilot: Settings*. The screen has:

- a sidebar with **Dashboard** pinned at the top, then collapsible groups: **Models** (Providers, Models, Model gallery), **Agent** (Agent & approvals, Skills & subagents, Inline completions), **Tools & integrations** (MCP servers, Web search), **Data & system** (Memory & history, Advanced) and **Help**
- a marker showing whether a value comes from your User or Workspace settings
- a reset button for every value
- a **provider manager** with a *Test connection* button that lists the models each server exposes

Click a group header to fold it; a folded group still shows the page you are on. The buttons above the groups fold the sidebar to an icon rail and expand or collapse every group. Both choices are remembered. In a narrow editor the sidebar becomes a strip of pills with every page.

The first time LocalPilot starts without a reachable model server or default model, it opens the **Welcome / Setup** wizard. The wizard detects Ollama, LM Studio, llama.cpp and vLLM, recommends a model and sets an approval preset (*Careful*, *Balanced* or *Autonomous*). Run it again any time with *LocalPilot: Welcome / Setup*. Turn off the automatic prompt with `localpilot.showWelcomeOnStartup`.

All settings are also in **Settings → Extensions → LocalPilot** and in `settings.json`. The keys are listed below.

![LocalPilot Settings: Providers page with providers grouped under Local and Cloud, each card showing where it runs, its API and its status (models and latency, unreachable, or a missing key)]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

Expand a provider to edit it and press **Test connection**. LocalPilot checks the server, measures latency and lists every model it exposes:

![Provider editor with a successful connection test against a running Ollama, listing its models]({{ '/assets/screenshots/settings-provider-test.png' | relative_url }})

![Agent & approvals page with the Careful / Balanced / Autonomous presets and per-action Ask / Allow / Block controls]({{ '/assets/screenshots/settings-agent.png' | relative_url }})

The **Agent & approvals** page also has the terminal, hooks, worktree and parallelism settings. **Skills & subagents** manages installed skills, the skill registry and the extra skill and plugin folders.

![Skills & subagents page: how registry skills are used, where they install, and the built-in skills switch]({{ '/assets/screenshots/settings-skills.png' | relative_url }})

## Models

| Setting | Default | Description |
|---|---|---|
| `localpilot.providers` | Ollama, LM Studio, llama.cpp, vLLM on localhost | Local servers, gateways and cloud APIs. Per provider: `type` (`ollama`, `openai`, `anthropic`), `baseUrl`, `apiKey` (`${secret:id}`, `${env:NAME}` or the key), `cloud`, `models`, `contextWindow`, `enabled`. See [Models & providers]({{ '/docs/models/' | relative_url }}) |
| `localpilot.defaultModel` | `""` (auto) | `provider/model`. Empty picks the best tool-capable coder model that fits this machine |
| `localpilot.models.disabled` | `[]` | `provider/model` ids hidden from pickers, routing and the status bar. Toggle them in **Settings → Models** |
| `localpilot.models.autoSetup` | `true` | Offer to install Ollama and a starter model when no local model is found |
| `localpilot.models.autoTune` | `auto` | Learn from local telemetry which installed models work best per role. `auto` updates role settings when another model is measurably better (with Undo); `suggest` only offers changes; `off` disables learning. Needs `localpilot.telemetry.enabled`. See [Learning from your usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}) |
| `localpilot.contextWindow` | `32768` | Requested context in tokens (Ollama `num_ctx`), capped by the model's maximum. `0` = the model's full native window, which needs enough RAM/VRAM. Compaction is budgeted against the same number |
| `localpilot.maxOutputTokens` | `4096` | Maximum tokens per response |
| `localpilot.temperature` | `-1` | Sampling temperature. `-1` uses each model's own setting (Gemma 4 and Qwen 3 ship 1.0 and repeat themselves at low temperatures); 0–2 forces one value for every model |
| `localpilot.thinking` | `auto` | Extended thinking for reasoning models: `auto`, `off`, `on`, `low`, `medium` or `high`. `auto` picks per task: high for Plan and Debug, medium for Agent and Multitask, low for Ask and subagents, none for quick helpers. `off` explicitly tells thinking models not to reason. Sent as Ollama `think` or OpenAI-compatible `reasoning_effort`; Ollama models other than gpt-oss take only on or off, so `low` skips the reasoning and `medium` or `high` send `think: true`. Reasoning shows as a collapsible step |
| `localpilot.keepAlive` | `30m` | How long Ollama keeps the model loaded after a request (for example `5m`, `30m`, or `-1` for forever). Avoids reload delays between turns |
| `localpilot.prewarm` | `true` | Load the chat's model as soon as you focus the composer or switch models, so the first reply does not wait for a weight load. Ollama only; at most once every few minutes per model |
| `localpilot.ollama.flashAttention` | `true` | Start Ollama with flash attention (`OLLAMA_FLASH_ATTENTION`): faster prompt processing and a smaller KV cache on supported models. Applies when LocalPilot starts or restarts Ollama |
| `localpilot.ollama.kvCacheType` | `q8_0` | KV cache quantisation for Ollama (`OLLAMA_KV_CACHE_TYPE`): `f16`, `q8_0` (about half the memory of `f16`) or `q4_0` (about a quarter, small quality loss on long contexts). Needs flash attention; applies when LocalPilot starts or restarts Ollama |

## colibri

Settings for [colibri]({{ '/docs/models/#colibri-huge-moe-models-from-disk' | relative_url }}), which runs very large mixture-of-experts models by streaming experts from disk. They are used by *LocalPilot: Start colibri*. A running `coli serve` is detected whatever these are set to. They are also at the bottom of **Settings → Providers**, with a **Start colibri** button.

![Settings → Providers → Huge MoE models (colibri): folder, model, models folder, GPU backend, port and parallel conversations, with Stop and Start colibri buttons]({{ '/assets/screenshots/settings-colibri.png' | relative_url }})

| Setting | Default | Description |
|---|---|---|
| `localpilot.colibri.path` | `""` | colibri folder: a checkout (`c/coli`) or a release (`coli`). Empty = `coli` on PATH, then `~/colibri`. **Start colibri** installs colibri when it is not found |
| `localpilot.colibri.model` | `""` | `--model` value: a colibri model name (for example `qwen3-coder-30b`, `glm-5.2`) or a model folder. Empty = the model colibri's setup installed |
| `localpilot.colibri.modelsDir` | `""` | Where colibri downloads models (`--dir`). Empty = `~/colibri-models` |
| `localpilot.colibri.backend` | `auto` | Engine built at setup: `auto`, `cuda`, `vulkan` or `cpu` |
| `localpilot.gateways.litellmConfig` | `""` | LiteLLM proxy config file (`model_list`) used by **Start Gateway** |
| `localpilot.colibri.port` | `8000` | Port `coli serve` listens on. Auto-detect also probes it when it is not `8000` |
| `localpilot.colibri.kvSlots` | `2` | `--kv-slots`: conversations colibri decodes together, each with its own cached prefix. 1–16, and capped by `localpilot.parallel.maxConcurrency`. Each slot costs a few hundred MB |

## Browser

In the Settings screen: **Web search → Browser**.

![Web search page with the search provider, result count and the browser used for screenshots]({{ '/assets/screenshots/settings-web.png' | relative_url }})

| Setting | Default | Description |
|---|---|---|
| `localpilot.browser.chromePath` | `""` (auto) | Chromium-based browser for headless web-page screenshots (`browser_screenshot`, *Screenshot a Web Page…*). Auto-detects Chrome, Chromium, Edge, Brave and Arc |

## Routing

| Setting | Default | Description |
|---|---|---|
| `localpilot.routing.enabled` | `true` | Pick a model per task: a vision model for image turns, the smallest FIM model for completions, a reasoning model in Plan mode, and the best available model when the default is offline or disabled |
| `localpilot.routing.vision` | `""` (auto) | `provider/model` for turns with images when the session model cannot see |
| `localpilot.routing.reasoning` | `""` (keep session model) | `provider/model` used in Plan mode |
| `localpilot.routing.fast` | `""` (auto) | `provider/model` for read-only subagents (`explore`, `clarifier`, `researcher`). Empty = the smallest tool-capable model that fits; `session` = keep the session model |
| `localpilot.routing.coding` | `""` (keep session model) | `provider/model` for implementing subagents (`coder`, `tester`, `debugger`, `docs`) |
| `localpilot.routing.parallelModels` | `true` | Spread simultaneous runs across models. When workers or Auto chats would land on a model that is already serving as many runs as it can, the extra ones go to a comparable idle model that fits in memory alongside. Models you chose explicitly are never swapped. See [Several models at once]({{ '/docs/parallel-agents/#several-models-at-once' | relative_url }}) |

See [Automatic routing]({{ '/docs/models/#automatic-routing' | relative_url }}).

## Context

| Setting | Default | Description |
|---|---|---|
| `localpilot.compactionThreshold` | `0.75` | Fraction of the context window (0.3–0.95) at which pruning and summarising start |
| `localpilot.compaction.strategy` | `agentic` | `agentic`: the model summarises older messages (falls back to `basic` when it fails or the transcript is too big for it). `basic`: no model call — every user message, the last 3 assistant replies and one line per tool call are kept. `off`: never compact automatically. See [Memory & planning]({{ '/docs/memory-and-planning/' | relative_url }}) |
| `localpilot.maxToolOutputChars` | `24000` | Maximum characters per tool output; the head and tail are kept |
| `localpilot.pdf.maxReadSizeMB` | `100` | Largest PDF the agent may read with `read_pdf`, `read_file` or as an attachment |
| `localpilot.pdf.maxChars` | `60000` | Most characters of PDF text returned per read |
| `localpilot.pdfViewer.pageColors` | `auto` | Page colours in the [PDF viewer]({{ '/docs/viewers/' | relative_url }}): `auto` (dark pages in dark themes, exact colours in high contrast), `original`, `dark` or `sepia` |
| `localpilot.pdfViewer.sidebar` | `auto` | PDF viewer sidebar: `auto` (outline if the PDF has one, else thumbnails), `outline`, `thumbnails` or `hidden` |
| `localpilot.pdfViewer.defaultZoom` | `auto` | Zoom for PDFs opened for the first time: `auto`, `page-width`, `page-fit` or `page-actual` |
| `localpilot.pdfViewer.rangeThresholdMB` | `16` | PDFs larger than this load page by page instead of all at once |
| `localpilot.pdfViewer.maxFileSizeMB` | `1024` | Ask before opening PDFs larger than this |
| `localpilot.markdownViewer.scrollSync` | `true` | Keep the [Markdown reader]({{ '/docs/viewers/' | relative_url }}) and the source editor scrolled together; double-click a block to open its source line |
| `localpilot.markdownViewer.outlineDepth` | `3` | Deepest heading level (2–6) in the reader's outline and in an inline `[[toc]]` |
| `localpilot.markdownViewer.frontMatter` | `collapsed` | How YAML front matter shows above a document: `collapsed`, `expanded` or `hidden` |
| `localpilot.markdownViewer.mermaid` | `true` | Draw ```` ```mermaid ```` blocks as diagrams (bundled, works offline) |
| `localpilot.markdownViewer.exportTheme` | `light` | Colours of **Export HTML / PDF** from the reader: `light`, or `match` for the current VS Code theme |
| `localpilot.maxConsecutiveMistakes` | `6` | Stop a run after this many steps in a row in which every tool call failed (or a tool call had to be repaired) and ask for guidance. Any successful tool call resets the count; `0` = no limit |
| `localpilot.disabledTools` | `[]` | Tools never offered to the model: LocalPilot names (`web_fetch`), Claude Code or Cline names (`Bash`, `execute_command`) or globs (`mcp_*`, `browser_*`). Also under **Settings → Agent & approvals → Tools** |
| `localpilot.systemPromptAppend` | `""` | Extra instructions appended to every system prompt |
| `localpilot.preferredLanguage` | `auto` | Language the agent answers in, in the chat and the CLI: English, Arabic, Czech, French, German, Hindi, Hungarian, Italian, Japanese, Korean, Polish, Portuguese (Brazil), Portuguese (Portugal), Russian, Simplified Chinese, Spanish, Traditional Chinese or Turkish. Code, identifiers and commands stay as they are. `auto` adds no instruction |
| `localpilot.prompts.autoCorrect` | `true` | Correct misspelled file names and code identifiers in your requests against the names in the workspace (`dicee.py` → `dice.py`) before the agent starts. Plain words are never changed; corrections are shown under your message |

## Skills, plugins & hooks

| Setting | Default | Description |
|---|---|---|
| `localpilot.skillsPaths` | `[]` | Additional skill folders (each skill is a folder with a `SKILL.md`). `.localpilot/skills`, `.claude/skills`, `.github/skills`, `.agents/skills`, `.cline/skills`, `.clinerules/skills`, `~/.agents/skills` and `~/.cline/skills` are scanned automatically |
| `localpilot.skills.builtin` | `true` | Load the 14 skills bundled with LocalPilot. A workspace or user skill with the same name overrides a bundled one |
| `localpilot.skills.repositories` | `["anthropics/skills/skills", "obra/superpowers/skills", "github/awesome-copilot/skills"]` | Skill catalog: GitHub repositories or folders (`owner/repo[/path][@ref]`, or github.com URLs) whose skills can be installed when a request matches one. The first repository wins on duplicate names. The index is cached in `~/.localpilot/skill-catalog.json` for a day. `GITHUB_TOKEN` is used when set |
| `localpilot.skills.autoInstall` | `auto` | What happens when a registry skill matches a request better than any installed one. `auto` installs and loads it as the request starts; `ask` shows an **Install "…"** chip; `off` never contacts the registry. Each chat can override this with its **Skills** button, where **Off** also silences suggestions for that chat |
| `localpilot.skills.autoInstallScope` | `user` | Where automatically installed skills go: `user` (`~/.localpilot/skills`) or `workspace` (`.localpilot/skills`) |
| `localpilot.skills.disabled` | `[]` | Skill names hidden from the agent (not in the prompt, not suggested, not loadable). They stay on disk. Toggle them in **Settings → Skills & subagents** |
| `localpilot.pluginPaths` | `[]` | Extra folders with Claude Code-style plugins (a folder with `.claude-plugin/plugin.json` bundling `commands/`, `agents/`, `skills/`, `hooks/hooks.json` and `.mcp.json`). `.localpilot/plugins`, `.claude/plugins`, `~/.localpilot/plugins` and `~/.claude/plugins` are scanned automatically. Disable one with `enabledPlugins` in `settings.json` |
| `localpilot.plugins.marketplaces` | `["anthropics/claude-plugins-official"]` | Plugin marketplaces to search and install from (**LocalPilot: Browse Plugins…**, `localpilot plugin search`): `owner/repo` on GitHub, any git URL or a local folder, each with a `.claude-plugin/marketplace.json` in Claude Code's format. Fetched with `git`, so private repositories work with your git credentials |
| `localpilot.checkpoints.enabled` | `true` | Take a checkpoint before each message you send. In a git repository it is a private ref (`refs/localpilot/checkpoints/<chat>/<turn>`) that records the working tree, including untracked files and changes made by shell commands. Your index, branches and `git stash list` are not touched. Outside git, or with this off, only the files the agent edits are snapshotted. Checkpoints are deleted with the chat. See [Checkpoints]({{ '/docs/features/' | relative_url }}#checkpoints) |
| `localpilot.hooks.enabled` | `true` | Run hooks configured in `.localpilot/settings.json`, `.claude/settings.json` and `~/.claude/settings.json`. Hooks are shell commands on events such as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`, using the Claude Code stdin and exit-code protocol (exit 2 blocks). Turn this off for repositories you do not trust. It does not affect MCP servers from workspace plugins or settings |

See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Approvals

| Setting | Default |
|---|---|
| `localpilot.approvals.terminal` | `ask` |
| `localpilot.approvals.write` | `always` |
| `localpilot.approvals.delete` | `ask` |
| `localpilot.approvals.network` | `always` |
| `localpilot.approvals.mcp` | `always` |

Values: `always`, `ask`, `never`.

**Auto mode** (`localpilot.autoMode.enabled`, default `false`; toggle with **LocalPilot: Toggle Auto Mode**): every approval set to `ask` is first reviewed by a small local model (`localpilot.autoMode.model`, empty = the fastest suitable one). It approves actions that clearly serve your request and stay inside the project. Pushes, `sudo`, recursive deletes, piping downloads into a shell, publishing and writes to secrets or `.git` always ask. The reviewer can only approve, never deny, and any reviewer error falls back to asking.

## Repositories

| Setting | Default | Purpose |
|---|---|---|
| `localpilot.repos` | `{}` | Extra repositories the agent can work across, name → folder (`{ "api": "~/src/api" }`). The folders of a multi-root workspace and the workspace's `.localpilot/repos.json` are included automatically. See [Several repositories](parallel-agents.md#several-repositories) |

## Organization policy

Administrators can deploy a policy that users and projects cannot override. LocalPilot reads it from a system location (an administrator-owned file, so a user cannot edit it):

| Platform | Path |
|---|---|
| macOS | `/Library/Application Support/LocalPilot/managed-settings.json` |
| Linux | `/etc/localpilot/managed-settings.json` |
| Windows | `%ProgramData%\LocalPilot\managed-settings.json` |

The `LOCALPILOT_MANAGED_SETTINGS` environment variable points to another file, for testing or a non-standard deployment; it is used only when the system file above does not exist, so it cannot replace a deployed policy. Changes apply within a few seconds, without restarting VS Code. A policy only tightens: it never grants anything a user's own settings refuse.

```jsonc
{
  "message": "Questions: it-security@example.com",       // shown wherever the policy blocks something
  "permissions": {
    "deny": ["Bash(curl:*)", "Read(.env)", "Read(**/*.pem)"], // always blocked, whatever settings.json allows
    "ask":  ["Bash(git push:*)"]                              // always asks, even if a project allows it
  },
  "approvals": { "terminal": "ask", "delete": "never" },     // floor per kind (terminal, write, delete, network, mcp): "ask" = never auto-approved, "never" = refused; mcp falls back to network
  "disableBypassPermissions": true,   // no bypassPermissions/acceptEdits default mode, no Auto mode
  "allowCloudProviders": false,       // only providers on this machine or the private network load
  "allowedProviderHosts": ["localhost", "127.0.0.1", "*.corp.example"],
  "allowWebAccess": false,            // removes web_search, web_fetch and the browser tools
  "allowedMcpServers": ["github"],    // other MCP servers do not start
  "allowSkillInstall": false,         // no skill downloads; skills from a local folder still install
  "auditLog": "/var/log/localpilot/${workspaceFolder}.jsonl"  // every tool call and approval, as JSON Lines
}
```

Rules use the same syntax as [permission rules](claude-code-compatibility.md) in `settings.json`. Every key is optional. A policy file that exists but cannot be parsed fails closed: cloud providers, web access and skill downloads are switched off, and every action needs approval, until it is fixed.

Users see the policy in **Settings** (a note on the Agent & approvals, Providers, Skills, MCP and Web search pages), in `/permissions` in the chat, and in `localpilot doctor`. Each audit record has the time, user, host, workspace, session, tool, its arguments (cut at 2,000 characters), the outcome, and whether the policy blocked it. Approvals are recorded with who decided: the setting, the policy, Auto mode or the user.

## Terminal

| Setting | Default | Description |
|---|---|---|
| `localpilot.terminal.runInIntegratedTerminal` | `true` | Run the agent's `run_command` calls in a visible **LocalPilot Agent** terminal so you can watch them. Falls back to a hidden process when the shell has no shell integration or this is off |
| `localpilot.terminal.reveal` | `true` | Show the LocalPilot Agent terminal, without taking focus, when the agent runs a command |

## Parallelism & worktrees

| Setting | Default | Description |
|---|---|---|
| `localpilot.parallel.maxConcurrency` | `4` | Concurrent tool calls and subagents (1–16). When LocalPilot starts Ollama, it also requests this many parallel slots (`OLLAMA_NUM_PARALLEL`, capped at 4) |
| `localpilot.parallel.maxSubagentDepth` | `2` | How deep subagents may nest (1–4) |
| `localpilot.queue.concurrency` | `1` | Tasks from the task queue (**LocalPilot: Queue Agent Task…**) that run at once. `1` runs them one after another; higher values run them side by side, each in its own worktree |
| `localpilot.worktrees.mode` | `always` | Isolate agents in git worktrees: `always`, `parallel` (only agents started together) or `off`. See [Parallel agents → Isolated worktrees]({{ '/docs/parallel-agents/#isolated-worktrees' | relative_url }}) |
| `localpilot.worktrees.location` | `""` (= `~/.localpilot/worktrees`) | Where the worktrees live, one sub-folder per repository |
| `localpilot.clarify.questions` | `smart` | When the agent asks before building: `smart` (new features and open-ended requests), `interview` (every change, then waits for your OK on the plan) or `minimal`. See [Questions before it starts]({{ '/docs/agent-modes/#questions-before-it-starts' | relative_url }}) |
| `localpilot.autoClarify` | `true` | Detect vague requests and give the agent a workspace snapshot (editor, open files, errors, git), so it states its interpretation before acting |

## Telemetry & storage

These settings control the local metrics behind the [Dashboard]({{ '/docs/dashboard/' | relative_url }}). The extension does not upload them. See [Privacy]({{ '/privacy/' | relative_url }}).

| Setting | Default | Description |
|---|---|---|
| `localpilot.telemetry.enabled` | `true` | Record local usage metrics (model calls, tokens and latency, tool runs, agent turns, inline completions, provider health) to daily JSONL files in `~/.localpilot/telemetry`. Also needed by `localpilot.models.autoTune` |
| `localpilot.telemetry.retentionDays` | `30` | Days of metrics and log files to keep. Older files are deleted automatically. `0` keeps everything |
| `localpilot.storage.sessionsInMemory` | `16` | Chat transcripts held in memory (2–500). Every chat stays in the history; older transcripts are read from disk when you open or search them. Running chats and the one on screen always stay loaded |
| `localpilot.storage.redis.enabled` | `false` | Optional. Store telemetry events and the log in Redis streams instead of daily files; with Redis Stack, metrics also become time series (`localpilot:ts:*`, label `app=localpilot`) for Grafana or RedisInsight. Writes fall back to files while Redis is unreachable. Telemetry then goes to the server in `storage.redis.url`. **LocalPilot: Set Up Redis Storage** connects one or starts it (Docker, or without Docker: Homebrew, apt/dnf, WSL, Memurai) |
| `localpilot.storage.redis.url` | `redis://127.0.0.1:6379` | `redis://[user:password@]host:port[/db]`, or `rediss://` for TLS. Keep it on `127.0.0.1` unless the server is protected |
| `localpilot.supervisor.enabled` | `true` | Keep local services running: start and keep running a local Ollama that has models downloaded, serves the default model or has run this session and Redis when `storage.redis.enabled` is on. Stops after 4 failed restarts in a row. **LocalPilot: Show Background Services** |
| `localpilot.supervisor.intervalSeconds` | `60` | How often background services are checked (≥ 15) |
| `localpilot.supervisor.autoInstall` | `false` | When no model server is found at startup, install Ollama and a starter model without asking (several GB) |

None of the memory savings need Redis: transcripts are capped by `storage.sessionsInMemory`, and the Dashboard aggregates one day of telemetry at a time with a bounded sample per latency series.

## Chat history & memory

| Setting | Default | Description |
|---|---|---|
| `localpilot.chat.location` | `sidebar` | Where the chat lives: `sidebar` (Primary Side Bar), `secondarySidebar` (right, where Copilot Chat sits), `panel` (bottom, next to the Terminal) or `editor` (a tab in the main area). The Chat view moves the same way as with drag-and-drop, so **Move View** and **Reset Location** in the view's context menu keep working. The Agents view and the activity bar icon stay in the Primary Side Bar. Also available as **LocalPilot: Move Chat To…** |
| `localpilot.sessions.retention` | `50` | Maximum chats kept per workspace. The oldest idle chats are removed when a new one starts; pinned and running chats do not count. `0` keeps everything |
| `localpilot.history.includeCli` | `true` | List sessions from the `localpilot` CLI for the same folder in the chat history, marked **CLI**. They are read from `~/.localpilot/workspaces/` (or `LOCALPILOT_DATA_DIR`). Takes effect after a window reload |
| `localpilot.memory.enabled` | `true` | Let the agent save and read durable notes (`.localpilot/memory/` and global storage). Manage notes in **Settings → Memory & history** |
| `localpilot.memory.autoSave` | `true` | After a run with at least three tool calls in which the agent saved nothing itself, ask the same model whether the run revealed durable project facts (build and test commands, conventions, pitfalls) and append at most three short notes to project memory. Runs after the answer; anything that looks like a credential is dropped. Needs `localpilot.memory.enabled` |
| `localpilot.memory.maxNoteChars` | `8000` | Largest memory note; longer notes lose their oldest paragraphs. Appending lines a note already has does nothing |
| `localpilot.memory.maxNotes` | `200` | Notes kept per scope; past it the least recently updated are removed (`README` is kept) |
| `localpilot.showWelcomeOnStartup` | `true` | Open the **Welcome / Setup** screen the first time LocalPilot starts without a reachable model server or default model |

## Web search

| Setting | Default | Description |
|---|---|---|
| `localpilot.webSearch.enabled` | `true` | Web access for the agent. `false` removes `web_search`, `web_fetch` and the browser tools from every request and refuses `@https://…` mentions. Model providers are not affected |
| `localpilot.webSearch.provider` | `duckduckgo` | `duckduckgo` (no key), `searxng`, `brave` or `tavily` |
| `localpilot.webSearch.searxngUrl` | `http://localhost:8888` | Self-hosted SearXNG URL |
| `localpilot.webSearch.apiKey` | `""` | Brave or Tavily API key |
| `localpilot.webSearch.maxResults` | `6` | Results per search |

## Inline completions

| Setting | Default | Description |
|---|---|---|
| `localpilot.inlineCompletion.enabled` | `false` | Ghost-text completions |
| `localpilot.inlineCompletion.model` | `""` | `provider/model`. Empty uses the smallest FIM-capable model that fits this machine |
| `localpilot.inlineCompletion.debounceMs` | `350` | Delay after typing before a completion is requested |
| `localpilot.inlineCompletion.maxTokens` | `128` | Maximum tokens per completion |

![Settings → Inline completions: the on/off switch with suggested FIM models, the completion model (Auto picks the smallest FIM model), debounce and max tokens]({{ '/assets/screenshots/settings-completions.png' | relative_url }})

## MCP

`localpilot.mcpServers` (default `{}`): see [MCP servers]({{ '/docs/mcp/' | relative_url }}).

## Example

```jsonc
{
  "localpilot.defaultModel": "ollama/qwen2.5-coder:32b",
  "localpilot.contextWindow": 65536,
  "localpilot.approvals.terminal": "ask",
  "localpilot.inlineCompletion.enabled": true,
  "localpilot.inlineCompletion.model": "ollama/qwen2.5-coder:1.5b-base",
  "localpilot.models.autoTune": "suggest",
  "localpilot.webSearch.provider": "searxng",
  "localpilot.systemPromptAppend": "Use pnpm, not npm. Prefer functional React components."
}
```
