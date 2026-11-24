import { afterAll, describe, expect, it } from 'vitest';
import {
  closeSharedAcpProjectMcpGateway,
  sharedAcpProjectMcpGateway,
} from '../src/fleet/acp-project-mcp-gateway.js';

describe('sharedAcpProjectMcpGateway', () => {
  afterAll(async () => {
    await closeSharedAcpProjectMcpGateway();
  });

  it('mints isolated HTTP MCP grants on one shared loopback gateway and revokes cleanly', async () => {
    const grant = await sharedAcpProjectMcpGateway({
      servers: ['codebase-index', 'kanban', 'requirement-intake'],
      projectRoot: process.cwd(),
      actor: 'test-worker-1',
      sessionId: 'sess-gw-1',
      role: 'executor',
    });

    expect(grant).toBeDefined();
    const names = grant!.mcpServers.map((s) => s.name);
    expect(names).toContain('wrongstack-index');
    expect(names).toContain('wrongstack-kanban');
    expect(names).toContain('wrongstack-intake');

    const indexDesc = grant!.mcpServers.find((s) => s.name === 'wrongstack-index')!;
    const authHeader = indexDesc.headers.find((h) => h.name === 'Authorization')!.value;

    // Verify real JSON-RPC tools/list works over HTTP with the grant token
    const res = await fetch(indexDesc.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(body.result?.tools?.some((t) => t.name === 'codebase_stats')).toBe(true);

    // Revoking the grant immediately blocks further requests with 401
    await grant!.revoke();
    const afterRevoke = await fetch(indexDesc.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(afterRevoke.status).toBe(401);
  });
});
