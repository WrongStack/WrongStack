import { describe, expect, it } from 'vitest';
import {
  editorKeyEdit,
  indentLines,
  indentUnit,
  newlineWithIndent,
  outdentLines,
  replacementRange,
} from '../src/editor-indent';

describe('editor indentation', () => {
  it('detects the file indentation unit', () => {
    expect(indentUnit('a\n\tb\n\tc\n  d')).toBe('\t');
    expect(indentUnit('a\n  b\n\tc')).toBe('  ');
    expect(indentUnit('')).toBe('  ');
  });
  it('keeps the line indent on Enter and adds one after an opening bracket', () => {
    const text = '  const a = 1;';
    expect(newlineWithIndent(text, text.length, text.length, '  ')).toEqual({
      text: '  const a = 1;\n  ',
      start: 17,
      end: 17,
    });
    const open = 'if (x) {';
    expect(newlineWithIndent(open, open.length, open.length, '  ').text).toBe('if (x) {\n  ');
    // Between a pair the closing bracket goes to its own line at the original indent.
    const pair = '\tf({})';
    const caret = pair.indexOf('}');
    const edit = newlineWithIndent(pair, caret, caret, '\t');
    expect(edit.text).toBe('\tf({\n\t\t\n\t})');
    expect(edit.start).toBe(caret + 3);
    // A selection is replaced.
    expect(newlineWithIndent('  abc', 3, 5, '  ').text).toBe('  a\n  ');
  });
  it('indents every touched line and keeps the selection over them', () => {
    const text = 'a\nb\n\nc';
    const edit = indentLines(text, 0, text.length, '  ');
    expect(edit.text).toBe('  a\n  b\n\n  c');
    expect(edit.text.slice(edit.start, edit.end)).toBe(edit.text);
    // A selection ending at the start of a line does not touch that line.
    expect(indentLines('a\nb\nc', 0, 4, '\t').text).toBe('\ta\n\tb\nc');
    // Starting mid-line moves the start with its text.
    const mid = indentLines('ab\ncd', 1, 4, '  ');
    expect(mid.text.slice(mid.start, mid.end)).toBe('b\n  c');
  });
  it('outdents by at most one unit and never past the line start', () => {
    const text = '    a\n\tb\n c\nd';
    const edit = outdentLines(text, 0, text.length, '  ');
    expect(edit.text).toBe('  a\nb\nc\nd');
    expect(edit.text.slice(edit.start, edit.end)).toBe(edit.text);
    const caret = outdentLines('    x', 4, 4, '  ');
    expect(caret).toEqual({ text: '  x', start: 2, end: 2 });
    expect(outdentLines('x', 1, 1, '  ')).toEqual({ text: 'x', start: 1, end: 1 });
  });
  it('maps keystrokes to edits and leaves modified keys to the textarea', () => {
    const key = (k: string, extra: Record<string, unknown> = {}, start = 0, end = start) => ({
      key: k,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      currentTarget: { selectionStart: start, selectionEnd: end },
      ...extra,
    });
    expect(editorKeyEdit(key('Tab'), 'x')).toEqual({ text: '  x', start: 2, end: 2 });
    expect(editorKeyEdit(key('Tab', {}, 0, 3), 'a\nb')?.text).toBe('  a\n  b');
    expect(editorKeyEdit(key('Tab', { shiftKey: true }, 2), '  x')?.text).toBe('x');
    expect(editorKeyEdit(key('Enter', {}, 3), '  x')?.text).toBe('  x\n  ');
    expect(editorKeyEdit(key('Enter', { shiftKey: true }, 3), '  x')).toBeNull();
    expect(editorKeyEdit(key('Enter', { ctrlKey: true }, 3), '  x')).toBeNull();
    expect(
      editorKeyEdit(key('Enter', { nativeEvent: { isComposing: true } }, 3), '  x'),
    ).toBeNull();
    expect(editorKeyEdit(key('a'), 'x')).toBeNull();
  });
});

describe('replacement range', () => {
  it('finds the single changed range between two texts', () => {
    expect(replacementRange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' });
    expect(replacementRange('ab', 'ab')).toEqual({ from: 2, to: 2, insert: '' });
    expect(replacementRange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' });
    expect(replacementRange('x', '')).toEqual({ from: 0, to: 1, insert: '' });
  });
});
