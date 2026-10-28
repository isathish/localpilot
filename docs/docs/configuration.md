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

![LocalPilot Settings: Providers page with live connection status (Ollama and Docker Model Runner reachable, LM Studio not running) and one-click presets to add more]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

Expand a provider to edit it and press **Test connection**. LocalPilot checks the server, measures latency and lists every model it exposes:

![Provider editor with a successful connection test against a running Ollama, listing its models]({{ '/assets/screenshots/settings-provider-test.png' | relative_url }})

![Agent & approvals page with the Careful / Balanced / Autonomous presets and per-action Ask / Allow / Block controls]({{ '/assets/screenshots/settings-agent.png' | relative_url }})

The **Agent & approvals** page also has the terminal, hooks, worktree and parallelism settings. **Skills & subagents** manages installed skills, the skill registry and the extra skill and plugin folders.

![Skills & subagents page: how registry skills are used, where they install, and the built-in skills switch]({{ '/assets/screenshots/settings-skills.png' | relative_url }})

## Models

| Setting | Default | Description |
|---|---|---|
| `localpilot.providers` | Ollama, LM Studio, llama.cpp, vLLM on localhost | Model servers. See [Models & providers]({{ '/docs/models/' | relative_url }}) |
| `localpilot.defaultModel` | `""` (auto) | `provider/model`. Empty picks the best tool-capable coder model that fits this machine |
| `localpilot.models.disabled` | `[]` | `provider/model` ids hidden from pickers, routing and the status bar. Toggle them in **Settings → Models** |
| `localpilot.models.autoSetup` | `true` | Offer to install Ollama and a starter model when no local model is found |
| `localpilot.models.autoTune` | `auto` | Learn from local telemetry which installed models work best per role. `auto` updates role settings when another model is measurably better (with Undo); `suggest` only offers changes; `off` disables learning. Needs `localpilot.telemetry.enabled`. See [Learning from your usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}) |
| `localpilot.contextWindow` | `32768` | Requested context in tokens (Ollama `num_ctx`), capped by the model's maximum. `0` = the model's full native window, which needs enough RAM/VRAM. Compaction is budgeted against the same number |
| `localpilot.maxOutputTokens` | `4096` | Maximum tokens per response |
| `localpilot.temperature` | `0.2` | Sampling temperature (0–2) |
| `localpilot.thinking` | `off` | Extended thinking for reasoning models: `off`, `on`, `low`, `medium` or `high`. Sent as Ollama `think` or OpenAI-compatible `reasoning_effort`. Reasoning shows as a collapsible step |
| `localpilot.keepAlive` | `30m` | How long Ollama keeps the model loaded after a request (for example `5m`, `30m`, or `-1` for forever). Avoids reload delays between turns |
| `localpilot.prewarm` | `true` | Load the chat's model as soon as you focus the composer or switch models, so the first reply does not wait for a weight load. Ollama only; at most once every few minutes per model |

## colibri

Settings for [colibri]({{ '/docs/models/#colibri-huge-moe-models-from-disk' | relative_url }}), which runs very large mixture-of-experts models by streaming experts from disk. They are used by *LocalPilot: Start colibri*. A running `coli serve` is detected whatever these are set to. They are also at the bottom of **Settings → Providers**, with a **Start colibri** button.

![Settings → Providers → Huge MoE models (colibri): folder, model, port and parallel conversations, with a Start colibri button]({{ '/assets/screenshots/settings-colibri.png' | relative_url }})

| Setting | Default | Description |
|---|---|---|
| `localpilot.colibri.path` | `""` | Folder of a colibri checkout (the one containing `c/coli`). Empty = `coli` on PATH |
| `localpilot.colibri.model` | `""` | `--model` value: a colibri model name (for example `qwen3-coder-30b`, `glm-5.2`) or a model folder. Empty = the model colibri's setup installed |
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
| `localpilot.maxToolOutputChars` | `24000` | Maximum characters per tool output; the head and tail are kept |
| `localpilot.systemPromptAppend` | `""` | Extra instructions appended to every system prompt |

## Skills, plugins & hooks

| Setting | Default | Description |
|---|---|---|
| `localpilot.skillsPaths` | `[]` | Additional skill folders (each skill is a folder with a `SKILL.md`). `.localpilot/skills`, `.claude/skills`, `.github/skills` and `~/.agents/skills` are scanned automatically |
| `localpilot.skills.builtin` | `true` | Load the 14 skills bundled with LocalPilot. A workspace or user skill with the same name overrides a bundled one |
| `localpilot.skills.repositories` | `["anthropics/skills/skills", "obra/superpowers/skills", "github/awesome-copilot/skills"]` | Skill catalog: GitHub repositories or folders (`owner/repo[/path][@ref]`, or github.com URLs) whose skills can be installed when a request matches one. The first repository wins on duplicate names. The index is cached in `~/.localpilot/skill-catalog.json` for a day. `GITHUB_TOKEN` is used when set |
| `localpilot.skills.autoInstall` | `auto` | What happens when a registry skill matches a request better than any installed one. `auto` installs and loads it as the request starts; `ask` shows an **Install "…"** chip; `off` never contacts the registry. Each chat can override this with its **Skills** button, where **Off** also silences suggestions for that chat |
| `localpilot.skills.autoInstallScope` | `user` | Where automatically installed skills go: `user` (`~/.localpilot/skills`) or `workspace` (`.localpilot/skills`) |
| `localpilot.skills.disabled` | `[]` | Skill names hidden from the agent (not in the prompt, not suggested, not loadable). They stay on disk. Toggle them in **Settings → Skills & subagents** |
| `localpilot.pluginPaths` | `[]` | Extra folders with Claude Code-style plugins (a folder with `.claude-plugin/plugin.json` bundling `commands/`, `agents/`, `skills/`, `hooks/hooks.json` and `.mcp.json`). `.localpilot/plugins`, `.claude/plugins`, `~/.localpilot/plugins` and `~/.claude/plugins` are scanned automatically. Disable one with `enabledPlugins` in `settings.json` |
| `localpilot.hooks.enabled` | `true` | Run hooks configured in `.localpilot/settings.json`, `.claude/settings.json` and `~/.claude/settings.json`. Hooks are shell commands on events such as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SessionStart`, using the Claude Code stdin and exit-code protocol (exit 2 blocks). Turn this off for repositories you do not trust |

See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Approvals

| Setting | Default |
|---|---|
| `localpilot.approvals.terminal` | `ask` |
| `localpilot.approvals.write` | `always` |
| `localpilot.approvals.delete` | `ask` |
| `localpilot.approvals.network` | `always` |

Values: `always`, `ask`, `never`.

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
| `localpilot.worktrees.mode` | `always` | Isolate agents in git worktrees: `always`, `parallel` (only agents started together) or `off`. See [Parallel agents → Isolated worktrees]({{ '/docs/parallel-agents/#isolated-worktrees' | relative_url }}) |
| `localpilot.worktrees.location` | `""` (= `~/.localpilot/worktrees`) | Where the worktrees live, one sub-folder per repository |
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

None of the memory savings need Redis: transcripts are capped by `storage.sessionsInMemory`, and the Dashboard aggregates one day of telemetry at a time with a bounded sample per latency series.

## Chat history & memory

| Setting | Default | Description |
|---|---|---|
| `localpilot.chat.location` | `sidebar` | Where the chat lives: `sidebar` (Primary Side Bar), `secondarySidebar` (right, where Copilot Chat sits), `panel` (bottom, next to the Terminal) or `editor` (a tab in the main area). The Chat view moves the same way as with drag-and-drop, so **Move View** and **Reset Location** in the view's context menu keep working. The Agents view and the activity bar icon stay in the Primary Side Bar. Also available as **LocalPilot: Move Chat To…** |
| `localpilot.sessions.retention` | `50` | Maximum chats kept per workspace. The oldest idle chats are removed when a new one starts; pinned and running chats do not count. `0` keeps everything |
| `localpilot.memory.enabled` | `true` | Let the agent save and read durable notes (`.localpilot/memory/` and global storage). Manage notes in **Settings → Memory & history** |
| `localpilot.showWelcomeOnStartup` | `true` | Open the **Welcome / Setup** screen the first time LocalPilot starts without a reachable model server or default model |

## Web search

| Setting | Default | Description |
|---|---|---|
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
