import * as fs from 'fs';
import * as path from 'path';

/** The "What's new" card on the empty chat: the version and the top bullets of its CHANGELOG section. */
export interface WhatsNewCard {
  version: string;
  bullets: string[];
}

/** `globalState` key holding the last version whose card was seen or dismissed. */
export const LAST_SEEN_VERSION = 'localpilot.lastSeenVersion';

/** Markdown emphasis, code and links reduced to their text, for a one-line bullet. */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The top bullets of the `## <version>` section of a Keep-a-Changelog file. A bullet that opens with a bold title
 * (`- **Title.** details`) is reduced to its title; otherwise to its first sentence. Empty when there is no section.
 */
export function changelogHighlights(markdown: string, version: string, max = 5): string[] {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const ver = version.replace(/^v/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+\\[?v?${ver}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) {
    return [];
  }
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      break;
    }
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let text = m[1];
    // Continuation lines of a wrapped bullet.
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
      text += ` ${lines[++i].trim()}`;
    }
    const title = /^\*\*(.+?)\*\*/.exec(text);
    const s = plain(title ? title[1] : (/^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text));
    if (s) {
      out.push(s.length > 160 ? `${s.slice(0, 159)}…` : s);
    }
  }
  return out;
}

/** Minimal `vscode.Memento` surface, so the logic runs (and is tested) without VS Code. */
export interface VersionMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
  keys(): readonly string[];
}

/**
 * Decides whether the "What's new" card shows: only after an update (the stored version differs from the running one),
 * never on a fresh install, and never again once dismissed. The changelog is read from the extension folder; no network.
 */
export class WhatsNew {
  private card: WhatsNewCard | undefined;

  constructor(private readonly state: VersionMemento, private readonly version: string, private readonly changelogPath: string) {
    const seen = state.get<string>(LAST_SEEN_VERSION);
    if (seen === version) {
      return;
    }
    // A first install has nothing "new": remember the version quietly. Any other stored key means LocalPilot ran before.
    if (seen === undefined && !state.keys().some((k) => k !== LAST_SEEN_VERSION)) {
      void state.update(LAST_SEEN_VERSION, version);
      return;
    }
    let md = '';
    try {
      md = fs.readFileSync(changelogPath, 'utf8');
    } catch {
      /* no changelog bundled: nothing to show */
    }
    const bullets = changelogHighlights(md, version);
    if (bullets.length) {
      this.card = { version, bullets };
    } else {
      void state.update(LAST_SEEN_VERSION, version);
    }
  }

  /** The card to show on the empty chat, until it is dismissed. */
  get pending(): WhatsNewCard | undefined {
    return this.card;
  }

  get changelog(): string {
    return this.changelogPath;
  }

  async dismiss(): Promise<void> {
    this.card = undefined;
    await this.state.update(LAST_SEEN_VERSION, this.version);
  }

  static forExtension(state: VersionMemento, version: string, extensionPath: string): WhatsNew {
    return new WhatsNew(state, version, path.join(extensionPath, 'CHANGELOG.md'));
  }
}
