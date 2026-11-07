---
title: Configuration
description: Every LocalPilot setting with its default value, grouped as in the LocalPilot Settings screen.
permalink: /docs/configuration/
---

The easiest way to configure LocalPilot is its own **Settings** screen. Click the gear icon in the chat toolbar or run *LocalPilot: Settings*. The screen has:

- a sidebar with **Dashboard** pinned at the top, then collapsible groups: **Models** (Providers, Models, Model gallery), **Agent** (Agent & approvals, Skills & subagents, Inline completions), **Tools & integrations** (MCP servers, Web search, Markdown & PDF), **Data & system** (Memory & history, Telemetry, Advanced) and **Help**
- a marker showing whether a value comes from your User or Workspace settings
- a reset button for every value
- a **provider manager** with a *Test connection* button that lists the models each server exposes

Click a group header to fold it; a folded group still shows the page you are on. The buttons above the groups fold the sidebar to an icon rail and expand or collapse every group. Both choices are remembered. In a narrow editor the sidebar becomes a strip of pills with every page.

The first time LocalPilot starts without a reachable model server or default model, it opens the **Setup** wizard. The wizard detects Ollama, LM Studio, llama.cpp and vLLM, recommends a model and sets an approval preset (*Careful*, *Balanced* or *Autonomous*). Run it again any time with *LocalPilot: Open Setup*. Turn off the automatic prompt with `localpilot.showWelcomeOnStartup`.

All settings are also in **Settings → Extensions → LocalPilot** and in `settings.json`. The keys are listed below.

![LocalPilot Settings: Providers page with providers grouped under Local and Cloud, each card showing where it runs, its API and its status (models and latency, unreachable, or a missing key)]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

Each card carries a health badge: *reachable* (with the latency), *slow* (a local server that took longer than 1.5 s to answer, a cloud API longer than 4 s), *down* or *no key* (no usable key, or the key was rejected). The badge comes from the page's own check when it opens and from the checks LocalPilot runs whenever it lists models, so no extra requests are made for it; the tooltip says how long the check took and when it ran. The chat's model picker shows the same tag next to each provider.

Expand a provider to edit it and press **Test connection**. LocalPilot checks the server, measures latency and lists every model it exposes:

![Provider editor with a successful connection test against a running Ollama, listing its models]({{ '/assets/screenshots/settings-provider-test.png' | relative_url }})

![Agent & approvals page with the Careful / Balanced / Autonomous presets and per-action Ask / Allow / Block controls]({{ '/assets/screenshots/settings-agent.png' | relative_url }})

The **Agent & approvals** page also has the terminal, hooks, worktree and parallelism settings. **Skills & subagents** manages installed skills, the skill registry and the extra skill and plugin folders.

![Skills & subagents page: how registry skills are used, where they install, and the built-in skills switch]({{ '/assets/screenshots/settings-skills.png' | relative_url }})

## Models

| Setting | Default | Description |
|---|---|---|
| `localpilot.providers` | Ollama, LM Studio, llama.cpp, vLLM on localhost | Local servers, gateways and cloud APIs. Per provider: `type` (`ollama`, `openai`, `anthropic`, or `vscode-lm` for VS Code's language models such as Copilot), `baseUrl` (not needed for `vscode-lm`), `apiKey` (`${secret:id}`, `${env:NAME}` or the key), `cloud`, `models`, `contextWindow`, `enabled`, and optionally `headers`, `timeoutMs`, `apiVersion`, `defaultModel`, `modelsUrl`, `extraBody` and `modelOverrides`. See [Models & providers]({{ '/docs/models/' | relative_url }}) |
| `localpilot.defaultModel` | `""` (auto) | `provider/model`. Empty picks the best tool-capable coder model that fits this machine |
| `localpilot.models.disabled` | `[]` | `provider/model` ids hidden from pickers, routing and the status bar. Toggle them in **Settings → Models** |
| `localpilot.models.autoSetup` | `true` | Offer to install Ollama and a starter model when no local model is found |
| `localpilot.models.autoTune` | `auto` | Learn from local telemetry which installed models work best per role. `auto` updates role settings when another model is measurably better (with Undo); `suggest` only offers changes; `off` disables learning. Needs `localpilot.telemetry.enabled`. See [Learning from your usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}) |
| `localpilot.contextWindow` | `32768` | Requested context in tokens (Ollama `num_ctx`), capped by the model's maximum. `0` = the model's full native window, which needs enough RAM/VRAM. Compaction is budgeted against the same number |
| `localpilot.maxOutputTokens` | `4096` | Maximum tokens per response |
| `localpilot.temperature` | `-1` | Sampling temperature. `-1` uses each model's own setting (Gemma 4 and Qwen 3 ship 1.0 and repeat themselves at low temperatures); 0–2 forces one value for every model |
| `localpilot.thinking` | `auto` | Extended thinking for reasoning models: `auto`, `off`, `on`, `low`, `medium`, `high` or `max`. A chat can override it with the composer's **Think** chip (CLI: `--thinking`, `/thinking`). `auto` picks per task: high for Plan and Debug, medium for Agent and Multitask, low for Ask and subagents, none for quick helpers. `off` explicitly tells thinking models not to reason. Sent as Ollama `think` or OpenAI-compatible `reasoning_effort`; Ollama models other than gpt-oss take only on or off, so `low` skips the reasoning and `medium` or `high` send `think: true`. Reasoning shows as a collapsible step |
| `localpilot.keepAlive` | `30m` | How long Ollama keeps the model loaded after a request (for example `5m`, `30m`, or `-1` for forever). Avoids reload delays between turns |
| `localpilot.prewarm` | `true` | Load the chat's model as soon as you focus the composer or switch models, so the first reply does not wait for a weight load. Ollama only; at most once every few minutes per model |
| `localpilot.ollama.flashAttention` | `true` | Start Ollama with flash attention (`OLLAMA_FLASH_ATTENTION`): faster prompt processing and a smaller KV cache on supported models. Applies when LocalPilot starts or restarts Ollama |
| `localpilot.ollama.kvCacheType` | `q8_0` | KV cache quantisation for Ollama (`OLLAMA_KV_CACHE_TYPE`): `f16`, `q8_0` (about half the memory of `f16`) or `q4_0` (about a quarter, small quality loss on long contexts). Needs flash attention; applies when LocalPilot starts or restarts Ollama |

## colibri

Settings for [colibri]({{ '/docs/models/#colibri-huge-moe-models-from-disk' | relative_url }}), which runs very large mixture-of-experts models by streaming experts from disk. They are used by *LocalPilot: Start Colibri Server*. A running `coli serve` is detected whatever these are set to. They are also at the bottom of **Settings → Providers**, with a **Start colibri** button.

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
| `localpilot.routing.fallbackModels` | `[]` | Models to use, in this order, when the chosen model is unavailable (server down, model removed, offline and it is a cloud model), as `provider/model` ids. The first available one answers the turn and the chat says *next in your fallback order*; with none available (or an empty list) the best available model is used. A cloud model in this list is the only way a local model falls back to the cloud. User settings only. Edit it in **Settings → Models → Routing → Fallback order** |
| `localpilot.firstTokenTimeoutSeconds` | `180` | Seconds a request may wait for the model's first token (loading into memory, reading a long prompt) before it counts as stalled and is retried; `0` = no limit. A provider's `timeoutMs` is a floor, and a request queued behind others gets their time too. While it waits, the chat offers **Keep waiting** (another full wait), **Switch model** and, with a fallback order, the first fallback model |

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
| `localpilot.editTool` | `auto` | File-editing tool the agent gets. `auto`: GPT, Codex and gpt-oss models get `apply_patch` (one patch updates, adds, moves and deletes several files after a single approval), other models get `edit_file` and `write_file`. `edit_file` or `apply_patch` forces one of them |
| `localpilot.diffPreview` | `onApproval` | Side-by-side diff (`Original ↔ LocalPilot (proposed)`) of what `edit_file`, `write_file` or `apply_patch` will write. `onApproval`: opens next to the approval card and closes when you approve or deny. `always`: also for edits approved automatically (including by *Allow for session*). `off`: never (edits happen in the background) |
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
| `localpilot.approvals.dangerousAlwaysAsk` | `true` |
| `localpilot.notifications` | `whenHidden` |

All approval settings are User settings only, so a repository cannot approve its own actions. **Always allow in this workspace…** on an approval card is kept by LocalPilot for that workspace instead (the auto-approve bar marks it *workspace*; pick another value there, or press **Ask again** in Settings → Agent & approvals → Command rules, to end it).

**Command rules.** Settings → Agent & approvals → **Command rules** lists the commands you always allow, always ask about or block, as `Bash(<pattern>)` permission rules: `npm test` matches exactly, `npm run test:*` by prefix, `git log *` with wildcards. Block wins over Ask, Ask over Allow. Rules for this workspace are saved in `.localpilot/settings.local.json` (added to `.git/info/exclude`), rules for all workspaces in `~/.localpilot/settings.json`; rules in other settings files (`.claude/settings.json`, a committed `.localpilot/settings.json`) are listed read-only. The arrow next to **All in chat** on an approval card offers *Always allow "…"* and *Always block "…"* for a single command. An Allow rule skips the prompt even for a command that looks destructive, so keep Allow rules narrow.

Values: `always`, `ask`, `never`. `approvals.terminal` also takes `safe`: read-only commands and routine test, lint and build commands (`npm test`, `tsc`, `pytest`, `cargo test`, `go vet`, `make test`) run without asking, everything else asks. With `approvals.dangerousAlwaysAsk` on, a destructive-looking command (`sudo`, `rm -rf /…`, `git push --force`, `git reset --hard`) asks even under `always`. The model can mark a command `requires_approval` so it asks under `always` or `safe` too. The **Auto-approve** bar above the chat input changes these settings for all chats, and the change also applies to a run in progress.

`localpilot.notifications` (`whenHidden`, `always`, `off`): a native notification with **Open chat** when a chat finishes, when it waits for your approval or answer, or when an auto-approved command is still running after 30 seconds. With `whenHidden` this happens only while the chat view is hidden or the window is not focused, and a run that finished normally is announced only when it took longer than 20 seconds (errors and runs that need you always are). The terminal CLI rings the bell after runs longer than 10 seconds unless this is `off`.

**Auto mode** (`localpilot.autoMode.enabled`, default `false`; toggle with **LocalPilot: Turn Auto Mode On/Off**): every approval set to `ask` is first reviewed by a small local model (`localpilot.autoMode.model`, empty = the fastest suitable one). It approves actions that clearly serve your request and stay inside the project. Pushes, `sudo`, recursive deletes, piping downloads into a shell, publishing and writes to secrets or `.git` always ask. The reviewer can only approve, never deny, and any reviewer error falls back to asking.

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
  "allowedMcpServers": ["github", { "name": "jira", "url": "https://mcp.corp.example/jira" }], // other MCP servers do not start; a url or command pins what the name may point at
  "mcpServers": {                     // the organization's MCP servers (the mcp.json shape); they win over any server of the same name
    "docs": { "url": "https://mcp.corp.example/docs", "alwaysEnabled": true }
  },
  "blockPersonalRemoteMcp": true,     // remote (URL) servers start only when the policy lists their URL
  "providers": [                      // merged into every user's providers and locked; users only add their key
    { "id": "corp", "type": "openai", "baseUrl": "https://llm.corp.example/v1", "headers": { "X-Team": "eng" } }
  ],
  "allowedModels": ["corp/*", "ollama/qwen*"],  // globs over provider/model; other models are not listed or routed to
  "telemetry": {                      // overrides the user's telemetry settings
    "enabled": true,                  // force local recording on (or off)
    "allowRemoteExport": false,       // the user's own OTLP export and Redis storage stay off (the default)
    "otlp": { "endpoint": "https://otel.corp.example:4318", "headers": { "x-api-key": "…" } } // exported here regardless of the user's opt-out and OTEL_* variables
  },
  "allowSkillInstall": false,         // no skill downloads; skills from a local folder still install
  "auditLog": "/var/log/localpilot/${workspaceFolder}.jsonl"  // every tool call and approval, as JSON Lines
}
```

Rules use the same syntax as [permission rules](claude-code-compatibility.md) in `settings.json`. Every key is optional. A policy file that exists but cannot be parsed fails closed: cloud providers, web access, remote MCP servers, telemetry export and skill downloads are switched off, and every action needs approval, until it is fixed.

The organization's providers are exempt from `allowCloudProviders` and `allowedProviderHosts`. Users enter their key on the provider's card in **Settings → Providers** or with `localpilot providers key <id>`; `localpilot providers remove` refuses them. A user can switch off an organization MCP server unless it has `"alwaysEnabled": true`.

**Organization rules, skills and commands.** The `rules/`, `skills/` and `commands/` folders next to the policy file are loaded as an extra layer with the source *organization*. Organization rules come last in the prompt, so they take precedence and are the last to be cut by the size limit. Organization skills and commands take precedence over workspace and user ones with the same name. These items can be opened from **Settings → Customize** but not changed or deleted there. An organization item with `alwaysEnabled: true` in its front matter cannot be switched off; the key is ignored in workspace and user rules, skills and commands.

Users see the policy in **Settings** (a note on the Agent & approvals, Providers, Skills, MCP and Web search pages), in `/permissions` in the chat, and in `localpilot doctor`. Every setting the policy decides shows a lock icon with the tooltip *Managed by your organization*, and its control is disabled and shows the value the policy applies, not the one stored in your settings. The setup wizard does not save approval values the policy forbids. Approval options below a floor are greyed out. When the organization exports telemetry, the Dashboard says where. Each audit record has the time, user, host, workspace, session, tool, its arguments (cut at 2,000 characters), the outcome, and whether the policy blocked it. Approvals are recorded with who decided: the setting, the policy, Auto mode or the user.

## Terminal

| Setting | Default | Description |
|---|---|---|
| `localpilot.terminal.runInIntegratedTerminal` | `true` | Run the agent's `run_command` calls in a visible **LocalPilot Agent** terminal so you can watch them. Falls back to a hidden process when the shell has no shell integration or this is off |
| `localpilot.terminal.reveal` | `true` | Show the LocalPilot Agent terminal, without taking focus, when the agent runs a command |
| `localpilot.terminal.shellIntegrationTimeout` | `4000` | Milliseconds to wait for shell integration in the agent terminal before running the command in a hidden process (minimum 500) |
| `localpilot.terminal.profile` | `default` | Shell for agent commands: `default` or a profile name from `terminal.integrated.profiles.<os>`. Pick one with **LocalPilot: Select Agent Terminal Profile…** |
| `localpilot.edit.reportNewErrors` | `true` | After `edit_file`, `write_file` or `apply_patch`, wait up to 1.5 s for the language server and append the new errors in that file (at most 10) to the tool result. No effect in the CLI |
| `localpilot.terminal.autoDetachSeconds` | `300` | Seconds a `run_command` call may run before the agent proceeds while it keeps running; later output goes to a log the agent can read. `0` = never detach (the command is stopped at its timeout) |

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

## Self-healing

How LocalPilot detects, fixes and verifies failures. In the Settings screen they are under **Agent & approvals → Self-healing**, with the **Retry configuration** table, the detected checks for the workspace and **Open checks.json**. See [Self-healing & recovery]({{ '/docs/self-healing/' | relative_url }}).

| Setting | Default | Description |
|---|---|---|
| `localpilot.healing.enabled` | `true` | The self-healing engine: detect, diagnose, fix and re-check until the task is verified or a budget is reached. Off = the behaviour without a quality gate (no checks, no security check). Ignored in an untrusted workspace, so a cloned repository cannot turn it off |
| `localpilot.healing.autoDetect` | `true` | Classify tool, model and check failures after every step |
| `localpilot.healing.autoRetry` | `true` | Retry transient failures (model timeouts, unreachable servers, dropped MCP connections) with backoff. Only calls that produced no output are retried |
| `localpilot.healing.autoFix` | `true` | Diagnose and fix deterministic failures (compile errors, failing tests, required lint). Off = detect and report only |
| `localpilot.healing.regressionRequired` | `true` | A task is only *completed* when the full relevant test suite passes after a fix, not just the affected tests |
| `localpilot.healing.maxRepairAttempts` | `3` | Fix-and-recheck attempts per code-fix category (0–10). `0` = never fix automatically |
| `localpilot.healing.maxTotalAttempts` | `8` | Recovery attempts per task across all categories (0–30) |
| `localpilot.healing.extraSteps` | `16` | Extra model steps a recovery may use beyond `localpilot.maxIterations` (0–60) |
| `localpilot.healing.taskDeadlineMinutes` | `60` | Recovery deadline, counted from the first detected failure and applied only while recovering. `0` = none |
| `localpilot.healing.checkTiming` | `onComplete` | `onComplete`: run the checks when the agent says it is done. `afterEdits`: also a fast typecheck or build after steps with edits |
| `localpilot.healing.scopeTests` | `true` | Run the tests affected by the changed files before the full suite |
| `localpilot.healing.checkTimeoutSeconds` | `300` | Reserved; discovered checks currently use fixed limits by kind (build, typecheck and custom 300 s, lint 180 s, tests 600 s, security 120 s). To change a limit, set `timeoutSeconds` on the check in `localpilot.healing.checks` or `.localpilot/checks.json`. A timed-out check leaves the task *Not verified* |
| `localpilot.healing.checkTimeBudgetSeconds` | `900` | Total time one verification run may spend on checks (30–7200) |
| `localpilot.healing.baseline` | `fast` | Checks run before the first edit so preexisting failures are not blamed on the task: `fast` (typecheck + lint), `all` (tests too) or `off` |
| `localpilot.healing.checks` | `[]` | Checks that override (same `id`) or add to the discovered ones: `id`, `kind`, `command`, `cwd`, `scoped`, `timeoutSeconds`, `required`, `when`. `.localpilot/checks.json` takes precedence. A workspace value is ignored in an untrusted workspace (and in the CLI without `--trust-workspace`) |
| `localpilot.healing.policies` | `{}` | Per-category overrides, e.g. `{ "unit_test": { "attempts": 2, "backoffMs": [1000], "timeoutSeconds": 600 } }`. Safety limits cannot be raised: `security` at most 3 attempts; `data_corruption`, `git_conflict`, `permission` and `loop` always escalate |
| `localpilot.healing.dependencyInstall` | `ask` | `ask`: every install shows a mandatory approval. `never`: a missing package is reported and the task is blocked. **User settings only** |
| `localpilot.healing.gitConflicts` | `escalate` | The only value in this release: conflicted files are left untouched and handed to you for review. Never resolved automatically |
| `localpilot.healing.securityCheck` | `changed` | `changed`: offline scan of changed files for secrets and risky code. `full`: also known-vulnerable dependencies (asks before going online). `off`. A finding blocks completion until fixed or you accept the risk. **User settings only**, so a repository cannot switch it off |
| `localpilot.healing.delegateFixes` | `true` | Fix independent groups of failures in parallel fixer subagents |
| `localpilot.healing.memory` | `workspace` | Failure memory: `workspace` (local storage), `project` (`.localpilot/recovery-memory.json`, read only in trusted workspaces) or `off` |

There is no setting to bypass a security finding; the Settings screen shows *Security bypass: disabled (cannot be enabled)*.

## Telemetry & storage

These settings control the local metrics behind the [Dashboard]({{ '/docs/dashboard/' | relative_url }}). The extension does not upload them unless you turn on OTLP export to your own collector. See [Privacy]({{ '/privacy/' | relative_url }}).

| Setting | Default | Description |
|---|---|---|
| `localpilot.telemetry.enabled` | `true` | Record local usage metrics (model calls, tokens and latency, tool runs, agent turns, inline completions, provider health) to daily JSONL files in `~/.localpilot/telemetry`. Also needed by `localpilot.models.autoTune` |
| `localpilot.telemetry.retentionDays` | `30` | Days of metrics and log files to keep. Older files are deleted automatically. `0` keeps everything |
| `localpilot.telemetry.otlp.enabled` | `false` | Opt-in. Also send telemetry to your own OpenTelemetry collector over OTLP/HTTP JSON (see [Dashboard]({{ '/docs/dashboard/#export-to-opentelemetry' | relative_url }})). Needs `localpilot.telemetry.enabled`; nothing is exported while it is off. User settings only |
| `localpilot.telemetry.otlp.endpoint` | `http://localhost:4318` | Base URL of the OTLP/HTTP receiver; `/v1/logs`, `/v1/metrics` and `/v1/traces` are appended. `OTEL_EXPORTER_OTLP_ENDPOINT` overrides it |
| `localpilot.telemetry.otlp.headers` | `{}` | Extra HTTP headers (e.g. `Authorization`). `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`) adds to and overrides them |
| `localpilot.telemetry.otlp.metricsInterval` | `60` | Seconds between metric exports. `OTEL_METRIC_EXPORT_INTERVAL` (milliseconds) overrides it |
| `localpilot.telemetry.otlp.exporters` | `["otlp"]` | `otlp`: logs and metrics to the endpoint; `traces`: run, model-call and tool-call spans; `console`: also print every export to the log |
| `localpilot.telemetry.otlp.traceSamplePercent` | `100` | Share of agent runs traced (0–100); a run's spans are kept or dropped together |
| `localpilot.telemetry.otlp.recordContent` | `false` | Put prompts, replies, tool arguments and results on spans. Off: spans carry only names, timings, tokens and outcomes (a failure's status message is a fixed `tool error` or the run outcome, not the error text) |
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
| `localpilot.showTips` | `true` | While the agent has been thinking for more than 4 seconds, rotate short feature tips (steering, `@` mentions, `/compact`, checkpoints, quoting, …) in the chat's status row. The tips are built in |
| `localpilot.sessions.retention` | `50` | Maximum chats in a workspace's chat list. The oldest idle chats move to Archived when a new one starts (removed only when conversation storage is off); pinned and running chats do not count. `0` keeps everything |
| `localpilot.history.includeCli` | `true` | List sessions from the `localpilot` CLI for the same folder in the chat history, marked **CLI**. They are read from `~/.localpilot/workspaces/` (or `LOCALPILOT_DATA_DIR`). Takes effect after a window reload |
| `localpilot.memory.enabled` | `true` | Let the agent save and read durable notes (`.localpilot/memory/` and global storage). Manage notes in **Settings → Memory & history** |
| `localpilot.memory.autoSave` | `true` | After a run with at least three tool calls in which the agent saved nothing itself, ask the same model whether the run revealed durable project facts (build and test commands, conventions, pitfalls) and append at most three short notes to project memory. Runs after the answer; anything that looks like a credential is dropped. Needs `localpilot.memory.enabled` |
| `localpilot.memory.maxNoteChars` | `8000` | Largest memory note; longer notes lose their oldest paragraphs. Appending lines a note already has does nothing |
| `localpilot.memory.maxNotes` | `200` | Notes kept per scope; past it the least recently updated are removed (`README` is kept) |
| `localpilot.memory.taskExpiryDays` | `14` | Task memory (a plan's or todo list's checklist and notes) moves to Trash this many days after every todo is done |
| `localpilot.showWelcomeOnStartup` | `true` | Open the **Setup** screen (*LocalPilot: Open Setup*) the first time LocalPilot starts without a reachable model server or default model |

## Conversation storage

Conversations, memory, attachments and backups are kept in one data folder per computer, shared by VS Code and the
`localpilot` CLI, and managed in **Settings → Continuity & sync**. See
[Conversations, memory & sync]({{ '/docs/continuity/' | relative_url }}).

| Setting | Default | Description |
|---|---|---|
| `localpilot.continuity.dataDir` | `""` | Data folder. Empty uses `~/.localpilot/continuity` (or `$LOCALPILOT_DATA_DIR/continuity`; `LOCALPILOT_CONTINUITY_DIR` sets the folder itself). Machine setting; takes effect after a window reload, and nothing is moved for you |
| `localpilot.continuity.trashRetentionDays` | `30` | Days deleted items stay in Trash before they are removed for good. `0` keeps them until you empty Trash |
| `localpilot.continuity.historyDays` | `90` | Days of version history kept (minimum 7). Older changes are folded into the current state |
| `localpilot.continuity.indexMaxMB` | `256` | Largest search index (minimum 32). Past it, archived and deleted conversations older than 180 days are searchable by title only |
| `localpilot.continuity.backup.enabled` | `true` | Back up conversations, memory and attachments automatically to the data folder's `backups` folder |
| `localpilot.continuity.backup.intervalDays` | `7` | Days between automatic backups |
| `localpilot.continuity.backup.keep` | `4` | Automatic backups kept |
| `localpilot.continuity.relatedConversations` | `true` | While you write the first message of a new chat, offer up to three related earlier conversations of the project (**Related: … · Add**). Nothing is added until you click **Add** |
| `localpilot.continuity.captureToolOutput` | `summary` | How much of each tool call's output an agent run's history keeps (**What ran** on the Run interrupted card, `localpilot history show --runs`): `errors` (only the error text of failed steps), `summary` (the first 2 KB of every step) or `full` (everything; over 2 KB as an attachment) |

### Sync

Sync between your devices through storage you choose, end-to-end encrypted (see
[Sync across devices]({{ '/docs/continuity/' | relative_url }}#sync-across-devices)). Set it up in **Settings →
Continuity & sync → Sync** or with `localpilot sync setup`; the passphrase, the S3 secret key and the WebDAV password are
never settings (they live in the OS keychain, or `~/.localpilot/keys.json` for the CLI). All are machine settings.

| Setting | Default | Description |
|---|---|---|
| `localpilot.sync.enabled` | `false` | Sync on this device. Set up sync turns it on |
| `localpilot.sync.backend` | `folder` | `folder`, `git`, `s3` or `webdav` |
| `localpilot.sync.folder.path` | `""` | Folder to sync through (a cloud drive folder or a network share); LocalPilot writes `localpilot-sync` inside it |
| `localpilot.sync.git.url` | `""` | A dedicated, empty Git repository (never a project's own) |
| `localpilot.sync.git.branch` | `localpilot-sync` | Branch of the sync repository |
| `localpilot.sync.s3.endpoint` | `""` | S3 endpoint URL (HTTPS; plain HTTP only for localhost) |
| `localpilot.sync.s3.region` | `us-east-1` | Region (`auto` for Cloudflare R2) |
| `localpilot.sync.s3.bucket` | `""` | Bucket |
| `localpilot.sync.s3.prefix` | `""` | Folder in the bucket (optional) |
| `localpilot.sync.s3.accessKeyId` | `""` | Access key ID; the secret key is kept in the keychain |
| `localpilot.sync.s3.pathStyle` | `null` | `true`: `endpoint/bucket` addressing; `false`: `bucket.endpoint`; empty: path style except on AWS |
| `localpilot.sync.webdav.url` | `""` | WebDAV folder URL (HTTPS; plain HTTP only for localhost) |
| `localpilot.sync.webdav.username` | `""` | WebDAV user; the password is kept in the keychain |
| `localpilot.sync.intervalMinutes` | `5` | Minutes between automatic syncs (also 15 s after a change, on focus, and on Sync now) |
| `localpilot.sync.categories` | all on except `checkpointContents` | `conversations`, `memory`, `attachments`, `agentState`, `checkpointContents`, `prompts`, `preferences`. A category turned off stays on this device; turning it on later sends what it held back |
| `localpilot.sync.maxAttachmentMB` | `20` | Largest attachment synced (with Git, over 5 MB stays local) |
| `localpilot.sync.deviceName` | `""` | This device's name on your other devices (empty: the computer's name) |

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

| Setting | Default | Description |
|---|---|---|
| `localpilot.mcp.watchServerFiles` | `true` | Restart a local MCP server 500 ms after its workspace script changes (a `.js`, `.mjs`, `.cjs` or `.py` file in its command or arguments, or a file under `build/` or `dist/`) |
| `localpilot.mcp.toolApprovals` | `{}` | Approval per MCP tool, `{ "server": { "tool": "always" \| "ask" \| "never" } }`. `ask` shows an approval card every time (even when the server's `autoApprove` lists the tool or `approvals.mcp` is `always`), `never` refuses every call without asking. Unlisted tools follow `approvals.mcp` and the server's `autoApprove` list; an organization floor still applies. User settings only. Set it per tool in **Settings → MCP servers** (open a connected server, **Tools** tab) |

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
