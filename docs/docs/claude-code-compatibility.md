---
title: Claude Code compatibility
description: settings.json permission rules, hooks, custom slash commands, hierarchical CLAUDE.md and plugins — read from .claude/ and .localpilot/ alike.
permalink: /docs/claude-code-compatibility/
---

LocalPilot reads the project configuration Claude Code uses, from both the `.claude/` and the `.localpilot/` folders (and `~/.claude/`, `~/.localpilot/`). A repository already set up for Claude Code works unchanged; a LocalPilot-only project can use the `.localpilot/` names. Where both exist, `.localpilot` takes precedence.

| Claude Code | Also read as | What it does |
|---|---|---|
| `.claude/settings.json`, `settings.local.json`, `~/.claude/settings.json` | `.localpilot/settings.json` … | Permission rules, hooks, `env`, `enabledPlugins`, `model` |
| `.claude/commands/*.md`, `~/.claude/commands` | `.localpilot/commands` | Custom slash commands |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.claude/rules/*` | `.localpilot/rules.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md` | Project instructions, with `@imports` |
| `.claude/agents/*.md` | `.localpilot/agents` | Subagents |
| `.claude/skills/*/SKILL.md`, `~/.claude/skills` | `.localpilot/skills`, `.github/skills` | Skills |
| `.claude/plugins`, `~/.claude/plugins` | `.localpilot/plugins`, `localpilot.pluginPaths` | Plugins |

## Permission rules

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

A rule is `Tool` or `Tool(specifier)`, using Claude Code's tool names:

- **`Bash(cmd)`** — `Bash(npm run build)` matches that exact command; `Bash(npm run test:*)` matches the prefix; `*` is a wildcard anywhere. A chained command (`a && b | c`) is **allowed only if every part is allowed**, and **denied if any part is**.
- **`Edit(pattern)` / `Write(pattern)` / `Read(pattern)`** — gitignore-style paths: `src/**`, `docs` (a folder covers its contents), `.env` (a bare name matches at any depth), `~/.zshrc` (home), `//etc/**` (absolute), `/docs/**` (project root). `Read` also governs the search and listing tools; `Edit` also governs writes, directory creation and deletes.
- **`WebFetch(domain:host)`** — the host and its subdomains (also covers `web_search` by query text with a plain specifier, and the browser tools).
- **`mcp__server`** / **`mcp__server__tool`** — every tool of an MCP server, or one of them.
- **`Task(agent)`**, **`Skill(name)`**, or any LocalPilot tool name directly (`run_command(git *)`, `read_file`).

Evaluation: **deny → ask → allow**. A matching `allow` runs the call **without the approval prompt** regardless of the `localpilot.approvals.*` settings; `ask` always prompts; `deny` returns a refusal to the model (it is told not to retry). When no rule matches, `permissions.defaultMode` applies — `acceptEdits` approves file edits, `bypassPermissions` approves everything, `dontAsk` refuses whatever would have prompted — and otherwise the normal approval settings decide. `/permissions` in the chat (or the CLI) shows the merged rules and where they came from.

Settings files are merged lowest-to-highest: `~/.claude/settings.json` → `~/.localpilot/settings.json` → `.claude/settings.json` → `.localpilot/settings.json` → `.claude/settings.local.json` → `.localpilot/settings.local.json`. Lists are concatenated, so a project can deny what a plugin or the user's file allows.

## Hooks

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

Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart` (matcher `startup`), `PreCompact` (matcher `auto`), `Notification` (matcher `permission_prompt`). `matcher` is a regular expression on the tool name — Claude's names (`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebFetch`, `Task`, `mcp__server__tool`) **and** LocalPilot's (`run_command`, `edit_file`, …) both match; empty or `*` matches everything.

Each hook runs through the shell in the project folder with the event as JSON on **stdin**:

```json
{ "hook_event_name": "PreToolUse", "session_id": "…", "cwd": "/path/to/project",
  "tool_name": "Bash", "tool_input": { "command": "npm test" }, "localpilot_tool_name": "run_command" }
```

`tool_input` carries Claude's field names (`command`, `file_path`, `old_string`, `new_string`, `content`) next to ours. `PostToolUse` adds `tool_response: { content, is_error }`; `UserPromptSubmit` adds `prompt`; `Stop` / `SubagentStop` add `stop_hook_active` and `last_assistant_message`. The environment has `CLAUDE_PROJECT_DIR`, `LOCALPILOT_PROJECT_DIR`, `settings.env` and, for plugin hooks, `CLAUDE_PLUGIN_ROOT`.

The hook answers with its **exit code** and **stdout**:

- **exit 0** — success. If stdout is JSON it is honoured: `decision: "block"` + `reason` (blocks a tool / prompt / stop with that reason), `continue: false` + `stopReason`, `systemMessage` (shown to you), `hookSpecificOutput.permissionDecision` (`allow` skips the approval prompt, `ask` forces it, `deny` blocks), `hookSpecificOutput.updatedInput` (rewrites the tool arguments), `hookSpecificOutput.additionalContext` (handed to the model). Plain stdout is added as context for `UserPromptSubmit` and `SessionStart`, and shown as a notice for the other events.
- **exit 2** — block. stderr is the reason: for `PreToolUse` the tool does not run and the model sees why; for `UserPromptSubmit` the prompt is dropped and the reason shown; for `Stop` / `SubagentStop` the agent is sent back to work with the reason (at most five times per turn — check `stop_hook_active` in your script to avoid loops).
- **any other exit code** — a non-blocking failure; stderr is logged and shown as a notice.

Hooks for the same event run in parallel; the default timeout is 60 s. `/hooks` lists what is configured. `localpilot.hooks.enabled: false` ignores hooks altogether — use it before opening a repository you do not trust, since hooks are arbitrary commands.

## Custom slash commands

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

`/fix-issue 123` sends the expanded body as the prompt: `$ARGUMENTS` is everything after the command, `$1`…`$9` the individual words (quotes group), `` !`cmd` `` is replaced by the command's output — **only when `allowed-tools` permits it** (`Bash(gh issue view:*)` above), otherwise it is skipped with a note — and `@path` inlines a file or folder listing from the workspace. `allowed-tools` also acts as extra **allow** rules while that turn runs, and `model` picks the model for it. The transcript shows what you typed.

Files in subfolders are namespaced: `.claude/commands/frontend/component.md` is `/frontend:component` (and `/component` while nothing else claims that name); plugin commands are `/plugin-name:command`. Project commands win over user ones (`~/.claude/commands`, `~/.localpilot/commands`). Custom commands appear in the composer's `/` autocomplete with their `argument-hint`, in `/help` and `/commands`, and the CLI runs them as well: `localpilot "/fix-issue 123"` or `/fix-issue 123` in the REPL.

## CLAUDE.md and instruction files

Instruction files are concatenated into the system prompt in this order:

1. **User** — `~/.claude/CLAUDE.md`, `~/.localpilot/CLAUDE.md`, `~/.localpilot/rules.md` (every project).
2. **Ancestors** — `CLAUDE.md`, `.claude/CLAUDE.md`, `.localpilot/rules.md` in the folders above the workspace (monorepo roots), farthest first.
3. **Project** — `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.windsurfrules`, then every `.md`/`.mdc` in `.cursor/rules`, `.localpilot/rules`, `.claude/rules`.
4. **Local** — `CLAUDE.local.md`, `.localpilot/rules.local.md` (personal notes; add them to `.gitignore`).

`@path` imports another file into the one that mentions it — `@README`, `@docs/style.md`, `@~/.claude/my-instructions.md` — relative to the importing file, recursively up to five levels; code blocks and inline code are not expanded, and email addresses are left alone. `/memory` lists the files currently in force.

## Plugins

```
my-plugin/
├── .claude-plugin/plugin.json   { "name": "my-plugin", "description": "…", "version": "1.0.0" }
├── commands/*.md                → /my-plugin:name
├── agents/*.md                  → subagents
├── skills/<name>/SKILL.md       → skills
├── hooks/hooks.json             → { "hooks": { "PreToolUse": [ … ] } }; ${CLAUDE_PLUGIN_ROOT} = the plugin folder
└── .mcp.json                    → { "mcpServers": { "name": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"] } } }
```

Plugins are found in `.claude/plugins`, `.localpilot/plugins`, `~/.claude/plugins` (including marketplace checkouts and `marketplace.json` listings), `~/.localpilot/plugins`, the folders in `localpilot.pluginPaths`, and the workspace itself when it has a manifest (handy while writing one). The manifest may point `commands`, `agents`, `skills`, `hooks` and `mcpServers` at other paths or inline the hooks / servers. A plugin's hooks sit **below** every settings file, so a project can override them; its MCP servers appear as `plugin:server`. Disable one with `"enabledPlugins": { "my-plugin": false }` (or `"my-plugin@marketplace": false`) in `settings.json`.

## Differences from Claude Code

- There is no `SlashCommand` tool yet: custom commands are run by you, not invoked by the model (`disable-model-invocation` is accepted and ignored).
- `SessionEnd` hooks and remote (`url`) MCP servers in plugins are not supported; `transcript_path` is not provided to hooks.
- Permission rules decide the **approval prompt**; the mode still rules: Ask and Plan mode never edit, whatever the rules say.
