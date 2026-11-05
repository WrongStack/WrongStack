import { describe, expect, it } from 'vitest';
import type { Session } from '../src/model';
import { nextSessionAfterDetach, restoreSessionTabs, sidebarSessions } from '../src/session-layout';

const sessions = ['alpha', 'beta', 'gamma'].map((id) => ({ id }) as Session);
describe('native session tabs', () => {
  it('restores valid tabs in order and migrates a selected session from the initial layout format', () => {
    expect(restoreSessionTabs({ selected: 'beta' }, sessions)).toEqual(['beta']);
    expect(
      restoreSessionTabs(
        { openSessionIds: ['gamma', 'missing', 'alpha', 'gamma', 7], selected: 'beta' },
        sessions,
      ),
    ).toEqual(['gamma', 'alpha', 'beta']);
  });
  it('drops stale selection and handles absent or malformed persisted tabs', () => {
    expect(restoreSessionTabs({ selected: 'missing', openSessionIds: 'bad' }, sessions)).toEqual(
      [],
    );
    expect(restoreSessionTabs({}, [])).toEqual([]);
  });
  it('selects the adjacent tab when detaching the foreground session and leaves background selection alone', () => {
    expect(nextSessionAfterDetach(['alpha', 'beta', 'gamma'], 'beta', 'beta')).toBe('gamma');
    expect(nextSessionAfterDetach(['alpha', 'beta'], 'beta', 'beta')).toBe('alpha');
    expect(nextSessionAfterDetach(['alpha'], 'alpha', 'alpha')).toBeNull();
    expect(nextSessionAfterDetach(['alpha', 'beta'], 'beta', 'alpha')).toBe('beta');
  });
  it('lists running and open sessions, then the five most recent stopped ones, per project', () => {
    const row = (id: string, status: Session['status'], updatedAt: number, projectId = 'p1') =>
      ({ id, projectId, status, updatedAt, kind: 'agent' }) as Session;
    const all = [
      row('live', 'running', 1),
      row('open-stopped', 'stopped', 2),
      ...[10, 20, 30, 40, 50, 60].map((at) => row(`old-${at}`, 'stopped', at)),
      row('paused', 'interrupted', 55),
      row('other-project', 'running', 99, 'p2'),
    ];
    expect(sidebarSessions(all, 'p1', ['open-stopped']).map((s) => s.id)).toEqual([
      'live',
      'open-stopped',
      'old-60',
      'paused',
      'old-50',
      'old-40',
      'old-30',
    ]);
    expect(sidebarSessions(all, 'p2', []).map((s) => s.id)).toEqual(['other-project']);
  });
});
