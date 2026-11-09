import { describe, expect, it } from 'vitest';
import {
  humanToLSP,
  humanToLSPRange,
  lspToHuman,
  lspToHumanRange,
  splitLines,
} from '../../src/position.js';

describe('position conversion', () => {
  it('converts ASCII positions', () => {
    const text = 'abc\ndef';
    expect(humanToLSP(text, { line: 2, character: 2 })).toEqual({ line: 1, character: 1 });
    expect(lspToHuman(text, { line: 1, character: 1 })).toEqual({ line: 2, character: 2 });
  });

  it('converts UTF-8 byte columns to UTF-16 columns', () => {
    const text = 'a😀z';
    expect(humanToLSP(text, { line: 1, character: 6 })).toEqual({ line: 0, character: 3 });
    expect(lspToHuman(text, { line: 0, character: 3 })).toEqual({ line: 1, character: 6 });
  });

  it('clamps out of range positions', () => {
    expect(humanToLSP('', { line: 99, character: 99 })).toEqual({ line: 0, character: 0 });
    expect(humanToLSP('abc', { line: Number.NaN, character: Number.NaN })).toEqual({
      line: 0,
      character: 0,
    });
    expect(lspToHuman('abc', { line: 99, character: 99 })).toEqual({ line: 1, character: 4 });
  });

  it('truncates fractional positions and validates lsp-args inline flags and timeoutMs (F128)', async () => {
    const { parseArgs } = await import('../../src/slash-commands/lsp-args.js');
    const { promiseWithTimeout } = await import('../../src/utils/timeout.js');
    expect(humanToLSP('hello\nworld', { line: 1.7, character: 3.9 })).toEqual({
      line: 0,
      character: 2,
    });
    expect(lspToHuman('hello\nworld', { line: 0.7, character: 2.9 })).toEqual({
      line: 1,
      character: 3,
    });
    expect(
      parseArgs('add ts --command tsserver --languages typescript --timeout 15000xyz').type,
    ).toBe('help');
    expect(parseArgs('add ts --command "   " --languages typescript').type).toBe('help');
    expect(parseArgs('add ts --command=tsserver --languages=typescript').type).toBe('add');
    await expect(promiseWithTimeout(Promise.resolve('ok'), Number.NaN)).resolves.toBe('ok');
  });

  it('converts ranges and splits all newline styles', () => {
    const text = 'a\r\nbb\rc';
    expect(
      humanToLSPRange(text, { start: { line: 1, character: 1 }, end: { line: 2, character: 2 } }),
    ).toEqual({ start: { line: 0, character: 0 }, end: { line: 1, character: 1 } });
    expect(
      lspToHumanRange(text, { start: { line: 0, character: 0 }, end: { line: 1, character: 1 } }),
    ).toEqual({ start: { line: 1, character: 1 }, end: { line: 2, character: 2 } });
    expect(splitLines('')).toEqual(['']);
    expect(splitLines(text)).toEqual(['a', 'bb', 'c']);
  });
});
