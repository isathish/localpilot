---
layout: docs
title: OmniRoute and LiteLLM in VS Code — one gateway for many cloud models
description: Connect the OmniRoute or LiteLLM gateway to VS Code with LocalPilot. One local endpoint for many cloud providers, with automatic fallback in the gateway and local models still preferred by LocalPilot.
permalink: /guides/omniroute-vscode/
keywords: OmniRoute VS Code, OmniRoute coding agent, LiteLLM VS Code, LiteLLM proxy VS Code, AI gateway VS Code, LLM router VS Code
---

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) and [LiteLLM](https://docs.litellm.ai/docs/simple_proxy) are gateways. They run on your machine and expose one OpenAI-compatible endpoint, then forward each request to a cloud provider, with routing, quotas and fallback handled in the gateway. LocalPilot adds the agent on top: tool calls, file edits, terminal commands, parallel agents and change review.

Because a gateway forwards your prompts to cloud models, LocalPilot marks it as **cloud** although its address is `localhost`. Automatic picks keep preferring your local models, and the gateway answers when you choose one of its models.

## OmniRoute

1. Install and start OmniRoute: `npm install -g omniroute`, then `omniroute`. It serves its API and dashboard on `http://localhost:20128`.
2. In the OmniRoute dashboard, connect the providers you want to use.
3. In VS Code, open **Settings → Providers → Add a provider → Gateways** and click **OmniRoute**. LocalPilot also finds a running OmniRoute by itself.
4. Press **Test connection**. OmniRoute's models are listed as `omniroute/<model>`, for example `omniroute/auto/coding`, `omniroute/cc/claude-sonnet-4-6` or a combo by its name.

OmniRoute needs an API key only when its `REQUIRE_API_KEY` setting is on. Create one under **Dashboard → API Keys** and paste it into the card; LocalPilot keeps it in your OS keychain.

```jsonc
{ "id": "omniroute", "type": "openai", "baseUrl": "http://localhost:20128/v1", "displayName": "OmniRoute", "cloud": true }
```

## LiteLLM proxy

1. Start the proxy, for example `litellm --config config.yaml`. It listens on `http://localhost:4000`.
2. Add **LiteLLM proxy** under **Gateways**, or let auto-detect find it.
3. If the proxy has a master key, paste it into the card.

```jsonc
{ "id": "litellm", "type": "openai", "baseUrl": "http://localhost:4000/v1", "displayName": "LiteLLM", "cloud": true }
```

## Other gateways and proxies

Add any OpenAI-compatible gateway as a **Custom endpoint**, then turn on **Sends prompts to cloud models** in its card (`"cloud": true`). Without it, LocalPilot treats a `localhost` server as local and may pick its models automatically.

## Tips

- Model names from a gateway rarely say how large their context window is. Set the card's **Context window** if the default 32k is too small for the models you route to.
- A gateway model that answers in plain text instead of tool calls still works in Agent mode: LocalPilot falls back to its text tool protocol.
- Keep a local model configured too. Read-only subagents, inline completions and other automatic picks then stay on your machine.
