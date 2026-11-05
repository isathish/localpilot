# Connect a model server

**Nothing set up yet?** Use the one-click button on the Welcome screen — it reads *Install Ollama & starter model*, *Start Ollama & download starter model* or *Download starter model* depending on what this machine already has (or run *LocalPilot: Set Up Models Automatically*). LocalPilot installs Ollama in the background (no admin rights), starts it and downloads a coder model sized for this machine — smaller models first, so you are productive in minutes. Bigger models are one click away in **Settings → Models**.

LocalPilot never talks to a cloud API unless you point it at one. It discovers models from the servers you run:

| Server | Default URL | Notes |
|---|---|---|
| **Ollama** | `http://localhost:11434` | Native API — tools, thinking, vision and FIM. `ollama pull qwen2.5-coder:7b` |
| **LM Studio** | `http://localhost:1234/v1` | Start the server from the *Developer* tab |
| **llama.cpp** | `http://localhost:8080/v1` | `llama-server -m model.gguf --port 8080` |
| **vLLM / Unsloth** | `http://localhost:8000/v1` | `vllm serve Qwen/Qwen2.5-Coder-7B-Instruct` |

The setup screen (**LocalPilot: Open Setup**) checks these ports, lists the models it finds and recommends one for agent work. **Settings → Models** shows what fits your RAM / GPU, lets you enable, disable, remove or install models, and chooses which model handles images, completions and Plan mode. Anything else that speaks the OpenAI `/v1` API (SGLang, LocalAI, Jan…) can be added under **Settings → Providers** with a *Test connection* button.

**Prefer a cloud model?** Under **Settings → Providers → Cloud APIs**, pick OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, DeepSeek or another provider and paste your API key. LocalPilot keeps it in your OS keychain, not in settings.json; *LocalPilot: Set Provider API Key…* does the same from the Command Palette. Cloud models are marked **cloud**, and automatic picks keep preferring local models. The **Gateways** tab adds OmniRoute or LiteLLM.
