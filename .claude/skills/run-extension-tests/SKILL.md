---
name: run-extension-tests
description: Run LocalPilot's checks, including type-check, lint, offline smoke tests and the Mocha suites inside a real VS Code Extension Development Host, and run a single suite in an isolated VS Code instance when another one is already running. USE WHEN verifying a change, writing or debugging a test in src/test/, or when `npm test` fails with "only supported if no other instance of Code is running".
---

# Testing LocalPilot

## Fast checks, every change

```bash
npx tsc --noEmit && npx eslint src         # types and lint (what `npm run compile` runs before bundling)
node --check media/chat.js                  # webview scripts are plain JS and not type-checked
npm run smoke                               # offline: mock Ollama/OpenAI servers, agent loop, context, pool, worktrees
```

## Mocha suites in VS Code

`npm test` compiles to `out/`, bundles, lints and runs every `out/test/**/*.test.js` in an Extension Development Host. `.vscode-test.mjs` runs VS Code with a throwaway `HOME`/`USERPROFILE` (nothing touches the real `~/.localpilot`), `LOCALPILOT_KEYCHAIN=none` and a test secrets passphrase; VS Code builds are cached in `.vscode-test/`. Wait for asynchronous effects with `waitFor(condition, timeoutMs, what)` from `src/test/waitFor.ts` instead of fixed sleeps.

Write tests in `src/test/<area>.test.ts` using `suite`/`test` and `assert`. Put logic in pure functions or classes with injected dependencies (a runner, a clock `now`, a file path) so tests need no real models or timers. `src/test/autonomy.test.ts` shows the pattern: a controllable runner, a fake clock, `await q.flush()` before teardown.

### Run one suite, or run while another VS Code test host is open

The test CLI refuses to start while another instance using the same user-data folder is running, and it resolves packages relative to its config file. So create a **temporary config in the repo root** with its own user-data folder, run it, then delete it:

```bash
npm run compile-tests && node esbuild.js
d=$(mktemp -d /tmp/lp-test-XXXX)
cat > .vscode-test.tmp.mjs <<EOF
import base from './.vscode-test.mjs';         // keeps the isolated home and the test env
export default {
  ...base,
  files: 'out/test/autonomy.test.js',            // or 'out/test/**/*.test.js'
  launchArgs: ['--user-data-dir', '$d/ud'],
  mocha: { timeout: 60000 },
};
EOF
npx vscode-test --config .vscode-test.tmp.mjs 2>&1 | grep -E "✔|passing|failing|^\s+[0-9]+\) |Error|expected|actual"
rm -f .vscode-test.tmp.mjs; rm -rf "$d"
```

- A config without `...base` must set the env itself; the telemetry folder **must end in `telemetry`**, because `telemetry.test.ts` asserts it.
- Don't kill VS Code processes you didn't start. Another session or the user may own them.
- The full suite takes about 4 minutes. Run it in the background and keep working.

### End-to-end tests with a real model

`src/test/e2e.test.ts` is opt-in: it skips unless `LOCALPILOT_E2E_MODEL=ollama/<tag>` (or `auto`) is set, and then needs Ollama on `localhost:11434` with that model; once opted in, a missing Ollama or model fails instead of skipping. A timeout like `session … still running after 200000 ms` with only the first user message in the transcript means the model never answered. Check `curl -s localhost:11434/api/ps` for large models loaded and other test runs sharing Ollama before suspecting the code. Say so in your report instead of calling the run green.

## Report

Give pass and fail counts. For each failure, say whether it comes from your change, from the environment (Ollama load, a config artifact), or is unknown, with the evidence. Don't call anything verified that you didn't run.
