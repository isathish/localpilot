---
title: Troubleshooting
description: Common problems and fixes.
permalink: /docs/troubleshooting/
---

## "No models found"

- Fastest fix: click **Set up automatically** (chat notice, setup wizard or *LocalPilot: Set Up Models Automatically*). It starts or installs Ollama and downloads a starter model that fits your machine.
- Is the server running? `curl http://localhost:11434/api/tags` (Ollama) or `curl http://localhost:1234/v1/models` (LM Studio). **Settings → Models** shows each runtime as running / installed / not found, with a *Start* button for Ollama.
- LM Studio: start the server from the **Developer** tab and load at least one model.
- Non-default port or remote host → add it to `localpilot.providers`.
- Press **Refresh models** (title bar ↻ or the empty-state button).
- Models you **disabled** in Settings → Models are hidden on purpose — flip the switch back on.

## A model is missing from the picker

Check **Settings → Models → Installed models**: disabled models are listed greyed out with their switch off. Embedding models are never shown. Models pulled by hand appear after **Refresh models**.

## Removing a model does nothing, or it is still listed

**Remove** in Settings → Models (and *LocalPilot: Remove Local Model…*) opens a VS Code confirmation dialog — look for it in the centre of the window; nothing happens until you click **Delete**. A toast reports *deleted* or the runtime's error, and the installed list refreshes by itself. If the model is still there afterwards, press **Refresh models**: the runtime may have been busy serving a request. Only Ollama and Docker Model Runner models can be deleted from LocalPilot — LM Studio models are removed in the LM Studio app (*My Models*); you can **disable** them here instead. A model deleted by hand (`ollama rm …`) disappears on the next refresh.

## The wrong model answers

With routing on, LocalPilot substitutes a model in three cases and says so in the chat status line: the turn has images and the session model cannot see (→ vision model), you are in Plan mode with `localpilot.routing.reasoning` set, or the chosen model is offline / disabled (→ best available). Pin a model per role in **Settings → Models → Routing**, or turn `localpilot.routing.enabled` off.

## Model download fails or is slow

Downloads run through the runtime (`ollama pull`, `docker model pull`, `lms get`), so network and disk limits are theirs. Cancel from the Activity list in Settings → Models and retry; partially downloaded layers resume. A size marked **tight** or **too big** may still download but will run slowly or not at all — prefer a size marked **fits**.

## "Ollama did not answer" after automatic setup

On macOS/Windows the Ollama app has to finish starting (menu-bar / tray icon); a first launch on Windows can take a minute and may show a welcome window — close it. LocalPilot waits up to 90 s, then press **Start** in Settings → Models, or run `ollama serve` in a terminal. If Ollama is running but shown as down, it is listening on `127.0.0.1` while `localhost` resolves to IPv6 — LocalPilot retries on the IPv4 loopback automatically; setting the provider URL to `http://127.0.0.1:11434` makes it explicit. On Linux the installer registers a `systemd` service; `systemctl status ollama` shows whether it is up.

## The model never calls tools / prints JSON instead

Your model likely lacks native function calling. LocalPilot falls back to a text protocol automatically; if the output still looks wrong, try a tool-trained model (`qwen2.5-coder`, `qwen3`, `llama3.3`, `devstral`) or a larger quant.

## Responses are cut off / the agent forgets earlier steps

Raise `localpilot.contextWindow` (Ollama defaults to 2–4k if not set) and make sure the model actually supports that window. Watch the context ring; compaction kicks in at 75%.

## Edits fail with "old_text not found"

The model's snippet didn't match the file. LocalPilot already retries with whitespace-insensitive matching; the agent will usually re-read the file and retry. If it loops, ask it to use `write_file` for that file.

## Slow first response

The model is loading into memory. Ollama keeps it loaded for 5 minutes by default (`OLLAMA_KEEP_ALIVE`). LM Studio: enable *Keep model loaded*. While nothing has arrived yet the status line counts the seconds (*Waiting for qwen2.5-coder · 45s (loading the model or a long prompt)…*); after 3 minutes with no output the request is cancelled and retried.

## "Retrying (1/2)" notes, or "the model stopped responding"

LocalPilot retries a model request on its own when the connection drops, the server answers 5xx/429, the stream goes silent for 90 s, or the model returns an empty completion — twice, with a short back-off, before showing an error. A *Retrying (n/2) — reason* note appears in the transcript each time. If the server says the prompt is too long, the conversation is compacted once and sent again. When an error does surface it comes with a **Retry** button that replays your last message. Repeated stalls usually mean the model is too large for the machine (watch memory) or the server is wedged — restart it. A tool called with the exact same arguments more than three times in one turn is refused so a confused model cannot loop forever; after 40 model steps in a single turn the agent stops and asks you to say *continue*.

## Parallel agents are slow

Local servers often process requests sequentially. For Ollama set `OLLAMA_NUM_PARALLEL=4`; for vLLM concurrency is native. Lower `localpilot.parallel.maxConcurrency` if memory is tight.

## Screenshots don't work on Linux

Install one of `gnome-screenshot`, `spectacle`, `scrot`, or `grim` + `slurp` (Wayland).

## Inline completions don't appear

Enable `localpilot.inlineCompletion.enabled` and make sure a FIM-capable model is installed — routing picks the smallest one automatically (install `qwen2.5-coder:1.5b` from the catalog if there is none), or pin one in `localpilot.inlineCompletion.model`. Also check that no other completion provider (e.g. Copilot) is taking precedence.

## Where are the logs?

**LocalPilot: Show Logs** opens the output channel with provider errors, MCP server output and tool failures.

## Reset everything

Sessions live in the workspace storage folder (*Developer: Open Extension Logs Folder* → sibling `workspaceStorage/<id>/localpilot.localpilot-agent/sessions`). Deleting that folder clears all chats for the workspace.
