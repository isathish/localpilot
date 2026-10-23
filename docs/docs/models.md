---
title: Models & providers
description: Connect Ollama, LM Studio, llama.cpp, vLLM, Docker Model Runner, Unsloth exports or any OpenAI-compatible endpoint — auto-detected, including model servers running in Docker containers.
permalink: /docs/models/
---

<p><img src="{{ '/assets/screenshots/model-picker.png' | relative_url }}" alt="Model picker grouped by provider with context size and capability badges" width="420"></p>

## Provider types

| `type` | Protocol | Use for |
|---|---|---|
| `ollama` | Ollama native API (`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`) | Ollama. Full support for tools, thinking, FIM `suffix`, vision, `num_ctx`. |
| `openai` | OpenAI-compatible (`/v1/chat/completions`, `/v1/completions`, `/v1/models`) | LM Studio, llama.cpp, vLLM, SGLang, LocalAI, Jan, OpenRouter, OpenAI, Azure OpenAI… |

Models are referenced as **`<providerId>/<modelId>`**, e.g. `ollama/qwen2.5-coder:14b` or `lmstudio/qwen2.5-coder-14b-instruct`.

## Default providers

```jsonc
"localpilot.providers": [
  { "id": "ollama",   "type": "ollama", "baseUrl": "http://localhost:11434" },
  { "id": "lmstudio", "type": "openai", "baseUrl": "http://localhost:1234/v1" },
  { "id": "llamacpp", "type": "openai", "baseUrl": "http://localhost:8080/v1" },
  { "id": "vllm",     "type": "openai", "baseUrl": "http://localhost:8000/v1" }
]
```

Unreachable servers are skipped silently; models from all reachable servers are merged into one picker.

## Auto-detection

You normally don't have to configure anything. At startup and on every *Refresh models*, LocalPilot probes:

1. the providers in your settings,
2. the well-known local ports — Ollama `11434`, LM Studio `1234`, llama.cpp `8080`, vLLM `8000`, **Docker Model Runner `12434`**, Jan `1337`, SGLang `30000`, KoboldCpp `5001`,
3. **running Docker containers** (`docker ps`) whose image is a known model server — `ollama/ollama`, `vllm/vllm-openai`, `ghcr.io/ggml-org/llama.cpp`, `localai/localai`, `huggingface/text-generation-inference`, `lmsysorg/sglang`, `docker/model-runner`, KoboldCpp — using the **published host port** of each container.

Every server that answers and is not yet in `localpilot.providers` is **added automatically** (never removed or edited), and a notification tells you what was found. With no `defaultModel` set, **Auto** picks the best tool-capable coder model across all servers; if your configured default is offline, LocalPilot falls back to the best available one and offers to make it the default.

## Docker-based models

**Docker Model Runner** (Docker Desktop 4.40+ or `docker model install-runner` on Docker Engine) serves models through an OpenAI-compatible API:

```bash
docker model pull ai/qwen2.5-coder            # or any ai/* model, or hf.co/<repo>
docker desktop enable model-runner --tcp=12434   # one-time: allow access from the host
```

LocalPilot then finds it at `http://localhost:12434/engines/v1` and lists its models under the `docker` provider (e.g. `docker/docker.io/ai/qwen2.5-coder:latest`, shown as *qwen2.5-coder:latest* in the picker). If the runner is active but host access is off, LocalPilot shows a one-click **Enable** prompt that runs the command above.

**Model servers in containers** work the same way as native ones — publish the port and LocalPilot picks them up:

```bash
docker run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama ollama/ollama
docker run -d --name vllm -p 8000:8000 --gpus all vllm/vllm-openai --model Qwen/Qwen2.5-Coder-7B-Instruct
docker run -d --name llamacpp -p 8080:8080 -v ./models:/models ghcr.io/ggml-org/llama.cpp:server -m /models/model.gguf --host 0.0.0.0
```

Containers appear as providers named `docker-<container>` (e.g. *vLLM (Docker · vllm)*), so a non-standard host port such as `-p 11435:11434` is handled automatically.

## Adding a provider

The quickest way is **Settings → Providers** (gear icon in the chat toolbar): pick a preset or *Custom endpoint*, fill in the URL and optional API key, and press **Test connection** to confirm the server answers and see which models it exposes.

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

## Unsloth models

Unsloth is a fine-tuning toolkit; serve the result with one of the supported runtimes:

- **GGUF export** → `ollama create mymodel -f Modelfile` or `llama-server -m model.gguf --port 8080`
- **Merged HF weights** → `vllm serve ./merged --port 8000`

Then it appears automatically under the matching provider.

## Capability detection

- **Tool calling** — read from Ollama's `/api/show` capabilities or the server's model metadata. Models without native tools fall back to a prompt-based protocol.
- **Vision** — enables image attachments.
- **FIM** — used for inline completions (`insert` capability or coder-model name heuristics).
- **Context window** — read from model metadata; capped by `localpilot.contextWindow`.

## Recommended models

| Task | Models |
|---|---|
| Agentic coding (tools) | `qwen2.5-coder:14b` / `:32b`, `qwen3`, `devstral`, `llama3.3`, `mistral-small`, `gpt-oss` |
| Inline completions (FIM) | `qwen2.5-coder:1.5b` / `:7b-base`, `codestral`, `starcoder2`, `deepseek-coder` |
| Screenshots / vision | `qwen2.5vl`, `llava`, `gemma3`, `pixtral` |
| Reasoning | `qwen3`, `deepseek-r1` (enable `localpilot.thinking`) |

Tip: keep `localpilot.contextWindow` at 32k+ for agent work; Ollama models default to 2–4k unless `num_ctx` is raised, which LocalPilot does for you.
