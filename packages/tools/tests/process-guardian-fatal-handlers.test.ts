import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy on process.exit so the test process doesn't actually die, and so we can
// assert the guardian asked for a fatal exit on uncaught / unhandled / sigterm.
const exitSpy = vi.hoisted(() => vi.fn());
vi.spyOn(process, 'exit').mockImplementation(exitSpy as never);

// Collect JSON-log output from the guardian so SIGTERM tests can assert the
// correct log events without relying on exit (which we mock to no-op).
type LogEvent = { event: string; sigtermCount?: number; threshold?: number };
const logLines: LogEvent[] = [];
const logSpy = vi.hoisted(() => vi.fn((...args: unknown[]) => {
  try { logLines.push(JSON.parse(String(args[0]))); } catch { /* ignore */ }
}));
vi.spyOn(console, 'log').mockImplementation(logSpy as never);

// Mock the persistent registry so start() doesn't touch the filesystem or the
// process-registry-persistent module's heartbeat timers.
vi.mock('../src/process-registry-persistent.js', () => ({
  getPersistentProcessRegistry: () => ({
    getInstanceId: () => 'test-instance',
    registerChildProcess: vi.fn(),
    unregister: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  }),
}));

const { ProcessGuardian } = await import('../src/process-guardian.js');

describe('ProcessGuardian fatal handlers', () => {
  afterEach(() => {
    exitSpy.mockClear();
    logLines.length = 0;
    // Defensive: if a test added a real handler, peel it back off so we don't
    // leak across the rest of the suite.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGHUP');
  });

  it('exits with code 1 when uncaughtException fires', () => {
    const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000 });
    g.start();

    const err = new Error('boom');
    process.emit('uncaughtException', err);

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    g.stop();
  });

  it('exits with code 1 when unhandledRejection fires with an Error reason', () => {
    const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000 });
    g.start();

    process.emit('unhandledRejection', new Error('rejected'));

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    g.stop();
  });

  it('exits with code 1 when unhandledRejection fires with a non-Error reason', () => {
    const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000 });
    g.start();

    process.emit('unhandledRejection', 'string-reason');

    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    g.stop();
  });

  describe('SIGTERM count-based guardrail', () => {
    afterEach(() => {
      // SIGTERM/SIGHUP listeners are cleaned up by the parent afterEach,
      // so only the test-local setup is needed here.
    });

    it('ignores SIGTERMs below the threshold (default 3)', () => {
      const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000 });
      g.start();

      process.emit('SIGTERM');
      process.emit('SIGTERM');

      // First two SIGTERMs are below threshold — no exit
      expect(exitSpy).toHaveBeenCalledTimes(0);
      const deferred = logLines.filter((l) => l.event === 'process_guardian.sigterm_deferred');
      expect(deferred).toHaveLength(2);
      expect(deferred[0].sigtermCount).toBe(1);
      expect(deferred[1].sigtermCount).toBe(2);

      g.stop();
    });

    it('exits on the Nth SIGTERM (default threshold=3)', () => {
      const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000 });
      g.start();

      process.emit('SIGTERM'); // 1 — deferred
      process.emit('SIGTERM'); // 2 — deferred
      expect(exitSpy).toHaveBeenCalledTimes(0); // still below threshold

      process.emit('SIGTERM'); // 3 — threshold hit
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0); // graceful exit code

      const exiting = logLines.filter((l) => l.event === 'process_guardian.sigterm_exiting');
      expect(exiting).toHaveLength(1);
      expect(exiting[0].threshold).toBe(3);

      g.stop();
    });

    it('exits immediately when sigtermThreshold is 0', () => {
      const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000, sigtermThreshold: 0 });
      g.start();

      process.emit('SIGTERM');

      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);

      g.stop();
    });

    it('never exits when sigtermThreshold is Infinity', () => {
      const g = new ProcessGuardian({ heartbeatIntervalMs: 60_000, sigtermThreshold: Infinity });
      g.start();

      // Send 10 SIGTERMs — none should trigger exit
      for (let i = 0; i < 10; i++) process.emit('SIGTERM');

      expect(exitSpy).toHaveBeenCalledTimes(0);
      const ignored = logLines.filter((l) => l.event === 'process_guardian.sigterm_ignored');
      expect(ignored).toHaveLength(10);

      g.stop();
    });
  });
});