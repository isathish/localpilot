---
title: Skills & subagents
description: Package know-how as SKILL.md playbooks, install skills from GitHub, and delegate work to subagents with their own context window.
permalink: /docs/skills-and-agents/
---

A **skill** is a Markdown playbook the agent loads when a request needs it. A **subagent** is a separate agent with its own system prompt, tools and context window that the main agent can hand work to. LocalPilot ships 14 skills and 9 subagents, and reads the same file formats as Claude Code and GitHub Copilot.

## Skills

### Write a skill

A skill is a folder with a `SKILL.md` file: YAML front matter, then Markdown instructions. Existing Claude Code and Copilot skills work unchanged.

```
.localpilot/skills/deploy-checklist/SKILL.md
```

```markdown
---
name: deploy-checklist
description: Steps to safely ship a release of this service. Use for "deploy", "release", "ship".
---
# Deploying
1. Run `npm test` and `npm run lint`.
2. Bump the version in package.json …
```

The `description` decides when the skill is suggested. Use the words people actually type and quote two or three trigger phrases, as above.

### Where skills are found

LocalPilot searches these folders in order. A skill found earlier overrides one with the same name found later.

| Order | Location |
|---|---|
| 1 | `<workspace>/.localpilot/skills/*` |
| 2 | `<workspace>/.claude/skills/*` |
| 3 | `<workspace>/.github/skills/*` |
| 4 | `~/.localpilot/skills/*`, `~/.claude/skills/*`, `~/.agents/skills/*` |
| 5 | Folders listed in `localpilot.skillsPaths` |
| 6 | Skills bundled with LocalPilot |

[Plugins]({{ '/docs/claude-code-compatibility/' | relative_url }}#plugins) can also contribute skills.

### Built-in skills

LocalPilot ships 14 playbooks that cover the development loop from idea to release. They live in the extension's `skills/` folder.

- To customise one, copy it into `.localpilot/skills/<name>/`. Your copy wins.
- To hide one, switch it off in **Settings → Skills & subagents**.
- To turn all of them off, set `localpilot.skills.builtin` to `false`.

| Skill | What it does |
|---|---|
| `requirements` | Turns a vague idea into a short spec: goals, user stories, acceptance criteria, non-goals |
| `design` | Architecture, file and module layout, data model, API and decisions, ending in an ordered todo plan |
| `new-project` | Picks a stack, scaffolds tooling and layout, builds and verifies a first working slice, plans next features |
| `implement` | Explore, plan, make small verified edits, check diagnostics/build/tests, summarise |
| `test` | Detects the framework, writes focused tests with edge cases, runs them and fixes real failures |
| `debug` | Reproduce, localise, form a hypothesis, fix the root cause, add a regression test |
| `review` | Findings ranked by severity (correctness, OWASP security, performance, tests) with `file:line` fixes |
| `refactor` | Behaviour-preserving restructuring, guarded by tests and diagnostics |
| `ui-design` | Hierarchy, spacing, typography, colour tokens, states, responsive layout and accessibility, verified with `browser_inspect` |
| `claude-ui-ux` | Calm, typography-led interfaces and assistant UX patterns: streaming, tool steps, permission prompts, plan panels, empty and error states |
| `docs` | README, guides, API docs and changelog, checked against the code |
| `deploy` | Dockerfile, CI, env and secrets, health checks, release checklist; runs the deploy when the CLI is available |
| `ship` | Final verification, conventional commit message, PR description; no git action without your permission |
| `explore-codebase` | A map of an unfamiliar repo (layout, entry points, request flow, conventions), saved to memory |

The agent loads a skill when your request matches it ("write a spec for…", "review this", "deploy it"). To force one, type `/skill implement …`.

### Install skills

You can install any skill in the [Agent Skills](https://agentskills.io) format. Pick one of these:

| Where | How |
|---|---|
| Settings | **Settings → Skills & subagents** (*LocalPilot: Manage Skills*): search the registry, click **Install**. Or use **Install from URL or folder…** |
| Command Palette | *LocalPilot: Install Skill…* |
| Chat | `/skill install anthropics/skills/skills/pdf` |
| Terminal | `localpilot skill install owner/repo[/path] [--user]` |

Accepted sources:

- `owner/repo`, `owner/repo/path/to/skill`, `owner/repo@ref/path`
- `https://github.com/owner/repo/tree/<ref>/<path>` or a `blob` link to a `SKILL.md`
- `https://raw.githubusercontent.com/…/SKILL.md`, or any other `https://…/SKILL.md`
- a local folder

What happens on install:

1. If the source holds several skills, you pick which ones to install.
2. Each skill is copied with its companion files (`scripts/`, `reference.md`, …) into `.localpilot/skills/<name>/` in the workspace. For *My skills* or `--user` it goes to `~/.localpilot/skills/`.
3. An existing skill with the same name is replaced only after you confirm.
4. The skill list refreshes at once. The `/skill` menu, suggestion chips and Settings see it without a reload.

For private repositories or higher GitHub API limits, set `GITHUB_TOKEN` (or `GH_TOKEN`) in the environment.

### The Skills settings page

Open it with *LocalPilot: Manage Skills*, or **Manage skills…** in the chat's Skills menu. It has these sections:

| Section | What you can do |
|---|---|
| **How skills are used** | Set the registry mode for new chats (`localpilot.skills.autoInstall`: Auto / Ask / Off), where registry installs go (`localpilot.skills.autoInstallScope`), and the built-in skills switch |
| **Installed skills** | See each skill's source (workspace, user, built-in) and how often it was loaded. Enable or disable it, **Open SKILL.md**, or **Delete** it. Built-in skills can only be disabled |
| **Suggested skills** | Recurring request types that no skill covers yet (see [below](#learning-which-skills-you-are-missing)) |
| **Skill registry** | Search all configured repositories as you type, filter by *Not installed / Installed*, choose the install target and click **Install**. Below it, each repository's index status (skill count, age, last error) and **Re-index now** |
| **Skill & plugin folders**, **Subagents** | Extra skill folders (`localpilot.skillsPaths`), extra Claude Code-style plugin folders (`localpilot.pluginPaths`) and the subagent list |

![Skills & subagents settings page: registry mode, install target and the built-in skills switch]({{ '/assets/screenshots/settings-skills.png' | relative_url }})

A disabled skill (`localpilot.skills.disabled`) stays on disk. The agent cannot see, suggest or load it.

### The skill registry

`localpilot.skills.repositories` lists skill collections that LocalPilot can install from when a request needs them. The defaults are:

- [`anthropics/skills`](https://github.com/anthropics/skills): PDF, Word, PowerPoint, Excel, frontend design, MCP builder and more
- [`obra/superpowers`](https://github.com/obra/superpowers): writing plans, brainstorming, systematic debugging, test-driven development and more
- [`github/awesome-copilot`](https://github.com/github/awesome-copilot): documentation, architecture, analysis, cloud and more

LocalPilot downloads the names and descriptions of these skills once a day into `~/.localpilot/skill-catalog.json`, shared with the CLI. Skill bodies are only downloaded when a skill is installed. To stop all registry traffic, set `localpilot.skills.autoInstall` to `off` (see [Privacy]({{ '/privacy/' | relative_url }})).

The registry mode decides what happens when the best match for a request is a skill you have not installed:

| `localpilot.skills.autoInstall` | Behaviour |
|---|---|
| `auto` (default) | The skill is installed as the request starts and loaded like any other. The turn shows *Installed "writing-plans" from obra/superpowers/skills for this request* |
| `ask` | An **Install "…"** chip appears under the request and stays there after the answer, until your next request. Nothing is downloaded until you click it. Once installed, a **Use "…"** chip prefills `/skill <name>` with your last request. If the download fails, the chip offers **Retry install** |
| `off` | The registry is never consulted |

Installed skills are matched and preloaded in every mode.

`localpilot.skills.autoInstallScope` sets where auto-installed skills go: `user` (`~/.localpilot/skills`, the default, nothing is added to your project) or `workspace` (`.localpilot/skills`, shared with your team).

A registry skill is only chosen on a specific match:

- The request must contain the skill's name words (`pdf`, `architecture blueprint`), a quoted trigger phrase from its description, or words that are rare across the whole registry. Everyday format names count: "an Excel spreadsheet" matches `xlsx`, "a PowerPoint deck" `pptx`, "a Word document" `docx`.
- A skill named after an action (`convert-excel-to-md`) is only chosen when the request asks for that action.
- A single common word such as "add", "review" or "markdown" never pulls in a skill.
- A registry skill must clearly beat every installed skill, so your own skills and the built-ins keep priority.
- A skill you delete after an automatic install, or decline with *Not now*, is not installed again. A skill you disabled is never downloaded again either. A skill auto-installed into another project's `.localpilot/skills` can still be installed here.
- A replacement download is staged first, so a failed update keeps the copy you have. With `GITHUB_TOKEN` or `GH_TOKEN` set, private repositories work for both the index and the files.
- Right after start-up or adding a repository, the first request waits up to 5 seconds for its index, so it is not matched against an empty list.

To search the registry yourself, run `localpilot skill search <words>` in a terminal (add `--install` to install the best match), use *LocalPilot: Browse Skill Registry (Quick Pick)…*, or type `/skill browse <words>` in the chat.

### Per-chat skill settings

The **Skills** button under the composer changes skill behaviour for one chat. The button label shows *N pinned* or the overriding mode.

| Control | Effect | Slash command |
|---|---|---|
| Mode | **Inherit global**, **Auto**, **Ask** or **Off**. Per chat, **Off** also turns off suggestions and preloading: only skills you force or pin are used | `/skill mode auto\|ask\|off\|inherit` |
| Pin | The skill's instructions are loaded into every request of the chat, whatever you type. Useful for a project convention or a release procedure | `/skill pin <name>`, `/skill unpin <name>` |

`/skills` lists all skills and shows the chat's current mode and pins.

### How the model sees skills

The system prompt lists only the name and description of each enabled skill, plus rules: use only these names, load a skill before acting on it, and never claim to have followed a skill that was not loaded.

The `load_skill` tool lists the allowed names in its parameter description (as an enum when there are few). If the model mangles a name (`PDF`, `pdf_skill`, `pfd`), LocalPilot resolves it to the installed skill and says so. An unknown name returns a *did you mean* list.

### Preloading

When a skill clearly applies, the model does not need to call `load_skill`. LocalPilot adds the skill's full text to the request as a hidden message. That message gives the reason (*it matches this request*, *you asked for it*, *it is pinned to this chat*, or *it was just installed*) and says the steps must be carried out, not summarised.

A skill is preloaded when:

- its name or a quoted trigger phrase appears in the request, or
- it is pinned to the chat, or
- you forced it with `/skill <name> …`, or
- the request is brief (24 words or fewer) and has exactly one looser match. This saves a model round trip; the note lets the model ignore the skill if it does not fit.

Limits:

- Preloaded text is capped at about a fifth of the model's context window (at most 24,000 characters), so a long playbook cannot crowd out the code.
- A skill already in the conversation is not loaded twice.
- Requests that name a tool directly ("use write_file to…") get no skill.

The turn shows **Using skill: name** chips for preloaded skills and **May also apply** chips for looser matches. The model may load a looser match with `load_skill` or ignore it.

### Recommendations

Each request is matched against the name, quoted trigger phrases and description terms of every skill. Terms are weighted by how distinctive they are among your installed skills, so *bug* counts for more than *code*.

- Strong matches are preloaded (see above).
- Weaker matches are passed to the model as a hint and shown as chips under the turn. Click a chip to force the skill.
- A request that matches no skill's own words ("add a logout button", "hello") gets no recommendation.
- An apostrophe inside a word (*doesn't*) is not read as a quote mark.

### Learning which skills you are missing

LocalPilot records the kind of each request (main verb plus key nouns, for example `deploy · api · staging`) and which skills were loaded for it.

1. When the same kind of request has come up three times with no skill covering it, the chat offers **Create "&lt;name&gt;" skill**.
2. Clicking it prefills a prompt that asks the agent to write `.localpilot/skills/<name>/SKILL.md` from what worked in this project, then reload skills.
3. **Not now** stops the suggestion for that topic.

The data is a small JSON file, `skill-learning.json`, in the extension's global storage (`~/.localpilot/` for the CLI). Entries expire after 60 days.

## Subagents

### Write a subagent

A subagent is a Markdown file. The front matter configures it and the body becomes its system prompt.

```
.localpilot/agents/migrator.md
```

```markdown
---
name: migrator
description: Converts JavaScript files to TypeScript one at a time.
tools: read_file, write_file, edit_file, run_command, get_diagnostics
model: ollama/qwen2.5-coder:32b
skills: ts-conventions
---
You convert JS to idiomatic TS. Preserve behaviour, add precise types, run tsc after each file…
```

| Field | Meaning |
|---|---|
| `tools` | Restricts the tool set. Omit it to allow all tools |
| `model` | Overrides the session model. Use a bigger model for hard sub-tasks, a smaller one for exploration |
| `skills` | Installed skills whose instructions are preloaded into every run of this subagent |

Subagent files are read from `.localpilot/agents`, `.claude/agents`, `~/.localpilot/agents` and `~/.claude/agents`, and from plugins.

### Built-in subagents

LocalPilot ships 9 subagents. Every one can use `load_skill`.

| Name | Purpose | Tools |
|---|---|---|
| `clarifier` | Turns a vague brief into a precise task: *Understood as / Assumptions / Alternatives / Suggested approach / Open question* | read-only |
| `explore` | Read-only codebase exploration and Q&A with `path:line` findings | read-only |
| `planner` | Ordered implementation plan (files, approach, risks, verification); no edits | read-only |
| `coder` | Implements a well-specified change end to end, verifies with diagnostics and tests | all |
| `tester` | Writes tests in the project's framework and conventions, runs them, reports real bugs | all |
| `debugger` | Reproduce, trace, find the root cause, make a minimal fix, re-verify | all |
| `reviewer` | Bugs ranked by severity, security (OWASP), error handling, conventions; no edits | read-only + `run_command` |
| `docs` | README sections, doc comments and changelog entries in the project's tone | all |
| `researcher` | Web research with cross-checked sources and citations | `web_search`, `web_fetch`, `read_file`, `gather_context` |

"Read-only" means `read_file`, `list_dir`, `file_search`, `grep_search`, `find_symbol`, `find_references`, `get_diagnostics`, `get_editor_state`, `gather_context` and `analyze_workspace`.

Rules that apply to every built-in:

- A subagent cannot ask you anything. When its brief is ambiguous it calls `gather_context`, reads the code, picks the most plausible reading and states it under **Interpretation** at the top of its report.
- Names are matched loosely: `review`, `debug`, `test`, `plan` and `Explore agent` all resolve. An unknown name falls back to `explore`, with a note in the result.
- A workspace or user agent file with the same name replaces the built-in.

`/agents` lists all subagents.

### How delegation works

The main agent calls `run_subagent` for one child or `run_parallel_subagents` for several at once. You can delegate directly with `/agent <name> <task>`.

Each child:

- starts with a fresh context window,
- cannot see the parent's conversation,
- returns only its final report.

So the prompt must contain everything the child needs: goal, files or symbols, constraints and what to return.

### Skills in subagents

Each subagent receives skills from four sources:

1. **The parent's active skills.** Skills the parent preloaded, pinned, forced with `/skill` or loaded with `load_skill` in this turn are passed down in a preloaded `<skill>` block. This applies to `run_subagent`, `run_parallel_subagents` and `run_todos_parallel`.
2. **Its own brief.** A strong match on the subagent's task loads that skill, even if you never mentioned it.
3. **Its agent file.** The `skills:` front-matter field.
4. **The task itself.** `run_subagent`, `run_parallel_subagents` tasks, `run_todos_parallel` tasks and `manage_todos` items all accept a `skills` array.

Disabled skills are filtered out at every level. A subagent without `load_skill` in its tool list is told that relevant skills are already in its brief.

### Model fallback for read-only subagents

Read-only subagents run on a small *fast* model when routing finds one. If that model sends no first token within a minute, the subagent falls back to the parent's model instead of failing. The router then skips the unresponsive model for 10 minutes. A broken or half-downloaded small model costs one subagent one minute, not the whole run.

## Understanding vague requests

Many prompts are terse: *fix this*, *make it faster*, *tests?*. LocalPilot works out the intent from what you are doing instead of guessing or stopping to ask.

1. **Detection.** Before each turn, the request is checked for signs of ambiguity: very short, an action with no object ("clean it up"), pointing words with nothing in view ("this", "the error"), or an unmeasurable goal ("better"). These are left alone: requests that name a file, symbol, line or quoted text; requests with an attachment, image or editor selection; questions; stack traces; short follow-ups in an ongoing conversation.
2. **Workspace snapshot.** A flagged request gets a hidden snapshot: active file and selection, open editors, files touched this session, open checklist items, the last few turns, current errors from the Problems panel and uncommitted git changes. The chat shows a short *Request looks ambiguous … interpreting it* note.
3. **Stated interpretation.** The agent starts its reply with `Understood as: …` and any assumptions, then proceeds. It calls `ask_user` (one question, 2 to 4 options, with a recommended default) only when two readings would lead to different work and the context does not settle it.

The same snapshot is available on demand as the `gather_context` tool, to the main agent and every subagent. To turn off the automatic step, set `localpilot.autoClarify` to `false`.

## Splitting big tasks

For anything beyond a few steps, the agent first writes a checklist with `manage_todos`.

1. Independent items can carry an `agent` and a self-contained `prompt`.
2. `run_todos_parallel` runs those items at the same time as subagents. Each item moves to *in progress* and then *done* in the Tasks panel, which also shows the agent working on it.
3. Meanwhile the main agent does the dependent steps itself, integrates the results and verifies the combined change.

If a task passed to `run_todos_parallel` restates a pending checklist item (same prompt or title), LocalPilot runs that item instead of adding a duplicate.

Read-only subagents go to a small fast model; implementing ones can use a stronger coding model. See [Models → Routing]({{ '/docs/models/' | relative_url }}) and the settings `localpilot.routing.fast` and `localpilot.routing.coding`.

## Project rules

Rules files are added to every system prompt: `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.localpilot/rules/*.md`, `.github/copilot-instructions.md` and `.windsurfrules`. Use them for coding conventions, architecture notes and "always run X after Y" instructions. The full list, load order and `@imports` are on [Claude Code compatibility]({{ '/docs/claude-code-compatibility/' | relative_url }}#claudemd-and-instruction-files).

For one-off preferences, use `localpilot.systemPromptAppend`.
