---
layout: docs
title: Claude, OpenAI, Gemini and OpenRouter in VS Code — bring your own key
description: Use cloud models from OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI and more in VS Code with LocalPilot. Your own API key, kept in your OS keychain, with local models still preferred for automatic picks.
permalink: /guides/cloud-models-vscode/
keywords: bring your own key VS Code, BYOK coding agent, Claude in VS Code, Anthropic API VS Code, OpenAI API VS Code agent, Gemini VS Code, OpenRouter VS Code, Groq VS Code, Mistral VS Code, DeepSeek VS Code, Azure OpenAI VS Code, Ollama Cloud VS Code
---

LocalPilot runs on local models by default. It can also use a cloud model with your own API key: OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cerebras, Hugging Face, NVIDIA NIM, Moonshot (Kimi), Alibaba Qwen, Azure OpenAI or Ollama Cloud. You get the same agent with every one: tool calls, file edits, terminal commands, parallel agents, change review, skills and MCP. You pay the provider for what you use; LocalPilot itself stays free.

A common setup is a local model for everyday work and a cloud model you pick for the hard tasks.

## Add a cloud provider

1. Open **Settings → Providers** (the gear in the chat toolbar).
2. Under **Add a provider**, choose **Cloud APIs** and click the provider. Type in **Find a provider…** to search every category.
3. The new card opens with the **API key** field focused. Paste your key. The card's **Get an API key ↗** link opens the provider's key page.
4. Press **Test connection**. The models the key can use are listed, and they appear in the chat's model picker marked **cloud**.

Prefer the keyboard? Run **LocalPilot: Set Provider API Key…** from the Command Palette.

## Where your key is kept

| In the key field | Where the key lives |
|---|---|
| A pasted key | VS Code secret storage, which is your OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux). settings.json only holds `${secret:<id>}`, so syncing or sharing settings never shares the key. |
| `${env:OPENAI_API_KEY}` | An environment variable. Cloud presets start with the provider's usual variable, so a key you already export works as is. Launch VS Code from a shell that exports it. |

The card header shows the state without revealing the key: no badge when the key resolves, or a warning such as **OPENAI_API_KEY not set** or **key missing** when it does not. Removing a provider deletes its stored key. The `localpilot` CLI cannot read the keychain and uses `LOCALPILOT_KEY_<ID>` instead, for example `LOCALPILOT_KEY_OPENAI`.

## Which model answers

- **A model you pick** in the chat's picker, or set as `localpilot.defaultModel`, is always used, cloud or not.
- **Automatic picks** (Auto, read-only subagents, images, Plan mode) prefer a local model and use a cloud model only when no comparable local one is available.
- **Inline completions** run on every pause in typing, so they never go to a cloud model unless you set one in `localpilot.inlineCompletion.model`. Cloud APIs have no fill-in-the-middle endpoint, so LocalPilot sends the code around the cursor through chat and inserts only the reply. A small, fast model (Claude Haiku, `gpt-*-mini`, a Groq model) keeps ghost text responsive.
- **Auto-tune** never writes a cloud model into your settings, and cloud models are never warmed up, which would only cost tokens.

## Provider notes

**Claude (Anthropic).** LocalPilot talks to the Messages API directly (`type: "anthropic"`). It supports tool use, images and prompt caching, so a long agent run is billed at cache rates for the repeated system prompt and tools. Thinking follows `localpilot.thinking`. Current models use adaptive thinking with an effort level, older models a token budget. Reasoning is streamed to the chat and sent back during the tool loop that produced it.

**OpenAI and other OpenAI-compatible APIs.** OpenAI's reasoning models reject `temperature` and `max_tokens`, and some APIs reject `reasoning_effort`. LocalPilot drops or renames the parameter, asks again and remembers this for that model. Speech, image, embedding and moderation models are hidden from the picker.

**Google Gemini** uses Google's OpenAI-compatible endpoint, `https://generativelanguage.googleapis.com/v1beta/openai`, with a key from Google AI Studio.

**OpenRouter** lists several hundred models. Disable the ones you do not want in **Settings → Models**. OpenRouter reports each model's context window and tool support, and LocalPilot uses both.

**Azure OpenAI** uses the v1 endpoint, `https://<resource>.openai.azure.com/openai/v1`. Replace `YOUR-RESOURCE` in the preset; the key is sent as `api-key`.

**Ollama Cloud** uses the native Ollama API at `https://ollama.com` with a key from your ollama.com account. Tags ending in `-cloud` on a local Ollama are also treated as cloud models.

## In settings.json

```jsonc
"localpilot.providers": [
  { "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434" },
  { "id": "anthropic", "type": "anthropic", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "${secret:anthropic}" },
  { "id": "openai", "type": "openai", "baseUrl": "https://api.openai.com/v1", "apiKey": "${env:OPENAI_API_KEY}" },
  { "id": "gemini", "type": "openai", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "apiKey": "${env:GEMINI_API_KEY}" }
]
```

Refer to a model as `<provider id>/<model>`, for example `anthropic/claude-sonnet-4-6` or `openai/gpt-5`.

## Privacy

A cloud provider receives the prompts and code you send to its models, under that provider's terms. Nothing goes to a cloud provider you have not added, and local providers stay on your machine. See [Privacy]({{ '/privacy/' | relative_url }}) and [Models & providers]({{ '/docs/models/' | relative_url }}).

## Troubleshooting

- **"OPENAI_API_KEY not set" on the card.** VS Code was started without the variable. Paste the key instead, or start VS Code from a shell that exports it.
- **401 or "invalid x-api-key".** The key is wrong or revoked. Paste a new one; it replaces the stored key.
- **No models listed.** Some keys can only use certain models, and Azure deployments must exist first. Add model ids by hand in the card's **Models** field if the API does not list them.
- **"Rate limiting" retries.** LocalPilot waits as long as the provider asks (`retry-after`) before retrying. A rejected key or an exhausted quota is reported at once instead of retried.
- **A model is never picked automatically.** That is by design for cloud models. Pick it in the chat's picker or set it as the default model.
