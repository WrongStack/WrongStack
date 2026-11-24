import { describe, expect, it } from 'vitest';
import { ProjectMcpGateway } from '../src/project-mcp-gateway.js';
import { MCPServer } from '../src/server-dispatch.js';

describe('ProjectMcpGateway malformed service path', () => {
  it('answers a malformed percent-escape with 400 instead of hanging the request', async () => {
    const gateway = await ProjectMcpGateway.start();
    try {
      const grant = gateway.registerGrant({
        actor: 'worker-a',
        services: {
          'wrongstack-sage': new MCPServer({
            host: { listTools: () => [], callTool: async () => ({ content: '', isError: false }) },
          }),
        },
      });
      const res = await fetch(`${gateway.url}/mcp/%E0`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.status).toBe(400);
      // The gateway keeps serving after the malformed request.
      const health = await fetch(`${gateway.url}/health`, { signal: AbortSignal.timeout(5_000) });
      expect(health.status).toBe(200);
    } finally {
      await gateway.close();
    }
  });
});
