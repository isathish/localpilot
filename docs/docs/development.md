---
title: Development
description: Build LocalPilot from source, run the tests, and contribute.
permalink: /docs/development/
---

## Prerequisites

Node.js 20+ and VS Code 1.140+.

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
                  lmProvider (Language Model API), inlineCompletion, inlineEdit, images
  mcp/            stdio MCP client
media/            chat.js / chat.css (webview), icons
docs/             this site (Jekyll, GitHub Pages)
```

### Adding a tool

1. Create `src/tools/<name>.ts` exporting a `Tool` with a JSON-schema `definition`.
2. Set `parallelSafe: true` for read-only tools; set `approvalKind` for mutating ones.
3. Register it in `src/extension.ts` and add a label in `toolLabel()` in `media/chat.js`.

### Adding a provider type

Implement `LLMProvider` (`src/types.ts`), branch in `createProvider()` (`src/providers/registry.ts`), and extend the `type` enum in `package.json`.

## Releases

CI runs on every push and pull request. Pushing a tag `vX.Y.Z` (matching `package.json`) builds the VSIX, creates a GitHub Release with it attached, and — if `VSCE_PAT` / `OVSX_PAT` secrets are configured — publishes to the VS Code Marketplace and Open VSX. The docs site deploys from `docs/` on every push to `main`.

## Contributing

Issues and pull requests are welcome at [{{ site.repo }}]({{ site.repo }}). Please run `npm run compile && npm run smoke` before opening a PR.
