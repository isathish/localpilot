---
layout: docs
title: OmniRoute and LiteLLM in VS Code — one gateway for many cloud models
description: Connect the OmniRoute or LiteLLM gateway to VS Code with LocalPilot. One local endpoint for many cloud providers, with automatic fallback in the gateway and local models still preferred by LocalPilot.
permalink: /guides/omniroute-vscode/
keywords: OmniRoute VS Code, OmniRoute coding agent, LiteLLM VS Code, LiteLLM proxy VS Code, AI gateway VS Code, LLM router VS Code
---

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) and [LiteLLM](https://docs.litellm.ai/docs/simple_proxy) are gateways. They run on your machine and expose one OpenAI-compatible endpoint, then forward each request to a cloud provider, with routing, quotas and fallback handled in the gateway. LocalPilot adds the agent on top: tool calls, file edits, terminal commands, parallel agents and change review.

Because a gateway forwards your prompts to cloud models, LocalPilot marks it as **cloud** although its address is `localhost`. Automatic picks keep preferring your local models, and the gateway answers when you choose one of its models.

## Start a gateway from LocalPilot

Run **LocalPilot: Start Gateway** from the Command Palette and pick OmniRoute or LiteLLM. Or press **Start OmniRoute** / **Start LiteLLM proxy** on the gateway's card in **Settings → Providers**. It handles each starting point:

| Situation | What happens |
|---|---|
| The gateway already runs | It is added as a provider (marked **cloud**) and LocalPilot reports what it can route to. It is not started twice. |
| It is installed but not running | It starts in a terminal named *LocalPilot · OmniRoute*, bound to `127.0.0.1` only. LocalPilot waits until `/v1/models` answers, then adds it. |
| OmniRoute is not installed | LocalPilot checks for Node.js 22.22+ or 24–26 and npm, and tells you what to install if they are missing. After you confirm, it runs `npm install -g omniroute` and starts it. **Copy command** gives you the line instead. |
| LiteLLM is not installed | LocalPilot runs `python3 -m pip install --user 'litellm[proxy]'` (`py -3` on Windows). Run Start Gateway again afterwards, since pip may install `litellm` to a folder that is not on your PATH yet. |
| LiteLLM has no config | LocalPilot asks for your proxy config file (`model_list`) and remembers it in `localpilot.gateways.litellmConfig`. |
| Another program holds the port | It offers the next free port and updates the provider. |
| The terminal closes before it answers | LocalPilot stops waiting and says so. The terminal output shows why. |

**What runs:**

```bash
OMNIROUTE_SERVER_HOST=127.0.0.1  omniroute --port 20128 --no-open --non-interactive
litellm --host 127.0.0.1 --port 4000 --config <your config>
```

OmniRoute binds to every network interface by default. LocalPilot always sets `OMNIROUTE_SERVER_HOST=127.0.0.1`, so the gateway, and the provider keys connected to it, are reachable only from this machine.

**Stop:** **LocalPilot: Stop Gateway** stops a gateway LocalPilot started. A gateway you started yourself keeps running.

## Connecting providers in OmniRoute

A fresh OmniRoute has no upstream providers. It lists only its own routes (`auto`, `auto/coding`, `auto/fast`…), and a request has nowhere to go. LocalPilot checks for this when the gateway starts. It shows **OmniRoute is running but has no provider connected** with **Open dashboard** and **Refresh models**.

1. Open the dashboard (`http://127.0.0.1:20128/`) and connect a provider under **Providers**. That can be an API key, a subscription, or one of its free tiers.
2. Press **Refresh models**, or run Start Gateway again. Provider models appear next to the routes, as `omniroute/openai/gpt-5.4`, `omniroute/glm/glm-5.2` and so on.

You can also connect a provider from a terminal: `omniroute setup --non-interactive --add-provider --provider openai --api-key "$OPENAI_API_KEY" --test-provider`.

If a request still has no route (for example the connected provider is out of quota), the chat says **The gateway has no provider it can send this request to**, with where to fix it. It is not retried.

## Picking models

- **`omniroute/auto`**, **`omniroute/auto/coding`**, **`omniroute/auto/fast`** and the other routes let OmniRoute pick the provider and fall back between them.
- **`omniroute/openai/gpt-5.4`** and other provider-prefixed ids go to that provider. LocalPilot passes the id through unchanged.
- **Combos** you define in OmniRoute appear by their name.

Gateway models are cloud models. Auto, subagents and inline completions keep preferring local models, and use the gateway only when you pick one of its models or nothing local is available.

## Keys

OmniRoute needs a key only when `REQUIRE_API_KEY=true`. Its model list stays open, so LocalPilot still lists the models. A chat request without the key then shows **The provider rejected the API key**. Create a key with `omniroute keys add` or under **Dashboard → Endpoints**. Paste it into the gateway's provider card, where LocalPilot keeps it in your OS keychain.

A LiteLLM master key goes into the LiteLLM card the same way.

## Check a real gateway end to end

With the gateway running and a provider connected, run this from a LocalPilot checkout:

```bash
npm run e2e:gateway                                              # OmniRoute on 127.0.0.1:20128
GATEWAY=litellm GATEWAY_URL=http://127.0.0.1:4000/v1 npm run e2e:gateway
GATEWAY_KEY=sk-… GATEWAY_MODEL=openai/gpt-5.4 npm run e2e:gateway
```

It drives the `localpilot` CLI in a throwaway home folder:

1. add the gateway as a provider
2. check its models are marked cloud
3. get a real answer through it
4. have the real model read a file with a tool call and answer from it

It exits 2 with instructions if no gateway answers, or if the gateway has no provider connected.

## Settings in settings.json

```jsonc
{ "id": "omniroute", "type": "openai", "baseUrl": "http://localhost:20128/v1", "displayName": "OmniRoute", "cloud": true }
{ "id": "litellm", "type": "openai", "baseUrl": "http://localhost:4000/v1", "displayName": "LiteLLM", "cloud": true }
```

`localpilot.gateways.litellmConfig` is the LiteLLM config file Start Gateway uses.

## Other gateways and proxies

Add any OpenAI-compatible gateway as a **Custom endpoint**, then turn on **Sends prompts to cloud models** in its card (`"cloud": true`). Without it, LocalPilot treats a `localhost` server as local and may pick its models automatically.

## Tips

- Model names from a gateway rarely say how large their context window is. Set the card's **Context window** if the default 32k is too small for the models you route to.
- A gateway model that answers in plain text instead of tool calls still works in Agent mode: LocalPilot falls back to its text tool protocol.
- Keep a local model configured too. Read-only subagents, inline completions and other automatic picks then stay on your machine.
