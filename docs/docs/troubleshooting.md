---
title: Troubleshooting
description: Fixes for common LocalPilot problems, from missing models and slow replies to colibri and automatic model changes.
permalink: /docs/troubleshooting/
---

## "No models found"

- **Quickest fix:** click **Set up automatically** (in the chat notice, the setup wizard, or *LocalPilot: Set Up Models Automatically*). It starts or installs Ollama and downloads a starter model that fits your machine.
- **Check that the server is running.** Run `curl http://localhost:11434/api/tags` (Ollama) or `curl http://localhost:1234/v1/models` (LM Studio). **Settings → Models** shows each runtime as running, installed or not found, with a *Start* button for Ollama.
- **LM Studio:** start the server from the **Developer** tab and load at least one model.
- **Non-default port or remote host:** add it to `localpilot.providers`.
- Press **Refresh models** (the ↻ button in the title bar, or the button in the empty state).
- Models you **disabled** in Settings → Models are hidden on purpose. Turn their switch back on.

## A model is missing from the picker

Open **Settings → Models → Installed models**. Disabled models are listed greyed out with their switch off. Embedding models are never shown. Models you pulled by hand appear after **Refresh models**.

## Removing a model does nothing, or it is still listed

**Remove** (in Settings → Models, or *LocalPilot: Remove Local Model…*) opens a VS Code confirmation dialog in the centre of the window. Nothing happens until you click **Delete**. A notification then reports *deleted* or the runtime's error, and the installed list refreshes.

If the model is still listed, press **Refresh models**; the runtime may have been busy serving a request. LocalPilot can only delete Ollama and Docker Model Runner models. Remove LM Studio models in the LM Studio app (*My Models*), or **disable** them in LocalPilot. A model you delete by hand (`ollama rm …`) disappears on the next refresh.

## The wrong model answers

With routing on, LocalPilot may use a different model than the session model. The chat status line says when it does. This happens when:

- the turn has images and the session model cannot see (a vision model answers),
- you are in Plan mode and `localpilot.routing.reasoning` is set,
- a subagent runs and `localpilot.routing.fast` or `localpilot.routing.coding` points elsewhere (read-only subagents use the smallest tool-capable model by default),
- the chosen model is offline or disabled (the best available model answers).

To control this, pin a model per role in **Settings → Models → Routing**, or set `localpilot.routing.enabled` to `false`. If a role setting changed without you, see the next entry.

## LocalPilot changed my default model

`localpilot.models.autoTune` is `auto` by default. In that mode LocalPilot can update `defaultModel` and the other role settings when another installed model has measurably performed better on this machine, based on local telemetry. It only replaces a model you picked by hand when that model keeps failing.

1. Click **Undo** in the notification that announced the change. This restores the previous value and stops that pick from being applied again.
2. Or open **Dashboard → Model tuning** to see what changed, when, and why.
3. To prevent future changes, set `localpilot.models.autoTune` to `suggest` (offers changes in a notification) or `off` (no learning).

A model pinned in workspace settings is never changed. See [Learning from your usage]({{ '/docs/models/#learning-from-your-usage' | relative_url }}).

## colibri is slow or looks hung

colibri models whose download is larger than your machine's model budget stream experts from disk. A long agent prompt can take minutes to prefill before the first token, and output runs at about 1 token per second or slower. This is expected, not a hang.

- **Watch the colibri terminal** (*LocalPilot · colibri*, or wherever you ran `coli serve`). It shows prefill and decode progress.
- **Wait longer before giving up.** LocalPilot already allows disk-streamed colibri models 4× the normal first-token and idle limits (2× for colibri models that fit in RAM).
- **Use a RAM-resident model for agent work.** Agent turns resend long prompts many times. A model that fits in RAM, such as `qwen3-coder-30b` (about 8 GB RAM), is far faster. Keep the huge disk-streamed models for single careful answers, such as Plan mode.
- **Run fewer agents at once.** colibri decodes one request per KV slot (`localpilot.colibri.kvSlots`, default `2`). Extra requests wait in its queue.

See [colibri]({{ '/docs/models/#colibri-huge-moe-models-from-disk' | relative_url }}).

## Model download fails or is slow

Downloads run through the runtime (`ollama pull`, `docker model pull`, `lms get`), so network and disk limits are the runtime's. Cancel from the Activity list in Settings → Models and retry; partially downloaded layers resume. A size marked **tight** or **too big** may still download but will run slowly or not at all. Prefer a size marked **fits**.

## "Ollama did not answer" after automatic setup

- **macOS and Windows:** the Ollama app has to finish starting (menu-bar or tray icon). A first launch on Windows can take a minute and may show a welcome window; close it. LocalPilot waits up to 30 seconds (90 seconds on Windows). After that, press **Start** in Settings → Models, or run `ollama serve` in a terminal.
- **Ollama runs but shows as down:** Ollama may listen on `127.0.0.1` while `localhost` resolves to IPv6. LocalPilot retries on the IPv4 loopback automatically. Setting the provider URL to `http://127.0.0.1:11434` makes it explicit.
- **Linux:** the official installer registers a `systemd` service. `systemctl status ollama` shows whether it is up.

## The model never calls tools, or prints JSON instead

Your model probably lacks native function calling. LocalPilot falls back to a text protocol automatically. If the output still looks wrong, try a tool-trained model (`gemma4`, `qwen2.5-coder`, `qwen3`, `llama3.3`, `devstral`) or a larger quantisation. Small local models are less reliable at tool use than large cloud models.

## Responses are cut off, or the agent forgets earlier steps

Raise `localpilot.contextWindow` and make sure the model supports that window. Ollama defaults to 2–4k tokens if `num_ctx` is not set. Watch the context ring in the chat; compaction starts at 75% (`localpilot.compactionThreshold`).

## Edits fail with "old_text not found"

The model's snippet did not match the file. LocalPilot already retries with whitespace-insensitive matching, and the agent usually re-reads the file and tries again. If it loops, ask it to use `write_file` for that file.

## Slow first response

The model is loading into memory.

- **Ollama:** LocalPilot asks Ollama to keep the model loaded for 30 minutes after each request (`localpilot.keepAlive`). With `localpilot.prewarm` on, it starts loading the model when you focus the composer.
- **LM Studio:** enable *Keep model loaded*.

While nothing has arrived, the status line counts the seconds, for example *Waiting for qwen2.5-coder · 45s (loading the model or a long prompt)…*. After 3 minutes with no output, the request is cancelled and retried. The limit grows when requests are queued, and is longer for colibri.

## "Retrying (1/2)" notes, or "the model stopped responding"

LocalPilot retries a model request itself when:

- the connection drops,
- the server answers 5xx or 429,
- the stream goes silent for 90 seconds,
- the model returns an empty completion.

It retries twice, with a short back-off, before showing an error. Each retry adds a *Retrying (n/2): reason* note to the transcript. If the server says the prompt is too long, LocalPilot compacts the conversation once and sends it again. When an error does surface, a **Retry** button replays your last message.

Repeated stalls usually mean the model is too large for the machine (watch memory) or the server is stuck. Restart the server.

Two loop guards also apply. A tool called with the exact same arguments more than three times in one turn is refused. After 40 model steps in one turn, the agent stops and asks you to say *continue*.

## Parallel agents are slow

Many local servers process one request at a time.

- **Ollama:** set `OLLAMA_NUM_PARALLEL=4`. When LocalPilot starts Ollama itself, it requests parallel slots for you, and it can offer to restart Ollama with them.
- **vLLM:** handles concurrent requests natively.
- **colibri:** raise `localpilot.colibri.kvSlots` (each slot costs a few hundred MB of RAM).

With `localpilot.routing.parallelModels` on, extra runs also spread to a comparable idle model. Lower `localpilot.parallel.maxConcurrency` if memory is tight.

## Screenshots don't work on Linux

Install one of `gnome-screenshot`, `spectacle`, `scrot`, or `grim` + `slurp` (Wayland).

## Inline completions don't appear

1. Set `localpilot.inlineCompletion.enabled` to `true`.
2. Make sure a FIM-capable model is installed. Routing picks the smallest one automatically. If there is none, install `qwen2.5-coder:1.5b` or `starcoder2:3b` from the catalog, or pin one in `localpilot.inlineCompletion.model`. colibri models cannot do fill-in-the-middle.
3. Check that no other completion provider (for example Copilot) takes precedence.

## Where are the logs?

- **LocalPilot: Show Logs** opens the output channel with provider errors, MCP server output and tool failures.
- The **Logs** card on the [Dashboard]({{ '/docs/dashboard/#logs' | relative_url }}) lets you search and filter the same log. Daily files are in `~/.localpilot/telemetry` as `localpilot-YYYY-MM-DD.log`.

## Reset everything

Chats live in the workspace storage folder. Run *Developer: Open Extension Logs Folder*, then go to the sibling folder `workspaceStorage/<id>/localpilot.localpilot-agent/sessions`. Deleting that folder clears all chats for the workspace.
