---
title: Parallel agents & change review
description: Run many agents at once, watch them in the Agents panel, and keep or undo what each one did.
permalink: /docs/parallel-agents/
---

## Every chat is an agent

Each LocalPilot session runs independently with its own context window, model and mode. Start another chat while one is still working — both stream at the same time.

## Run Tasks in Parallel

**Command Palette → LocalPilot: Run Tasks in Parallel…** (<kbd>⌘⇧⌥P</kbd>). Separate tasks with ` | `:

```
Add input validation to the login form | Write tests for utils/date.ts | Fix all TypeScript errors in src/api
```

One agent is spawned per task. The first opens in the chat view; the Agents panel tracks the rest.

## The Agents panel

Below the chat view (collapsed by default):

- **Running** — live status line (`Running grep_search…`), inline **Stop**, badge with the count.
- **Idle** — recent sessions with mode, message count and changed-file count.
- Expand a session to see the **files it changed**; click a file for a side-by-side diff.
- Inline **Keep** / **Undo** on sessions and files; **Keep All / Undo All Agent Changes** in the title menu.

## Change review

Before an agent modifies a file, LocalPilot stores the original content. From then on:

- The **files changed** bar appears above the composer: expand it, click a file for a diff, hover for per-file Keep/Undo, or use **Undo all / Keep all**.
- Changed lines are highlighted in open editors.
- Undo restores the exact pre-agent content (new files are moved to the trash).
- Keeping simply forgets the snapshot — your normal Git workflow takes over.

Changes are tracked **per session**, so reverting one agent's work never touches another's.

## Subagents inside a session

A single agent can also fan out: `run_subagent` runs one child, `run_parallel_subagents` runs several concurrently (bounded by `localpilot.parallel.maxConcurrency`). Children have fresh context windows and report back only their final message, keeping the parent's context small. See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).

## Limits

- `localpilot.parallel.maxConcurrency` (default 4) bounds concurrent tool calls and subagents per session.
- `localpilot.parallel.maxSubagentDepth` (default 2) prevents runaway nesting.
- Your model server's own concurrency (e.g. `OLLAMA_NUM_PARALLEL`) ultimately decides how many requests run truly simultaneously.
