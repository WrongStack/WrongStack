import { describe, expect, it } from 'vitest';
import { createChronicleCounterSink } from '../src/counter-sink.js';
import type { ChronicleEvent, ChronicleEventInput } from '../src/types.js';

describe('createChronicleCounterSink drain/dispose inflight barrier', () => {
  it('waits for prior in-flight emits to settle even when a subsequent emit fails', async () => {
    let releaseFirst!: (v: ChronicleEvent[]) => void;
    const firstGate = new Promise<ChronicleEvent[]>((r) => {
      releaseFirst = r;
    });
    let firstSettled = false;
    let calls = 0;

    const sink = createChronicleCounterSink({
      inner: {
        append: async (i) => ({ ...i }) as ChronicleEvent,
        appendBatch: async () => {
          calls++;
          if (calls === 1) {
            const res = await firstGate;
            firstSettled = true;
            return res;
          }
          throw new Error('disk full');
        },
        flush: async () => {},
        stats: () => ({}) as never,
      },
      level: 'lean',
      windowMs: 60_000,
      now: () => 1_000,
    });

    const event = (sessionId: string): ChronicleEventInput =>
      ({
        eventType: 'tool.started',
        outcome: 'success',
        occurredAt: new Date(1_000).toISOString(),
        scope: { sessionId },
        correlation: {},
        attributes: { toolName: 'read' },
      }) as ChronicleEventInput;

    await sink.append(event('s1'));
    const drain1 = sink.drain();
    await sink.append(event('s2'));

    let disposeDone = false;
    const disposePromise = sink.dispose().finally(() => {
      disposeDone = true;
    });

    await new Promise((r) => setTimeout(r, 15));
    expect(disposeDone).toBe(false);

    releaseFirst([]);
    await expect(disposePromise).rejects.toThrow('disk full');
    await drain1;
    expect(firstSettled).toBe(true);
  });
});
