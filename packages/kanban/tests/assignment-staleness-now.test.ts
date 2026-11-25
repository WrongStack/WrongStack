import { describe, expect, it } from 'vitest';
import { isLeaseExpired } from '../src/manager/assignment-staleness.js';

describe('isLeaseExpired invalid now handling', () => {
  it('falls back to Date.now() when now is unparseable', () => {
    expect(isLeaseExpired('2020-01-01T00:00:00Z', 'invalid-now')).toBe(true);
    expect(isLeaseExpired('2099-01-01T00:00:00Z', 'invalid-now')).toBe(false);
  });
});
