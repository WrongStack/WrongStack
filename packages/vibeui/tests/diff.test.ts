import { expect, it } from 'vitest';
import { codeLanguage } from '../src/lib/code-content';
import { compareLines } from '../src/lib/diff';

it.each([
  ['', 'new file'],
  ['deleted file', ''],
  ['a\nb\nc', 'a\nchanged\nc'],
  ['a\nb\nc', 'a\nadded\nb\nc'],
  ['a\na\nb', 'a\nb'],
  ['a\r\nb', 'a\nb'],
  ['a\nb\n', 'b\n'],
])('reconstructs both file versions from the displayed diff: %j → %j', (before, after) => {
  const lines = compareLines(before, after);
  expect(
    lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(before.replaceAll('\r\n', '\n'));
  expect(
    lines
      .filter((line) => line.kind !== 'remove')
      .map((line) => line.text)
      .join('\n'),
  ).toBe(after.replaceAll('\r\n', '\n'));
});
it('marks additions and removals while preserving equal surrounding lines', () => {
  expect(compareLines('a\nb\nc', 'a\nx\nc').map((line) => line.kind)).toEqual([
    'context',
    'remove',
    'add',
    'context',
  ]);
});
it('normalizes standalone CR line endings and detects Dockerfile.* and query-suffixed codeLanguage hints (F86)', () => {
  const crLines = compareLines('line1\rline2', 'line1\nline2');
  expect(crLines).toEqual([
    { kind: 'context', text: 'line1', oldLine: 1, newLine: 1 },
    { kind: 'context', text: 'line2', oldLine: 2, newLine: 2 },
  ]);
  expect(codeLanguage('deploy/Dockerfile.prod')).toBe('dockerfile');
  expect(codeLanguage('Containerfile.dev')).toBe('dockerfile');
  expect(codeLanguage('src/app.ts?raw=1#L5')).toBe('typescript');
});
