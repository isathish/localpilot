---
title: Zed, JetBrains & Neovim (ACP)
description: Use the LocalPilot agent from Zed, JetBrains IDEs and Neovim through the Agent Client Protocol, with your local models.
permalink: /docs/acp/
keywords: agent client protocol, ACP agent, Zed external agent, JetBrains ACP, Neovim AI agent, avante acp, local AI agent Zed
---

`localpilot --acp` runs the LocalPilot agent as an [Agent Client Protocol](https://agentclientprotocol.com) server: JSON-RPC over stdin and stdout, one message per line. Editors that speak ACP start it as a subprocess and show the conversation, tool calls, plans and approval prompts in their own UI. The agent is the same one as in VS Code and the terminal: same tools, skills, rules, memory, MCP servers and providers.

You need the `localpilot` command on your PATH (**LocalPilot: Install 'localpilot' CLI in PATH** in VS Code). Settings come from the same places as for the CLI (see [Terminal & CLI](terminal-and-cli.md#settings)).

## Zed

Add an agent server to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "LocalPilot": {
      "command": "localpilot",
      "args": ["--acp"]
    }
  }
}
```

Open the Agent Panel and start a new **LocalPilot** thread. Use the full path (for example `/Users/you/.local/bin/localpilot`) if Zed does not see your shell's PATH.

## JetBrains IDEs

In IDEs with ACP support in the AI Assistant, add the agent to `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "LocalPilot": {
      "command": "/Users/you/.local/bin/localpilot",
      "args": ["--acp"]
    }
  }
}
```

LocalPilot then appears in the AI chat's agent picker.

## Neovim

Plugins that drive ACP agents take the same command. With avante.nvim:

```lua
require('avante').setup({
  provider = 'localpilot',
  acp_providers = {
    localpilot = { command = 'localpilot', args = { '--acp' } },
  },
})
```

CodeCompanion.nvim and other ACP clients work the same way: point them at `localpilot --acp`.

## What the editor gets

- **Sessions.** Each new thread is a LocalPilot session saved for its folder, like a CLI session: `localpilot -r` and VS Code's history (marked **CLI**) list it, and the editor can reopen it (`session/load` replays the conversation).
- **Streaming.** The answer, the model's reasoning, each tool call with its status and output, and the agent's checklist (as the plan) stream into the editor.
- **Approvals.** Nothing is approved automatically: every file edit, command, network call or MCP tool call becomes a permission prompt with **Allow**, **Always allow … in this session** and **Reject**. "Always" never covers deletes, and your organization's policy still applies. In this mode `approvals.*` settings of `always` or `safe` count as `ask` (a kind set to `never` stays refused), and auto mode's reviewer model is off. Start with `localpilot --acp --yes` only if you want every action approved.
- **Mode and model.** The editor's mode picker offers Agent, Multitask, Debug, Plan and Ask; the model picker lists the models of your providers. Both are also offered as session config options.
- **Context.** Text, files the editor embeds, file links and images are passed to the agent.
- **Cancel.** Stopping in the editor stops the run, as Ctrl+C does in the terminal.

The usual CLI options apply: `-C <dir>` for the default folder, `-m <provider/model>`, `--no-mcp`, `--trust-workspace`, `--data-dir`. Logs go to stderr and to the CLI log file (`localpilot doctor log`); stdout carries protocol messages only.
