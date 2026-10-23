---
layout: docs
title: Use Ollama in VS Code as a full coding agent
description: Turn Ollama into a Copilot-style agent inside VS Code with LocalPilot — tool calling, file edits, terminal commands, parallel agents and screenshots, all offline.
permalink: /guides/ollama-vscode/
keywords: Ollama VS Code, Ollama VS Code extension, Ollama coding assistant, Ollama agent VS Code, qwen2.5-coder VS Code, local copilot ollama
---

[Ollama](https://ollama.com) makes running models like `qwen2.5-coder`, `llama3.3` or `devstral` a one-liner — but on its own it is just a chat endpoint. **LocalPilot** turns it into a complete coding agent inside VS Code: it reads your project, edits files, runs your tests, and fixes what breaks.

## Setup in two minutes

**Zero-setup path:** install LocalPilot, open the sidebar and click **Set up automatically**. LocalPilot installs Ollama if needed (Homebrew / winget / official script), starts it, and pulls `qwen2.5-coder` in the size that fits your machine (7b on 16 GB+, 3b or 1.5b below that) plus `qwen2.5-coder:1.5b` for inline completions.

**Manual path:**

```bash
ollama pull qwen2.5-coder:7b       # 14b / 32b from Settings → Models once you know it fits
ollama serve                        # usually already running as a service
```

Install LocalPilot ([download VSIX]({{ site.download }}) → `code --install-extension localpilot.vsix`), open the sidebar, and pick `ollama/qwen2.5-coder:7b` from the model dropdown. Ollama on `localhost:11434` is detected automatically. **Settings → Models** lists every Ollama model with its size and lets you pull more from the catalog, delete models and switch them on or off without leaving VS Code.

## What you get beyond the Ollama CLI

| Capability | How LocalPilot uses Ollama |
|---|---|
| **Tool calling** | Native `/api/chat` tools for models that support them (qwen2.5-coder, qwen3, llama3.x, mistral); prompt-based fallback for the rest |
| **Large context** | Sets `num_ctx` per request (default 32k) so the model actually sees your files, then prunes/compacts history automatically |
| **Thinking models** | `localpilot.thinking` enables Ollama's `think` for qwen3 / deepseek-r1 and shows the reasoning collapsed |
| **Vision** | Screenshots and pasted images go to `qwen2.5vl`, `llava`, `gemma3` |
| **Inline completions** | Ollama's FIM `suffix` support; routing picks the smallest FIM model (`qwen2.5-coder:1.5b`) automatically |
| **Model management** | `ollama pull` / `ollama rm` from the Settings UI with progress, hardware-aware size recommendations, per-model enable/disable |
| **Parallel agents** | Several sessions at once; set `OLLAMA_NUM_PARALLEL=4` so Ollama serves them concurrently |

## Recommended Ollama models

- **Agent work:** `qwen2.5-coder:7b` (8 GB+), `qwen2.5-coder:14b` (16 GB), `qwen2.5-coder:32b` (24 GB+), `devstral`, `qwen3:14b`, `gpt-oss:20b`
- **Fast completions:** `qwen2.5-coder:1.5b`, `starcoder2:3b`
- **Screenshots:** `gemma3:4b`, `qwen2.5vl:7b`, `gemma3:12b`

The catalog in **Settings → Models** marks each size *fits / tight / too big* for your machine and stars the recommended one, so you don't have to guess.

## Tips

- Raise `localpilot.contextWindow` to 65536 on 32B models with enough memory; Ollama's own default is only 2–4k.
- Keep the model loaded between turns: `OLLAMA_KEEP_ALIVE=30m`.
- Remote Ollama box? Add `{ "id": "gpu-box", "type": "ollama", "baseUrl": "http://10.0.0.5:11434" }` to `localpilot.providers`.

Next: [Getting started]({{ '/docs/getting-started/' | relative_url }}) · [Models & providers]({{ '/docs/models/' | relative_url }}) · [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }})
