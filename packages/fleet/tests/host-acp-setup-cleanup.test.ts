import type { SubagentRunContext, TaskSpec } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { buildAcpSubagentRunner } from '../src/host-acp.js';

describe('buildAcpSubagentRunner sessionSetup cleanup', () => {
  it('revokes acquired MCP gateway grant when permissions(ctx) throws', async () => {
    let revoked = 0;
    const runner = await buildAcpSubagentRunner('test-agent', {
      projectRoot: process.cwd(),
      overrides: { 'test-agent': { command: 'node', args: ['-e', 'process.exit(1)'] } },
      bridge: { projectRoot: process.cwd() },
      acpProjectMcpGateway: async () => ({
        mcpServers: [
          { name: 'wrongstack-sage', type: 'http', url: 'http://127.0.0.1:1/mcp' } as never,
        ],
        revoke: () => {
          revoked += 1;
        },
      }),
      permissions: () => {
        throw new Error('permission policy construction failed');
      },
    });

    const task: TaskSpec = { id: 't1', description: 'test task' };
    const ctx = {
      subagentId: 'test-agent',
      sessionId: 'sess-1',
      signal: new AbortController().signal,
      config: {
        id: 'test-agent',
        name: 'test-agent',
        role: 'coder',
        provider: 'acp',
        model: 'test-agent',
        cwd: process.cwd(),
      },
    } as SubagentRunContext;

    await expect(runner(task, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('permission policy construction failed'),
    });
    expect(revoked).toBe(1);
  });
});
