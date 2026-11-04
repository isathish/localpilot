---
layout: docs
title: Privacy
description: What the LocalPilot extension sends and to whom, what stays on your disk, and what this website collects. Two separate answers, stated plainly.
permalink: /privacy/
---

LocalPilot has two parts with different privacy behaviour: the **extension** you install in VS Code, and **this website**. They are answered separately below. For what the agent can do on your machine and how it is limited, see [Security]({{ '/security/' | relative_url }}).

## The extension

### Where your code and prompts go

Only to the model servers listed in `localpilot.providers`. Cloud APIs (OpenAI, Anthropic, Gemini…) are used only if you add them, and automatic model picks prefer local models even then. The defaults are all on `localhost`:

| Server | Default address |
|---|---|
| Ollama | `http://localhost:11434` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp | `http://localhost:8080/v1` |
| vLLM (or colibri) | `http://localhost:8000/v1` |

Auto-detection also probes a few other local ports and running Docker containers. It only adds servers that answer on your machine. If you add a remote endpoint yourself, your prompts go there.

**Cloud providers** (OpenAI, Anthropic, Gemini, OpenRouter and the others under *Settings → Providers → Cloud APIs*) and **gateways** that forward to them (OmniRoute, LiteLLM) receive the prompts and code you send to their models, under that provider's terms. They are marked **cloud** in Settings and in the model picker. Automatic picks prefer local models, and two features never use a cloud model unless you choose one for them: inline completions (`localpilot.inlineCompletion.model`) and auto-tune.

**API keys** you paste are stored in VS Code secret storage, which is your operating system's keychain. settings.json only holds a `${secret:<id>}` reference, so settings sync never carries the key. A key can also come from an environment variable (`${env:NAME}`). The Settings page is told only whether a key is present, never the key itself.

### Other network requests

| Request | When | How to turn it off |
|---|---|---|
| Skill registry index (names and descriptions) from GitHub | At most once a day, when skills auto-install is on | `localpilot.skills.autoInstall: off` |
| Web search and web fetch tools | When the agent calls them | `localpilot.approvals.network` (`ask` to approve each, `never` to block) |
| Model downloads | Only when you start one (setup, catalog, gallery) | Don't start one |
| MCP servers | Only servers you configure | Remove them from `localpilot.mcpServers` |
| Dependency checks against [OSV.dev](https://osv.dev): package names and versions from your lockfiles, no code | When the `security_scan` tool, `/scan` or `localpilot scan` checks dependencies | `localpilot.approvals.network` (`ask` or `never`) in the editor; `--offline` in the CLI |
| Plugin marketplaces (fetched with `git`) | When you browse or install plugins | Remove them from `localpilot.plugins.marketplaces` |
| Model gallery listings from ollama.com, hub.docker.com and huggingface.co | While the model gallery is open | Don't open the gallery |
| Browser tools (open and read web pages) | When the agent calls them | `localpilot.approvals.network` (`ask` to approve each, `never` to block) |

There is no account, no analytics SDK and no update check in the extension. Extension updates come from VS Code itself, the same as for any other extension.

### What stays on your disk

- **Usage metrics** for the Dashboard and model tuning: model calls, tokens, latency, tool runs, agent turns, completion acceptance. They are daily JSONL files in `~/.localpilot/telemetry`, kept for `localpilot.telemetry.retentionDays` (default 30). Nothing reads them except LocalPilot on your machine. Turn recording off with `localpilot.telemetry.enabled: false`, or delete everything from **Dashboard → Delete all recorded data**.
- **Chats, memory notes and checkpoints** in VS Code's extension storage and in `.localpilot/` inside your project.

### How to check this yourself

1. Disconnect from the network. Chat, edits, tests and completions keep working against a local model.
2. Open **Settings → Providers** and confirm every address is one you expect.
3. Read the source on [GitHub]({{ site.repo }}). The network code is in `src/providers/`, `src/tools/web.ts`, `src/tools/browser.ts`, `src/security/`, `src/agent/skillCatalog.ts`, `src/agent/skillInstaller.ts`, `src/agent/pluginInstaller.ts` and `src/mcp/`.

## This website

This site ({{ site.url }}{{ site.baseurl }}) is hosted on GitHub Pages and **does use tracking**:

- **Google Analytics** records page views. It also records clicks on the Install, Download VSIX and GitHub links, and the "Ask AI" buttons, so we can tell which pages help people get started.
- **Live view counts** ("1.2K views" under each page title, and the totals on the home page). Each page load sends one request to [Abacus](https://abacus.jasoncameron.dev), a free counter service. The request adds one to an anonymous counter for that page and one to the site total, and keeps a stream open so the numbers update while you read. Abacus stores only the counts, but like any web server it sees your IP address. No cookies are set. A flag in your browser's local storage (`lp-visited`) makes your first visit count once towards "people explored". **If your browser sends Global Privacy Control or Do Not Track, you are shown the numbers but not counted.** Before the live numbers arrive, the page shows totals read from Google Analytics when the site was built.
- **Google Fonts** serves the site's fonts, so your browser requests them from Google.
- **GitHub Pages** keeps standard server logs, under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

None of this touches the extension. Blocking analytics in your browser has no effect on LocalPilot.

Questions or concerns: [open an issue]({{ site.repo }}/issues).
