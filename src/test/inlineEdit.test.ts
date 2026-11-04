import * as assert from 'assert';
import { extractCode } from '../ui/inlineEdit';

suite('Inline edit code extraction', () => {
  test('a TSDoc example with its own fence keeps the full body', () => {
    const body = ['/**', ' * Adds two numbers.', ' * @example', ' * ```ts', ' * add(1, 2);', ' * ```', ' */', 'export function add(a: number, b: number): number {', '  return a + b;', '}'].join('\n');
    assert.strictEqual(extractCode('```ts\n' + body + '\n```\n'), body);
  });
  test('a 4-backtick outer fence keeps an inner ``` block', () => {
    const body = ['Usage:', '```ts', 'run();', '```', 'Done.'].join('\n');
    assert.strictEqual(extractCode('````markdown\n' + body + '\n````'), body);
  });
  test('a nested block with an info string does not end the outer block', () => {
    const body = ['const doc = `', '```js', 'x();', '```', '`;'].join('\n');
    assert.strictEqual(extractCode('```ts\n' + body + '\n```'), body);
  });
  test('prose after the block is dropped', () => {
    assert.strictEqual(extractCode('Here you go:\n```py\nprint(1)\n```\nThis prints 1.\n```\nmore\n```'), 'print(1)');
  });
  test('an unclosed fence returns undefined', () => {
    assert.strictEqual(extractCode('```ts\nconst a = 1;\nconst b ='), undefined);
  });
  test('plain text without fences is returned trimmed', () => {
    assert.strictEqual(extractCode('\n  ls -la  \n'), 'ls -la');
  });
});
