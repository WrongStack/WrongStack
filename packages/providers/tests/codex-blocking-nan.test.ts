import { describe, expect, it } from 'vitest';
import { codexBlockingWindow } from '../src/openai-codex-rate-limits.js';

describe('codexBlockingWindow non-finite usedPercent', () => {
  it('ignores non-finite usedPercent instead of treating it as blocking', () => {
    expect(
      codexBlockingWindow({
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [{ id: 'primary', usedPercent: 100 }],
        capturedAt: 0,
      })?.id,
    ).toBe('primary');

    for (const usedPercent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        codexBlockingWindow({
          providerId: 'openai-codex',
          meterId: 'codex',
          windows: [{ id: 'primary', usedPercent }],
          capturedAt: 0,
        }),
      ).toBeUndefined();
    }
  });
});
