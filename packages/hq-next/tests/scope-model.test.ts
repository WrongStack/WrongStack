/**
 * The operator's scope: one machine or one project narrows the fleet the same
 * way on every surface, and a stale choice never empties HQ.
 */
import type { HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPE,
  belongsToMachine,
  effectiveScope,
  inScope,
  machineIdsForKey,
  scopeLabel,
  scopeSnapshot,
} from '../src/lib/scope';

const T = '2026-11-01T12:00:00.000Z';

// Two machines; project alpha runs on both, beta only on m2.
const snapshot = {
  generatedAt: T,
  clients: [
    { clientId: 'c1', machineId: 'm1', hostname: 'desk', projectId: 'alpha', connected: true },
    { clientId: 'c2', machineId: 'm2', hostname: 'lab', projectId: 'alpha', connected: true },
    { clientId: 'c3', machineId: 'm2', hostname: 'lab', projectId: 'beta', connected: false },
  ],
  projects: [
    { projectId: 'alpha', projectName: 'Alpha', machineIds: ['m1', 'm2'], totalCostUsd: 5 },
    { projectId: 'beta', projectName: 'Beta', machineIds: ['m2'], totalCostUsd: 2 },
  ],
  machines: [
    { machineId: 'm1', hostname: 'desk', projectIds: ['alpha'] },
    { machineId: 'm2', hostname: 'lab', projectIds: ['alpha', 'beta'] },
  ],
  sessions: [
    { sessionId: 's1', clientId: 'c1', projectId: 'alpha', costUsd: 1.5 },
    { sessionId: 's2', clientId: 'c2', projectId: 'alpha', costUsd: 3.5 },
    { sessionId: 's3', clientId: 'c3', projectId: 'beta', costUsd: 2 },
  ],
  liveSessions: [
    { sessionId: 's1', machineId: 'm1', projectId: 'alpha', agents: [{ id: 'a' }] },
    { sessionId: 's2', machineId: 'm2', projectId: 'alpha', agents: [{ id: 'a' }, { id: 'b' }] },
  ],
  fleets: [{ runId: 'r1', clientId: 'c2', projectId: 'alpha', activeSubagents: 3 }],
  mailboxes: [
    { mailboxId: 'x', projectId: 'alpha', unreadCount: 1, incompleteCount: 2 },
    { mailboxId: 'y', projectId: 'beta', unreadCount: 4, incompleteCount: 0 },
  ],
  mcpServers: [{ name: 'db', clientId: 'c3', projectId: 'beta' }],
  totals: { totalCostUsd: 7 },
} as unknown as HqSnapshot;

describe('scopeSnapshot', () => {
  it('returns the fleet untouched for the whole-fleet scope', () => {
    expect(scopeSnapshot(snapshot, ALL_SCOPE)).toBe(snapshot);
  });

  it('narrows to one machine and prices it by its own sessions', () => {
    const lab = scopeSnapshot(snapshot, { kind: 'machine', id: 'host:lab' });
    expect(lab?.clients.map((c) => c.clientId)).toEqual(['c2', 'c3']);
    expect(lab?.projects.map((p) => p.projectId)).toEqual(['alpha', 'beta']);
    expect(lab?.liveSessions?.map((s) => s.sessionId)).toEqual(['s2']);
    expect(lab?.mcpServers?.map((s) => s.name)).toEqual(['db']);
    expect(lab?.totals).toMatchObject({
      activeClients: 1,
      activeSessions: 1,
      activeAgents: 2,
      activeSubagents: 3,
      // s2 + s3 — not alpha's 5, which includes the other machine.
      totalCostUsd: 5.5,
      unreadMailboxMessages: 5,
    });
  });

  it('narrows to one project across machines', () => {
    const beta = scopeSnapshot(snapshot, { kind: 'project', id: 'beta' });
    expect(beta?.clients.map((c) => c.clientId)).toEqual(['c3']);
    expect(beta?.machines?.map((m) => m.machineId)).toEqual(['m2']);
    expect(beta?.fleets).toEqual([]);
    expect(beta?.totals.totalCostUsd).toBe(2);
  });
});

describe('scope rules', () => {
  it('falls back to the whole fleet when the chosen machine or project is gone', () => {
    expect(effectiveScope({ kind: 'machine', id: 'gone' }, snapshot)).toEqual(ALL_SCOPE);
    expect(effectiveScope({ kind: 'project', id: 'beta' }, snapshot)).toEqual({
      kind: 'project',
      id: 'beta',
    });
  });

  it('places records by client, machine or project, and keeps unknown ones visible', () => {
    const m1 = { kind: 'machine' as const, id: 'host:desk' };
    expect(inScope({ clientId: 'c2' }, m1, snapshot)).toBe(false);
    expect(inScope({ clientId: 'c1' }, m1, snapshot)).toBe(true);
    // A project-only record belongs to a machine its project runs on.
    expect(inScope({ projectId: 'beta' }, m1, snapshot)).toBe(false);
    expect(inScope({ projectId: 'alpha' }, m1, snapshot)).toBe(true);
    expect(inScope({}, m1, snapshot)).toBe(true);
    expect(inScope({ projectId: 'alpha' }, { kind: 'project', id: 'beta' }, snapshot)).toBe(false);
  });

  it('keys machines by hostname, so every process on one computer is one machine', () => {
    // A raw id is not a machine key; the stale preference falls back.
    expect(effectiveScope({ kind: 'machine', id: 'm2' }, snapshot)).toEqual(ALL_SCOPE);
    const twoIds = {
      ...snapshot,
      clients: [
        ...snapshot.clients,
        {
          clientId: 'c4',
          machineId: 'm2-pid-9',
          hostname: 'LAB',
          projectId: 'beta',
          connected: true,
        },
      ],
    } as unknown as HqSnapshot;
    expect([...machineIdsForKey(twoIds, 'host:lab')].sort()).toEqual(['m2', 'm2-pid-9']);
    const lab = scopeSnapshot(twoIds, { kind: 'machine', id: 'host:lab' });
    expect(lab?.clients.map((c) => c.clientId)).toEqual(['c2', 'c3', 'c4']);
    // s2 has no hostname of its own and still lands on lab through its id.
    expect(lab?.liveSessions?.map((s) => s.sessionId)).toEqual(['s2']);
    expect(belongsToMachine({ machineId: 'm2' }, 'host:lab', twoIds)).toBe(true);
    expect(belongsToMachine({ clientId: 'gone' }, 'host:lab', twoIds)).toBe(false);
  });

  it('names the scope', () => {
    expect(scopeLabel(ALL_SCOPE, snapshot)).toBe('Whole fleet');
    expect(scopeLabel({ kind: 'machine', id: 'host:lab' }, snapshot)).toBe('lab');
    expect(scopeLabel({ kind: 'project', id: 'alpha' }, snapshot)).toBe('Alpha');
  });
});
