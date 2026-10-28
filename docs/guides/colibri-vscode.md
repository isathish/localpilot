---
layout: docs
title: Run huge MoE models in VS Code with colibri
description: Use colibri with LocalPilot to run very large mixture-of-experts models in VS Code on 8 to 32 GB of RAM. Which models fit, setup steps and real speed limits.
permalink: /guides/colibri-vscode/
keywords: colibri VS Code, run large MoE model locally, GLM-5.2 local, DeepSeek V4 Flash local, Qwen3-Coder-30B VS Code, stream experts from disk, huge LLM low RAM
---

To run a huge mixture-of-experts (MoE) model in VS Code, serve it with [colibri](https://github.com/JustVugg/colibri) and connect LocalPilot to it. colibri keeps the dense part of the model in RAM and streams the experts from disk, so a model with a 429 GB download can run on a machine with 16 GB of RAM. Start it with `coli serve` (or **LocalPilot: Start colibri**), and LocalPilot detects it and lists its model in the picker. The catch is speed: when experts stream from disk, the first token can take minutes and decoding runs at about one token per second or slower.

## What colibri is

colibri is a pure-C inference engine for large MoE models such as GLM-5.2, DeepSeek V4 Flash, Qwen3-Coder-30B and Kimi K3. An MoE model only uses a few of its experts for each token. colibri keeps the always-used part in memory and reads the experts it needs from disk. `coli serve` exposes an OpenAI-compatible API, on port 8000 by default.

LocalPilot needs version 1.2.4 or later for colibri support.

## Which models fit which RAM

These numbers come from colibri's own model table. "Minimum" is the least RAM colibri accepts for the model. "Comfortable" gives it a larger expert cache, which means fewer disk reads.

| colibri model | Minimum RAM | Comfortable RAM | Download |
|---|---|---|---|
| `qwen3-coder-30b` | 8 GB | 18 GB | 19 GB |
| `qwen36-35b` | 10 GB | 20 GB | 23 GB |
| `deepseek-v4-flash` | 16 GB | 32 GB | 167 GB |
| `glm-5.2` | 16 GB | 24 GB | 429 GB |

You need free disk space for the full download, and a fast SSD matters. Every expert that is not cached in RAM is read from disk while the model generates.

LocalPilot judges memory fit by the RAM-resident size, not the download. That is why it marks `glm-5.2` as runnable on a 16 GB machine even though the download is 429 GB.

## Set it up

1. **Install colibri and a model.** Clone [colibri](https://github.com/JustVugg/colibri) and run its setup script, `./start-here.sh`, in the checkout. The script picks a model for your machine and downloads it. LocalPilot never downloads colibri models itself.
2. **Start the server.** Either run `coli serve` yourself, or use LocalPilot:
   1. Open the Command Palette and run **LocalPilot: Start colibri (stream huge MoE models from disk)**.
   2. If `localpilot.colibri.path` is empty, choose your colibri checkout folder (the one containing `c/coli`) or **Use `coli` on PATH**. The folder is saved to `localpilot.colibri.path`.
   3. LocalPilot opens a terminal named *LocalPilot · colibri* and runs:

      ```bash
      c/coli serve --host 127.0.0.1 --port 8000 [--model <name>] [--kv-slots <n>]
      ```

   4. It waits up to 10 minutes for the server to answer while the resident part of the model loads. Watch the terminal for progress.
3. **Pick the model.** When the server answers, LocalPilot refreshes its model list and the colibri model appears in the picker.

To check the server yourself, run `curl http://127.0.0.1:8000/v1/models`. The response lists the model with `"owned_by": "colibri"`.

## How LocalPilot detects colibri

- A server whose `/v1/models` reports `owned_by: "colibri"` is treated as colibri. This includes port 8000, which LocalPilot's default `vllm` provider also uses. That entry is then labelled *colibri*.
- A custom port in `localpilot.colibri.port` is probed by auto-detect too.
- Docker containers whose image name contains `colibri` are detected through their published host port.
- LocalPilot reads the model's input modalities (for vision) and capabilities, and hides models that cannot chat. It reads the number of KV slots from `/health`, which tells it how many requests colibri decodes at once.

## What to expect for speed

There are two cases, depending on whether the download fits in your machine's *model budget* (shown in **Settings → Models**).

- **The model fits in RAM** (for example `qwen3-coder-30b`, a 19 GB download, on a 32 GB Apple Silicon Mac). It avoids most disk reads, so it is much faster than a streamed model. LocalPilot gives it twice the usual first-token and idle stall timeouts.
- **The model streams from disk** (for example `glm-5.2` on a 16–24 GB machine). Prefill of a long prompt can take minutes. Decoding runs at about one token per second or slower. LocalPilot gives it four times the usual stall timeouts, so a long silence is not treated as a hang.

An agent run that reads files and calls tools many times can take a very long time on a disk-streamed model. Use these models for single, careful answers.

## Which LocalPilot roles suit it

Automatic routing treats a disk-streamed colibri model like this:

| Role | Routing |
|---|---|
| Plan mode (`localpilot.routing.reasoning`) | Slightly favoured. One long, careful answer is a good use. |
| Chat, Agent mode and images | Ranked lower. Pick it by hand if you accept the wait. |
| Read-only subagents (explore, research) | Avoided. They make many short calls. |
| Inline completions | Never used. colibri's `/v1/completions` has no `suffix`, so there is no fill-in-the-middle. |

A colibri model that fits in RAM is routed like any other local model, apart from inline completions. A good split is a fast local model (for example from Ollama) for Agent mode and completions, and a colibri model in `localpilot.routing.reasoning` for Plan mode.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `localpilot.colibri.path` | `""` | colibri checkout folder containing `c/coli`. Empty means `coli` on your PATH. |
| `localpilot.colibri.model` | `""` | `--model` for **Start colibri**: a colibri model name such as `qwen3-coder-30b` or `glm-5.2`, or a model folder. Empty uses the model colibri's setup installed. |
| `localpilot.colibri.port` | `8000` | Port for `coli serve`. Auto-detect also probes it when it is not 8000. |
| `localpilot.colibri.kvSlots` | `2` | `--kv-slots`: conversations colibri decodes together, each with its own cached prefix. Maximum 16, and capped by `localpilot.parallel.maxConcurrency`. Each slot costs a few hundred MB. |

If a vLLM server already uses port 8000, set `localpilot.colibri.port` to another port before you start colibri.

Next: [Models & providers]({{ '/docs/models/' | relative_url }}) · [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }}) · [Offline AI coding assistant]({{ '/guides/offline-ai-coding-assistant/' | relative_url }})
