import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { effectiveScope, scopeSnapshot } from '../src/lib/scope.js';

describe('effectiveScope offline machine retention', () => {
  it('keeps a machine scope active when the machine is present in offlineMachines', () => {
    const snapshot = {
      machines: [{ machineId: 'm1', hostname: 'live-box', projectIds: ['p1'] }],
      offlineMachines: [
        { key: 'host:gpu-offline', hostname: 'gpu-offline', projects: [] },
        { key: 'host:other-offline', hostname: 'other-offline', projects: [] },
      ],
      clients: [],
      liveSessions: [],
      projects: [{ projectId: 'p1', projectName: 'Proj', machineIds: ['m1'], totalCostUsd: 0 }],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: {},
    } as unknown as HqSnapshot;

    const scope = { kind: 'machine' as const, id: 'host:gpu-offline' };
    expect(effectiveScope(scope, snapshot)).toEqual(scope);

    const scoped = scopeSnapshot(snapshot, scope);
    expect(scoped?.offlineMachines?.map((m) => m.key)).toEqual(['host:gpu-offline']);
    expect(effectiveScope({ kind: 'machine', id: 'host:gone' }, snapshot).kind).toBe('all');
  });
});
