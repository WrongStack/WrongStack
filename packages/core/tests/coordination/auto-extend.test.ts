import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it, vi } from 'vitest';
import { attachAutoExtend } from '../../src/coordination/index.js';

function emitTool(bus: EventBus): void {
  bus.emit('tool.executed', { id: 'call-read', name: 'read', durationMs: 1, ok: true });
}

function emitThreshold(
  bus: EventBus,
  kind: 'iterations' | 'tool_calls' | 'tokens' | 'cost' | 'timeout',
  limit: number,
): { extend: ReturnType<typeof vi.fn>; deny: ReturnType<typeof vi.fn> } {
  const extend = vi.fn();
  const deny = vi.fn();
  bus.emit('budget.threshold_reached', {
    kind,
    used: limit,
    limit,
    timeoutMs: 30_000,
    extend,
    deny,
  });
  return { extend, deny };
}

describe('attachAutoExtend', () => {
  it('extends a non-timeout kind by +50% up to the per-kind cap, then denies', () => {
    const bus = new EventBus();
    attachAutoExtend(bus, { maxExtensionsPerKind: 2 });

    const a = emitThreshold(bus, 'tool_calls', 1000);
    expect(a.extend).toHaveBeenCalledWith({ maxToolCalls: 1500 });
    expect(a.deny).not.toHaveBeenCalled();

    const b = emitThreshold(bus, 'tool_calls', 1500);
    expect(b.extend).toHaveBeenCalledWith({ maxToolCalls: 2250 });

    // Third hit exceeds maxExtensionsPerKind=2 → deny.
    const c = emitThreshold(bus, 'tool_calls', 2250);
    expect(c.extend).not.toHaveBeenCalled();
    expect(c.deny).toHaveBeenCalledOnce();
  });

  it('never dies on timeout while the agent keeps making progress', () => {
    const bus = new EventBus();
    attachAutoExtend(bus);

    // Progress happens, then a timeout threshold → extend.
    emitTool(bus);
    const a = emitThreshold(bus, 'timeout', 1000);
    expect(a.extend).toHaveBeenCalledWith({ timeoutMs: 1500 });
    expect(a.deny).not.toHaveBeenCalled();

    // More progress, another timeout → extend again (no cap on timeout).
    emitTool(bus);
    const b = emitThreshold(bus, 'timeout', 1500);
    expect(b.extend).toHaveBeenCalledWith({ timeoutMs: 2250 });
    expect(b.deny).not.toHaveBeenCalled();
  });

  it('denies a timeout when there is no new progress since the last grant', () => {
    const bus = new EventBus();
    attachAutoExtend(bus);

    emitTool(bus);
    const a = emitThreshold(bus, 'timeout', 1000);
    expect(a.extend).toHaveBeenCalledOnce();

    // No tool executed since the last grant → wedged → deny.
    const b = emitThreshold(bus, 'timeout', 1500);
    expect(b.extend).not.toHaveBeenCalled();
    expect(b.deny).toHaveBeenCalledOnce();
  });

  it('respects the timeout ceiling', () => {
    const bus = new EventBus();
    attachAutoExtend(bus, { ceiling: { timeoutMs: 1200 } });
    emitTool(bus);
    const a = emitThreshold(bus, 'timeout', 1000);
    // 1000 * 1.5 = 1500, capped to ceiling 1200.
    expect(a.extend).toHaveBeenCalledWith({ timeoutMs: 1200 });
  });

  it('detaches all listeners on unsubscribe', () => {
    const bus = new EventBus();
    const off = attachAutoExtend(bus);
    expect(bus.listenerCount('budget.threshold_reached')).toBe(1);
    off();
    expect(bus.listenerCount('budget.threshold_reached')).toBe(0);
    expect(bus.listenerCount('tool.executed')).toBe(0);
  });
});
