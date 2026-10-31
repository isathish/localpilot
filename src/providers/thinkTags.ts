/**
 * Splits reasoning that a model writes inline as `<think>…</think>` (deepseek-r1, qwen3, QwQ… on servers or
 * templates that do not separate it) out of the content stream, so the UI shows it as thinking while it streams
 * instead of a long wait followed by a raw tag dump. Tags may arrive split across chunks; only a reply that
 * *starts* with `<think>` is treated as reasoning, so code that mentions the tag later is left alone.
 */
export class ThinkTagSplitter {
  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';
  private mode: 'start' | 'think' | 'text' = 'start';
  private buf = '';

  push(chunk: string): { type: 'thinking' | 'text'; text: string }[] {
    if (this.mode === 'text') {
      return chunk ? [{ type: 'text', text: chunk }] : [];
    }
    this.buf += chunk;
    const out: { type: 'thinking' | 'text'; text: string }[] = [];
    if (this.mode === 'start') {
      const lead = this.buf.trimStart();
      if (lead.startsWith(ThinkTagSplitter.OPEN)) {
        this.mode = 'think';
        this.buf = lead.slice(ThinkTagSplitter.OPEN.length);
      } else if (ThinkTagSplitter.OPEN.startsWith(lead)) {
        return out; // whitespace or a partial `<think` so far
      } else {
        this.mode = 'text';
        const text = this.buf;
        this.buf = '';
        return [{ type: 'text', text }];
      }
    }
    const end = this.buf.indexOf(ThinkTagSplitter.CLOSE);
    if (end >= 0) {
      const thought = this.buf.slice(0, end);
      const rest = this.buf.slice(end + ThinkTagSplitter.CLOSE.length).replace(/^\s+/, '');
      this.mode = 'text';
      this.buf = '';
      if (thought) {
        out.push({ type: 'thinking', text: thought });
      }
      if (rest) {
        out.push({ type: 'text', text: rest });
      }
      return out;
    }
    // Hold back what could be the start of `</think>`.
    const keep = ThinkTagSplitter.CLOSE.length - 1;
    if (this.buf.length > keep) {
      out.push({ type: 'thinking', text: this.buf.slice(0, -keep) });
      this.buf = this.buf.slice(-keep);
    }
    return out;
  }

  /** Whatever is still buffered when the stream ends (an unterminated `<think>` stays reasoning). */
  flush(): { type: 'thinking' | 'text'; text: string }[] {
    const text = this.buf;
    this.buf = '';
    if (!text) {
      return [];
    }
    return [{ type: this.mode === 'think' ? 'thinking' : 'text', text }];
  }
}
