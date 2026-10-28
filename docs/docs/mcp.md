---
title: MCP servers
description: Add Model Context Protocol servers to give the agent more tools. Configure them in Settings or localpilot.mcpServers.
permalink: /docs/mcp/
---

LocalPilot includes an [MCP](https://modelcontextprotocol.io) client for servers that use the **stdio** transport (a local process). Every tool a server exposes becomes an agent tool named `mcp_<server>_<tool>`. Characters other than letters, digits, `_` and `-` are replaced with `_`, and the name is cut at 64 characters.

Remote servers (HTTP or SSE, configured with a `url`) are not supported.

## Configuration

Open **Settings → MCP servers** (gear icon in the chat toolbar). There you can add, edit, disable and remove servers. Each server shows its live state: connected with its tool count, disabled, or *failed to start* with the exact error.

![MCP servers page: a connected server with 11 tools, a disabled one, and the form to add a server]({{ '/assets/screenshots/settings-mcp.png' | relative_url }})

The same configuration is stored in the `localpilot.mcpServers` setting:

```jsonc
"localpilot.mcpServers": {
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  },
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" }
  },
  "postgres": {
    "command": "uvx",
    "args": ["mcp-server-postgres", "postgresql://localhost/mydb"],
    "enabled": false
  }
}
```

| Field | Required | Purpose |
|---|---|---|
| `command` | yes | Program to launch |
| `args` | no | Arguments |
| `env` | no | Extra environment variables, added to the environment VS Code was started with |
| `cwd` | no | Working directory. Default: the first workspace folder |
| `enabled` | no | Set `false` to keep the entry without starting the server |

Avoid committing tokens in `env` to a shared workspace `settings.json`; put such servers in your user settings.

[Plugins]({{ '/docs/claude-code-compatibility/' | relative_url }}#plugins) can add servers through their `.mcp.json`. Those appear as `plugin:server`.

## Starting and reloading

- Servers start when the extension activates, and restart when `localpilot.mcpServers` changes.
- To restart them yourself, run **LocalPilot: Reload Skills, Subagents & MCP Servers**. The notification shows how many MCP tools were registered.
- The [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) starts the same servers. Pass `--no-mcp` to skip them.

## Approvals

MCP tool calls follow the `localpilot.approvals.network` policy (default `always`). Set it to `ask` to confirm each call. In a `settings.json` file you can also allow, prompt for or deny specific servers and tools with `mcp__server` or `mcp__server__tool` [permission rules]({{ '/docs/claude-code-compatibility/' | relative_url }}#permission-rules).

An MCP server is a program you choose to run, and it can contact any service it is built for. See [Privacy]({{ '/privacy/' | relative_url }}).

## Troubleshooting

Run **LocalPilot: Show Logs**. Server stderr is logged under `[mcp:<name>]`, along with start-up errors, exit codes and the tool count.
