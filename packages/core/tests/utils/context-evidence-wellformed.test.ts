import { describe, expect, it } from 'vitest';
import {
  extractCommands,
  extractErrors,
  summarizeInput,
  summarizeToolOutput,
} from '../../src/utils/context-evidence-extract.js';

const ROCKET = '\u{1F680}';

/**
 * F2646: the completed-work evidence extractors cap command, error and first-line
 * text with a plain `.slice`. That text becomes the `completedWork` ledger the
 * next request's system prompt carries, so a split astral character reaches the
 * provider wire.
 */
describe('context evidence extraction keeps valid UTF-16 (F2646)', () => {
  it('drops the orphaned half in a command', () => {
    const out = extractCommands('bash', { command: `${'c'.repeat(219)}${ROCKET}tail` })[0] ?? '';

    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe('c'.repeat(219));
  });

  it('drops the orphaned half in summarized input', () => {
    const out = summarizeInput({ path: `${'p'.repeat(159)}${ROCKET}tail` }) ?? '';

    expect(out.isWellFormed()).toBe(true);
  });

  it('drops the orphaned half in the output first line', () => {
    const out = summarizeToolOutput('bash', undefined, `${'o'.repeat(219)}${ROCKET}tail`, {
      files: [],
      symbols: [],
      errors: [],
      ok: true,
    });

    expect(out.isWellFormed()).toBe(true);
  });

  it('drops the orphaned half in an error line', () => {
    const out = extractErrors(`Error: ${'e'.repeat(252)}${ROCKET}tail`) ?? [];

    expect(out[0]?.isWellFormed() ?? false).toBe(true);
  });

  it('keeps short evidence unchanged (control)', () => {
    expect(extractCommands('bash', { command: 'npm test' })[0]).toBe('npm test');
    expect(summarizeInput({ path: 'src/a.ts' })).toBe('path=src/a.ts');
  });
});
