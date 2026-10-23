---
title: Configuration
description: Every LocalPilot setting, with defaults.
permalink: /docs/configuration/
---

The easiest way to configure LocalPilot is its own **Settings** screen — click the gear icon in the chat toolbar or run *LocalPilot: Settings*. It has a page for each group below, shows whether a value comes from your User or Workspace settings, lets you reset any value, and includes a **provider manager** with a *Test connection* button that lists the models each server exposes.

The first time LocalPilot starts without a reachable model server it opens the **Welcome / Setup** wizard instead, which detects Ollama, LM Studio, llama.cpp and vLLM, recommends a model and sets an approval preset (*Careful*, *Balanced* or *Autonomous*). Run it again any time with *LocalPilot: Welcome / Setup*, or disable the automatic prompt with `localpilot.showWelcomeOnStartup`.

Everything is also available in **Settings → Extensions → LocalPilot** and in `settings.json`; the keys are listed below.

![LocalPilot Settings inside VS Code — Providers page with live connection status (Ollama reachable, others not running) and one-click presets to add more]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

Expand a provider to edit it and press **Test connection** — LocalPilot checks the server, measures latency and lists every model it exposes:

![Provider editor with a successful connection test against a running Ollama, listing its models]({{ '/assets/screenshots/settings-provider-test.png' | relative_url }})

![Agent & approvals page with the Careful / Balanced / Autonomous presets and per-action Ask / Allow / Block controls]({{ '/assets/screenshots/settings-agent.png' | relative_url }})

## Models

| Setting | Default | Description |
|---|---|---|
| `localpilot.providers` | Ollama, LM Studio, llama.cpp, vLLM on localhost | Model servers. See [Models & providers]({{ '/docs/models/' | relative_url }}) |
| `localpilot.defaultModel` | `""` (auto) | `provider/model`. Empty picks the best tool-capable coder model found |
| `localpilot.contextWindow` | `32768` | Requested context (Ollama `num_ctx`); capped by the model's maximum |
| `localpilot.maxOutputTokens` | `4096` | Max tokens per response |
| `localpilot.temperature` | `0.2` | Sampling temperature |
| `localpilot.thinking` | `false` | Extended thinking for reasoning models |

## Context

| Setting | Default | Description |
|---|---|---|
| `localpilot.compactionThreshold` | `0.75` | Fraction of the window at which pruning/summarising starts |
| `localpilot.maxToolOutputChars` | `24000` | Per-tool-output clamp (head + tail kept) |
| `localpilot.systemPromptAppend` | `""` | Extra instructions appended to every system prompt |
| `localpilot.skillsPaths` | `[]` | Additional skill folders |

## Approvals

| Setting | Default |
|---|---|
| `localpilot.approvals.terminal` | `ask` |
| `localpilot.approvals.write` | `always` |
| `localpilot.approvals.delete` | `ask` |
| `localpilot.approvals.network` | `always` |

Values: `always`, `ask`, `never`.

## Parallelism

| Setting | Default | Description |
|---|---|---|
| `localpilot.parallel.maxConcurrency` | `4` | Concurrent tool calls / subagents |
| `localpilot.parallel.maxSubagentDepth` | `2` | Nesting limit |

## Web search

| Setting | Default | Description |
|---|---|---|
| `localpilot.webSearch.provider` | `duckduckgo` | `duckduckgo` (no key), `searxng`, `brave`, `tavily` |
| `localpilot.webSearch.searxngUrl` | `http://localhost:8888` | Self-hosted SearXNG |
| `localpilot.webSearch.apiKey` | `""` | Brave / Tavily key |
| `localpilot.webSearch.maxResults` | `6` | |

## Inline completions

| Setting | Default | Description |
|---|---|---|
| `localpilot.inlineCompletion.enabled` | `false` | Ghost-text completions |
| `localpilot.inlineCompletion.model` | `""` | `provider/model`; empty uses the first FIM-capable model |
| `localpilot.inlineCompletion.debounceMs` | `350` | |
| `localpilot.inlineCompletion.maxTokens` | `128` | |

## MCP

`localpilot.mcpServers` — see [MCP servers]({{ '/docs/mcp/' | relative_url }}).

## Example

```jsonc
{
  "localpilot.defaultModel": "ollama/qwen2.5-coder:32b",
  "localpilot.contextWindow": 65536,
  "localpilot.approvals.terminal": "ask",
  "localpilot.inlineCompletion.enabled": true,
  "localpilot.inlineCompletion.model": "ollama/qwen2.5-coder:1.5b-base",
  "localpilot.webSearch.provider": "searxng",
  "localpilot.systemPromptAppend": "Use pnpm, not npm. Prefer functional React components."
}
```
