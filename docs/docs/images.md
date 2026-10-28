---
title: Screenshots & images
description: Capture a screen region, paste or drop an image, screenshot or inspect a web page headlessly, and let a vision model work from what you see.
permalink: /docs/images/
---

## Ways to attach an image

| Method | How |
|---|---|
| Capture a screenshot | Camera button in the composer, <kbd>⌘⌥⇧S</kbd> (<kbd>Ctrl+Alt+Shift+S</kbd>), or *LocalPilot: Capture Screenshot to Chat (Area / Window / Screen)* |
| Paste | Paste from the clipboard into the input box |
| Drag and drop | Drop an image file onto the composer |
| Pick a file | Image button, *LocalPilot: Attach Image to Chat…*, or right-click a PNG, JPEG, GIF or WebP file in the Explorer → *Attach Image to Chat* |
| Screenshot a web page | Camera menu → **Screenshot a URL…**, or *LocalPilot: Screenshot a Web Page…*. See [below](#web-pages-and-the-browser-view) |

Screenshot capture offers these targets:

- **Selection area**: drag a rectangle. <kbd>Esc</kbd> cancels.
- **This VS Code window**: captured at once.
- **Pick a window**: click another window (macOS, Linux), or switch to it within 3 seconds (Windows).
- **Full screen**: now, or **in 5 s** so you can switch apps or open a menu first.

Limits:

- Up to four images per message.
- Images you paste or drop are scaled down to at most 1568 px on the long edge before sending.
- Your message shows thumbnails; click an image in the transcript to zoom.

## Web pages and the browser view

The agent has three browser tools, available in every mode.

| Tool | What it does |
|---|---|
| `open_browser` | Opens a URL in VS Code's **Simple Browser** beside the editor, or in the system browser with `external: true`. Use it to show you a dev server or a result |
| `browser_screenshot` | Renders a URL in a headless Chromium-based browser already on your machine (Chrome, Chromium, Edge, Brave, Arc, or `localpilot.browser.chromePath`) and returns the PNG. Options: `width` / `height` (default 1280×800), `full_page`, `mobile` (390×844 with a mobile user agent), `wait_ms` (default 1500). The result also reports how many console errors and failed requests the page produced |
| `browser_inspect` | Attaches to the headless browser over the Chrome DevTools Protocol and returns, in one call: a screenshot, the console, the network trace, performance metrics and layout checks (details below) |

`browser_inspect` returns:

- **Console**: logs, warnings, errors and uncaught exceptions with `file:line:col`.
- **Network**: every request with status, type, size and timing; failed requests listed first.
- **Performance**: DOMContentLoaded, load, FCP, LCP, DOM node count, JS heap.
- **Layout checks**: horizontal overflow with the elements causing it, images without alt text, tiny text, controls without an accessible name.

Optional `actions` run before capture, each with an optional `wait`:

```json
[{"click": "#save"}, {"type": {"selector": "#email", "text": "a@b.c"}}, {"scroll": "bottom"}, {"eval": "localStorage.clear()"}]
```

This lets the agent reproduce a flow and see what breaks. `include_text` adds the visible page text, for text-only models.

### How the agent uses them

The agent is told to use `browser_inspect` after web UI changes: start or reuse the dev server, inspect, fix what the report shows, inspect again. In the chat the result appears as a **DevTools panel**: screenshot, status chips (console errors, failed requests, layout issues), a colour-coded console with clickable locations, failed requests with timings, performance metrics and layout findings. The model reads the same report.

With a vision model, the screenshot is added to the conversation so the agent can look at the page it changed. With a text-only model, you still see the image in the transcript and the tool result says the model cannot; the agent uses `web_fetch` for the page text instead.

Approvals: screenshots and inspections follow the **Network** approval policy (`localpilot.approvals.network`). Opening the browser view needs no approval.

### Doing it yourself

The camera menu has a **Web page** group:

| Menu item | Command | Result |
|---|---|---|
| **Screenshot a URL…** | *LocalPilot: Screenshot a Web Page…* | Attaches a screenshot |
| **Screenshot a URL (phone size)…** | | Same, at 390×844 with a mobile user agent |
| **Inspect a URL (screenshot + console + network)…** | *LocalPilot: Inspect a Web Page (Screenshot, Console, Network)…* | Attaches the screenshot and drafts a message with the DevTools report |
| **Open URL in browser view…** | *LocalPilot: Open URL in Browser View…* | Opens the page beside the editor |

The browser runs locally. No cloud browser service is used.

## Requirements

To read images, the selected model must support vision (for example `gemma4`, `qwen2.5vl`, `llava`). LocalPilot checks the model's capabilities. If it cannot read images, the message is not sent and you are asked to pick a vision model.

## Screenshot tools by platform

| Platform | Tool used |
|---|---|
| macOS | Built-in `screencapture`: `-i` for an area, `-i -W` to pick a window, `-l <id>` for the VS Code window, no flag for full screen |
| Linux | The first one that works of `gnome-screenshot`, `spectacle`, `scrot`, `grim` (+ `slurp` for areas), ImageMagick `import` + `xdotool` |
| Windows | PowerShell: a translucent drag-to-select overlay for areas, the foreground window for windows, the virtual screen for full screen |
| Web pages | Any Chromium-based browser in headless mode, found automatically or set with `localpilot.browser.chromePath` |

## Example prompts

- *"Start the dev server, open it in the browser view and screenshot the dashboard at phone size. Fix anything that overflows."*
- *"This dialog is misaligned. Find the CSS causing it and fix it."*
- *"Here's the failing test output. Fix the bug."*
- *"Rebuild this mock-up in React."*
