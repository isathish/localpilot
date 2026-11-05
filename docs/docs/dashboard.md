---
title: Dashboard, metrics & logs
description: Local usage metrics, model tuning, provider health and a searchable live log. Stored in local files on your machine; the extension uploads nothing.
permalink: /docs/dashboard/
---

**LocalPilot: Open Dashboard** shows what LocalPilot has been doing on this machine. You can also open it from the status-bar menu, the chat title bar menu and **Settings → Dashboard**, the first entry in the settings sidebar.

![Settings → Dashboard: agent runs, tokens, model calls, tool calls, completion acceptance, provider health, throughput, turn time and cache hits, with daily activity and token charts]({{ '/assets/screenshots/settings-dashboard.png' | relative_url }})

Everything on the page is computed from local JSONL files in `~/.localpilot/telemetry` (or, if you turned it on, the [Redis server](#telemetry-settings) you configured). The extension does not upload these metrics or send them to anyone else. See [Privacy]({{ '/privacy/' | relative_url }}) for every network call the extension makes.

## What you see

Pick a range: **Today**, **7 days**, **30 days**, **90 days** or **All**. While the page is open and visible, it refreshes every 15 seconds.

| Card | What it tells you |
|------|-------------------|
| **Agent runs** | Turns finished, stopped and failed, how many were subagents, and a per-day bar chart. |
| **Tokens** | Prompt and completion tokens as reported by the server, the cost of priced cloud calls when there were any, plus the fastest model's **tok/s**. |
| **Model calls** | Requests made, retries (stalls, connection drops, empty replies) and hard errors. |
| **Tool calls** | Tool executions and their failure rate. |
| **Completions** | Inline-completion acceptance rate (accepted ÷ shown), requests and median latency. |
| **Providers** | How many configured servers are reachable now, and each one's uptime over the range. |
| **Throughput** | Completion tokens per second of generation across all calls in the range, and the fastest model. |
| **Turn time** | Median and 95th-percentile duration of an agent turn, and the median number of model steps. |
| **Cache hits** | Share of tool calls answered from the per-turn read cache (identical reads in one turn run once). |
| **Edits kept** | Share of agent-edited lines you kept, with lines added and removed in the edits you kept and in the ones you undid (Keep / Undo in the Changes panel, the chat, the CLI or a Ctrl+I inline edit; unsaved edits count). |
| **Hooks** | Hook commands run, how many failed or timed out, how many blocked an action, and their median duration. |

Charts follow the cards. They are hidden for a single-day range, where the counters cover it. Hover any bar or point for the exact value. Colours come from your VS Code theme's chart palette.

- **Activity:** model calls, tool calls, agent runs and errors per day.
- **Tokens:** prompt tokens stacked on completion tokens, per day.
- **Generation speed:** tok/s per day.
- **Completions:** shown vs accepted per day.
- **Run outcomes** and **Tool reliability:** donuts of done / stopped / failed runs and succeeded / cached / failed tool calls.
- **Activity by hour:** when the machine is busiest, in local time.

Tables follow the charts:

- **Models:** calls, tokens in and out, cost (the provider's reported cost, or the bundled prices; a dash for local models, which are free), generation speed (**tok/s**), time to first token and whole-request time (median and 95th percentile), and errors.
- **Runs by mode:** Agent, Multitask, Debug, Ask and Plan, with outcomes, steps per run, duration and tool calls.
- **Tools:** per tool, calls, failures, cached hits, duration and share of all calls.
- **Provider health:** up or down, last error, uptime % and probe latency. LocalPilot checks providers whenever it discovers models: at start-up, on refresh, and every 30 s while the model picker is open.
- **Inline completions:** requested, shown, accepted, empty and failed, plus latency and acceptance by language.
- **Isolated worktrees:** how many runs were isolated, and worktrees created, applied (with files touched), discarded and conflicted.
- **Subagents:** per persona (coder, explore, tester…), runs, failures, duration and tool calls.
- **Recent problems:** the latest model errors, failed runs, unreachable providers, failed hooks and failed MCP tool calls.

### What is recorded

Besides model calls, tool calls, runs, completions and provider checks, LocalPilot records these events:

| Event | Fields |
|-------|--------|
| `task` | Chat task created, then one outcome per turn: completed, completed but not verified, incomplete, blocked, aborted (stopped), failed, or stopped at the mistake limit. |
| `mode_switch` / `model_selected` | The new mode or model, and whether you used the picker, a slash command, the CLI or **Build plan**. |
| `slash` | The command name only, never its arguments. |
| `mention` | The kind of context attached (file, line range, folder, URL, `@git`, `@problems`…), never the path. |
| `mcp_call` | Server, tool, duration and success. Arguments and results are not recorded. |
| `checkpoint` | A git checkpoint taken before a turn, a restore (files and conversation) or a rewind (conversation only), the outcome (`failed` when some files could not be restored) and the number of files reverted. |
| `hook` | The hook event, duration and outcome (ok, blocked, failed, timed out). The command line is not recorded. |
| `edit_decision` | Kept or undone, lines added and removed, and the number of files. |
| `recovery` | A self-healing step (`detected`, `retry`, `fix_attempt`, `validated`, `rolled_back`, `recovered`, `duplicate`, `escalated`, `blocked`, `exhausted`, `resumed`, `memory_hit`, `accept_risk`), the failure category and severity, attempt N of M, duration, outcome and a 16-character signature hash. Never code, error messages, file paths or the readable signature. |

Paths, command lines and branch names are never recorded. **Export…** shows exactly what is stored.

## Self-healing & recovery

The **Self-healing & recovery** section shows what the [self-healing engine]({{ '/docs/self-healing/' | relative_url }}) did in the selected range.

- **Tiles:** engine on or off, failures detected, recovered, pending intervention, recovery rate and mean time to recover.
- **Configuration:** automatic detection, automatic retry, automatic code fixes, regression testing required, max repair attempts, and *Security bypass: disabled*, which cannot be switched on.
- **Current recovery:** for each running chat, its phase, attempt N/M and the kind of failure.

**Recovery rate** = recovered ÷ (recovered + escalated + exhausted + blocked), over the recovery episodes in the range; 0 when there were none. This is the same definition in the telemetry, the Dashboard and the docs. Preexisting failures (already there before the task) and foreign ones (in files another running task changed) never open an episode, and a task that ends *Not verified* never counts as recovered.

Below them, eight views:

| View | What it shows |
|------|---------------|
| **Failure History** | Time, chat, category, severity, signature and outcome, filterable by category. Pick an entry from failure memory and choose **Don't suggest again** to stop it being offered as a fix suggestion |
| **Root Cause Analysis** | Per attempt: the failure, the root cause (the model's `Root cause:` line or LocalPilot's own hypothesis), the strategy, the result and any memory suggestion used |
| **Recovery Attempts** | A timeline per task: attempts with durations, retries and backoff waits, resource adjustments (thinking off, smaller context, another model) |
| **Applied Patches** | File, lines added and removed, attempt, kept or rolled back, a preview and **Open diff** |
| **Retry Configuration** | The effective policy per category (defaults plus your `localpilot.healing.policies`), with a link to edit it |
| **Regression Reports** | Per validation: failures before and after, fixed, introduced and preexisting |
| **Human Intervention Queue** | Open items waiting for you, with **Open chat**, **Resume**, **Approve install**, **Rollback fixes** and **Dismiss** |
| **Recovery Performance Analytics** | Recovery rate by category, attempts per recovery, time to recover (median and 90th percentile), the most frequent signatures and how often a memory suggestion led to a fix |

Readable signatures such as `TS2345@src/api/user.ts` come from the local recovery store on this machine. Telemetry itself only has a 16-character hash of the signature.

## Model tuning

The **Model tuning** card shows what LocalPilot has learned about your installed models from local usage. It appears when `localpilot.models.autoTune` is `auto` or `suggest` and there is at least one model to rank. The header shows how many runs and model calls were analysed, the window (last 14 days) and the mode (*tuning automatically* or *suggesting only*).

The card has four parts:

1. **Suggestions.** A table of changes LocalPilot recommends: role, suggested model, the model it would replace (marked *struggling* if that model keeps failing), the reason and a confidence badge (low, medium or high). Press **Apply** to write the suggestion to the role setting. *Auto uses it* means the setting is empty and Auto routing already picks that model, so there is nothing to write.
2. **Per-role ranking.** For each role (Chat & agent, Plan mode, Coding subagents, Read-only subagents, Inline completions, Images), the top installed models with their evidence. Evidence reads like "<i>N</i>% of <i>N</i> runs finished · <i>N</i> tok/s". The learned bonus or penalty is shown in green or red. Models without data show *not measured yet*.
3. **Recent automatic changes.** The last settings LocalPilot changed in `auto` mode, with the new value and the time.
4. **Analyse now.** Re-reads the telemetry and updates the card.

To undo an automatic change, use **Undo** in the notification that announced it, or set the role back in **Settings → Models → Routing**. To stop automatic changes, set `localpilot.models.autoTune` to `suggest` or `off`. For how the scoring and guardrails work, see [Learning from your usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}).

![Model tuning card: suggestions (qwen2.5-coder:7b for read-only subagents, with the reason and confidence), and for each role the installed models ranked by finished runs and speed, with the learned bonus or penalty]({{ '/assets/screenshots/dashboard-tuning.png' | relative_url }})

## Logs

The **Logs** card mirrors the *LocalPilot* output channel. Filter by minimum level, search, and keep **Follow** on to stream new lines as they are written. **Open log file** opens today's file (`localpilot-YYYY-MM-DD.log`) in an editor. With Redis storage on, it shows the newest lines from Redis in an untitled editor instead. **Output channel** jumps to the VS Code panel.

The CLI writes its own log to `~/.localpilot/cli.log` (add `-v` for debug lines). Its runs still count in the metrics, because the extension and the CLI share the same telemetry folder.

## Telemetry settings

Recording, retention, Redis storage and OpenTelemetry export are set in **Settings → Telemetry** (under *Data & system* in the sidebar, or **Telemetry settings** in the Dashboard's toolbar). The page's first line says where usage data goes: only this machine, or also the Redis server and OTLP collector you configured, shown by host and port (a password in the Redis URL is never shown). **Delete all recorded data…** is on the same page.

| Setting | Default | Meaning |
|---------|---------|---------|
| `localpilot.telemetry.enabled` | `true` | Record usage metrics locally. Turning it off stops recording and also stops [learning from usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}). The log is still mirrored for the viewer. |
| `localpilot.telemetry.retentionDays` | `30` | Days of metrics and log files to keep. Older files are deleted on start-up and at most every 6 hours after that. `0` keeps everything. |
| `localpilot.storage.redis.enabled` | `false` | Keep events and the log in Redis instead of files (see [Configuration]({{ '/docs/configuration/#telemetry--storage' | relative_url }})). The storage line under the settings says which backend is in use, and shows *Redis unreachable — using files* while it falls back. |

With Redis on, the data goes to the server you configured rather than staying in local files. With Redis Stack, every model, tool, run, health and completion metric is also a time series; the event stream keeps every event, while a series keeps one value per millisecond.

## Export to OpenTelemetry

In **Settings → Telemetry → Export to your OpenTelemetry collector**, switch on *Send telemetry to an OTLP collector* (`localpilot.telemetry.otlp.enabled`) to also send telemetry to your own collector (otel-collector, Grafana Alloy, or a self-hosted Langfuse or Phoenix through their OTLP endpoints). It is plain OTLP/HTTP with JSON bodies, works in VS Code and the CLI, and carries the resource attributes `service.name=localpilot` and `service.version`. Export needs `localpilot.telemetry.enabled`: while local recording is off nothing is exported, not even log lines, and a warning in the log says so.

- **Logs** (`/v1/logs`): every event above as a record named `localpilot.<type>` with its fields as attributes, plus the LocalPilot log lines.
- **Metrics** (`/v1/metrics`, every `metricsInterval` seconds, cumulative): `localpilot.events`, `localpilot.model.requests`, `localpilot.model.duration`, `localpilot.model.ttft`, `localpilot.tokens`, `localpilot.tool.calls`, `localpilot.tool.duration`, `localpilot.runs`, `localpilot.run.duration`, and counters for completions, tasks, hooks, MCP calls and accepted/rejected edit lines. Self-healing adds `localpilot.recovery.events` (by action and category), `localpilot.recovery.outcomes` (by outcome) and the histogram `localpilot.recovery.duration_ms` (by category), with no signature attribute.
- **Traces** (`/v1/traces`, add `traces` to `localpilot.telemetry.otlp.exporters`): an `invoke_agent` span per run (subagents nest under the tool call that started them), a `chat <model>` span per model request and an `execute_tool <name>` span per tool call, with `gen_ai.*` attributes (model, provider, token usage, finish reason, tool name and call id). `traceSamplePercent` keeps that share of runs. Prompts, replies, tool input/output and error text are added only with `recordContent: true`; without it a failed span's status message is just `tool error` or the run outcome. Events recorded during a span get its `traceId` and `spanId`, so logs and traces link up.

Exports are batched (up to 512 items, at least every 5 seconds); at most 2048 wait while the collector is unreachable, and the oldest are dropped first. The standard variables `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL` (only `http/json`; other values log a warning) and `OTEL_METRIC_EXPORT_INTERVAL` override the settings. Set `LOCALPILOT_OTEL_DEBUG=1` to log the resolved configuration and the result of every export. **Test connection** next to the endpoint in Settings (or **LocalPilot: Test OTLP Connection**) sends one `localpilot.test.connection` record and shows the collector's HTTP status or the error under the field. A field that an environment variable overrides is marked *Overridden by OTEL_…* and cannot be edited there. The OTLP settings are User settings only; a workspace cannot redirect your telemetry.

**Export…** writes every recorded event plus the current log buffer to a JSON file you choose. **Delete all recorded data…** removes the folder's contents after you confirm.

## What exactly is stored

Each event is one line of JSON in `events-YYYY-MM-DD.jsonl`:

| Event | Fields |
|-------|--------|
| `model` | session id, model, provider, mode, depth, prompt/completion tokens, time to first token, duration, outcome (`ok`, `retry`, `error`, `aborted`) and the error kind |
| `tool` | session id, tool name, mode, duration, error flag, cached flag |
| `run` | session id, mode, model, depth (0 = the chat, 1+ = subagent), subagent name and routing role, outcome (`done`, `stopped`, `failed`), duration, steps, tool calls, tokens, isolated flag |
| `completion` | action (`requested`, `shown`, `cached`, `accepted`, `empty`, `error`), model, language, duration |
| `health` | provider id, reachable, probe duration, number of models or the error |
| `worktree` | `create`, `apply` (files, conflicts) or `discard` |

Prompts, file contents, tool arguments and tool results are never recorded. Events hold only names, counts and timings. The log file can contain error messages from model servers and tools.

The LocalPilot website (not the extension) uses Google Analytics for page views. Details are on the [Privacy]({{ '/privacy/' | relative_url }}) page.
