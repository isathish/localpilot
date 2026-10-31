import * as assert from 'assert';
import { ThinkTagSplitter } from '../providers/thinkTags';

/** Feeds `chunks` through a splitter and returns the merged thinking / text it produced. */
function run(chunks: string[]): { thinking: string; text: string } {
  const s = new ThinkTagSplitter();
  const out = { thinking: '', text: '' };
  for (const ev of [...chunks.flatMap((c) => s.push(c)), ...s.flush()]) {
    out[ev.type === 'thinking' ? 'thinking' : 'text'] += ev.text;
  }
  return out;
}

suite('LocalPilot think-tag splitting', () => {
  test('inline <think> reasoning streams as thinking, even with tags split across chunks', () => {
    assert.deepStrictEqual(run(['<think>plan it</think>\n\nAnswer']), { thinking: 'plan it', text: 'Answer' });
    assert.deepStrictEqual(run(['\n<thi', 'nk>step 1, ', 'step 2</th', 'ink>', 'Done.']), { thinking: 'step 1, step 2', text: 'Done.' });
  });

  test('ordinary replies and later mentions of the tag pass through untouched', () => {
    assert.deepStrictEqual(run(['Hello ', 'world']), { thinking: '', text: 'Hello world' });
    assert.deepStrictEqual(run(['Use `<think>` tags', ' like this']), { thinking: '', text: 'Use `<think>` tags like this' });
    assert.deepStrictEqual(run(['<', 'b>bold</b>']), { thinking: '', text: '<b>bold</b>' });
  });

  test('an unterminated <think> stays reasoning; thinking is emitted before the closing tag arrives', () => {
    assert.deepStrictEqual(run(['<think>still going']), { thinking: 'still going', text: '' });
    const s = new ThinkTagSplitter();
    const early = s.push('<think>a long chain of thought');
    assert.ok(early.some((e) => e.type === 'thinking' && e.text.length > 0), 'streams before </think>');
  });
});
