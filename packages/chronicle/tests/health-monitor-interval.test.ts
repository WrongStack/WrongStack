import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { startChronicleHealthMonitor } from '../src/health-monitor.js';

describe('startChronicleHealthMonitor interval bounds', () => {
  it('falls back to default interval instead of 1ms spin when intervalMs is non-finite', async () => {
    const emitter = new EventEmitter();
    let samples = 0;
    emitter.on('runtime.health.sampled', () => {
      samples += 1;
    });
    const stop = startChronicleHealthMonitor({
      events: { emit: (type: string, payload: unknown) => emitter.emit(type, payload) } as never,
      journal: { stats: () => ({ written: 0, dropped: 0, queued: 0 }) } as never,
      context: { scope: { sessionId: 's1' } } as never,
      intervalMs: Number.NaN,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(samples).toBe(0);
    } finally {
      stop();
    }
  });
});
