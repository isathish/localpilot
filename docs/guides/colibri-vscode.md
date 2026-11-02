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

Run **LocalPilot: Start colibri** from the Command Palette, or **Start colibri** in **Settings → Providers → Huge MoE models**. It handles every starting point:

| Your machine | What Start colibri does |
|---|---|
| colibri is not installed | Checks that git and Python are installed and shows the install command if not. Asks where to put the checkout (default `~/colibri`) and which model to use. Then it clones colibri and runs its setup in a terminal: detect the hardware, build the engine (or download a prebuilt one when there is no compiler), download the model and start the server. |
| colibri is installed but nothing is set up | Runs colibri's setup without questions, and colibri downloads the model it recommends for this machine. |
| colibri is set up | Runs the same setup command. It sees the completed setup and only starts the server: no download, no build. |
| colibri is already running | Uses it. It does not start a second server. It offers **Switch model…**, **Stop colibri** and **Open dashboard**. |
| Another server holds the port (vLLM also uses 8000) | Offers the next free port and saves it to `localpilot.colibri.port`. |
| `localpilot.colibri.path` is not a colibri folder | Offers to choose another folder, install colibri there, or forget the folder. |

colibri is found in this order: `localpilot.colibri.path` (a git checkout with `c/coli` or an unpacked release with `coli`), then `coli` on your PATH, then a checkout in `~/colibri`.

**Choosing a model.** The picker ranks colibri's catalog against this machine:

- **Runs from RAM** (fast) comes first, then **streams from disk** (slow, best for Plan mode). Models that need more RAM than you have are left out.
- Each entry shows its download size. A model that does not fit on the free disk in the models folder is flagged, and you are asked before it downloads.
- **Let colibri recommend** leaves the choice to colibri.
- **A model folder I already have…** uses a model on disk (`--model-dir`).
- Models colibri cannot install without a manual conversion (OLMoE, Qwen3.8-27B, GLM-5.3-Flash, DeepSeek V4.1 Flash) are not offered.

**What runs.** A terminal named *LocalPilot · colibri* runs colibri's own setup, never interactive and never opening a browser:

```bash
~/colibri/c/coli setup --yes --no-browser --host 127.0.0.1 --port 8000 [--model <id> | --model-dir <folder>] [--dir <models folder>] [--backend <cuda|vulkan|cpu>] [--reconfigure]
```

On a first install the line starts with `git clone --depth 1 https://github.com/JustVugg/colibri ~/colibri &&`. On Windows it runs in PowerShell with `py -3 c\coli`, or `coli.cmd` from a release archive. Parallel agents each get a KV slot through `COLI_KV_SLOTS`, which `coli serve` reads.

**Waiting.** A notification shows how long it has been running and, when colibri reports it (`coli status --json`), the install phase and percentage. A first install can take hours for the larger models, so LocalPilot waits up to 12 hours; a start waits up to 20 minutes. **Cancel** only stops the waiting: colibri keeps going in its terminal, and LocalPilot picks it up when it answers. If the terminal is closed first, run Start colibri again: an interrupted download resumes where it stopped.

When the server answers, LocalPilot adds colibri as a provider, refreshes the model list, and the model appears in the picker.

**Switching or stopping.** **Start colibri** while it runs → **Switch model…** stops it and runs setup with `--reconfigure` and the new model. **LocalPilot: Stop colibri** (also in Settings) runs `coli stop` and closes the terminal.

To check the server yourself, run `curl http://127.0.0.1:8000/v1/models`. The response lists the model with `"owned_by": "colibri"`. `coli status`, `coli doctor` and `coli logs -n 50` in the checkout show colibri's own view.

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
| `localpilot.colibri.path` | `""` | colibri folder: a checkout with `c/coli` or a release with `coli`. Empty means `coli` on your PATH, then `~/colibri`. Set by Start colibri when it installs colibri or you choose a folder. |
| `localpilot.colibri.model` | `""` | A colibri catalog id (`qwen3-coder-30b`, `qwen36-35b`, `glm-5.2`, `deepseek-v4-flash`…) or a folder with a model on disk. Empty lets colibri recommend one. **Switch model…** sets it. |
| `localpilot.colibri.modelsDir` | `""` | Where models are downloaded (`--dir`). Empty means `~/colibri-models`. Pick a disk with room: models are 19 GB to 1.6 TB. |
| `localpilot.colibri.backend` | `auto` | Engine built or downloaded at setup: `auto` (CUDA, then Vulkan, then CPU; Metal on Apple Silicon), `cuda`, `vulkan` or `cpu`. |
| `localpilot.colibri.port` | `8000` | Where the server listens. Auto-detect also probes it when it is not 8000. Start colibri offers another port when something else holds this one. |
| `localpilot.colibri.kvSlots` | `2` | Conversations colibri decodes together, each with its own cached prefix (`COLI_KV_SLOTS`). Maximum 16, and capped by `localpilot.parallel.maxConcurrency`. Each slot costs a few hundred MB. |

Next: [Models & providers]({{ '/docs/models/' | relative_url }}) · [Agent, Ask & Plan]({{ '/docs/agent-modes/' | relative_url }}) · [Offline AI coding assistant]({{ '/guides/offline-ai-coding-assistant/' | relative_url }})
