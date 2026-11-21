import type { BridgeMessage, BridgeTransport } from '@wrongstack/contracts/types/agent-bridge';
import { describe, expect, it } from 'vitest';
import { createMessage, InMemoryAgentBridge } from '../src/agent-bridge.js';

describe('InMemoryAgentBridge.request sync-throw cleanup', () => {
  it('clears inflightGuards, pendingRequests, and timer when transport.send throws synchronously', async () => {
    let deliver: ((msg: BridgeMessage) => void) | undefined;
    let attempt = 0;
    const transport: BridgeTransport = {
      subscribe: (_id, handler) => {
        deliver = handler;
        return () => {};
      },
      send: (msg) => {
        attempt++;
        if (attempt === 1) throw new Error('sync transport error');
        queueMicrotask(() => deliver?.({ ...msg, from: 'coord', to: 'a1', payload: { ok: true } }));
        return Promise.resolve();
      },
      close: async () => {},
    };

    const bridge = new InMemoryAgentBridge(
      { agentId: 'a1', coordinatorId: 'coord', timeoutMs: 5000 },
      transport,
    );
    const msg = createMessage('task', 'a1', { step: 1 });

    await expect(bridge.request(msg, 5000)).rejects.toThrow('sync transport error');
    const retry = await bridge.request<{ ok: boolean }>(msg, 500);
    expect(retry.payload).toEqual({ ok: true });

    await bridge.stop();
  });
});
