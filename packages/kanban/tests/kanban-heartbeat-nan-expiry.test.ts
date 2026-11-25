import { describe, expect, it } from 'vitest';
import { isAssignmentHeartbeatDue } from '../src/manager/recovery.js';

describe('isAssignmentHeartbeatDue invalid timestamp guard (F2231)', () => {
  it('fails closed (returns true) when leaseExpiresAt is unparseable', () => {
    expect(
      isAssignmentHeartbeatDue(
        {
          status: 'running',
          claimedAt: '2026-01-01T00:00:00.000Z',
          leaseExpiresAt: 'not-a-valid-date',
        } as unknown as Parameters<typeof isAssignmentHeartbeatDue>[0],
        '2026-01-01T00:01:00.000Z',
      ),
    ).toBe(true);

    expect(
      isAssignmentHeartbeatDue(
        {
          status: 'running',
          claimedAt: '2026-01-01T00:00:00.000Z',
          leaseExpiresAt: '2026-01-01T00:10:00.000Z',
        } as unknown as Parameters<typeof isAssignmentHeartbeatDue>[0],
        '2026-01-01T00:01:00.000Z',
      ),
    ).toBe(false);
  });
});
