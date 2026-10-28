---
layout: docs
title: A free, open-source GitHub Copilot alternative that runs locally
description: LocalPilot is a free, MIT-licensed coding agent for VS Code that runs on local models. How it compares with GitHub Copilot, Cursor and Claude Code.
permalink: /guides/github-copilot-alternative/
keywords: GitHub Copilot alternative, free Copilot alternative, Cursor alternative, Claude Code alternative, open source copilot, self-hosted copilot, local copilot VS Code
---

If you want a GitHub Copilot alternative that runs on your own hardware, LocalPilot is a free, MIT-licensed VS Code extension that does that. It runs a coding agent against local model servers such as Ollama, LM Studio, llama.cpp or vLLM. It needs no account and no subscription. Your code goes only to the model servers you configure, which are all on `localhost` by default. The trade-off is model quality: local models are weaker than the frontier cloud models that Copilot, Cursor and Claude Code use.

## Side by side

This table compares the products as they are documented by their vendors at the time of writing. Features and plans change, so check each vendor's documentation before you decide.

| | LocalPilot | GitHub Copilot (VS Code) | Cursor | Claude Code |
|---|---|---|---|---|
| Where it runs | VS Code extension | VS Code extension (and other IDEs) | Its own editor, a fork of VS Code | Terminal CLI, with IDE integrations |
| Models | Any local or self-hosted model you run | Cloud models; local models through bring-your-own-key | Cloud models; custom OpenAI-compatible endpoints | Anthropic's Claude models |
| Account needed | No | GitHub sign-in, also when using your own model key | Cursor account | Anthropic account or API key |
| Works with no internet | Yes, once models are downloaded | No | Check Cursor's docs | Not by default |
| Agent mode with approvals | Yes | Yes | Yes | Yes |
| MCP servers | Yes | Yes | Yes | Yes |
| Cost | Free (MIT) | Free tier and paid plans | Free tier and paid plans | Paid plan or API usage |
| Answer quality | Depends on your local model and hardware | Frontier cloud models | Frontier cloud models | Frontier cloud models |

About bring-your-own-key in Copilot: VS Code lets you add models from other providers, including a local Ollama, to Copilot Chat. You still sign in with GitHub, and some Copilot features keep using GitHub's service.

## What you give up

- **Model strength.** A 7B–14B local model is clearly weaker than frontier cloud models on large refactors and unfamiliar codebases. A 32B coder model on a 24 GB GPU or a 32 GB+ Apple Silicon Mac closes part of the gap for routine work. It does not close all of it.
- **Speed on small machines.** Response time depends on your CPU, GPU and memory. On a laptop without a GPU, expect long waits on larger models.
- **Hardware.** You need enough RAM or VRAM for the model. **Settings → Models** shows what fits your machine.

## What you get

- **A short data path.** Prompts and code go only to the model servers you configure. The extension sends no telemetry. The [privacy page]({{ '/privacy/' | relative_url }}) lists every outbound connection and how to turn each off.
- **No per-request costs or rate limits.** You pay for electricity and hardware, not tokens.
- **Your existing instructions carry over.** LocalPilot reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `.github/copilot-instructions.md` and `.claude/skills` from your project.
- **Agent features:** parallel agents in isolated git worktrees, Best-of-N runs across several models, 14 built-in skills and 9 built-in subagents, screenshots and vision models, and inline completions.
- **Copilot Chat can use your local models too.** LocalPilot registers its models with VS Code's Language Model API, so they can appear in the Copilot Chat model picker.

## Try it

```bash
ollama pull qwen2.5-coder:14b
curl -L -o localpilot.vsix {{ site.download }}
code --install-extension localpilot.vsix
```

`qwen2.5-coder:14b` is a 9 GB download. On a machine with 8 GB of RAM, start with `qwen2.5-coder:3b` or use **Set up automatically** in the LocalPilot sidebar, which picks a size for you.

Next: [Getting started]({{ '/docs/getting-started/' | relative_url }}) · [Features]({{ '/docs/features/' | relative_url }}) · [Compare on the home page]({{ '/#compare' | relative_url }})
