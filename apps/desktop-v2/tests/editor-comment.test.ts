import { describe, expect, it } from 'vitest';
import { lineCommentMarker, toggleLineComment } from '../src/editor-comment';

describe('editor line comments', () => {
  it('picks the marker from the file name and refuses languages without line comments', () => {
    expect(lineCommentMarker('src/app.tsx')).toBe('//');
    expect(lineCommentMarker('scripts/build.PY')).toBe('#');
    expect(lineCommentMarker('db/schema.sql')).toBe('--');
    expect(lineCommentMarker('docker/Dockerfile')).toBe('#');
    expect(lineCommentMarker('.env.local')).toBe('#');
    expect(lineCommentMarker('styles.css')).toBeNull();
    expect(lineCommentMarker('README.md')).toBeNull();
    expect(lineCommentMarker('LICENSE')).toBeNull();
  });

  it('comments the caret line and keeps the caret on the same character', () => {
    expect(toggleLineComment('  const a = 1;', 8, 8, '//')).toEqual({
      text: '  // const a = 1;',
      start: 11,
      end: 11,
    });
  });

  it('comments every touched line at the shallowest indent and skips blank lines', () => {
    const text = 'if (x) {\n  y();\n\n}\nafter';
    const edit = toggleLineComment(text, 0, 18, '//');
    expect(edit.text).toBe('// if (x) {\n//   y();\n\n// }\nafter');
    // The selection started at the line start, so it now covers the first marker too.
    expect(edit.start).toBe(0);
    expect(edit.text.slice(edit.start, edit.end)).toBe('// if (x) {\n//   y();\n\n// }');
  });

  it('removes markers and one following space when every filled line is commented', () => {
    const text = '  // a\n  //b\n\n  // c';
    const edit = toggleLineComment(text, 0, text.length, '//');
    expect(edit.text).toBe('  a\n  b\n\n  c');
    expect(edit.end).toBe(edit.text.length);
    expect(toggleLineComment('# x', 3, 3, '#')).toEqual({ text: 'x', start: 1, end: 1 });
  });

  it('comments all lines when only some are commented, and moves a caret inside a marker', () => {
    expect(toggleLineComment('// a\nb', 0, 6, '#').text).toBe('# // a\n# b');
    expect(toggleLineComment('// a\n// b', 0, 9, '//').text).toBe('a\nb');
    expect(toggleLineComment('  // a', 3, 3, '//')).toEqual({ text: '  a', start: 2, end: 2 });
  });

  it('leaves blank selections unchanged', () => {
    expect(toggleLineComment('a\n\nb', 2, 2, '//')).toEqual({ text: 'a\n\nb', start: 2, end: 2 });
  });
});
