---
title: Claude Code compatibility
description: LocalPilot reads Claude Code's settings.json permission rules, hooks, slash commands, CLAUDE.md files and plugins from .claude/ and .localpilot/.
permalink: /docs/claude-code-compatibility/
---

LocalPilot reads the project configuration that Claude Code uses. A repository already set up for Claude Code works without changes. A LocalPilot-only project can use the same files under `.localpilot/` instead of `.claude/`.

## What is read

| Claude Code file | LocalPilot equivalent | Used for |
|---|---|---|
| `.claude/settings.json`, `.claude/settings.local.json`, `~/.claude/settings.json` | `.localpilot/settings.json`, `.localpilot/settings.local.json`, `~/.localpilot/settings.json` | [Permission rules](#permission-rules), [hooks](#hooks), `env`, `enabledPlugins`, `model` |
| `.claude/commands/*.md`, `~/.claude/commands` | `.localpilot/commands`, `~/.localpilot/commands` | [Custom slash commands](#custom-slash-commands) |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.claude/rules/*` | `.localpilot/rules.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md` and others | [Project instructions](#claudemd-and-instruction-files), with `@imports` |
| `.claude/agents/*.md`, `~/.claude/agents` | `.localpilot/agents`, `~/.localpilot/agents` | [Subagents]({{ '/docs/skills-and-agents/' | relative_url }}#subagents) |
| `.claude/skills/*/SKILL.md`, `~/.claude/skills` | `.localpilot/skills`, `.github/skills`, `~/.localpilot/skills` | [Skills]({{ '/docs/skills-and-agents/' | relative_url }}) |
| `.claude/plugins`, `~/.claude/plugins` | `.localpilot/plugins`, `~/.localpilot/plugins`, `localpilot.pluginPaths` | [Plugins](#plugins) |

Useful chat commands:

| Command | Shows |
|---|---|
| `/permissions` | The merged permission rules and which files they came from |
| `/hooks` | Configured hooks per event |
| `/commands` | Custom slash commands |
| `/memory` | Instruction files in force, in prompt order (chat only) |

The [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) supports `/permissions`, `/hooks` and `/commands` too.

## Permission rules

Permission rules let a project pre-approve, always prompt for, or block specific tool calls.

```jsonc
// .localpilot/settings.json (or .claude/settings.json)
{
  "permissions": {
    "allow": ["Bash(npm run test:*)", "Bash(git status)", "Edit(src/**)", "WebFetch(domain:github.com)", "mcp__github"],
    "ask":   ["Bash(git push:*)"],
    "deny":  ["Read(.env)", "Read(secrets/**)", "Bash(rm -rf:*)", "Bash(curl:*)"],
    "defaultMode": "default"
  }
}
```

### Rule syntax

A rule is `Tool` or `Tool(specifier)`, using Claude Code's tool names.

| Rule | Matches |
|---|---|
| `Bash(npm run build)` | Exactly that command |
| `Bash(npm run test:*)` | Commands starting with `npm run test` |
| `Bash(git * --force)` | `*` is a wildcard anywhere |
| `Edit(src/**)`, `Write(…)`, `Read(…)` | File paths, gitignore style (see below) |
| `WebFetch(domain:github.com)` | That host and its subdomains, for `web_fetch` and the browser tools (`open_browser`, `browser_screenshot`, `browser_inspect`) |
| `WebSearch(…)` | `web_search`, matched against the query text |
| `mcp__github`, `mcp__github__create_issue` | Every tool of an MCP server, or one tool |
| `Task(agent)`, `Skill(name)` | Subagent runs, skill loads |
| `run_command(git *)`, `read_file` | Any LocalPilot tool name, used directly |

**Chained shell commands.** A command such as `a && b | c` is allowed only if every part is allowed. It is denied if any part is denied.

**Path patterns** for `Edit`, `Write` and `Read`:

| Pattern | Meaning |
|---|---|
| `src/**` | Everything under `src` |
| `docs` | A folder covers its contents |
| `.env` | A bare name matches at any depth |
| `~/.zshrc` | Relative to your home folder |
| `//etc/**` | Absolute path |
| `/docs/**` | Relative to the project root |

`Read` also governs the search and listing tools. `Edit` also governs writes, directory creation and deletes.

### How rules are evaluated

Rules are checked in this order: **deny**, then **ask**, then **allow**. The first match wins.

| Result | Effect |
|---|---|
| `deny` | The call is refused. The model is told why and not to retry |
| `ask` | You are always prompted |
| `allow` | The call runs without an approval prompt, whatever the `localpilot.approvals.*` settings say |
| no match | `permissions.defaultMode` decides (below); otherwise the normal approval settings apply |

| `defaultMode` | Effect when no rule matches |
|---|---|
| `default`, `plan` | No change; the approval settings decide |
| `acceptEdits` | File edits are approved |
| `bypassPermissions` | Everything is approved |
| `dontAsk` | Anything that would have prompted is refused |

### How settings files merge

Files are merged from lowest to highest priority:

1. `~/.claude/settings.json`
2. `~/.localpilot/settings.json`
3. `.claude/settings.json`
4. `.localpilot/settings.json`
5. `.claude/settings.local.json`
6. `.localpilot/settings.local.json`

Lists are concatenated, so a project can deny what a plugin or your user file allows. For single values, a later file wins, so `.localpilot` files override their `.claude` counterparts.

## Hooks

Hooks are shell commands that run on agent events. They can block a tool call, rewrite its input, add context for the model or keep the agent working.

Hooks run arbitrary commands. Before you open a repository you do not trust, set `localpilot.hooks.enabled` to `false` (default `true`) to ignore all hooks. The switch is also in **Settings → Agent & approvals → Hooks**.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check-command.sh", "timeout": 10 }] },
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "python3 .claude/hooks/security-guidance.py" }] }
    ],
    "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "echo \"Today is $(date +%F); branch $(git branch --show-current)\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "./scripts/stop-gate.sh" }] }]
  }
}
```

### Events

| Event | Fires | `matcher` is compared with |
|---|---|---|
| `PreToolUse` | Before a tool call | Tool name |
| `PostToolUse` | After a tool call | Tool name |
| `UserPromptSubmit` | When you send a prompt | (none) |
| `Stop` | When the agent is about to finish | (none) |
| `SubagentStop` | When a subagent is about to finish | (none) |
| `SessionStart` | When a session starts | `startup` |
| `SessionEnd` | When a session ends | `clear` (*Clear conversation* or `/clear`), `prompt_input_exit` (CLI REPL exits), `other` (chat deleted, or a one-shot CLI run finished) |
| `PreCompact` | Before automatic compaction | `auto` |
| `Notification` | When a permission prompt appears | `permission_prompt` |

`matcher` is a regular expression. For tool events it matches both Claude's names (`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `Task`, `mcp__server__tool`) and LocalPilot's (`run_command`, `edit_file`, …). An empty matcher or `*` matches everything.

### Input

Each hook runs through the shell in the project folder. It receives the event as JSON on stdin:

```json
{ "hook_event_name": "PreToolUse", "session_id": "…", "cwd": "/path/to/project",
  "tool_name": "Bash", "tool_input": { "command": "npm test" }, "localpilot_tool_name": "run_command" }
```

- `tool_input` carries Claude's field names (`command`, `file_path`, `old_string`, `new_string`, `content`) alongside LocalPilot's.
- `PostToolUse` adds `tool_response: { content, is_error }`.
- `UserPromptSubmit` adds `prompt`.
- `Stop` and `SubagentStop` add `stop_hook_active` and `last_assistant_message`.

Environment variables: `CLAUDE_PROJECT_DIR`, `LOCALPILOT_PROJECT_DIR`, everything in the settings file's `env`, and `CLAUDE_PLUGIN_ROOT` for plugin hooks.

### Output

The hook answers with its exit code and stdout.

| Exit code | Meaning |
|---|---|
| `0` | Success. JSON on stdout is honoured (see below). Plain stdout is added as context for `UserPromptSubmit` and `SessionStart`, and shown as a notice for other events |
| `2` | Block. stderr is the reason. `PreToolUse`: the tool does not run and the model sees why. `UserPromptSubmit`: the prompt is dropped and the reason shown. `Stop` / `SubagentStop`: the agent is sent back to work with the reason |
| anything else | Non-blocking failure. stderr is logged and shown as a notice |

JSON fields read on exit 0:

| Field | Effect |
|---|---|
| `decision: "block"` + `reason` | Blocks the tool call, prompt or stop, with that reason |
| `continue: false` + `stopReason` | Stops the run |
| `systemMessage` | Shown to you |
| `hookSpecificOutput.permissionDecision` | `allow` skips the approval prompt, `ask` forces it, `deny` blocks |
| `hookSpecificOutput.updatedInput` | Replaces the tool arguments |
| `hookSpecificOutput.additionalContext` | Passed to the model |

A `Stop` hook can send the agent back at most five times per turn. Check `stop_hook_active` in your script to avoid loops.

Hooks for the same event run in parallel. The default timeout is 60 seconds; set `timeout` (in seconds) per hook to change it.

## Custom slash commands

A custom command is a Markdown file whose body becomes the prompt.

```markdown
<!-- .claude/commands/fix-issue.md -->
---
description: Fix a GitHub issue end to end
argument-hint: [issue-number]
allowed-tools: Bash(gh issue view:*), Bash(git checkout:*), Bash(npm test:*)
model: ollama/qwen3-coder:30b
---
Fix issue #$1 following our coding standards.

Issue: !`gh issue view $1`
Guidelines: @docs/CONTRIBUTING.md

Create a branch, implement the fix, run `npm test`, and summarise what changed.
```

Typing `/fix-issue 123` sends the expanded body. The transcript shows what you typed.

### Placeholders

| Syntax | Replaced with |
|---|---|
| `$ARGUMENTS` | Everything after the command name |
| `$1` … `$9` | Individual words (quotes group words) |
| `` !`cmd` `` | The command's output, only when `allowed-tools` permits it (`Bash(gh issue view:*)` above). Otherwise it is skipped with a note |
| `@path` | The file's contents, or a folder listing, from the workspace |

### Front matter

| Key | Effect |
|---|---|
| `description` | Shown in autocomplete, `/help` and `/commands` |
| `argument-hint` | Shown next to the command in autocomplete |
| `allowed-tools` | Extra **allow** rules while that turn runs |
| `model` | Model for that turn |
| `disable-model-invocation` | Accepted and ignored (see [differences](#differences-from-claude-code)) |

### Names and precedence

- Subfolders become namespaces: `.claude/commands/frontend/component.md` is `/frontend:component`, and also `/component` while no other command uses that name.
- Plugin commands are `/plugin-name:command`.
- Project commands win over user commands (`~/.claude/commands`, `~/.localpilot/commands`).

Custom commands appear in the composer's `/` autocomplete, in `/help` and in `/commands`. The CLI runs them as well: `localpilot "/fix-issue 123"`, or `/fix-issue 123` in the REPL.

## CLAUDE.md and instruction files

Instruction files are joined into the system prompt in this order:

| Order | Scope | Files |
|---|---|---|
| 1 | User (every project) | `~/.claude/CLAUDE.md`, `~/.localpilot/CLAUDE.md`, `~/.localpilot/rules.md` |
| 2 | Ancestors (monorepo roots), farthest first | `CLAUDE.md`, `.claude/CLAUDE.md`, `.localpilot/rules.md` in each folder above the workspace, stopping at your home folder |
| 3 | Project | `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, then every `.md` / `.mdc` in `.cursor/rules`, `.localpilot/rules`, `.claude/rules` |
| 4 | Local (personal; add to `.gitignore`) | `CLAUDE.local.md`, `.localpilot/rules.local.md` |

**Imports.** `@path` imports another file into the one that mentions it: `@README`, `@docs/style.md`, `@~/.claude/my-instructions.md`.

- Paths are relative to the importing file.
- Imports are recursive, up to five levels.
- `@` inside code blocks and inline code is not expanded. Email addresses are left alone.
- Each imported file is cut at 20,000 characters.

**Size limit.** The combined instructions are cut at 12,000 characters, so keep the important rules near the top of the first files.

Front matter in rule files (for example `.mdc`) is treated as metadata and removed. `/memory` lists the files currently in force.

## Plugins

A plugin bundles commands, subagents, skills, hooks and MCP servers in one folder.

```
my-plugin/
├── .claude-plugin/plugin.json   { "name": "my-plugin", "description": "…", "version": "1.0.0" }
├── commands/*.md                → /my-plugin:name
├── agents/*.md                  → subagents
├── skills/<name>/SKILL.md       → skills
├── hooks/hooks.json             → { "hooks": { "PreToolUse": [ … ] } }; ${CLAUDE_PLUGIN_ROOT} = the plugin folder
└── .mcp.json                    → { "mcpServers": { "name": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } }
```

Plugins are found in:

- `.claude/plugins` and `.localpilot/plugins` in the workspace
- `~/.claude/plugins`, including marketplace checkouts and `marketplace.json` listings
- `~/.localpilot/plugins`
- folders in `localpilot.pluginPaths`
- the workspace itself, when it has a manifest (useful while writing a plugin)

Details:

- The manifest may point `commands`, `agents`, `skills`, `hooks` and `mcpServers` at other paths, or inline the hooks and servers.
- Plugin hooks rank below every settings file, so a project can override them.
- Plugin MCP servers appear as `plugin:server`. Only stdio servers (with a `command`) are supported; servers with only a `url` are skipped.
- To disable a plugin, add `"enabledPlugins": { "my-plugin": false }` (or `"my-plugin@marketplace": false`) to a `settings.json`.

## Differences from Claude Code

- **No `SlashCommand` tool.** You run custom commands; the model cannot invoke them. `disable-model-invocation` is accepted and ignored.
- **No remote MCP servers in plugins.** Only stdio servers are started.
- **No `transcript_path`** in hook input.
- **`SessionEnd` does not fire when the VS Code window closes.** It fires on clear, chat delete and CLI exit only.
- **Modes still apply.** Permission rules decide the approval prompt, but Ask and Plan mode never edit files, whatever the rules say.
