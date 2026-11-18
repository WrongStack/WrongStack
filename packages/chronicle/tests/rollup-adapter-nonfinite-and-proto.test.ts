import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { createChronicleContext, wireRollupsToChronicle } from '../src/index.js';
import type { ChronicleEventInput } from '../src/types.js';

describe('wireRollupsToChronicle non-finite sample guard and __proto__ own-property fidelity', () => {
  it('ignores NaN and Infinity metric samples without poisoning finite window statistics and preserves __proto__ keys', async () => {
    const appended: ChronicleEventInput[] = [];
    const journal = {
      append: async (input: ChronicleEventInput) => {
        appended.push(JSON.parse(JSON.stringify(input)) as ChronicleEventInput);
        return input as never;
      },
      stats: () => ({ eventCount: appended.length, byteSize: 0 }),
      flush: async () => {},
    };
    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-1');
    const dispose = wireRollupsToChronicle({ events, journal, context, windowMs: 60_000 });

    events.emit('ctx.pct', { sessionId: 's-nan', load: 0.25, tokens: 250 });
    events.emit('ctx.pct', {
      sessionId: 's-nan',
      load: Number.NaN,
      tokens: Number.POSITIVE_INFINITY,
    });
    events.emit('ctx.pct', { sessionId: 's-nan', load: 0.75, tokens: 750 });

    events.emit('tool.progress', {
      sessionId: 's-proto',
      id: 'tc-proto',
      name: 'bash',
      event: { type: '__proto__', text: 'abc' },
    } as never);
    events.emit(
      'ctx.pct',
      JSON.parse('{"sessionId":"s-proto-gauge","__proto__":42,"load":0.5}') as never,
    );

    dispose();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const nanRollup = appended.find((e) => e.scope.sessionId === 's-nan');
    expect(nanRollup?.attributes).toMatchObject({
      signal: 'ctx.pct',
      samples: 3,
      stats: {
        load: { sum: 1, min: 0.25, max: 0.75, last: 0.75 },
        tokens: { sum: 1000, min: 250, max: 750, last: 750 },
      },
    });

    const protoProgress = appended.find((e) => e.scope.sessionId === 's-proto');
    const categories = (protoProgress?.attributes as { categories?: Record<string, number> })
      ?.categories;
    expect(Object.hasOwn(categories ?? {}, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(categories, '__proto__')?.value).toBe(1);

    const protoGauge = appended.find((e) => e.scope.sessionId === 's-proto-gauge');
    const gaugeStats = (protoGauge?.attributes as { stats?: Record<string, unknown> })?.stats;
    expect(Object.hasOwn(gaugeStats ?? {}, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(gaugeStats, '__proto__')?.value).toEqual({
      sum: 42,
      last: 42,
    });
  });
});
