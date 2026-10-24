import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { Context } from '@wrongstack/core/agent';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { ToolRegistry } from '@wrongstack/core/registry';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { expect, it } from 'vitest';
import { MCPRegistry } from '../src/registry.js';

it('flushes recovered output before acknowledging delivery and deduplicates it after another restart', async () => {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'wrongstack-task-conversation-'));
  if (
    path.dirname(root) !== base ||
    !path.basename(root).startsWith('wrongstack-task-conversation-')
  )
    throw new Error('Unsafe fixture directory');
  const task = {
    taskId: 'conversation-task',
    status: 'working',
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: null,
    pollIntervalMs: 100,
  };
  let restarted = false,
    calls = 0,
    polls = 0,
    ready!: () => void;
  const firstPoll = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const m = JSON.parse(raw);
    let result;
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
    else if (m.method === 'tools/call') {
      calls++;
      result = { resultType: 'task', ...task };
    } else {
      assert.equal(m.method, 'tasks/get');
      polls++;
      ready();
      result = restarted
        ? {
            resultType: 'complete',
            ...task,
            status: 'completed',
            result: { content: [{ type: 'text', text: 'DURABLE-RECOVERED-OUTPUT' }] },
          }
        : { resultType: 'complete', ...task };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    name: 'conversation',
    transport: 'streamable-http' as const,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    allowPrivateNetworks: true,
  };
  const store = new DefaultSessionStore({ dir: path.join(root, 'sessions') });
  const writer = await store.create({ id: '', provider: 'unused', model: 'unused' });
  const contexts: Context[] = [];
  const context = (session: Context['session']) => {
    const ctx = new Context({
      systemPrompt: [],
      provider: { name: 'unused', capabilities: {} } as never,
      session,
      signal: new AbortController().signal,
      tokenCounter: new DefaultTokenCounter(),
      cwd: root,
      projectRoot: root,
      model: 'unused',
      agentId: 'leader',
    });
    contexts.push(ctx);
    return ctx;
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  const make = () => {
    const tools = new ToolRegistry();
    return {
      tools,
      registry: new MCPRegistry({
        toolRegistry: tools,
        events: new EventBus(),
        log,
        cwd: root,
        taskJournalDir: path.join(root, 'tasks'),
      }),
    };
  };
  const first = make(),
    second = make(),
    third = make(),
    ctx = context(writer);
  let running: Promise<unknown> | undefined;
  try {
    await first.registry.start(config);
    const tool = first.tools.list().find((t) => t.name === 'mcp__conversation__build')!;
    running = tool.execute({}, ctx, { signal: ctx.signal });
    void running.catch(() => undefined);
    await firstPoll;
    await first.registry.stopAll();
    await running.catch(() => undefined);
    await writer.close();
    const resumed = await store.resume(writer.id),
      restored = context(resumed.writer);
    restored.messages = resumed.data.messages;
    restarted = true;
    await second.registry.start(config);
    second.registry.setTaskRecoveryContext(() => restored);
    expect((await second.registry.recoverTasks(restored))[0]?.outcome).toBe('recovered');
    // No caller-side flush: delivery itself must fence the session writer.
    const replay = await store.load(writer.id);
    expect(
      replay.messages.some(
        (m) =>
          m.origin === 'runtime' && JSON.stringify(m.content).includes('DURABLE-RECOVERED-OUTPUT'),
      ),
    ).toBe(true);
    await second.registry.stopAll();
    await resumed.writer.close();
    // Simulate a crash after the transcript flush but before the receipt acknowledgement.
    const file = path.join(root, 'tasks', 'journal.json'),
      journal = JSON.parse(await fs.readFile(file, 'utf8'));
    journal.entries[0].delivered = false;
    await fs.writeFile(file, JSON.stringify(journal));
    const again = await store.resume(writer.id),
      next = context(again.writer);
    next.messages = again.data.messages;
    await third.registry.start(config);
    const before = polls;
    expect((await third.registry.recoverTasks(next))[0]?.outcome).toBe('recovered');
    expect(polls).toBe(before);
    expect(calls).toBe(1);
    expect(
      next.messages.filter(
        (m) =>
          m.origin === 'runtime' && JSON.stringify(m.content).includes('DURABLE-RECOVERED-OUTPUT'),
      ),
    ).toHaveLength(1);
  } finally {
    await first.registry.stopAll();
    await second.registry.stopAll();
    await third.registry.stopAll();
    for (const c of contexts) {
      await c.flushConversationJournal();
      await c.session.close();
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
