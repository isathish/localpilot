# Approvals

Each kind of action has its own policy:

| Action | Tools | Default |
|---|---|---|
| Terminal commands | `run_command` | **Ask** |
| File edits | `edit_file`, `write_file`, `create_directory` | **Allow** |
| Deleting files | `delete_path` | **Ask** |
| Network & MCP | `web_search`, `web_fetch`, MCP tools | **Allow** |

**Ask** shows an inline card in the chat with *Allow*, *Allow for this chat* and *Deny*. **Allow** proceeds silently. **Block** refuses the action.

Presets — *Careful*, *Balanced* and *Autonomous* — set all four at once. Regardless of policy, every file edit is snapshotted so you can undo it or restore the whole chat to an earlier checkpoint.
