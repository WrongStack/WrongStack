/**
 * The fleet tools an ACP agent leading the session reaches over a loopback
 * HTTP MCP endpoint: only the leader's coordination tools, behind a token,
 * each run as the leader's own tool call.
 */
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Tool } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import {
  FLEET_SERVER_NAME,
  fleetNote,
  fleetToolName,
  startFleetEndpoint,
} from '../src/acp-leader/acp-leader-fleet.js';
import type { AcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';

function host(tools: string[], runTool: AcpLeaderHost['runTool']): AcpLeaderHost {
  return {
    events: new EventBus(),
    projectRoot: '/proj',
    getConfig: () => ({}) as never,
    permission: () => ({}) as never,
    context: () => ({}) as never,
    getTool: (name) =>
      tools.includes(name)
        ? ({ name, description: `${name} tool`, inputSchema: { type: 'object' } } as Tool)
        : undefined,
    runTool,
  };
}

async function rpc(url: string, token: string | undefined, method: string, params?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
}

describe('fleet endpoint', () => {
  it("offers only the leader's coordination tools and runs them as the leader", async () => {
    const runTool = vi.fn(async (name: string, input: Record<string, unknown>) => ({
      content: `${name} ran with ${JSON.stringify(input)}`,
      isError: false,
    }));
    // `delegate` is disabled in this profile; `read` is not a fleet tool.
    const run = { sessionId: 'tab-2' };
    const endpoint = await startFleetEndpoint(
      host(['spawn_subagent', 'await_tasks', 'read'], runTool),
      run,
    );
    expect(endpoint).toBeDefined();
    try {
      expect(endpoint!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      expect(endpoint!.tools).toEqual(['spawn_subagent', 'await_tasks']);

      const list = await rpc(endpoint!.url, endpoint!.token, 'tools/list');
      expect(
        (list.body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name),
      ).toEqual(['spawn_subagent', 'await_tasks']);

      const call = await rpc(endpoint!.url, endpoint!.token, 'tools/call', {
        name: 'await_tasks',
        arguments: { taskIds: ['t1'] },
      });
      expect(JSON.stringify(call.body)).toContain('await_tasks ran with');
      // Run for the session the endpoint serves.
      expect(runTool).toHaveBeenCalledWith('await_tasks', { taskIds: ['t1'] }, run);

      // Not offered, so not run.
      await rpc(endpoint!.url, endpoint!.token, 'tools/call', { name: 'read', arguments: {} });
      expect(runTool).toHaveBeenCalledTimes(1);

      // Without the token nothing is served.
      expect((await rpc(endpoint!.url, undefined, 'tools/list')).status).toBe(401);
    } finally {
      await endpoint?.close();
    }
  });

  it('serves nothing when the leader has none of the tools', async () => {
    await expect(startFleetEndpoint(host(['read'], vi.fn()))).resolves.toBeUndefined();
  });

  it('invokes runTool with 2 arguments when run options are omitted', async () => {
    const runTool = vi.fn(async (_name: string, _input: Record<string, unknown>) => ({
      content: 'ok',
      isError: false,
    }));
    const endpoint = await startFleetEndpoint(host(['spawn_subagent'], runTool));
    expect(endpoint).toBeDefined();
    try {
      await rpc(endpoint!.url, endpoint!.token, 'tools/call', {
        name: 'spawn_subagent',
        arguments: { role: 'worker' },
      });
      expect(runTool).toHaveBeenCalledTimes(1);
      expect(runTool).toHaveBeenCalledWith('spawn_subagent', { role: 'worker' });
    } finally {
      await endpoint?.close();
    }
  });

  it("offers WrongStack's skill tool, so a playbook the task names can be loaded", async () => {
    const runTool = vi.fn(async () => ({ content: 'skill body', isError: false }));
    const endpoint = await startFleetEndpoint(host(['skill', 'read'], runTool));
    try {
      expect(endpoint?.tools).toEqual(['skill']);
      await rpc(endpoint!.url, endpoint!.token, 'tools/call', {
        name: 'skill',
        arguments: { name: 'bug-hunter' },
      });
      expect(runTool).toHaveBeenCalledWith('skill', { name: 'bug-hunter' });
      expect(fleetNote(endpoint!.tools)).toContain("- skill: load one of WrongStack's skills");
    } finally {
      await endpoint?.close();
    }
  });

  it('maps a fleet MCP tool name back to the leader tool, and nothing else', () => {
    expect(fleetToolName(`mcp__${FLEET_SERVER_NAME}__delegate`)).toBe('delegate');
    expect(fleetToolName(`mcp__${FLEET_SERVER_NAME}__skill`)).toBe('skill');
    expect(fleetToolName(`mcp__${FLEET_SERVER_NAME}__bash`)).toBeUndefined();
    expect(fleetToolName('mcp__wrongstack-index__codebase_search')).toBeUndefined();
  });

  it('explains only the tools the agent was given', () => {
    const note = fleetNote(['spawn_subagent', 'assign_task', 'await_tasks', 'fleet_status']);
    expect(note).toContain('spawn_subagent + assign_task + await_tasks');
    expect(note).toContain('fleet_status');
    expect(note).not.toContain('- delegate');
    expect(fleetNote(['delegate'])).toContain('[DELEGATION RESULT]');
  });

  it('catches runTool exceptions and returns an isError tool result instead of a JSON-RPC error', async () => {
    const runTool = vi.fn(async () => {
      throw new Error('worker failed unexpectedly');
    });
    const endpoint = await startFleetEndpoint(host(['delegate'], runTool));
    try {
      const call = await rpc(endpoint!.url, endpoint!.token, 'tools/call', {
        name: 'delegate',
        arguments: {},
      });
      expect(call.body).toMatchObject({
        result: {
          content: [{ type: 'text', text: expect.stringContaining('worker failed unexpectedly') }],
          isError: true,
        },
      });
      expect(call.body?.error).toBeUndefined();
    } finally {
      await endpoint?.close();
    }
  });
});
