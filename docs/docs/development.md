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
| `npm run compile` | Type-checks (`tsc --noEmit`), lints (`eslint src`) and bundles with esbuild into `dist/extension.js`. |
| `npm run watch` | Rebuilds with esbuild and type-checks with `tsc` on every change. |
| `npm run smoke` | Offline smoke tests (`scripts/smoke.ts`): mock Ollama and OpenAI-compatible servers, the agent loop, context manager, parallel pool, worktrees, telemetry and more. No VS Code needed. |
| `npm test` | Compiles, then runs the Mocha suites in `src/test/` inside a real Extension Development Host (`vscode-test` downloads VS Code on first run). See below. |
| `npm run check:version` | Checks that `package.json`, `package-lock.json`, `docs/_config.yml` and the `CHANGELOG.md` section agree on the version. |
| `npm run icons` | Rebuilds the `localpilot.woff` icon font. |
| `npx @vscode/vsce package --no-dependencies --readme-path MARKETPLACE.md` | Builds the VSIX the same way CI does. |

`npm test` includes end-to-end runs against a real local model (`src/test/e2e.test.ts`). They need Ollama on `localhost:11434` with a tool-capable model: a real tool call writes a file, two sessions run in parallel, and `stop()` aborts a run. Without Ollama they skip themselves, which is what happens in CI. Set `LOCALPILOT_E2E_MODEL=ollama/<tag>` to force a model. The test runner points `LOCALPILOT_TELEMETRY_DIR` at a scratch folder, so the made-up providers the tests create never appear on your real Dashboard.

Press <kbd>F5</kbd> to launch an Extension Development Host.

### UI harnesses

The webviews can be opened in a plain browser with mock data for quick visual checks in light/dark and at any width — no Extension Host needed:

| File | What it shows |
|---|---|
| `scripts/ui-preview.html` | Chat view with a full sample transcript (steps, diff and terminal cards, approvals, tasks, changes). |
| `scripts/ui-preview-parallel.html` | Chat view with a stateful mock controller; `window.sim.start/tool/text/end(sessionId, …)` drives several sessions streaming at once to check tabs and background runs. `sim.reopen()` reloads the page the way a re-created webview boots (init + `session` with `liveFrom` + `replay`) to check that runs in flight are rebuilt. |
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

The full surface (`LocalPilotApi` in `src/extension.ts`):

| Member | What it does |
|---|---|
| `runPrompt(prompt, mode?, attachments?)` | Starts a new session and returns its id; the run streams in the background. |
| `runParallel(tasks, mode?)` | One independent agent per task, all concurrent; returns the session ids. |
| `runBestOfN(prompt, models, mode?)` | The same prompt on several models at once, each in its own git worktree; returns the session ids. |
| `send(sessionId, text)` | Follow-up in an existing session; resolves with the final assistant text. |
| `stop(sessionId)` | Cancels a running session. |
| `getSession(id)` | The persisted `Session` (messages, todos, model, worktree…). |
| `applyWorktree(sessionId)` / `discardWorktree(sessionId)` | Bring an isolated session's edits onto the workspace (uncommitted) or throw them away. |
| `runningSessionIds` / `onDidChangeRuns` | Ids currently running and an event that fires when the set changes. |
| `listModels()` | Every model discovered across the configured providers. |
| `autoSetupModels(opts?)` | Installs a starter model set sized for this machine (`installRuntime`, `target`, `force`). |
| `installModel(target, model)` | Pulls one model onto a runtime; resolves `true` on success. |
| `screenshotUrl(url, opts?)` | Renders a URL in a local headless Chromium and returns the PNG (base64) with its size. |
| `inspectUrl(url, opts?)` | DevTools report for a URL — screenshot, console, network, performance and layout checks, optionally after scripted actions. |
| `chatHost` | `{ viewId, visible, ready }` for the chat view wherever VS Code currently places it (undefined before first shown). |
| `telemetry` | `summary(days)`, `logs(filter)` and `dir` — the local-only metrics behind the Dashboard. |

## Architecture

```
src/
  providers/      Ollama + OpenAI-compatible clients, registry (provider/model ids), catalog, discovery
                  (auto-detect, Docker), modelManager, modelGallery, colibri, usageAdvisor
  agent/          agentLoop (model⇄tools), subagents, skills, prompts, parallel pool, changeTracker
  context/        contextManager (budget → prune → compact), tokenizer, workspaceContext (@mentions, rules)
  tools/          fs, search (ripgrep), terminal, editor/diagnostics, web search/fetch, browser (headless Chromium), registry
  sessions/       persisted multi-session store
  ui/             chatController, chatViewProvider (webview), agentsView, chatParticipant,
                  lmProvider (Language Model API), inlineCompletion, inlineEdit, images, markdownViewer,
                  modelAutoTune, settingsPanel (Settings / provider manager / setup wizard webview), cli
  mcp/            MCP client (mcpManager)
  cli/            the `localpilot` terminal CLI and its VS Code shim
  telemetry/      local-only metrics store behind the Dashboard
  terminal/       terminal manager for agent commands
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
2. **verify** (on Ubuntu) type-checks, lints, runs the smoke and Extension Host tests, packages `localpilot-X.Y.Z.vsix` and checks the version inside the VSIX.
3. **publish** creates the `vX.Y.Z` tag, the GitHub Release (that version's changelog section as notes, plus the VSIX, a stable `localpilot.vsix` and `SHA256SUMS.txt`) and publishes to the VS Code Marketplace and Open VSX when the `VSCE_PAT` / `OVSX_PAT` secrets exist. A failed publish fails the run; re-run **Publish to Marketplace** for that tag to retry without burning a version. Finally it starts the **Docs** workflow so the website shows the new version (commits pushed by the workflow itself do not trigger push-based runs, so this is done explicitly).

Pushes that do not change the version are checked for releasable commits: if the push contains anything other than `docs:`, `site:`, `copy:`, `readme:`, `chore:`, `ci:`, `build:`, `test:`, `tests:`, `style:`, `wip:`, `merge:` or `release:` commits (see `scripts/auto-bump.js`), a **bump** job runs `scripts/release.js` on `main` (patch by default; minor for a breaking `type!:` commit; or whatever `[release patch|minor|major]` in a commit message asks for), commits `release: vX.Y.Z` and starts a new Release run, which tags and publishes it. Put `[skip release]` in a commit message to hold a push back.

Separately from releases, the **CI** workflow runs on every push and pull request to `main` that touches code (pushes that only change `docs/` or Markdown files are skipped, except `CHANGELOG.md` and `MARKETPLACE.md`). On Ubuntu, macOS and Windows it runs `check:version`, `compile`, `smoke` and the Extension Host tests (about 190). On Ubuntu it also packages a VSIX artifact. The live-model end-to-end tests skip in CI because no Ollama runs there. The **Docs** workflow deploys the website when `docs/` or `CHANGELOG.md` changes.

### Cutting a release by hand

Only needed to pick a specific version (for example a minor or major bump). Two equivalent ways:

- **From GitHub:** *Actions → Prepare release → Run workflow*, pick `patch`, `minor`, `major` or a custom version. It bumps, updates the changelog, verifies, commits `release: vX.Y.Z` to `main` and starts the Release workflow.
- **From your machine**, on a clean `main`:

  ```bash
  npm run release -- patch            # or minor | major | 1.2.3
  npm run release -- patch --dry-run  # show the version and release notes without changing anything
  ```

Both run `scripts/release.js`, which bumps the version in `package.json`, `package-lock.json` and `docs/_config.yml`, promotes the **Unreleased** section of `CHANGELOG.md` to `## X.Y.Z — date`, runs `check:version`, compile, smoke and packaging, then commits `release: vX.Y.Z` and pushes it. Write changelog entries under `## Unreleased` as you go; if there are none, the script generates them from the conventional commits since the previous tag (`feat:` → Added, `fix:` → Fixed, `docs:`/`site:`/`copy:`/`readme:` → Documentation, anything else → Changed; `chore:`, `ci:`, `build:`, `test:`, `style:` and `release:` commits are skipped unless they are all there is). If `package.json` was already bumped by hand and is untagged, `patch`/`minor`/`major` release that pending version instead of bumping again.

Editing `package.json` by hand and pushing still works, provided `docs/_config.yml` matches and the changelog has a `## X.Y.Z` section with entries; CI and the Release workflow fail early otherwise. Pushing a tag manually or running *Actions → Release → Run workflow* for an existing tag is still supported.

## Website

The site in `docs/` is plain Jekyll (GitHub Pages). The version shown on the site (`site.version`) is taken from `package.json` when the Docs workflow builds, so it always matches the released extension; the `version:` key in `docs/_config.yml` is only a fallback for local `jekyll serve` and is kept in sync by `npm run release` / `npm run check:version`. Everything else site-wide lives in `docs/_config.yml`:

| Key | Used by |
|---|---|
| `google_analytics` | Google tag (gtag.js) in `_includes/head.html`, plus `ask_ai`, `download_vsix`, `click_install`, `click_github` and `copy_markdown` events. |
| `ask_ai` | The **Ask AI** buttons (`_includes/ask-ai.html`) shown under every docs title and in the footer. Each entry is an assistant whose public `?q=` parameter receives a pre-filled, page-aware prompt — ChatGPT, Claude, Perplexity and Gemini (via Google AI Mode, since the Gemini app has no prefill parameter). |
| `topics`, `works_with` | Footer link columns and the keyword *Topics* strip (`_includes/footer.html`). Add a target keyword here so it becomes a crawlable link. |
| `nav`, `guides` | Sidebar, footer columns, pager and `/llms.txt`. A new guide page needs an entry under `guides`. |

The site's Google Analytics is the only tracking on the site; the extension has none. The [privacy page]({{ '/privacy/' | relative_url }}) explains both.

Docs pages also get **Copy page as Markdown** (fetches the page source from GitHub and strips the front matter) and **View as Markdown** links, and `/llms.txt` lists every page with its description for LLM crawlers.

## Contributing

Issues and pull requests are welcome at [{{ site.repo }}]({{ site.repo }}). Please run `npm run compile && npm run smoke` before opening a PR.
