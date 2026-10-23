---
title: Getting started
description: Install LocalPilot, connect a local model server and run your first agent task in under five minutes.
permalink: /docs/getting-started/
---

## 1. Serve a model

LocalPilot talks to any of these out of the box (default ports are probed automatically):

| Server | Default endpoint | Notes |
|---|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434` | Native API: tool calling, thinking, FIM, vision |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` | Start the server from the *Developer* tab |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | `http://localhost:8080/v1` | Great for Unsloth GGUF exports |
| [vLLM](https://docs.vllm.ai) / SGLang | `http://localhost:8000/v1` | GPU servers, OpenAI-compatible |

```bash
# Ollama example
ollama pull qwen2.5-coder:14b
ollama serve
```

> Any other OpenAI-compatible server (LocalAI, Jan, text-generation-webui, OpenRouter, …) works too — add it under `localpilot.providers`. See [Models & providers]({{ '/docs/models/' | relative_url }}).

## 2. Install the extension

**From the Marketplace** (search for *LocalPilot Agent* in the Extensions view), or from the command line:

```bash
code --install-extension {{ site.extension_id }}
```

**From a GitHub release:** download the latest VSIX from the [releases page]({{ site.releases }}) (or the [direct link]({{ site.download }})) and run `code --install-extension localpilot.vsix`, or use **Extensions view → ··· → Install from VSIX…**

## 3. Open LocalPilot

Click the LocalPilot icon in the Activity Bar or press <kbd>⌘⇧L</kbd> (<kbd>Ctrl⇧L</kbd> on Windows/Linux).

On first launch the **Welcome / Setup** screen opens: it detects the servers from step 1, lists their models with a recommended default, and lets you choose how much freedom the agent gets (*Careful*, *Balanced* or *Autonomous*). Click **Finish & open chat** and you're done. You can rerun it any time with *LocalPilot: Welcome / Setup*.

Afterwards, pick a model from the picker at the bottom of the composer — or click the model name in the status bar. If you see *No models found*, make sure a server is running and press **Refresh**, or open **Set up providers** to add a custom endpoint and test the connection.

## 4. Your first task

Switch to **Agent** mode and try:

> Add input validation to the login form and write tests for it.

LocalPilot will read the relevant files, make edits, run diagnostics and report back. Review the **files changed** bar above the composer and choose **Keep all** or **Undo all**.

## Next steps

- Learn the three modes: [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }})
- Run several agents at once: [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }})
- Teach it your conventions: [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }})
- Tune behaviour: [Configuration]({{ '/docs/configuration/' | relative_url }})
