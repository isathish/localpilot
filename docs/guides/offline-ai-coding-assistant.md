---
layout: docs
title: Offline AI coding assistant for VS Code — private, air-gapped, self-hosted
description: How to run a fully offline AI coding assistant in VS Code with LocalPilot — no internet, no accounts, no telemetry. Works on air-gapped machines and in regulated environments.
permalink: /guides/offline-ai-coding-assistant/
keywords: offline AI coding assistant, air-gapped AI coding, private AI code assistant, self-hosted AI coding assistant, on-prem copilot, local LLM VS Code, enterprise private coding assistant
---

Teams in finance, healthcare, defence and anyone with an NDA need an assistant whose data path they can audit. LocalPilot's data path is one line long: **VS Code → your model server**.

## Zero-network checklist

1. **Model server on the same machine or LAN** — Ollama, LM Studio, llama.cpp `llama-server` or vLLM. All run without internet once models are downloaded.
2. **LocalPilot installed from the VSIX** — no activation call-home, no update checks, no telemetry. Verify with `SHA256SUMS.txt` from the [release]({{ site.releases }}).
3. **Web tools off** — set `localpilot.approvals.network` to `never` to hard-block `web_search`, `web_fetch` and MCP network tools.
4. **Approvals on** — keep `localpilot.approvals.terminal` at `ask` so every shell command is reviewed.
5. **Audit what changed** — the Agents panel lists every file each session touched; Undo restores pre-agent content.

```jsonc
// settings.json for an air-gapped workstation
{
  "localpilot.providers": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://127.0.0.1:11434" }],
  "localpilot.approvals.network": "never",
  "localpilot.approvals.terminal": "ask",
  "localpilot.webSearch.provider": "searxng"   // irrelevant when network is 'never', kept explicit
}
```

## Sizing hardware

LocalPilot does this for you: **Settings → Models** reads RAM, cores and GPU memory, shows a *model budget*, and marks every catalog size *fits / tight / too big*. Automatic setup starts with the smallest useful model and leaves bigger ones as an explicit upgrade. As a rule of thumb:

| Setup | Comfortable models |
|---|---|
| 8 GB laptop | `qwen2.5-coder:3b` + `qwen2.5-coder:1.5b` for completions |
| MacBook Pro M-series 16–24 GB | `qwen2.5-coder:7b`, `qwen2.5-coder:14b` (q4), `gemma3:4b` for screenshots |
| 32–64 GB unified / 24 GB GPU | `qwen2.5-coder:32b`, `devstral`, `qwen3:32b`, `gpt-oss:20b` |
| Shared GPU server (vLLM) | 32B–72B models for the whole team, OpenAI-compatible endpoint |

Pre-download models before going offline (`ollama pull …` or the catalog's **Install** button); the Ollama installer itself needs network once.

## Team roll-out

- Serve one vLLM or Ollama endpoint on the LAN and point every developer's `localpilot.providers` at it.
- Commit `AGENTS.md` / `.localpilot/rules.md` and `.localpilot/skills/` to the repo so every agent follows the same conventions.
- Pin the extension version by distributing the VSIX internally; releases are reproducible from the tagged source.

Next: [Configuration]({{ '/docs/configuration/' | relative_url }}) · [Parallel agents & change review]({{ '/docs/parallel-agents/' | relative_url }})
