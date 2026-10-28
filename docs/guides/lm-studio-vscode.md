---
layout: docs
title: LM Studio in VS Code — agentic coding with your local models
description: Connect LM Studio's local server to VS Code with LocalPilot. Get an agent that edits files and runs commands using the models you already downloaded.
permalink: /guides/lm-studio-vscode/
keywords: LM Studio VS Code, LM Studio extension, LM Studio coding assistant, LM Studio OpenAI API VS Code, local LLM VS Code agent
---

To use LM Studio in VS Code, start LM Studio's local server and install the LocalPilot extension. LocalPilot ships with an `lmstudio` provider pointed at `http://localhost:1234/v1`, so the models you load in LM Studio appear in its model picker. Pick one and start an **Agent** chat. LM Studio runs the model; LocalPilot adds the agent: tool calls, file edits, terminal commands, diagnostics, parallel sessions and change review.

Local models are weaker than frontier cloud models on hard tasks, and speed depends on your hardware. A coder model of 14B or more gives noticeably better agent results than a 7B one, if your memory allows it.

## Set it up

1. In LM Studio, open the **Developer** tab and load a model, for example `Qwen2.5-Coder-14B-Instruct`.
2. Click **Start Server**. The default address is `http://localhost:1234`. With the `lms` CLI you can run `lms server start` instead.
3. Install LocalPilot from the [Marketplace]({{ site.marketplace }}) or as a [VSIX]({{ site.download }}).
4. Open the LocalPilot sidebar, pick the model in the dropdown, and start an **Agent** chat.

To check the server, run `curl http://localhost:1234/v1/models`. Your loaded models should be listed.

In LM Studio's model settings, turn on *Keep model loaded* and raise the context length. LocalPilot reads the context length the server reports and budgets the conversation to fit.

## Download models from VS Code

This needs the `lms` CLI (LM Studio → Developer → *Install lms*).

- **Settings → Models** downloads catalog models into LM Studio with `lms get` and marks which sizes fit your hardware.
- **Settings → Model gallery** searches GGUF repositories on Hugging Face. Pick a quantisation marked *fits*, *tight* or *too big*, and LocalPilot runs `lms get org/repo@quant` with live progress.

LocalPilot cannot delete LM Studio models. Remove them in the LM Studio app (My Models), or disable them in LocalPilot.

## What works

- **Tool calling** through the `tools` field of `/v1/chat/completions`, for models that support it. Other models fall back to a text-based tool protocol.
- **Streaming**, with reasoning output shown as a collapsible "Thought" step and token usage (`stream_options`) feeding the context meter.
- **Inline completions** through `/v1/completions`. They are off by default: turn on `localpilot.inlineCompletion.enabled` and load a coder model.
- **Images** with multimodal models such as Qwen2.5-VL or Gemma 3.
- **Several models at once:** load a small model for completions and a larger one for the agent. LocalPilot lists both and routes each job to the right one.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No models found" | Start the server in the Developer tab and load at least one model. |
| The agent describes edits but never makes them | The model is not tool-trained. Try Qwen2.5-Coder-Instruct or Devstral. |
| Slow responses | Offload all layers to the GPU in LM Studio, use a smaller quantisation, or lower `localpilot.maxOutputTokens` (default `4096`). |
| Answers cut off mid-conversation | Raise the context length in LM Studio and reload the model. |

Next: [Models & providers]({{ '/docs/models/' | relative_url }}) · [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }})
