import { expect, it } from 'vitest';
import {
  codeEditorEdit,
  deleteLines,
  languageNewline,
  smartHome,
  toggleBlockComment,
} from '../src/editor-language';

const key = (key: string, start: number, end = start, mods: Record<string, boolean> = {}) => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
  currentTarget: { selectionStart: start, selectionEnd: end },
});

it('opens and leaves Python blocks and continues doc comments', () => {
  const py = 'def f():';
  expect(languageNewline(py, py.length, py.length, 'a.py')?.text).toBe('def f():\n  ');
  const ret = 'def f():\n    return 1';
  expect(languageNewline(ret, ret.length, ret.length, 'a.py')?.text).toBe(`${ret}\n  `);
  const doc = '  /**';
  expect(languageNewline(doc, doc.length, doc.length, 'a.ts')?.text).toBe('  /**\n   * ');
  const star = '   * text';
  expect(languageNewline(star, star.length, star.length, 'a.ts')?.text).toBe(`${star}\n   * `);
  expect(languageNewline('x = 1', 5, 5, 'a.ts')).toBeNull();
  expect(languageNewline('# note:', 7, 7, 'a.yaml')).toBeNull();
});

it('toggles block comments where a language has no line comment', () => {
  const on = toggleBlockComment('  a { color: red; }', 2, 2, ['/*', '*/']);
  expect(on.text).toBe('  /* a { color: red; } */');
  expect(toggleBlockComment(on.text, 5, 5, ['/*', '*/']).text).toBe('  a { color: red; }');
  expect(codeEditorEdit(key('/', 0, 0, { ctrlKey: true }), 'Title', 'r.md')?.text).toBe(
    '<!-- Title -->',
  );
  expect(codeEditorEdit(key('/', 0, 0, { ctrlKey: true }), 'x', 'a.json')).toBeNull();
});

it('deletes lines, moves Home to the content and indents with Ctrl+]', () => {
  expect(deleteLines('a\nb\nc', 2, 2)).toEqual({ text: 'a\nc', start: 2, end: 2 });
  expect(deleteLines('a\nb', 2, 2)).toEqual({ text: 'a', start: 1, end: 1 });
  expect(smartHome('    x', 5)).toBe(4);
  expect(smartHome('    x', 4)).toBe(0);
  expect(codeEditorEdit(key(']', 0, 0, { ctrlKey: true }), 'x', 'a.ts')?.text).toBe('  x');
  expect(codeEditorEdit(key('[', 0, 0, { ctrlKey: true }), '  x', 'a.ts')?.text).toBe('x');
  // Generic keys still reach pairing and indentation.
  expect(codeEditorEdit(key('(', 0), '', 'a.ts')?.text).toBe('()');
  expect(codeEditorEdit(key('Enter', 1), '{}', 'a.ts')?.text).toBe('{\n  \n}');
});
