import { describe, expect, it } from 'vitest';
import { fleetBroadcastTargets } from '../src/server/http-server/api-handlers.js';

const row = (sessionId: string, pid: number, project: string, status = 'active') => ({
  sessionId,
  pid,
  projectSlug: project,
  projectRoot: `/work/${project}`,
  status,
});

describe('fleet broadcast targets', () => {
  const all = [row('a1', 11, 'alpha'), row('a2', 12, 'alpha', 'stale'), row('b1', 21, 'beta')];

  it("follows the host's own registered session's project", () => {
    expect(fleetBroadcastTargets(all, 11, undefined).map((s) => s.sessionId)).toEqual(['a1']);
  });

  it('uses the host project root when the host is not a registered session', () => {
    expect(fleetBroadcastTargets(all, 99, '/work/beta/').map((s) => s.sessionId)).toEqual(['b1']);
  });

  it('addresses nothing, never every project, when the host project is unknown', () => {
    expect(fleetBroadcastTargets(all, 99, undefined)).toEqual([]);
  });
});
