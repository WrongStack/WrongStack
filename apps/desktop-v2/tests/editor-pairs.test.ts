import { describe, expect, it } from 'vitest';
import {
  backspacePair,
  duplicateLines,
  editorPairEdit,
  moveLines,
  pairEdit,
} from '../src/editor-pairs';

const key = (
  k: string,
  start: number,
  end = start,
  mods: Partial<Record<string, boolean>> = {},
) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
  currentTarget: { selectionStart: start, selectionEnd: end },
});

describe('editor pairs', () => {
  it('closes brackets before whitespace or a closer and types over the closer', () => {
    expect(pairEdit('(', 'f', 1, 1, true)).toEqual({ text: 'f()', start: 2, end: 2 });
    expect(pairEdit('{', 'a ]', 2, 2, true)).toEqual({ text: 'a {}]', start: 3, end: 3 });
    expect(pairEdit('(', 'ab', 0, 0, true)).toBeNull();
    expect(pairEdit(')', 'f()', 2, 2, true)).toEqual({ text: 'f()', start: 3, end: 3 });
  });
  it('wraps a one-line selection and leaves multi-line selections alone', () => {
    expect(pairEdit('[', 'x = a', 4, 5, true)).toEqual({ text: 'x = [a]', start: 5, end: 6 });
    expect(pairEdit('(', 'a\nb', 0, 3, true)).toBeNull();
  });
  it('pairs quotes in code but not after a word or in prose', () => {
    expect(pairEdit('"', 'x = ', 4, 4, true)).toEqual({ text: 'x = ""', start: 5, end: 5 });
    expect(pairEdit("'", 'don', 3, 3, true)).toBeNull();
    expect(pairEdit("'", 'x ', 2, 2, false)).toBeNull();
    expect(editorPairEdit(key("'", 0), '', 'notes.md')).toBeNull();
    expect(editorPairEdit(key("'", 0), '', 'a.ts')).toEqual({ text: "''", start: 1, end: 1 });
  });
  it('deletes an empty pair with backspace', () => {
    expect(backspacePair('f()', 2, 2, true)).toEqual({ text: 'f', start: 1, end: 1 });
    expect(backspacePair('f(x)', 3, 3, true)).toBeNull();
    expect(backspacePair('""', 1, 1, false)).toBeNull();
  });
  it('moves and duplicates whole lines', () => {
    expect(moveLines('a\nb\nc', 2, 3, 'up')).toEqual({ text: 'b\na\nc', start: 0, end: 1 });
    expect(moveLines('a\nb\nc', 2, 2, 'down')).toEqual({ text: 'a\nc\nb', start: 4, end: 4 });
    expect(moveLines('a\nb', 0, 0, 'up')).toBeNull();
    expect(moveLines('a\nb', 2, 2, 'down')).toBeNull();
    expect(moveLines('a\nb\nc\nd', 0, 3, 'down')).toEqual({ text: 'c\na\nb\nd', start: 2, end: 5 });
    expect(duplicateLines('a\nb', 0, 1)).toEqual({ text: 'a\na\nb', start: 2, end: 3 });
    expect(
      editorPairEdit(key('ArrowDown', 0, 0, { altKey: true, shiftKey: true }), 'x', 'a.ts'),
    ).toEqual({
      text: 'x\nx',
      start: 2,
      end: 2,
    });
  });
  it('leaves modified and composing keys to the textarea', () => {
    expect(editorPairEdit(key('(', 0, 0, { ctrlKey: true }), '', 'a.ts')).toBeNull();
    expect(
      editorPairEdit({ ...key('(', 0), nativeEvent: { isComposing: true } }, '', 'a.ts'),
    ).toBeNull();
  });
});
