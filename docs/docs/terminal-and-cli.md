---
title: Terminal & CLI
description: Watch the agent run commands in a VS Code terminal, send terminal output to the chat, and run the LocalPilot agent from any shell with the localpilot CLI.
permalink: /docs/terminal-and-cli/
keywords: local AI CLI, terminal coding agent, Ollama CLI agent, claude code alternative CLI, VS Code terminal AI, fix terminal error AI
---

## The agent's terminal

When the agent runs a command with `run_command`, you see it run in a terminal named **LocalPilot Agent**. It uses VS Code's shell integration, so you get the shell's own prompt, colours and exit-code markers. The agent receives the captured output and exit code.

![The chat shows Edited cart.js and Ran npm test, exit 0; next to it the LocalPilot Agent terminal shows both tests passing]({{ '/assets/screenshots/terminal-agent.png' | relative_url }})

How it behaves:

- Each chat session gets one agent terminal, reused for all its commands.
- The model gets the same output you see, with ANSI colours and shell-integration markers removed.
- Stopping the chat sends Ctrl+C to the running command.
- The command's output streams live into its row in the chat. Rows longer than 5 lines fold; click to see all of it.
- **Proceed While Running** on the running command row lets the agent carry on while the command keeps going. The agent gets the output so far, and later output is appended to a log file it can read with `read_file`. The logs live in `cmd-logs` under the extension's global storage (`~/.localpilot/cmd-logs` for the CLI). Each log is capped at 10 MB, and logs older than 24 hours are deleted at startup.
- A command still running after `localpilot.terminal.autoDetachSeconds` (default 300) is detached the same way, or sooner if the model asked for a shorter `timeout_seconds`. With the setting at `0`, commands are stopped at their timeout instead (default 120, maximum 600).
- **Stop** on a running or detached command row kills the command and every process it started.
- If the shell has no shell integration, or `localpilot.terminal.runInIntegratedTerminal` is off, the command runs in a hidden process instead. The result is the same, but you do not see it run.
- Commands started with `background: true` (dev servers, watchers) are detached after their first 3 seconds of output, and the rest goes to their log. Detached commands are stopped when the window closes or the CLI exits.

| Setting | Default | Purpose |
|---|---|---|
| `localpilot.terminal.runInIntegratedTerminal` | `true` | Run agent commands in the visible LocalPilot Agent terminal |
| `localpilot.terminal.reveal` | `true` | Show the terminal panel, without taking focus, when a command runs |
| `localpilot.terminal.autoDetachSeconds` | `300` | Seconds before a running command is detached so the agent can continue. `0` = never |
| `localpilot.terminal.shellIntegrationTimeout` | `4000` | Milliseconds to wait for shell integration in the agent terminal before using the hidden process (minimum 500). Raise it if a slow shell startup makes the agent fall back |
| `localpilot.terminal.profile` | `default` | Shell for agent commands: `default` (VS Code's default shell) or a profile name from `terminal.integrated.profiles.<os>` |

**Agent terminal profile.** Run **LocalPilot: Select Agent Terminal Profile…** to pick the shell from your `terminal.integrated.profiles` for this OS (for example Git Bash or PowerShell on Windows, fish on Linux). The profile's path and args are used for the agent terminal, background commands and the hidden fallback process. A profile that only names a `source` (PowerShell, Git Bash) uses its usual install location. A profile whose shell is not found, or that is not a shell (tmux, WSL), uses the default shell. The CLI does not read VS Code's terminal profiles and always uses the system shell.

## Send terminal output to the chat

LocalPilot records the commands you run in any VS Code terminal that has shell integration. The last command and its output are then one click away.

| Action | How |
|---|---|
| Explain the last output | Right-click a terminal → **LocalPilot: Explain Terminal Output** |
| Fix a failed command | Right-click a terminal → **LocalPilot: Fix Failed Command**. It takes the most recent command that exited non-zero, opens an Agent chat and asks it to find the cause, fix it and re-run the command |
| Attach the output | Right-click a terminal → **LocalPilot: Add Terminal Output to Chat**, or type `@terminal` in the chat. With text selected in the terminal, the selection is drafted as a **Terminal output:** block instead (your clipboard is left as it was); otherwise the last command and its output are attached |
| Generate a shell command | <kbd>⌘⌥K</kbd> (<kbd>Ctrl+Alt+K</kbd>) in a terminal, or right-click → **LocalPilot: Generate Terminal Command…** |

## The `localpilot` CLI

`localpilot` runs the LocalPilot agent in a shell. It uses the same agent loop, tools, skills, memory, MCP servers, permission rules and change tracking as the extension. It runs under Node and talks to the same model servers you configured. For what else may go over the network (skill registry, web tools, MCP servers you add), see [Privacy]({{ '/privacy/' | relative_url }}).

![The localpilot CLI in the LocalPilot terminal: it reads the code, edits test/cart.test.js, runs npm test (3 passing), prints a summary and lists the changed file]({{ '/assets/screenshots/terminal-cli.png' | relative_url }})

### Install

- **Inside VS Code.** Run *LocalPilot: Open LocalPilot Terminal*. It is also in the chat toolbar's ⋯ menu, and in the terminal **+** dropdown as the **LocalPilot** profile. The CLI is already on `PATH` in that terminal.
- **In any shell.** Run *LocalPilot: Install 'localpilot' CLI in PATH*. It writes `~/.local/bin/localpilot` (Windows: `%USERPROFILE%\bin\localpilot.cmd`). The script finds the newest installed LocalPilot after updates. It needs Node.js 18.17+ (20+ recommended); with an older or missing `node` the script uses VS Code's bundled runtime. Reading PDFs (`read_pdf`, PDF attachments) needs Node.js 22.13 or newer; on an older Node that tool returns an error and everything else works. If `~/.local/bin` is not on your `PATH`, the notification tells you the line to add.

### Examples

```bash
localpilot "fix the failing tests in src/api"     # one task in agent mode, then exit
localpilot                                        # interactive session (REPL)
localpilot --ask "how does the retry logic work?"
localpilot --plan "migrate the auth module to JWT"
localpilot -f src/db.ts "add connection pooling"  # attach files (path#L10-L20 for a range)
localpilot --yes "update all deps and run tests"  # approve every command/edit/network call (CI, scripts)
localpilot -p "summarise this repo" > NOTES.md    # print only the final answer
git diff | localpilot --ask "review this diff"    # piped stdin becomes the prompt
git diff | localpilot "write the changelog entry" # with a task: stdin is added as <stdin>…</stdin> context
localpilot --yolo --timeout 10m "fix the lint errors" # CI preset; exit code tells how it went
localpilot --json "add a test for parse()" | jq -c .type   # NDJSON event stream
localpilot "what is wrong in @./screenshot.png"   # @path attaches a file, or an image
localpilot -m ollama/qwen3:8b "…"                 # pick a model for this run
localpilot models                                 # models from every reachable server (cloud ones marked)
localpilot doctor                                 # check servers, settings, skills, MCP, ripgrep
localpilot providers add anthropic                # add Claude; asks for the key (not echoed)
localpilot -m anthropic/claude-sonnet-4-6 "…"     # run a task on a cloud model
localpilot skill install anthropics/skills/skills/pdf
localpilot skill search "write a plan" --install
```

An installed Ollama that is not running is started by the CLI when a run or `localpilot models` needs it (`Starting Ollama at http://localhost:11434…` on stderr); it keeps running afterwards, as it does when VS Code starts it.

### Subcommands

| Command | What it does |
|---|---|
| `localpilot models` | Lists models from every reachable provider. Cloud models are marked `cloud` |
| `localpilot doctor` | Checks providers (reachability and key state), settings and tools. `--json` prints the same as JSON; `doctor log` prints the log file's path and opens it. Warns when this CLI is older than the newest LocalPilot extension installed in VS Code, Cursor or VSCodium |
| `localpilot config [kind] [--json]` | Lists what is in force, with source path and on/off state: `rules`, `skills`, `agents`, `commands`, `hooks`, `mcp`, `tools` (with the approval each needs) or `plugins`. Without a kind, all of them |
| `localpilot providers` | Lists providers under **Local** and **Cloud** with reachability, model count and where each key comes from. Never prints a key |
| `localpilot providers presets` | Lists what `providers add` accepts: local servers, cloud APIs and gateways |
| `localpilot providers add <preset\|url>` | Adds a provider: a preset (`openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `omniroute`…) or any OpenAI-compatible URL; a close name such as `hf` picks the matching preset and says which. Options: `--key <key>`, `--key-env VAR`, `--url <url>`, `--region <aws-region>` (Amazon Bedrock), `--id <id>`, `--name <name>`, `--type ollama\|openai\|anthropic`, `--cloud` / `--no-cloud`. Checks the connection and lists the models |
| `localpilot providers key <id> [key]` | Sets a provider's API key: as an argument, typed at a hidden prompt, or piped in (`pass openai \| localpilot providers key openai`). `--key-env VAR` reads it from a variable instead; `--remove-key` deletes it |
| `localpilot providers test [id]` | Checks one provider, or all, and lists their models |
| `localpilot providers remove <id>` | Removes a provider added from the CLI, with its stored key. A provider from VS Code settings is disabled for the CLI only |
| `localpilot mcp [list] [--json]` | Lists the MCP servers in force: transport, command or URL, on/off state, the file each comes from and any definition it overrides. Without arguments in a terminal, a numbered menu to add, remove, enable, disable or sign in |
| `localpilot mcp add <name> [--env K=V]… -- <command> [args…]` | Adds a local (stdio) server to `~/.localpilot/mcp.json`, or to `./.mcp.json` with `--scope project`. Everything after `--` is the server's command line. `--force` replaces a server of the same name |
| `localpilot mcp add <name> <url> [--transport http\|sse] [--header "K: V"]…` | Adds a remote server. Without `--transport`, Streamable HTTP is tried first, then SSE |
| `localpilot mcp remove\|enable\|disable <name>` | Removes a server from its file, or switches it on or off where it is defined (a file's `disabled` field, or the `localpilot.mcpServers` setting in `~/.localpilot/config.json`) |
| `localpilot mcp auth <name>` | Connects to a remote server once, so it can sign you in, and reports its tools |
| `localpilot skill install <source> [--user]` | Installs a skill from `owner/repo[/path]`, `owner/repo@ref/path`, a GitHub URL, a `SKILL.md` URL or a folder. `--user` installs to `~/.localpilot/skills` |
| `localpilot skill search <words> [--install]` | Ranks the skill registry (`localpilot.skills.repositories`) for a query. `--install` installs the best match |
| `localpilot eval [--models a,b]` | Benchmarks models on real coding tasks; see [Benchmarking models](#benchmarking-models) |
| `localpilot scan [folder]` | Security scan: vulnerable dependencies, committed secrets and risky code; see [Security scanning](#security-scanning) |
| `localpilot history [--json] [--limit 50]` | Lists the sessions saved in this folder, newest first, with title, age, message count and model. `--json` prints them as JSON |
| `localpilot history delete <id>` | Deletes a saved session (by id, unique id prefix or list number) |
| `localpilot history export <id> [-o file]` | Exports a session as Markdown (printed, or written to `-o file.md`) or as a standalone HTML page (`-o file.html`) |
| `localpilot work [--once] [--max N]` | Takes tasks from the [shared board](parallel-agents.md#the-shared-board) (`.localpilot/board`) one after another until none is left; run several for parallel workers |

### Benchmarking models

`localpilot eval` measures how well a model does the agent's job. It runs a suite of coding tasks with the real agent loop, the same tools, prompts and context management as the chat. Each task runs in a fresh temporary workspace and is checked by running something: the task's tests, a command, file contents or the answer. No model grades another model.

```bash
localpilot eval                                                    # the default model, built-in suite
localpilot eval --models ollama/qwen2.5-coder:7b,ollama/gemma4:12b # compare models
localpilot eval --tasks py-off-by-one,js-async-bug --keep          # some tasks; keep the workspaces to inspect
localpilot eval --suite .localpilot/evals/backend.json --json out.json
```

In VS Code, **LocalPilot: Run Agent Benchmark…** in the Command Palette lets you pick the models and runs the same command in a terminal.

The built-in suite has eight tasks: fixing bugs (an off-by-one, a missing `await`), implementing a function from its tests, renaming a function across files, changing a shared function's signature and its callers, editing a config file precisely, and two questions about a codebase (where something is handled, what a change affects). They need Python 3 and Node.js; a task whose interpreter is missing is skipped, not failed. Every task fails as shipped and passes with a reference solution, and the smoke tests check both.

The report shows, per model, how many tasks passed, the average time, steps and tool calls, the share of tool calls that failed and the tokens used, then a task-by-model grid and the reason for each failure. Results are saved in `~/.localpilot/evals/`, and the next run of the same suite shows the change in pass rate since the last one. The command exits with 1 when a task fails, so a CI job can gate on it.

**Your own suite.** Put a JSON file in `.localpilot/evals/` (the first one found is the default for that workspace) or pass `--suite`:

```json
{
  "name": "backend",
  "tasks": [
    {
      "id": "fix-tax-rounding",
      "title": "Round tax to cents",
      "category": "fix",
      "needs": ["python3"],
      "files": { "tax.py": "def tax(x):\n    return x * 0.2\n", "test_tax.py": "..." },
      "prompt": "test_tax.py fails; fix tax.py.",
      "verify": { "command": ["{python}", "-m", "unittest", "-q"], "files": [{ "path": "tax.py", "pattern": "round\\(" }] },
      "timeoutSec": 300
    }
  ]
}
```

`verify.command` passes on exit code 0 (`{python}` becomes the Python 3 found on the machine); `verify.files` entries must match (or with `"absent": true`, must not); `verify.answer` is a regular expression the final answer must match. Set `"mode": "ask"` for questions.

### Security scanning

`localpilot scan` checks a workspace for three kinds of problems:

- **Vulnerable dependencies.** Exact versions are read from the lockfiles (`package-lock.json`, `yarn.lock`, `requirements*.txt` pins, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `go.mod`, `Cargo.lock`, `Gemfile.lock`) and checked against [OSV.dev](https://osv.dev), the open vulnerability database that includes GitHub's advisories, PyPA, the Go database and RustSec. Each finding names the advisory (GHSA and CVE ids), its severity and the versions that fix it. Only package names and versions are sent; `--offline` skips this part.
- **Secrets** committed to tracked files: private keys, AWS, GitHub, OpenAI, Anthropic, Slack, Google and Stripe keys, and passwords or tokens assigned in code. Values are masked in the report. Placeholders (`changeme`, `<token>`, `${VAR}`) and values read from the environment are ignored.
- **Risky code**, a short list of high-confidence patterns: TLS verification turned off, shell commands or SQL built from strings, unsafe deserialization (`pickle`, `yaml.load` without a safe loader) and `eval`. The same pattern in a test file is reported as low.

Add `localpilot-scan: ignore` (or `nosec`) on a line to skip it. The command exits with 1 when a finding reaches `--fail-on` (default `high`; `none` never fails). `--sarif file` writes SARIF 2.1.0 for GitHub code scanning, `--json file` the raw findings:

In GitHub Actions the CLI runs straight from the release's VSIX (it is self-contained; only Node.js 18.17+ is needed, 20+ recommended):

```yaml
- name: LocalPilot security scan
  env: { GH_TOKEN: "${{ github.token }}" }
  run: |
    gh release download --repo isathish/localpilot --pattern localpilot.vsix -O lp.vsix
    unzip -q lp.vsix 'extension/dist/*' -d lp
    node lp/extension/dist/cli.js scan --sarif scan.sarif --fail-on critical
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: scan.sarif }
```

In the chat, `/scan` runs the same scan and fixes what is safe to fix: it upgrades vulnerable dependencies to the fixed version and runs the tests, moves secrets to environment variables (and tells you which credentials to rotate), and rewrites the clearest risky patterns. The agent also has the scan as the `security_scan` tool, and uses it when you ask about security.

### Options

| Option | Meaning |
|---|---|
| `--agent`, `--ask`, `--plan`, `--multitask`, `--debug` | Mode (default `agent`) |
| `-i`, `--isolate` | Work in an isolated git worktree. Your checkout is untouched while the agent works. A one-shot run applies the result back as uncommitted changes when it ends. Continuing the session later (`-c`, `-r`, `/resume`) works in your checkout again |
| `--no-apply` | With `--isolate`: leave the result in the worktree and print its path |
| `-c`, `--continue` | Continue the most recent session in this folder. With a task, it runs in that session; without one, the REPL opens in it |
| `-r`, `--resume [id]` | Resume a saved session by id or list number. Without an id, shows a numbered list (title, age, messages, model) and reads a number |
| `--data-dir <dir>` | Where sessions are saved (default `~/.localpilot`; also `LOCALPILOT_DATA_DIR`) |
| `--hooks-dir <dir>` | Also run the [hook scripts](claude-code-compatibility.md#hook-scripts-in-hook-folders) in this folder (repeatable; also `LOCALPILOT_HOOKS_DIR`) |
| `-m`, `--model <provider/model>` | Model for this run; a provider id alone means its **Default model** |
| `--thinking [level]` | How hard reasoning models think: `auto`, `off`, `low`, `medium` (a bare flag), `high` or `max`. Remembered in `~/.localpilot/config.json` for later sessions |
| `-f`, `--file <path>` | Attach a file; repeatable. `path#L10-L20` for a range |
| `-y`, `--yes` | Approve every command, edit and network call |
| `-C`, `--cwd <dir>` | Workspace root (default: current directory) |
| `-p`, `--print` | Print only the final answer; no tool log, non-interactive. A one-shot run whose output is not a terminal (piped or redirected) also prints only the answer |
| `--json` | One-shot runs: one JSON object per line on stdout (`assistant_delta`, `thinking_delta`, `tool_start`, `tool_end`, `tool_progress`, `status`, `compaction`, `subagent_start`, `subagent_end`, `hook`, `nudge`, each with `type` and `ts`), then `run_result` with `finishReason`, `text`, `usage`, `costUsd`, `durationMs`, `model` and `sessionId`. Errors go to stderr as `{"type":"error","message":…,"kind":…}`, including those before the run starts (no model reachable, a bad `-P`, `-s` or `-k`, an `--isolate` failure, an invalid MCP file). `eval` and `scan` keep `--json <file>` |
| `--timeout <s>` | Stop the run after this long (`90`, `90s`, `5m`). One-shot runs only |
| `--retries <n>` | Stop after `n` failed steps in a row (overrides `localpilot.maxConsecutiveMistakes`) |
| `--yolo` | For CI: `--yes`, only `read_file`, `edit_file`, `apply_patch`, `write_file`, `run_command`, `grep_search`, `file_search` and `list_dir`, `--retries 3` unless given, and no MCP servers unless `--mcp`. One-shot runs only: without a task it exits with a usage error |
| `-s`, `--system <text\|@file>` | Add text (or a file's contents) to the system prompt. With `--system-replace` (one-shot runs only) it replaces LocalPilot's persona |
| `-P`, `--provider <id>` | Use this provider for the run: a configured one, or a preset (`openai`, `groq`…) added for this run only. Without `-m`, its default model or first model |
| `-k`, `--key <key>` | With `-P`: the API key for this run only. `--save-key` stores it like `localpilot providers key` |
| `--no-mcp` | Do not start MCP servers |
| `--compaction <strategy>` | How a full context is compacted for this run: `agentic` (model summary), `basic` (no model call) or `off`. Overrides `localpilot.compaction.strategy` |
| `-v`, `--verbose` | Show tool arguments and debug logs |
| `--ide` (`--vscode`) | Open the task in VS Code instead of running it in the shell |
| `--settings`, `--setup` | Open LocalPilot Settings or the setup wizard in VS Code |
| `-h`, `--help`; `-V`, `--version` | Help, version |

One-shot runs exit with `0` when the run finished, `1` when it ended with an error (no model reachable, the server failed), `3` when it stopped at the consecutive-mistake limit, `124` on `--timeout` and `130` when stopped with Ctrl+C. Usage errors exit with `2`.

### Saved sessions

Every CLI session is saved after each turn, per folder, under `~/.localpilot/workspaces/<hash>/sessions` (`<hash>` is derived from the folder path; `--data-dir` or `LOCALPILOT_DATA_DIR` moves the root). Quit, then `localpilot -c` to carry on where you left off, or `localpilot -r` to pick an older one.

VS Code lists these sessions in the chat history of the same folder, marked **CLI** (turn off with `localpilot.history.includeCli`). Continuing one in VS Code saves it with the editor's chats; deleting it there deletes the CLI's copy too. Forks made in either place show "forked from …" in the history.

### Interactive session

Run `localpilot` with no task to start a session. These commands are available:

| Command | What it does |
|---|---|
| `/mode agent\|multitask\|debug\|plan\|ask` | Switch mode |
| `/model <name>`, `/models` | Switch model, list models |
| `/thinking <level>` | This session's thinking level (`auto`, `off`, `low`, `medium`, `high`, `max`); remembered for later sessions |
| `/providers` | List providers with reachability and key state |
| `/changes`, `/keep` | Show or accept this session's file changes |
| `/undo [N [f\|c\|b]]` | Go back to an earlier turn: restore its files, the chat, or both (also **Esc Esc** at an empty prompt) |
| `/undo all` | Revert every pending file change of this session |
| `/file <path>` (`/attach`) | Attach a file to the next prompt |
| `/isolate`, `/apply`, `/discard` | Move to a git worktree; bring its changes into your checkout; throw them away |
| `/commands`, `/permissions`, `/hooks` | Custom commands, permission rules, hooks (see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }})) |
| `/clear` | Clear the conversation |
| `/history` | List the saved sessions in this folder |
| `/resume [N\|id]` | Switch to a saved session (without an argument, pick from the list) |
| `/fork [name]` | Copy this session and continue in the copy; the original stays as it was. History shows "forked from …" |
| `/doctor` | Run the checks from `localpilot doctor` |
| `/compact` (`/smol`) | Summarise older messages to free context, as in the chat |
| `/context`, `/memory` | Context use; the instruction files in force and the saved memory notes (the same text as in the chat) |
| `/skills`, `/agents`, `/plugins` | List skills (with their files), subagents and plugins |
| `/mcp [list]` | MCP servers with their state, tools, prompts and errors |
| `/mcp enable\|disable\|restart <name> [--save]` | Switch a server on or off for this session, even one switched off in its configuration (`--save` writes it to its configuration), or restart it |
| `/yes on\|off` | Auto-approve every action from now on (the prompt shows `[auto]`), or ask again |
| `/settings [filter]` | The effective settings (keys masked); `/settings set <key> <value>` and `/settings unset <key>` write `~/.localpilot/config.json` |
| `/help`, `/exit` (`/quit`, `/q`) | Help, leave |
| `/<custom-command> …` | Run a custom slash command or Cline workflow (also when named mid-message: `fix it, then /review`) |
| `/<skill-name> <task>` | Run a task with that skill, like `/skill <name> <task>` |
| `/deep-planning <task>` | Plan in Plan mode for one turn; the plan is saved as `implementation_plan.md` |

A dim status line above each prompt shows the model, mode, context use, git branch with uncommitted lines (`main +3 −1`), auto-approve and the session's cost: `ollama/qwen3:8b · agent · ctx 34% · main +3 −1 · auto:off`. **Tab** completes `/commands` (built-ins, custom commands, skills, MCP prompts) and `@paths` in the workspace (fuzzy, like the chat's @ menu); an `@path` in a message attaches that file, or sends that image. **Shift+Tab** switches to the next mode. On exit the CLI prints the session id, message count, tokens, cost and the command to resume it.

Run control:

- **Ctrl+C** stops the current run. Press it again to quit.
- **Ctrl+Z** pauses the run after its current step. Press it again to resume.
- **Ctrl+B** while a command runs detaches it (Proceed While Running): the agent continues and the command's later output goes to its log.
- Anything you type while a run is going is queued and handed to the agent at its next step.
- A line that starts with `>>` waits instead: it starts a new turn when the run ends, one turn per line. `/queue` lists the waiting messages and `/queue rm N` removes one. A removed steer is never sent to the model.
- Subagents pause and stop with the run.

The CLI uses the same skills as the extension: recommendations, the registry (`localpilot.skills.autoInstall`) and the shared index in `~/.localpilot/skill-catalog.json`. It notes when a registry skill matches a request but is not installed yet. See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

### Approvals

Commands, file edits, deletes and network calls go through the same approval policies as the extension (`localpilot.approvals.*`) and the same `settings.json` permission rules.

- When a policy says *ask*, the CLI shows the command or diff and prompts **[y]es · [n]o · [a]lways**. **[a]lways** approves only that kind of action (commands, file edits or network calls) until `/clear` or you exit. Deletes and destructive commands are not remembered and always ask again. Answer `n` followed by a reason (`n edit src/b.ts instead`) to deny and tell the agent what to do instead.
- When a run that took more than 10 seconds finishes, the CLI rings the terminal bell (unless `localpilot.notifications` is `off` or output is not a terminal).
- `--yes` approves everything.
- Without a TTY (for example in CI), anything that needs approval is denied unless you pass `--yes`.

Edits are tracked per run. A one-shot run prints the changed files at the end. In a session, `/undo all` reverts them and `/keep` accepts them.

`/undo` with no argument (or **Esc** twice at an empty prompt) lists the earlier turns: their number, the first 60 characters of the prompt and how many files changed since. Type a number, then `f` to restore only the files, `c` to rewind only the chat (the prompt comes back on the input line, files are kept), or `b` (or Enter) for both. `/undo 3 f` skips the questions. Files come back from the same checkpoints as in VS Code, so changes made by shell commands are restored too (see [Checkpoints]({{ '/docs/features/' | relative_url }}#checkpoints)).

### Settings

The CLI reads settings in this order, later sources winning:

1. VS Code's user `settings.json`
2. the workspace's `.vscode/settings.json`
3. `~/.localpilot/config.json`
4. command-line flags

A model server configured in LocalPilot Settings is therefore already known to the CLI. API keys that Settings stored in VS Code's secret storage (`${secret:<id>}`) are out of the CLI's reach: set `LOCALPILOT_KEY_<ID>` instead, the provider id in upper case with other characters as `_` (for example `LOCALPILOT_KEY_OPENAI` or `LOCALPILOT_KEY_OLLAMA_CLOUD`). Keys written as `${env:NAME}` work in both. Changes saved from the CLI (such as `localpilot providers add`) go to `~/.localpilot/config.json`, never to VS Code's settings. `/model` and `-m`/`--model` apply to the current run only; the lasting default is `defaultModel` in `~/.localpilot/config.json` or in VS Code's settings. Logs go to `~/.localpilot/cli.log`.

`~/.localpilot/config.json` uses the same keys without the `localpilot.` prefix:

```json
{
  "providers": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434" }],
  "defaultModel": "ollama/qwen2.5-coder:7b",
  "approvals": { "terminal": "ask", "write": "always" }
}
```

### Providers and API keys

The CLI sees every provider configured in VS Code. Providers you add with `localpilot providers add` go to `~/.localpilot/config.json` and join VS Code's list by id, so both stay in use and VS Code's settings are never written.

```bash
localpilot providers presets                      # what you can add
localpilot providers add openai                   # uses $OPENAI_API_KEY, or asks for the key
localpilot providers add anthropic --key "$KEY"   # stores the key (see below)
localpilot providers add groq --key-env GROQ_API_KEY
localpilot providers add omniroute                # local gateway, marked cloud
localpilot providers add http://gpu-box:8000/v1 --id homelab
localpilot providers                              # Local / Cloud, reachability, key state
localpilot -m anthropic/claude-sonnet-4-6 "review the auth module"
```

Where keys come from:

| `apiKey` | In the CLI |
|---|---|
| `${env:NAME}` | The variable in your shell. |
| `${secret:<id>}` | VS Code keeps this key in the OS keychain, which the CLI cannot read. It uses `~/.localpilot/keys.json` instead (written by `providers add --key` and `providers key`, readable by you only), or the variable `LOCALPILOT_KEY_<ID>`, for example `LOCALPILOT_KEY_OPENAI`. |
| the key itself | Used as is. |

Cloud models are marked `cloud` in `localpilot models`. As in the editor, a run without `-m` uses Auto, which prefers local models: a cloud model answers when you pick it with `-m`, `/model` or as the default model.

### Deep links

`--ide`, `--settings` and `--setup` use LocalPilot's URI handler. You can call it from any tool that opens URLs:

| URI | Opens |
|---|---|
| `vscode://localpilot.localpilot-agent/run?mode=agent&prompt=…` | A chat that runs the prompt in that mode. Add `files=a.ts,b.ts` to attach files, or `parallel=1` with tasks separated by `\|` to run them as parallel agents |
| `vscode://localpilot.localpilot-agent/new?mode=ask` | A new chat (optional `mode`) |
| `vscode://localpilot.localpilot-agent/settings?section=providers` | Settings at a section |
| `vscode://localpilot.localpilot-agent/setup` | The setup wizard |
| `vscode://localpilot.localpilot-agent/terminal?run=localpilot%20--help` | The LocalPilot terminal, running a command |

VS Code decodes the query once before LocalPilot splits it on `&`, so a plain value such as `prompt=…` must not contain `&`. To pass text with `&` or `=`, add `v=2` and percent-encode each value twice (`&` becomes `%2526`); this is what the CLI sends.
