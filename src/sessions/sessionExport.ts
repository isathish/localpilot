// Markdown and HTML exports of a chat (pure: shared by the SessionStore, continuity's export and the CLI).
import type { Session } from '../types';
import { userText } from '../agent/clarify';

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wraps a chat's Markdown export in a standalone page: the text as written, readable in light and dark themes. */
export function sessionHtml(title: string, markdown: string): string {
  const css = [
    ':root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa}',
    '@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--border:#3d444d;--code:#151b23}}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    'main{max-width:860px;margin:0 auto;padding:32px 24px}',
    'header{color:var(--muted);font-size:13px;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px}',
    'pre{white-space:pre-wrap;word-wrap:break-word;background:var(--code);border:1px solid var(--border);border-radius:6px;padding:16px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  ].join('\n');
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">\n<title>${escHtml(title)}</title>\n<style>\n${css}\n</style>\n</head>\n<body>\n<main>\n<header>Exported from LocalPilot · ${escHtml(new Date().toLocaleString())}</header>\n<pre>${escHtml(markdown)}</pre>\n</main>\n</body>\n</html>\n`;
}

/** A chat as Markdown (what Export as Markdown writes): prompts, answers, tool calls and results, attachments named. */
export function sessionMarkdown(s: Session): string {
  const lines = [`# ${s.title}`, `_Model: ${s.model} · ${new Date(s.createdAt).toLocaleString()}_`, ''];
  for (const m of s.messages) {
    if (m.role === 'tool') {
      lines.push(`<details><summary>Tool result: ${m.toolName}</summary>\n\n\`\`\`\n${m.content.slice(0, 4000)}\n\`\`\`\n</details>\n`);
    } else if (m.role === 'user' && (m.meta?.hidden || m.meta?.toolImages || m.meta?.toolResults)) {
      continue;
    } else if (m.meta?.summary) {
      lines.push('_Conversation compacted_\n');
    } else if (m.role === 'user') {
      const attached = [...m.content.matchAll(/<(attachment|directory|workspace_tree|problems|git|open_editors|terminal_output|selection)\b([^>]*)>[\s\S]*?<\/\1>/g)].map(
        (b) => /\bpath="([^"]*)"/.exec(b[2])?.[1] ?? `@${b[1]}`
      );
      lines.push(`### You\n\n${m.meta?.display ?? userText(m.content)}\n`);
      if (attached.length) {
        lines.push(`Attached: ${[...new Set(attached)].join(', ')}\n`);
      }
    } else {
      lines.push(`### LocalPilot\n\n${m.content}\n`);
      for (const tc of m.toolCalls ?? []) {
        lines.push(`> **tool** \`${tc.name}(${tc.arguments.slice(0, 200)})\`\n`);
      }
    }
  }
  return lines.join('\n');
}

