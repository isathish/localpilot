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
localpilot models                                 # models from every reachable server
localpilot doctor                                 # check servers, settings, skills, MCP, ripgrep
localpilot skill install anthropics/skills/skills/pdf
localpilot skill search "write a plan" --install
```

### Subcommands

| Command | What it does |
|---|---|
| `localpilot models` | Lists models from your local servers |
| `localpilot doctor` | Checks servers, settings and tools |
| `localpilot skill install <source> [--user]` | Installs a skill from `owner/repo[/path]`, `owner/repo@ref/path`, a GitHub URL, a `SKILL.md` URL or a folder. `--user` installs to `~/.localpilot/skills` |
| `localpilot skill search <words> [--install]` | Ranks the skill registry (`localpilot.skills.repositories`) for a query. `--install` installs the best match |

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

A model server configured in LocalPilot Settings is therefore already known to the CLI. Changes made from the CLI (such as `/model`) are saved to `~/.localpilot/config.json`, never to VS Code's settings. Logs go to `~/.localpilot/cli.log`.

`~/.localpilot/config.json` uses the same keys without the `localpilot.` prefix:

```json
{
  "providers": [{ "id": "ollama", "type": "ollama", "baseUrl": "http://localhost:11434" }],
  "defaultModel": "ollama/qwen2.5-coder:7b",
  "approvals": { "terminal": "ask", "write": "always" }
}
```

### Deep links

`--ide`, `--settings` and `--setup` use LocalPilot's URI handler. You can call it from any tool that opens URLs:

| URI | Opens |
|---|---|
| `vscode://localpilot.localpilot-agent/run?mode=agent&prompt=…` | A chat that runs the prompt in that mode. Add `files=a.ts,b.ts` to attach files, or `parallel=1` with tasks separated by `\|` to run them as parallel agents |
| `vscode://localpilot.localpilot-agent/new?mode=ask` | A new chat (optional `mode`) |
| `vscode://localpilot.localpilot-agent/settings?section=providers` | Settings at a section |
| `vscode://localpilot.localpilot-agent/setup` | The setup wizard |
| `vscode://localpilot.localpilot-agent/terminal?run=localpilot%20--help` | The LocalPilot terminal, running a command |
