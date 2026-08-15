import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

type Tracked = {
  pid: number;
  name: string;
  command: string;
  startedAt: number;
  sessionId?: string;
  child: ChildProcess;
  processGroupLeader?: boolean;
  background?: boolean;
};

const fakeChild = (): ChildProcess => {
  const c = {
    killed: false,
    kill: vi.fn(() => {
      c.killed = true;
      return true;
    }),
  };
  return c as never as ChildProcess;
};

/** A child that has exited but whose 'close' event never fired (orphan case). */
const staleChild = (): ChildProcess =>
  ({ killed: false, kill: vi.fn(() => true), exitCode: 0 }) as never as ChildProcess;

const makeProc = (overrides: Partial<Tracked> = {}): Tracked => ({
  pid: overrides.pid ?? 1000 + Math.floor(Math.random() * 9000),
  name: overrides.name ?? 'bash',
  command: overrides.command ?? 'echo hi',
  startedAt: overrides.startedAt ?? Date.now(),
  child: overrides.child ?? fakeChild(),
  ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
  ...(overrides.background !== undefined ? { background: overrides.background } : {}),
});

describe('ProcessRegistry', () => {
  beforeEach(() => {
    _resetProcessRegistry();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    // The registry disables the breaker by default (users opt in via /settings).
    // These tests exercise breaker behavior, so enable it.
    getProcessRegistry().setBreakerConfig({ enabled: true });
  });
  afterEach(() => {
    _resetProcessRegistry();
    vi.restoreAllMocks();
  });

  it('returns the same singleton on repeat access', () => {
    const a = getProcessRegistry();
    const b = getProcessRegistry();
    expect(a).toBe(b);
  });

  it('_resetProcessRegistry creates a fresh instance', () => {
    const a = getProcessRegistry();
    _resetProcessRegistry();
    const b = getProcessRegistry();
    expect(a).not.toBe(b);
  });

  it('register/get/unregister round trip', () => {
    const r = getProcessRegistry();
    const p = makeProc({ pid: 123 });
    r.register(p);
    expect(r.get(123)?.pid).toBe(123);
    expect(r.get(123)?.killed).toBe(false);
    r.unregister(123);
    expect(r.get(123)).toBeUndefined();
  });

  it('list returns all tracked processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10001 }));
    r.register(makeProc({ pid: 10002 }));
    r.register(makeProc({ pid: 10003 }));
    expect(r.list()).toHaveLength(3);
    expect(
      r
        .list()
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10001, 10002, 10003]);
  });

  it('byName filters by tool name', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10011, name: 'bash' }));
    r.register(makeProc({ pid: 10012, name: 'exec' }));
    r.register(makeProc({ pid: 10013, name: 'bash' }));
    expect(r.byName('bash')).toHaveLength(2);
    expect(r.byName('exec')).toHaveLength(1);
    expect(r.byName('other')).toHaveLength(0);
  });

  it('bySession filters by sessionId', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10021, sessionId: 's1' }));
    r.register(makeProc({ pid: 10022, sessionId: 's2' }));
    r.register(makeProc({ pid: 10023, sessionId: 's1' }));
    expect(r.bySession('s1')).toHaveLength(2);
    expect(r.bySession('s2')).toHaveLength(1);
    expect(r.bySession('absent')).toHaveLength(0);
  });

  it('activeCount excludes killed processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10031 }));
    r.register(makeProc({ pid: 10032 }));
    expect(r.activeCount).toBe(2);
    r.kill(10031, { force: true });
    expect(r.activeCount).toBe(1);
  });

  it('stats returns combined counts and breaker snapshot', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10041 }));
    r.register(makeProc({ pid: 10042 }));
    const s = r.stats();
    expect(s.activeCount).toBe(2);
    expect(s.totalCount).toBe(2);
    expect(s.breaker).toBeDefined();
    expect(s.breaker.state).toBe('closed');
  });

  it('breaker pass-through: beforeCall is true when closed', () => {
    const r = getProcessRegistry();
    expect(r.beforeCall()).toBe(true);
    expect(r.canProceed).toBe(true);
  });

  it('forceBreakerOpen blocks further calls', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true });
    r.forceBreakerOpen();
    expect(r.canProceed).toBe(false);
    expect(r.beforeCall()).toBe(false);
    expect(r.stats().breaker.state).toBe('open');
  });

  it('forceBreakerReset clears the open state', () => {
    const r = getProcessRegistry();
    r.forceBreakerOpen();
    r.forceBreakerReset();
    expect(r.stats().breaker.state).toBe('closed');
    expect(r.canProceed).toBe(true);
  });

  it('afterCall feeds the breaker (consecutive failures trip)', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true });
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.canProceed).toBe(false);
  });

  it('kill returns false for unknown PID', () => {
    const r = getProcessRegistry();
    expect(r.kill(999)).toBe(false);
  });

  it('kill marks the process killed but keeps it in the registry until unregister', () => {
    const r = getProcessRegistry();
    const proc = makeProc({ pid: 42 });
    r.register(proc);
    expect(r.kill(42, { force: true })).toBe(true);
    expect(r.get(42)?.killed).toBe(true);
    // Process remains in the registry — caller (close handler) unregisters.
    expect(r.list()).toHaveLength(1);
  });

  it('repeat kill without force is a latched no-op', () => {
    const r = getProcessRegistry();
    const child = fakeChild();
    r.register(makeProc({ pid: 7, child }));
    expect(r.kill(7)).toBe(true);
    expect(r.kill(7)).toBe(true); // latched — no second SIGTERM
    expect((child.kill as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('repeat kill with force escalates to SIGKILL even when already killed', () => {
    const r = getProcessRegistry();
    const child = fakeChild();
    r.register(makeProc({ pid: 8, child }));
    r.kill(8); // SIGTERM (soft)
    // Regression: the unconditional `if (p.killed) return true` latch made
    // this second call a silent no-op, so a process that ignored SIGTERM
    // could never be escalated to SIGKILL via kill(pid, {force: true}).
    expect(r.kill(8, { force: true })).toBe(true);
    const signals = (child.kill as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(signals).toContain('SIGTERM');
    expect(signals).toContain('SIGKILL');
  });

  it('killAll skips protected processes unless includeProtected is set', () => {
    const r = getProcessRegistry();
    r.register({ ...makeProc({ pid: 9101 }), protected: false });
    r.register({ ...makeProc({ pid: 9102 }), protected: true });
    expect(r.killAll({ force: true })).toEqual([9101]);
    expect(r.get(9102)?.killed).toBe(false);
    // Second pass only reaps the protected entry (9101 already killed → still
    // reported as killAll target when includeProtected re-walks the map, so
    // assert the protected one is now killed rather than exact PID list).
    r.killAll({ force: true, includeProtected: true });
    expect(r.get(9102)?.killed).toBe(true);
  });

  it('killAll kills every tracked process and returns their PIDs', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10051 }));
    r.register(makeProc({ pid: 10052 }));
    r.register(makeProc({ pid: 10053 }));
    const killed = r.killAll({ force: true }).sort((a, b) => a - b);
    expect(killed).toEqual([10051, 10052, 10053]);
    expect(r.activeCount).toBe(0);
  });

  it('preserves detached background jobs during host shutdown cleanup', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10054 }));
    r.register(makeProc({ pid: 10055, background: true }));
    expect(r.activeBackgroundCount).toBe(1);
    expect(r.stats().backgroundCount).toBe(1);

    expect(r.killAll({ force: true, preserveBackground: true })).toEqual([10054]);
    expect(r.get(10054)?.killed).toBe(true);
    expect(r.get(10055)?.killed).toBe(false);

    // An explicit kill action still terminates the background job.
    expect(r.kill(10055, { force: true })).toBe(true);
  });

  it('killSession kills only matching session processes', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10061, sessionId: 's1' }));
    r.register(makeProc({ pid: 10062, sessionId: 's2' }));
    r.register(makeProc({ pid: 10063, sessionId: 's1' }));
    const killed = r.killSession('s1', { force: true }).sort((a, b) => a - b);
    expect(killed).toEqual([10061, 10063]);
    expect(r.get(10062)?.killed).toBe(false);
  });

  it('killSession returns an empty array when no processes match', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 10071, sessionId: 's1' }));
    expect(r.killSession('does-not-exist', { force: true })).toEqual([]);
  });

  it('never process-group kills untrusted fake PIDs', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const r = getProcessRegistry();
    const child = fakeChild();
    r.register(makeProc({ pid: 1, child }));
    expect(r.kill(1, { force: true })).toBe(true);
    expect(killSpy).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('tolerates persistent-registry entries with child: null (no TypeError)', () => {
    // process-registry-persistent.ts mirrors cross-instance entries into the
    // in-memory registry with `child: null` (no live handle exists in this
    // process). _isStaleEntry used to dereference `entry.child.exitCode` and
    // every get()/list()/stats()/kill() touching such an entry threw.
    const r = getProcessRegistry();
    r.register({
      pid: 42421,
      name: 'wrongstack-main',
      command: 'node wstack',
      // Old enough that the stale-check actually runs its logic (not the
      // 60s fast-path). process.kill is mocked → POSIX liveness probe says
      // "alive"; win32 keeps null-child entries unconditionally.
      startedAt: Date.now() - 120_000,
      child: null,
      protected: true,
    });
    expect(() => r.list()).not.toThrow();
    expect(() => r.stats()).not.toThrow();
    expect(r.get(42421)?.pid).toBe(42421);
    // Protected entries still refuse kill — without throwing.
    expect(r.kill(42421)).toBe(false);

    // Kill path on a null-child entry must not throw either. PID 1 is used
    // so no real process can be targeted: _isSafeSignalPid rejects it on
    // POSIX and no Windows user process has PID 1 (taskkill fails cleanly).
    r.register({
      pid: 1,
      name: 'wrongstack-main',
      command: 'node wstack',
      startedAt: Date.now(),
      child: null,
    });
    expect(() => r.kill(1, { force: true })).not.toThrow();
  });
});

describe('ProcessRegistry circuit-breaker config', () => {
  beforeEach(() => {
    _resetProcessRegistry();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetProcessRegistry();
    vi.restoreAllMocks();
  });

  it('defaults to disabled — calls proceed even after forceBreakerOpen', () => {
    const r = getProcessRegistry();
    r.forceBreakerOpen();
    // Breaker state is open, but protection is off so calls still proceed.
    expect(r.beforeCall()).toBe(true);
    expect(r.canProceed).toBe(true);
  });

  it('setBreakerConfig({ enabled: true }) gates calls after a trip', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true });
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.canProceed).toBe(false);
    expect(r.beforeCall()).toBe(false);
  });

  it('disabling cancels protection and re-enables a fresh circuit', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true });
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.canProceed).toBe(false);
    r.setBreakerConfig({ enabled: false });
    expect(r.canProceed).toBe(true);
    expect(r.stats().breaker.state).toBe('closed');
  });

  it('auto kill/reset countdown is null until the breaker trips', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true, autoKillResetMs: 30_000 });
    expect(r.getBreakerCountdown()).toBeNull();
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    // Tripped → countdown armed.
    const cd = r.getBreakerCountdown();
    expect(cd).not.toBeNull();
    expect(cd?.totalMs).toBe(30_000);
    expect(cd?.remainingMs).toBe(30_000);
  });

  it('fires killAll + reset when the countdown elapses', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true, autoKillResetMs: 10_000 });
    r.register(makeProc({ pid: 10081 }));
    r.register(makeProc({ pid: 10082 }));
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.canProceed).toBe(false);
    expect(r.getBreakerCountdown()).not.toBeNull();

    vi.advanceTimersByTime(10_000);

    // Forced recovery: processes killed, breaker closed, countdown cleared.
    expect(r.get(10081)?.killed).toBe(true);
    expect(r.get(10082)?.killed).toBe(true);
    expect(r.canProceed).toBe(true);
    expect(r.stats().breaker.state).toBe('closed');
    expect(r.getBreakerCountdown()).toBeNull();
  });

  it('manual reset cancels the armed countdown', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true, autoKillResetMs: 10_000 });
    r.register(makeProc({ pid: 10091 }));
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    expect(r.getBreakerCountdown()).not.toBeNull();

    r.forceBreakerReset();

    expect(r.getBreakerCountdown()).toBeNull();
    // Process not killed — reset is a recovery, not a kill.
    expect(r.get(10091)?.killed).toBe(false);
    // Countdown never fires after cancel.
    vi.advanceTimersByTime(10_000);
    expect(r.get(10091)?.killed).toBe(false);
  });

  it('breakertimeout=0 means manual recovery (no countdown armed)', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true, autoKillResetMs: 0 });
    r.register(makeProc({ pid: 10101 }));
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    // Breaker is open → canProceed false, no countdown armed.
    expect(r.canProceed).toBe(false);
    expect(r.getBreakerCountdown()).toBeNull();
    vi.advanceTimersByTime(60_000);
    // No auto kill/reset fired — process untouched, breaker unchanged.
    expect(r.get(10101)?.killed).toBe(false);
  });

  it('notifies subscribers on arm and cancel', () => {
    const r = getProcessRegistry();
    r.setBreakerConfig({ enabled: true, autoKillResetMs: 10_000 });
    const events: Array<{ remainingMs: number } | null> = [];
    const off = r.onBreakerCountdownChange((snap) => events.push(snap));
    for (let i = 0; i < 5; i++) r.afterCall(10, true);
    r.forceBreakerReset();
    off();

    // At least one armed snapshot then a null (cancel) snapshot.
    expect(events.some((e) => e !== null && e.remainingMs > 0)).toBe(true);
    expect(events.at(-1)).toBeNull();
  });

  it('list() prunes entries whose child exited but whose close never fired', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 30001, startedAt: Date.now() - 120_000, child: staleChild() }));
    r.register(makeProc({ pid: 30002 }));
    expect(r.list().map((p) => p.pid)).toEqual([30002]);
    expect(r.activeCount).toBe(1);
  });

  it('stats() prunes stale entries before counting', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 30011, startedAt: Date.now() - 120_000, child: staleChild() }));
    r.register(makeProc({ pid: 30012 }));
    const s = r.stats();
    expect(s.totalCount).toBe(1);
    expect(s.activeCount).toBe(1);
  });

  it('get() keeps pruning a single stale PID (existing behavior)', () => {
    const r = getProcessRegistry();
    r.register(makeProc({ pid: 30021, startedAt: Date.now() - 120_000, child: staleChild() }));
    expect(r.get(30021)).toBeUndefined();
  });
});
