import { describe, expect, it } from 'vitest';
import { mergeTrustEntries } from '../src/security/trust-entry.js';

describe('mergeTrustEntries explicit-undefined guard (F2284)', () => {
  it('does not let undefined fields on exact entry clear wildcard denyPrivate', () => {
    const merged = mergeTrustEntries(
      { allow: ['ls'], denyPrivate: undefined },
      { denyPrivate: true, deny: ['rm'] },
    );
    expect(merged?.denyPrivate).toBe(true);
  });
});
