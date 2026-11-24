import { describe, expect, it } from 'vitest';
import { ProjectMcpGateway } from '../src/project-mcp-gateway.js';
import { MCPServer } from '../src/server-dispatch.js';

describe('P2.2 & P2.3 ProjectMcpGateway & dynamic MCP Resources', () => {
  it('isolates per-worker grants, serves dynamic resources, and enforces bearer & service scoping', async () => {
    const makeServer = (tag: string) =>
      new MCPServer({
        host: {
          listTools: () => [
            {
              name: 'ping_actor',
              description: 'Returns actor tag',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
          callTool: async () => ({ content: `actor:${tag}`, isError: false }),
        },
        resourceProvider: {
          listResources: () => [
            {
              uri: `wrongstack://${tag}/brief`,
              name: `${tag} brief`,
              mimeType: 'application/json',
            },
          ],
          readResource: async (uri) =>
            uri === `wrongstack://${tag}/brief`
              ? [{ uri, mimeType: 'application/json', text: JSON.stringify({ actor: tag }) }]
              : null,
        },
      });

    const gateway = await ProjectMcpGateway.start();
    try {
      const grantA = gateway.registerGrant({
        actor: 'worker-a',
        sessionId: 'sess-1',
        services: { 'wrongstack-sage': makeServer('worker-a') },
      });
      const grantB = gateway.registerGrant({
        actor: 'worker-b',
        sessionId: 'sess-1',
        services: { 'wrongstack-sage': makeServer('worker-b') },
      });

      expect(gateway.activeGrants).toBe(2);
      const urlA = grantA.mcpServers[0]!.url;
      const urlB = grantB.mcpServers[0]!.url;

      // 1. Unauthenticated request is rejected (401)
      const unauth = await fetch(urlA, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(unauth.status).toBe(401);

      // 2. Unauthorized service for grantA is rejected (403)
      const forbidden = await fetch(`${gateway.url}/mcp/wrongstack-kanban`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${grantA.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(forbidden.status).toBe(403);

      // 3. Initialize mints Mcp-Session-Id header
      const initRes = await fetch(urlA, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${grantA.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
      });
      expect(initRes.status).toBe(200);
      const mintedSessionId = initRes.headers.get('mcp-session-id');
      expect(mintedSessionId).toBeTruthy();

      // 4. Both workers call tools/call concurrently with their own actor isolation
      const [resA, resB] = await Promise.all([
        fetch(urlA, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${grantA.token}`,
            'mcp-session-id': mintedSessionId!,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'ping_actor', arguments: {} },
          }),
        }).then((r) => r.json() as Promise<{ result: { content: { text: string }[] } }>),
        fetch(urlB, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${grantB.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'ping_actor', arguments: {} },
          }),
        }).then((r) => r.json() as Promise<{ result: { content: { text: string }[] } }>),
      ]);
      expect(resA.result.content[0]?.text).toBe('actor:worker-a');
      expect(resB.result.content[0]?.text).toBe('actor:worker-b');

      // 5. Dynamic MCP resources/list and resources/read work over the gateway
      const readRes = await fetch(urlA, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${grantA.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/read',
          params: { uri: 'wrongstack://worker-a/brief' },
        }),
      }).then((r) => r.json() as Promise<{ result: { contents: { text: string }[] } }>);
      expect(JSON.parse(readRes.result.contents[0]!.text)).toEqual({ actor: 'worker-a' });

      // 6. DELETE tears down session with 204
      const delRes = await fetch(urlA, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${grantA.token}`,
          'mcp-session-id': mintedSessionId!,
        },
      });
      expect(delRes.status).toBe(204);

      // 7. Revoking grant immediately blocks subsequent calls
      grantA.revoke();
      expect(gateway.activeGrants).toBe(1);
      const afterRevoke = await fetch(urlA, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${grantA.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
      });
      expect(afterRevoke.status).toBe(401);
    } finally {
      await gateway.close();
    }
  });
});
