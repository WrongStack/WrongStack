import { describe, expect, it, vi } from 'vitest';
import {
  CollaborationBus,
  collabInjectMiddleware,
  collabPauseMiddleware,
} from '../../src/index.js';
import type { ToolCallPipelinePayload } from '../../src/core/agent-types.js';
import { Pipeline } from '../../src/kernel/index.js';

describe('CollaborationBus', () => {
  it('starts in the running state', () => {
    const bus = new CollaborationBus();
    expect(bus.isPaused()).toBe(false);
    expect(bus.getState().paused).toBe(false);
    expect(bus.getState().pausedAt).toBeNull();
    expect(bus.getState().pausedBy).toBeNull();
  });

  it('requestPause flips to paused and stamps the actor + time', () => {
    const bus = new CollaborationBus();
    expect(bus.requestPause('p1')).toBe(true);
    expect(bus.isPaused()).toBe(true);
    const s = bus.getState();
    expect(s.paused).toBe(true);
    expect(s.pausedBy).toBe('p1');
    expect(typeof s.pausedAt).toBe('string');
  });

  it('requestPause is idempotent — second call is a no-op', () => {
    const bus = new CollaborationBus();
    expect(bus.requestPause('p1')).toBe(true);
    expect(bus.requestPause('p2')).toBe(false); // already paused
    expect(bus.getState().pausedBy).toBe('p1'); // original winner
  });

  it('resume returns false when not paused, true when it transitions', () => {
    const bus = new CollaborationBus();
    expect(bus.resume()).toBe(false);
    bus.requestPause('p1');
    expect(bus.resume()).toBe(true);
    expect(bus.isPaused()).toBe(false);
    expect(bus.getState().pausedAt).toBeNull();
    expect(bus.getState().pausedBy).toBeNull();
  });

  it('waitForResume returns true immediately when not paused', async () => {
    const bus = new CollaborationBus();
    await expect(bus.waitForResume(10)).resolves.toBe(true);
  });

  it('waitForResume blocks until resume(), then returns true', async () => {
    const bus = new CollaborationBus();
    bus.requestPause('p1');
    let resolved = false;
    const p = bus.waitForResume(5_000).then((r) => {
      resolved = true;
      return r;
    });
    // Should not have resolved yet.
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    bus.resume();
    await expect(p).resolves.toBe(true);
  });

  it('waitForResume times out and auto-resumes; returns false', async () => {
    const bus = new CollaborationBus();
    bus.requestPause('p1');
    const start = Date.now();
    const ok = await bus.waitForResume(30);
    const elapsed = Date.now() - start;
    expect(ok).toBe(false);
    expect(bus.isPaused()).toBe(false); // auto-resumed
    // We shouldn't have waited unboundedly — the real checks are ok=false +
    // auto-resume above. Generous bound for late timers under suite load.
    expect(elapsed).toBeLessThan(2000);
  });

  it('waitForResume with timeout=0 awaits unbounded until resume()', async () => {
    const bus = new CollaborationBus();
    bus.requestPause('p1');
    let resolved = false;
    const p = bus.waitForResume(0).then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    bus.resume();
    await expect(p).resolves.toBe(true);
  });

  it('multiple waiters all resolve on a single resume()', async () => {
    const bus = new CollaborationBus();
    bus.requestPause('p1');
    const a = bus.waitForResume(1_000);
    const b = bus.waitForResume(1_000);
    const c = bus.waitForResume(1_000);
    bus.resume();
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
  });
});

describe('collabPauseMiddleware', () => {
  const noopLogger = { debug() {}, warn() {} };

  function makePayload(name: string): ToolCallPipelinePayload {
    return {
      toolUse: { type: 'tool_use' as const, id: 'tu-1', name, input: {} },
      result: { type: 'tool_result' as const, tool_use_id: 'tu-1', content: 'ok' },
      ctx: {} as never,
    };
  }

  it('passes through when the bus is not paused', async () => {
    const bus = new CollaborationBus();
    const mw = collabPauseMiddleware(bus, { logger: noopLogger });
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    await mw.handler(makePayload('read'), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs inside the named Pipeline middleware contract', async () => {
    const bus = new CollaborationBus();
    const pipeline = new Pipeline<ToolCallPipelinePayload>();
    pipeline.prepend(collabPauseMiddleware(bus, { logger: noopLogger }));
    const payload = makePayload('read');
    await expect(pipeline.run(payload)).resolves.toBe(payload);
  });

  it('blocks the pipeline while paused and resumes via the bus', async () => {
    const bus = new CollaborationBus();
    const mw = collabPauseMiddleware(bus, { logger: noopLogger });
    bus.requestPause('controller-1');
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    const p = mw.handler(makePayload('bash'), next);
    // next() must not have been called yet.
    await new Promise((r) => setImmediate(r));
    expect(next).not.toHaveBeenCalled();
    bus.resume();
    await p;
    expect(next).toHaveBeenCalledOnce();
  });

  it('auto-resumes on timeout and logs a warning', async () => {
    const bus = new CollaborationBus();
    const warn = vi.fn();
    const mw = collabPauseMiddleware(bus, { logger: { warn, debug() {} }, defaultTimeoutMs: 15 });
    bus.requestPause('controller-1');
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    await mw.handler(makePayload('bash'), next);
    expect(bus.isPaused()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/auto-resuming/);
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not call next() until the bus is resumed (even if next is fast)', async () => {
    const bus = new CollaborationBus();
    const mw = collabPauseMiddleware(bus, { logger: noopLogger });
    bus.requestPause('controller-1');
    const order: string[] = [];
    const next = vi.fn().mockImplementation(async (payload: ToolCallPipelinePayload) => {
      order.push('next');
      return payload;
    });
    const p = mw.handler(makePayload('bash'), next).then(() => order.push('mw-done'));
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([]); // nothing yet
    bus.resume();
    await p;
    expect(order).toEqual(['next', 'mw-done']);
  });
});

// ── CollaborationBus injection queue (Phase 4) ─────────────────────────────────

describe('CollaborationBus.injectToolResult', () => {
  it('starts with an empty queue', () => {
    const bus = new CollaborationBus();
    expect(bus.pendingInjectionCount()).toBe(0);
    expect(bus.takeInjection('any')).toBeNull();
  });

  it('queues an injection and pops it on take', () => {
    const bus = new CollaborationBus();
    const ok = bus.injectToolResult({
      toolUseId: 'tu-1',
      content: 'injected',
      isError: false,
      reason: 'controller override',
      authorId: 'p1',
    });
    expect(ok).toBe(true);
    expect(bus.pendingInjectionCount()).toBe(1);
    const popped = bus.takeInjection('tu-1');
    expect(popped).not.toBeNull();
    expect(popped!.content).toBe('injected');
    expect(popped!.reason).toBe('controller override');
    expect(bus.pendingInjectionCount()).toBe(0);
    // Second take returns null — the injection is one-shot.
    expect(bus.takeInjection('tu-1')).toBeNull();
  });

  it('is idempotent: a second queue for the same id is rejected', () => {
    const bus = new CollaborationBus();
    expect(
      bus.injectToolResult({
        toolUseId: 'tu-1',
        content: 'first',
        isError: false,
        reason: 'r1',
        authorId: 'p1',
      }),
    ).toBe(true);
    expect(
      bus.injectToolResult({
        toolUseId: 'tu-1',
        content: 'second',
        isError: false,
        reason: 'r2',
        authorId: 'p1',
      }),
    ).toBe(false);
    // First write wins — taking still returns the first.
    const popped = bus.takeInjection('tu-1');
    expect(popped!.content).toBe('first');
  });

  it('keeps multiple injections for different toolUseIds independent', () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'a',
      content: 1,
      isError: false,
      reason: 'r',
      authorId: 'p',
    });
    bus.injectToolResult({
      toolUseId: 'b',
      content: 2,
      isError: false,
      reason: 'r',
      authorId: 'p',
    });
    bus.injectToolResult({
      toolUseId: 'c',
      content: 3,
      isError: false,
      reason: 'r',
      authorId: 'p',
    });
    expect(bus.pendingInjectionCount()).toBe(3);
    expect(bus.takeInjection('b')!.content).toBe(2);
    expect(bus.pendingInjectionCount()).toBe(2);
  });

  it('bounds the queue when unconsumed injections pile up (leak guard)', () => {
    const bus = new CollaborationBus();
    for (let i = 0; i < 64; i++) {
      bus.injectToolResult({
        toolUseId: `tu-${i}`,
        content: i,
        isError: false,
        reason: 'stress',
        authorId: 'p',
      });
    }
    // Cap is 32 — oldest FIFO-evicted, newest retained.
    expect(bus.pendingInjectionCount()).toBe(32);
    expect(bus.takeInjection('tu-0')).toBeNull();
    expect(bus.takeInjection('tu-63')!.content).toBe(63);
  });

  it('expires stale unconsumed injections by TTL', () => {
    vi.useFakeTimers();
    try {
      const bus = new CollaborationBus();
      bus.injectToolResult({
        toolUseId: 'stale',
        content: 'old',
        isError: false,
        reason: 'r',
        authorId: 'p',
      });
      expect(bus.pendingInjectionCount()).toBe(1);
      // Advance past INJECTION_TTL_MS (10 minutes).
      vi.advanceTimersByTime(11 * 60_000);
      expect(bus.pendingInjectionCount()).toBe(0);
      expect(bus.takeInjection('stale')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── collabInjectMiddleware (Phase 4) ─────────────────────────────────────────

describe('collabInjectMiddleware', () => {
  const noopLogger = { debug() {}, warn() {} };

  function makePayload(id: string, name: string): ToolCallPipelinePayload {
    return {
      toolUse: { type: 'tool_use' as const, id, name, input: {} },
      result: { type: 'tool_result' as const, tool_use_id: id, content: 'real' },
      ctx: {} as never,
    };
  }

  it('passes through when no injection is queued for the toolUse.id', async () => {
    const bus = new CollaborationBus();
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    const payload = makePayload('tu-1', 'read');
    await mw.handler(payload, next);
    expect(next).toHaveBeenCalledOnce();
    // Real result preserved.
    expect(payload.result.content).toBe('real');
  });

  it('runs pause and inject inside the named Pipeline middleware contract', async () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'tu-pipe',
      content: 'pipeline synthetic',
      isError: false,
      reason: 'pipeline regression',
      authorId: 'p1',
    });
    const pipeline = new Pipeline<ToolCallPipelinePayload>();
    pipeline.prepend(collabInjectMiddleware(bus, { logger: noopLogger }));
    pipeline.prepend(collabPauseMiddleware(bus, { logger: noopLogger }));
    const payload = makePayload('tu-pipe', 'bash');
    const out = await pipeline.run(payload);
    expect(out).toBe(payload);
    expect(payload.result.content).toBe('pipeline synthetic');
  });

  it('splices the injected result and does NOT call next() when matched', async () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'tu-2',
      content: 'synthetic content',
      isError: false,
      reason: 'controller: skip the bash call',
      authorId: 'p1',
    });
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    const payload = makePayload('tu-2', 'bash');
    await mw.handler(payload, next);
    expect(next).not.toHaveBeenCalled();
    expect(payload.result.content).toBe('synthetic content');
    expect(payload.result.is_error).toBe(false);
    // The queue is drained after consumption.
    expect(bus.pendingInjectionCount()).toBe(0);
  });

  it('marks the spliced result as error when isError is true', async () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'tu-3',
      content: 'simulated failure',
      isError: true,
      reason: 'controller: simulate a tool error',
      authorId: 'p1',
    });
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    const payload = makePayload('tu-3', 'read');
    await mw.handler(payload, next);
    expect(payload.result.is_error).toBe(true);
    expect(payload.result.content).toBe('simulated failure');
  });

  it('JSON-serializes object content into a string', async () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'tu-4',
      content: { foo: 'bar', n: 42 },
      isError: false,
      reason: 'r',
      authorId: 'p',
    });
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    const next = vi.fn(async (payload: ToolCallPipelinePayload) => payload);
    const payload = makePayload('tu-4', 'read');
    await mw.handler(payload, next);
    expect(payload.result.content).toBe(JSON.stringify({ foo: 'bar', n: 42 }));
  });

  it('notifies onInjectionConsumed with the resolved tool name when matched', async () => {
    const bus = new CollaborationBus();
    bus.injectToolResult({
      toolUseId: 'tu-9',
      content: 'synthetic',
      isError: true,
      reason: 'controller override',
      authorId: 'p-author',
    });
    const consumed: Array<Record<string, unknown>> = [];
    bus.onInjectionConsumed((info) => consumed.push(info));
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    await mw.handler(
      makePayload('tu-9', 'bash'),
      vi.fn(async (payload: ToolCallPipelinePayload) => payload),
    );
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      toolUseId: 'tu-9',
      toolName: 'bash',
      authorId: 'p-author',
      reason: 'controller override',
      isError: true,
    });
  });

  it('does not notify onInjectionConsumed when no injection was queued', async () => {
    const bus = new CollaborationBus();
    const consumed: unknown[] = [];
    bus.onInjectionConsumed((info) => consumed.push(info));
    const mw = collabInjectMiddleware(bus, { logger: noopLogger });
    await mw.handler(
      makePayload('tu-x', 'read'),
      vi.fn(async (payload: ToolCallPipelinePayload) => payload),
    );
    expect(consumed).toHaveLength(0);
  });
});
