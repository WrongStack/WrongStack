import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WrongStackACPServer } from '../src/agent/wrongstack-acp-agent.js';

function getPort(srv: WrongStackACPServer): number {
  const httpServer = (srv as unknown as { httpServer: Server }).httpServer;
  return (httpServer.address() as AddressInfo).port;
}

describe('WrongStackACPServer selfOrigin on ephemeral / IPv6 binds (F2730)', () => {
  it('accepts same-origin http://[::1]:<boundPort> and rejects foreign origins', async () => {
    const server = new WrongStackACPServer({
      transport: 0,
      host: '::1',
      runTurn: async () => ({ stopReason: 'end_turn' }),
    });
    await server.start();
    const port = getPort(server);
    try {
      const ok = await fetch(`http://[::1]:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://[::1]:${port}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1 },
        }),
      });
      expect(ok.status).toBe(200);

      const forbidden = await fetch(`http://[::1]:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: 1 },
        }),
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
});
