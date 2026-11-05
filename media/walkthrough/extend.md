# Skills, MCP servers and plugins

**Skills** teach the agent how your team works. A skill is a folder with a `SKILL.md` file: a short description the agent reads up front, and instructions it loads only when the task matches. LocalPilot scans `.localpilot/skills`, `.claude/skills`, `.github/skills` and `~/.agents/skills`, and ships built-in skills for requirements, design, implementation, tests, debugging and review. Run one directly with `/skill` in the chat.

**MCP servers** give the agent new tools: databases, issue trackers, browsers, cloud APIs. Add a local server that starts from a command, or a remote one reached at a URL, in **Settings → MCP Servers**. Servers in `<workspace>/.mcp.json` start once you trust the workspace.

**Plugins** bundle commands, agents, skills, hooks and MCP servers in one folder, in the same format as Claude Code plugins. **Browse plugins** installs them from a marketplace; they can be turned off one by one.
