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
});
