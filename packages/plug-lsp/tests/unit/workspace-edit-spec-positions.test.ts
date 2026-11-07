/**
 * Regression: applyTextEdits diverged from LSP TextEdit/Position semantics in
 * ways that corrupt files written by applyWorkspaceEdit:
 *  - same-position inserts came out in REVERSE array order (edits were applied
 *    from the end backwards), though the spec says array order decides;
 *  - a character past the line length was not clamped, so an over-long
 *    whole-line replacement ran through the newline and deleted the rest of
 *    the file;
 *  - a line past the end resolved to the START of the last line, so an
 *    end-of-file append to a file without a trailing newline landed mid-line.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyTextEdits, applyWorkspaceEdit } from '../../src/tools/workspace-edit.js';

const at = (line: number, character: number) => ({ line, character });
const edit = (sl: number, sc: number, el: number, ec: number, newText: string) => ({
  range: { start: at(sl, sc), end: at(el, ec) },
  newText,
});

describe('applyTextEdits LSP position semantics', () => {
  it('keeps array order for inserts at the same position', () => {
    expect(
      applyTextEdits('code();\n', [
        edit(0, 0, 0, 0, "import a from 'a';\n"),
        edit(0, 0, 0, 0, "import b from 'b';\n"),
      ]),
    ).toBe("import a from 'a';\nimport b from 'b';\ncode();\n");
    expect(applyTextEdits('abc', [edit(0, 0, 0, 0, 'X'), edit(0, 0, 0, 1, 'Y')])).toBe('XYbc');
  });

  it('clamps a character past the line length to the line end', () => {
    expect(
      applyTextEdits('const a = 1;\nconst b = 2;\n', [edit(0, 0, 0, 1000, 'let a = 1;')]),
    ).toBe('let a = 1;\nconst b = 2;\n');
    expect(applyTextEdits('aaa\r\nb\r\n', [edit(0, 0, 0, 99, 'X')])).toBe('X\r\nb\r\n');
  });

  it('treats a line past the end as the end of the document and clamps negative line numbers to 0', () => {
    expect(applyTextEdits('a\nb', [edit(2, 0, 2, 0, '\nc')])).toBe('a\nb\nc');
    expect(applyTextEdits('abc\ndef', [edit(-2, 2, 0, 3, 'X')])).toBe('abX\ndef');
  });

  it('counts a lone CR as a line break, as LSP does', () => {
    // Splitting on LF alone made this file one line long, so the edit to line
    // 1 clamped to end-of-document and was appended after the last CR.
    expect(applyTextEdits('let a = 1;\rlet b = a;\r', [edit(1, 8, 1, 9, 'x')])).toBe(
      'let a = 1;\rlet b = x;\r',
    );
    // Mixed endings still resolve each line correctly.
    expect(applyTextEdits('a\r\nb\rc\nd', [edit(2, 0, 2, 1, 'C'), edit(3, 0, 3, 1, 'D')])).toBe(
      'a\r\nb\rC\nD',
    );
  });

  it('orders zero-length inserts before replacements at the same start offset regardless of input order', () => {
    expect(applyTextEdits('abc', [edit(0, 0, 0, 1, 'Y'), edit(0, 0, 0, 0, 'X')])).toBe('XYbc');
  });

  it('rejects inverted and overlapping text edit ranges instead of corrupting content', () => {
    expect(() => applyTextEdits('abcdef', [edit(0, 4, 0, 2, 'X')])).toThrow(/Inverted|Invalid/i);
    expect(() => applyTextEdits('abcdef', [edit(0, 1, 0, 4, 'X'), edit(0, 2, 0, 5, 'Y')])).toThrow(
      /Overlapping/i,
    );
  });

  it('merges workspace edits across differently-encoded file URIs targeting the same file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'f26-ws-edit-'));
    try {
      const targetFile = path.join(tmpDir, 'sample.ts');
      await fs.writeFile(targetFile, 'const a = 1;\nconst b = 2;\n', 'utf8');

      const uriCanonical = pathToFileURL(targetFile).toString();
      const uriAlt = uriCanonical.includes('%20')
        ? uriCanonical
        : `${uriCanonical.slice(0, -3)}%2ets`;

      await applyWorkspaceEdit(
        {
          changes: {
            [uriCanonical]: [edit(0, 10, 0, 11, '10')],
            [uriAlt]: [edit(1, 10, 1, 11, '20')],
          },
        },
        { fileWritten: async () => {} } as never,
        tmpDir,
      );

      const finalText = await fs.readFile(targetFile, 'utf8');
      expect(finalText).toBe('const a = 10;\nconst b = 20;\n');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
