import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { expect, it, vi } from 'vitest';
import { MCPRegistry } from '../src/registry.js';
import type { MCPTaskContext } from '../src/task-identity.js';
import { MCPTaskJournal } from '../src/task-journal.js';

it.each(['cancel', 'retry', 'foreign-session', 'foreign-agent', 'account', 'policy'])(
  'manages a saved task through its registry: %s',
  async (mode) => {
    const base = await realpath(os.tmpdir());
    const directory = await mkdtemp(path.join(base, 'wrongstack-task-ui-'));
    if (
      path.dirname(directory) !== base ||
      !path.basename(directory).startsWith('wrongstack-task-ui-')
    )
      throw new Error('Unsafe fixture directory');
    const calls: string[] = [];
    let status = 'working',
      grant = 'account-a';
    let polled!: () => void;
    const firstPoll = new Promise<void>((resolve) => {
      polled = resolve;
    });
    const task = {
      taskId: 'remote-build',
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttlMs: null,
      pollIntervalMs: 100,
    };
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const bytes of req) raw += bytes.toString();
      const m = JSON.parse(raw);
      calls.push(m.method);
      let result: unknown;
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
      else if (m.method === 'tools/call') result = { resultType: 'task', ...task, status };
      else if (m.method === 'tasks/cancel') result = { resultType: 'complete' };
      else {
        polled();
        result = {
          resultType: 'complete',
          ...task,
          status,
          ...(status === 'completed'
            ? { result: { content: [{ type: 'text', text: 'build recovered' }] } }
            : {}),
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = {
      name: 'builder',
      transport: 'streamable-http' as const,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      allowPrivateNetworks: true,
    };
    const journalDir = path.join(directory, 'tasks');
    const create = () => {
      const tools = new ToolRegistry();
      const registry = new MCPRegistry({
        toolRegistry: tools,
        events: new EventBus(),
        log: { info() {}, debug() {}, warn() {}, error() {} } as unknown as Logger,
        cwd: directory,
        taskJournalDir: journalDir,
        authorizationProviderFactory: () => ({
          getAccessToken: async () => undefined,
          getTaskIdentity: async () => grant,
        }),
      });
      return { registry, tools };
    };
    const first = create(),
      second = create(),
      appendMessage = vi.fn();
    const owner = {
      session: { id: 'session-a' },
      agentId: 'leader',
      signal: new AbortController().signal,
      requestUserInput: vi.fn(),
      state: { appendMessage },
    } as unknown as MCPTaskContext;
    try {
      await first.registry.start(config);
      const running = first.tools
        .list()
        .find((t) => t.name === 'mcp__builder__build')!
        .execute({}, owner, { signal: owner.signal });
      void running.catch(() => undefined);
      await firstPoll;
      const receipt = (await first.registry.listTasks(owner))[0]!;
      if (mode === 'cancel') {
        expect(await first.registry.retryTask(owner, receipt.id)).toBe('busy');
        expect(await second.registry.retryTask(owner, receipt.id)).toBe('busy');
        // Cancellation also works while the original invocation holds its observer lease.
        await first.registry.cancelTask(owner, receipt.id);
        expect((await first.registry.listTasks(owner))[0]).toMatchObject({
          status: 'working',
          delivered: false,
        });
      }
      await first.registry.stopAll();
      await running.catch(() => undefined);
      await second.registry.start({
        ...config,
        ...(mode === 'policy' ? { allowedTools: [] } : {}),
      });
      if (mode === 'retry') {
        const journal = new MCPTaskJournal(journalDir);
        const leaseToken = randomUUID();
        await journal.claim(
          receipt.id,
          { sessionId: 'session-a', agentId: 'leader' },
          receipt.binding,
          leaseToken,
        );
        await journal.update(receipt.id, leaseToken, { retryAfter: Date.now() + 300_000 });
        await journal.release(receipt.id, leaseToken);
        expect(await second.registry.recoverTasks(owner)).toEqual([]);
        status = 'completed';
        expect(await second.registry.retryTask(owner, receipt.id)).toBe('requested');
        await vi.waitFor(
          async () => expect((await second.registry.listTasks(owner))[0]?.delivered).toBe(true),
          { timeout: 3000 },
        );
        expect(appendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('build recovered') }),
        );
        expect(await second.registry.retryTask(owner, receipt.id)).toBe('unavailable');
      } else if (mode === 'cancel') {
        await second.registry.cancelTask(owner, receipt.id);
        expect((await second.registry.listTasks(owner))[0]?.status).toBe('working');
        expect(calls.filter((m) => m === 'tasks/cancel')).toHaveLength(2);
        status = 'cancelled';
        await second.registry.recoverTasks(owner);
        expect((await second.registry.listTasks(owner))[0]).toMatchObject({
          status: 'cancelled',
          delivered: true,
        });
      } else {
        if (mode === 'account') grant = 'account-b';
        const target = {
          ...owner,
          ...(mode === 'foreign-session' ? { session: { id: 'session-b' } } : {}),
          ...(mode === 'foreign-agent' ? { agentId: 'worker' } : {}),
        } as MCPTaskContext;
        await expect(second.registry.cancelTask(target, receipt.id)).rejects.toThrow();
        if (mode.startsWith('foreign'))
          expect(await second.registry.retryTask(target, receipt.id)).toBe('unavailable');
        else await second.registry.recoverTasks(target);
        expect(calls).not.toContain('tasks/cancel');
        expect(appendMessage).not.toHaveBeenCalled();
      }
      expect(calls.filter((m) => m === 'tools/call')).toHaveLength(1);
    } finally {
      await first.registry.stopAll();
      await second.registry.stopAll();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
