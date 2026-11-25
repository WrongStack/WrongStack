import { describe, expect, it } from 'vitest';
import {
  verificationExecutionLeaseSecretHash,
  verificationExecutionLeaseSecretMatches,
} from '../src/verification-execution-lease.js';

describe('verificationExecutionLeaseSecretMatches hex validation (F1834)', () => {
  it('rejects malformed expectedHash values with trailing non-hex garbage', () => {
    const secret = 'lease-secret-test-value';
    const validHash = verificationExecutionLeaseSecretHash(secret);

    expect(verificationExecutionLeaseSecretMatches(secret, validHash)).toBe(true);
    expect(verificationExecutionLeaseSecretMatches(secret, `${validHash}zzzz`)).toBe(false);
    expect(verificationExecutionLeaseSecretMatches(secret, `${validHash}\n`)).toBe(false);
    expect(verificationExecutionLeaseSecretMatches(secret, `${validHash}00`)).toBe(false);
  });
});
