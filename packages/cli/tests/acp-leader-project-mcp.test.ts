/**
 * The WrongStack project services an ACP agent leading the session reaches.
 *
 * They used to reach the leader only as stdio descriptors (`<process.execPath>
 * mcp serve <name> ...`). In the standalone desktop engine that executable's
 * main is the engine, not the CLI, so every one of them died on start with
 * "Desktop engine requires a valid port, private token, and disabled frontend
 * directory." and the leader had no project service at all. The leader now
 * also gets them from its own process over loopback HTTP (the workers'
 * `ProjectMcpGateway` grant), which needs no child process and no CLI; the
 * stdio descriptors stay for stdio-only agents.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, StreamEvent } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const acp = vi.hoisted(() => ({ starts: [] as Array<Record<string, unknown>> }));

vi.mock('@wrongstack/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/acp')>()),
  findAgentDescriptor: (id: string) =>
    id === 'claude-code' ? { id, contextWindow: 1_000_000 } : undefined,
  resolveAcpAgentCommand: (id: string) =>
    id === 'claude-code' ? { command: 'npx', args: ['adapter'], role: id } : null,
  ACPSession: {
    start: async (opts: Record<string, unknown>) => {
      acp.starts.push(opts);
      return {
        openSession: async () => ({ sessionId: 'sess_mcp', resumed: false }),
        getCapabilities: () => ({ promptCapabilities: {} }),
        getAvailableCommands: () => [],
        prompt: async () => ({
          text: 'ok',
          stopReason: 'end_turn',
          toolCalls: [],
          diffs: [],
          thoughts: '',
          hasText: true,
        }),
        close: async () => {},
        canSteer: () => false,
        steer: async () => 'unsupported',
        getSessionPlans: () => [],
      };
    },
  },
}));

const { bindAcpLeaderHost, closeAcpLeaderSessions } = await import(
  '../src/acp-leader/acp-leader-host.js'
);
const { AcpLeaderProvider } = await import('../src/acp-leader/acp-leader-provider.js');

const PROJECT_SERVICES = [
  'wrongstack-index',
  'wrongstack-sage',
  'wrongstack-mailbox',
  'wrongstack-kanban',
  'wrongstack-intake',
];

interface McpDescriptor {
  type?: string | undefined;
  name: string;
  url?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  command?: string | undefined;
}

let projectRoot: string;

/** One leader turn, so the agent session starts; the MCP descriptors it was given. */
async function startLeader(): Promise<McpDescriptor[]> {
  bindAcpLeaderHost({
    events: new EventBus(),
    projectRoot,
    getConfig: () => ({}) as Config,
    permission: () => ({ evaluate: async () => ({ permission: 'auto' }) }) as never,
    context: () => ({}) as never,
    getTool: () => undefined,
    runTool: async () => ({ content: '', isError: true }),
  });
  const provider = new AcpLeaderProvider({
    bootConfig: {} as Config,
    buildProvider: () => undefined,
  });
  const stream = provider.stream(
    {
      model: 'claude-code',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      cache: { sessionId: 's-mcp', threadId: 's-mcp' },
    },
    { signal: new AbortController().signal },
  );
  for await (const event of stream as AsyncIterable<StreamEvent>) void event;
  return (acp.starts[0]?.mcpServers ?? []) as McpDescriptor[];
}

/** The loopback endpoint of `name`, with its grant, or undefined when not served. */
function httpEndpoint(
  servers: McpDescriptor[],
  name: string,
): { url: string; authorization: string } | undefined {
  const server = servers.find((s) => s.type === 'http' && s.name === name);
  const authorization = server?.headers?.find((header) => header.name === 'Authorization')?.value;
  return server?.url && authorization ? { url: server.url, authorization } : undefined;
}

async function listTools(endpoint: { url: string; authorization: string }): Promise<string[]> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: endpoint.authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

beforeEach(() => {
  acp.starts.length = 0;
  // An empty project of its own: the services are opened on whatever root they are given.
  projectRoot = mkdtempSync(join(tmpdir(), 'wrongstack-acp-leader-mcp-'));
});

afterEach(async () => {
  await closeAcpLeaderSessions();
  bindAcpLeaderHost(undefined);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('project services of an ACP leader', () => {
  it('serves every project service over loopback HTTP from this process', async () => {
    const servers = await startLeader();

    expect(servers.filter((server) => server.type === 'http').map((server) => server.name)).toEqual(
      expect.arrayContaining(PROJECT_SERVICES),
    );

    for (const name of PROJECT_SERVICES) {
      const endpoint = httpEndpoint(servers, name);
      if (!endpoint) throw new Error(`no loopback HTTP endpoint for ${name}`);
      expect(endpoint.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp/${name}$`));
      expect(endpoint.authorization).toMatch(/^Bearer /);
      expect((await listTools(endpoint)).length, name).toBeGreaterThan(0);
    }
  });

  it('keeps the stdio descriptors, so a stdio-only agent still reaches the services', async () => {
    const servers = await startLeader();

    const stdio = servers.filter((server) => server.type !== 'http');
    expect(stdio.map((server) => server.name)).toEqual(expect.arrayContaining(PROJECT_SERVICES));
    for (const server of stdio) expect(server.command, server.name).toBeTruthy();
  });

  it('answers nothing once the leader session is closed: its grant is revoked', async () => {
    const endpoint = httpEndpoint(await startLeader(), 'wrongstack-sage');
    if (!endpoint) throw new Error('no loopback HTTP endpoint for wrongstack-sage');
    expect((await listTools(endpoint)).length).toBeGreaterThan(0);

    await closeAcpLeaderSessions();

    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: endpoint.authorization },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
  });
});
