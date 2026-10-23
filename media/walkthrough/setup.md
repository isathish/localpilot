# Connect a model server

LocalPilot never talks to a cloud API unless you point it at one. It discovers models from the servers you run:

| Server | Default URL | Notes |
|---|---|---|
| **Ollama** | `http://localhost:11434` | Native API — tools, thinking, vision and FIM. `ollama pull qwen2.5-coder:7b` |
| **LM Studio** | `http://localhost:1234/v1` | Start the server from the *Developer* tab |
| **llama.cpp** | `http://localhost:8080/v1` | `llama-server -m model.gguf --port 8080` |
| **vLLM / Unsloth** | `http://localhost:8000/v1` | `vllm serve Qwen/Qwen2.5-Coder-7B-Instruct` |

The **Welcome / Setup** screen checks these ports, lists the models it finds and recommends one for agent work. Anything else that speaks the OpenAI `/v1` API (SGLang, LocalAI, Jan, OpenRouter, Azure OpenAI…) can be added under **Settings → Providers** with a *Test connection* button.
