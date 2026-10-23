---
layout: docs
title: Use Ollama in VS Code as a full coding agent
description: Turn Ollama into a Copilot-style agent inside VS Code with LocalPilot — tool calling, file edits, terminal commands, parallel agents and screenshots, all offline.
permalink: /guides/ollama-vscode/
keywords: Ollama VS Code, Ollama VS Code extension, Ollama coding assistant, Ollama agent VS Code, qwen2.5-coder VS Code, local copilot ollama
---

[Ollama](https://ollama.com) makes running models like `qwen2.5-coder`, `llama3.3` or `devstral` a one-liner — but on its own it is just a chat endpoint. **LocalPilot** turns it into a complete coding agent inside VS Code: it reads your project, edits files, runs your tests, and fixes what breaks.

## Setup in two minutes

```bash
ollama pull qwen2.5-coder:14b      # or :32b if you have the VRAM
ollama serve                        # usually already running as a service
```

Install LocalPilot ([download VSIX]({{ site.download }}) → `code --install-extension localpilot.vsix`), open the sidebar, and pick `ollama/qwen2.5-coder:14b` from the model dropdown. Ollama on `localhost:11434` is detected automatically.

## What you get beyond the Ollama CLI

| Capability | How LocalPilot uses Ollama |
|---|---|
| **Tool calling** | Native `/api/chat` tools for models that support them (qwen2.5-coder, qwen3, llama3.x, mistral); prompt-based fallback for the rest |
| **Large context** | Sets `num_ctx` per request (default 32k) so the model actually sees your files, then prunes/compacts history automatically |
| **Thinking models** | `localpilot.thinking` enables Ollama's `think` for qwen3 / deepseek-r1 and shows the reasoning collapsed |
| **Vision** | Screenshots and pasted images go to `qwen2.5vl`, `llava`, `gemma3` |
| **Inline completions** | Ollama's FIM `suffix` support with `qwen2.5-coder:1.5b-base` or `codestral` |
| **Parallel agents** | Several sessions at once; set `OLLAMA_NUM_PARALLEL=4` so Ollama serves them concurrently |

## Recommended Ollama models

- **Agent work:** `qwen2.5-coder:14b` (16 GB), `qwen2.5-coder:32b` (24 GB+), `devstral`, `qwen3:14b`
- **Fast completions:** `qwen2.5-coder:1.5b-base`, `qwen2.5-coder:7b-base`
- **Screenshots:** `qwen2.5vl:7b`, `gemma3:12b`

## Tips

- Raise `localpilot.contextWindow` to 65536 on 32B models with enough memory; Ollama's own default is only 2–4k.
- Keep the model loaded between turns: `OLLAMA_KEEP_ALIVE=30m`.
- Remote Ollama box? Add `{ "id": "gpu-box", "type": "ollama", "baseUrl": "http://10.0.0.5:11434" }` to `localpilot.providers`.

Next: [Getting started]({{ '/docs/getting-started/' | relative_url }}) · [Models & providers]({{ '/docs/models/' | relative_url }}) · [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }})
