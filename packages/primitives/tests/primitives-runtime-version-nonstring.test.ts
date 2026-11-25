import { describe, expect, it } from 'vitest';
import { shouldReplaceOlderDaemon } from '../src/runtime-version.js';

describe('shouldReplaceOlderDaemon non-string clientVersion guard', () => {
  it('returns false without throwing when clientVersion is not a string', () => {
    expect(shouldReplaceOlderDaemon('1.0.0', null as never)).toBe(false);
    expect(shouldReplaceOlderDaemon('1.0.0', '2.0.0')).toBe(true);
    expect(shouldReplaceOlderDaemon('2.0.0', '1.0.0')).toBe(false);
  });
});
