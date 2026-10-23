---
title: Development
description: Build LocalPilot from source, run the tests, and contribute.
permalink: /docs/development/
---

## Prerequisites

Node.js 20+ and VS Code 1.104+.

```bash
git clone {{ site.repo }}.git
cd localpilot
npm install
```

## Scripts

| Command | What it does |
|---|---|
| `npm run compile` | Type-check (`tsc`), lint (`eslint`) and bundle with esbuild → `dist/extension.js` |
| `npm run watch` | Rebuild on change |
| `npm run smoke` | Offline tests: mock Ollama & OpenAI servers, agent loop, context manager, parallel pool |
| `npm test` | Mocha tests inside a real Extension Development Host (downloads VS Code on first run) |
| `npx @vscode/vsce package --no-dependencies` | Build the VSIX |

Press <kbd>F5</kbd> to launch an Extension Development Host.

## Architecture

```
src/
  providers/      Ollama + OpenAI-compatible clients, registry (provider/model ids)
  agent/          agentLoop (model⇄tools), subagents, skills, prompts, parallel pool, changeTracker
  context/        contextManager (budget → prune → compact), tokenizer, workspaceContext (@mentions, rules)
  tools/          fs, search (ripgrep), terminal, editor/diagnostics, web search/fetch, registry
  sessions/       persisted multi-session store
  ui/             chatController, chatViewProvider (webview), agentsView, chatParticipant,
                  lmProvider (Language Model API), inlineCompletion, inlineEdit, images,
                  settingsPanel (Settings / provider manager / setup wizard webview)
  mcp/            stdio MCP client
media/            chat.js / chat.css, settings.js / settings.css (webviews), walkthrough/*.md, icons
docs/             this site (Jekyll, GitHub Pages)
```

### Adding a tool

1. Create `src/tools/<name>.ts` exporting a `Tool` with a JSON-schema `definition`.
2. Set `parallelSafe: true` for read-only tools; set `approvalKind` for mutating ones.
3. Register it in `src/extension.ts` and add a label in `toolLabel()` in `media/chat.js`.

### Adding a provider type

Implement `LLMProvider` (`src/types.ts`), branch in `createProvider()` (`src/providers/registry.ts`), and extend the `type` enum in `package.json`.

## Releases

CI runs on every push and pull request. To cut a release from a clean `main`:

```bash
npm run release -- patch     # or minor | major | 1.2.3
```

The script bumps `package.json` and the docs version, promotes the **Unreleased** section of `CHANGELOG.md`, runs compile + smoke + packaging, commits, tags `vX.Y.Z` and pushes. The **Release** workflow then builds and tests on CI, attaches `localpilot-X.Y.Z.vsix`, a stable `localpilot.vsix` and `SHA256SUMS.txt` to a GitHub Release with the changelog as notes, and — if `VSCE_PAT` / `OVSX_PAT` repository secrets exist — publishes to the VS Code Marketplace and Open VSX. The docs site deploys from `docs/` on every push to `main`.

## Website

The site in `docs/` is plain Jekyll (GitHub Pages). Everything site-wide lives in `docs/_config.yml`:

| Key | Used by |
|---|---|
| `google_analytics` | Google tag (gtag.js) in `_includes/head.html`, plus `ask_ai`, `download_vsix`, `click_install`, `click_github` and `copy_markdown` events. |
| `ask_ai` | The **Ask AI** buttons (`_includes/ask-ai.html`) shown under every docs title and in the footer. Each entry is an assistant whose public `?q=` parameter receives a pre-filled, page-aware prompt — ChatGPT, Claude, Perplexity and Gemini (via Google AI Mode, since the Gemini app has no prefill parameter). |
| `topics`, `works_with` | Footer link columns and the keyword *Topics* strip (`_includes/footer.html`). Add a target keyword here so it becomes a crawlable link. |
| `nav`, `guides` | Sidebar, footer columns, pager and `/llms.txt`. |

Docs pages also get **Copy page as Markdown** (fetches the page source from GitHub and strips the front matter) and **View as Markdown** links, and `/llms.txt` lists every page with its description for LLM crawlers.

## Contributing

Issues and pull requests are welcome at [{{ site.repo }}]({{ site.repo }}). Please run `npm run compile && npm run smoke` before opening a PR.
