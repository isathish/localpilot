---
title: Screenshots & images
description: Show the model what you see — capture a region, paste, or drop an image and let a vision model work on it.
permalink: /docs/images/
---

## Ways to attach an image

- **Capture screenshot** — camera button in the composer, <kbd>⌘⌥⇧S</kbd>, or *LocalPilot: Capture Screenshot to Chat*. Select a screen region and it lands in the composer.
- **Paste** from the clipboard into the input box.
- **Drag and drop** an image file onto the composer.
- **Image button** to pick files, or right-click a PNG/JPEG in the Explorer → *Attach Image to Chat*.

Up to four images per message. Images are downscaled client-side to 1568px on the long edge so they fit typical vision budgets, shown as thumbnails on your message, and click-to-zoom in the transcript.

## Requirements

The selected model must support vision (`qwen2.5vl`, `llava`, `gemma3`, `pixtral`, …). LocalPilot checks the model's capabilities and warns you before sending if it cannot read images.

## Screenshot tooling by platform

| Platform | Tool used |
|---|---|
| macOS | `screencapture -i` (region) — built in |
| Linux | first available of `gnome-screenshot`, `spectacle`, `scrot`, `grim`+`slurp` |
| Windows | PowerShell `System.Drawing` capture of the primary screen |

## Good prompts

- *"This dialog is misaligned — find the CSS causing it and fix it."*
- *"Here's the failing test output. Fix the bug."*
- *"Reproduce this UI from the mock-up in React."*
