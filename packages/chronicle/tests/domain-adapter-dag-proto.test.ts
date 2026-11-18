import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { createChronicleContext } from '../src/context.js';
import { wireDomainEventsToChronicle } from '../src/domain-adapter.js';
import type { ChronicleEventSink } from '../src/sink.js';
import type { ChronicleEvent, ChronicleEventInput } from '../src/types.js';

describe('wireDomainEventsToChronicle DAG and prototype sanitization', () => {
  it('preserves shared non-circular DAG references, marks true ancestor cycles, and strips __proto__', () => {
    const captured: ChronicleEventInput[] = [];
    const sink: ChronicleEventSink = {
      append: async (input) => {
        captured.push(input);
        return input as unknown as ChronicleEvent;
      },
      flush: async () => {},
      stats: () => ({
        acceptedEvents: captured.length,
        persistedEvents: captured.length,
        rejectedEvents: 0,
        failedEvents: 0,
        batches: captured.length,
        pendingEvents: 0,
        maxObservedPending: 0,
        largestBatch: 1,
        partitionRolls: 0,
      }),
    };

    const events = new EventBus();
    const context = createChronicleContext({ installationId: 'i', machineId: 'm' }, 'trace-1');
    const off = wireDomainEventsToChronicle({ events, journal: sink, context });

    const sharedMeta = { role: 'reviewer', mode: 'strict' };
    const nodeA: Record<string, unknown> = { id: 'A' };
    const nodeB: Record<string, unknown> = { id: 'B', back: nodeA };
    nodeA['next'] = nodeB;
    const hostile = JSON.parse('{"kind":"x","__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;

    events.emit(
      'agent.status_changed' as never,
      {
        sessionId: 's-1',
        agents: [
          { id: 'a1', meta: sharedMeta },
          { id: 'a2', meta: sharedMeta },
        ],
        first: nodeA,
        second: nodeB,
        extra: hostile,
      } as never,
    );
    off();

    expect(captured).toHaveLength(1);
    const attrs = captured[0]!.attributes as Record<string, unknown>;
    const agents = attrs['agents'] as Array<Record<string, unknown>>;
    expect(agents[0]!['meta']).toEqual({ role: 'reviewer', mode: 'strict' });
    expect(agents[1]!['meta']).toEqual({ role: 'reviewer', mode: 'strict' });

    const first = attrs['first'] as { id: string; next: { id: string; back: unknown } };
    const second = attrs['second'] as { id: string; back: { id: string; next: unknown } };
    expect(first.next.back).toEqual({ circular: true });
    expect(second.id).toBe('B');
    expect(second.back.next).toEqual({ circular: true });

    const extra = attrs['extra'] as Record<string, unknown>;
    expect(Object.getPrototypeOf(extra)).toBe(Object.prototype);
    expect('polluted' in extra).toBe(false);
    expect(extra['kind']).toBe('x');
  });
});
