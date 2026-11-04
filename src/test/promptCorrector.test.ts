import * as assert from 'assert';
import { correctPromptNames, editDistance, identifiersIn, NameVocabulary } from '../agent/promptCorrector';

const vocab: NameVocabulary = {
  files: new Set(['dice.py', 'test_dice.py', 'chatController.ts', 'README.md', 'package.json', 'next.ts']),
  identifiers: new Set(['rollDice', 'roll_dice', 'ChatController', 'parseNotation', 'MAX_SIDES']),
};

suite('LocalPilot prompt name correction', () => {
  test('edit distance counts a transposition as one edit and stops early past the limit', () => {
    assert.strictEqual(editDistance('fucntion', 'function', 2), 1);
    assert.strictEqual(editDistance('dicee', 'dice', 1), 1);
    assert.strictEqual(editDistance('abcdef', 'uvwxyz', 2), 3);
  });

  test('misspelled file names and identifiers are corrected to the real workspace names', () => {
    const r = correctPromptNames('fix the bug in dicee.py where rollDise breaks, see src/chatControler.ts and roll_dise', vocab);
    assert.strictEqual(r.text, 'fix the bug in dice.py where rollDice breaks, see src/chatController.ts and roll_dice');
    assert.deepStrictEqual(r.fixes, [
      { from: 'dicee.py', to: 'dice.py' },
      { from: 'rollDise', to: 'rollDice' },
      { from: 'chatControler.ts', to: 'chatController.ts' },
      { from: 'roll_dise', to: 'roll_dice' },
    ]);
  });

  test('plain words, exact names, other extensions, URLs and @mentions are left alone', () => {
    const text = 'please make the form nicer, use Next.js, read README.md and package.json, see https://example.com/dicee.py and @dicee.py';
    assert.deepStrictEqual(correctPromptNames(text, vocab), { text, fixes: [] });
  });

  test('short or ambiguous names are not guessed', () => {
    const ambiguous: NameVocabulary = { files: new Set(['app1.ts', 'app2.ts']), identifiers: new Set(['userId1', 'userId2']) };
    const text = 'look at app3.ts and userId3';
    assert.deepStrictEqual(correctPromptNames(text, ambiguous), { text, fixes: [] });
  });

  test('names being created, renamed to, numbered or differing only in case are left alone', () => {
    const v: NameVocabulary = {
      files: new Set(['user.py', 'main.py', 'dice.py']),
      identifiers: new Set(['rollDice', 'userId']),
    };
    for (const text of ['create users.py', 'rename rollDice to rollDie', 'rename userID to userId', 'make main2.py that imports main.py']) {
      assert.deepStrictEqual(correctPromptNames(text, v), { text, fixes: [] }, text);
    }
    assert.strictEqual(correctPromptNames('open dicee.py', v).text, 'open dice.py');
    assert.strictEqual(correctPromptNames('add a test to dicee.py', v).text, 'add a test to dice.py');
  });

  test('code fences, pasted errors and long pastes are left alone', () => {
    const v: NameVocabulary = { files: new Set(['dice.py']), identifiers: new Set(['fetchUser', 'rollDice']) };
    const fenced = 'why does this fail?\n```js\nconst x = rollDise();\n```';
    assert.deepStrictEqual(correctPromptNames(fenced, v), { text: fenced, fixes: [] });
    const pasted = "src/app.ts(3,5): Cannot find name 'fetchUsers'";
    assert.deepStrictEqual(correctPromptNames(pasted, v), { text: pasted, fixes: [] });
    assert.strictEqual(correctPromptNames('fix the error in dicee.py', v).text, 'fix the error in dice.py');
    const long = 'see dicee.py and rollDise. '.repeat(400);
    assert.ok(long.length > 10_000);
    assert.deepStrictEqual(correctPromptNames(long, v), { text: long, fixes: [] });
  });

  test('identifier harvesting keeps name-like tokens only', () => {
    const out = new Set<string>();
    identifiersIn('function rollDice(notation) { const MAX_SIDES = 100; return parse_notation(notation); } // value', out);
    assert.deepStrictEqual([...out].sort(), ['MAX_SIDES', 'parse_notation', 'rollDice']);
  });
});
