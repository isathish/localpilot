---
title: Markdown & PDF viewers
description: Read Markdown with diagrams, math, alerts and footnotes, kept in step with the source editor, and PDFs with find, outline and thumbnails, right inside VS Code.
permalink: /docs/viewers/
---

## Markdown reader

LocalPilot has a reading view for Markdown: specs, plans and reports the agent writes, long chat answers and any `.md` in your workspace. It renders with VS Code's own Markdown engine, so it looks like the built-in preview, and lays it out as a calm reading column.

### Opening it

- **Reader panel.** Run **LocalPilot: Open Markdown Reader** on a Markdown file (editor title bar, Explorer or editor context menu), click **Open as document** on a chat answer, or let the agent use its `show_markdown` tool. The panel comes back after a window reload when it showed a file.
- **Open With….** Right-click a `.md` or `.markdown` file → **Open With…** → **LocalPilot Markdown Reader**. Each file gets its own tab, so you can read two documents side by side. To make it the default, pick **Configure default editor for '*.md'…** in the same menu.
- **Links.** Clicking a link to another `.md` opens it in the reader; `docs/b.md#intro` scrolls to the *Intro* heading. Links to code open the file at the line: `src/a.ts:10`, `src/a.ts#L10` and `src/a.ts#L10-L20` (the range is selected). `x.pdf#page=3` opens a PDF at that page. Web and `mailto:` links open outside VS Code; any other kind of link is ignored.

### Scroll sync

With the source open next to the reader, scrolling either side keeps the same block in view on the other. Double-click a paragraph, heading, list or code block in the reader to jump to that line in the source. Turn sync off with `localpilot.markdownViewer.scrollSync`.

### What it renders

- **Mermaid diagrams** from ```` ```mermaid ```` blocks, drawn with a bundled copy of Mermaid (no network) in strict security mode. Hover a diagram for **Copy source**, **Copy SVG** and **Save SVG…**. A diagram with a syntax error shows the error above its source; the rest of the page still renders.
- **Math** from VS Code's built-in math support (`$…$`, `$$…$$`), styled with bundled KaTeX fonts.
- **GitHub alerts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]`.
- **Footnotes**: `text[^1]` with `[^1]: the note`, listed at the end with links back.
- **Front matter** as a **Properties** table above the document (`localpilot.markdownViewer.frontMatter`: collapsed, expanded or hidden).
- **Tables** keep their header row in view while you scroll a long table.
- **Images**: relative paths, `/`-paths from the workspace root and `srcset`. A missing image shows an "Image not found" placeholder.

### Outline and navigation

The outline lists headings down to `localpilot.markdownViewer.outlineDepth` (default h3) and follows your position. Long documents get a filter box. A paragraph that is just `[[toc]]` or `[TOC]` becomes a table of contents in the page.

| Key | Action |
|---|---|
| `o` | Show or hide the outline |
| `/` | Filter the outline |
| `w` | Wrap long code lines |
| `+` / `-` | Larger or smaller text |
| `a` | Reading settings (width, font, line height, size) |
| Cmd/Ctrl+F | Find in the page |
| Cmd/Ctrl+C (no selection) | Copy the Markdown |

Code blocks have **Copy** and, for files, **path:line**, which copies a reference such as `docs/spec.md:42-50` you can paste into the chat.

### Reading settings

**Aa** in the toolbar (or `a`) sets the column width (narrow, normal, wide or full), the font (sans, serif or the editor font), the line height and the text size. The choice is remembered and applies at once to every open reader.

### Ask LocalPilot

The speech-bubble button attaches the file to the chat and starts a question about it; for an answer shown from the chat, the text is quoted into the draft instead. Select text in the reader and click the floating **Ask LocalPilot** to attach the file at that line and quote the selection. **LocalPilot: Ask LocalPilot About This Document** does the same from the Explorer (Markdown and PDF files), the editor title of the reader or the Command Palette.

### Export

The **⋯** menu has **Export HTML…**, **Export PDF…** and **Copy HTML**, also available as **LocalPilot: Export Markdown as HTML / as PDF**.

- **HTML** is a single self-contained file: styles, diagrams, math fonts and local images under 5 MB are embedded, and it contains no scripts, so it opens offline in any browser. Larger local images are linked by their path on disk, so they show only on this machine.
- **PDF** prints that page with a Chromium-based browser (Chrome, Chromium, Edge or Brave, or `localpilot.browser.chromePath`) in headless mode. Without one, LocalPilot offers to export HTML instead or to set the browser path.
- **Copy HTML** copies the rendered document, with local image paths relative to the file.

Exports use light colours by default; set `localpilot.markdownViewer.exportTheme` to `match` to keep your editor theme.

### Settings

| Setting | Default | Description |
|---|---|---|
| `localpilot.markdownViewer.scrollSync` | `true` | Keep the reader and the source editor scrolled together |
| `localpilot.markdownViewer.outlineDepth` | `3` | Deepest heading level in the outline and `[[toc]]` |
| `localpilot.markdownViewer.frontMatter` | `collapsed` | `collapsed`, `expanded` or `hidden` |
| `localpilot.markdownViewer.mermaid` | `true` | Draw Mermaid diagrams |
| `localpilot.markdownViewer.exportTheme` | `light` | Colours of exported HTML and PDF: `light`, or `match` for the current VS Code theme |

The reader runs no scripts from the document: it allows only its own script, strips embedded frames, forms and event handlers, and loads no code from the network. Remote images in a document still load.

## PDF viewer

LocalPilot opens PDFs in its own viewer, built on a bundled copy of pdf.js. Everything runs locally: the file never leaves VS Code and the viewer makes no network requests.

### Opening a PDF

- **Double-click** a `.pdf` in the Explorer. If another PDF extension is installed, VS Code asks which viewer to use.
- **Right-click** a PDF → **Open in PDF Viewer**, or run **LocalPilot: Open in PDF Viewer** from the Command Palette.
- **Links.** `docs/spec.pdf:3` in a chat answer, `[spec](docs/spec.pdf#page=3)` in the Markdown reader, and the agent's `open_file` tool open the PDF at page 3. A link to a PDF that is already open turns its page instead of opening a second tab.
- Reopening a file returns to the page and zoom you left it at.

To make the viewer the default (or stop it being the default), set `workbench.editorAssociations`, for example `{ "*.pdf": "localpilot.pdfViewer" }`, or right-click a PDF → **Open With…** → **Configure default editor for '*.pdf'…**.

### Navigation and zoom

| Key | Action |
|---|---|
| `n` / `j`, `p` / `k` | Next or previous page |
| PageDown / PageUp | Scroll by a screen (by a page in Page fit) |
| Home / End | First or last page |
| Cmd/Ctrl+G | Go to a page |
| Cmd/Ctrl+F | Find |
| Cmd/Ctrl+= / Cmd/Ctrl+- / Cmd/Ctrl+0 | Zoom in, out, automatic |
| Cmd/Ctrl+scroll | Zoom |
| `r` / Shift+`r` | Rotate clockwise or counter-clockwise |

The zoom menu has Auto, Page width, Page fit, Actual size and 50–400 %. Text can be selected and copied.

### Sidebar and find

The sidebar shows the PDF's **Outline** (the current section is highlighted) or **Pages** thumbnails. With `localpilot.pdfViewer.sidebar` set to `auto` it shows the outline when there is one, otherwise thumbnails, and stays hidden when the view is narrower than 640 px.

Find highlights every match and counts them ("3 of 12"). It has **Match case**, **Whole words** and **Highlight all**; Enter goes to the next match, Shift+Enter to the previous one.

### Page colours

The colour button switches between **Auto**, **Original**, **Dark** and **Sepia** (`localpilot.pdfViewer.pageColors`). Auto darkens pages in dark themes and draws them in the exact theme colours in high-contrast themes. Dark mode inverts photos too; **⋯ → Show original colours** switches back.

### Large and protected files

PDFs up to `localpilot.pdfViewer.rangeThresholdMB` (16 MB) load at once. Larger ones load page by page as you read, so a 500-page, 200 MB file opens quickly and memory stays bounded. Above `localpilot.pdfViewer.maxFileSizeMB` (1024 MB) the viewer asks first. For a password-protected PDF it asks for the password; the password stays in the viewer and is never stored. A damaged file shows **Not a valid PDF** with **Open with system viewer**. The viewer reloads when the file changes on disk.

### Using a PDF with the agent

- **Ask** in the toolbar attaches the PDF to the chat and starts a question. Select text and click **Ask about selection** to attach that page (`docs/spec.pdf#page=3`) and quote the selection.
- **⋯ → Attach page as image** (or **LocalPilot: Attach Current PDF Page as Image**) renders the current page as a PNG (at most 2000 px wide and 12 MB) and adds it to the chat. Use it for scanned pages, which have no text, and for diagrams, with a vision model.
- **⋯ → Copy page text**, **Document properties**, **Open with system viewer** and **Reveal in file manager**.
- The agent reads PDFs itself with `read_pdf`; see [Context]({{ '/docs/context/' | relative_url }}).

### Security

The viewer never runs JavaScript inside a PDF: pdf.js scripting is off and its sandbox is not shipped. XFA forms are off, form fields are drawn flat and embedded attachments are not exposed. Links open outside VS Code only for `http`, `https` and `mailto`; `file:`, `javascript:` and launch actions are dropped. The webview's content security policy allows only the viewer's own scripts and WebAssembly decoders, and reads nothing from disk except the PDF the host sends it.

### Settings

| Setting | Default | Description |
|---|---|---|
| `localpilot.pdfViewer.pageColors` | `auto` | `auto`, `original`, `dark` or `sepia` |
| `localpilot.pdfViewer.sidebar` | `auto` | `auto`, `outline`, `thumbnails` or `hidden` |
| `localpilot.pdfViewer.defaultZoom` | `auto` | `auto`, `page-width`, `page-fit` or `page-actual` for files opened for the first time |
| `localpilot.pdfViewer.rangeThresholdMB` | `16` | Larger PDFs load page by page |
| `localpilot.pdfViewer.maxFileSizeMB` | `1024` | Ask before opening larger PDFs |
