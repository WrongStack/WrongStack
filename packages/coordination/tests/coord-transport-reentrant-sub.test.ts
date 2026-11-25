import { describe, expect, it } from 'vitest';
import { InMemoryBridgeTransport } from '../src/in-memory-transport.js';

describe('InMemoryBridgeTransport re-entrant subscribe guard (F2292)', () => {
  it('does not deliver an already-sent message to a handler subscribed during send', async () => {
    const transport = new InMemoryBridgeTransport();
    let lateReceived = false;
    transport.subscribe('a1', () => {
      transport.subscribe('a1', () => {
        lateReceived = true;
      });
    });
    await transport.send({ from: 'leader', to: 'a1', type: 'note', payload: 'hi' } as never, 'a1');
    expect(lateReceived).toBe(false);
  });
});
