---
title: Keyboard shortcuts
description: LocalPilot's default keybindings for macOS, Windows and Linux, keys inside the chat, and the full command list.
permalink: /docs/shortcuts/
---

To change a binding, open **Preferences → Keyboard Shortcuts** in VS Code and search for "LocalPilot".

## Global shortcuts

| Action | macOS | Windows / Linux | When |
|---|---|---|---|
| Open chat | <kbd>⌘⇧L</kbd> | <kbd>Ctrl+Shift+L</kbd> | always |
| New chat | <kbd>⌘⇧⌥L</kbd> | <kbd>Ctrl+Shift+Alt+L</kbd> | always |
| Run tasks in parallel | <kbd>⌘⇧⌥P</kbd> | <kbd>Ctrl+Shift+Alt+P</kbd> | always |
| Edit with LocalPilot (inline) | <kbd>⌘⌥K</kbd> | <kbd>Ctrl+Alt+K</kbd> | editor focused and not read-only |
| Generate terminal command | <kbd>⌘⌥K</kbd> | <kbd>Ctrl+Alt+K</kbd> | terminal focused |
| Capture screenshot to chat | <kbd>⌘⌥⇧S</kbd> | <kbd>Ctrl+Alt+Shift+S</kbd> | always |
| Explain selection | <kbd>⌘⇧E</kbd> | <kbd>Ctrl+Shift+E</kbd> | text selected in the editor |

## Inside the chat

These keys work in the chat view. On Windows and Linux, read <kbd>⌘</kbd> as <kbd>Ctrl</kbd> and <kbd>⌥</kbd> as <kbd>Alt</kbd>.

### Composer

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Send |
| <kbd>⇧Enter</kbd> | New line |
| <kbd>⌘⇧Enter</kbd> | Send in a new tab (another agent, running in parallel) |
| <kbd>Enter</kbd> while the agent runs | Choose **Add to this agent** (queued for its next step) or **Send in a new tab**. If the agent is paused, the message goes to it directly |
| <kbd>↑</kbd> / <kbd>↓</kbd> in an empty input | Previous / next prompt from history |
| <kbd>⇧Tab</kbd> | Rotate the mode: Agent → Multitask → Debug → Plan → Ask (not while the agent runs) |
| <kbd>⌘Enter</kbd> in an empty input | **Build** the prepared plan shown in the chat |
| <kbd>⌘L</kbd> | Focus the input |
| <kbd>⌘I</kbd> | Open the **Add context** menu |
| <kbd>/</kbd> | Slash command picker |
| <kbd>@</kbd> | Mention picker |
| <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Tab</kbd> or <kbd>Enter</kbd> | Move in a picker / accept |

### Running agent

| Key | Action |
|---|---|
| <kbd>Esc</kbd> | Close the open picker. With no picker open, stop the running agent |
| <kbd>⌥Esc</kbd> | Pause the running agent after its current step, or resume it |
| <kbd>Y</kbd> / <kbd>A</kbd> / <kbd>N</kbd> | Answer a permission prompt: allow once / allow for this session / deny (<kbd>Esc</kbd> also denies) |

### Chat tabs

| Key | Action |
|---|---|
| <kbd>⌥↑</kbd> / <kbd>⌥↓</kbd> | Previous / next chat tab |
| <kbd>⌥1</kbd> … <kbd>⌥9</kbd> | Jump to tab 1 to 9 |
| <kbd>⌘⌥T</kbd> | New tab |
| <kbd>⌘⌥W</kbd> | Close the current tab (not while its agent runs) |

With a tab focused:

| Key | Action |
|---|---|
| <kbd>←</kbd> / <kbd>→</kbd>, <kbd>Home</kbd> / <kbd>End</kbd> | Move between tabs |
| <kbd>Delete</kbd> or <kbd>Backspace</kbd> | Close the tab, or all selected tabs |
| <kbd>F2</kbd> | Rename the tab |
| <kbd>⌘A</kbd> | Select all tabs |
| <kbd>Esc</kbd> | Clear the selection |
| <kbd>⌘</kbd>-click / <kbd>⇧</kbd>-click | Select several tabs, then close them with ✕ or <kbd>Delete</kbd> |

## Commands

Open the Command Palette and type "LocalPilot" to see these.

| Area | Commands |
|---|---|
| Chat | Open Chat · Open Chat in Editor · Move Chat To… · LocalPilot Menu… · New Chat · Show Chats… · Chat Actions… · Open in Markdown Reader |
| Agents | Run Tasks in Parallel… · Stop All Agents · Pause or Resume Agent · Pause All Agents · Resume All Agents |
| Best-of-N and worktrees | Best of N: Run One Task on Several Models… · Compare Best-of-N Results… · Apply Agent's Changes to Workspace · Discard Agent's Isolated Changes |
| Changes | Keep All Agent Changes · Undo All Agent Changes |
| Models | Select Model · Refresh Models · Set Up Models Automatically · Install Model from Catalog… · Remove Local Model… · Enable / Disable Model… · Manage Models · Browse Ollama Model Gallery… · Manage Model Providers… · Restart Ollama with Parallel Request Slots · Tune Models From Usage · Start colibri (stream huge MoE models from disk) |
| Skills | Install Skill… · Browse Skill Registry (Quick Pick)… · Manage Skills · Reload Skills, Subagents & MCP Servers |
| Browser and images | Open URL in Browser View… · Screenshot a Web Page… · Inspect a Web Page (Screenshot, Console, Network)… · Capture Screenshot to Chat (Area / Window / Screen) · Attach Image to Chat… |
| Editor | Edit with LocalPilot (inline) · Explain · Fix · Refactor · Generate Tests · Add Documentation · Fix Errors in File · Toggle Inline Completions · Generate Commit Message |
| Terminal and CLI | Open LocalPilot Terminal · Generate Terminal Command… · Explain Terminal Output · Fix Failed Command · Add Terminal Output to Chat · Install 'localpilot' CLI in PATH |
| Settings and data | Settings · Welcome / Setup · Open Dashboard · Open Memory Notes · Clear Memory Notes… · Clear Chat History… · Show Logs |

Editor commands such as Explain, Fix and Refactor act on the current selection.
