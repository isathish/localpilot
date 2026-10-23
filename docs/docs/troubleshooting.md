---
title: Troubleshooting
description: Common problems and fixes.
permalink: /docs/troubleshooting/
---

## "No models found"

- Is the server running? `curl http://localhost:11434/api/tags` (Ollama) or `curl http://localhost:1234/v1/models` (LM Studio).
- LM Studio: start the server from the **Developer** tab and load at least one model.
- Non-default port or remote host → add it to `localpilot.providers`.
- Press **Refresh models** (title bar ↻ or the empty-state button).

## The model never calls tools / prints JSON instead

Your model likely lacks native function calling. LocalPilot falls back to a text protocol automatically; if the output still looks wrong, try a tool-trained model (`qwen2.5-coder`, `qwen3`, `llama3.3`, `devstral`) or a larger quant.

## Responses are cut off / the agent forgets earlier steps

Raise `localpilot.contextWindow` (Ollama defaults to 2–4k if not set) and make sure the model actually supports that window. Watch the context ring; compaction kicks in at 75%.

## Edits fail with "old_text not found"

The model's snippet didn't match the file. LocalPilot already retries with whitespace-insensitive matching; the agent will usually re-read the file and retry. If it loops, ask it to use `write_file` for that file.

## Slow first response

The model is loading into memory. Ollama keeps it loaded for 5 minutes by default (`OLLAMA_KEEP_ALIVE`). LM Studio: enable *Keep model loaded*.

## Parallel agents are slow

Local servers often process requests sequentially. For Ollama set `OLLAMA_NUM_PARALLEL=4`; for vLLM concurrency is native. Lower `localpilot.parallel.maxConcurrency` if memory is tight.

## Screenshots don't work on Linux

Install one of `gnome-screenshot`, `spectacle`, `scrot`, or `grim` + `slurp` (Wayland).

## Inline completions don't appear

Enable `localpilot.inlineCompletion.enabled`, pick a FIM-capable base model (`qwen2.5-coder:1.5b-base`), and make sure no other completion provider (e.g. Copilot) is taking precedence.

## Where are the logs?

**LocalPilot: Show Logs** opens the output channel with provider errors, MCP server output and tool failures.

## Reset everything

Sessions live in the workspace storage folder (*Developer: Open Extension Logs Folder* → sibling `workspaceStorage/<id>/localpilot.localpilot-agent/sessions`). Deleting that folder clears all chats for the workspace.
