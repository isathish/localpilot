---
name: vscode-extension-ui
description: Change LocalPilot's user interface: the chat webview (media/chat.css, media/chat.js and the markup in src/ui/chatViewProvider.ts), the settings/setup webview (media/settings.*), and native VS Code surfaces (Agents tree view, status bar, quick picks, notifications). Covers the files that must change together, the theme tokens, narrow-width rules, and how to screenshot the result before calling it done. USE WHEN asked to restyle, clean up, polish, fix layout, add a button/panel/indicator, or otherwise update the UI of this extension.
---

# Updating LocalPilot's UI

The UI lives in a sidebar that is often 300–400 px wide, follows any VS Code theme, and streams updates many times a second. Every change has to survive all three.

## 1. Find the right files

| Surface | Markup | Style | Behaviour | Preview harness |
|---|---|---|---|---|
| Chat view | `src/ui/chatViewProvider.ts` (`html()` template) | `media/chat.css` | `media/chat.js` | `scripts/ui-preview.html`, `scripts/ui-preview-parallel.html` |
| Settings / setup | `src/ui/settingsPanel.ts` (`html()`) | `media/settings.css` | `media/settings.js` | `scripts/settings-preview.html?section=models&light=1` (`?page=setup`) |
| Markdown viewer | `src/ui/markdownViewer.ts` | `media/mdview.css` | `media/mdview.js` | `scripts/mdview-preview.html` |
| Agents view | `src/ui/agentsView.ts` (TreeDataProvider) | ThemeIcons only | commands in `src/extension.ts` | none, use F5 |
| Status bar, quick picks, notifications | `src/extension.ts` (`refreshStatus`, `localpilot.statusMenu`, `cmd(...)`) | none | none | none, use F5 |

The preview harnesses keep **their own copy of the markup**. If you add or rename an element id in `chatViewProvider.ts`, copy the change into `scripts/ui-preview*.html` too, otherwise the preview throws on `$('newId')` and stops looking like the real view. `media/chat.js` looks elements up once in `els` at the top of the file.

Host ⇄ webview messages are typed in `src/ui/chatController.ts` (`ToWebview`, `FromWebview`). To add one: extend the union, send it with `this.broadcast(...)`, handle it in the `switch (m.type)` near the end of `chat.js`, and mock it in the preview's `postMessage` stub.

## 2. Style rules

- **Only use the tokens** at the top of `media/chat.css` (`--fg`, `--muted`, `--border-soft`, `--card`, `--tint`, `--tint-2`, `--accent`, `--brand`, `--ok`, `--warn`, `--error`, `--radius*`, `--fs-*`). They map to `--vscode-*` variables, so light, dark and high-contrast themes work. Never hard-code a colour unless it's a language colour in `.fchip .l-*`. Use `color-mix(in srgb, var(--x) N%, transparent)` for tints.
- **One accent.** `--brand` (amber) means LocalPilot or "working". `--accent` is the host's button colour for primary actions. Semantic colours only carry meaning, so a successful state stays quiet (muted text) and only problems get colour.
- **Fewer boxes.** Before adding a border or a card, try spacing, a divider, or muted text. Stacked panels next to each other should look like one card (see how `#tasks` and `#changes` join in `chat.css`).
- **Narrow widths.** Use container queries (`@container messages (max-width: …)`, `@container (max-width: 330px)`), not media queries. Collapse labels to icons (`.long` / `.short` spans), truncate with ellipsis, and never scroll horizontally. Check 300, 360 and 480 px.
- **Streaming.** Text deltas arrive in coalesced bursts. Don't re-render whole lists on every event: the existing renderers compare a signature string (`tasksSig`, `changesSig`) and keep `scrollTop`. Animations must not move content that's already on screen.
- **CSP.** Scripts load only with the nonce (`script-src 'nonce-…'`), so no inline `<script>` or `onclick=` attributes in the template. Attach handlers in `chat.js`. Inline styles are allowed.
- **Accessibility.** Use real `<button>`s with a `title` or `aria-label`. Icon-only buttons need a label. Keep focus outlines (`--focus`). Text contrast must be at least 4.5:1 in both themes.
- **Native UI** follows VS Code conventions: `ThemeIcon` ids (`$(name)` in labels), `contextValue` strings that drive `view/item/context` menus in `package.json`, and `description` for secondary text. No emoji.

Match the surrounding code: `chat.js` is dense single-line handlers with short comments that explain *why*. Keep that density.

## 3. See it before you call it done

Screenshot the preview at real sidebar widths. Headless Chrome won't render narrower than 500 px, so the script below puts the preview in iframes:

```bash
.claude/skills/vscode-extension-ui/scripts/shoot.sh                       # chat, idle + live, 360 px wide
.claude/skills/vscode-extension-ui/scripts/shoot.sh ui-preview.html 300 "live=0" "plan=1"
.claude/skills/vscode-extension-ui/scripts/shoot.sh settings-preview.html 480 "section=models" "section=models&light=1"
```

It prints the PNG path. Open it with the Read tool and compare it with a screenshot taken **before** your change. Look for clipping, wrapping labels, doubled borders, contrast, and both idle and running states. Then:

```bash
node --check media/chat.js && npx tsc --noEmit && npx eslint src
```

For behaviour the preview can't mock (tree view, status bar, real approvals), press F5 and try it in the Extension Development Host.

## 4. Report

Say what changed visually and at which widths and states you checked it. Mention anything you couldn't check, such as light theme or the native views, so the user knows to look.
