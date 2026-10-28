---
title: Getting started
description: Install LocalPilot, get a local model running, and accept your first agent edit. Includes hardware expectations.
permalink: /docs/getting-started/
---

These steps take you from nothing installed to your first accepted edit. You need VS Code 1.104 or later.

## What your machine can run

LocalPilot runs models on your own hardware, so your RAM and GPU decide which models are practical. It works out a model budget from your hardware:

| Hardware | Model budget |
|---|---|
| Apple Silicon (unified memory) | 50% of RAM up to 8 GB, 60% up to 16 GB, 70% above that |
| Dedicated GPU with 4 GB+ VRAM | About VRAM minus 1 GB, up to 1.5× VRAM when there is enough system RAM |
| CPU only | Half of RAM |

As a rough guide, a 7B coding model needs about 8 GB of RAM, and 14B to 32B models need 16 to 32 GB. **Settings → Models** shows your budget and marks each model as fits, tight or too big.

Small local models are weaker than frontier cloud models. They handle focused tasks well. Expect to break large tasks into smaller ones and to review edits carefully.

To run very large mixture-of-experts models on a normal machine, see colibri in [Models & providers]({{ '/docs/models/' | relative_url }}). Those models stream from disk and are slow.

## 1. Install the extension

Pick one:

- **Marketplace:** search for *LocalPilot Agent* in the Extensions view, or run:

  ```bash
  code --install-extension {{ site.extension_id }}
  ```

- **VSIX from GitHub:** download `localpilot.vsix` and `SHA256SUMS.txt` from the [latest release]({{ site.releases }}). Verify the file, then install it:

  ```bash
  sha256sum -c --ignore-missing SHA256SUMS.txt          # Linux, Git Bash
  shasum -a 256 -c --ignore-missing SHA256SUMS.txt      # macOS
  code --install-extension localpilot.vsix
  ```

  The check prints `localpilot.vsix: OK` when the file is intact. You can also use **Extensions view → ··· → Install from VSIX…**.

## 2. Open LocalPilot

Click the LocalPilot icon in the Activity Bar, or press <kbd>⌘⇧L</kbd> (<kbd>Ctrl+Shift+L</kbd> on Windows and Linux).

On first launch the **Welcome / Setup** screen opens. It looks for running model servers on their default ports.

![Setup step 1: LocalPilot found Ollama with 5 models and Docker Model Runner with 1; LM Studio is not running]({{ '/assets/screenshots/setup-detect.png' | relative_url }})

## 3. Get a model

If you have no model server, let LocalPilot set one up:

1. In the setup screen, click the button it offers: **Install Ollama & starter model**, **Start Ollama & download starter model** or **Download starter model**. It shows which models it will download and their size.
2. Wait for the download. LocalPilot installs the official Ollama build in the background without admin rights, starts it and shows progress. If that fails, it falls back to the official install script in a terminal.

The starter model depends on your model budget:

| Budget | Agent model | Download |
|---|---|---|
| 9 GB or more | Gemma 4 e4b (tools and vision) | 6.6 GB |
| 4 to 9 GB | Gemma 4 e2b (tools and vision) | 4.6 GB |
| Under 4 GB | Llama 3.2 3b or 1b, or a tiny SmolLM2 | 2.0 GB or less |

When it also fits, LocalPilot adds `starcoder2:3b` (1.7 GB) for inline completions. Details are in [Automatic setup]({{ '/docs/models/#automatic-setup' | relative_url }}).

If you already run a server, LocalPilot detects it on these default endpoints:

| Server | Default endpoint |
|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434` |
| [LM Studio](https://lmstudio.ai) | `http://localhost:1234/v1` (start the server in the *Developer* tab) |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | `http://localhost:8080/v1` |
| [vLLM](https://docs.vllm.ai) | `http://localhost:8000/v1` |

Auto-detection also probes Docker Model Runner, Jan, SGLang, KoboldCpp and Docker containers of known model servers. Any other OpenAI-compatible server can be added under `localpilot.providers`. See [Models & providers]({{ '/docs/models/' | relative_url }}).

## 4. Pick a model and approval level

1. Choose a default model. The wizard recommends one that supports tool calling, which Agent mode needs.
2. Choose how much the agent may do without asking: *Careful*, *Balanced* or *Autonomous*. You can change this later.
3. Click **Finish & open chat**.

![Setup step 2: choosing a default model; gemma4:12b is recommended because it calls tools and reads images]({{ '/assets/screenshots/setup-model.png' | relative_url }})

![Setup step 3: Careful, Balanced (the default) or Autonomous, and an optional switch for inline completions]({{ '/assets/screenshots/setup-approvals.png' | relative_url }})

You can rerun the wizard with *LocalPilot: Welcome / Setup*. To switch models later, use the picker under the composer or the model name in the status bar. If the picker says *No models found*, click **Set up automatically**, or start your server and press **Refresh**.

## 5. Run your first task

1. Open a project folder.
2. Make sure the mode picker under the composer shows **Agent**.
3. Type a small, concrete task, for example:

   > Add input validation to the login form and write tests for it.

4. Watch the agent read files, edit them and run checks. With the *Balanced* preset (the default), shell commands and deletes wait for your approval.

## 6. Review and accept the edit

The changes bar above the composer lists every file the agent changed. Click a file to see a diff.

- **In a git repository** the agent works in an isolated copy of your project (a git worktree) by default. The bar reads *N files changed in isolated copy*. Click **Apply to workspace** to bring the changes into your folder as uncommitted edits, or **Discard**.
- **Outside git**, or with `localpilot.worktrees.mode` set to `off`, the agent edits your files directly. Use **Accept all** / **Reject all**, or accept and reject per file.

Rejecting restores the exact content from before the agent's edit.

## Next steps

- [Agent modes]({{ '/docs/agent-modes/' | relative_url }}): Agent, Multitask, Debug, Plan and Ask.
- [Parallel agents]({{ '/docs/parallel-agents/' | relative_url }}): several agents, worktrees and Best of N.
- [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}): teach it your conventions.
- [Configuration]({{ '/docs/configuration/' | relative_url }}): every setting.
- [Privacy]({{ '/privacy/' | relative_url }}): what leaves your machine.
