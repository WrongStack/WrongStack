import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  memoryNeedsPathRemap,
  memoryNeedsSymbolRemap,
  parseRenameCommand,
  readIdentifierAt,
  remapAnchors,
  remapSymbolAnchors,
} from '../../src/shared/path-remap.js';

describe('path-remap', () => {
  it('remaps exact file anchors and directory prefixes', () => {
    const { anchors, changed } = remapAnchors(
      [
        { type: 'file', path: 'src/old.ts' },
        { type: 'symbol', path: 'src/old/lib.ts', symbol: 'Foo' },
        { type: 'file', path: 'src/other.ts' },
      ],
      'src/old.ts',
      'src/new.ts',
    );
    expect(changed).toBe(true);
    expect(anchors[0]?.path).toBe('src/new.ts');
    expect(anchors[1]?.path).toBe('src/old/lib.ts');
    expect(anchors[2]?.path).toBe('src/other.ts');

    const dir = remapAnchors([{ type: 'file', path: 'pkg/a/b.ts' }], 'pkg/a', 'pkg/x');
    expect(dir.anchors[0]?.path).toBe('pkg/x/b.ts');
  });

  it('remaps symbol anchors optionally scoped by path', () => {
    const { anchors, changed } = remapSymbolAnchors(
      [
        { type: 'symbol', path: 'a.ts', symbol: 'OldName' },
        { type: 'symbol', path: 'b.ts', symbol: 'OldName' },
        { type: 'file', path: 'a.ts' },
      ],
      { oldSymbol: 'OldName', newSymbol: 'NewName', path: 'a.ts' },
    );
    expect(changed).toBe(true);
    expect(anchors[0]?.symbol).toBe('NewName');
    expect(anchors[1]?.symbol).toBe('OldName');
  });

  it('detects memories that need remap', () => {
    expect(memoryNeedsPathRemap({ anchors: [{ type: 'file', path: 'a.ts' }] }, 'a.ts')).toBe(true);
    expect(memoryNeedsPathRemap({ anchors: [{ type: 'file', path: 'b.ts' }] }, 'a.ts')).toBe(false);
    expect(
      memoryNeedsSymbolRemap(
        { anchors: [{ type: 'symbol', path: 'a.ts', symbol: 'Foo' }] },
        { oldSymbol: 'Foo', path: 'a.ts' },
      ),
    ).toBe(true);
  });

  it('parses mv / git mv / Move-Item', () => {
    expect(parseRenameCommand('git mv packages/foo.ts packages/bar.ts')).toEqual({
      from: 'packages/foo.ts',
      to: 'packages/bar.ts',
    });
    expect(parseRenameCommand('mv -f a b')).toEqual({ from: 'a', to: 'b' });
    expect(parseRenameCommand(`Move-Item -Path 'old.ts' -Destination 'new.ts'`)).toEqual({
      from: 'old.ts',
      to: 'new.ts',
    });
    expect(parseRenameCommand('ls -la')).toBeUndefined();
  });

  it('resolves a move into a directory (trailing separator) to the file inside it', () => {
    expect(parseRenameCommand('git mv src/a.ts lib/')).toEqual({
      from: 'src/a.ts',
      to: 'lib/a.ts',
    });
    expect(parseRenameCommand('mv src/a.ts lib/')).toEqual({ from: 'src/a.ts', to: 'lib/a.ts' });
    expect(parseRenameCommand(`Move-Item 'src\\a.ts' 'lib\\'`)).toEqual({
      from: 'src\\a.ts',
      to: 'lib\\a.ts',
    });
    expect(parseRenameCommand('mv src/old/ lib/')).toEqual({ from: 'src/old/', to: 'lib/old' });
    const { anchors } = remapAnchors([{ type: 'file', path: 'src/a.ts' }], 'src/a.ts', 'lib/a.ts');
    expect(anchors[0]?.path).toBe('lib/a.ts');
  });

  it('honours the GNU target-directory flag (`mv -t DIR SRC`)', () => {
    expect(parseRenameCommand('mv -t lib src/a.ts')).toEqual({ from: 'src/a.ts', to: 'lib/a.ts' });
    expect(parseRenameCommand('mv --target-directory=lib src/a.ts')).toEqual({
      from: 'src/a.ts',
      to: 'lib/a.ts',
    });
    expect(parseRenameCommand('mv -f -t lib/ src/a.ts')).toEqual({
      from: 'src/a.ts',
      to: 'lib/a.ts',
    });
  });

  const tempFiles: string[] = [];
  afterEach(() => {
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    tempFiles.length = 0;
  });

  it('reads identifier at 1-based line/character', () => {
    const file = path.join(os.tmpdir(), `sage-id-${Date.now()}.ts`);
    fs.writeFileSync(file, 'export function oldName() {\n  return 1;\n}\n');
    tempFiles.push(file);
    // line 1, character pointing into oldName
    expect(readIdentifierAt(file, 1, 18)).toBe('oldName');
  });

  // An astral letter is ONE identifier character but TWO UTF-16 units. Walking
  // code units tested a lone surrogate with `\p{L}`, read it as a non-letter,
  // and returned a truncated identifier (`ca𐐀ll` → `ca`, which
  // remapSymbolAnchors can match against a different real symbol) or nothing
  // at all when the astral letter started the identifier. `character` is the
  // tool-input convention: a 1-based BYTE column (plug-lsp humanToLSP).
  it('keeps astral letters inside an identifier', () => {
    const astral = '\u{10400}'; // DESERET CAPITAL LETTER LONG I — \p{L}, 4 bytes
    const file = path.join(os.tmpdir(), `sage-id-astral-${Date.now()}.ts`);
    fs.writeFileSync(file, `const ca${astral}ll = 1;\n`, 'utf8');
    tempFiles.push(file);
    // byte column 9 is the astral letter itself (6 for `const `, 2 for `ca`).
    expect(readIdentifierAt(file, 1, 9)).toBe(`ca${astral}ll`);
    // Byte columns inside the character's 4 bytes belong to that character.
    expect(readIdentifierAt(file, 1, 10)).toBe(`ca${astral}ll`);
  });

  it('keeps an identifier that starts with an astral letter', () => {
    const astral = '\u{10400}';
    const file = path.join(os.tmpdir(), `sage-id-astral-first-${Date.now()}.ts`);
    fs.writeFileSync(file, `const ${astral} = 1;\n`, 'utf8');
    tempFiles.push(file);
    expect(readIdentifierAt(file, 1, 7)).toBe(astral);
    // A byte column past the identifier and its trailing space (on `=`) is
    // still not part of any identifier: 6 bytes for `const `, 4 for the astral
    // letter, 1 for the space, so `=` starts at 1-based byte column 12.
    expect(readIdentifierAt(file, 1, 12)).toBeUndefined();
  });
});
