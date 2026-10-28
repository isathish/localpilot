---
layout: docs
title: Offline AI coding assistant for VS Code — private, air-gapped, self-hosted
description: Run an AI coding assistant in VS Code with no internet using LocalPilot and a local model. What needs network, what doesn't, and how to lock it down.
permalink: /guides/offline-ai-coding-assistant/
keywords: offline AI coding assistant, air-gapped AI coding, private AI code assistant, self-hosted AI coding assistant, on-prem copilot, local LLM VS Code, enterprise private coding assistant
---

You can run an AI coding assistant in VS Code with no internet connection. Install LocalPilot, download a model into a local server such as Ollama while you are still online, then disconnect. Chat, agent edits, terminal commands, tests and inline completions keep working against the local model. The data path is short: VS Code → LocalPilot → your model server.

Two honest limits. Local models are weaker than frontier cloud models, so expect more retries on hard tasks. And the model must fit in your machine's memory, which sets the quality ceiling.

## What needs the network and what does not

| Works offline | Needs network |
|---|---|
| Chat, Agent, Ask and Plan modes | Installing Ollama or LM Studio |
| File edits, terminal commands, diagnostics | Downloading models (setup, catalog, model gallery search) |
| Inline completions | The skill registry index from GitHub (`localpilot.skills.autoInstall`, default `auto`) |
| Parallel agents, worktrees, change review | Web search, web fetch and browser tools on external URLs |
| Built-in skills and subagents, the local Dashboard | MCP servers that call remote services |

The extension sends no telemetry and has no update check. VS Code itself may still update extensions and send its own telemetry; those are VS Code settings, covered below. The [privacy page]({{ '/privacy/' | relative_url }}) lists every outbound request the extension can make.

## Lock it down

1. **Run the model server on the same machine or your LAN.** Ollama, LM Studio, llama.cpp `llama-server` and vLLM all run without internet once the models are on disk.
2. **Install LocalPilot from the VSIX** on the [releases page]({{ site.releases }}). Verify it against the `SHA256SUMS.txt` file from the same release:

   ```bash
   sha256sum -c --ignore-missing SHA256SUMS.txt        # Linux
   shasum -a 256 -c --ignore-missing SHA256SUMS.txt    # macOS
   ```

3. **Block network tools.** Set `localpilot.approvals.network` to `never`. This blocks web search, web fetch, the browser tools and all MCP tools. Use `ask` instead if you want to approve each call, for example for an MCP server on your LAN.
4. **Turn off the skill index.** Set `localpilot.skills.autoInstall` to `off`. Built-in skills and skills already in your project keep working.
5. **Review commands.** Keep `localpilot.approvals.terminal` at its default `ask`, so you approve every shell command.
6. **Check what changed.** The Agents panel lists every file each session touched, and you can undo a session's edits.

```jsonc
// settings.json for an air-gapped workstation
{
  "localpilot.providers": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://127.0.0.1:11434" }],
  "localpilot.approvals.network": "never",
  "localpilot.approvals.terminal": "ask",
  "localpilot.skills.autoInstall": "off",
  // VS Code's own settings, not LocalPilot's:
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false
}
```

Auto-detection only adds servers that answer on your machine. Listing a single provider, as above, makes the configuration explicit.

## Size the hardware

**Settings → Models** reads your RAM, CPU cores and GPU memory, shows a *model budget*, and marks every catalog size *fits*, *tight* or *too big*. Automatic setup starts with a small model and leaves larger ones as an explicit upgrade. As a rough guide (sizes are downloads from LocalPilot's catalog):

| Machine | Models that run comfortably |
|---|---|
| 8 GB laptop | `qwen2.5-coder:3b` (1.9 GB), plus `qwen2.5-coder:1.5b` (1.0 GB) for completions |
| 16–24 GB Apple Silicon | `qwen2.5-coder:7b` (4.7 GB), `qwen2.5-coder:14b` (9.0 GB), `gemma3:4b` (3.3 GB) for screenshots |
| 32–64 GB unified memory or a 24 GB GPU | `qwen2.5-coder:32b` (20 GB), `devstral` (14 GB), `qwen3:32b` (20 GB), `gpt-oss:20b` (14 GB) |
| Shared GPU server running vLLM | Larger models served to the whole team over an OpenAI-compatible endpoint |

Download every model before you go offline, with `ollama pull …` or the catalog's **Install** button.

### Very large models on modest RAM: colibri

[colibri](https://github.com/JustVugg/colibri) runs large mixture-of-experts models by keeping the dense part in RAM and streaming the experts from disk. That lets a 16 GB machine run models whose downloads are hundreds of gigabytes, fully offline once downloaded. The cost is speed: a model that streams from disk can take minutes before the first token and decodes at about one token per second or slower. It suits one careful Plan-mode answer, not a chatty agent loop. See [Run huge MoE models with colibri]({{ '/guides/colibri-vscode/' | relative_url }}).

## Roll it out to a team

- Serve one vLLM or Ollama endpoint on the LAN and point every developer's `localpilot.providers` at it.
- Commit `AGENTS.md` or `.localpilot/rules.md`, and `.localpilot/skills/`, so every agent follows the same conventions.
- Distribute a pinned VSIX internally. Each release's VSIX is built by the project's CI from the tagged commit, and the release lists its SHA-256 checksums.

Next: [Configuration]({{ '/docs/configuration/' | relative_url }}) · [Parallel agents & change review]({{ '/docs/parallel-agents/' | relative_url }}) · [Privacy]({{ '/privacy/' | relative_url }})
