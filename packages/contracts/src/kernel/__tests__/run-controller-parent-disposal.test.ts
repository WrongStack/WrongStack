import { describe, expect, it } from 'vitest';
import { RunController } from '../run-controller.js';

const settle = () => new Promise<void>((r) => setImmediate(r));

describe('RunController parent abort during the disposal window (F1)', () => {
  it('keeps a normally-ended run un-aborted when the parent aborts before the detach hook runs', async () => {
    // dispose() ends the run synchronously, but the parent-listener detach
    // is a cleanup hook that only starts on a microtask. A parent abort in
    // that synchronous window must not flip the ended run to aborted.
    const parent = new AbortController();
    const run = new RunController({ parentSignal: parent.signal });
    let cleanup = 0;
    let abortEvents = 0;
    run.onAbort(() => {
      cleanup++;
    });
    run.signal.addEventListener('abort', () => {
      abortEvents++;
    });

    const disposed = run.dispose();
    parent.abort('late-parent');
    await disposed;
    await settle();

    expect(run.aborted).toBe(false);
    expect(abortEvents).toBe(0);
    expect(cleanup).toBe(1);
  });

  it('ignores a parent abort while gated async cleanup is in flight', async () => {
    // Gated completion order: the cleanup hook is parked on an explicit
    // gate, the parent aborts mid-cleanup, then the gate releases. The
    // stale abort must not flip the run; dispose awaits the hook.
    const parent = new AbortController();
    const run = new RunController({ parentSignal: parent.signal });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let hookFinished = false;
    let abortEvents = 0;
    run.onAbort(async () => {
      await gate;
      hookFinished = true;
    });
    run.signal.addEventListener('abort', () => {
      abortEvents++;
    });

    const disposed = run.dispose();
    await settle();
    parent.abort('mid-cleanup');
    release();
    await disposed;

    expect(hookFinished).toBe(true);
    expect(run.aborted).toBe(false);
    expect(abortEvents).toBe(0);
  });

  it('stays un-aborted across repeated dispose and repeated late parent aborts', async () => {
    const parent = new AbortController();
    const run = new RunController({ parentSignal: parent.signal });
    let cleanup = 0;
    run.onAbort(() => {
      cleanup++;
    });
    await run.dispose();
    parent.abort('late-1');
    parent.abort('late-2');
    await run.dispose();
    run.abort('late-direct');
    await settle();
    expect(run.aborted).toBe(false);
    expect(cleanup).toBe(1);
  });

  it('still propagates a parent abort that lands while the run is live', async () => {
    const parent = new AbortController();
    const run = new RunController({ parentSignal: parent.signal });
    let cleanup = 0;
    run.onAbort(() => {
      cleanup++;
    });
    parent.abort('live-run');
    expect(run.aborted).toBe(true);
    expect(run.signal.reason).toBe('live-run');
    await run.dispose();
    await settle();
    expect(cleanup).toBe(1);
  });
});
