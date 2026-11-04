/** Context blocks inlined into a sent message, mapped back to the `@` mention that produced them. */
const MENTION_BLOCKS: Record<string, string> = { workspace_tree: '@workspace', problems: '@problems', git: '@git', open_editors: '@editors', terminal_output: '@terminal' };

/**
 * The attachment refs of a sent user message, recovered from the blocks inlined into its content, so a rewound
 * message comes back into the composer with the same chips (`path`, `path#L3-9`, `doc.pdf#page=2-4`, `@problems` …).
 */
export function rewindAttachments(content: string): string[] {
  const refs: string[] = [];
  const add = (r: string) => {
    if (r && !refs.includes(r)) {
      refs.push(r);
    }
  };
  const re = /<(attachment|directory|workspace_tree|problems|git|open_editors|terminal_output)\b([^>]*)>[\s\S]*?<\/\1>/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const [, tag, attrs] = m;
    if (MENTION_BLOCKS[tag]) {
      add(MENTION_BLOCKS[tag]);
      continue;
    }
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
    const p = attr('path')?.replace(/&quot;/g, '"');
    if (!p) {
      continue;
    }
    const pages = /^(\d+)(?:-(\d+))? of (\d+)$/.exec(attr('pages') ?? '');
    const lines = /^(\d+)(?:-(\d+))?$/.exec(attr('lines') ?? '');
    if (pages && pages[1] !== '0' && !(pages[1] === '1' && (pages[2] ?? pages[1]) === pages[3])) {
      add(`${p}#page=${pages[1]}${pages[2] && pages[2] !== pages[1] ? `-${pages[2]}` : ''}`);
    } else if (lines) {
      add(`${p}#L${lines[1]}${lines[2] && lines[2] !== lines[1] ? `-${lines[2]}` : ''}`);
    } else {
      add(p);
    }
  }
  return refs;
}
