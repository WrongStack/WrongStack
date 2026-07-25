/**
 * @wrongstack/plugins — git-autocommit porcelain parsing.
 *
 * `getChangedFiles` turned each `git status --porcelain` line into a path
 * with `line.slice(3).trim()`. Two shapes that produces a path matching no
 * file on disk — and because `stageFiles` filters to files that exist, the
 * change was then dropped from the commit *silently*:
 *
 *  - Renames and copies print `R  old -> new`. Slicing yielded the literal
 *    string `"old -> new"`. The rename never got staged.
 *  - Paths containing a space, a quote, or a non-ASCII byte are C-quoted by
 *    git (`"path with space.ts"`). The quotes stayed attached.
 */
import { describe, expect, it } from 'vitest';
import { parsePorcelainLine } from '../src/git-autocommit/index.js';

describe('parsePorcelainLine — ordinary entries', () => {
  it.each([
    [' M src/app.ts', 'src/app.ts'],
    ['?? new-file.ts', 'new-file.ts'],
    ['A  added.ts', 'added.ts'],
    ['MM both-modified.ts', 'both-modified.ts'],
    [' D deleted.ts', 'deleted.ts'],
    ['UU conflicted.ts', 'conflicted.ts'],
  ])('parses %s', (line, expected) => {
    expect(parsePorcelainLine(line)).toBe(expected);
  });

  it('keeps a nested path intact', () => {
    expect(parsePorcelainLine(' M packages/core/src/index.ts')).toBe('packages/core/src/index.ts');
  });
});

describe('parsePorcelainLine — renames and copies', () => {
  it('stages the DESTINATION of a rename, not the arrow string', () => {
    expect(parsePorcelainLine('R  old-name.ts -> new-name.ts')).toBe('new-name.ts');
  });

  it('handles a staged-and-modified rename', () => {
    expect(parsePorcelainLine('RM old.ts -> new.ts')).toBe('new.ts');
  });

  it('stages the destination of a copy', () => {
    expect(parsePorcelainLine('C  src/a.ts -> src/b.ts')).toBe('src/b.ts');
  });

  it('picks the LAST arrow when a filename itself contains one', () => {
    expect(parsePorcelainLine('R  weird -> name.ts -> final.ts')).toBe('final.ts');
  });

  it('does not treat a plain path containing "->" as a rename', () => {
    // Status code has no R/C, so the arrow is part of the filename.
    expect(parsePorcelainLine(' M a -> b.ts')).toBe('a -> b.ts');
  });
});

describe('parsePorcelainLine — quoted paths', () => {
  it('unquotes a path containing a space', () => {
    expect(parsePorcelainLine(' M "path with space.ts"')).toBe('path with space.ts');
  });

  it('unquotes escaped characters', () => {
    expect(parsePorcelainLine(' M "tab\\there.ts"')).toBe('tab\there.ts');
    expect(parsePorcelainLine(' M "quote\\"inside.ts"')).toBe('quote"inside.ts');
    expect(parsePorcelainLine(' M "back\\\\slash.ts"')).toBe('back\\slash.ts');
  });

  it('decodes octal escapes git uses for non-ASCII bytes', () => {
    // git escapes each UTF-8 BYTE separately, so the bytes have to be
    // reassembled before decoding. Decoding escape-by-escape instead yields
    // the mojibake 'cafÃ©.ts', which matches no file on disk — and the
    // change would be silently dropped, exactly the bug this parsing fixes.
    expect(parsePorcelainLine(' M "caf\\303\\251.ts"')).toBe('café.ts');
  });

  it('decodes a multi-byte path git escaped end to end', () => {
    // \304\261 is UTF-8 for 'ı' (Turkish dotless i).
    expect(parsePorcelainLine(' M "kay\\304\\261t.ts"')).toBe('kayıt.ts');
  });

  it('unquotes the destination of a quoted rename', () => {
    expect(parsePorcelainLine('R  "old name.ts" -> "new name.ts"')).toBe('new name.ts');
  });

  it('leaves an unquoted path untouched', () => {
    expect(parsePorcelainLine(' M plain.ts')).toBe('plain.ts');
  });
});

describe('parsePorcelainLine — degenerate input', () => {
  it('returns null for a line with no path', () => {
    expect(parsePorcelainLine(' M ')).toBeNull();
    expect(parsePorcelainLine('')).toBeNull();
  });
});
