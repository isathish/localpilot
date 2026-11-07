---
title: Conversations, memory & sync
description: What LocalPilot keeps about your work, where it keeps it, how to find, organise and restore conversations, the six kinds of memory, end-to-end encrypted sync across devices, and how to recover from crashes and mistakes.
permalink: /docs/continuity/
---

LocalPilot keeps your conversations, the agent's memory, what the model saw and what the agent did, so you can pick up any
piece of work later, on this machine or another one. Everything stays on your computer unless you turn on sync, and
synced data is always encrypted with a passphrase only you know. There is no LocalPilot server and no account.

## What LocalPilot keeps

| What | Examples | Kept as |
|---|---|---|
| Conversations | Every message, edited prompts, regenerated answers, branches, summaries, images and attachments | Conversation history |
| Memory | Project facts, your preferences, task notes, knowledge you saved, lessons the agent learned | Memory items (six types, below) |
| Context | What each answer was based on: files, rules, memory, summaries, and what was left out | Context snapshots and the Context library |
| Agent activity | Each run, its tool calls, errors, retries, approvals, the files it changed and the checkpoint taken before it | Agent sessions, execution events, checkpoints |
| Your setup | Prompt templates and custom commands, project instructions and rules, favourite models, default model per mode | Templates, instructions and preferences |

These are kept separately and linked to each other, so you can delete a conversation without losing the project memory it
created, or look at what an agent run did without opening the whole chat.

API keys and passwords are never part of this. They stay in VS Code's secret storage (or the CLI's key file) and are never
synced.

## Where it is stored

<p><img src="{{ '/assets/screenshots/settings-continuity.png' | relative_url }}" alt="Settings → Continuity &amp; sync → Storage: the data folder, conversations and messages, change log, search index (ready), attachments, backups and this device, with Open folder and Rebuild index" width="720"></p>

Everything lives in one folder per computer, shared by VS Code and the `localpilot` CLI:

- default: `~/.localpilot/continuity` (or `$LOCALPILOT_DATA_DIR/continuity` when you set `LOCALPILOT_DATA_DIR`)
- change it with `localpilot.continuity.dataDir` (takes effect after a window reload; LocalPilot does not move existing
  data for you). The CLI reads the same setting from your user settings or `~/.localpilot/config.json`; an explicit
  `--data-dir <dir>` on the command line wins and uses `<dir>/continuity`.

Inside it, LocalPilot writes an append-only log of every change (one log per window or CLI process, so two windows never
overwrite each other) and a search index built from that log. Changes reach the disk within a quarter of a second, and
at once for the ones that matter most (a finished answer, the start and end of a run, a deletion), so a crash or a power
cut loses at most a moment of typing. If the index is ever damaged, LocalPilot rebuilds it from the log on its own; you
can also run **LocalPilot: Rebuild Conversation Index**. If the folder cannot be used (no permission, disk full), chats
keep working exactly as in 1.6 and **Settings → Continuity & sync** says why.

| In the data folder | What it is |
|---|---|
| `streams/` | The change logs, one folder per window or CLI process |
| `index/` | The search index (can always be rebuilt) |
| `blobs/` | Images, attachments and large tool output, stored once each |
| `backups/` | Automatic and manual backups |
| `migration/` | What was imported from 1.6, and copies of the original files |

The chat files VS Code kept in 1.6 are still written as before, so nothing that read them stops working.

Project memory is still a set of Markdown files in `<workspace>/.localpilot/memory`, so you can edit it and commit it as
before. Your personal (developer) memory is still in VS Code's global storage.

### Upgrading from 1.6

The first time 1.7 starts, it imports your existing chats in the background: those of every workspace of this VS Code
profile (also workspaces whose folder no longer exists) and of the `localpilot` CLI, including the messages that a
compaction had folded away, with their images, run traces, checkpoints and interrupted runs. It also imports your project
and global memory notes and your custom commands. Empty "New chat" files are skipped. You can keep working meanwhile;
your chats load from their files as before.

Nothing is deleted or changed: every original file is first copied to `continuity/migration/legacy-backup/<date>`, and
the copies stay there until you click **Remove migration backup** in **Settings → Continuity & sync** (or run
`localpilot data migrate --remove-backup`). If a file cannot be read, it is listed there with **Retry**. Running the
import again never duplicates anything. If you start the CLI before VS Code, VS Code still imports its own chats the
first time it opens.

## Finding your conversations

<p><img src="{{ '/assets/screenshots/conversations-navigator.png' | relative_url }}" alt="The conversation navigator: search box and New conversation, All, Pinned, Favorites, Archived and Trash with counts, this project, tag chips, a running chat and today&#39;s chats, and Knowledge &amp; continuity" width="420"></p>

Click the history button in the chat's title bar (or run **LocalPilot: Open Conversations**) to open the navigator:

- **Search** and **New conversation** at the top.
- **All, Pinned, Favorites, Archived, Trash**, each with a count, then **Projects**: **This project** (the default),
  **All projects**, or one project with the number of conversations in it. Tags used in the list appear as chips; click
  one to filter by it.
- The conversations, grouped by date (Today, Yesterday, Previous 7 days…), with their project when it is not this one,
  their tags, a branch count when messages were edited or regenerated, and a **CLI** badge for chats started in the
  terminal. A conversation of another project, or one archived away, opens in this window when you click it.
- **Knowledge & continuity**: Memory manager, Context library, Checkpoints, Sync manager, Trash and Settings.

In a narrow sidebar (under 360 px) the views fold into one **Show** menu. Opened in an editor tab wider than 800 px, the
navigator has two panes: views, projects and Knowledge & continuity on the left, the list on the right.

While the search index is still being built (the first start after the upgrade), the navigator says **Indexing your
history…** and lists this folder's chats as in 1.6; the other views appear as soon as the index is ready.

### Search

<p><img src="{{ '/assets/screenshots/conversations-search.png' | relative_url }}" alt="Searching for docker: a match in error output, one in a code block and one in an answer, sorted by relevance" width="420"></p>

Search looks at titles, your messages, the answers, code blocks and error output, and shows the matching part of the
conversation (marked **Code:** or **Error:** when the match is in code or an error). Narrow it down by typing filters into
the box:

| Filter | Finds |
|---|---|
| `in:code` | Only inside code blocks and tool arguments |
| `in:errors` | Only in errors: failed commands, stack traces, failed tests |
| `from:user` / `from:assistant` | Only what you wrote / what the model answered |
| `project:api` | Conversations of a project |
| `tag:release` | Conversations with a tag |
| `model:qwen` | Conversations that used a model |
| `is:pinned`, `is:favorite`, `is:archived`, `is:trashed` | By state |
| `after:2026-10-01`, `before:2026-11-01` | By date |

Example: `in:errors ECONNREFUSED project:api` finds the conversation where you fixed that connection error. Search covers
**This project** unless you pick **All projects**.

### Projects that moved

A project is recognised by its git repository (the remote URL and the first commit), so a cloned or moved repository keeps
its conversations without you doing anything. A folder that is not a git repository is recognised by its path; after you
move it, its old conversations are listed under a project marked **(moved?)**. Pick it and click **This is the same
project** to bring its conversations to this folder.

## Organising conversations

From a conversation's menu in the navigator (**⋯**, or right-click):

- **Rename**, **Pin** (keeps it first in the tab bar), **Favorite** (also the ★ on the row; collects it under Favorites
  across projects).
- **Tags…**: add or remove free-text tags, then filter with the tag chips or `tag:`.
- **Archive**: hides it from All without deleting it; it stays searchable and opens from **Archived**.
  `localpilot.sessions.retention` (default 50) now moves the oldest idle chats beyond the limit to Archived instead of
  deleting them.
- **Duplicate**: a new conversation with copies of the messages.
- **Export as JSON, Markdown, HTML or PDF**, **Share securely…** (below).
- **Merge with…**: a new conversation that continues this one with a summary of the one you pick (written by the chat's
  model when it can be reached); both originals stay.
- **Versions**: earlier titles, states and branches (below).
- **Move to Trash**.

**Select** lets you pick several conversations and **Archive**, **Tag**, **Export** or **Trash** them together.

## Continuing, branching and restoring

<p><img src="{{ '/assets/screenshots/compare-answers.png' | relative_url }}" alt="Compare answers: two answers to the same request, from qwen2.5-coder:14b and claude-sonnet-4-6" width="460"></p>

Conversation history is never overwritten:

- **Edit** a prompt or **Regenerate** an answer: the new version is a branch, and the earlier one stays. Messages that have
  other versions show `‹ 1/2 ›`; the arrows switch between them (the chat then shows that version and what followed it).
- **Regenerate with another model** (the stacked-layers button under the latest answer) answers again with the model you
  pick; **Compare** (under an answer that has other versions, or **⋯ → Compare answers**) shows the answers side by side,
  or as tabs in a narrow sidebar, with **Use this one**.
- **⋯ → Continue from here** on any message starts a new branch at that message; the later messages stay on the previous
  branch. **⋯ → Duplicate from here** makes a new conversation with everything up to that message.

**Versions** lists the conversation's branches (**Show** switches to one, the pencil renames it) and its history of
titles, pins, favorites, tags and branch switches. **Restore** puts an earlier title and states back as a new change, or
goes back to the branch that was shown then; the newer values stay in the list. Version history is kept for
`localpilot.continuity.historyDays` (default 90 days).

When another window or the CLI on this computer continues a conversation you have open, the chat shows **Updated on
another window or the CLI**; it reloads on its own when the chat is idle, otherwise click **Reload** when the agent is done.

## Trash and recovery from mistakes

Deleting a conversation (the trash button on a row, **Move to Trash**, **Clear…**, or the CLI's `history trash`) moves it to
**Trash**, with an **Undo** button for 10 seconds. In Trash (**Knowledge & continuity → Trash**, the Trash view, or
**LocalPilot: Open Conversation Trash**) you can **Restore** it with all its messages, checkpoints and transcript, or
**Delete permanently**. Conversations are removed from Trash after `localpilot.continuity.trashRetentionDays` (default 30
days; 0 keeps them until you empty Trash yourself).

Deleting permanently also removes the conversation's transcript archive, run traces, checkpoints, command logs and the
attachments that nothing else uses, and the conversation's own memory notes.

Memory notes you delete (in Memory manager, with `localpilot memory rm`, by the agent, or by deleting the note file) are in
Trash too, under **Memory notes**: **Restore** puts a project or developer note's file back. Context sets and prompt
templates join Trash as their parts of 1.7 land.

If conversation storage is off (see Where it is stored), deleting works as in 1.6: the chat is removed at once.

## Export, import and sharing

- **Export** one conversation from its menu, several with **Select → Export** (one file each into a folder you pick), or
  any with **LocalPilot: Export Conversations…**: **JSON** (complete: every branch, tags and states; can be imported again),
  **Markdown**, **HTML** or **PDF**. PDF writes a print-ready page and opens it in your browser; choose *Save as PDF* in
  its print dialog.
- **Import** with **LocalPilot: Import Conversations…**: a LocalPilot JSON export, or a `.lpshare` file and its code. Chats
  from Claude Code and Codex import as in 1.6.
- **Share securely…** looks for secrets (API keys, tokens) in the conversation and offers **Redact** (only the shared copy
  changes) or **Keep**, then saves an encrypted `.lpshare` file and shows a 52-character **share code** once. Send the file
  and the code by different channels; without the code the file cannot be read, and LocalPilot does not keep it.

## Memory

LocalPilot has six kinds of memory. Open them all in **Memory manager** (**Knowledge & continuity → Memory manager**,
**LocalPilot: Open Memory Manager**, or **Open Memory manager** in Settings → Memory & history).

<p><img src="{{ '/assets/screenshots/memory-manager.png' | relative_url }}" alt="The Memory manager: Project, Developer, Conversation, Task, Knowledge and Agent tabs with counts, and two project notes, one pinned" width="420"></p>

| Type | What it holds | Applies to | Where |
|---|---|---|---|
| Conversation | A summary of the conversation, and notes you asked it to remember | That conversation only | LocalPilot's store |
| Project | Build and test commands, conventions, architecture (as in 1.6) | Every chat in the project | `.localpilot/memory/*.md` in the project |
| Developer | Your preferences: style, tools, habits (1.6's "global" notes) | Every chat in every project | VS Code global storage (`~/.localpilot/memory` for the CLI) |
| Task | The checklist of a plan or todo list while it runs, and notes the agent keeps about it | Chats working on that task; moved to Trash 14 days after every todo is done (`localpilot.memory.taskExpiryDays`) | LocalPilot's store |
| Knowledge | Reference material you chose to keep: an explanation, a snippet, a decision record | Only when looked up: `#memory:<name>` or the agent's `memory_search` | LocalPilot's store |
| Agent | Lessons the agent learned: pitfalls and their fixes, and which fix worked for which kind of failure | Their names in every prompt; the agent reads one when it is relevant | LocalPilot's store |

**How memory fills up.**

- The agent saves project facts with `memory_save` as in 1.6. After a substantial run, the automatic save
  (`localpilot.memory.autoSave`) keeps facts as project notes and turns pitfalls into **Agent** lessons. When self-healing
  fixes a failure, what worked becomes an Agent lesson too.
- Each conversation gets a **summary**: after a compaction (the compaction's own summary, no extra request) or every 20
  messages (one short request to the same model, after the answer, never delaying it).
- While a plan or todo list runs, its checklist is kept as **Task** memory.
- On any message, the **⋯** menu has **Remember in this chat** (a Conversation note) and **Save to knowledge** (a Knowledge
  note); both ask for a name.

**Memory manager.** Pick a type (a menu under 360 px wide), filter, and per note: **Edit** (project and developer notes
open their Markdown file; the others edit in place), **Move to** another type, **Local only** (the note is never sent to a cloud model: it is left out
of the prompt and replaced by a placeholder wherever it was attached; local models still get it), **Pin** (listed first), **Versions** (every save, with a line diff against now and **Restore**), and **Move to
Trash**. **New** creates a note of any type; **All projects** shows other projects' notes. Changes made in a note file by
hand, by a script or by `git pull` are picked up within seconds.

**For the agent.** The memory tools accept a `type` (`global` still means developer): `memory_save`, `memory_read`,
`memory_list`, `memory_delete`, and the new `memory_search`, which searches every type by words. The prompt's memory section
keeps its 1.6 size: project and developer notes come first, and this chat's conversation and task notes and the agent's
lessons get what is left. Write `#memory:<name>` in a message (type `#memory:` for suggestions) to attach any note.

**VS Code and the CLI.** Both use the same memory. Developer notes written in one appear in the other's folder; a note file
is only rewritten when it still holds what LocalPilot last saw of it, otherwise your file is kept and the change waits as a
conflict. Project notes tracked by git are never rewritten (git moves them).

## Context library and earlier conversations

<p><img src="{{ '/assets/screenshots/context-library.png' | relative_url }}" alt="The Context library: three named context sets with their #context: names, Attach, edit and delete" width="420"></p>

**Context library.** Open it from **Knowledge & continuity → Context library**, **LocalPilot: Open Context Library**, or
**Open Context library** in Settings → Continuity & sync. A context set has a name, an optional description and items:

| Item | What it adds when attached |
|---|---|
| File | The file (up to 24,000 characters) |
| Files matching | Every file a glob matches, such as `docs/**/*.md` (up to 40 files; `node_modules`, `.git` and build folders skipped) |
| Snippet | Text you keep with the set |
| Memory note | That note, by name |
| Earlier chat | That conversation's summary (as `#chat:` below) |
| Link | The address, as a reference; it is not fetched |

Attach a set with `#context:<name>` in a message (typing `#context:` suggests names) or **Attach** on the page, which
puts the mention into the message box; the set is read when you send (80,000 characters at most). **New set** starts
empty, and **Add files of this chat** fills it with the files attached to the current chat and its working files.
**Available in** keeps a set to this project or offers it in every project. **Local only** keeps the whole set away
from cloud models. Sets have versions, and a deleted set waits in Trash.

**Earlier conversations.**

- While you write the first message of a new chat, LocalPilot may offer up to three earlier conversations of the same
  project above the message box: **Related: <title> · Add**. They are chosen by the words your message shares with them
  (rarer words count more), never from Trash, and nothing is added until you click **Add**, which puts `#chat:<id>`
  into the message. Turn this off with `localpilot.continuity.relatedConversations`.
- `#chat:<title or id>` adds an earlier conversation: its summary when it has one, else its first request and last
  answer, about 1,500 tokens at most. Typing `#chat:` suggests recent conversations.
- The agent has two read-only tools, offered when your request refers to earlier work: `history_search` finds messages
  of earlier conversations (this project, or all projects when it asks) and `history_read` reads up to 20 messages and
  12,000 characters of one conversation at a time.

**What did the model see?** Every answer records what its request held: the parts of the window (system prompt, rules,
memory, tools, conversation, files, tool output, summaries), the items with their tokens (each attached file, set,
earlier chat, memory note, rule file, summary and tool output) and what was left out, plus the working files, todos and
attachments of the chat at that moment. A compaction records the context before and after it. The context ring's card
shows the last request's **Items** and **Excluded**; **⋯ → What did the model see?** on an answer, or the Context
library's **Context of this chat** tab, shows any recorded request. Records of a conversation are deleted with it.

**Local only.** Memory notes and context sets marked **Local only**, and conversations tagged `local-only`, never reach
a cloud model: before each request to one, their text is replaced by a short placeholder (also when they were attached
in an earlier message or returned by a tool), and they are listed under **Excluded**. A conversation tagged
`local-only` is not sent to a cloud model at all; the chat says why and you can pick a local model. Local models get
everything. The first time a chat that ran on local models goes to a cloud model, a notice says what is now sent and
what stays on this machine.

**Reopening a chat.** When you open a chat that has no working state in this window (after a restart, from another
window or the CLI, or reloaded from the log), its working files, todos and attachments come back from its last
request, and the chat lists the files that changed since (by content); the next answer is told to read them again.

## Agent runs and crash recovery

Each agent run is kept with the conversation it belongs to: when it started and ended, how it ended (finished, failed,
stopped, interrupted), the model, the tokens, the files it changed, and **what ran**: each model call, tool call (with its
status), retry, model fallback, approval, compaction and error, in order. How much of each tool call's output is kept is
set by `localpilot.continuity.captureToolOutput`: `errors` (only the error text of failed steps), `summary` (the first
2 KB of every step, the default) or `full` (everything; output over 2 KB is stored as an attachment). The text the model
streams is not stored here; the chat keeps the answers.

<p><img src="{{ '/assets/screenshots/run-interrupted.png' | relative_url }}" alt="An interrupted run: stopped while validating, the failing assertion, the two files changed so far, and Resume, Rollback fixes, Review changes so far and Dismiss" width="420"></p>

The model that answered is kept too. Each stretch of a conversation answered by one model is recorded with why the model
changed: you picked another one, Auto picked it, a fallback took over, or the provider was down.

**If VS Code crashes, or the window closes during a run**, the next start marks that run as interrupted (a run is
interrupted when the process that ran it is gone; a run still going in another window or in the CLI is left alone). Open
the chat and the **Run interrupted** card shows:

- **What ran**: the run's last steps, including the one that was running when it stopped.
- **Changed files**: what the run changed (added, modified, deleted), with **Keep** for each file still waiting for review,
  **Keep all** and **Review diff**, and the time of the checkpoint taken before the run.
- **Resume**, **Restore checkpoint** (files and chat back to before your last message) or **Dismiss**.

**If the laptop turns off (or LocalPilot closes) while an answer is being written**, the text written so far is saved
every 2 seconds on this computer. On the next start it comes back as the chat's last answer, marked **Partial answer**,
and the card becomes **Interrupted — partial answer** with **Continue** (the model carries on from where the text
stopped), **Regenerate** (sends your request again) and **Discard** (removes the partial text). These drafts are never
synced, and a draft is removed as soon as the answer it belongs to is saved. In the CLI, `localpilot -c` (or `-r <id>`)
puts the partial answer back and says so; type "continue" to pick it up.

## Checkpoints

<p><img src="{{ '/assets/screenshots/checkpoints.png' | relative_url }}" alt="The Checkpoints page: three checkpoints of this project with their changed files, View changes, Restore (files and chat, files only, chat only) and Open chat" width="460"></p>

A checkpoint is taken before each agent turn (Settings → Agent → Checkpoints): a git snapshot in a git repository, file
snapshots otherwise. **Checkpoints** (in **Knowledge & continuity**, the command **LocalPilot: Open Checkpoints**, or
Settings → Continuity & sync → **Open Checkpoints**) lists this project's checkpoints, newest first (**All projects** shows
every project's), with the conversation, the turn, the time, the kind, the files the turn changed and whether it was
restored. For each:

- **View changes** opens the changes since that checkpoint in a diff.
- **Restore…** offers **Files and chat**, **Files only** or **Chat only**, asks before it changes anything, and uses the same
  restore as the chat's message menu (in a git repository your current state is saved in git stash first).
- **Open chat** opens the conversation.

View changes and Restore are available for chats of this window whose turn is still in the chat (a turn removed by a
rewind or an edit says so). A checkpoint taken on another device shows **Content on <device>**: its files are listed, but
its content stays on that device unless sync carries **Checkpoint contents** (off by default, because it can be large).

## Sync across devices

Sync is off by default. Turn it on in **Settings → Continuity & sync → Sync**: choose the storage, fill in its fields,
click **Test connection**, then **Set up sync…** (also **LocalPilot: Set Up Sync…**). From the terminal:
`localpilot sync setup`.

### Choose where your data goes

| Storage | Use it with | You provide |
|---|---|---|
| Folder | iCloud Drive, Dropbox, OneDrive, Google Drive for desktop, a network share | A folder that your sync app keeps up to date on every device (**Browse…**) |
| Git | Any git host: a **separate, private** repository, not your project's | The repository URL and a branch (`localpilot-sync`); your usual git credentials or SSH keys are used |
| S3-compatible | Amazon S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi | Endpoint, region, bucket, optional folder in the bucket, access key ID, and the secret key (**Set…**) |
| WebDAV | Nextcloud, ownCloud, Synology, any WebDAV server | URL, user name, and the password or an app password (**Set…**) |

LocalPilot writes everything into a `localpilot-sync` folder (or prefix) of that storage. S3 and WebDAV need HTTPS (plain
HTTP is accepted only for `localhost`). The S3 secret key and the WebDAV password are kept in VS Code's secret storage (the
OS keychain), or in `~/.localpilot/keys.json` for the CLI; they never go into settings and never sync. A Git URL that
points at a folder with a working tree (a project) is refused. With Git, attachments over 5 MB stay local.

**Test connection** checks access and says whether the storage is empty (set-up creates the encrypted remote) or already
holds LocalPilot data (set-up joins it with your passphrase). A wrong passphrase changes nothing.

### Your passphrase

The first device creates a sync **passphrase** (asked twice, with a strength hint). Everything LocalPilot uploads is
encrypted on your computer before it leaves, with AES-256-GCM and a random data key; the data key is protected by a key
derived from your passphrase with scrypt. The passphrase itself is never stored; each device keeps only the data key, in
its secret storage. Your storage provider sees object names (random-looking ids and numbers), sizes, counts and when they
were written, and how many devices there are; it cannot read titles, messages, code, project names and paths, memory,
tags, device names, or tell which attachments are the same as files it knows.

- Each new device asks for the passphrase once (`LOCALPILOT_SYNC_PASSPHRASE` for unattended machines).
- **Change passphrase…** works from any device that syncs; the others keep syncing, new devices join with the new one.
- **Rotate key…** makes a new data key for everything uploaded from then on (history stays readable). Your other devices
  pause once and ask for the passphrase (**Enter passphrase…**).
- If you lose the passphrase, synced data cannot be decrypted by anyone, including you. Your local data is not affected:
  **Start over…** deletes the synced copies (of every device) and uploads this device's data again under a new
  passphrase; other devices join again with it.
- **Turn off sync…** stops this device and forgets its key; the storage and your other devices are not changed.

### What is synced

**What syncs** (Sync settings or the Sync manager) has seven switches:

| Category | What it carries |
|---|---|
| Conversations | Conversations with their branches, summaries, model changes and context snapshots; pinned, favorite, archived, tags and Trash travel with them |
| Memory and context sets | Memory notes of every type and the context library |
| Attachments | Images and files attached to chats, up to `localpilot.sync.maxAttachmentMB` (20 MB) |
| Agent runs and checkpoints | Agent runs, what they did, and the list of checkpoints |
| Checkpoint contents | Off by default. A git bundle of each git checkpoint (up to 50 MB), so a checkpoint taken on another device can be viewed and restored here |
| Custom commands | Your own custom commands (`~/.localpilot/commands`) |
| Preferences | Default model, plan-mode model, thinking level, approval levels, Auto mode and your starred models; never API keys, endpoints or credentials |

A category you turn off stays on this device (the Sync manager says how many items it held back); turning it on later
sends them. Attachments are downloaded in the background after the conversations that use them.

Sync runs 10 seconds after start-up, every `localpilot.sync.intervalMinutes` (5 by default), 15 seconds after a change,
when the window gets focus, and on **Sync now**. It only sends what changed. While offline, changes wait (they are just
the part of the log not uploaded yet, so they survive a restart) and retry after 5 s, 15 s, 1 min, 5 min, then every
15 min. Only one window (or the CLI) syncs at a time on a computer; the others see the result. A cycle with nothing new
costs one listing and no downloads.

### Sync manager

Open it from the conversation navigator (**Knowledge & continuity → Sync manager**, whose dot shows synced, syncing,
offline, paused or a conflict count) or **LocalPilot: Open Sync Manager**. It shows the status and the last sync, what is
waiting, **Sync now**, **Pause** / **Resume**, the **conflicts**, your **devices** (rename this one, **Remove…** another,
**List again**), what syncs, recent activity, and **Change passphrase…**, **Rotate key…**, **Turn off sync…** and
**Start over…**. When sync needs you, the status says why with the fix next to it: **Enter passphrase…** (the key was
rotated or sync started over elsewhere), **Update credentials…** (sign-in failed), or **Sync settings…** (the folder,
bucket or repository is gone).

<p><img src="{{ '/assets/screenshots/sync-manager.png' | relative_url }}" alt="The Sync manager: up to date with three conflicts (a title, a memory note edited on two devices with Compare, and a chat continued on two devices) and the devices list" width="420"></p>

### Conflicts

Most simultaneous changes merge on their own: pins, favorites, tags and other settings take the latest change; memory
notes edited on two devices are merged line by line when the edits do not overlap. When they do conflict, LocalPilot
applies the later change, keeps the other, and lists a conflict on every device (**LocalPilot: Show Sync Conflicts**):

- **Changed on two devices** (for example a title): keep either device's value.
- **Edited on two devices** (a memory note or a custom command): **Compare…** opens both versions in VS Code's diff editor,
  then keep either one, both, or edit the merged text. A note file or command you edited here is never overwritten.
- **Continued on two devices**: both continuations are kept as branches; the chat says "Continued on <device> too".
  **Keep both**, or use the other device's branch.
- **Deleted on one device, edited on another**: it stays out of Trash; **Move to Trash again** if you meant it.
- **Damaged on the storage**: an object that fails its check is skipped; **Re-upload from this device** writes this
  device's data again.

A resolution made on one device clears the conflict everywhere. In the terminal: `localpilot sync conflicts` and
`localpilot sync resolve <id> --keep mine|theirs|both` (a text conflict without `--keep` prints the diff).

### Removing a device

**Remove…** in the Sync manager (or `localpilot sync remove-device <id> --rotate`) stops listing the device; what it synced
stays. Choose **Remove and Rotate Key** so it cannot read anything synced afterwards, and revoke its access at your
storage provider too (LocalPilot does not manage those credentials).

## When things go wrong

| What happened | What LocalPilot does |
|---|---|
| VS Code crashed during an agent task | The chat shows **Run interrupted** with what ran, the files it changed (**Keep**, **Review diff**), and **Resume**, **Restore checkpoint** or **Dismiss** |
| The laptop turned off during an answer | The text written so far comes back as a **Partial answer** with **Continue**, **Regenerate** and **Discard** |
| The network dropped during sync | Nothing is lost; the status says **Offline** with how many changes wait, and sync retries on its own (5 s up to every 15 min) |
| The model provider is down | Switch model and retry from the same point; the conversation keeps its history, and the switch is recorded with its reason |
| The conversation is too long for the model | Older messages are summarised; the full transcript stays searchable and restorable |
| You switched from a local to a cloud model | One notice about what will be sent; **Local only** items stay out, and a chat tagged `local-only` is not sent |
| You switched to a model with a smaller window | The chat says so, and older messages are summarised before the next request |
| You reopened a chat after its files changed | Its working files and todos come back, and the files changed since are listed |
| The same conversation is open on two devices | Both continuations are kept as branches, and a **Continued on two devices** conflict lets you pick |
| You moved or renamed the project folder | Conversations follow the project (matched by its git repository); otherwise confirm once that it is the same project |
| You deleted something by accident | **Undo**, or restore it from Trash; older items from a backup |
| The storage provider is down or your credentials expired | Sync pauses with the reason and the fix (**Update credentials…**, **Sync settings…**); everything works locally |
| You forgot the sync passphrase | Nothing can decrypt the synced copies; your local data is intact. **Start over…** uploads this device's data under a new passphrase |
| An agent left code changes half done | The interrupted run lists its changed files with **Keep** / **Review diff**, and **Restore checkpoint** puts the files back as they were before the run |
| You want an earlier version of a conversation | **Versions → Restore** brings it back as a branch |

## Data management

**Settings → Continuity & sync** shows where your data is and how much space the change log, the search index,
attachments and backups use, and lets you:

- **Back up now** and **Restore from file…** (also **LocalPilot: Back Up Conversations and Memory Now** and **LocalPilot:
  Restore Conversations from Backup…**). A backup holds every change, memory note and attachment. Automatic backups
  run every 7 days into the data folder's `backups` folder (`localpilot.continuity.backup.enabled`,
  `backup.intervalDays`, `backup.keep`, 4 kept). A backup you make yourself can be encrypted with a passphrase
  (AES-256-GCM, key derived with scrypt); without the passphrase it cannot be read. Restoring merges: it adds what is
  missing and never removes newer data, and restoring the same backup twice changes nothing.
- **Empty Trash**, and set how long items stay in Trash (`localpilot.continuity.trashRetentionDays`, 30 days) and how
  much version history is kept (`localpilot.continuity.historyDays`, 90 days). Removing an item for good also removes
  its text from this computer's log and the attachments nothing else uses.
- **Rebuild index**, **Open folder**, **Remove migration backup** (with its size), and **Retry** for files the import
  could not read.
- `localpilot.continuity.indexMaxMB` (256 MB) caps the search index: past it, archived and deleted conversations older
  than 180 days are searchable by title only.

Your data on this computer is not encrypted by LocalPilot, just like your source code; use your operating system's disk
encryption.

## From the terminal

The `localpilot` CLI uses the same data and offers the same operations:

```bash
localpilot history --all-projects --view favorites   # also all, pinned, archived, trash; --tag t; --json
localpilot history search "in:errors ECONNREFUSED" --all-projects
localpilot history show s_01J...         # print a conversation (--branch b)
localpilot history export s_01J... --format md -o chat.md   # json, md, html, pdf; several ids -o folder
localpilot history import chat.json      # or a .lpshare file with --code
localpilot history trash s_01J...        # restore with: localpilot history restore s_01J...; purge deletes for good
localpilot history favorite s_01J...     # pin, archive, un…; tag <id> +a -b; rename <id> <title>
localpilot history versions s_01J...     # branches <id>; duplicate <id> [--from <messageId>]; merge <id> <id>
localpilot history share s_01J... -o chat.lpshare   # prints the share code once; open-share <file> --code CODE
localpilot history show --runs s_01J...  # its agent runs: outcome, model, tokens, what ran, files changed (--json)
localpilot recovery runs                 # runs a crash or a closed terminal cut off, with what ran (an id narrows it; --json)
localpilot memory list --type knowledge   # all types without --type; --all-projects; --trash; --json
localpilot memory add --type knowledge deploy-steps "kubectl rollout restart deploy/api"   # - reads stdin
localpilot memory search "rollout"        # every type; memory show|edit|rm|restore|move|pin|local-only|versions <id|name>
localpilot sync setup --backend folder --folder ~/Dropbox/localpilot   # asks for the passphrase (twice for a new one)
localpilot sync setup --backend s3 --endpoint https://s3.eu-west-1.amazonaws.com --bucket my-bucket --access-key AKIA…
localpilot sync status                   # also now, pause, resume, devices, conflicts (--json)
localpilot sync resolve cf_… --keep mine # passphrase, rotate-key, remove-device <id> [--rotate], off, start-over --yes
localpilot data stats                    # where the data is, sizes, index and import state
localpilot data backup --encrypt         # passphrase prompted, or LOCALPILOT_BACKUP_PASSPHRASE
localpilot data restore ~/backups/20261107-101500.lpbackup
localpilot data migrate --status         # also --retry, --remove-backup
localpilot data rebuild-index
```

Ids can be shortened to any unique prefix. In the interactive CLI, `/history search <words>`, `/trash` (and
`/trash restore <id>`) and `/branch` (`list`, `switch <n>`, `from <messageId>`) do the same for the current chat;
`/memory list|search|add|rm …` takes the `localpilot memory` actions (a bare `/memory` still shows the memory report). `history
delete <id>` still deletes a chat of this folder at once, as in 1.6.

`/sync` (`status`, `now`, `pause`, `resume`) works in the interactive CLI, and a CLI session syncs in the background like
VS Code. For unattended machines, set `LOCALPILOT_SYNC_PASSPHRASE` (and `LOCALPILOT_SYNC_SECRET` for the S3 secret key or
WebDAV password at set-up) instead of typing them. See
[Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}) for the rest of the CLI.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `localpilot.continuity.dataDir` | `~/.localpilot/continuity` | Where conversations, memory, the index and backups are kept |
| `localpilot.continuity.trashRetentionDays` | `30` | Days items stay in Trash; 0 keeps them until you empty it |
| `localpilot.continuity.historyDays` | `90` | Days of version history kept |
| `localpilot.continuity.indexMaxMB` | `256` | Largest search index; past it, old archived chats are searchable by title only |
| `localpilot.continuity.captureToolOutput` | `summary` | How much of each tool call's output a run's history keeps: `errors`, `summary` (first 2 KB), `full` |
| `localpilot.continuity.relatedConversations` | `true` | Offer related earlier conversations while you write the first message of a new chat |
| `localpilot.continuity.backup.enabled` / `.intervalDays` / `.keep` | `true` / `7` / `4` | Automatic local backups |
| `localpilot.memory.taskExpiryDays` | `14` | Days task memory is kept after its task is done |
| `localpilot.sync.enabled` | `false` | Turn sync on |
| `localpilot.sync.backend` | `folder` | `folder`, `git`, `s3` or `webdav`, with the settings of that backend: `sync.folder.path`; `sync.git.url`, `sync.git.branch`; `sync.s3.endpoint`, `.region`, `.bucket`, `.prefix`, `.accessKeyId`, `.pathStyle`; `sync.webdav.url`, `.username` |
| `localpilot.sync.intervalMinutes` | `5` | How often to sync |
| `localpilot.sync.categories` | all except checkpoint contents | What to sync |
| `localpilot.sync.maxAttachmentMB` | `20` | Largest attachment that is synced |
| `localpilot.sync.deviceName` | host name | How this device appears on your other devices |

<p><img src="{{ '/assets/screenshots/settings-sync.png' | relative_url }}" alt="Settings → Continuity &amp; sync → Sync: status with Sync now, Pause and Open Sync manager, storage (folder), Test connection, and what syncs" width="720"></p>

See also [Memory & planning]({{ '/docs/memory-and-planning/' | relative_url }}),
[Self-healing & recovery]({{ '/docs/self-healing/' | relative_url }}) and
[Parallel agents & changes]({{ '/docs/parallel-agents/' | relative_url }}).
