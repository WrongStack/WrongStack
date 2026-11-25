import { describe, expect, it } from 'vitest';
import { failedRunResumePrompt } from '../src/types/failed-run-resume.js';
import { ProviderError } from '../src/types/provider-errors.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('resume and provider error Unicode boundaries', () => {
  it('keeps capped failed-run reasons well-formed', () => {
    expect(hasLoneSurrogate(failedRunResumePrompt(1, `${'a'.repeat(199)}😀tail`))).toBe(false);
  });

  it('keeps capped provider request IDs well-formed', () => {
    const error = new ProviderError('failed', 500, true, 'provider', {
      body: { requestId: `${'a'.repeat(15)}😀tail` } as never,
    });
    expect(hasLoneSurrogate(error.describe())).toBe(false);
  });
});
