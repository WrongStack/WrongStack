import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { wireDecisionsToChronicle } from '../src/decision-adapter.js';
import { createChronicleContext } from '../src/index.js';

describe('wireDecisionsToChronicle resilience (F562)', () => {
  it('falls back to a valid ISO timestamp on non-finite at and safely skips non-string hash fields', () => {
    const events = new EventBus();
    const appended: Array<{
      eventType: string;
      occurredAt: string;
      attributes: Record<string, unknown>;
    }> = [];

    const unsub = wireDecisionsToChronicle({
      events,
      journal: {
        append: (input: {
          eventType: string;
          occurredAt: string;
          attributes: Record<string, unknown>;
        }) => {
          appended.push(input);
          return Promise.resolve({} as never);
        },
      } as never,
      context: createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-1'),
    });

    for (const badAt of [Number.NaN, Number.POSITIVE_INFINITY, 1e20, -1e20]) {
      events.emit('brain.human_answered', {
        at: badAt,
        sessionId: 's1',
        id: `d-${String(badAt)}`,
        text: 'ok',
      });
    }
    expect(appended).toHaveLength(4);
    for (const entry of appended) {
      expect(Number.isNaN(Date.parse(entry.occurredAt))).toBe(false);
    }

    appended.length = 0;
    events.emit('brain.decision_requested', {
      at: 1700000000000,
      sessionId: 's2',
      request: {
        id: 'req-1',
        source: 'user',
        risk: 'low',
        fallback: 'ask_human',
        question: { bad: 1 } as never,
        context: 42 as never,
      },
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.occurredAt).toBe(new Date(1700000000000).toISOString());
    expect(appended[0]?.attributes['questionHash']).toBeUndefined();
    expect(appended[0]?.attributes['contextHash']).toBeUndefined();

    unsub();
  });

  it('routes both synchronous throws and async rejections from journal.append to onPersistError', async () => {
    const events = new EventBus();
    const persistErrors: Array<{ message: string; eventType: string }> = [];
    let mode: 'sync' | 'async' = 'sync';

    const unsub = wireDecisionsToChronicle({
      events,
      journal: {
        append: () => {
          if (mode === 'sync') throw new Error('sync fail');
          return Promise.reject(new Error('async fail'));
        },
      } as never,
      context: createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-1'),
      onPersistError: (err, ev) =>
        persistErrors.push({
          message: err instanceof Error ? err.message : String(err),
          eventType: ev.eventType,
        }),
    });

    events.emit('brain.outcome', {
      at: Date.now(),
      sessionId: 's3',
      requestId: 'd-sync',
      outcome: 'success',
      detail: 'sync',
    });
    mode = 'async';
    events.emit('brain.outcome', {
      at: Date.now(),
      sessionId: 's3',
      requestId: 'd-async',
      outcome: 'failure',
      detail: 'async',
    });
    await Promise.resolve();
    await Promise.resolve();
    unsub();

    expect(persistErrors).toEqual([
      { message: 'sync fail', eventType: 'decision.outcome_observed' },
      { message: 'async fail', eventType: 'decision.outcome_observed' },
    ]);
  });
});
