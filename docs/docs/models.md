---
title: Models & providers
description: Connect Ollama, LM Studio, llama.cpp, vLLM, Unsloth exports or any OpenAI-compatible endpoint, and pick the right model for the job.
permalink: /docs/models/
---

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

## Adding a provider

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
