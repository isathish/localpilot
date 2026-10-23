# Inline completions

Ghost-text suggestions come from a small fill-in-the-middle (FIM) model running locally, so they are fast and private.

Good choices: `qwen2.5-coder:1.5b-base`, `qwen2.5-coder:7b-base`, `codestral`, `starcoder2`.

Enable them under **Settings → Inline completions** (or *LocalPilot: Toggle Inline Completions*). LocalPilot picks the first FIM-capable model automatically; you can pin a specific one and tune the debounce and length.
