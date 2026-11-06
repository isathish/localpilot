/**
 * A tiny DOM for running webview code (media/*.js sections) in a `vm` sandbox: an HTML parser for `innerHTML`, class /
 * dataset / attribute access, tree edits and `querySelector` with compound selectors (tag, #id, .class, [attr], [attr="v"],
 * :scope, :not(...)), descendant and child combinators and selector lists. Enough for the chat cards, not a browser.
 */

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'wbr']);
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e] ?? _);
const encode = (s: string, attr = false): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(attr ? /"/g : /$^/g, '&quot;');

export class MiniText {
  readonly nodeType = 3;
  parentNode: MiniElement | null = null;
  constructor(public text: string) {}
  get textContent(): string { return this.text; }
}

type Child = MiniElement | MiniText;

interface Compound { tag?: string; id?: string; classes: string[]; attrs: { name: string; value?: string }[]; scope: boolean; not: Compound[] }
type Complex = { compound: Compound; comb: ' ' | '>' | '' }[];

function parseCompound(src: string): Compound {
  const c: Compound = { classes: [], attrs: [], scope: false, not: [] };
  const re = /^(\*|[a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]|:scope|:not\(([^)]*)\)/g;
  let m: RegExpExecArray | null; let pos = 0;
  while (pos < src.length && (re.lastIndex = pos, m = re.exec(src)) && m.index === pos) {
    if (m[1]) { if (m[1] !== '*') { c.tag = m[1].toLowerCase(); } }
    else if (m[2]) { c.classes.push(m[2]); }
    else if (m[3]) { c.id = m[3]; }
    else if (m[4]) { c.attrs.push({ name: m[4], value: m[5] ?? m[6] ?? m[7] }); }
    else if (m[0] === ':scope') { c.scope = true; }
    else if (m[8] !== undefined) { c.not.push(parseCompound(m[8].trim())); }
    pos = re.lastIndex;
    if (m[0] === '') { break; }
  }
  if (pos !== src.length) { throw new Error(`miniDom: unsupported selector "${src}"`); }
  return c;
}

function parseSelector(sel: string): Complex[] {
  return sel.split(',').map((part) => {
    const toks = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const out: Complex = []; let comb: ' ' | '>' | '' = '';
    for (const t of toks) { if (t === '>') { comb = '>'; continue; } out.push({ compound: parseCompound(t), comb: out.length ? (comb || ' ') : '' }); comb = ''; }
    return out;
  });
}

function matchCompound(e: MiniElement, c: Compound, scope: MiniElement | null): boolean {
  if (c.scope && e !== scope) { return false; }
  if (c.tag && e.tagName.toLowerCase() !== c.tag) { return false; }
  if (c.id && e.getAttribute('id') !== c.id) { return false; }
  for (const k of c.classes) { if (!e.classList.contains(k)) { return false; } }
  for (const a of c.attrs) { if (!e.hasAttribute(a.name) || (a.value !== undefined && e.getAttribute(a.name) !== a.value)) { return false; } }
  return c.not.every((n) => !matchCompound(e, n, scope));
}

function matchComplex(e: MiniElement, cx: Complex, i: number, scope: MiniElement | null): boolean {
  if (!matchCompound(e, cx[i].compound, scope)) { return false; }
  if (i === 0) { return true; }
  if (cx[i].comb === '>') { return !!e.parentNode && matchComplex(e.parentNode, cx, i - 1, scope); }
  for (let p = e.parentNode; p; p = p.parentNode) { if (matchComplex(p, cx, i - 1, scope)) { return true; } }
  return false;
}

class ClassList {
  constructor(private readonly el: MiniElement) {}
  private get list(): string[] { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  private set list(v: string[]) { this.el.setAttribute('class', v.join(' ')); }
  contains(c: string): boolean { return this.list.includes(c); }
  add(...cs: string[]): void { const l = this.list; for (const c of cs) { if (!l.includes(c)) { l.push(c); } } this.list = l; }
  remove(...cs: string[]): void { this.list = this.list.filter((x) => !cs.includes(x)); }
  toggle(c: string, force?: boolean): boolean { const on = force ?? !this.contains(c); if (on) { this.add(c); } else { this.remove(c); } return on; }
}

export class MiniElement {
  readonly nodeType = 1;
  parentNode: MiniElement | null = null;
  childNodes: Child[] = [];
  attributes = new Map<string, string>();
  readonly classList = new ClassList(this);
  readonly dataset: Record<string, string>;
  value = '';
  [k: string]: unknown;

  constructor(public tagName: string) {
    this.tagName = tagName.toUpperCase();
    const kebab = (k: string): string => `data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? this.attributes.get(kebab(k)) : undefined),
      set: (_t, k, v) => { this.attributes.set(kebab(String(k)), String(v)); return true; },
      deleteProperty: (_t, k) => { this.attributes.delete(kebab(String(k))); return true; },
      has: (_t, k) => this.attributes.has(kebab(String(k))),
    }) as Record<string, string>;
  }

  get children(): MiniElement[] { return this.childNodes.filter((c): c is MiniElement => c instanceof MiniElement); }
  get firstChild(): Child | null { return this.childNodes[0] || null; }
  get lastElementChild(): MiniElement | null { const c = this.children; return c[c.length - 1] || null; }
  get nextSibling(): Child | null { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
  get nextElementSibling(): MiniElement | null { const p = this.parentNode; if (!p) { return null; } const c = p.children; return c[c.indexOf(this) + 1] || null; }
  /** Inserts nodes right after this element (Element.after). */
  after(...nodes: Child[]): void { const p = this.parentNode; if (!p) { return; } const ref = this.nextSibling; for (const n of nodes) { p.insertBefore(n, ref); } }
  get isConnected(): boolean { let p: MiniElement | null = this; while (p.parentNode) { p = p.parentNode; } return p.tagName === '#ROOT'; }
  get className(): string { return this.getAttribute('class') || ''; }
  set className(v: string) { this.setAttribute('class', v); }
  get title(): string { return this.getAttribute('title') || ''; }
  set title(v: string) { this.setAttribute('title', v); }
  get disabled(): boolean { return this.hasAttribute('disabled'); }
  set disabled(v: boolean) { if (v) { this.setAttribute('disabled', ''); } else { this.removeAttribute('disabled'); } }
  getAttribute(n: string): string | null { return this.attributes.has(n) ? this.attributes.get(n)! : null; }
  setAttribute(n: string, v: string): void { this.attributes.set(n, String(v)); }
  hasAttribute(n: string): boolean { return this.attributes.has(n); }
  removeAttribute(n: string): void { this.attributes.delete(n); }

  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.childNodes = []; if (v) { this.appendChild(new MiniText(String(v))); } }
  get innerHTML(): string {
    return this.childNodes.map((c) => {
      if (c instanceof MiniText) { return encode(c.text); }
      const tag = c.tagName.toLowerCase(); const attrs = [...c.attributes].map(([k, v]) => (v === '' && k === 'disabled' ? ` ${k}` : ` ${k}="${encode(v, true)}"`)).join('');
      return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${c.innerHTML}</${tag}>`;
    }).join('');
  }
  set innerHTML(html: string) { for (const c of this.childNodes) { c.parentNode = null; } this.childNodes = []; for (const c of parseHtml(String(html))) { this.appendChild(c); } }
  insertAdjacentHTML(where: string, html: string): void {
    const nodes = parseHtml(html);
    if (where === 'afterbegin') { const first = this.childNodes[0]; for (const n of nodes) { this.insertBefore(n, first || null); } }
    else if (where === 'beforeend') { for (const n of nodes) { this.appendChild(n); } }
    else { throw new Error(`miniDom: insertAdjacentHTML ${where}`); }
  }

  appendChild<T extends Child>(c: T): T { return this.insertBefore(c, null); }
  insertBefore<T extends Child>(c: T, ref: Child | null): T {
    if (c.parentNode) { c.parentNode.removeChild(c); }
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && i < 0) { throw new Error('miniDom: insertBefore reference is not a child'); }
    if (i < 0) { this.childNodes.push(c); } else { this.childNodes.splice(i, 0, c); }
    c.parentNode = this; return c;
  }
  removeChild<T extends Child>(c: T): T { const i = this.childNodes.indexOf(c); if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; } return c; }
  remove(): void { this.parentNode?.removeChild(this); }

  private descendants(): MiniElement[] { const out: MiniElement[] = []; const walk = (e: MiniElement): void => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  matches(sel: string, scope: MiniElement | null = null): boolean { return parseSelector(sel).some((cx) => matchComplex(this, cx, cx.length - 1, scope)); }
  querySelectorAll(sel: string): MiniElement[] { const cxs = parseSelector(sel); return this.descendants().filter((e) => cxs.some((cx) => matchComplex(e, cx, cx.length - 1, this))); }
  querySelector(sel: string): MiniElement | null { return this.querySelectorAll(sel)[0] || null; }
  closest(sel: string): MiniElement | null { for (let e: MiniElement | null = this; e; e = e.parentNode) { if (e.tagName !== '#ROOT' && e.matches(sel)) { return e; } } return null; }
  focus(): void { /* no focus in a sandbox */ }
}

function parseHtml(html: string): Child[] {
  const root = new MiniElement('#frag'); let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { const tag = m[1].toUpperCase(); for (let e: MiniElement | null = cur; e && e !== root; e = e.parentNode) { if (e.tagName === tag) { cur = e.parentNode!; break; } } }
    else if (m[2]) {
      const e = new MiniElement(m[2]);
      for (const a of (m[3] || '').matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) { e.setAttribute(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? '')); }
      cur.appendChild(e);
      if (!VOID.has(m[2].toLowerCase()) && !m[4]) { cur = e; }
    } else if (m[5] !== undefined) { cur.appendChild(new MiniText(decode(m[5]))); }
  }
  const out = [...root.childNodes]; for (const c of out) { c.parentNode = null; } return out;
}

/** A document whose `body` is connected (`isConnected`), with `createElement`. */
export function miniDocument(): { createElement(tag: string): MiniElement; body: MiniElement; root: MiniElement } {
  const root = new MiniElement('#root'); const body = root.appendChild(new MiniElement('body'));
  return { createElement: (tag: string) => new MiniElement(tag), body, root };
}

/** Dispatches a click the way the chat's delegated handlers read it: `onclick` of the target and its ancestors. */
export function click(target: MiniElement): void {
  const ev = { target, preventDefault: () => undefined, stopPropagation: () => undefined };
  for (let e: MiniElement | null = target; e; e = e.parentNode) { const h = e.onclick; if (typeof h === 'function') { h.call(e, ev); } }
}

/** Submits a form: calls its `onsubmit`. */
export function submit(form: MiniElement): void {
  const h = form.onsubmit; if (typeof h === 'function') { h.call(form, { target: form, preventDefault: () => undefined }); }
}
