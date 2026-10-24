import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { expect, it, vi } from 'vitest';
import { MCPRegistry } from '../src/registry.js';
import type { MCPTaskContext as AgentContext } from '../src/task-identity.js';

it.each([
  'resume',
  'automatic',
  'other-session',
  'other-agent',
  'other-account',
  'other-server',
  'other-project',
  'policy',
  'missing',
  'failed',
  'account-during-poll',
  'owner-during-poll',
])('persists and scopes restart recovery: %s', async (mode) => {
  const tempBase = await realpath(os.tmpdir()),
    directory = await mkdtemp(path.join(tempBase, 'wrongstack-task-journal-'));
  if (
    path.dirname(directory) !== tempBase ||
    !path.basename(directory).startsWith('wrongstack-task-journal-')
  )
    throw new Error('Unsafe fixture directory');
  const task = {
    taskId: 'durable-build',
    status: 'working',
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: null,
    pollIntervalMs: 100,
  };
  const calls: string[] = [];
  let restarted = false,
    grant = 'grant-a',
    currentSession = 'original-session';
  let firstPoll!: () => void;
  const polled = new Promise<void>((resolve) => {
    firstPoll = resolve;
  });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const bytes of req) raw += bytes.toString();
    const m = JSON.parse(raw);
    calls.push(m.method);
    let result: unknown, error: unknown;
    if (m.method === 'server/discover')
      result = {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {}, extensions: { 'io.modelcontextprotocol/tasks': {} } },
      };
    else if (m.method === 'tools/list')
      result = {
        resultType: 'complete',
        tools: [{ name: 'build', inputSchema: { type: 'object' } }],
      };
    else if (m.method === 'tools/call') result = { resultType: 'task', ...task };
    else {
      firstPoll();
      if (!restarted && mode === 'account-during-poll') grant = 'grant-b';
      if (!restarted && mode === 'owner-during-poll') currentSession = 'other-session';
      if (restarted && mode === 'missing') error = { code: -32602, message: 'Task expired' };
      else
        result = restarted
          ? mode === 'failed'
            ? {
                resultType: 'complete',
                ...task,
                status: 'failed',
                error: { code: -32603, message: 'SECRET-FAILURE' },
              }
            : {
                resultType: 'complete',
                ...task,
                status: 'completed',
                result: { content: [{ type: 'text', text: 'Recovered build result' }] },
              }
          : { resultType: 'complete', ...task };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(error ? { error } : { result }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const journalDir = path.join(directory, 'tasks');
  const config = {
    name: 'durable',
    transport: 'streamable-http' as const,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    headers: { Authorization: 'Bearer AUTH-SECRET-FIRST' },
    allowPrivateNetworks: true,
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  const make = (cwd = directory) => {
    const tools = new ToolRegistry();
    return {
      tools,
      registry: new MCPRegistry({
        toolRegistry: tools,
        events: new EventBus(),
        log,
        cwd,
        taskJournalDir: journalDir,
        authorizationProviderFactory: () => ({
          getAccessToken: async () => undefined,
          getTaskIdentity: async () => grant,
        }),
      }),
    };
  };
  const otherDirectory = path.join(directory, 'other-project');
  await mkdir(otherDirectory);
  const first = make(),
    second = make(mode === 'other-project' ? otherDirectory : directory),
    appendMessage = vi.fn();
  const owner = {
    session: { id: 'original-session' },
    eventSessionId: () => currentSession,
    agentId: 'leader',
    signal: new AbortController().signal,
    requestUserInput: vi.fn(),
    state: { appendMessage },
  } as unknown as AgentContext;
  let running: Promise<unknown> | undefined;
  try {
    await first.registry.start(config);
    const tool = first.tools.list().find((t) => t.name === 'mcp__durable__build')!;
    running = tool.execute({ secret: 'INPUT-MUST-NOT-PERSIST' }, owner, { signal: owner.signal });
    void running.catch(() => undefined);
    await polled;
    expect(await readdir(journalDir)).toContain('journal.json');
    const text = await readFile(path.join(journalDir, 'journal.json'), 'utf8');
    expect(text).toContain('durable-build');
    expect(text).not.toContain('INPUT-MUST-NOT-PERSIST');
    expect(text).not.toContain('AUTH-SECRET');
    expect(text).not.toContain('grant-a');
    await first.registry.stopAll();
    await running.catch(() => undefined);
    restarted = true;
    const beforeRecovery = calls.length;
    await second.registry.start({
      ...config,
      ...(mode === 'other-account'
        ? { headers: { Authorization: 'Bearer AUTH-SECRET-OTHER' } }
        : {}),
      ...(mode === 'other-server' ? { url: config.url + '?other-target' } : {}),
      ...(mode === 'policy' ? { allowedTools: [] } : {}),
    });
    const target =
      mode === 'other-session'
        ? ({
            ...owner,
            session: { id: 'other-session' },
            eventSessionId: () => 'other-session',
          } as AgentContext)
        : mode === 'other-agent'
          ? ({ ...owner, agentId: 'other-agent' } as AgentContext)
          : owner;
    if (mode === 'automatic') {
      second.registry.setTaskRecoveryContext(() => target);
      await vi.waitFor(() => expect(appendMessage).toHaveBeenCalled(), { timeout: 3000 });
    }
    await second.registry.recoverTasks(target);
    if (mode === 'resume' || mode === 'automatic')
      expect(appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'runtime',
          content: expect.stringContaining('Recovered build result'),
        }),
      );
    else if (mode === 'missing' || mode === 'failed') {
      expect(appendMessage).toHaveBeenCalledTimes(1);
      expect(appendMessage.mock.calls[0]![0].content).not.toContain('SECRET-FAILURE');
      const count = calls.length;
      await second.registry.recoverTasks(target);
      expect(calls.length).toBe(count);
    } else {
      expect(appendMessage).not.toHaveBeenCalled();
      expect(calls.slice(beforeRecovery)).not.toContain('tasks/get');
    }
    expect(calls.filter((m) => m === 'tools/call')).toHaveLength(1);
    expect(calls).not.toContain('tasks/cancel');
  } finally {
    await first.registry.stopAll();
    await second.registry.stopAll();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});
