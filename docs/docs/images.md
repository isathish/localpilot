---
title: Screenshots & images
description: Show the model what you see — capture a region, paste or drop an image, screenshot a web page or local dev server headlessly, open URLs in a browser view inside VS Code, and let a vision model work on it.
permalink: /docs/images/
---

## Ways to attach an image

- **Capture screenshot** — camera button in the composer, <kbd>⌘⌥⇧S</kbd>, or *LocalPilot: Capture Screenshot to Chat (Area / Window / Screen)*. Pick what to capture:
  - **Selection area** — drag a rectangle (Esc cancels).
  - **This VS Code window** — captured immediately, no interaction.
  - **Pick a window** — click another window (macOS/Linux) or switch to it within 3 s (Windows).
  - **Full screen** — now, or **in 5 s** to leave time to switch apps or open a menu.
- **Paste** from the clipboard into the input box.
- **Drag and drop** an image file onto the composer.
- **Image button** to pick files, or right-click a PNG/JPEG in the Explorer → *Attach Image to Chat*.
- **Screenshot a URL…** (camera menu → *Web page*, or *LocalPilot: Screenshot a Web Page…*) — renders any page or local dev server (`localhost:3000`) with a headless browser and attaches the result; a *phone size* variant uses a 390×844 viewport with a mobile user agent.

Up to four images per message. Images are downscaled client-side to 1568px on the long edge so they fit typical vision budgets, shown as thumbnails on your message, and click-to-zoom in the transcript.

## Browser view & web-page screenshots for the agent

The agent has two browser tools, available in every mode:

| Tool | What it does |
|---|---|
| `open_browser` | Opens a URL in VS Code's built-in **Simple Browser** beside the editor (or the system browser with `external: true`). Use it to show you a dev server or a result. |
| `browser_screenshot` | Renders a URL with a **headless Chromium** already on your machine (Chrome, Chromium, Edge, Brave, Arc — or `localpilot.browser.chromePath`) and returns the PNG. Options: `width`/`height` (default 1280×800), `full_page`, `mobile` (390×844 + mobile UA), `wait_ms` for scripts to settle. The result line also says how many console errors / failed requests the page produced. |
| `browser_inspect` | The DevTools version: attaches to the headless browser over the **Chrome DevTools Protocol** and returns, in one call, the **screenshot**, the **console** (logs, warnings, errors and uncaught exceptions with `file:line:col`), the **network trace** (every request with status, type, size and timing; failed ones listed first), **performance** (DOMContentLoaded, load, FCP, LCP, DOM nodes, JS heap) and **layout checks** (horizontal overflow with the culprit elements, images without alt text, tiny text, controls without an accessible name). Optional `actions` run before capture — `{"click": "#save"}`, `{"type": {"selector": "#email", "text": "a@b.c"}}`, `{"scroll": "bottom"}`, `{"eval": "localStorage.clear()"}`, each with an optional `wait` — so the agent can reproduce a flow and see exactly what breaks. `include_text` adds the visible page text for text-only models. |

The agent is instructed to use `browser_inspect` after web UI changes: start or reuse the dev server, inspect, fix what the report shows, re-inspect. In the chat the result is a **DevTools panel** — screenshot, status chips (console errors, failed requests, layout issues), a colour-coded console with clickable locations, failed requests with timings, performance metrics and layout findings — and the same report is what the model reads, so you can follow its reasoning line by line.

With a vision model the screenshot is attached to the conversation, so the agent can *look* at the page it just changed — the system prompt tells it to verify web UI work this way. With a text-only model the image is still shown to you in the transcript (click to enlarge) and the tool result says so; the agent falls back to `web_fetch` for the page text. Screenshots are governed by the **Network** approval policy; opening the browser view needs no approval.

You can drive this yourself too: the camera menu has **Screenshot a URL…**, **Inspect a URL (screenshot + console + network)…** — which attaches the screenshot and drafts a message with the DevTools report for the model to analyse — and **Open URL in browser view…**; the same actions exist as *LocalPilot: Screenshot a Web Page…*, *Inspect a Web Page…* and *Open URL in Browser View…* commands. Everything runs locally; nothing is sent to a cloud browser service.

## Requirements

The selected model must support vision (`qwen2.5vl`, `llava`, `gemma3`, `pixtral`, …). LocalPilot checks the model's capabilities and warns you before sending if it cannot read images.

## Screenshot tooling by platform

| Platform | Tool used |
|---|---|
| macOS | `screencapture` — `-i` area, `-iW` pick window, `-l <id>` VS Code window, full screen — built in |
| Linux | first available of `gnome-screenshot`, `spectacle`, `scrot`, `grim`+`slurp`, ImageMagick `import`+`xdotool` |
| Windows | PowerShell: translucent drag-to-select overlay for areas, `GetForegroundWindow` for windows, virtual-screen capture for full screen |
| Web pages | any Chromium-based browser (`--headless=new --screenshot`), auto-detected or `localpilot.browser.chromePath` |

## Good prompts

- *"Start the dev server, open it in the browser view and screenshot the dashboard at phone size — fix anything that overflows."*
- *"This dialog is misaligned — find the CSS causing it and fix it."*
- *"Here's the failing test output. Fix the bug."*
- *"Reproduce this UI from the mock-up in React."*
