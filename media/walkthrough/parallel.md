# Parallel agents

Each chat is an independent agent with its own model, mode and change set. Start as many as you like:

- **Run Tasks in Parallel…** (`⌘⇧⌥P`) — type several tasks separated by ` | ` and each one starts immediately in its own chat.
- The **+** button in the tab strip starts another chat while the current one is still running.
- The **Agents** view lists running agents with their current step and lets you stop them or review their changes.

Inside a single chat the agent can also fan out work to **subagents** (`run_parallel_subagents`), each with a fresh context window, and merge their reports.

## Best of N

**Best of N: Run One Task on Several Models…** gives the same task to several models at once. Compare the results side by side and keep the one you like.

## Isolated worktrees

Agents running side by side in a Git repository each work in their own **worktree**, so their edits never collide with each other or with yours. When an agent finishes, its entry in the **Agents** view offers **Apply Agent's Changes to Workspace** (they land as ordinary uncommitted edits), or **Discard Agent's Isolated Changes** to throw them away.

## Task queue

**Queue Agent Task…** lines up work to run one after another, for example overnight. The queue appears in the **Agents** view, where you can pause, resume, cancel or retry a task.
