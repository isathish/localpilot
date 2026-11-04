import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { readFileTool } from '../tools/fs';
import { readPdfTool } from '../tools/pdf';
import { WorkspaceContext } from '../context/workspaceContext';
import { builtinAgents } from '../agent/builtinAgents';
import { hasPdf, irrelevantTools } from '../agent/toolRelevance';
import { getConfig } from '../config';
import { canonicalToolName, evaluatePermission } from '../agent/permissions';
import { emptySettings } from '../agent/settings';
import { ToolContext } from '../types';
import { makePdf } from './fixtures/makePdf';
import { makeDocx, makeZip } from './fixtures/makeDocx';

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

function ctx(): ToolContext {
  return {
    sessionId: 'test',
    signal: new AbortController().signal,
    depth: 0,
    requestApproval: async () => true,
    progress() {},
    async trackChange() {},
  };
}

const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, append() {}, appendLine() {} } as unknown as vscode.LogOutputChannel;

let dir = '';
const rel = (p: string) => path.relative(root(), path.join(dir, p)).split(path.sep).join('/');

suite('PDF reading and document attachments', function () {
  this.timeout(60_000);
  suiteSetup(async () => {
    assert.ok(root(), 'tests need a workspace folder');
    dir = path.join(root(), `pdf-read-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'doc.pdf'), makePdf(['Hello LocalPilot', 'Second page']));
    await fs.writeFile(path.join(dir, 'long.pdf'), makePdf(Array.from({ length: 30 }, (_, i) => `Body of page ${i + 1}`)));
    await fs.writeFile(path.join(dir, 'fake.pdf'), 'just text, no signature');
    await fs.writeFile(path.join(dir, 'protected.pdf'), makePdf(['Classified'], { password: 'user' }));
    await fs.writeFile(path.join(dir, 'notes.docx'), makeDocx(['Quarterly notes', 'Second paragraph']));
    await fs.writeFile(path.join(dir, 'analysis.ipynb'), JSON.stringify({ metadata: { language_info: { name: 'python' } }, cells: [{ cell_type: 'code', source: 'print(6 * 7)', outputs: [{ output_type: 'stream', text: '42\n' }, { output_type: 'display_data', data: { 'image/png': 'iVBO' } }] }] }));
    await fs.writeFile(path.join(dir, 'bundle.zip'), makeZip({ 'a.txt': 'a' }));
  });
  suiteTeardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('contributions: settings, the attach command and the explorer entry', () => {
    const pkg = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON;
    const conf = pkg.contributes.configuration;
    const props = Array.isArray(conf) ? Object.assign({}, ...conf.map((c: { properties: object }) => c.properties)) : conf.properties;
    assert.strictEqual(props['localpilot.pdf.maxReadSizeMB'].default, 100);
    assert.strictEqual(props['localpilot.pdf.maxChars'].default, 60000);
    assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'localpilot.attachFile'));
    assert.ok(pkg.contributes.menus['explorer/context'].some((m: { command: string }) => m.command === 'localpilot.attachFile'));
    assert.deepStrictEqual(getConfig().pdf, { maxReadSizeMB: 100, maxChars: 60000 });
  });

  test('read_pdf extracts page text in a forked child', async () => {
    const r = await readPdfTool.execute({ path: rel('doc.pdf') }, ctx());
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /2 pages/);
    assert.match(r.content, /--- Page 1 ---\nHello LocalPilot/);
    assert.match(r.content, /--- Page 2 ---\nSecond page/);
  });

  test('ranges: one page, past the end, 20 pages per call with a read-more hint', async () => {
    const two = await readPdfTool.execute({ path: rel('doc.pdf'), pages: '2' }, ctx());
    assert.ok(!two.content.includes('Hello LocalPilot') && two.content.includes('Second page'), two.content);
    const past = await readPdfTool.execute({ path: rel('doc.pdf'), pages: '5-9' }, ctx());
    assert.ok(past.isError && /past the end.*2 pages/.test(past.content), past.content);
    const first = await readPdfTool.execute({ path: rel('long.pdf') }, ctx());
    assert.match(first.content, /showing pages 1-20/);
    assert.match(first.content, /read more with read_pdf path="[^"]*long\.pdf" pages="21-30"/);
    const rest = await readPdfTool.execute({ path: rel('long.pdf'), pages: '21-30' }, ctx());
    assert.match(rest.content, /Body of page 30/);
    assert.ok(!/read more/.test(rest.content));
    const last = await readPdfTool.execute({ path: rel('long.pdf'), pages: '-2' }, ctx());
    assert.match(last.content, /showing pages 29-30/);
  });

  test('read_file on a PDF redirects to read_pdf (lines are pages)', async () => {
    const r = await readFileTool.execute({ path: rel('doc.pdf'), start_line: 2, end_line: 2 }, ctx());
    assert.match(r.content, /^\(read_file on a PDF: start_line\/end_line are page numbers; prefer read_pdf\)/);
    assert.match(r.content, /Second page/);
    assert.ok(!r.content.includes('Hello LocalPilot'));
  });

  test('not a PDF, password-protected, outside the workspace', async () => {
    const fake = await readPdfTool.execute({ path: rel('fake.pdf') }, ctx());
    assert.ok(fake.isError && /not a PDF/.test(fake.content), fake.content);
    const locked = await readPdfTool.execute({ path: rel('protected.pdf') }, ctx());
    assert.ok(locked.isError && /password-protected/.test(locked.content), locked.content);
    const wrong = await readPdfTool.execute({ path: rel('protected.pdf'), password: 'nope' }, ctx());
    assert.ok(wrong.isError && /password .*incorrect/.test(wrong.content), wrong.content);
    const open = await readPdfTool.execute({ path: rel('protected.pdf'), password: 'user' }, ctx());
    assert.ok(!open.isError && open.content.includes('Classified'), open.content);
    await assert.rejects(readPdfTool.execute({ path: '/etc/x.pdf' }, ctx()), /outside the workspace/);
  });

  test('attachments: PDF pages, notebook cells, Word text and a note for binaries', async () => {
    const w = new WorkspaceContext(log);
    try {
      const pdf = await w.readAttachment(rel('doc.pdf'));
      assert.match(pdf, /^<attachment path="[^"]*doc\.pdf" kind="pdf" pages="1-2 of 2">/);
      assert.ok(pdf.includes('Hello LocalPilot') && pdf.includes('Second page'));
      const page2 = await w.readAttachment(`${rel('doc.pdf')}#page=2`);
      assert.ok(page2.includes('pages="2 of 2"') && !page2.includes('Hello LocalPilot'), page2);
      const past = await w.readAttachment(`${rel('doc.pdf')}#page=5`);
      assert.match(past, /error="bad range">\n\(Page 5 is past the end: the PDF has 2 pages\)/);
      assert.ok(!past.includes('Second page'), past);
      const lines = await w.readAttachment(`${rel('long.pdf')}#L3-L4`);
      assert.ok(lines.includes('Body of page 3') && lines.includes('Body of page 4') && !lines.includes('Body of page 5'), lines);
      const nb = await w.readAttachment(rel('analysis.ipynb'));
      assert.match(nb, /kind="ipynb"/);
      assert.match(nb, /--- Cell 1 \(code, python\) ---\nprint\(6 \* 7\)\nOutput:\n42\n\[image output\]/);
      const docx = await w.readAttachment(rel('notes.docx'));
      assert.match(docx, /kind="docx"/);
      assert.match(docx, /Quarterly notes\n\nSecond paragraph/);
      const zip = await w.readAttachment(rel('bundle.zip'));
      assert.match(zip, /kind="binary">\n\(Binary or unsupported file: bundle\.zip, \d+ B\)/);
      const locked = await w.readAttachment(rel('protected.pdf'));
      assert.match(locked, /error="unreadable">\n\(This PDF is password-protected/);
    } finally {
      w.dispose();
    }
  });

  test('Read(...) permission rules cover read_pdf', () => {
    const perm = { ...emptySettings().permissions, deny: ['Read(./secret/**)'] };
    const r = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
    assert.strictEqual(canonicalToolName('read_pdf'), 'Read');
    assert.strictEqual(evaluatePermission(perm, 'read_pdf', { path: 'secret/a.pdf' }, { root: r }).decision, 'deny');
    assert.strictEqual(evaluatePermission(perm, 'read_pdf', { path: 'docs/a.pdf' }, { root: r }).decision, 'none');
  });

  test('read_pdf is read-only for subagents and only offered when PDFs are in play', () => {
    const explore = builtinAgents().find((a) => a.name === 'explore');
    const researcher = builtinAgents().find((a) => a.name === 'researcher');
    assert.ok(explore?.tools?.includes('read_pdf') && researcher?.tools?.includes('read_pdf'));
    assert.ok(irrelevantTools('fix the pager', undefined, 1).has('read_pdf'));
    assert.ok(!irrelevantTools('summarise docs/spec.pdf', undefined, 1).has('read_pdf'));
    assert.ok(hasPdf(dir), 'a folder with PDFs brings the tool in');
  });
});
