import { describe, expect, it } from 'vitest';
import { toIndexSymbols } from '../src/parser-output.js';

const ROCKET = '\u{1F680}';

const symbol = (signature: string) => ({
  kind: 'function',
  name: 'run',
  signature,
  line: 1,
  col: 0,
  doc: '',
  scope: '',
});

/**
 * F2650: `toIndexSymbols` caps a parser-provided signature at 500 UTF-16 units
 * with a plain `.slice`. Signatures come from the language parser and are stored
 * in the code index and rendered by codebase tools.
 */
describe('index symbols keep valid UTF-16 (F2650)', () => {
  it('drops the orphaned half in a signature', () => {
    const [out] = toIndexSymbols(
      [symbol(`${'s'.repeat(499)}${ROCKET}tail`)] as never,
      'a.ts',
      'ts',
    );

    expect(out?.signature.isWellFormed()).toBe(true);
    expect(out?.signature).toBe('s'.repeat(499));
    expect(out?.text.isWellFormed()).toBe(true);
  });

  it('keeps a short signature unchanged (control)', () => {
    const [out] = toIndexSymbols([symbol('run(): void')] as never, 'a.ts', 'ts');

    expect(out?.signature).toBe('run(): void');
  });
});
