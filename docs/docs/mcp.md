---
title: MCP servers
description: Add local or remote Model Context Protocol servers to give the agent more tools. Configure them in Settings or localpilot.mcpServers.
permalink: /docs/mcp/
---

LocalPilot includes an [MCP](https://modelcontextprotocol.io) client for local servers (a process started from a command, the **stdio** transport) and remote servers (a `url`, over **Streamable HTTP** or the older **HTTP+SSE** transport). Every tool a server exposes becomes an agent tool named `mcp_<server>_<tool>`. Characters other than letters, digits, `_` and `-` are replaced with `_`, and the name is cut at 64 characters.

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
  "deepwiki": {
    "url": "https://mcp.deepwiki.com/mcp"
  },
  "github-remote": {
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${env:GITHUB_TOKEN}" }
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
| `command` | for a local server | Program to launch |
| `args` | no | Arguments |
| `url` | for a remote server | The server's endpoint (`https://…`) |
| `type` | no | `stdio`, `http` (Streamable HTTP) or `sse` (HTTP+SSE). Inferred when omitted: a `command` is stdio, a `url` ending in `/sse` is SSE, any other `url` is Streamable HTTP |
| `headers` | no | Remote servers: headers sent with every request, typically `Authorization`. Values accept `${env:NAME}` and `${secret:NAME}` |
| `env` | no | Extra environment variables, added to the environment VS Code was started with |
| `cwd` | no | Working directory. Default: the first workspace folder |
| `enabled` | no | Set `false` to keep the entry without starting the server |

Avoid committing tokens in `env` or `headers` to a shared workspace `settings.json`: use `${env:NAME}` or `${secret:NAME}` references, or put such servers in your user settings.

### Remote servers

For a remote server without an explicit `type`, LocalPilot first speaks Streamable HTTP, the current MCP transport: it posts each request to the URL, accepts JSON or event-stream replies, and keeps the session the server assigns (`Mcp-Session-Id`). If the server refuses that with a 4xx error other than 401 or 403, LocalPilot connects again with HTTP+SSE at the same URL, as the MCP specification recommends for older servers. An authentication error is reported as it is, not retried. Each server's card in Settings shows which transport it uses.

[Plugins]({{ '/docs/claude-code-compatibility/' | relative_url }}#plugins) can add servers through their `.mcp.json`, local or remote (`{ "type": "http", "url": …, "headers": … }`, the same format as Claude Code). Those appear as `plugin:server`.

## Starting and reloading

- Servers start when the extension activates, and restart when `localpilot.mcpServers` changes.
- To restart them yourself, run **LocalPilot: Reload Skills, Subagents & MCP Servers**. The notification shows how many MCP tools were registered.
- The [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) starts the same servers. Pass `--no-mcp` to skip them.

## Approvals

In the read-only Ask and Plan modes, for read-only subagents and for the Multitask coordinator, LocalPilot offers only the MCP tools the server annotates with `readOnlyHint: true`; any other MCP tool may change files or remote state, so it is offered only in modes that can edit, such as Agent.

MCP tool calls follow the `localpilot.approvals.network` policy (default `always`). Set it to `ask` to confirm each call. In a `settings.json` file you can also allow, prompt for or deny specific servers and tools with `mcp__server` or `mcp__server__tool` [permission rules]({{ '/docs/claude-code-compatibility/' | relative_url }}#permission-rules).

An MCP server is a program you choose to run, and it can contact any service it is built for. See [Privacy]({{ '/privacy/' | relative_url }}).

## Troubleshooting

Run **LocalPilot: Show Logs**. Server stderr is logged under `[mcp:<name>]`, along with start-up errors, exit codes and the tool count.
