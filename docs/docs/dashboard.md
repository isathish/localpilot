---
title: Dashboard, metrics & logs
description: Local-only usage metrics, provider health and a searchable live log — nothing leaves your machine.
permalink: /docs/dashboard/
---

**LocalPilot: Open Dashboard** (also in the status-bar menu, the chat title bar menu and **Settings → Dashboard**) shows what LocalPilot has been doing on this machine. Everything on the page is computed from files in `~/.localpilot/telemetry`; **no data is ever sent to a third party**.

## What you see

Pick a range — **Today**, **7 / 30 / 90 days** or **All** — and the page refreshes every 15 seconds while it is open.

| Card | What it tells you |
|------|-------------------|
| **Agent runs** | Turns finished / stopped / failed, how many were subagents, and a per-day bar chart. |
| **Tokens** | Prompt and completion tokens as reported by the server, plus the fastest model's **tok/s**. |
| **Model calls** | Requests made, retries (stalls, connection drops, empty replies) and hard errors. |
| **Tool calls** | Tool executions and their failure rate. |
| **Completions** | Inline-completion acceptance rate (accepted ÷ shown), requests, median latency. |
| **Providers** | How many configured servers are reachable right now, with each one's uptime over the range. |
| **Throughput** | Completion tokens per second of generation across every call in the range, and the fastest model. |
| **Turn time** | Median and 95th-percentile duration of an agent turn, with the median number of model steps. |
| **Cache hits** | Share of tool calls answered from the per-turn read cache (identical reads in one turn run once). |

Then the charts (hidden for a single-day range, where the counters say it all). Hover any bar or point for the exact value; colours come from the VS Code theme's chart palette.

- **Activity** — per day: model calls, tool calls, agent runs and errors.
- **Tokens** — per day, prompt stacked on completion.
- **Generation speed** — tok/s per day.
- **Completions** — shown vs accepted per day.
- **Run outcomes** / **Tool reliability** — donuts of done / stopped / failed and succeeded / cached / failed.
- **Activity by hour** — when the machine is busiest (local time).

Below the charts:

- **Models** — calls, tokens in/out, generation speed (**tok/s**), time to first token and whole-request time (median / 95th percentile), errors.
- **Runs by mode** — Agent, Multitask, Debug, Ask, Plan: outcomes, steps per run, duration, tool calls.
- **Tools** — per tool: calls, failures, cached hits, duration and share of all calls.
- **Provider health** — up/down, last error, uptime %, probe latency. Checks happen whenever models are discovered (start-up, refresh, every 30 s while the picker is open).
- **Inline completions** — requested / shown / accepted / empty / failed, latency and acceptance by language.
- **Isolated worktrees** — how many runs were isolated, worktrees created, applied (with files touched), discarded, conflicts.
- **Subagents** — per persona (coder, explore, tester…): runs, failures, duration and tool calls.
- **Recent problems** — the latest model errors, failed runs and unreachable providers.

## Logs

The **Logs** card mirrors the *LocalPilot* output channel: filter by minimum level, search, and keep **Follow** on to stream new lines as they are written. **Open log file** opens today's file (`localpilot-YYYY-MM-DD.log`) in an editor; **Output channel** jumps to the VS Code panel.

The CLI writes its own log (`localpilot --log-file`); its runs still count in the metrics because the extension and the CLI share the same telemetry folder.

## Telemetry settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `localpilot.telemetry.enabled` | `true` | Record usage metrics locally. Off stops recording; the log is still mirrored for the viewer. |
| `localpilot.telemetry.retentionDays` | `30` | Days of metrics and log files to keep. Older files are deleted on start-up and a few times a day. `0` keeps everything. |

**Export…** writes every recorded event plus the current log buffer to a JSON file you choose. **Delete all recorded data…** removes the folder's contents after a confirmation.

## What exactly is stored

One line of JSON per event in `events-YYYY-MM-DD.jsonl`:

| Event | Fields |
|-------|--------|
| `model` | session id, model, provider, mode, prompt/completion tokens, time to first token, duration, outcome (`ok`, `retry`, `error`, `aborted`) and the error kind |
| `tool` | session id, tool name, mode, duration, error flag, cached flag |
| `run` | session id, mode, model, depth (0 = the chat, 1+ = subagent), outcome (`done`, `stopped`, `failed`), duration, steps, tool calls, tokens, isolated |
| `completion` | action (`requested`, `shown`, `cached`, `accepted`, `empty`, `error`), model, language, duration |
| `health` | provider id, reachable, probe duration, number of models or the error |
| `worktree` | `create` / `apply` (files, conflicts) / `discard` |

Prompts, file contents, tool arguments and results are **never** recorded — only names, counts and timings.
