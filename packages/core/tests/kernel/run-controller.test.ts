import { describe, expect, it } from 'vitest';
import { RunController } from '../../src/kernel/run-controller.js';

describe('RunController', () => {
  it('signal aborts when abort() is called', () => {
    const c = new RunController();
    expect(c.aborted).toBe(false);
    c.abort('test');
    expect(c.aborted).toBe(true);
    expect(c.signal.aborted).toBe(true);
  });

  it('fires hooks in LIFO order on abort', async () => {
    const c = new RunController();
    const order: number[] = [];
    c.onAbort(() => void order.push(1));
    c.onAbort(() => void order.push(2));
    c.onAbort(() => void order.push(3));
    c.abort();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([3, 2, 1]);
  });

  it('fires hooks on dispose() when run ends normally', async () => {
    const c = new RunController();
    const fired: string[] = [];
    c.onAbort(() => void fired.push('a'));
    c.onAbort(() => void fired.push('b'));
    await c.dispose();
    expect(fired).toEqual(['b', 'a']);
    expect(c.aborted).toBe(false);
  });

  it('hooks fire exactly once across abort + dispose', async () => {
    const c = new RunController();
    let count = 0;
    c.onAbort(() => {
      count++;
    });
    c.abort();
    await new Promise((r) => setImmediate(r));
    await c.dispose();
    expect(count).toBe(1);
  });

  it('fires a hook registered after dispose() immediately, exactly once', async () => {
    // Regression guard: a hook registered after the controller has drained
    // (post-dispose/abort) must not be silently dropped — it fires immediately
    // on a best-effort basis so the resource it cleans up isn't leaked.
    const c = new RunController();
    await c.dispose();
    let count = 0;
    const off = c.onAbort(() => {
      count++;
    });
    // Immediate run is scheduled as a microtask; let it settle.
    await new Promise((r) => setImmediate(r));
    expect(count).toBe(1);
    // The returned unsubscribe is a no-op (hook already ran) and must not
    // re-fire or throw.
    off();
    // A subsequent abort() must not run the hook a second time.
    c.abort();
    await new Promise((r) => setImmediate(r));
    expect(count).toBe(1);
  });

  it('routes a throwing post-drain hook through errorSink instead of throwing', async () => {
    // A hook registered after the controller has drained fires immediately;
    // if it throws, the error must be routed through errorSink (best-effort),
    // not surface as an unhandled rejection.
    const errs: Array<{ msg: string; where: string }> = [];
    const c = new RunController({
      errorSink: (err, where) =>
        errs.push({ msg: err instanceof Error ? err.message : String(err), where }),
    });
    await c.dispose();
    c.onAbort(() => {
      throw new Error('post-drain boom');
    });
    await new Promise((r) => setImmediate(r));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.msg).toBe('post-drain boom');
    expect(errs[0]?.where).toBe('RunController.onAbort(post-drain)');
  });

  it('unsubscribe stops a hook from firing', async () => {
    const c = new RunController();
    let fired = false;
    const off = c.onAbort(() => {
      fired = true;
    });
    off();
    c.abort();
    await new Promise((r) => setImmediate(r));
    expect(fired).toBe(false);
  });

  it('propagates abort from a parent signal', () => {
    const parent = new AbortController();
    const c = new RunController({ parentSignal: parent.signal });
    expect(c.aborted).toBe(false);
    parent.abort('upstream');
    expect(c.aborted).toBe(true);
  });

  it('inherits an already-aborted parent signal', () => {
    const parent = new AbortController();
    parent.abort('pre');
    const c = new RunController({ parentSignal: parent.signal });
    expect(c.aborted).toBe(true);
  });

  it('routes hook errors through errorSink instead of throwing', async () => {
    const errs: string[] = [];
    const c = new RunController({
      errorSink: (err) => errs.push(err instanceof Error ? err.message : String(err)),
    });
    c.onAbort(() => {
      throw new Error('boom');
    });
    c.onAbort(() => undefined);
    c.abort();
    await new Promise((r) => setImmediate(r));
    expect(errs).toEqual(['boom']);
  });

  it('awaits async hooks before dispose resolves', async () => {
    const c = new RunController();
    let done = false;
    c.onAbort(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await c.dispose();
    expect(done).toBe(true);
  });

  it('fires hooks when constructed with an already-aborted parent signal', async () => {
    // Regression guard: previously, constructing a RunController with a
    // parent signal that was already aborted would propagate the abort to
    // the child signal but never run the child's cleanup hooks — because
    // the abort listener was attached AFTER the child signal was already
    // aborted, and the WHATWG spec does not deliver abort events to late
    // listeners on already-aborted signals.
    const parent = new AbortController();
    parent.abort('pre');
    const fired: string[] = [];
    const c = new RunController({ parentSignal: parent.signal });
    c.onAbort(() => void fired.push('a'));
    c.onAbort(() => void fired.push('b'));
    // Drain the microtask scheduled by the constructor's void this.runHooks().
    await new Promise((r) => setImmediate(r));
    expect(c.aborted).toBe(true);
    expect(fired).toEqual(['b', 'a']);
  });

  it('hooks registered after parent-already-aborted construction still fire', async () => {
    // Even with the synchronous runHooks() in the constructor, a hook
    // registered synchronously after construction (before the microtask
    // drains) must still run — the void schedules a microtask that
    // snapshots the hooks array at execution time.
    const parent = new AbortController();
    parent.abort('pre');
    const fired: string[] = [];
    const c = new RunController({ parentSignal: parent.signal });
    c.onAbort(() => void fired.push('late'));
    await new Promise((r) => setImmediate(r));
    expect(fired).toEqual(['late']);
  });

  it('runs hooks in parallel: a slow hook does not delay a fast one', async () => {
    // Regression guard: hooks are independent and "one bad hook can't block
    // the others" — a slow async hook must not delay fast synchronous hooks
    // from completing. Parallel execution means total wall-clock is bounded
    // by the slowest hook rather than the sum of all hook durations.
    let slowCount = 0;
    let fast1Count = 0;
    let fast2Count = 0;
    const c = new RunController();
    c.onAbort(async () => {
      slowCount++;
      await new Promise((r) => setTimeout(r, 50));
    });
    c.onAbort(() => {
      fast1Count++;
    });
    c.onAbort(() => {
      fast2Count++;
    });
    const t0 = Date.now();
    await c.dispose();
    const elapsed = Date.now() - t0;
    expect(slowCount).toBe(1);
    expect(fast1Count).toBe(1);
    expect(fast2Count).toBe(1);
    // Parallel: fast hooks finish around the same time as the slow one
    // (~50ms), not stacked (~150ms). Allow generous slack for CI.
    expect(elapsed).toBeLessThan(120);
  });

  it('one throwing hook does not block the others (parallel + error isolation)', async () => {
    // The contract says "one bad hook can't block the others". Verify that
    // a throwing hook, a slow hook, and a fast hook all execute when the
    // controller drains — the throwing one routes through errorSink, the
    // others complete normally.
    const errs: string[] = [];
    const c = new RunController({
      errorSink: (err) => errs.push(err instanceof Error ? err.message : String(err)),
    });
    let fast1Count = 0;
    let fast2Count = 0;
    c.onAbort(() => {
      throw new Error('boom');
    });
    c.onAbort(() => {
      fast1Count++;
    });
    c.onAbort(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    c.onAbort(() => {
      fast2Count++;
    });
    await c.dispose();
    expect(errs).toEqual(['boom']);
    expect(fast1Count).toBe(1);
    expect(fast2Count).toBe(1);
  });

  it('awaits in-flight hooks across concurrent and repeated dispose calls', async () => {
    let hookFinished = false;
    const c = new RunController();
    c.onAbort(async () => {
      await new Promise((r) => setTimeout(r, 40));
      hookFinished = true;
    });

    const p1 = c.dispose();
    const p2 = c.dispose();
    await p2;
    await p1;

    expect(hookFinished).toBe(true);

    // Sequential dispose calls after drain remain idempotent and resolved
    await c.dispose();
    expect(hookFinished).toBe(true);
  });

  it('retains _hooksPromise and awaits async hooks on pre-aborted parentSignal dispose', async () => {
    const parent = new AbortController();
    parent.abort('pre');
    const c = new RunController({ parentSignal: parent.signal });
    let hookFinished = false;
    c.onAbort(async () => {
      await new Promise((r) => setTimeout(r, 40));
      hookFinished = true;
    });

    await new Promise((r) => queueMicrotask(r));
    await c.dispose();
    expect(hookFinished).toBe(true);
  });
});

