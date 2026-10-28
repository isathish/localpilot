---
layout: docs
title: Use Ollama in VS Code as a full coding agent
description: Connect Ollama to VS Code with LocalPilot for an agent that edits files, runs commands and reads screenshots. Setup steps, model picks and tips.
permalink: /guides/ollama-vscode/
keywords: Ollama VS Code, Ollama VS Code extension, Ollama coding assistant, Ollama agent VS Code, qwen2.5-coder VS Code, local copilot ollama
---

To use Ollama in VS Code as a coding agent, install the LocalPilot extension and keep Ollama running on `localhost:11434`. LocalPilot finds it automatically and lists your Ollama models in its model picker. Pick a model with tool support, such as `qwen2.5-coder:7b`, and start an **Agent** chat. The agent reads your project, edits files, runs commands and checks the results, all against the model on your machine.

Set your expectations first. A 7B or 14B local model is weaker than frontier cloud models on hard, multi-file tasks. It works well for focused edits, tests and explanations. Bigger models help, but they need more memory.

## Set it up

### Option 1: automatic setup

1. Install LocalPilot from the [Marketplace]({{ site.marketplace }}) or as a [VSIX]({{ site.download }}).
2. Open the LocalPilot sidebar and click **Set up automatically**.

LocalPilot installs Ollama if it is missing (Homebrew, winget or the official script), starts it, and downloads a starter set sized to your machine's *model budget*:

| Model budget | Agent model | Completions |
|---|---|---|
| 9 GB or more | `gemma4:e4b` | `starcoder2:3b`, if it fits alongside |
| 4–9 GB | `gemma4:e2b` | none |
| 2.5–4 GB | `llama3.2:3b` | none |
| below 2.5 GB | `llama3.2:1b` or `smollm2:360m` | none |

The model budget is the share of RAM or GPU memory LocalPilot plans to give a model. **Settings → Models** shows it for your machine. Gemma 4 reads images itself, so the starter set needs no separate vision model. The starter set is deliberately small. Upgrade from the catalog once you know what your machine handles.

### Option 2: manual setup

1. Pull a model and make sure Ollama is running:

   ```bash
   ollama pull qwen2.5-coder:7b
   ollama serve        # skip if Ollama already runs as a service
   ```

2. Install LocalPilot: [download the VSIX]({{ site.download }}), then run `code --install-extension localpilot.vsix`.
3. Open the LocalPilot sidebar and pick `ollama/qwen2.5-coder:7b` in the model dropdown.

To check that Ollama is reachable, run `curl http://localhost:11434/api/version`. It should return a version number.

## What LocalPilot adds on top of Ollama

| Capability | How it works with Ollama |
|---|---|
| Tool calling | Native `/api/chat` tools for models that report tool support. Other models get a text-based tool protocol. |
| Context size | Sends `num_ctx` with every request (`localpilot.contextWindow`, default `32768`), then prunes and compacts history as the chat grows. |
| Thinking models | `localpilot.thinking` (default `off`) turns on Ollama's `think` option. The reasoning shows as a collapsed step. |
| Images | Screenshots and pasted images go to a vision model such as `gemma4`, `qwen2.5vl` or `gemma3`. |
| Inline completions | Off by default. Turn on `localpilot.inlineCompletion.enabled`. LocalPilot then uses Ollama's FIM `suffix` support with the smallest FIM-capable model that fits, unless you set `localpilot.inlineCompletion.model`. |
| Model management | **Settings → Models** pulls and removes models with progress, marks each size *fits*, *tight* or *too big*, and lets you switch models on or off. |
| Model gallery | **Settings → Model gallery** searches the [ollama.com library](https://ollama.com/library) and Hugging Face GGUF repositories, with the same fit badges. It installs with `ollama pull`, including `hf.co/…` names. |
| Parallel agents | Several sessions or subagents at once. See the tip on parallel slots below. |

## Which Ollama models to use

Sizes below are the download sizes in LocalPilot's catalog. Leave headroom for the context cache and your other apps.

- **Agent work:** `qwen2.5-coder:7b` (4.7 GB), `qwen2.5-coder:14b` (9.0 GB), `qwen2.5-coder:32b` (20 GB), `devstral` (14 GB), `qwen3:14b` (9.3 GB), `gpt-oss:20b` (14 GB).
- **Inline completions:** `qwen2.5-coder:1.5b` (1.0 GB), `starcoder2:3b` (1.7 GB).
- **Screenshots:** `gemma4:e4b` (6.6 GB), `gemma3:4b` (3.3 GB), `qwen2.5vl:7b` (6.0 GB).

Small models (under about 7B) often stop early or call tools wrongly on long agent tasks. If edits never happen, try a larger coder model before changing anything else.

## Tips

- **Larger context:** with a 32B model and enough memory, raise `localpilot.contextWindow` to `65536`. Ollama's own default context is much smaller, which is why LocalPilot always sends `num_ctx`.
- **Keep the model loaded:** `localpilot.keepAlive` (default `30m`) tells Ollama how long to keep the model in memory between turns. Use `-1` to keep it loaded.
- **Parallel slots:** Ollama answers one request per model at a time by default. Run **LocalPilot: Restart Ollama with Parallel Request Slots** from the Command Palette, or set `OLLAMA_NUM_PARALLEL` yourself, so subagents really run at the same time. Each slot uses extra memory.
- **Ollama on another machine:** add it to `localpilot.providers`:

  ```json
  { "id": "gpu-box", "type": "ollama", "baseUrl": "http://10.0.0.5:11434" }
  ```

  Your prompts and code then travel to that machine. Use a trusted network.

Next: [Getting started]({{ '/docs/getting-started/' | relative_url }}) · [Models & providers]({{ '/docs/models/' | relative_url }}) · [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }})
