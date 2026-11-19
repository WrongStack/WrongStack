import type { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { compactBridgeToolInput, installSubagentEventBridge } from '../src/host-event-bridge.js';

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event: string, fn: (payload: unknown) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
    emit(event: string, payload: unknown) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
  } as unknown as EventBus;
}

describe('host-event-bridge session stamping and payload bounds', () => {
  it('stamps bridged file.activity events with hostSessionId instead of the subagent private sessionId', () => {
    const events = createEventBus();
    const hostEvents = createEventBus();
    const fileActivities: Array<Record<string, unknown>> = [];
    hostEvents.on(
      'file.activity' as never,
      ((payload: Record<string, unknown>) => {
        fileActivities.push(payload);
      }) as never,
    );

    const dispose = installSubagentEventBridge({
      events,
      hostEvents,
      hostSessionId: 'host-tab-42',
      projectRoot: '/repo',
      effectiveCfg: { id: 'sub-9', name: 'auditor' } as never,
      subCfg: { id: 'sub-9', name: 'auditor' } as never,
    });

    events.emit(
      'tool.progress' as never,
      {
        sessionId: 'sub-private-1',
        id: 'tc-1',
        name: 'edit',
        event: { type: 'file_changed', path: 'src/a.ts', operation: 'edit' },
      } as never,
    );
    events.emit(
      'tool.progress' as never,
      {
        sessionId: 'sub-private-2',
        id: 'tc-2',
        name: 'write',
        event: { type: 'file_changed', data: { path: 'src/b.ts' }, operation: 'write' },
      } as never,
    );

    expect(fileActivities).toHaveLength(2);
    expect(fileActivities[0]?.['sessionId']).toBe('host-tab-42');
    expect(fileActivities[1]?.['sessionId']).toBe('host-tab-42');

    dispose();
    events.emit(
      'tool.progress' as never,
      {
        sessionId: 'sub-private-3',
        id: 'tc-3',
        name: 'edit',
        event: { type: 'file_changed', path: 'src/c.ts', operation: 'edit' },
      } as never,
    );
    expect(fileActivities).toHaveLength(2);
  });

  it('bounds array tool inputs and preserves surrogate pairs when truncating text', () => {
    const mixedArray = [
      'x'.repeat(500),
      42,
      true,
      null,
      [1, 2, 3],
      { nested: 'obj' },
      ...Array.from({ length: 200 }, () => 'y'.repeat(1000)),
    ];
    const compacted = compactBridgeToolInput(mixedArray) as {
      _arrayLength: number;
      items: unknown[];
    };
    expect(compacted._arrayLength).toBe(206);
    expect(compacted.items).toHaveLength(20);
    expect((compacted.items[0] as string).length).toBe(120);
    expect(compacted.items[1]).toBe(42);
    expect(compacted.items[2]).toBe(true);
    expect(compacted.items[3]).toBeNull();
    expect(compacted.items[4]).toBe('[Array(3)]');
    expect(compacted.items[5]).toBe('[Object]');
    expect(JSON.stringify(compacted).length).toBeLessThan(4096);

    for (const prefixLen of [357, 358, 359]) {
      const emojiStr = `${'a'.repeat(prefixLen)}😀${'z'.repeat(20)}`;
      const out = String(compactBridgeToolInput(emojiStr));
      expect(out.endsWith('…')).toBe(true);
      const beforeEllipsis = out.charCodeAt(out.length - 2);
      expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    }
    expect(compactBridgeToolInput('short 😀')).toBe('short 😀');
  });
});
