import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/codebase-index/py-parser.js';

async function withPythonFile(
  content: string,
  run: (file: string, content: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'ws-py-parser-'));
  const file = join(dir, 'mod.py');
  try {
    await writeFile(file, content, 'utf8');
    await run(file, content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const parse = (file: string, content: string) => parseSymbols({ file, content, lang: 'py' });

describe('py-parser parseSymbols', () => {
  it('extracts symbols from Python source', async () => {
    await withPythonFile(
      ['class Widget:', '    pass', '', 'def build():', '    return Widget()', '', 'y = 1'].join(
        '\n',
      ),
      async (file, content) => {
        const res = await parse(file, content);
        expect(res.file).toBe(file);
        expect(res.symbols.find((s) => s.name === 'Widget')?.kind).toBe('class');
        expect(res.symbols.find((s) => s.name === 'build')?.kind).toBe('function');
        expect(res.symbols.find((s) => s.name === 'y')?.kind).toBe('var');
      },
    );
  });

  it('handles invalid Python source without throwing', async () => {
    await withPythonFile('def broken(:', async (file, content) => {
      const res = await parse(file, content);
      expect(res.file).toBe(file);
      // With a working Python runtime, ast fails → empty.
      // Without Python, the generic regex fallback may still see `def broken`.
      if (res.symbols.length > 0) {
        expect(res.symbols.some((s) => s.name === 'broken')).toBe(true);
      } else {
        expect(res.symbols).toEqual([]);
      }
    });
  });
});
