import { describe, expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';
import { checkHooks, checkMemoryDedup } from '../src/portable-commands/tuneup-report.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('automation and tuneup Unicode boundaries', () => {
  it('keeps capped automation session IDs well-formed', () => {
    const result = buildAutomationResult(
      JSON.stringify({ status: 'done', sessionId: `${'a'.repeat(255)}😀tail` }),
      null,
      1,
    );
    expect(hasLoneSurrogate(result.sessionId ?? '')).toBe(false);
  });

  it('keeps duplicate-memory samples well-formed', () => {
    const line = `${'a'.repeat(68)}😀tail`;
    const finding = checkMemoryDedup({
      memoryFiles: [
        { label: 'a', path: 'a', content: line },
        { label: 'b', path: 'b', content: line },
      ],
    } as never)[0];
    expect(hasLoneSurrogate(finding?.handoff ?? '')).toBe(false);
  });

  it('keeps slow-hook command previews well-formed', () => {
    const finding = checkHooks({
      config: {
        hooks: {
          beforeTool: [{ type: 'command', command: `${'a'.repeat(44)}😀tail`, timeoutMs: 60000 }],
        },
      },
    } as never)[0];
    expect(hasLoneSurrogate(finding?.problem ?? '')).toBe(false);
  });
});
