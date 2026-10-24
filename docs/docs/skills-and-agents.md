---
title: Skills & subagents
description: Package expertise as reusable skills and delegate work to specialised subagents.
permalink: /docs/skills-and-agents/
---

## Skills

A skill is a folder containing a `SKILL.md` with YAML front-matter and Markdown instructions — the same convention used by Claude Code and GitHub Copilot, so existing skills work unchanged.

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

### Discovery locations (priority order)

1. `<workspace>/.localpilot/skills/*`
2. `<workspace>/.claude/skills/*`
3. `<workspace>/.github/skills/*`
4. `~/.localpilot/skills/*`, `~/.claude/skills/*`, `~/.agents/skills/*`
5. Folders listed in `localpilot.skillsPaths`
6. Skills bundled with LocalPilot (see below) — a skill with the same name found earlier overrides them

### Built-in skills

LocalPilot ships playbooks for the whole development loop, so a fresh workspace already knows how to go from idea to deployment. They follow the same `SKILL.md` format and live in the extension's `skills/` folder; copy one into `.localpilot/skills/<name>/` to customise it, or turn them all off with `localpilot.skills.builtin`.

| Skill | What it drives |
|---|---|
| `requirements` | A vague idea → a short spec with goals, user stories, acceptance criteria, non-goals |
| `design` | Architecture, file/module layout, data model, API, decisions → an ordered todo plan |
| `new-project` | Pick a stack, scaffold tooling and layout, build a first working slice, verify it, plan next features |
| `implement` | Explore → plan → small verified edits → diagnostics/build/tests → summary |
| `test` | Detect the framework, write focused tests with edge cases, run and fix real failures |
| `debug` | Reproduce → localise → hypothesis → root-cause fix → regression test |
| `review` | Severity-ranked findings (correctness, OWASP security, performance, tests) with `file:line` fixes |
| `refactor` | Behaviour-preserving restructuring guarded by tests and diagnostics |
| `ui-design` | Hierarchy, spacing, typography, colour tokens, states, responsive, accessibility — verified with `browser_inspect` |
| `claude-ui-ux` | Calm, warm, typography-led interfaces and assistant/agent UX patterns (streaming, tool steps, permission prompts, plan panels, empty/error states) |
| `docs` | README / guides / API docs / changelog, checked against the code |
| `deploy` | Dockerfile, CI, env & secrets, health checks, release checklist; runs the deploy when the CLI is available |
| `ship` | Final verification, conventional commit message, PR description — no git action without permission |
| `explore-codebase` | A map of an unfamiliar repo: layout, entry points, request flow, conventions, saved to memory |

The agent loads them on its own when a request matches ("write a spec for…", "review this", "deploy it"), or force one with `/skill implement …`.

### Installing skills

Skills published anywhere in the [Agent Skills](https://agentskills.io) format — a GitHub repository, a folder inside one, a collection such as `anthropics/skills`, a URL to a `SKILL.md`, or a folder on disk — install in one step:

- **Command Palette → LocalPilot: Install Skill…** (also the **Install skill…** button in Settings → Memory & history → Skills), or
- in the chat: `/skill install anthropics/skills/skills/pdf`, or
- from the terminal: `localpilot skill install owner/repo[/path] [--user]`.

Accepted sources: `owner/repo`, `owner/repo/path/to/skill`, `owner/repo@branch/path`, `https://github.com/owner/repo/tree/main/skills/x`, a `blob`/`raw.githubusercontent.com` link to a `SKILL.md`, any other `https://…/SKILL.md`, or a local path. When the source holds several skills you pick which ones to install; each lands in `.localpilot/skills/<name>/` of the workspace (or `~/.localpilot/skills/` for *My skills* / `--user`) with its companion files (`scripts/`, `reference.md`, …), and the skill list refreshes immediately — the `/skill` menu, the suggestion chips and Settings all see it without a reload. Existing skills are only replaced after confirmation. Private repositories and higher API limits use `GITHUB_TOKEN` if it is set.

### The skill catalog: skills that install themselves

You should not have to know that a skill exists before you can use it. `localpilot.skills.repositories` lists skill collections — by default [`anthropics/skills`](https://github.com/anthropics/skills) (PDF, Word, PowerPoint, Excel, frontend design, MCP builder…), [`obra/superpowers`](https://github.com/obra/superpowers) (writing plans, brainstorming, systematic debugging, test-driven development…) and [`github/awesome-copilot`](https://github.com/github/awesome-copilot) (hundreds of skills for documentation, architecture, analysis, cloud and more). LocalPilot indexes their names and descriptions once a day (`~/.localpilot/skill-catalog.json`, shared with the CLI; no skill bodies are downloaded until needed) and matches every request against the catalog as well as against what is installed.

When the best match is a catalog skill — "write a plan for migrating auth", "fill this PDF form", "generate an architecture blueprint", "make a pptx of the results" — the agent **installs it as the request starts** and loads it like any other skill; the turn shows *Installed "writing-plans" from obra/superpowers/skills for this request* and the skill appears in Settings → Skills. That is `localpilot.skills.autoInstall: auto`, the default. Choose `ask` to get an **Install "…"** chip under the request instead (nothing is downloaded until you click it), or `off` to never consult the catalog. `localpilot.skills.autoInstallScope` decides where such skills go: `user` (`~/.localpilot/skills`, the default — nothing is added to your project) or `workspace` (`.localpilot/skills`, shared with the team).

The match has to be specific: the request must contain the skill's name words (`pdf`, `architecture blueprint`), a quoted trigger phrase from its description, or words that are rare across the whole catalog — a single common word ("add", "review", "markdown") never pulls in a skill, and a catalog skill is only chosen when it clearly beats every installed one, so your own and the built-in skills keep priority. A skill you delete after an automatic install, or decline with *Not now*, is not installed again.

To look around yourself, **LocalPilot: Browse Skill Catalog…** (also the **Browse catalog…** button in Settings → Skills) lists every skill of every configured repository with type-to-filter, shows which are already installed, re-indexes on demand and installs your selection into the workspace or your user skills. In the terminal, `localpilot skill search <words>` ranks the catalog for a query and `--install` installs the best match.

### Progressive disclosure

Only the **name and description** of each skill are placed in the system prompt. When a task matches, the model calls `load_skill` to pull in the full instructions. Dozens of skills therefore cost almost no context. Force one with `/skill <name> <task>`.

### Recommendations while you chat

Each request is matched against the skill index — the skill's name, any quoted trigger phrases in its description (`Use for "deploy", "release"`) and the description's terms, weighted by how distinctive each term is among your installed skills (a word like *bug* says more than *code*). Matching skills are passed to the model as a hint so it loads the playbook before starting, and shown as chips under the turn; click a chip to force it (`/skill <name> …`). Nothing is recommended for requests that match no skill ("add a logout button", "hello") — a recommendation always comes from the skill's own words. Write descriptions with the words people actually type, and quote two or three trigger phrases, to make a skill easy to recommend; an apostrophe inside a word (*doesn't*) is not treated as a quote.

### Learning which skills you are missing

LocalPilot remembers the *kinds* of requests that come up (main verb + key nouns, e.g. `deploy · api · staging`) and which skills were loaded for them. When the same kind of request has come up three times and no skill covered it, the chat offers **Create "<name>" skill**: it prefills a prompt asking the agent to write `.localpilot/skills/<name>/SKILL.md` with front-matter and a step-by-step body based on what worked in this project, then reload skills. **Not now** stops the suggestion for that topic. The state is a small JSON file (`skill-learning.json`) in the extension's global storage — `~/.localpilot/` for the CLI — and entries expire after 60 days.

## Subagents

Subagents are Markdown files whose body becomes the system prompt:

```
.localpilot/agents/migrator.md
```

```markdown
---
name: migrator
description: Converts JavaScript files to TypeScript one at a time.
tools: read_file, write_file, edit_file, run_command, get_diagnostics
model: ollama/qwen2.5-coder:32b
---
You convert JS to idiomatic TS. Preserve behaviour, add precise types, run tsc after each file…
```

- `tools` restricts the tool set (omit for all tools).
- `model` overrides the session model — use a bigger model for hard sub-tasks, a smaller one for exploration.
- Locations: `.localpilot/agents`, `.claude/agents`, `~/.localpilot/agents`, `~/.claude/agents`.

### Built-in subagents

| Name | Purpose | Tools |
|---|---|---|
| `clarifier` | Turns a vague brief into a precise task statement: *Understood as / Assumptions / Alternatives / Suggested approach / Open question* | read-only + `gather_context` |
| `explore` | Read-only codebase exploration & Q&A with `path:line` findings | read-only + `gather_context` |
| `planner` | Ordered implementation plan (files, approach, risks, verification) — no edits | read-only + `gather_context` |
| `coder` | Implements a well-specified change end to end, verifies with diagnostics/tests | all |
| `tester` | Writes tests in the project's framework and conventions, runs them, reports real bugs | all |
| `debugger` | Reproduce → trace → root cause → minimal fix → re-verify | all |
| `reviewer` | Severity-ranked bugs, security (OWASP), error handling, conventions — no edits | read-only + `run_command` |
| `docs` | README sections, doc comments, changelog entries matching the project's tone | all |
| `researcher` | Web research with cross-checked sources and citations | `web_search`, `web_fetch`, `read_file` |

Every built-in follows the same contract: a subagent cannot ask the user anything, so when its brief is ambiguous it calls `gather_context`, reads the code, picks the most plausible interpretation and states it under **Interpretation** at the top of its report. Agent names are matched loosely — `review`, `debug`, `test`, `plan`, `Explore agent` all resolve — and an unknown name falls back to `explore` with a note in the result. A workspace or user agent file with the same name replaces the built-in one.

### How delegation works

The main agent calls `run_subagent` (one child) or `run_parallel_subagents` (many, concurrently). Children run with a **fresh context window**, cannot see the parent's conversation, and return only their final report — so include everything they need in the prompt (goal, files/symbols, constraints, what to return). Delegate directly with `/agent <name> <task>`.

## Understanding vague requests

Most prompts are terse — *fix this*, *make it faster*, *tests?*. Instead of guessing or stopping to ask, LocalPilot resolves the intent from what you are doing:

1. **Automatic detection.** Before each turn the request is checked for signs of ambiguity: very short, an action with no object ("clean it up"), pointing words with nothing in view ("this", "the error"), or an unmeasurable goal ("better"). Requests that name a file, symbol, line or quoted text, come with an attachment, image or editor selection, are questions, stack traces, or short follow-ups in an ongoing conversation are left alone.
2. **Workspace snapshot.** When a request is flagged, the model receives a hidden snapshot: active file and selection, open editors, files touched this session, open checklist items, the last few turns, current errors from the Problems panel and uncommitted git changes. The chat shows a small *Request looks ambiguous … interpreting it* note.
3. **Stated interpretation.** The agent begins its reply with `Understood as: …` plus any assumptions, then proceeds. It calls `ask_user` (one question, 2–4 concrete options, with a recommended default) only when two readings would lead to materially different work and the context does not settle it.

The same snapshot is available on demand as the `gather_context` tool, to the main agent and to every subagent. Turn the automatic step off with `localpilot.autoClarify: false`.

## Splitting big tasks

For anything beyond a few steps the agent first writes a checklist with `manage_todos`. Items that are independent of each other can carry an `agent` and a self-contained `prompt`; `run_todos_parallel` then runs those items concurrently as subagents — each flips to *in progress* and *done* in the Tasks panel, which shows the delegated agent on the item — while the main agent does the dependent steps itself, integrates the results and verifies the combined change. Read-only subagents are routed to a small, fast model and implementing ones can use a stronger coding model; see [Models → Routing]({{ '/docs/models/' | relative_url }}) and `localpilot.routing.fast` / `localpilot.routing.coding`.

## Project rules

Rules files are injected into every system prompt automatically: `.localpilot/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.localpilot/rules/*.md`, `.github/copilot-instructions.md`, `.windsurfrules`. Use them for coding conventions, architecture notes and "always run X after Y" instructions. Add one-off preferences in `localpilot.systemPromptAppend`.
