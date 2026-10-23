# Parallel agents

Each chat is an independent agent with its own model, mode and change set. Start as many as you like:

- **Run Tasks in Parallel…** (`⌘⇧⌥P`) — type several tasks separated by ` | ` and each one starts immediately in its own chat.
- The **+** button in the tab strip starts another chat while the current one is still running.
- The **Agents** view lists running agents with their current step and lets you stop them or review their changes.

Inside a single chat the agent can also fan out work to **subagents** (`run_parallel_subagents`), each with a fresh context window, and merge their reports.
