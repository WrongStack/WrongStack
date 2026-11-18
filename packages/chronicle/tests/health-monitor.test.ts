import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChronicleContext } from '../src/context.js';
import { startChronicleHealthMonitor } from '../src/health-monitor.js';
import type { ChronicleEventSink } from '../src/sink.js';

function context(sessionId: string): ChronicleContext {
  return {
    scope: {
      installationId: 'installation',
      machineId: 'machine',
      sessionId,
    },
    correlation: { traceId: 'trace', spanId: 'span' },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startChronicleHealthMonitor', () => {
  it.each(['context', 'journal'] as const)(
    'reports a failing %s sample and continues on the next tick',
    async (source) => {
      vi.useFakeTimers();
      const error = new Error('sample source unavailable');
      const emit = vi.fn();
      const onPersistError = vi.fn();
      const resolveContext = vi.fn(() => context('recovered'));
      const stats = vi.fn(() => ({
        accepted: 0,
        persisted: 0,
        dropped: 0,
        quarantined: 0,
        buffered: 0,
      }));
      (source === 'journal' ? stats : resolveContext).mockImplementationOnce(() => {
        throw error;
      });
      const stop = startChronicleHealthMonitor({
        events: { emit } as unknown as EventBus,
        journal: { stats } as unknown as ChronicleEventSink,
        context: resolveContext,
        intervalMs: 5_000,
        onPersistError,
      });
      try {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(onPersistError).toHaveBeenCalledExactlyOnceWith(error);
        expect(emit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(emit).toHaveBeenCalledExactlyOnceWith(
          'runtime.health.sampled',
          expect.objectContaining({ sessionId: 'recovered' }),
        );
        expect(onPersistError).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    },
  );

  it('samples a dynamic context and emits bounded runtime health data', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stats = vi.fn(() => ({
      accepted: 3,
      persisted: 2,
      dropped: 1,
      quarantined: 0,
      buffered: 0,
    }));
    const resolveContext = vi.fn(() => context('session-dynamic'));

    const stop = startChronicleHealthMonitor({
      events: { emit } as unknown as EventBus,
      journal: { stats } as unknown as ChronicleEventSink,
      context: resolveContext,
      intervalMs: 5_001,
    });

    await vi.advanceTimersByTimeAsync(5_001);

    expect(resolveContext).toHaveBeenCalledOnce();
    expect(stats).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      'runtime.health.sampled',
      expect.objectContaining({
        sessionId: 'session-dynamic',
        uptimeSeconds: expect.any(Number),
        cpu: {
          userMicros: expect.any(Number),
          systemMicros: expect.any(Number),
        },
        memory: expect.objectContaining({
          rssBytes: expect.any(Number),
          heapUsedBytes: expect.any(Number),
        }),
        chronicle: expect.objectContaining({ accepted: 3, dropped: 1 }),
      }),
    );

    stop();
    await vi.advanceTimersByTimeAsync(10_002);
    expect(emit).toHaveBeenCalledOnce();
  });

  it('clamps short intervals and reports EventBus persistence failures', async () => {
    vi.useFakeTimers();
    const error = new Error('event bus unavailable');
    const onPersistError = vi.fn();
    const emit = vi.fn(() => {
      throw error;
    });

    const stop = startChronicleHealthMonitor({
      events: { emit } as unknown as EventBus,
      journal: {
        stats: () => ({
          accepted: 0,
          persisted: 0,
          dropped: 0,
          quarantined: 0,
          buffered: 0,
        }),
      } as unknown as ChronicleEventSink,
      context: context('session-static'),
      intervalMs: 1,
      onPersistError,
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(emit).toHaveBeenCalledOnce();
    expect(onPersistError).toHaveBeenCalledWith(error);
    stop();
  });

  it('uses the default sampling interval when none is configured', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = startChronicleHealthMonitor({
      events: { emit } as unknown as EventBus,
      journal: {
        stats: () => ({
          accepted: 0,
          persisted: 0,
          dropped: 0,
          quarantined: 0,
          buffered: 0,
        }),
      } as unknown as ChronicleEventSink,
      context: context('session-default'),
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledOnce();
    stop();
  });
});
