import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { attachAutoExtend } from '../src/auto-extend.js';

describe('attachAutoExtend idle_timeout patch (F196)', () => {
  it('extends idleTimeoutMs rather than overwriting timeoutMs when kind is idle_timeout', () => {
    const bus = new EventBus();
    const detach = attachAutoExtend(bus, { factor: 0.5 });
    try {
      let patch: Record<string, unknown> | undefined;
      let denied = false;
      bus.emit('tool.executed', { tool: 'read', durationMs: 1, success: true } as never);
      bus.emit('budget.threshold_reached', {
        kind: 'idle_timeout',
        limit: 30_000,
        current: 30_000,
        extend: (next: Record<string, unknown>) => {
          patch = next;
        },
        deny: () => {
          denied = true;
        },
      } as never);

      expect(denied).toBe(false);
      expect(patch).toEqual({ idleTimeoutMs: 45_000 });
    } finally {
      detach();
    }
  });
});
