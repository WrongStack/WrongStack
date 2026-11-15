import { describe, expect, it } from 'vitest';
import { CollaborationBus } from '../src/collab-bus.js';

describe('CollaborationBus.waitForResume timeout clamping (F385)', () => {
  it('clamps timeoutMs above 32-bit signed max instead of timing out in 1ms', async () => {
    const bus = new CollaborationBus();
    bus.requestPause('user');
    setTimeout(() => bus.resume(), 30);

    await expect(bus.waitForResume(3_000_000_000)).resolves.toBe(true);
  });
});
