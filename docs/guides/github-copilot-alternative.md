---
layout: docs
title: A free, open-source GitHub Copilot alternative that runs locally
description: LocalPilot is a free GitHub Copilot and Cursor alternative for VS Code that runs entirely on your hardware with Ollama, LM Studio, llama.cpp or vLLM — agent mode, parallel agents, skills, screenshots and MCP without a subscription.
permalink: /guides/github-copilot-alternative/
keywords: GitHub Copilot alternative, free Copilot alternative, Cursor alternative, Claude Code alternative, open source copilot, self-hosted copilot, local copilot VS Code
---

If you want Copilot-class agentic coding **without** a subscription, usage limits, or sending source code to a third party, LocalPilot is built for exactly that.

## Side by side

| | LocalPilot | GitHub Copilot | Cursor | Claude Code |
|---|---|---|---|---|
| Runs fully offline / on-prem | **Yes** | No | No | No |
| Any local model (Ollama, LM Studio, vLLM…) | **Yes** | Limited (BYOK) | Limited | No |
| Agent mode with tools & approvals | Yes | Yes | Yes | Yes |
| Parallel agents + per-agent change review | **Yes** | Partial | Yes | Yes |
| Skills & custom subagents | Yes | Yes | Rules only | Yes |
| Screenshots / vision | Yes | Yes | Yes | Yes |
| MCP servers | Yes | Yes | Yes | Yes |
| Works inside VS Code | Yes | Yes | Separate IDE | Yes |
| Price | **Free, MIT** | Subscription | Subscription | Usage-based |
| Account / telemetry | **None** | Required | Required | Required |

## What you give up — honestly

- Frontier cloud models are still stronger than a 14B local model on the hardest tasks. A 32B coder model on a 24 GB+ GPU or Apple Silicon Mac closes most of the gap for day-to-day work.
- First-token latency depends on your hardware, not a data centre.

## What you gain

- **Privacy by construction** — nothing leaves the machine unless you configure a remote server.
- **No bills, no rate limits** — run agents all day.
- **Your existing rules carry over** — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.claude/skills` are read automatically.
- **It also plugs into Copilot Chat** — LocalPilot registers your local models with VS Code's Language Model API, so they appear in Copilot's model picker too.

## Try it

```bash
ollama pull qwen2.5-coder:14b
curl -L -o localpilot.vsix {{ site.download }}
code --install-extension localpilot.vsix
```

Then: [Getting started]({{ '/docs/getting-started/' | relative_url }}) · [Features]({{ '/docs/features/' | relative_url }}) · [Compare on the home page]({{ '/#compare' | relative_url }})
