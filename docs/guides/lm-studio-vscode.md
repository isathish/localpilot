---
layout: docs
title: LM Studio in VS Code — agentic coding with your local models
description: Connect LM Studio's local server to VS Code with LocalPilot and get an agent that edits files, runs commands and reviews changes — using the GGUF or MLX models you already downloaded.
permalink: /guides/lm-studio-vscode/
keywords: LM Studio VS Code, LM Studio extension, LM Studio coding assistant, LM Studio OpenAI API VS Code, local LLM VS Code agent
---

[LM Studio](https://lmstudio.ai) gives you a polished way to download and run GGUF/MLX models with an OpenAI-compatible server. **LocalPilot** connects to that server and adds the agent layer: tools, file edits, terminal, diagnostics, parallel sessions and change review inside VS Code.

## Setup

1. In LM Studio open the **Developer** tab, load a model (e.g. `Qwen2.5-Coder-14B-Instruct`), and click **Start Server** (default `http://localhost:1234`).
2. Install LocalPilot ([download VSIX]({{ site.download }})). The `lmstudio` provider on port 1234 is pre-configured — your loaded models appear in the model picker immediately.
3. Pick the model and start an **Agent** chat.

> Enable *Keep model loaded* and raise the server's context length in LM Studio's model settings — LocalPilot reads the reported `max_context_length` to budget its context.

## What works

- **Tool calling** via `/v1/chat/completions` `tools` for models LM Studio marks as tool-capable; automatic text-protocol fallback otherwise.
- **Streaming**, **reasoning content** (shown as a collapsible "Thought" step), and `stream_options` usage reporting for the context meter.
- **Inline completions** through `/v1/completions` with a coder base model.
- **Vision** with multimodal models (Qwen2.5-VL, Gemma 3) for screenshots.
- **Multiple models**: load a small model for completions and a large one for the agent; LocalPilot lists them both.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No models found" | Start the server in the Developer tab; make sure at least one model is loaded |
| Edits never happen | The model lacks tool training — try Qwen2.5-Coder-Instruct or Devstral |
| Slow responses | Enable GPU offload fully; reduce `localpilot.maxOutputTokens` |

Next: [Models & providers]({{ '/docs/models/' | relative_url }}) · [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }})
