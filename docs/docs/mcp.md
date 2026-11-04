---
title: MCP servers
description: Add local or remote Model Context Protocol servers to give the agent more tools. Configure them in Settings or localpilot.mcpServers.
permalink: /docs/mcp/
---

LocalPilot includes an [MCP](https://modelcontextprotocol.io) client for local servers (a process started from a command, the **stdio** transport) and remote servers (a `url`, over **Streamable HTTP** or the older **HTTP+SSE** transport). Every tool a server exposes becomes an agent tool named `mcp_<server>__<tool>` (two underscores between server and tool). When a name contains characters other than letters, digits, `_` and `-`, or is longer than 64 characters, those characters become `_`, the name is cut, and it ends in an 8-character hash of the real server and tool, so two tools never share a name. Permission rules and `localpilot.disabledTools` entries written with the older `mcp_<server>_<tool>` names still match. Tools a server marks as app-only (`_meta.ui.visibility` without `"model"`) are not offered to the model.

## Results, resources and prompts

- **Images** a tool returns are shown in the chat and sent to the model when it can see images. **Embedded resources** appear as `[resource <uri> (<mime type>)]` followed by their text; **resource links** as the same line. Results are rendered as Markdown; results longer than 20 lines start collapsed. Very long results are cut like other tool output, and the model can read the rest with `read_file`.
- When a connected server offers **resources**, the agent gets an `mcp_read_resource` tool (`server`, `uri`) that reads one. It is read-only, so it also works in Plan and Ask modes, and it follows the MCP tools approval setting. Permission rules call it `ReadMcpResourceTool`, and a rule or `localpilot.disabledTools` entry naming a whole server (`mcp__<server>`) also covers reading that server's resources.
- A server's **prompts** run as slash commands: `/mcp:<server>:<prompt> args…`. Arguments are matched to the prompt's declared arguments by position or as `key=value`; extra words join the last argument, and quotes keep spaces. The messages the server returns become your turn. The prompts are listed in an **MCP** section of the `/` menu, and in `/commands` in the CLI.

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
| `type` | no | `stdio`, `http` (Streamable HTTP, also written `streamableHttp`) or `sse` (HTTP+SSE). Inferred when omitted: a `command` is stdio, a `url` ending in `/sse` is SSE, any other `url` is Streamable HTTP |
| `headers` | no | Remote servers: headers sent with every request, typically `Authorization` |
| `env` | no | Extra environment variables, added to the environment VS Code was started with |
| `cwd` | no | Working directory. Default: the first workspace folder |
| `enabled` | no | Set `false` to keep the entry without starting the server (`"disabled": true` also works). Turning a server off or on from Settings or the chat writes `"disabled"` into its file and keeps the file's comments and layout |
| `timeout` | no | Seconds a request to the server (a tool call, a listing) may take before it fails: 1 to 3600, default 60 |
| `autoApprove` | no | Tool names (as the server names them) that run without asking, even when `localpilot.approvals.mcp` is `ask`; not when it is `never`, your organization's policy sets an MCP approval, or a permission rule or hook asks for that tool |

`command`, `args`, `env` values, `cwd`, `url` and `headers` accept `${env:NAME}`, `${secret:NAME}` and Claude-style `${NAME}` or `${NAME:-default}`. A reference that resolves to nothing is left as written, and the log gets one warning for that server. Settings always show the references, never the values.

Avoid committing tokens in `env` or `headers` to a shared workspace `settings.json`: use `${env:NAME}` references, or put such servers in your user settings. A `${secret:NAME}` reference also resolves from a `LOCALPILOT_KEY_<NAME>` environment variable, and the CLI reads it from `~/.localpilot/keys.json`, but VS Code cannot store MCP header secrets in the keychain yet.

### Server files (`.mcp.json`)

LocalPilot also reads servers from files in the `{ "mcpServers": { "name": { … } } }` format that Claude Code and Cline use. When the same name appears in several places, the first one in this list wins:

1. the `localpilot.mcpServers` setting;
2. `<workspace>/.mcp.json`;
3. `~/.localpilot/mcp.json`, or the file named by `LOCALPILOT_MCP_SETTINGS_PATH`;
4. plugin `.mcp.json` files.

Besides the fields above, these files accept Cline's and Claude Code's spellings: `transportType` or a nested `transport: { "type": … }` instead of `type`, `disabled`, and `alwaysAllow` for `autoApprove`. A relative `cwd` is resolved against the file's folder.

From a terminal, `localpilot mcp add <name> -- <command> [args…]` (or `localpilot mcp add <name> <url>`) writes a server to `~/.localpilot/mcp.json`, or to `./.mcp.json` with `--scope project`. `localpilot mcp list`, `remove`, `enable` and `disable` manage them, and `localpilot mcp` alone opens a menu. The file is written through a temporary file and a rename. A file with comments is not rewritten, so its comments are not lost; edit that one by hand. See the [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) page for the flags.

A workspace's `.mcp.json` runs commands from the repository, so LocalPilot asks once before starting its servers ("This workspace defines MCP servers … Start them?"). The answer is remembered for that workspace. If a server's command, arguments, environment, URL, headers or `autoApprove` list change, you are asked again for that server. If you choose **Not now**, the servers stay stopped until you reload the window. The CLI asks in the terminal and remembers the answer in `~/.localpilot/mcp-trust.json`. Only a typed `y` starts them: `-y` does not answer this question. With `--trust-workspace` it starts them without asking, and with no terminal to ask in it leaves them stopped.

A file with errors shows a notification that lists the problem in each server, with an **Open file** button. The servers that are valid still start.

### Remote servers

For a remote server without an explicit `type`, LocalPilot first speaks Streamable HTTP, the current MCP transport: it posts each request to the URL, accepts JSON or event-stream replies, and keeps the session the server assigns (`Mcp-Session-Id`). If the server refuses that with a 4xx error other than 401 or 403, LocalPilot connects again with HTTP+SSE at the same URL, as the MCP specification recommends for older servers. An authentication error is reported as it is, not retried. Each server's card in Settings shows which transport it uses.

After the handshake LocalPilot also opens the server's standalone event stream (a `GET` with `Accept: text/event-stream` and the session id), on which a server sends notifications nobody asked for. A server without one answers 404 or 405, which is fine. A stream that drops is reopened with a growing delay, up to 30 seconds.

[Plugins]({{ '/docs/claude-code-compatibility/' | relative_url }}#plugins) can add servers through their `.mcp.json`, local or remote (`{ "type": "http", "url": …, "headers": … }`, the same format as Claude Code). Those appear as `plugin:server`.

## Starting and reloading

- Servers start when the extension activates. When `localpilot.mcpServers` or an `mcp.json` file changes, only the servers whose connection settings changed are stopped, started or restarted. A new `timeout` or `autoApprove` applies without a restart.
- A server that announces new or removed tools (`notifications/tools/list_changed`) has its tools listed again 300 ms after the last announcement. Only that server's tools are registered again; the others are left alone. Changed resource and prompt lists are fetched again the same way.
- Log messages a server sends (`notifications/message`) appear in the LocalPilot log under `[mcp:<name>]`, at the matching level.
- A request that runs longer than the server's `timeout` fails with `MCP request to "<server>" timed out after Ns. Raise "timeout" for this server in <file>.` The server form in **Settings → MCP** has a **Timeout** list (30 s to 1 hour).
- To restart them yourself, run **LocalPilot: Reload Skills, Subagents & MCP Servers**. The notification shows how many MCP tools were registered.
- **Settings → MCP** shows every server, including those from `.mcp.json` files and plugins, with a status dot (yellow while connecting or restarting), a **Restart** button and, when a server fails, its error with **Retry**. Expand a connected server to see its **Tools** (parameters, with required ones marked `*`), **Resources** (URI, name and MIME type, plus templates) and **Prompts** (name and arguments).
- The server button in the chat composer opens a list of servers with a switch to turn each on or off (written where the server is defined: the setting or its `.mcp.json` / `mcp.json` file), a status dot, a restart button and a link to **Settings → MCP**. It shows how many MCP tools are offered to the model, since each one adds to the prompt.
- The [CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) starts the same servers. Pass `--no-mcp` to skip them.

## Approvals

In the read-only Ask and Plan modes, for read-only subagents and for the Multitask coordinator, LocalPilot offers only the MCP tools the server annotates with `readOnlyHint: true`; any other MCP tool may change files or remote state, so it is offered only in modes that can edit, such as Agent.

MCP tool calls have their own approval setting, `localpilot.approvals.mcp` (default `always`), shown as **MCP tools** under **Settings → Agent & approvals**, apart from **Network** (web and browser tools). Set it to `ask` to confirm each call; the tools in a server's `autoApprove` list still run without asking, unless a `permissions.ask` rule (yours or your organization's) or a PreToolUse hook asks for them. `never` blocks every MCP tool. An organization policy that sets a `network` approval floor and no `mcp` floor applies it to MCP tools too. In a `settings.json` file you can also allow, prompt for or deny specific servers and tools with `mcp__server` or `mcp__server__tool` [permission rules]({{ '/docs/claude-code-compatibility/' | relative_url }}#permission-rules).

An MCP server is a program you choose to run, and it can contact any service it is built for. See [Privacy]({{ '/privacy/' | relative_url }}).

## Troubleshooting

Run **LocalPilot: Show Logs**. Server stderr is logged under `[mcp:<name>]`, along with start-up errors, exit codes and the tool count.
