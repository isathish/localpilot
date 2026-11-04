---
title: Features
description: Everything LocalPilot does in VS Code, from setup to models, the agent, parallel work, change review, tools, the CLI and the dashboard, with links to the details.
permalink: /docs/features/
---

![LocalPilot agent session in VS Code: read cart.js and its test, a +1/−1 edit, npm test passing in the LocalPilot Agent terminal, and Apply to workspace / Discard]({{ '/assets/screenshots/hero-agent.png' | relative_url }})

LocalPilot is a coding agent for VS Code. It reads your project, edits files, runs commands and tests, and shows you every diff before you keep it. It runs on models on your machine. You can also add a cloud model with your own key, and automatic picks keep preferring local models. This page lists every feature in the order you meet them. Each section links to the details.

## 1. Get set up

- **First-run setup.** A three-step welcome checks the usual local ports, lists the servers it found and their models, recommends a model, and sets an approval preset. No server running? It links to adding a custom endpoint or a cloud API. See [Getting started]({{ '/docs/getting-started/' | relative_url }}).
- **Automatic model setup.** With no model anywhere, one click installs or starts Ollama, without admin rights, and downloads a starter model sized for your RAM and GPU, smallest first.
- **Background services.** LocalPilot starts a local Ollama that is installed but stopped and keeps it running while VS Code is open, and Redis when Redis storage is on. A request that needs a stopped Ollama starts it first, in VS Code and in the CLI, and a chat set to a local model is never moved to a cloud model because its server is down. Failed restarts back off. *LocalPilot: Show Background Services* shows their state. Opt in to `localpilot.supervisor.autoInstall` to install Ollama and a starter model without being asked.
- **Models are picked up as they appear.** Servers are re-checked in the background, so a model you pull or a server you start shows up within seconds.

## 2. Pick your models

![Settings → Providers: providers grouped under Local and Cloud, each card showing where it runs, its API and its status]({{ '/assets/screenshots/settings-providers.png' | relative_url }})

- **Local servers, detected automatically:**
  - Ollama, LM Studio, llama.cpp, vLLM, SGLang, Docker Model Runner, Jan, LocalAI and KoboldCpp
  - GPT4All and text-generation-webui as one-click presets in **Settings → Providers**
  - model servers running in Docker containers
- **Cloud APIs with your own key:**
  - OpenAI, Anthropic (Claude), Google Gemini, OpenRouter, Groq, Mistral, DeepSeek and xAI
  - Together, Fireworks, Cerebras, Hugging Face, NVIDIA NIM, Moonshot, Alibaba Qwen, Azure OpenAI and Ollama Cloud

  Claude uses its native API, with tool use, thinking and prompt caching. See [Cloud models]({{ '/guides/cloud-models-vscode/' | relative_url }}).
- **Gateways.** OmniRoute and LiteLLM run on your machine and forward to many cloud providers. They are treated as cloud. See [OmniRoute & LiteLLM]({{ '/guides/omniroute-vscode/' | relative_url }}).
- **Keys stay out of settings.json.** A pasted key goes to your OS keychain, and settings hold only `${secret:<id>}`. A key can also come from an environment variable (`${env:OPENAI_API_KEY}`). The provider card says when a key is missing, never what it is.
- **Local first, cloud when you choose.** Cloud models are marked **cloud** everywhere. Auto, subagents, images and ghost text prefer local models and use a cloud model only when nothing local fits, or when you pick it.
- **Model manager.** **Settings → Models** shows what this machine can run (a model budget from RAM and GPU), what is installed, and which model handles which task. It installs from a curated catalog to Ollama, Docker Model Runner or LM Studio.
- **Model gallery.** Search the Ollama library, Docker Hub's `ai/` models and Hugging Face GGUF repositories. Every size is marked *fits*, *tight* or *too big*.
- **Automatic routing.** Images go to a vision model, ghost text to a small fill-in-the-middle model, Plan mode to an optional reasoning model, and read-only subagents to a small fast model. An offline model falls back to the best available one.
- **Thinking chosen per task** (`localpilot.thinking`: `auto`). More reasoning for Plan and Debug, medium for the agent, light for Ask and subagents, none for quick helpers.
- **Learns which models work for you.** Local run history (finished runs, speed, errors, accepted completions) ranks your installed models per role. Auto routing follows the rankings, with Undo (`localpilot.models.autoTune`).
- **Fast local starts.** The model loads when you focus the chat box. Models already in memory are preferred. Ollama starts with flash attention and a q8_0 KV cache, which uses about half the memory of f16.
- **Huge MoE models with colibri.** A running `coli serve` is detected. Memory fit uses only the part that stays in RAM. See the [colibri guide]({{ '/guides/colibri-vscode/' | relative_url }}).
- **Failures handled for you.**
  - Cloud rate limits are waited out as long as the provider asks.
  - Parameters a model rejects are adjusted, and the fix is remembered.
  - A rejected key or an exhausted quota is reported at once, with where to fix it.

See [Models & providers]({{ '/docs/models/' | relative_url }}).

## 3. Work with the agent

- **Five modes.**
  - **Agent** edits and runs commands.
  - **Multitask** splits work across background workers.
  - **Debug** reproduces a bug before fixing it.
  - **Plan** writes a plan without editing.
  - **Ask** answers read-only.

  See [Agent modes]({{ '/docs/agent-modes/' | relative_url }}).
- **Questions before it starts.** For a new feature or an open-ended request, the agent reads the code first. Then it asks up to four questions in one card. Each option explains itself and one is marked **Recommended**. You answer with <kbd>1</kbd>–<kbd>9</kbd> and <kbd>Enter</kbd>, or **Skip**. Clear requests start at once (`localpilot.clarify.questions`).
- **Understands terse requests.** "fix this" or "make it faster" gets a snapshot of your editor, errors and git state. The agent states how it understood the request before acting.
- **Improve prompt** (<kbd>⌘I</kbd> / <kbd>Ctrl+I</kbd>). It rewrites your draft into a precise request that names the real file, function or selection. It never adds requirements. <kbd>⌘Z</kbd> brings your original back.
- **Misspelled names corrected.** `dicee.py` → `dice.py`, `rollDise` → `rollDice`, matched against your workspace before the agent starts (`localpilot.prompts.autoCorrect`).
- **A transcript you can follow.**
  - Reasoning, steps and status stream live.
  - A one-line work strip says what the agent is doing.
  - Bursts of read-only steps (reads, searches, symbol lookups, web lookups, diagnostics) fold into one row, "Explored 7 files · 3 searches", and the view stays pinned to the bottom when groups fold away.
  - Web results show as link cards.
  - ```` ```mermaid ```` blocks in answers are drawn as diagrams (bundled, offline), with **Source**, **Copy source** and **Open in reader**.
  - File links in answers are checked: a path that names no file in the workspace shows as plain code instead of a link that would fail.
  - While the model thinks for more than a few seconds, a short tip about a feature shows under the status line (`localpilot.showTips`).
- **Task header.** A card under the tabs shows the chat's first prompt (click to expand it), the folder or isolated worktree it runs in, its tokens and, for priced cloud models, its cost, plus **Copy** and **Delete** (the tooltip gives the size on disk). Fold it away with its chevron; it stays folded.
- **What's new.** After an update, the empty chat shows the top items of the new version's changelog once, with **Open changelog**. Nothing is fetched from the network.
- **Every answer shows its model and speed,** with Copy, **Regenerate** and Open as document. A failed answer keeps **Retry** and **Change model**.
- **Quote and find your place.** Select text in an answer and click **Quote**. The quote shows above the input (✕ removes it) and is sent in front of your reply as a `> ` block. When you scroll up past your last request, a strip at the top shows it; click the strip to jump back to it.
- **Sessions.** Chats are saved per workspace, with a history panel, fork, pin, rename and export to Markdown. **Edit** any of your messages, or use **Restore checkpoint** to restore the files, the conversation, or both ([details](#checkpoints)). Restore checkpoint applies to chats that edit the workspace directly; in an isolated worktree chat use **Discard**, or **Edit** and **Reset Chat** to rewind only the conversation.
- **Slash commands.** `/help`, `/model`, `/mode`, `/compact` (or `/smol`), `/newtask` (continue in a new chat that starts from a summary of this one), `/deep-planning <task>` (investigate, ask, then write `implementation_plan.md`), `/team <task>` (split the work for background workers and the shared board), `/newrule` (or `/init`, write a project rule file in `.localpilot/rules/`), `/<skill-name> <task>`, `/clear`, `/skills`, `/agents`, `/commands`, `/skill`, `/agent`, `/memory`, `/permissions`, `/hooks`, `/context`.
- **The chat goes where you want it.** Primary or Secondary Side Bar, bottom Panel or an editor tab (**Move Chat To…**). It works the same in each, down to narrow widths.

![A finished agent turn: a step summary (read, searched, edited +6 −4, ran pytest), the answer with a list, inline code and a syntax-highlighted code block with Copy, Insert and Save actions]({{ '/assets/screenshots/chat-rendering.png' | relative_url }})

## 4. Stay in control

- **Approvals.** Commands and deletes ask first by default, while edits and web access are allowed. Each action can be set to Always, Ask or Never, or use a preset: *Careful*, *Balanced* or *Autonomous*.
- **Auto mode** (⚡ in the status bar). A small local model reviews actions that would ask for approval, and approves the ones that clearly serve your request inside the project. Pushes, `sudo`, recursive deletes, publishing and writes to secrets or `.git` always ask. The reviewer can only approve, never deny.
- **Pause, steer, stop.** Pause after the current step, type a correction the agent reads when it resumes, or stop. Works for the whole run or a single subagent. **Send after this turn** queues a message for the next turn. A banner lists queued messages so you can cancel or edit them before they are sent.
- **Permission rules and hooks.** Claude Code `settings.json` allow, ask and deny rules and hooks apply as written.
- **Safe commands.** Destructive commands are detected. Stop and timeouts kill the whole process tree.

## 5. Run work in parallel

![Three agents running in parallel: a tab per task, pause and stop for each, the Agents panel and the status bar count]({{ '/assets/screenshots/parallel-agents.png' | relative_url }})

- **Run Tasks in Parallel** (<kbd>⌘⇧⌥P</kbd>) starts one agent per task, each in its own tab.
- **Isolated worktrees.** In a git repository each agent works in its own git worktree (`localpilot.worktrees.mode`). You **Apply to workspace** or **Discard** its result.
- **Best of N.** Run one task on 2 to 8 models, compare the results and keep the best.
- **Task queue.** *LocalPilot: Queue Agent Task…* lines tasks up, each with its own mode and model, optionally waiting for others to succeed first. They run one at a time or side by side (`localpilot.queue.concurrency`). The queue survives a reload.
- **Several models at once.** A busy model's extra work goes to a comparable idle model that fits alongside it (`localpilot.routing.parallelModels`).
- **Agents panel.** Running, queued and idle work, the files each run changed, and Stop, Keep and Undo.

See [Parallel agents & change review]({{ '/docs/parallel-agents/' | relative_url }}).

## 6. Review every change

![Side-by-side diff of the agent's edit, opened from the changed-file list in the chat]({{ '/assets/screenshots/review-diff.png' | relative_url }})

- **See an edit before you approve it.** When an edit asks for approval, a side-by-side diff (`Original ↔ LocalPilot (proposed)`) of exactly what `edit_file`, `write_file` or `apply_patch` will write opens next to the approval card, without taking focus. It closes when you approve or deny, and an approved file then opens normally. The `write_file` card itself shows the diff (or the first 200 lines of a new file). `localpilot.diffPreview`: `onApproval` (default), `always` (also for edits approved automatically) or `off`.
- Each file is snapshotted before the agent edits it. Changed lines are highlighted in open editors.
- The changes card above the chat box lists every changed file. Open a diff, or accept or reject per file or all at once.
- Changes are tracked per session, so rejecting one agent's work never touches another's.
- <a id="checkpoints"></a>**Checkpoints.** Before each message you send, LocalPilot records the state of the workspace. In a git repository this is a private ref, `refs/localpilot/checkpoints/<chat>/<turn>`, made with `git stash create` plus a commit of the untracked (not ignored) files, so changes made by `run_command` are captured too. Your branches, index and `git stash list` are not touched, and chats in an isolated worktree are checkpointed inside the worktree. Outside git, the files the agent edits are snapshotted to disk, so **Restore checkpoint** still works after a reload. In a multi-root workspace only the first folder is checkpointed (a warning says so). The refs and snapshots are deleted with the chat, in VS Code and with `localpilot history delete` (which prints how much they held, and separately the size of the chat's command logs). **Settings → Memory & history** includes them in the **On disk** figure: the snapshots plus the git objects that only checkpoints keep (git frees those at its next `gc` once the refs are gone). Leftovers from deleted or old CLI chats are removed once they have had no new checkpoint for 14 days, so a chat still in use in another window on the same repository keeps its refs. A file larger than 20 MB is snapshotted in memory only, so it can be restored until the window reloads. Turn git checkpoints off with `localpilot.checkpoints.enabled`.
- **Restore checkpoint.** The **Restore checkpoint** button on one of your messages opens a menu:
  - **Restore files only** puts the files back as they were before that message and keeps the chat.
  - **Restore chat only** removes that message and the turns after it, and leaves the files as they are.
  - **Restore both** does both.

  A restore that removes messages puts the message's text, images and attachments back in the composer. In a git repository, files come back from the git checkpoint, so files created or deleted by shell commands are restored too. Before restoring, LocalPilot saves your current state with `git stash push --include-untracked -m "localpilot pre-restore"`, so you can get it back with `git stash pop`. LocalPilot refuses to restore if HEAD has moved past the checkpoint (for example, after the agent made a commit), because that would lose commits. Ignored files are never touched. If the agent is still running, it is stopped first. The button is disabled when there is no checkpoint for that message. When checkpoints are off, clicking it opens the setting.
- **Edit a past message.** Click one of your messages (or its **Edit** pencil) to edit it in place. You can change the text and remove its images and attachments; **Esc** cancels, and nothing is removed until you choose:
  - **Reset Chat** (or **Enter**) removes that message and the turns after it, sends the edited message, and leaves the files as they are.
  - **Reset Code** also puts the files back to the checkpoint taken before that message, then sends the edit. It shows a spinner while LocalPilot checks for the checkpoint, and is disabled when there is none.

  An empty edit is refused.
- **View changes.** When the latest turn changed at least one file, its answer shows a **View changes** button. It opens every file changed since your last message in one multi-file diff, including files changed by commands. **Review all** in the changes panel does the same for every file the chat changed. Files outside the workspace are left out. Files over 50 MB are compared as empty.
- **Ship it as a pull request.** `/pr` checks what changed, runs the checks that cover it, commits on a new branch, pushes and opens a pull request with a description of what changed and how it was verified. `/fix-ci` reads the failing checks of the branch, reproduces the failure locally, fixes it and pushes. Behind them are tools the agent also uses on its own: `git_status`, `git_commit` (asks like any edit), `git_push` (asks like a terminal command; never force-pushes, and refuses the default branch unless you ask), `pull_request` (create, view, list, comment) and `ci_status` (workflow runs, the log lines of failed steps, re-run). Pull requests and CI use the [GitHub CLI](https://cli.github.com) (`gh auth login` once). Commands run without a shell, so nothing in a commit message or branch name is executed. A project's own `.claude/commands/pr.md` replaces the built-in `/pr`.

## 7. Context, memory, tools and skills

- **Long tasks in small windows.** A per-model token budget prunes old tool output first, then summarises older turns. An 8k model still finishes. See [Context]({{ '/docs/context/' | relative_url }}).
- **@ mentions.** `@workspace`, `@selection`, `@problems`, `@git`, `@editors`, `@terminal`, files, `file#L10-L20` ranges and folders, with fuzzy search across the whole workspace.
- **Your rules, as they are.** `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules`, `.github/copilot-instructions.md` and `.localpilot/rules.md`.
- **Memory.** Project and global notes the agent saves and recalls in later sessions, with size limits so they stay useful. See [Memory & planning]({{ '/docs/memory-and-planning/' | relative_url }}).
- **Tools:**
  - files: read, edit, write, list, delete, and `apply_patch` (one `*** Begin Patch` patch that updates, adds, moves and deletes several files after a single approval; context is matched exactly, then ignoring trailing and then surrounding whitespace, and line endings are kept)
  - search: ripgrep, symbols and references, a repository map
  - shell, diagnostics, and a checklist
  - web search (DuckDuckGo, SearXNG, Brave, Tavily) and fetch
  - a headless browser for screenshots and DevTools inspection
  - subagents, and any MCP server's tools

  Models without native tool calling use a text protocol. See [MCP]({{ '/docs/mcp/' | relative_url }}).
- **Skills and subagents.** 14 built-in skills load when a request matches them. Install more from GitHub, or let a recurring request become a new skill. Nine subagents are built in: `clarifier`, `explore`, `planner`, `coder`, `tester`, `debugger`, `reviewer`, `docs` and `researcher`. Add your own in `.localpilot/agents/`. See [Skills & subagents]({{ '/docs/skills-and-agents/' | relative_url }}).
- **Claude Code compatibility.** Skills, agents, custom commands, plugins, permission rules and hooks from `.claude/` work unchanged. See [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}).
- **Images and browser.** Capture a region, window or screen (<kbd>⌘⌥⇧S</kbd>), or paste or drop an image. Images go to a vision model. The agent can screenshot and inspect web pages and local dev servers. See [Screenshots & images]({{ '/docs/images/' | relative_url }}).

## 8. In the editor, terminal and CLI

- **Inline edit** (<kbd>⌘⌥K</kbd>) rewrites a selection in place, with Keep and Undo. In a terminal, the same key writes a command.
- **Light bulb and context menu.** Explain, Fix, Refactor, Generate Tests, Add Documentation, Fix Errors in File. The light bulb also offers **Add to LocalPilot Chat**, **Explain with LocalPilot** and **Improve with LocalPilot**; with nothing selected they take the cursor line and 3 lines either side. **Fix with LocalPilot** is the preferred quick fix when the line has errors or warnings.
- **Inline completions.** Ghost text from a small fill-in-the-middle model. A cloud model is used only if you choose one for completions; then the code around the cursor goes through chat.
- **Commit messages.** The sparkle button in the Source Control title writes the message straight into the commit box with one model call (no agent, no tools): it uses the staged diff, else all changes (cut at 5,000 characters), treats any text already in the box as notes, and follows the commit conventions in your project rules. With several repositories with changes it asks which one, or **All**. While it writes, the button becomes **Stop**. **Commit with Agent…** (in the Source Control **⋯** menu) runs the old agent session instead.
- **Jupyter notebooks.** In a `.ipynb` notebook, the toolbar's **Generate Cell with LocalPilot** asks what to add and has the agent insert a cell after the selected one; each cell's title bar has **Explain Cell** (starts a chat) and **Improve Cell** (asks what to change, then replaces the cell). The agent edits cells with the `notebook_edit` tool (insert, replace or delete by cell number; asks like any edit), so it never rewrites the notebook JSON; it sees the cell's type, source, execution count and text outputs plus the two cells on either side. In the CLI, `notebook_edit` edits the `.ipynb` file directly.
- A **[Markdown reader]({{ '/docs/viewers/' | relative_url }})** for long answers and the plans and reports the agent writes, with Mermaid diagrams, math, scroll sync with the source and an "Open With…" editor for any `.md` file.
- **Agent terminal.** Commands run in a visible **LocalPilot Agent** terminal. Right-click any terminal for **Explain Terminal Output**, **Fix Failed Command** or **Add Terminal Output to Chat**.
- **The `localpilot` CLI.** It is the same agent in any shell, with approvals, a REPL, isolation in a worktree, skills, `models` and `doctor`. `localpilot providers` adds and checks local and cloud providers and sets keys; it keeps its own key file because the CLI cannot read the keychain. See [Terminal & CLI]({{ '/docs/terminal-and-cli/' | relative_url }}).

## 9. Measure, configure, extend

- **Dashboard.** Runs, tokens, speed and first-token time per model, tool failures, accepted completions, provider health, **Model tuning** and a live log. Everything stays in `~/.localpilot/telemetry`, or optionally in your own Redis. See [Dashboard]({{ '/docs/dashboard/' | relative_url }}).
- **Settings.** The gear in the chat toolbar opens one page for everything. **Search settings** (<kbd>⌘F</kbd> or <kbd>/</kbd>) jumps to any setting. Each value shows whether it comes from User or Workspace settings. See [Configuration]({{ '/docs/configuration/' | relative_url }}).
- **Provider manager.**
  - Configured providers grouped under Local and Cloud, with live status.
  - **Add a provider** by kind (On this machine, Cloud APIs, Gateways) or by search.
  - A **Get an API key** link for each cloud provider, and **Test connection** to list a provider's models.
- **VS Code platform.**
  - `@localpilot` in the built-in Chat view (`/agent`, `/ask`, `/plan`).
  - Your models in VS Code's language-model picker, with cloud ones labelled.
  - An extension API: `runPrompt`, `runParallel`, `runBestOfN`, `queue`, `send`, `stop`, `applyWorktree`, `listModels`. See [Development]({{ '/docs/development/' | relative_url }}).
- **Private by default.** No account and no telemetry upload. Code goes only to the providers you configure. See [Privacy]({{ '/privacy/' | relative_url }}).
- **Web access switch.** Set `localpilot.webSearch.enabled` to `false` and the agent gets no `web_search`, `web_fetch` or browser tools, and `@https://…` mentions are not fetched. Your model providers keep working.
- **Response language.** `localpilot.preferredLanguage` makes the agent answer in one of 18 languages, in the chat and the CLI, while code and commands stay as written.

Small local models are weaker than frontier cloud models. Give them precise instructions and review more. Or pick a cloud model for the hard tasks and keep local models for the rest.
