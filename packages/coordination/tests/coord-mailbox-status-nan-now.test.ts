import { describe, expect, it } from 'vitest';
import { mapRegisteredAgentsToStatuses } from '../src/mailbox-status-mappers.js';

describe('mapRegisteredAgentsToStatuses non-finite clock guard (F2294)', () => {
  it('falls back to Date.now() when now is NaN so live agents stay online', () => {
    const nowIso = new Date().toISOString();
    const registry = new Map([
      [
        'a1',
        {
          agentId: 'a1',
          name: 'Agent 1',
          role: 'worker',
          sessionId: 's1',
          status: 'running',
          iterations: 1,
          toolCalls: 1,
          lastSeenAt: nowIso,
          pid: 1,
          source: 'local',
        },
      ],
    ]);
    const statuses = mapRegisteredAgentsToStatuses(registry as never, Number.NaN, 60_000);
    expect(statuses[0]?.online).toBe(true);
  });
});
