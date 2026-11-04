import { createHash } from 'crypto';

/**
 * Writes a minimal valid PDF 1.4: Helvetica, one content stream per page (lines of a page split on `\n`) and exact xref
 * offsets so pdf.js does not have to recover the file. Pure, for the PDF tests and the offline smoke test.
 * - `outline` adds a bookmark per page ("Page N").
 * - `js` adds a JavaScript OpenAction and a `javascript:` link annotation (they must never run).
 * - `password` encrypts with the Standard security handler (RC4 40-bit, R2) and owner password "owner": the same file
 *   `qpdf --encrypt <password> owner 40 -- in.pdf out.pdf` would write, generated here so no binary fixture is committed.
 */
export function makePdf(pages: string[], opts: { outline?: boolean; js?: boolean; password?: string } = {}): Buffer {
  const objs: string[] = [];
  const add = (body: string): number => objs.push(body);
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const id = createHash('md5').update(pages.join('\f')).digest();
  const crypt = opts.password !== undefined ? standardSecurity(opts.password, 'owner', id) : undefined;
  // Strings and streams are encrypted with a per-object key; the bodies are filled in after numbering.
  const str = (obj: number, s: string): string => `<${(crypt ? crypt.encrypt(obj, Buffer.from(s, 'latin1')) : Buffer.from(s, 'latin1')).toString('hex')}>`;
  const kids: number[] = [];
  const streams: { obj: number; data: Buffer }[] = [];
  for (const text of pages) {
    const lines = text.split('\n').map((l) => `(${l.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj`);
    const content = Buffer.from(`BT /F1 12 Tf 14 TL 72 720 Td ${lines.join(' T* ')} ET`, 'latin1');
    const contentObj = add('');
    streams.push({ obj: contentObj, data: content });
    const page = add('');
    kids.push(page);
    let annots = '';
    if (opts.js) {
      const link = add('');
      objs[link - 1] = `<< /Type /Annot /Subtype /Link /Rect [72 700 300 730] /Border [0 0 0] /A << /S /URI /URI ${str(link, 'javascript:alert(1)')} >> >>`;
      annots = ` /Annots [${link} 0 R]`;
    }
    objs[page - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentObj} 0 R${annots} >>`;
  }
  for (const s of streams) {
    const data = crypt ? crypt.encrypt(s.obj, s.data) : s.data;
    objs[s.obj - 1] = `<< /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`;
  }
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let extra = '';
  if (opts.outline && kids.length) {
    const root = add('');
    const items = kids.map(() => add(''));
    items.forEach((it, i) => {
      const sib = `${i > 0 ? ` /Prev ${items[i - 1]} 0 R` : ''}${i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : ''}`;
      objs[it - 1] = `<< /Title ${str(it, `Page ${i + 1}`)} /Parent ${root} 0 R${sib} /Dest [${kids[i]} 0 R /Fit] >>`;
    });
    objs[root - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
    extra += ` /Outlines ${root} 0 R`;
  }
  if (opts.js) {
    extra += ` /OpenAction << /S /JavaScript /JS ${str(catalog, 'app.alert(1)')} >>`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${extra} >>`;
  const encrypt = crypt ? add(`<< /Filter /Standard /V 1 /R 2 /O <${crypt.o.toString('hex')}> /U <${crypt.u.toString('hex')}> /P ${crypt.p} >>`) : 0;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} /ID [<${id.toString('hex')}> <${id.toString('hex')}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts: Buffer[]): Buffer => createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (pw: string): Buffer => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);

/** PDF 1.7 §7.6.3, algorithms 2–4 for revision 2 (40-bit RC4). */
function standardSecurity(user: string, owner: string, id: Buffer) {
  const p = -4;
  const o = rc4(md5(padded(owner)).subarray(0, 5), padded(user));
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(p);
  const key = md5(padded(user), o, pBytes, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const encrypt = (obj: number, data: Buffer): Buffer => {
    const k = md5(key, Buffer.from([obj & 255, (obj >> 8) & 255, (obj >> 16) & 255, 0, 0])).subarray(0, 10);
    return rc4(k, data);
  };
  return { o, u, p, encrypt };
}
