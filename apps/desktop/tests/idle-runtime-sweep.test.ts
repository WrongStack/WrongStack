/**
 * Reclaiming project servers nobody is using.
 *
 * Every open project holds a `webui-server` child process (Electron's Node via
 * ELECTRON_RUN_AS_NODE). Ten open projects were ten Node processes, alive until
 * the app quit or the user closed each project by hand.
 *
 * The decision of what may be reclaimed is a pure function so it can be tested
 * exhaustively; the killing is not. The guard that matters most is the second
 * one: a background project running an agent writes to stdout continuously, and
 * reclaiming it mid-task would destroy work in progress. Being unwatched is not
 * the same as being idle, and these tests pin that distinction.
 */
import { describe, expect, it } from 'vitest';
import { reclaimableRuntimeIds, resolveIdleTimeoutMs } from '../src/main/runtime-manager.js';

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const MINUTES = 60_000;

function runtimes(
  entries: Array<{ id: string; status?: string; idleMinutes?: number }>,
): Map<string, { status: string; lastActivityAt: number }> {
  return new Map(
    entries.map((e) => [
      e.id,
      {
        status: e.status ?? 'running',
        lastActivityAt: NOW - (e.idleMinutes ?? 0) * MINUTES,
      },
    ]),
  );
}

const opts = (over: Partial<Parameters<typeof reclaimableRuntimeIds>[1]> = {}) => ({
  activeRuntimeId: null,
  idleTimeoutMs: 15 * MINUTES,
  now: NOW,
  ...over,
});

describe('reclaimableRuntimeIds', () => {
  it('reclaims a project untouched past the timeout', () => {
    const ids = reclaimableRuntimeIds(runtimes([{ id: 'rt-old', idleMinutes: 20 }]), opts());
    expect(ids).toEqual(['rt-old']);
  });

  it('leaves a project that is still inside the window', () => {
    const ids = reclaimableRuntimeIds(runtimes([{ id: 'rt-warm', idleMinutes: 14 }]), opts());
    expect(ids).toEqual([]);
  });

  it('never reclaims the active project, however long since it was touched', () => {
    const ids = reclaimableRuntimeIds(
      runtimes([{ id: 'rt-active', idleMinutes: 600 }]),
      opts({ activeRuntimeId: 'rt-active' }),
    );
    expect(ids).toEqual([]);
  });

  it('never reclaims a project whose agent is still producing output', () => {
    // The failure this prevents: an unwatched project running a long task gets
    // killed mid-work because nobody clicked on it. `lastActivityAt` is bumped
    // by child stdout/stderr, so a busy project is never idle.
    const ids = reclaimableRuntimeIds(
      runtimes([
        { id: 'rt-busy', idleMinutes: 0 },
        { id: 'rt-abandoned', idleMinutes: 45 },
      ]),
      opts(),
    );
    expect(ids).toEqual(['rt-abandoned']);
  });

  it('ignores a project that is not running', () => {
    // Starting: killing it mid-boot would strand a half-spawned child.
    // Stopped/error: there is nothing left to reclaim.
    const ids = reclaimableRuntimeIds(
      runtimes([
        { id: 'rt-starting', status: 'starting', idleMinutes: 60 },
        { id: 'rt-stopped', status: 'stopped', idleMinutes: 60 },
        { id: 'rt-error', status: 'error', idleMinutes: 60 },
      ]),
      opts(),
    );
    expect(ids).toEqual([]);
  });

  it('reclaims nothing when the timeout is disabled', () => {
    const ids = reclaimableRuntimeIds(
      runtimes([{ id: 'rt-ancient', idleMinutes: 10_000 }]),
      opts({ idleTimeoutMs: 0 }),
    );
    expect(ids).toEqual([]);
  });

  it('reclaims every idle project in one pass', () => {
    const ids = reclaimableRuntimeIds(
      runtimes([
        { id: 'rt-1', idleMinutes: 30 },
        { id: 'rt-2', idleMinutes: 0 },
        { id: 'rt-3', idleMinutes: 90 },
        { id: 'rt-4', idleMinutes: 16 },
      ]),
      opts({ activeRuntimeId: 'rt-2' }),
    );
    expect(ids.sort()).toEqual(['rt-1', 'rt-3', 'rt-4']);
  });
});

describe('resolveIdleTimeoutMs', () => {
  it('defaults to fifteen minutes', () => {
    expect(resolveIdleTimeoutMs({})).toBe(15 * MINUTES);
  });

  it('honours an explicit number of minutes', () => {
    expect(resolveIdleTimeoutMs({ WRONGSTACK_DESKTOP_IDLE_MINUTES: '45' })).toBe(45 * MINUTES);
  });

  it('treats zero as "keep every project running"', () => {
    expect(resolveIdleTimeoutMs({ WRONGSTACK_DESKTOP_IDLE_MINUTES: '0' })).toBe(0);
  });

  it('treats a negative value as disabled rather than as "reclaim immediately"', () => {
    // A misread sign must not turn the sweep into an instant killer.
    expect(resolveIdleTimeoutMs({ WRONGSTACK_DESKTOP_IDLE_MINUTES: '-5' })).toBe(0);
  });

  it('falls back to the default for anything unparseable', () => {
    expect(resolveIdleTimeoutMs({ WRONGSTACK_DESKTOP_IDLE_MINUTES: 'soon' })).toBe(15 * MINUTES);
    expect(resolveIdleTimeoutMs({ WRONGSTACK_DESKTOP_IDLE_MINUTES: '' })).toBe(15 * MINUTES);
  });
});
