/**
 * Every LocalPilot key in one place: the VS Code keybindings (read from the extension's manifest, so the table cannot
 * drift from package.json) and the keys inside the chat view, which the webview handles itself. Settings →
 * Keyboard shortcuts and `/keys` show it; "Change…" opens VS Code's Keyboard Shortcuts editor filtered to the command.
 */

export interface ShortcutRow {
  /** What the key does. */
  action: string;
  /** macOS and Windows/Linux key labels. */
  mac: string;
  win: string;
  /** Where it works ("editor focused"), when that matters. */
  when?: string;
  /** VS Code command id: the row can be changed in the Keyboard Shortcuts editor. Chat keys have none (fixed). */
  command?: string;
}

export interface ShortcutGroup {
  id: 'global' | 'review' | 'composer' | 'run' | 'tabs' | 'changes';
  title: string;
  /** Changed in VS Code's Keyboard Shortcuts editor (true) or fixed keys of the chat view (false). */
  customizable: boolean;
  rows: ShortcutRow[];
}

interface ManifestKeybinding {
  command: string;
  key?: string;
  mac?: string;
  when?: string;
}

/** `ctrl+shift+alt+l` → `Ctrl+Shift+Alt+L`; on macOS `cmd+shift+alt+l` → `⌘⇧⌥L`. */
export function keyLabel(key: string, mac: boolean): string {
  return key
    .split(' ')
    .map((chord) => {
      const parts = chord.split('+');
      if (mac) {
        const sym: Record<string, string> = { cmd: '⌘', ctrl: '⌃', shift: '⇧', alt: '⌥', enter: '↩', escape: 'Esc' };
        const order = ['ctrl', 'alt', 'shift', 'cmd'];
        const mods = parts.slice(0, -1).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((p) => sym[p] ?? p);
        const last = parts[parts.length - 1];
        return mods.join('') + (sym[last] ?? (last.length === 1 ? last.toUpperCase() : last[0].toUpperCase() + last.slice(1)));
      }
      return parts.map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+');
    })
    .join(' ');
}

/** The `when` clause in a few words; unknown clauses are left out rather than shown raw. */
function whenLabel(when: string | undefined): string | undefined {
  if (!when) {
    return undefined;
  }
  if (/localpilot\.reviewing/.test(when)) {
    return 'in a review diff';
  }
  if (/terminalFocus/.test(when)) {
    return 'terminal focused';
  }
  if (/pdfViewer|markdownEditor|localpilot\.markdown/.test(when)) {
    return 'in the PDF or Markdown reader';
  }
  if (/!editorTextFocus/.test(when)) {
    return 'outside the text editor';
  }
  if (/editorTextFocus|editorFocus/.test(when)) {
    return 'editor focused';
  }
  return undefined;
}

const CHAT_GROUPS: ShortcutGroup[] = [
  {
    id: 'composer',
    title: 'Chat: message box',
    customizable: false,
    rows: [
      { action: 'Send', mac: '↩', win: 'Enter' },
      { action: 'New line', mac: '⇧↩', win: 'Shift+Enter' },
      { action: 'Send in a new tab (runs in parallel)', mac: '⌘⇧↩', win: 'Ctrl+Shift+Enter' },
      { action: 'Send after this turn (while the agent runs)', mac: '⌥↩', win: 'Alt+Enter' },
      { action: 'Previous / next prompt (empty input)', mac: '↑ / ↓', win: 'Up / Down' },
      { action: 'Next mode: Ask → Agent → Plan → Debug → Multitask', mac: '⇧Tab', win: 'Shift+Tab' },
      { action: 'Build the prepared plan (empty input)', mac: '⌘↩', win: 'Ctrl+Enter' },
      { action: 'Focus the message box', mac: '⌘L', win: 'Ctrl+L' },
      { action: 'Improve the prompt (in the input) / Add context (elsewhere)', mac: '⌘I', win: 'Ctrl+I' },
      { action: 'Slash commands / mentions', mac: '/ · @', win: '/ · @' },
    ],
  },
  {
    id: 'run',
    title: 'Chat: running agent',
    customizable: false,
    rows: [
      { action: 'Stop the agent (or close the open picker)', mac: 'Esc', win: 'Esc' },
      { action: 'Pause after this step / resume', mac: '⌥Esc', win: 'Alt+Esc' },
      { action: 'Approval: allow once / all in this chat / deny', mac: 'Y / A / N', win: 'Y / A / N' },
      { action: 'Approval: deny with a reason', mac: '⇧N', win: 'Shift+N' },
    ],
  },
  {
    id: 'tabs',
    title: 'Chat: tabs',
    customizable: false,
    rows: [
      { action: 'Previous / next chat tab', mac: '⌥↑ / ⌥↓', win: 'Alt+Up / Alt+Down' },
      { action: 'Go to tab 1–9', mac: '⌥1 … ⌥9', win: 'Alt+1 … Alt+9' },
      { action: 'New tab', mac: '⌘⌥T', win: 'Ctrl+Alt+T' },
      { action: 'Close the tab (not while it runs)', mac: '⌘⌥W', win: 'Ctrl+Alt+W' },
      { action: 'Rename the focused tab', mac: 'F2', win: 'F2' },
    ],
  },
  {
    id: 'changes',
    title: 'Chat: Changes panel (file row focused)',
    customizable: false,
    rows: [
      { action: 'Next / previous file', mac: 'J / K', win: 'J / K' },
      { action: 'Accept / reject the file', mac: 'A / R', win: 'A / R' },
      { action: 'Open the diff', mac: '↩', win: 'Enter' },
    ],
  },
];

/** The keybinding groups (from the manifest) followed by the chat's own keys. */
export function shortcutGroups(manifest: { contributes?: { keybindings?: ManifestKeybinding[]; commands?: { command: string; title: string }[] } }): ShortcutGroup[] {
  const titles = new Map((manifest.contributes?.commands ?? []).map((c) => [c.command, c.title]));
  const global: ShortcutRow[] = [];
  const review: ShortcutRow[] = [];
  for (const k of manifest.contributes?.keybindings ?? []) {
    if (!k.command.startsWith('localpilot.') || !k.key) {
      continue;
    }
    const row: ShortcutRow = { action: titles.get(k.command) ?? k.command, mac: keyLabel(k.mac ?? k.key, true), win: keyLabel(k.key, false), command: k.command, ...(whenLabel(k.when) ? { when: whenLabel(k.when) } : {}) };
    (k.command.startsWith('localpilot.review.') ? review : global).push(row);
  }
  return [
    { id: 'global', title: 'VS Code', customizable: true, rows: global },
    ...(review.length ? [{ id: 'review' as const, title: 'Review diff', customizable: true, rows: review }] : []),
    ...CHAT_GROUPS,
  ];
}

/** `/keys`: the same table as Markdown for the chat (the current OS's labels). */
export function shortcutsMarkdown(groups: ShortcutGroup[], mac: boolean): string {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`**${g.title}**${g.customizable ? ' (change in Settings → Keyboard shortcuts)' : ''}`, '');
    for (const r of g.rows) {
      lines.push(`- \`${mac ? r.mac : r.win}\` ${r.action}${r.when ? ` (${r.when})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
