---
title: Models & providers
description: Set up local models sized to your hardware, install from the catalog or gallery, and let LocalPilot route each task to the right model.
permalink: /docs/models/
---

<p><img src="{{ '/assets/screenshots/model-picker.png' | relative_url }}" alt="Model picker grouped by provider (Ollama, LM Studio, Anthropic, OpenAI), each model with its context window, tool support, a vision badge, and a cloud badge on Claude Sonnet 4.6 and gpt-5" width="370"></p>

LocalPilot talks to model servers that run on your machine or your network, and to cloud model APIs you add. This page covers which servers it supports, how it finds them, how to install and remove models, and how it picks a model for each task.

## Provider types

| `type` | Protocol | Use for |
|---|---|---|
| `ollama` | Ollama native API (`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`) | Ollama, local or [Ollama Cloud](https://ollama.com) (`https://ollama.com`). Full support for tools, thinking, FIM `suffix`, vision and `num_ctx`. |
| `openai` | OpenAI-compatible (`/v1/chat/completions`, `/v1/completions`, `/v1/models`) | Local: LM Studio, llama.cpp, vLLM, SGLang, LocalAI, Jan, KoboldCpp, GPT4All, text-generation-webui, colibri. Gateways to cloud models: OmniRoute, LiteLLM. Cloud: OpenAI, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cerebras, Hugging Face, NVIDIA NIM, Moonshot, Alibaba Qwen, Azure OpenAI, Amazon Bedrock… |
| `anthropic` | Anthropic Messages API (`/v1/messages`, `/v1/models`) | Claude models: tools, images, streaming, thinking and prompt caching. |
| `vscode-lm` | VS Code's Language Model API (`vscode.lm`) | Models other extensions offer in VS Code, such as GitHub Copilot. VS Code only; see [VS Code language models](#vs-code-language-models-copilot). |

You refer to a model as **`<providerId>/<modelId>`**, for example `ollama/qwen2.5-coder:14b` or `lmstudio/qwen2.5-coder-14b-instruct`.

## Default providers

```jsonc
"localpilot.providers": [
  { "id": "ollama",   "type": "ollama", "baseUrl": "http://localhost:11434" },
  { "id": "lmstudio", "type": "openai", "baseUrl": "http://localhost:1234/v1" },
  { "id": "llamacpp", "type": "openai", "baseUrl": "http://localhost:8080/v1" },
  { "id": "vllm",     "type": "openai", "baseUrl": "http://localhost:8000/v1" }
]
```

LocalPilot skips servers that do not answer. Models from every reachable server appear together in one picker.

## Auto-detection

Usually you do not need to configure anything. At startup and on every **Refresh models**, LocalPilot probes:

1. The providers in your settings.
2. Well-known local ports:

   | Server | Port |
   |---|---|
   | Ollama | `11434` |
   | LM Studio | `1234` |
   | llama.cpp | `8080` |
   | vLLM, or colibri (`coli serve`) | `8000` |
   | Docker Model Runner | `12434` (`/engines/v1`) |
   | Jan | `1337` |
   | SGLang | `30000` |
   | KoboldCpp | `5001` |
   | colibri on a custom port | `localpilot.colibri.port`, when it is not `8000` |

3. Running Docker containers (`docker ps`) whose image is a known model server: Ollama, vLLM, llama.cpp, LocalAI, Text Generation Inference, SGLang, Docker Model Runner, KoboldCpp, LM Studio, Open WebUI and colibri. LocalPilot connects through each container's **published host port**.

A server on port `8000` that lists models with `owned_by: "colibri"` is labelled **colibri** instead of "vLLM". See [colibri](#colibri-huge-moe-models-from-disk).

Each server that answers and is not yet in `localpilot.providers` is added to it, and a notification tells you what was found. LocalPilot never removes or edits a provider you configured.

If `defaultModel` is empty, **Auto** picks the best tool-capable coder model that fits this machine, across all servers. If your configured default is offline, LocalPilot falls back to the best available model and offers to make it the default. If no server has any model, it offers [automatic setup](#automatic-setup).

## Automatic setup

A stopped Ollama needs nothing from you: when it has models downloaded, LocalPilot starts it when VS Code opens, and any request (chat, CLI, subagent) that needs a model on it starts it first. Setup then keeps the models it already has instead of downloading a starter model.

If no model is reachable anywhere (a fresh machine, deleted models, nothing installed), LocalPilot offers to fix it in one click. The setup wizard shows one button that fits your situation: *Install Ollama & starter model*, *Start Ollama & download starter model* or *Download starter model*. The button names the models and the download size, then runs without further prompts. The same flow is behind *Set up automatically* in the chat, **Settings → Models** and the *LocalPilot: Set Up Models Automatically* command.

1. **Find a runtime.** A running Ollama or Docker Model Runner is used as it is. An installed but stopped Ollama is started (the menu-bar or tray app, or `ollama serve`). If nothing is installed, LocalPilot installs Ollama in the background, without admin rights, and shows download progress:

   | OS | What LocalPilot does |
   |---|---|
   | macOS | Downloads `Ollama-darwin.zip`, unpacks it to `/Applications` (or `~/Applications`), clears the quarantine flag and launches the app. |
   | Windows | Runs `winget install Ollama.Ollama` when winget is available. Otherwise runs `OllamaSetup.exe` silently as a per-user install. Then launches the tray app. |
   | Linux | Unpacks the official `ollama-linux-<arch>.tar.zst` (decoded by Node's built-in zstd, `.tgz` fallback) into `~/.local/share/localpilot/ollama` and starts `ollama serve`. No `sudo` or systemd needed. |

   If that fails, LocalPilot falls back to the interactive installer in a terminal (Homebrew, winget or `install.sh`).

2. **Size the models to the machine.** LocalPilot reads RAM, CPU cores and GPU memory (Apple Silicon counts as unified memory) and turns them into a *model budget*. The starter set is the smallest useful model, so the agent is ready quickly and leaves room for a second model:

   | Budget | Agent model | Completions | Images |
   |---|---|---|---|
   | ≥ 9 GB (16 GB RAM or more) | `gemma4:e4b` (6.6 GB) | `starcoder2:3b` | the Gemma 4 model itself |
   | 4–9 GB (8 GB RAM) | `gemma4:e2b` (4.6 GB, a little tight on 8 GB) | none | the Gemma 4 model itself |
   | 2.5–4 GB | `llama3.2:3b` | none | none |
   | 1.5–2.5 GB | `llama3.2:1b` | none | none |
   | < 1.5 GB | `smollm2:360m` | none | none |

   Gemma 4 supports native tool calling, vision and optional thinking. One download covers agent work, screenshots and Plan mode. Qwen models are no longer in the starter set, but they remain in the catalog.

3. **Download with progress** in the status bar, a notification and the Models page. Then LocalPilot sets `defaultModel`, `inlineCompletion.model` and `routing.vision` if they were empty.

Models you already have are skipped, so you can re-run setup safely. To stop the startup offer, set `localpilot.models.autoSetup` to `false`.

## Managing models

The chat's model menu searches as you type, best match first with the matched letters highlighted. Hover a model and click its star to pin it under **Starred** at the top (kept across windows). Text that matches no model offers **Use '<text>' as a model id with <provider>** for OpenAI-compatible and Claude providers: **Enter** adds the id to that provider's **Models** list and switches the chat to it. Type `<provider>/<id>` to pick the provider.

Open **Settings → Models** (*LocalPilot: Manage Models*) to manage models.

![Settings → Models: machine profile with model budget, runtime status, install progress and the installed-model list with enable switches, roles and fit badges; the cloud model Claude Sonnet 4.6 shows a cloud badge instead of a size]({{ '/assets/screenshots/settings-models-manager.png' | relative_url }})

- **This machine:** detected RAM, GPU and cores, the resulting model budget and tier, and each runtime's state (Ollama, Docker Model Runner, LM Studio: running, installed or not found). Ollama has *Start* and *Install* buttons.
- **Installed models:** every model from every reachable provider, with size, context, capabilities and the role the router would give it. Each row has:
  - an **enable/disable** switch. Disabled models stay installed but disappear from pickers, routing and the status bar. They are stored in `localpilot.models.disabled`.
  - *Set default*.
  - **Remove**, for Ollama and Docker Model Runner models. Delete LM Studio models in the LM Studio app.
- **Routing:** see [Automatic routing](#automatic-routing).
- **Model catalog:** curated families (Gemma 4, Nemotron 3.5 Bolt, Qwen2.5 Coder, Qwen3, Devstral, gpt-oss, Llama 3.x, Gemma 3, Qwen2.5 VL, Mistral Small, DeepSeek-R1, Codestral, StarCoder2, Phi-4 mini, SmolLM2). Every size is marked **fits**, **tight** or **too big** for this machine, and a star icon marks the recommended size per family. Choose where to install: Ollama (`ollama pull`), Docker Model Runner (`docker model pull`) or LM Studio (`lms get`). The download shows inline and you can cancel it. Filter by role or search.

![Model catalog: every size of a family marked fits / tight / too big, the recommended size starred, installed sizes ticked, and an Install-to-runtime button or live download progress per row]({{ '/assets/screenshots/settings-models-catalog.png' | relative_url }})

**Remove** asks for confirmation in a VS Code dialog. It then deletes the model files through the runtime (`/api/delete` for Ollama, `docker model rm` for Docker Model Runner) and shows the result. The installed list, the chat's model picker and the status bar refresh on their own. If the removed model was the default or pinned to a role, routing falls back to the best available model until you pick another.

The same actions exist as commands: *Install Model from Catalog…*, *Remove Local Model…* and *Enable / Disable Model…*. Models you pull by hand (`ollama pull …`) show up on the next refresh.

## Model gallery

**Settings → Model gallery** (*LocalPilot: Browse Ollama Model Gallery…*) lets you browse the full public catalog of each registry your runtimes download from, not only the curated list. A tab appears for each registry that a detected runtime can install from:

| Tab | Shown when | Installs with |
|---|---|---|
| **Ollama library** ([ollama.com/library](https://ollama.com/library)) | always | `ollama pull <name>:<tag>` |
| **Docker Hub** (the [`ai/` namespace](https://hub.docker.com/u/ai)) | Docker Model Runner is installed or running | `docker model pull ai/<name>:<tag>` |
| **Hugging Face** (GGUF repositories) | LM Studio is installed or running, or Ollama is running | `lms get <org>/<repo>@<quant>` or `ollama pull hf.co/<org>/<repo>:<quant>`. Pick the runtime in **Install to**. |

- **Search** as you type. Filter by capability (**Tools**, **Vision**, **Thinking**, **Embedding** on Ollama; **Vision**, **Embedding** elsewhere). Sort by popularity, newest or name, and use **Load more** for further pages. Each model shows its description, capability badges, published sizes, download count and a link to its page. Cloud-only Ollama models carry a `cloud` badge and cannot be downloaded.
- **Choose size** fetches the model's tags. Each tag shows download size, context length, inputs, format (GGUF, safetensors or MLX) and age. It is marked **fits**, **tight** or **too big** against this machine's model budget, using the same rule as the catalog. **latest** marks what a bare pull gets (**default** = Q4_K_M on Hugging Face), and **installed** marks tags the target runtime already has. Plain sizes (`8b`, `e4b`, `30b-a3b`, `Q4_K_M`) come first. Other quantisations, MLX and bf16 variants sit behind *show all N tags*. Hugging Face sizes are the sum of a quantisation's files, including sharded repositories.
- **Install** pulls the tag through the chosen runtime with live progress and a cancel button. It uses the same job list as the Models page. When it finishes, the model appears under **Installed models**, in the chat's picker and in routing.
- **Pull by name** accepts anything the chosen runtime's CLI accepts: `qwen3:8b` or `hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M` for Ollama, `ai/qwen3:8b` for Docker Model Runner, `unsloth/Qwen3-8B-GGUF@q4_k_m` or a model key for LM Studio. LocalPilot checks the reference against the runtime's syntax before running anything.

The gallery needs internet access to the registry sites. Listings are cached for ten minutes, and Docker Hub rate-limits anonymous bursts. Installing needs a running runtime; if there is none, the page offers **Start Ollama** or **Install Ollama**.

![Settings → Model gallery: Ollama library, Docker Hub and Hugging Face tabs, the running runtime with this machine's model budget, search, capability filters, and models with download counts, badges and a Choose size menu]({{ '/assets/screenshots/settings-gallery.png' | relative_url }})

## Automatic routing

With `localpilot.routing.enabled` on (the default), LocalPilot picks a model per task instead of using one model for everything:

| Task | Model used |
|---|---|
| Agent or chat turn | The session's model, else `localpilot.defaultModel`, else the best tool-capable coder model **that fits in memory** |
| Turn with images | The session model if it can see. Otherwise `localpilot.routing.vision` or the best installed vision model, for that turn only; the session keeps its model |
| Inline completions | `localpilot.inlineCompletion.model`, else the **smallest** FIM-capable model (latency matters more than size) |
| Plan mode | `localpilot.routing.reasoning` when set (for example `ollama/qwen3:8b`), else the session model |
| Read-only subagents (`explore`, `clarifier`, `researcher`) | `localpilot.routing.fast` when set, else the **smallest** tool-capable instruct model that fits. These run many short tool calls, often in parallel. `session` pins the session model |
| Implementing subagents (`coder`, `tester`, `debugger`, `docs`) | `localpilot.routing.coding` when set (for example a 32b coder while you chat with a 7b), else the session model |
| Chosen model offline or disabled | The first available model of `localpilot.routing.fallbackModels` (**Settings → Models → Routing → Fallback order**), else the best available model. A note at the top of the turn explains the substitution. A local model never falls back to a cloud model unless that cloud model is in your fallback order |

The ranking weighs capabilities (tools, FIM, vision), model family, parameter count and whether the model fits the machine's budget. A 32b model that spills out of memory loses to a 14b that fits. colibri models that stream from disk are ranked down for chat, agent and image turns and kept away from read-only subagents and inline completions; they get a small boost for Plan mode.

When [learning from usage](#learning-from-your-usage) is on, each model also gets a learned bonus or penalty per role from how it has performed on this machine. The bonus is capped at ±12 points. Hard capabilities such as tools, vision and FIM are worth 20–60 points, so a learned preference never makes up for a missing capability.

The status bar shows the model that will actually answer.

![Settings → Models → Routing: Route automatically, Learn from usage, and the model for each job, with what Auto picks right now]({{ '/assets/screenshots/settings-routing.png' | relative_url }})

## colibri: huge MoE models from disk

[colibri](https://github.com/JustVugg/colibri) is a C engine that runs very large mixture-of-experts (MoE) models, such as GLM-5.2 (744B), DeepSeek V4 Flash (284B), Qwen3-Coder-30B and Kimi K3. It keeps the dense part of the model in RAM and streams the experts from disk. `coli serve` exposes an OpenAI-compatible API on port `8000`. For a step-by-step setup, see the [colibri guide]({{ '/guides/colibri-vscode/' | relative_url }}).

### Detection

- LocalPilot recognises a running `coli serve` by `owned_by: "colibri"` in its `/v1/models` list. This works on vLLM's port `8000`, where the stock "vLLM / Unsloth" entry is then labelled **colibri**.
- If you run it on another port, set `localpilot.colibri.port`. Auto-detect probes that port too.
- Docker containers whose image name contains `colibri` are detected through their published port.
- LocalPilot reads each model's `input_modalities` (image input enables vision) and `capabilities`. Models that cannot chat, such as decision-only or image-generation models, are hidden.
- It reads the KV-slot count from `/health`. That is how many requests colibri decodes at once, and LocalPilot uses it to plan parallel work.

<p><img src="{{ '/assets/screenshots/colibri-picker.png' | relative_url }}" alt="Model picker with a colibri group listing glm-5.2 below the Ollama models" width="370"></p>

![Settings → Models: glm-5.2 served by colibri, listed with 16 GB (its RAM-resident size, not the 429 GB download), 744B parameters and a fits badge]({{ '/assets/screenshots/colibri-models.png' | relative_url }})

<small>These two captures used a local stand-in that answers like `coli serve` (same `/v1/models` and `/health` responses), because a real GLM-5.2 needs a 429 GB download. What LocalPilot shows comes from those responses either way.</small>

### Memory fit

For colibri models, the fits / tight / too big check uses the RAM the model needs while running, not the download size. The numbers come from colibri's own model table. Two examples:

| Model | RAM needed (minimum) | Download |
|---|---|---|
| GLM-5.2 | about 16 GB | 429 GB |
| Qwen3-Coder-30B | about 8 GB | 19 GB |

### Speed: what to expect

A colibri model whose download is larger than your machine's model budget streams experts from disk. Expect minutes of prefill on a long prompt and about 1 token per second of output, or slower. That is workable for one careful answer. It is too slow for long agent loops or ghost text. LocalPilot adjusts for this:

- **Longer timeouts.** Disk-streamed models get 4× the first-token and idle stall limits. colibri models that fit in RAM get 2×.
- **Routing.** Disk-streamed models are kept away from read-only subagents and inline completions, ranked lower for chat and agent turns, and slightly favoured for Plan mode.
- **No inline completions.** colibri's `/v1/completions` has no `suffix` parameter, so LocalPilot never uses colibri for fill-in-the-middle.

For everyday agent work, prefer a colibri model that fits in RAM, such as `qwen3-coder-30b`, or a model on another runtime.

### Start colibri from VS Code

Run **LocalPilot: Start Colibri Server** (`localpilot.startColibri`):

1. If `localpilot.colibri.path` is empty, pick your colibri checkout folder, use `coli` on your PATH, or open colibri on GitHub.
2. LocalPilot opens a terminal named **LocalPilot · colibri** and runs:

   ```bash
   coli serve --host 127.0.0.1 --port <port> [--model <model>] [--kv-slots <n>]
   ```

   With a checkout folder, it runs `c/coli` from that folder (`c\coli.cmd` on Windows).
3. It waits up to 10 minutes for the server to answer while the model's resident part loads. Watch the terminal for progress.
4. It refreshes the model list and tells you which models colibri is serving.

### Disk space before a download

Before colibri's setup downloads a model (installing colibri, switching models, or starting with a model in `localpilot.colibri.model` that is not in the models folder yet), LocalPilot checks the free space on the disk that holds the models folder (`localpilot.colibri.modelsDir`, default `~/colibri-models`). A model needs its download size plus 2 GB to work in. When it does not fit, a dialog says by how much, for example *glm-5.2 needs about 431 GB (a 429 GB download plus 2 GB to work in), but the disk that holds ~/colibri-models has 120 GB free: 311 GB short*, and offers:

- **Choose another folder…**: pick a folder on a bigger disk; it becomes `localpilot.colibri.modelsDir` and the check runs again.
- **Use <model> (N GB)**: the best smaller model that fits this machine's memory and the free space.
- **Pick another model…**: the full model list, ranked for this machine.
- **Download anyway**: start the download as it is. colibri stops when the disk is full and resumes from there next time.

With colibri left to pick its own model, the check uses the smallest model it could pick for this machine. A model folder (instead of a catalog name) downloads nothing and is not checked. **Settings → Providers → colibri** shows the free space under **Models folder**, in amber when even the smallest model would not fit.

### colibri settings

| Setting | Default | Description |
|---|---|---|
| `localpilot.colibri.path` | `""` | colibri checkout folder (the one containing `c/coli`). Empty = `coli` on PATH |
| `localpilot.colibri.model` | `""` | `--model` value: a colibri model name (`qwen3-coder-30b`, `glm-5.2`) or a model folder. Empty = the model colibri's setup installed |
| `localpilot.colibri.port` | `8000` | Port `coli serve` listens on |
| `localpilot.colibri.kvSlots` | `2` | `--kv-slots`: conversations decoded together, each with its own cached prefix. Maximum 16, and capped by `localpilot.parallel.maxConcurrency`. Each slot costs a few hundred MB |

## Learning from your usage

LocalPilot can learn which of your installed models work best on this machine and route to them. This is controlled by `localpilot.models.autoTune`:

| Value | What happens |
|---|---|
| `auto` (default) | Auto routing uses the learned bonus. LocalPilot also updates role settings when another installed model is measurably better, and shows a notification with **Undo**. |
| `suggest` | Auto routing uses the learned bonus. Setting changes are only offered in a notification; nothing is written without your click. |
| `off` | No learning from usage. |

It needs `localpilot.telemetry.enabled` (on by default). The data never leaves your machine; it is the same local telemetry the [Dashboard]({{ '/docs/dashboard/' | relative_url }}) uses.

### What it measures

LocalPilot reads the last 14 days of local telemetry. Recent runs count more: a run from 7 days ago weighs half as much as one from today. It judges each installed model per role:

- Chat & agent
- Plan mode
- Coding subagents
- Read-only subagents
- Inline completions
- Images

The signals are:

- the share of runs that finished (stopped runs count partly against the model)
- generation speed compared with your other models
- time to first token
- the error rate of requests
- for inline completions, acceptance rate and latency

### Which settings it can change

In `auto` mode, LocalPilot may update `localpilot.defaultModel`, `localpilot.routing.reasoning`, `localpilot.routing.coding`, `localpilot.routing.fast`, `localpilot.inlineCompletion.model` and `localpilot.routing.vision`. When a role's setting is empty and Auto routing already prefers the better model, nothing is written.

### Guardrails

- A model you picked by hand is only replaced when it keeps failing for that role.
- A change needs several runs of evidence and a clear score gap. Low-confidence suggestions are never applied automatically.
- Each role changes at most once every 12 hours.
- If a workspace setting pins the model, LocalPilot leaves it alone.
- Every change, automatic or applied by you (notification, dashboard, command), shows a notification with **Undo**. Undo restores the previous value and stops that pick from being applied again. If the setting was changed again since, Undo leaves it alone and says so.
- Suggestions are shown one at a time; the ones you have not seen yet are offered on a later check.

### Review or undo changes

- **Dashboard → Model tuning** lists the per-role ranking with evidence, open suggestions with **Apply**, and recent automatic changes. **Analyse now** re-reads the telemetry. See [Dashboard]({{ '/docs/dashboard/#model-tuning' | relative_url }}).
- **LocalPilot: Tune Models From Usage** (`localpilot.tuneModels`) analyses now and lets you pick which suggestions to apply.
- The *LocalPilot* output channel logs every automatic change as `auto-tune: <setting> <old> → <new> (<reason>)`.
- To stop automatic changes, set `localpilot.models.autoTune` to `suggest` or `off`.


![Dashboard → Model tuning: a suggestion to use qwen2.5-coder:7b for read-only subagents, and for each role the installed models ranked by the share of runs that finished and their speed, with the learned bonus or penalty]({{ '/assets/screenshots/dashboard-tuning.png' | relative_url }})

## Docker-based models

**Docker Model Runner** (Docker Desktop 4.40+, or `docker model install-runner` on Docker Engine) serves models through an OpenAI-compatible API:

```bash
docker model pull ai/qwen2.5-coder            # or any ai/* model, or hf.co/<repo>
docker desktop enable model-runner --tcp=12434   # one-time: allow access from the host
```

LocalPilot then finds it at `http://localhost:12434/engines/v1` and lists its models under the `docker` provider. For example, `docker/docker.io/ai/qwen2.5-coder:latest` is shown as *qwen2.5-coder:latest* in the picker. If the runner is active but host access is off, LocalPilot offers an **Enable** button that runs the command above.

**Model servers in containers** work like native ones. Publish the port and LocalPilot picks them up:

```bash
docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
docker run -d --name vllm -p 8000:8000 --gpus all vllm/vllm-openai --model Qwen/Qwen2.5-Coder-7B-Instruct
docker run -d --name llamacpp -p 8080:8080 -v ./models:/models ghcr.io/ggml-org/llama.cpp:server -m /models/model.gguf --host 0.0.0.0
```

Containers appear as providers named `docker-<container>`, for example *vLLM (Docker · vllm)*. A non-standard host port such as `-p 11435:11434` works because LocalPilot reads the published port.

## Adding a provider

The quickest way is **Settings → Providers** (gear icon in the chat toolbar):

1. Under **Add a provider**, choose **On this machine**, **Cloud APIs** or **Gateways** and click a preset. **Find a provider…** searches all three, best match first (`hf` finds Hugging Face, `vercel` the Vercel AI Gateway). Use the arrow keys to move through the presets, **Enter** to add one and **Esc** to clear the search. For anything else, use **Custom endpoint**. The cloud presets include SambaNova, MiniMax, Z.AI, Baseten, Nebius AI Studio, Requesty and Vercel AI Gateway, each reading its key from the provider's usual environment variable.
2. Enter the URL and, if needed, an API key. Cloud presets fill in the URL and read the key from the provider's usual environment variable (`${env:OPENAI_API_KEY}`, `${env:ANTHROPIC_API_KEY}`, `${env:GEMINI_API_KEY}`…). If you paste the key itself instead, LocalPilot stores it in VS Code secret storage (your OS keychain) and writes only `${secret:<id>}` to settings.json. **LocalPilot: Set Provider API Key…** does the same from the Command Palette.
3. Press **Test connection** to confirm the server answers and see which models it exposes.

Configured providers are listed under **Local** and **Cloud**.

![A cloud provider's card: OpenAI with the warning OPENAI_API_KEY not set, the API key field first with a Get an API key link, then ID, API type, base URL and context window]({{ '/assets/screenshots/settings-provider-cloud.png' | relative_url }}) A card's header shows what needs attention: a server that is unreachable, or a key that is missing (**OPENAI_API_KEY not set**, **key missing**). When everything works it shows the model count and latency instead. For a cloud provider the **API key** field comes first, with a link to the provider's key page.

![Add a provider: the Cloud APIs tab with presets for Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI and more, a search box, and a Custom endpoint button]({{ '/assets/screenshots/settings-add-provider.png' | relative_url }})

![Provider editor with a successful connection test]({{ '/assets/screenshots/settings-provider-test.png' | relative_url }})

The same configuration lives in `localpilot.providers` if you prefer `settings.json`:

```jsonc
{
  "id": "homelab",
  "type": "openai",
  "displayName": "Homelab vLLM",
  "baseUrl": "http://10.0.0.5:8000/v1",
  "apiKey": "optional-token",
  "contextWindow": 131072,          // fallback if the server doesn't report it
  "models": ["Qwen/Qwen2.5-Coder-32B-Instruct"]  // for servers with no /models endpoint
}
```

Cloud providers look like this:

```jsonc
{ "id": "openai", "type": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "${env:OPENAI_API_KEY}" },
{ "id": "anthropic", "type": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "${env:ANTHROPIC_API_KEY}" },
{ "id": "gemini", "type": "openai", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKey": "${env:GEMINI_API_KEY}" }
```

Ways to give a key:

| `apiKey` | Where the key lives |
|---|---|
| `${secret:<id>}` | VS Code secret storage (OS keychain). Written for you when you paste a key in Settings or run **Set Provider API Key…**. The `localpilot` CLI has no keychain access and reads `LOCALPILOT_KEY_<ID>` instead, for example `LOCALPILOT_KEY_OPENAI`. |
| `${env:NAME}` | An environment variable in VS Code's environment. Launch VS Code from a shell that exports it, or set it in your shell profile. |
| the key itself | settings.json, in plain text. Avoid this if you sync settings. |

Azure OpenAI uses the v1 endpoint, `https://<resource>.openai.azure.com/openai/v1`, and the key is sent as `api-key`. For a deployment-style URL (`…/openai/deployments/<name>`), set **Azure api-version** (`apiVersion`) and it is added to every request.

### Provider options

A provider card's **Default model** lists the models the server reported (with a loading state, and the error when listing failed); type any id that is not listed. The provider id alone then means that model: `-m openrouter` or `-P openrouter` in the CLI, or `"localpilot.defaultModel": "openrouter"`. **Headers, timeout and model settings** opens the rest:

| Field | Setting | What it does |
|---|---|---|
| Custom headers | `headers` | Sent with every request, after the API key, so a header can replace it. Values take `${env:NAME}` and `${secret:NAME}`; a header whose reference is not set is left out. OpenRouter also gets `HTTP-Referer` and `X-Title` unless you set them. |
| First-token timeout | `timeoutMs` | The least time to wait for a reply to start before it counts as stalled, for gateways that load models on demand. |
| Route requests by | `extraBody` | OpenRouter only: `provider.sort` by `price`, `throughput` or `latency`. `extraBody` merges any other fields into each chat request. |
| Model list URL | `modelsUrl` | Where to read the model list when it is not `<baseUrl>/models`. |
| Model settings | `modelOverrides` | Per model id: `contextWindow`, `maxOutput`, `vision`, `reasoning`, `inputPrice` and `outputPrice` (US dollars per 1M tokens) and `temperature`. They win over what the server and the bundled model facts say. |

```jsonc
{
  "id": "openrouter", "type": "openai", "baseUrl": "https://openrouter.ai/api/v1", "apiKey": "${env:OPENROUTER_API_KEY}",
  "defaultModel": "qwen/qwen3-coder",
  "timeoutMs": 90000,
  "extraBody": { "provider": { "sort": "throughput" } },
  "modelOverrides": { "qwen/qwen3-coder": { "contextWindow": 262144, "inputPrice": 0.22, "outputPrice": 0.95 } }
}
```

**Settings → Models** shows each model's input and output price per 1M tokens (and the cache price when known), or *local · free* for models on this machine.

Amazon Bedrock uses its OpenAI-compatible endpoint, `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`, with a [Bedrock API key](https://console.aws.amazon.com/bedrock/home#/api-keys) sent as a Bearer token (read from `AWS_BEARER_TOKEN_BEDROCK` until you paste one). Pick the region in the provider card's **AWS region** field, or with `localpilot providers add bedrock --region eu-central-1`. The endpoint has no model listing, so the preset lists the models it serves (`openai.gpt-oss-120b-1:0`, `openai.gpt-oss-20b-1:0`); add others under **Models**. IAM credentials, AWS profiles and SigV4 signing are not supported directly: run a [LiteLLM proxy](https://docs.litellm.ai/docs/providers/bedrock) and add it as a gateway.

### Claude

The `anthropic` type talks to the Messages API directly:

- **Thinking** follows `localpilot.thinking`. Current models (Claude 4.6 and later) use adaptive thinking with the matching effort level. Older thinking models use a token budget. Models that always think (Opus 5.5, Fable) get a low effort when thinking is off.
- **Reasoning is kept within a tool loop.** Thinking blocks are sent back with their signatures in the tool loop that produced them. If LocalPilot has since pruned or compacted the conversation, the API rejects the old blocks. LocalPilot then resends the request once without them and stops replaying them.
- **Prompt caching** is on, so the system prompt, tools and earlier turns are billed at cache rates on the next request.
- No `temperature` is sent, because current Claude models reject sampling parameters.

### VS Code language models (Copilot)

The `vscode-lm` type uses the chat models that other extensions provide to VS Code, such as GitHub Copilot. It needs no URL or key:

```jsonc
{ "id": "copilot", "type": "vscode-lm" }
```

- Models appear as `copilot/<model id>` (for example `copilot/gpt-4o`), named with their vendor. Add `"models": ["gpt-4o", "claude-sonnet-4"]` to list only some of them (by id or family).
- VS Code asks you once to allow LocalPilot to use the models. If you decline, the request fails with a message saying so.
- Tool calls work. Images are not sent, because the stable API has no image input.
- No price or cost is shown: the extension that provides the model handles billing and quotas.
- The models are treated as cloud models, so automatic picks prefer local models.
- The list updates when you sign in or out of the providing extension. LocalPilot's own models, which it offers to other extensions, are never listed here.
- The CLI has no `vscode.lm`, so it leaves this provider out, including from `localpilot doctor`.
- In **Settings → Providers** the card shows only the fields that apply: name, ID, type, Models and Default model. Switching the type to another API clears the placeholder URL so you can enter a real one.

### Gateways (OmniRoute, LiteLLM)

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) and LiteLLM run on your machine but forward prompts to cloud models. Their presets set `"cloud": true`, so automatic picks treat their models as cloud models:

```jsonc
{ "id": "omniroute", "type": "openai", "baseUrl": "http://localhost:20128/v1", "cloud": true }
```

Pick a model as `omniroute/<model>`, for example `omniroute/auto/coding` or `omniroute/cc/claude-sonnet-4-6`. OmniRoute needs a key only when its `REQUIRE_API_KEY` is on. For any other local proxy to cloud models, turn on **Sends prompts to cloud models** in its provider card. Auto-detect finds OmniRoute on `:20128` and LiteLLM on `:4000`.

When a cloud model rejects a parameter (OpenAI reasoning models do not take `temperature` or `max_tokens`, and some APIs do not take `reasoning_effort`), LocalPilot drops or renames it, asks again and remembers this for that model. Speech, image, embedding and moderation models in cloud listings are hidden.

A provider on another machine or a cloud endpoint receives your prompts and code. Cloud providers are marked **cloud** in Settings. Automatic model picks (Auto, subagents, completions, images) prefer local models and use a cloud model only when nothing local is available. A cloud model you pick yourself, or set as `localpilot.defaultModel`, is always used. Keep providers on `localhost` if your code must stay on this machine.

## Unsloth models

Unsloth is a fine-tuning toolkit. Serve its output with one of the supported runtimes:

- **GGUF export:** `ollama create mymodel -f Modelfile` or `llama-server -m model.gguf --port 8080`
- **Merged HF weights:** `vllm serve ./merged --port 8000`

The model then appears under the matching provider.

## Capability detection

- **Tool calling:** read from Ollama's `/api/show` capabilities or the server's model metadata. Models without native tools fall back to a prompt-based protocol.
- **Vision:** enables image attachments.
- **Edit tool:** GPT, Codex and gpt-oss models (any id matching `gpt` or `codex`) are trained on the `*** Begin Patch` format, so they get `apply_patch` instead of `edit_file` and `write_file`; other models get `edit_file` and `write_file`. Override with `localpilot.editTool` (`auto`, `edit_file`, `apply_patch`).
- **FIM:** used for inline completions (`insert` capability, or coder-model name heuristics).
- **Context window:** read from model metadata and capped by `localpilot.contextWindow`. LM Studio's `/v1/models` has no context lengths, so for LM Studio (and any local server whose listing has none) LocalPilot asks its native `/api/v0/models`: the length a model is loaded with, else the most it supports. The provider's `contextWindow` is the fallback after that.
- **Cloud model limits and prices:** when a cloud API's listing does not say, the context window, output limit, vision and reasoning support come from a table of model facts bundled with LocalPilot (taken from [models.dev](https://models.dev), never fetched at runtime). The same table gives prices per million tokens for the cloud presets (OpenAI, Anthropic, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Cerebras, Moonshot, Alibaba Qwen), so each request's cost is added to the chat's usage: input not served from the cache, output, cache reads (the cache price, else the input price) and cache writes (the cache price, else 1.25 × input). A cost the provider reports itself (OpenRouter) is used instead. Local models are free, and gateways (LiteLLM, OmniRoute, custom endpoints) have no known prices. A local model's output limit is its context window; the request still sends `localpilot.maxOutputTokens`.

## Recommended models

Small local models are weaker than frontier cloud models. Larger models that still fit your machine give better agent results.

| Task | Models |
|---|---|
| Agentic coding (tools) | `gemma4:e2b` / `:e4b` / `:12b` (recommended), `nemotron-3.5-bolt:e4b`, `devstral`, `gpt-oss`, `mistral-small`, `qwen3` |
| Inline completions (FIM) | `starcoder2:3b`, `codestral`, `qwen2.5-coder:1.5b` / `:7b-base`, `deepseek-coder` |
| Screenshots / vision | `gemma4` (any size), `nemotron-3.5-bolt`, `qwen2.5vl`, `llava`, `gemma3`, `pixtral` |
| Reasoning | `gemma4`, `gpt-oss`, `qwen3`, `deepseek-r1` (set `localpilot.thinking`) |

Keep `localpilot.contextWindow` at 32k or more for agent work. Ollama models default to 2–4k unless `num_ctx` is raised; LocalPilot sends `num_ctx` for you.
