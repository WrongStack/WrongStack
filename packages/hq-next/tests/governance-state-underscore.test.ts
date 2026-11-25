import type { HqGovernanceSnapshotPayload } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { governanceDetail } from '../src/features/attention/governance';

describe('governanceDetail broker state formatting', () => {
  it('replaces all underscores in multi-word broker states', () => {
    const detail = governanceDetail({
      observedAt: '2026-01-01T00:00:00Z',
      signal: { code: 'attachment_broker_degraded', operatorAction: 'investigate' },
      attachmentBroker: {
        state: 'not_yet_ready',
        health: 'degraded',
        consecutiveFailures: 0,
        pendingRevocations: 0,
        auditHealthy: true,
      },
    } as unknown as HqGovernanceSnapshotPayload);
    expect(detail.facts[0]?.value).toBe('not yet ready · degraded');
  });
});
