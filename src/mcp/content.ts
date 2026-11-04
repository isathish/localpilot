import type { ImageAttachment } from '../ui/images';

/** One item of a `tools/call` result (or of a prompt message) as the MCP spec defines it. */
export interface McpContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  description?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

/** Largest image (decoded) passed on to the model and the chat; bigger ones are named but dropped. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const resourceLine = (uri: string | undefined, mime: string | undefined) => `[resource ${uri ?? ''}${mime ? ` (${mime})` : ''}]`;

/**
 * A tool result's content as text plus images: text items as written, images as `[image <name> (<mime>)]` lines with
 * the data in `images`, embedded resources as `[resource <uri> (<mime>)]` followed by their text, resource links as
 * the same line. `structuredContent` is used when there is no content at all.
 */
export function mcpContentToResult(content: McpContentItem[] | undefined, structured: unknown, label = 'mcp'): { text: string; images: ImageAttachment[] } {
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c || typeof c !== 'object') {
      continue;
    }
    if (c.type === 'text') {
      parts.push(c.text ?? '');
    } else if (c.type === 'image' || (c.type === 'resource' && c.resource?.blob && IMAGE_MIME.test(c.resource.mimeType ?? ''))) {
      const raw = c.type === 'image' ? c.data : c.resource?.blob;
      // Only real base64 reaches the chat (it is put in an img src) and the vision providers.
      const data = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
      const mime = (c.type === 'image' ? c.mimeType : c.resource?.mimeType) || 'image/png';
      const name = `${label}-image-${images.length + 1}.${(/\/(\w+)/.exec(mime)?.[1] ?? 'png').replace('jpeg', 'jpg')}`;
      if (!data || !BASE64.test(data) || !IMAGE_MIME.test(mime)) {
        parts.push(`[image content (${mime}) not shown]`);
      } else if (data.length * 0.75 > MAX_IMAGE_BYTES) {
        parts.push(`[image ${name} (${mime}) larger than 10 MB, not shown]`);
      } else {
        images.push({ name, data, mime });
        parts.push(`[image ${name} (${mime})]`);
      }
    } else if (c.type === 'resource') {
      const r = c.resource ?? {};
      parts.push(r.text !== undefined ? `${resourceLine(r.uri, r.mimeType)}\n${r.text}` : resourceLine(r.uri, r.mimeType));
    } else if (c.type === 'resource_link') {
      parts.push(`${resourceLine(c.uri, c.mimeType)}${c.name && c.name !== c.uri ? ` ${c.name}` : ''}${c.description ? ` — ${c.description}` : ''}`);
    } else {
      parts.push(`[${c.type} content${c.mimeType ? ` (${c.mimeType})` : ''}]`);
    }
  }
  if (!parts.length && structured !== undefined) {
    parts.push(JSON.stringify(structured, null, 2));
  }
  return { text: parts.join('\n'), images };
}

/** False for a tool whose `_meta.ui.visibility` lists who may call it and leaves the model out (an app-only tool). */
export function mcpToolVisibleToModel(tool: { _meta?: unknown }): boolean {
  const ui = (tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui;
  const v = ui?.visibility;
  if (v === undefined || v === null) {
    return true;
  }
  const list = Array.isArray(v) ? v : [v];
  return list.some((x) => x === 'model');
}

/** The text of a `resources/read` result: text contents as written, binary ones named. */
export function mcpResourceText(contents: { uri?: string; mimeType?: string; text?: string; blob?: string }[] | undefined): { text: string; images: ImageAttachment[] } {
  const items: McpContentItem[] = (Array.isArray(contents) ? contents : []).map((r) => ({ type: 'resource', resource: r }));
  const out = mcpContentToResult(items, undefined, 'resource');
  for (const r of Array.isArray(contents) ? contents : []) {
    if (r.blob && !IMAGE_MIME.test(r.mimeType ?? '')) {
      out.text += `\n[binary ${r.mimeType ?? 'data'}, ${Math.round((r.blob.length * 0.75) / 1024)} KB]`;
    }
  }
  return out;
}
