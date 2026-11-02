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
- Commands time out after `timeout_seconds` (default 120, maximum 600).
- If the shell has no shell integration, or `localpilot.terminal.runInIntegratedTerminal` is off, the command runs in a hidden process instead. The result is the same, but you do not see it run.
- Commands started with `background: true` (dev servers, watchers) open their own terminal and are not awaited. Their output is not captured.

| Setting | Default | Purpose |
|---|---|---|
| `localpilot.terminal.runInIntegratedTerminal` | `true` | Run agent commands in the visible LocalPilot Agent terminal |
| `localpilot.terminal.reveal` | `true` | Show the terminal panel, without taking focus, when a command runs |

## Send terminal output to the chat

LocalPilot records the commands you run in any VS Code terminal that has shell integration. The last command and its output are then one click away.

| Action | How |
|---|---|
| Explain the last output | Right-click a terminal → **LocalPilot: Explain Terminal Output** |
| Fix a failed command | Right-click a terminal → **LocalPilot: Fix Failed Command**. It takes the most recent command that exited non-zero, opens an Agent chat and asks it to find the cause, fix it and re-run the command |
| Attach the output | Right-click a terminal → **LocalPilot: Add Terminal Output to Chat**, or type `@terminal` in the chat |
| Generate a shell command | <kbd>⌘⌥K</kbd> (<kbd>Ctrl+Alt+K</kbd>) in a terminal, or right-click → **LocalPilot: Generate Terminal Command…** |

## The `localpilot` CLI

`localpilot` runs the LocalPilot agent in a shell. It uses the same agent loop, tools, skills, memory, MCP servers, permission rules and change tracking as the extension. It runs under Node and talks to the same model servers you configured. For what else may go over the network (skill registry, web tools, MCP servers you add), see [Privacy]({{ '/privacy/' | relative_url }}).

![The localpilot CLI in the LocalPilot terminal: it reads the code, edits test/cart.test.js, runs npm test (3 passing), prints a summary and lists the changed file]({{ '/assets/screenshots/terminal-cli.png' | relative_url }})

### Install

- **Inside VS Code.** Run *LocalPilot: Open LocalPilot Terminal*. It is also in the chat toolbar's ⋯ menu, and in the terminal **+** dropdown as the **LocalPilot** profile. The CLI is already on `PATH` in that terminal.
- **In any shell.** Run *LocalPilot: Install 'localpilot' CLI in PATH*. It writes `~/.local/bin/localpilot` (Windows: `%USERPROFILE%\bin\localpilot.cmd`). The script finds the newest installed LocalPilot after updates. It runs with `node`, or with VS Code's own runtime when Node is not installed. If `~/.local/bin` is not on your `PATH`, the notification tells you the line to add.

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
localpilot -m ollama/qwen3:8b "…"                 # pick a model for this run
localpilot models                                 # models from every reachable server (cloud ones marked)
localpilot doctor                                 # check servers, settings, skills, MCP, ripgrep
localpilot providers add anthropic                # add Claude; asks for the key (not echoed)
localpilot -m anthropic/claude-sonnet-4-6 "…"     # run a task on a cloud model
localpilot skill install anthropics/skills/skills/pdf
localpilot skill search "write a plan" --install
```

### Subcommands

| Command | What it does |
|---|---|
| `localpilot models` | Lists models from every reachable provider. Cloud models are marked `cloud` |
| `localpilot doctor` | Checks providers (reachability and key state), settings and tools |
| `localpilot providers` | Lists providers under **Local** and **Cloud** with reachability, model count and where each key comes from. Never prints a key |
| `localpilot providers presets` | Lists what `providers add` accepts: local servers, cloud APIs and gateways |
| `localpilot providers add <preset\|url>` | Adds a provider: a preset (`openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `omniroute`…) or any OpenAI-compatible URL. Options: `--key <key>`, `--key-env VAR`, `--url <url>`, `--id <id>`, `--name <name>`, `--type ollama\|openai\|anthropic`, `--cloud` / `--no-cloud`. Checks the connection and lists the models |
| `localpilot providers key <id> [key]` | Sets a provider's API key: as an argument, typed at a hidden prompt, or piped in (`pass openai \| localpilot providers key openai`). `--key-env VAR` reads it from a variable instead; `--remove-key` deletes it |
| `localpilot providers test [id]` | Checks one provider, or all, and lists their models |
| `localpilot providers remove <id>` | Removes a provider added from the CLI, with its stored key. A provider from VS Code settings is disabled for the CLI only |
| `localpilot skill install <source> [--user]` | Installs a skill from `owner/repo[/path]`, `owner/repo@ref/path`, a GitHub URL, a `SKILL.md` URL or a folder. `--user` installs to `~/.localpilot/skills` |
| `localpilot skill search <words> [--install]` | Ranks the skill registry (`localpilot.skills.repositories`) for a query. `--install` installs the best match |
| `localpilot eval [--models a,b]` | Benchmarks models on real coding tasks; see [Benchmarking models](#benchmarking-models) |

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

### Options

| Option | Meaning |
|---|---|
| `--agent`, `--ask`, `--plan`, `--multitask`, `--debug` | Mode (default `agent`) |
| `-i`, `--isolate` | Work in an isolated git worktree. Your checkout is untouched while the agent works. A one-shot run applies the result back as uncommitted changes when it ends |
| `--no-apply` | With `--isolate`: leave the result in the worktree and print its path |
| `-m`, `--model <provider/model>` | Model for this run |
| `-f`, `--file <path>` | Attach a file; repeatable. `path#L10-L20` for a range |
| `-y`, `--yes` | Approve every command, edit and network call |
| `-C`, `--cwd <dir>` | Workspace root (default: current directory) |
| `-p`, `--print` | Print only the final answer; no tool log, non-interactive |
| `--no-mcp` | Do not start MCP servers |
| `-v`, `--verbose` | Show tool arguments and debug logs |
| `--ide` (`--vscode`) | Open the task in VS Code instead of running it in the shell |
| `--settings`, `--setup` | Open LocalPilot Settings or the setup wizard in VS Code |
| `-h`, `--help`; `-V`, `--version` | Help, version |

### Interactive session

Run `localpilot` with no task to start a session. These commands are available:

| Command | What it does |
|---|---|
| `/mode agent\|multitask\|debug\|plan\|ask` | Switch mode |
| `/model <name>`, `/models` | Switch model, list models |
| `/providers` | List providers with reachability and key state |
| `/changes`, `/undo`, `/keep` | Show, revert or accept this session's file changes |
| `/file <path>` (`/attach`) | Attach a file to the next prompt |
| `/isolate`, `/apply`, `/discard` | Move to a git worktree; bring its changes into your checkout; throw them away |
| `/commands`, `/permissions`, `/hooks` | Custom commands, permission rules, hooks (see [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }})) |
| `/clear` | Clear the conversation |
| `/doctor` | Run the checks from `localpilot doctor` |
| `/help`, `/exit` (`/quit`, `/q`) | Help, leave |
| `/<custom-command> …` | Run a custom slash command |

Run control:

- **Ctrl+C** stops the current run. Press it again to quit.
- **Ctrl+Z** pauses the run after its current step. Press it again to resume.
- Anything you type while a run is going is queued and handed to the agent at its next step.
- Subagents pause and stop with the run.

The CLI uses the same skills as the extension: recommendations, the registry (`localpilot.skills.autoInstall`) and the shared index in `~/.localpilot/skill-catalog.json`. It notes when a registry skill matches a request but is not installed yet. See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

### Approvals

Commands, file edits, deletes and network calls go through the same approval policies as the extension (`localpilot.approvals.*`) and the same `settings.json` permission rules.

- When a policy says *ask*, the CLI shows the command or diff and prompts **[y]es · [n]o · [a]lways this session**.
- `--yes` approves everything.
- Without a TTY (for example in CI), anything that needs approval is denied unless you pass `--yes`.

Edits are tracked per run. A one-shot run prints the changed files at the end. In a session, `/undo` reverts them and `/keep` accepts them.

### Settings

The CLI reads settings in this order, later sources winning:

1. VS Code's user `settings.json`
2. the workspace's `.vscode/settings.json`
3. `~/.localpilot/config.json`
4. command-line flags

A model server configured in LocalPilot Settings is therefore already known to the CLI. API keys that Settings stored in VS Code's secret storage (`${secret:<id>}`) are out of the CLI's reach: set `LOCALPILOT_KEY_<ID>` instead, the provider id in upper case with other characters as `_` (for example `LOCALPILOT_KEY_OPENAI` or `LOCALPILOT_KEY_OLLAMA_CLOUD`). Keys written as `${env:NAME}` work in both. Changes made from the CLI (such as `/model`) are saved to `~/.localpilot/config.json`, never to VS Code's settings. Logs go to `~/.localpilot/cli.log`.

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
