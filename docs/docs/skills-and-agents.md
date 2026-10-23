---
title: Skills & subagents
description: Package expertise as reusable skills and delegate work to specialised subagents.
permalink: /docs/skills-and-agents/
---

## Skills

A skill is a folder containing a `SKILL.md` with YAML front-matter and Markdown instructions — the same convention used by Claude Code and GitHub Copilot, so existing skills work unchanged.

```
.localpilot/skills/deploy-checklist/SKILL.md
```

```markdown
---
name: deploy-checklist
description: Steps to safely ship a release of this service. Use for "deploy", "release", "ship".
---
# Deploying
1. Run `npm test` and `npm run lint`.
2. Bump the version in package.json …
```

### Discovery locations (priority order)

1. `<workspace>/.localpilot/skills/*`
2. `<workspace>/.claude/skills/*`
3. `<workspace>/.github/skills/*`
4. `~/.localpilot/skills/*`, `~/.claude/skills/*`, `~/.agents/skills/*`
5. Folders listed in `localpilot.skillsPaths`

### Progressive disclosure

Only the **name and description** of each skill are placed in the system prompt. When a task matches, the model calls `load_skill` to pull in the full instructions. Dozens of skills therefore cost almost no context. Force one with `/skill <name> <task>`.

## Subagents

Subagents are Markdown files whose body becomes the system prompt:

```
.localpilot/agents/migrator.md
```

```markdown
---
name: migrator
description: Converts JavaScript files to TypeScript one at a time.
tools: read_file, write_file, edit_file, run_command, get_diagnostics
model: ollama/qwen2.5-coder:32b
---
You convert JS to idiomatic TS. Preserve behaviour, add precise types, run tsc after each file…
```

- `tools` restricts the tool set (omit for all tools).
- `model` overrides the session model — use a bigger model for hard sub-tasks, a smaller one for exploration.
- Locations: `.localpilot/agents`, `.claude/agents`, `~/.localpilot/agents`, `~/.claude/agents`.

### Built-in subagents

| Name | Purpose | Tools |
|---|---|---|
| `explore` | Read-only codebase exploration & Q&A | search/read only |
| `coder` | Implements a well-specified change end to end | all |
| `reviewer` | Bugs, security (OWASP), style — no edits | read + run_command |
| `researcher` | Web research with citations | web_search, web_fetch, read_file |

### How delegation works

The main agent calls `run_subagent` (one child) or `run_parallel_subagents` (many, concurrently). Children run with a **fresh context window**, cannot see the parent's conversation, and return only their final report — so include everything they need in the prompt. Delegate directly with `/agent <name> <task>`.

## Project rules

Rules files are injected into every system prompt automatically: `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.localpilot/rules/*.md`, `.github/copilot-instructions.md`, `.windsurfrules`. Use them for coding conventions, architecture notes and "always run X after Y" instructions. Add one-off preferences in `localpilot.systemPromptAppend`.
