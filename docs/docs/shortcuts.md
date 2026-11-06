---
title: Keyboard shortcuts
description: LocalPilot's default keybindings for macOS, Windows and Linux, keys inside the chat, and the full command list.
permalink: /docs/shortcuts/
---

**Settings → Keyboard shortcuts** lists every key below, with **Change…** next to each VS Code binding: it opens VS Code's Keyboard Shortcuts editor filtered to that command. You can also open **Preferences → Keyboard Shortcuts** and search for "LocalPilot". Type `/keys` in the chat to print the list there. The keys inside the chat are handled by the chat view and cannot be rebound.

## Global shortcuts

| Action | macOS | Windows / Linux | When |
|---|---|---|---|
| Open chat | <kbd>⌘⇧L</kbd> | <kbd>Ctrl+Shift+L</kbd> | outside the text editor |
| New chat | <kbd>⌘⇧⌥L</kbd> | <kbd>Ctrl+Shift+Alt+L</kbd> | always |
| Run tasks in parallel | <kbd>⌘⇧⌥P</kbd> | <kbd>Ctrl+Shift+Alt+P</kbd> | always |
| Edit with LocalPilot (inline) | <kbd>⌘⌥K</kbd> | <kbd>Ctrl+Alt+K</kbd> | editor focused and not read-only |
| Generate terminal command | <kbd>⌘⌥K</kbd> | <kbd>Ctrl+Alt+K</kbd> | terminal focused |
| Capture screenshot to chat | <kbd>⌘⌥⇧S</kbd> | <kbd>Ctrl+Alt+Shift+S</kbd> | always |
| Add selection to chat (focuses the chat input when nothing is selected) | <kbd>⌘'</kbd> | <kbd>Ctrl+'</kbd> | editor focused |

<kbd>⌘⇧L</kbd> / <kbd>Ctrl+Shift+L</kbd> opens the chat when focus is not in a text editor, so VS Code's **Select All Occurrences** still works while you edit. <kbd>⌘⇧⌥L</kbd> replaces **Open Quick Chat**. To get that back, open **Keyboard Shortcuts**, search for "LocalPilot: New Chat", and change or remove the binding.

## Inside the chat

These keys work in the chat view. On Windows and Linux, read <kbd>⌘</kbd> as <kbd>Ctrl</kbd> and <kbd>⌥</kbd> as <kbd>Alt</kbd>.

### Composer

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Send |
| <kbd>⇧Enter</kbd> | New line |
| <kbd>⌘⇧Enter</kbd> | Send in a new tab (another agent, running in parallel) |
| <kbd>Enter</kbd> while the agent runs | Add the message to this run: the agent reads it at its next step (when it resumes, if paused) |
| <kbd>⌥Enter</kbd> while the agent runs | **Send after this turn**: the message starts a new turn when the run ends. **More…** in the hint under the message box also offers a new tab or stopping first |
| <kbd>↑</kbd> / <kbd>↓</kbd> in an empty input | Previous / next prompt from history |
| <kbd>⇧Tab</kbd> | Rotate the mode: Ask → Agent → Plan → Debug → Multitask (not while the agent runs) |
| <kbd>⌘Enter</kbd> in an empty input | **Build** the prepared plan shown in the chat |
| <kbd>⌘L</kbd> | Focus the input |
| <kbd>⌘I</kbd> in the input | **Improve prompt**: rewrite the draft in place (nothing is sent) |
| <kbd>⌘I</kbd> elsewhere in the chat | Open the **Add context** menu |
| <kbd>/</kbd> | Slash command picker |
| <kbd>@</kbd> | Mention picker |
| <kbd>↑</kbd> / <kbd>↓</kbd>, <kbd>Tab</kbd> or <kbd>Enter</kbd> | Move in a picker / accept |

### Running agent

| Key | Action |
|---|---|
| <kbd>Esc</kbd> | Close the open picker. With no picker, approval or text field in the way, stop the running agent, wherever the focus is in the chat |
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

### Reviewing changes

The **Changes** panel above the input is a review queue. **Review** opens the first file not reviewed yet in a side-by-side diff, and the **N files** chip under an answer opens the files of that turn.

With a file row focused in the panel:

| Key | Action |
|---|---|
| <kbd>J</kbd> / <kbd>K</kbd> (or <kbd>↓</kbd> / <kbd>↑</kbd>) | Next / previous file |
| <kbd>A</kbd> | Accept the file |
| <kbd>R</kbd> | Reject the file (its edits are removed from disk; **Restore edits** on the row brings them back for 5 minutes) |
| <kbd>Enter</kbd> | Open the diff (the file itself once it is reviewed) |

In the review diff (the title bar shows the same actions):

| Key | Action |
|---|---|
| <kbd>⌘Enter</kbd> / <kbd>Ctrl+Enter</kbd> | Accept the file and open the next one |
| <kbd>⌥F5</kbd> / <kbd>Alt+F5</kbd> | Next changed file |
| <kbd>⇧⌥F5</kbd> / <kbd>Shift+Alt+F5</kbd> | Previous changed file |

**Reject File** is in the diff's title bar. The right side of the diff is the file itself, so you can edit it before accepting. When the last file is decided, a summary ("All 5 files reviewed: 4 accepted, 1 rejected") offers **Undo**.

## Commands

Open the Command Palette and type "LocalPilot" to see these.

| Area | Commands |
|---|---|
| Chat | Open Chat · Open Chat in Editor · Move Chat To… · Show Quick Menu… · New Chat · Show Chats… · Chat Actions… · Open in Markdown Reader · Open Markdown Reader to the Side · Ask LocalPilot About This Document · Export Markdown as HTML · Export Markdown as PDF |
| Agents | Run Tasks in Parallel… · Stop All Agents · Pause or Resume Agent · Pause All Agents · Resume All Agents |
| Best-of-N and worktrees | Best of N: Run One Task on Several Models… · Compare Best-of-N Results… · Apply Agent's Changes to Workspace · Discard Agent's Isolated Changes |
| Changes | Keep All Agent Changes · Undo All Agent Changes · Accept File · Reject File · Next Changed File · Previous Changed File (in a review diff) |
| Models | Select Default Model… · Refresh Models · Set Up Models Automatically · Install Model from Catalog… · Remove Local Model… · Enable / Disable Model… · Manage Models · Browse Ollama Model Gallery… · Manage Model Providers… · Set Provider API Key… · Restart Ollama with Parallel Request Slots · Tune Models From Usage · Start Colibri Server · Stop Colibri Server |
| Skills | Install Skill… · Browse Skill Registry… · Manage Skills · Reload Skills, Subagents & MCP Servers |
| Browser and images | Open URL in Browser View… · Screenshot a Web Page… · Inspect a Web Page (Screenshot, Console, Network)… · Capture Screenshot to Chat (Area / Window / Screen) · Attach Image to Chat… · Add File/Folder to Chat |
| Editor | Add Selection to Chat · Edit with LocalPilot (inline) · Explain Selection · Fix Selection · Refactor Selection · Generate Tests for Selection · Document Selection · Fix Errors in File · Turn Inline Completions On/Off · Generate Commit Message · Stop Generating Commit Message · Commit with Agent… · Generate / Explain / Improve Cell with LocalPilot |
| Terminal and CLI | Open Terminal · Generate Terminal Command… · Explain Terminal Output · Fix Failed Command · Add Terminal Output to Chat · Install 'localpilot' CLI in PATH |
| Settings and data | Settings · Open Setup · Open Dashboard · Open Memory Notes · Clear Memory Notes… · Clear Chat History… · Show Logs |

Editor commands such as Explain Selection, Fix Selection and Refactor Selection act on the current selection. In the light bulb (Cmd/Ctrl+.) they appear as Explain Selection with LocalPilot and Refactor Selection with LocalPilot.
