/**
 * Smoke checks (bundled into scripts/smoke.ts) for the editor integrations: the notebook_edit JSON fallback the CLI
 * uses, the cell context of the notebook commands, and the one-shot commit message prompt.
 */
import { applyNotebookJsonEdit, describeCells, emptyNotebook, parseNotebookEditArgs } from '../src/tools/notebookCells';
import { notebookToCompactText } from '../src/context/extractors';
import { cleanCommitMessage, commitMessagePrompt, commitRules, truncateDiff } from '../src/ui/commitMessage';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function editorIntegration(check: Check): void {
  console.log('\n[notebook_edit / cell context / commit message]');
  const nb = JSON.stringify({ cells: [{ cell_type: 'code', execution_count: 1, metadata: {}, outputs: [{ output_type: 'stream', text: 'x' }], source: ['a = 1'] }], metadata: {}, nbformat: 4, nbformat_minor: 4 }, null, 1);
  const ins = applyNotebookJsonEdit(nb, { action: 'insert', cell: 1, cellType: 'markdown', source: '# Head\ntext' });
  const view = notebookToCompactText(ins.json).text;
  check('notebook JSON insert: new cell first, read_file numbering follows', /^# \[markdown\] cell 1\n# Head\ntext\n# \[code\] cell 2 \(exec 1\)/.test(view), view);
  check('notebook JSON: no ids before nbformat 4.5', !/"id"/.test(ins.json));
  const rep = applyNotebookJsonEdit(ins.json, { action: 'replace', cell: 2, source: 'a = 2' });
  check('notebook JSON replace: outputs and exec count cleared', /"execution_count": null/.test(rep.json) && /"outputs": \[\]/.test(rep.json) && rep.before === 'a = 1');
  let threw = '';
  try {
    applyNotebookJsonEdit(nb, { action: 'delete', cell: 5 });
  } catch (e) {
    threw = String(e);
  }
  check('notebook JSON: out-of-range cell is refused', /out of range/.test(threw), threw);
  const fresh = applyNotebookJsonEdit(emptyNotebook(), { action: 'insert', cell: 1, source: 'print(1)' });
  check('notebook JSON: a new notebook gets nbformat 4.5 cell ids', fresh.cells === 1 && /"id": "[0-9a-f]{8}"/.test(fresh.json));
  check('notebook_edit args: string cell numbers accepted, bad action refused', typeof parseNotebookEditArgs({ action: 'delete', cell: '3' }) === 'object' && typeof parseNotebookEditArgs({ action: 'nope', cell: 1 }) === 'string');
  const ctx = describeCells([{ kind: 'markdown', source: '# t', outputs: [] }, { kind: 'code', language: 'python', source: 'plot()', executionCount: 2, outputs: ['[image output]'] }], 1);
  check('cell context: header, fenced source, outputs', ctx.includes('### Cell 2 (code, python, exec 2) <- target') && ctx.includes('```python\nplot()\n```') && ctx.includes('Output:\n[image output]'), ctx);

  check('commit diff truncated at 5,000 characters with a note', /diff truncated/.test(truncateDiff('x\n'.repeat(4000))) && truncateDiff('abc') === 'abc');
  check('commit rules: only commit-related lines', commitRules('# Style\nTabs.\n- Use conventional commits.') === '- Use conventional commits.');
  const msgs = commitMessagePrompt('+a', { notes: 'draft', staged: false });
  check('commit prompt: notes and unstaged label', /draft/.test(msgs[1].content) && /nothing is staged/.test(msgs[1].content));
  check('commit message cleaned of think tags and fences', cleanCommitMessage('<think>x</think>\n```text\nfix: a\n```') === 'fix: a');
}
