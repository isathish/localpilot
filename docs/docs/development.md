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
| `npm test` | Mocha tests inside a real Extension Development Host (downloads VS Code on first run). Includes **end-to-end runs against a real local model** when Ollama is reachable on `:11434` — a real tool call writes a file, two sessions run in parallel, `stop()` aborts a run. Skipped otherwise; `LOCALPILOT_E2E_MODEL=ollama/<tag>` forces a model. |
| `npx @vscode/vsce package --no-dependencies` | Build the VSIX |

Press <kbd>F5</kbd> to launch an Extension Development Host.

### UI harnesses

The webviews can be opened in a plain browser with mock data for quick visual checks in light/dark and at any width — no Extension Host needed:

| File | What it shows |
|---|---|
| `scripts/ui-preview.html` | Chat view with a full sample transcript (steps, diff and terminal cards, approvals, tasks, changes). |
| `scripts/ui-preview-parallel.html` | Chat view with a stateful mock controller; `window.sim.start/tool/text/end(sessionId, …)` drives several sessions streaming at once to check tabs and background runs. |
| `scripts/settings-preview.html?section=models&light=1` | Settings / setup wizard (`?page=setup`) with mocked providers, probe results, hardware profile, installed models, catalog and jobs. |

## Extension API

`activate()` returns a small API for other extensions and scripts:

```ts
const lp = await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
const id = await lp.runPrompt('Add input validation to src/server.ts', 'agent');   // new session, streams in the background
const ids = await lp.runParallel(['Write tests for utils', 'Update the README']);   // one agent per task, concurrently
lp.onDidChangeRuns(() => console.log(lp.runningSessionIds));
lp.stop(id);
```

`send(sessionId, text)` resolves with the final answer, `getSession(id)` returns the transcript, `listModels()` the discovered models and `version` the installed extension version.

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
media/            chat.js / chat.css, settings.js / settings.css (webviews), walkthrough/*.md, icons,
                  localpilot.woff (brand icon font → $(localpilot-logo); rebuild with `npm run icons`)
docs/             this site (Jekyll, GitHub Pages)
```

### Adding a tool

1. Create `src/tools/<name>.ts` exporting a `Tool` with a JSON-schema `definition`.
2. Set `parallelSafe: true` for read-only tools; set `approvalKind` for mutating ones.
3. Register it in `src/extension.ts` and add a label in `toolLabel()` in `media/chat.js`.

### Adding a provider type

Implement `LLMProvider` (`src/types.ts`), branch in `createProvider()` (`src/providers/registry.ts`), and extend the `type` enum in `package.json`.

## Releases

Releases are driven by the version in `package.json`. **Whenever `main` carries a version that has no `vX.Y.Z` tag yet, the Release workflow releases it.** Nothing is tagged until the build is green:

1. **prepare** checks that `package.json`, `package-lock.json`, `docs/_config.yml` and the `CHANGELOG.md` section agree (`npm run check:version`) and decides whether the version is new.
2. **verify** type-checks, lints, runs the smoke and Extension Host tests, packages `localpilot-X.Y.Z.vsix` and checks the version inside the VSIX.
3. **publish** creates the `vX.Y.Z` tag, the GitHub Release (that version's changelog section as notes, plus the VSIX, a stable `localpilot.vsix` and `SHA256SUMS.txt`) and publishes to the VS Code Marketplace and Open VSX when the `VSCE_PAT` / `OVSX_PAT` secrets exist. A failed publish fails the run; re-run **Publish to Marketplace** for that tag to retry without burning a version.

Pushes that do not change the version only run CI and deploy the docs.

### Cutting a release

Two equivalent ways:

- **From GitHub:** *Actions → Prepare release → Run workflow*, pick `patch`, `minor`, `major` or a custom version. It bumps, updates the changelog, verifies, commits `release: vX.Y.Z` to `main` and starts the Release workflow.
- **From your machine**, on a clean `main`:

  ```bash
  npm run release -- patch            # or minor | major | 1.2.3
  npm run release -- patch --dry-run  # show the version and release notes without changing anything
  ```

Both run `scripts/release.js`, which bumps the four version locations, promotes the **Unreleased** section of `CHANGELOG.md` to `## X.Y.Z — date`, runs compile + smoke + packaging and pushes the commit. Write changelog entries under `## Unreleased` as you go; if there are none, the script generates them from the conventional commits since the previous tag (`feat:` → Added, `fix:` → Fixed, `docs:`/`site:` → Documentation, anything else → Changed; `chore:`, `test:`, `ci:` and `release:` commits are skipped). If `package.json` was already bumped by hand and is untagged, `patch`/`minor`/`major` release that pending version instead of bumping again.

Editing `package.json` by hand and pushing still works, provided `docs/_config.yml` matches and the changelog has a `## X.Y.Z` section with entries; CI and the Release workflow fail early otherwise. Pushing a tag manually or running *Actions → Release → Run workflow* for an existing tag is still supported.

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
