import { describe, expect, it } from 'vitest';
import {
  ENHANCE_MIN_RETRY_TIMEOUT_MS,
  nextEnhanceTimeout,
} from '../src/execution/enhance-recovery.js';

describe('nextEnhanceTimeout non-finite baseMs guard', () => {
  it('returns a finite timeout when baseMs is NaN', () => {
    expect(nextEnhanceTimeout(Number.NaN)).toBe(ENHANCE_MIN_RETRY_TIMEOUT_MS);
    expect(nextEnhanceTimeout(Number.NaN, { enhanceRetryTimeoutMs: 250_000 })).toBe(250_000);
  });
});
