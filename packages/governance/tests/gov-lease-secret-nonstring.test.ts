import { describe, expect, it } from 'vitest';
import { verificationExecutionLeaseSecretMatches } from '../src/verification-execution-lease.js';

describe('verificationExecutionLeaseSecretMatches non-string secret guard (F2250)', () => {
  it('returns false instead of throwing on non-string secret', () => {
    expect(
      verificationExecutionLeaseSecretMatches(undefined as unknown as string, 'a'.repeat(64)),
    ).toBe(false);
  });
});
