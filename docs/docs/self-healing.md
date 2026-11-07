---
title: Self-healing & recovery
description: How LocalPilot detects a failing build, test, tool or model call, finds the root cause, fixes it, re-runs the checks and tells you plainly when it needs you.
permalink: /docs/self-healing/
---

A coding agent that stops at the first red build is not much help. LocalPilot's self-healing engine runs inside the agent loop: when a build, a test, a tool or a model call fails, it detects the failure, classifies it, works out the root cause, fixes it, re-runs the relevant checks and carries on. It stops when the task is verified or when a safety boundary is reached (attempts, time, approvals), and then it tells you exactly why and what to do next.

It is on by default in VS Code and in the [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}), for every agent, skill and subagent. Turn it off with `localpilot.healing.enabled`; LocalPilot then behaves exactly as it did before.

## How it works

Each task follows the same lifecycle:

**Plan → Execute → Detect → Fix → Retry → Validate → Complete**

1. **Execute.** The agent works as usual: it reads, edits and runs commands.
2. **Detect.** Every tool result, model error and check output is classified: a category (TypeScript error, failing unit test, missing dependency, model timeout, git conflict, security finding…), a severity and a stable signature such as `TS2345@src/api/user.ts`.
3. **Fix.** Transient problems (a model server that went away, a stalled reply, a dropped MCP connection) are retried with backoff. Deterministic problems (compile errors, failing tests) get one focused fix step: the agent sees the error, the code around it and its own change in that file, and is asked for the root cause and the smallest fix. Small local models do much better with one problem at a time, so it fixes the first group of related failures per attempt.
4. **Retry and validate.** The failing check runs again, then every earlier stage. If a fix makes things worse (more or more severe failures, or a check that passed now fails), that attempt's edits are rolled back and the next attempt is told what happened.
5. **Regression.** Once the failing check passes, the full relevant test suite runs, so a fix that breaks something else is caught.
6. **Complete.** A completion contract decides the outcome (see [Outcomes](#outcomes)). A task is only reported as done when it really is.

Fixing the same error again with the same change is not self-healing. When a signature survives a fix, the next prompt says so; when it survives two, the engine stops and asks you. A patch identical to an earlier one is refused, and a fix step that changes no file counts as a failed attempt straight away.

Independent groups of failures (different files with no import between them) can be fixed by parallel **fixer** subagents when `localpilot.healing.delegateFixes` is on and `parallel.maxConcurrency` is above 1. Each fixer runs only the checks for the files it touched; the parent then runs the full suite once.

## When checks run

Checks run **only when files actually changed** in the turn, in Agent, Debug and Multitask mode (after the workers report). Changes come from:

- the edit tools (`edit_file`, `write_file`, `apply_patch`, `notebook_edit`, `delete_path`);
- commands the agent runs that touch files (`sed -i`, code generators, `npm install` writing a lockfile). LocalPilot compares the working tree before and after each command, so these count too;
- files written by subagents and workers.

Reading code, `git log`, `ls` and other exploration never trigger checks.

When every changed file is outside every check's scope (documentation, `*.md`, images and other assets, files that belong to no detected ecosystem and match no check's `when` globs), no check runs and the task completes normally. Files under `.localpilot/` never count as changes.

By default (`localpilot.healing.checkTiming: onComplete`) the checks run once, when the agent says it is done, so the edit loop stays fast on a local machine. With `afterEdits`, a fast typecheck or build also runs after steps with edits (at most once every 3 steps). In VS Code, the errors the language server reports after an edit are classified for free in both modes.

Inside one verification run the stages go in this order and stop at the first failure: build or typecheck, lint (only blocking when required), the tests affected by the changed files (`localpilot.healing.scopeTests`), the full relevant test suite, then the security check. Stages that passed on an identical tree are reused.

### Baseline: failures that were there before

Before the first file change of a turn, LocalPilot runs a quick baseline so failures that already existed are not blamed on the task, and not "fixed" by it. With `localpilot.healing.baseline: fast` (the default) the baseline is **typecheck + lint only**, never a build or tests; ecosystems whose only compile check is a build (Maven, Gradle, .NET, Go) skip it. `all` runs every check, `off` treats every failure as new. Failures that match the baseline are shown as *preexisting* and never block. The baseline is cached by the state of the tree, so a clean tree is not checked twice.

## Check discovery

LocalPilot finds the checks by reading project files. Nothing is executed during discovery. In a monorepo it also looks at the package folders that contain changed files.

| Ecosystem | Detected by | Build | Typecheck | Lint | Tests |
|---|---|---|---|---|---|
| Node / TypeScript | `package.json` (pnpm, yarn, bun or npm from the lockfile) | `build` or `compile` script | `typecheck` / `type-check` / `check-types` / `tsc` script, else `node_modules/.bin/tsc --noEmit` when installed (never `npx`) | `lint` script | `test` script (not npm's placeholder); affected tests with jest `--findRelatedTests` or `vitest related` |
| Python | `pyproject.toml`, `setup.cfg`, `pytest.ini`, `tox.ini`, `requirements*.txt` | `python -m compileall` (syntax) | `mypy` or `pyright` when configured | `ruff` or `flake8` when configured | `python -m pytest` |
| Go | `go.mod` | `go build ./...` | | `go vet ./...` | `go test ./...`, affected packages first |
| Rust | `Cargo.toml` | `cargo build` (only without typecheck) | `cargo check --all-targets` | `cargo clippy` when listed in `rust-toolchain` | `cargo test` |
| Maven | `pom.xml` (prefers `./mvnw`) | `mvn -DskipTests compile` | | | `mvn test` |
| Gradle | `build.gradle(.kts)` (prefers `./gradlew`) | `compileJava` / `compileKotlin` | | | `test` |
| .NET | `*.sln`, `*.csproj`, `*.fsproj` | `dotnet build` | | | `dotnet test` |
| Make | `Makefile` | `make build` | `make typecheck` | `make lint` | `make test` / `make check` |

A built-in, offline **security** check scans the changed files for secrets and risky code (see `localpilot.healing.securityCheck`).

Build, typecheck and test checks are required by default; lint and custom checks are not. A failing non-required check is reported but does not block. Each discovered check has a fixed time limit by kind: 300 s for build, typecheck and custom checks, 180 s for lint, 600 s for tests and 120 s for the security scan. To change a limit, set `timeoutSeconds` on that check in `.localpilot/checks.json` or `localpilot.healing.checks` (the same `id` overrides the discovered check). See the detected checks for the open workspace in **Settings → Agent & approvals → Self-healing**.

### `.localpilot/checks.json`

Override or add checks per project with `.localpilot/checks.json` (**Open checks.json** in the Self-healing settings creates it). It takes precedence over the `localpilot.healing.checks` setting, which takes precedence over discovery; entries are matched by `id`.

```json
{
  "checks": [
    { "id": "custom:e2e", "kind": "test", "command": "npm run test:e2e", "required": false, "timeoutSeconds": 900, "when": ["src/api/**"] },
    { "id": "npm:test", "kind": "test", "command": "npm run test:unit", "scoped": "npx mocha {tests}" }
  ],
  "disable": ["npm:lint"],
  "timeBudgetSeconds": 1200
}
```

| Field | Meaning |
|---|---|
| `id` | The check's id. Use a discovered id (`npm:test`, `pytest`, `cargo:check`…) to replace that check |
| `kind` | `build`, `typecheck`, `lint`, `test` or `custom` |
| `command` | The full command line |
| `cwd` | Workspace-relative folder (absolute paths and `..` are rejected) |
| `scoped` | Command for affected-only runs, with `{files}`, `{tests}` or `{pkgs}` |
| `timeoutSeconds` | Time limit for this check (10–3600) |
| `required` | A failing required check blocks completion |
| `when` | Globs: run only when a changed file matches |
| `disable` | Discovered check ids to switch off |
| `timeBudgetSeconds` | Total time for one verification run in this project |

**Trust.** `checks.json` and a workspace's `localpilot.healing.checks` value are commands chosen by the repository, so they are **ignored in an untrusted workspace**; only discovery and your User settings apply there. In the CLI the workspace is untrusted by default, so `checks.json` is ignored unless you pass `--trust-workspace` or set `LOCALPILOT_TRUST_WORKSPACE=1`. That is expected behaviour, not a bug. Every check, trusted or not, still goes through the normal approval pipeline.

## Budgets and default policies

Every recovery loop has a limit:

| Budget | Setting | Default |
|---|---|---|
| Fix attempts per code-fix category | `localpilot.healing.maxRepairAttempts` | 3 |
| Recovery attempts per task, all categories | `localpilot.healing.maxTotalAttempts` | 8 |
| Extra model steps for recovery, beyond `maxIterations` | `localpilot.healing.extraSteps` | 16 |
| Recovery deadline | `localpilot.healing.taskDeadlineMinutes` | 60 min |
| Time for one verification run | `localpilot.healing.checkTimeBudgetSeconds` | 900 s |

The **recovery deadline counts from the first detected failure**, and only while a recovery is active. A long, healthy run (a big Multitask turn, for example) has no deadline. When a budget runs out, the report names it: *Stopped: task deadline of 60 min reached*.

Default policy per kind of failure (change them with `localpilot.healing.policies` or the **Retry configuration** table in the settings):

| Failure | What happens | Attempts |
|---|---|---|
| Model server unreachable, network timeout | Reconnect and retry with exponential backoff (1 s, 2 s, 4 s); waits for the server's health check first, so "Ollama is down" does not burn attempts | 3 |
| Model stalled | Retry; the last attempt may move to a comparable idle model | 3 |
| Model out of memory | Adjust resources: thinking off, smaller context window, one request at a time, then a smaller model with the same tool protocol and locality (a local model is never swapped for a cloud one unless your fallback rules already allow it) | 2 |
| Malformed tool call or JSON | Repair it deterministically when safe, else ask the model to resend | 2 |
| Compile, TypeScript, build error | Root-cause analysis, targeted fix, rebuild | 3 |
| Required lint | Fix | 2 |
| Unit test | Diagnose and fix the implementation (tests are not edited unless new in this turn or you asked) | 3 |
| Integration test | Diagnose with the neighbouring modules (importers and imports of the changed files) | 2 |
| Runtime crash | Stack frames, code, fix | 2 |
| Missing dependency | Resolve, with your approval | 1 |
| MCP tool not connected | Restart the server and retry, only when the call provably did not run; a timed-out call is never replayed | 2 |
| Database / migration | Read-only validation of the schema and state | 1 |
| Security finding | Remediate, or block completion | 2 (at most 3) |
| Check timed out | One retry with double the time, else *Not verified* | 1 |
| Git conflict, data corruption, missing credentials, loop | Stop and escalate | 0 |

Transient failures are retried only when the model had not produced any output yet, so nothing is replayed twice.

## Verification approvals

Checks are ordinary `run_command` calls and go through the same managed policy, `settings.json` permission rules, hooks, approval prompts and audit log as the agent's own commands. Their rows appear under **Verification** in the chat.

With `localpilot.approvals.terminal: ask`, one prompt covers the verification run: *Run verification checks: `npm run typecheck`, `npm test` (LocalPilot self-healing)*. A yes is an **allowance for the rest of the turn** (at most 30 minutes). It is tied to the check commands **and the scripts that define them**: the `scripts` of `package.json`, the Makefile recipes, `.localpilot/checks.json` and wrapper scripts. If the agent rewrites the `test` script, the allowance no longer applies and you are asked again.

The allowance never overrides a stronger rule:

- a mandatory prompt from your organization's policy or an `ask` rule in `settings.json` asks every time;
- `deny` rules, a hook that blocks and `approvals.terminal: never` refuse the check; the task then ends as *Not verified*;
- unattended runs (the task queue) run checks only when no prompt is needed, and **never install anything**: a needed install leaves the task *Needs input*.

## Outcomes

At the end of each task the completion contract records whether requirements were met, code changes were applied, and compilation, tests, lint, security, regression and approvals passed. The outcome is one of:

| Outcome | Meaning |
|---|---|
| **Completed** (verified) | Every required check passed, or none applied because the changes were out of scope |
| **Not verified** (`completed_unverified`) | No failures, but a required check could not run: it was denied, needed a prompt in an unattended run, timed out, no checks were found for the changed code, or the dependencies are missing in a worktree. Also when **the check definitions or tests were changed during a fix** (for example `package.json` `scripts.test`, a test config or an existing test file the request did not mention): a fix that edits the yardstick cannot count as verified, and the footer lists the edits |
| **Incomplete** | Checks still fail after the budget, a critical or high failure is unresolved, or the deadline was reached |
| **Blocked** | It needs you: an approval was declined or could not be asked, credentials are missing, a git conflict waits for review, the model replied `Blocked:`, or a security finding needs your decision |
| **Failed** | The model or engine could not continue (for example the model server stayed unreachable) |
| **Cancelled** | You pressed Stop |

The final answer ends with a short footer, for example *Verified: typecheck ✓ · tests 42/42 ✓* or *Incomplete: `npm test` still fails (TS2345 in src/api/user.ts:42) after 3 attempts. Root cause: … Next: …*. An escalation report always has the root cause, what was tried and the next action.

**CLI.** One-shot runs exit with `4` when the task is incomplete and `5` when it is blocked. `0` still means completed or not verified; add `--require-verified` to make *Not verified* exit `4` too. With `--json`, `run_result` has `finishReason` `incomplete` or `blocked` and carries `outcome` and `contract`, and `recovery` events stream as NDJSON lines. See [Terminal & CLI]({{ '/docs/terminal-and-cli/#self-healing-in-the-cli' | relative_url }}).

**Task queue.** A queued task that ends **Incomplete** gets the status `incomplete`; a **Blocked** one gets `needs_input`. Both count as finished and hold back the tasks that depend on them, like `failed`. **Retry** on such a task continues in the same chat with its recovery state instead of starting over. *Not verified* tasks are `done`.

## Security guarantees

Self-healing never makes LocalPilot less safe:

- **Installs always ask.** A dependency install or package add is a mandatory approval, even with `approvals.terminal: always`. `localpilot.healing.dependencyInstall: never` turns installs off (the task is reported as blocked). This setting is user-only.
- **No security bypass.** There is no setting to skip a security finding, and the model cannot waive one. Only you can accept a risk, from the recovery card, after a confirmation; it is recorded in the audit log, the recovery state and telemetry.
- **`localpilot.healing.securityCheck` is user-only**, so a repository's `.vscode/settings.json` cannot switch it off.
- **Git conflicts always escalate.** Conflicted files are left as they are (no `checkout --theirs`, no `reset`) and handed to you, with **Open merge editor** on the card.
- **Data corruption stops.** A corrupted database or data file stops the task at once, with no fix attempts and no writes.
- **Dangerous commands always ask during recovery.** While a recovery is active, a destructive-looking command prompts even if `approvals.dangerousAlwaysAsk` is off.
- The engine's own commands are only the discovered checks and a fixed list of install commands; none of them is destructive.
- Files you edit during a run are never rolled back by the engine; the attempt escalates instead.

## Failure memory

LocalPilot remembers failures and the fixes that worked, and offers them as **suggestions** when the same failure comes back. A suggestion is always presented as "may not apply; check against the current code", is never applied automatically, and the result is validated by the checks like any other fix.

`localpilot.healing.memory` chooses where it is kept:

| Value | Store |
|---|---|
| `workspace` (default) | Per workspace in VS Code's storage (`~/.localpilot/recovery/` in the CLI). Not committed, not shared |
| `project` | `.localpilot/recovery-memory.json`, which you can commit to share with your team |
| `off` | Nothing is remembered |

An entry holds the failure signature (`TS2345`, normalised message), the category, the root cause, the strategy, a short diff excerpt with secrets redacted, the files involved and whether validation passed.

The project file is written by other people, so it is treated as untrusted input: it is **read only in a trusted workspace** (in the CLI, with `--trust-workspace` or `LOCALPILOT_TRUST_WORKSPACE=1`), and each entry is **sanitised** before it reaches a prompt (short single-line root cause and strategy, instruction-like lines and URLs removed, the diff shown only as a fenced excerpt, at most two entries). The memory files never trigger checks.

A suggestion that fails twice more often than it works stops being offered. To switch one off yourself, open **Dashboard → Self-healing & recovery → Failure History**, pick the entry and choose **Don't suggest again**. Memory stays on your machine unless you choose `project` and commit the file.

## Restart and resume

Recovery state is saved after every step, before any side effect, so it survives a crash or a reload.

- **Reloading or closing the window interrupts** a running recovery; it does not cancel it. When you open that chat again, a **Recovery interrupted** card shows the phase, attempt N/M and the open failures, with **Resume**, **Rollback fixes** and **Dismiss**. Resume re-runs the checks first (unchanged stages are free), then continues the fix or completes. Edits are never replayed, and an install that had started is not rerun; the checks show whether it took effect.
- A queued task interrupted by a reload is put back in the queue and **continues in the same chat**, rather than repeating the whole prompt.
- **Stop cancels.** The task ends as *Cancelled*, running checks are killed and nothing resumes.
- If the CLI and VS Code use the same session, only one runs its recovery; the other shows *Recovery is running in another window*.
- In the CLI, `localpilot -c` prints the interrupted state before the prompt, and `/recovery resume` continues it.
- A run that was not recovering when it was cut off shows **Run interrupted** instead, with what ran and the files it changed; its recovery phase is also kept with the run. See [Agent runs and crash recovery]({{ '/docs/continuity/' | relative_url }}#agent-runs-and-crash-recovery).

## Worktrees

With [isolated worktrees]({{ '/docs/parallel-agents/#isolated-worktrees' | relative_url }}) (queue concurrency above 1, parallel fixers), a fresh worktree usually has no `node_modules`, `.venv`, `target` or similar. When the main checkout has them and the worktree does not, the checks run against the main checkout after the worktree is applied, or they are **skipped** with *dependencies not installed in worktree* and the task is *Not verified*. A resulting "Cannot find module" is never treated as a missing dependency, so it never leads to an install prompt.

Failures in files last written by **another running task** in the same folder are reported as *foreign* ("2 failures in files changed by another running task"). They are never attributed to, fixed by or counted against this task.

## In the chat: the recovery card

Each task with a recovery gets one card that updates in place:

- a header such as **Self-healing · attempt 2/3 · TypeScript (TS2345)**;
- the phases: Detect → Diagnose → Fix → Validate → Regression;
- the root cause line, chips for each check (✓, ✗, ⏱ with durations) and the patches per attempt (file, +/−; rolled-back ones struck through, with **Rollback** per attempt);
- the end state: **Recovered after N attempts** (green), **Not verified** (amber) or **Needs you: reason** (red) with actions: Resume, Retry with guidance, Approve install, Rollback, Open merge editor, Accept risk (security findings only, confirmed and audited) and Dismiss.

The check commands appear as **Verification** rows under the card. The answer's footer shows the outcome badge. Open interventions are also listed in the Agents view.

## Dashboard

**Settings → Dashboard → Self-healing & recovery** shows the engine state, failures detected, recovered, pending interventions, recovery rate and mean time to recover, the current recovery of each running chat, and eight views: Failure History, Root Cause Analysis, Recovery Attempts, Applied Patches, Retry Configuration, Regression Reports, Human Intervention Queue and Recovery Performance Analytics. See [Dashboard]({{ '/docs/dashboard/#self-healing--recovery' | relative_url }}).

The **recovery rate** has one definition everywhere: *recovered ÷ (recovered + escalated + exhausted + blocked)* over the recovery episodes in the range, and 0 when nothing happened. Preexisting and foreign failures never open an episode, and *Not verified* never counts as recovered.

Telemetry stays local like every other metric. Recovery events carry only categories, outcomes, counts, timings and a 16-character **signature hash**, never code, messages, file paths or the readable signature (`TS2345@src/api/user.ts` contains a path; the Dashboard resolves it from the local recovery store). OTLP export adds only the `localpilot.recovery.*` metrics (`localpilot.recovery.events`, `localpilot.recovery.outcomes`, `localpilot.recovery.duration_ms`), without any signature attribute.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No checks ran | Did files change? Exploration and docs-only edits do not run checks. Is the mode Agent, Debug or Multitask? Look at **Detected checks for this workspace** in the settings |
| `checks.json` is ignored | The workspace is untrusted. In VS Code, trust it; in the CLI, pass `--trust-workspace` or set `LOCALPILOT_TRUST_WORKSPACE=1` |
| Always *Not verified* | A check is denied (`deny` rule, hook, `approvals.terminal: never`), times out (raise that check's `timeoutSeconds` in `.localpilot/checks.json` or `localpilot.healing.checks`), needs a prompt in a queued task, or the worktree has no dependencies. The footer says which |
| Asked to approve checks again in the same turn | The check scripts changed (for example the agent edited `package.json` `scripts`), or a mandatory organization or `settings.json` rule asks every time |
| The first edit of a turn is slow | The baseline is running. `fast` runs only typecheck and lint; use `off` to skip it |
| A failure that was already there blocks the task | Keep `baseline` on (`fast` or `all`) so preexisting failures are recognised |
| It stopped with *task deadline reached* | Raise `localpilot.healing.taskDeadlineMinutes` or set `0`. The deadline only runs while recovering |
| A queued task shows `needs_input` | It needs an approval (usually an install), credentials or a conflict review. Open the chat, act, then **Retry** |
| The CLI exits with 4 or 5 in CI | 4 = incomplete (or not verified with `--require-verified`), 5 = blocked. The `run_result` line has `outcome` and `contract` |
| You want the old behaviour | `localpilot.healing.enabled: false` (or `localpilot.healing.autoFix: false` to detect and report only) |
