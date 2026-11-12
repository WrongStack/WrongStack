import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from '@wrongstack/contracts/types';
import { DefaultSessionStore, SessionTreeCoordinator } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTreeCommand, tokenizeTreeArgs } from '../src/commands.js';

describe('/tree portable slash command', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tree-cmd-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('tokenizes quoted arguments cleanly', () => {
    expect(
      tokenizeTreeArgs('branch try-redis --at 2 --label "Explore Redis Streams" --no-switch'),
    ).toEqual([
      'branch',
      'try-redis',
      '--at',
      '2',
      '--label',
      'Explore Redis Streams',
      '--no-switch',
    ]);
  });

  it('executes list, branch, switch, rename, fold, and archive subcommands end-to-end', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const writer = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const liveMessages: Message[] = [];

    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
      onMessagesReplaced: (msgs) => {
        liveMessages.splice(0, liveMessages.length, ...msgs);
      },
    });

    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T12:00:00.000Z',
      content: 'Design cache layer',
    });

    const cmd = buildTreeCommand({ treeCoordinator: coordinator });

    const created = await cmd.run('branch try-redis --label "Redis prototype"');
    expect(created?.message).toContain('Created and switched to branch');
    expect(created?.message).toContain('try-redis');

    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T12:01:00.000Z',
      content: 'Benchmark Redis Lua scripts',
    });

    const renamed = await cmd.run('rename try-redis redis-lua');
    expect(renamed?.message).toContain('redis-lua');

    const listed = await cmd.run('list');
    expect(listed?.message).toContain('Session Tree (2 branches · active: redis-lua)');
    expect(listed?.message).toContain('redis-lua');

    const folded = await cmd.run('fold redis-lua --into main --focus "Lua latency"');
    expect(folded?.message).toContain('Folded branch');
    expect(
      liveMessages.some((m) => String(m.content).includes('[Branch Fold-Back: redis-lua]')),
    ).toBe(true);

    const archived = await cmd.run('archive redis-lua');
    expect(archived?.message).toContain('Archived branch');

    const jsonRes = await cmd.run('list --json');
    const parsed = JSON.parse(jsonRes?.message ?? '{}') as {
      activeBranchId: string;
      branches: Record<string, { name: string; status: string }>;
    };
    expect(parsed.activeBranchId).toBe('main');
    expect(
      Object.values(parsed.branches).some((b) => b.name === 'redis-lua' && b.status === 'archived'),
    ).toBe(true);

    await writer.close();
  });

  it('resolves per-call callCtx session writer for multi-tab WebUI and multi-session ACP hosts', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const writerA = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });
    const writerB = await store.create({ id: '', model: 'gpt-5', provider: 'openai' });

    const cmd = buildTreeCommand({
      sessionStore: store,
      sessionRef: { current: writerA },
    });

    await cmd.run('branch tab-b-branch', {
      session: writerB,
      messages: [],
    } as never);

    const listA = JSON.parse(
      (await cmd.run('list --json', { session: writerA } as never))?.message ?? '{}',
    ) as {
      branches: Record<string, { name: string }>;
    };
    const listB = JSON.parse(
      (await cmd.run('list --json', { session: writerB } as never))?.message ?? '{}',
    ) as {
      branches: Record<string, { name: string }>;
    };

    expect(Object.values(listA.branches).map((b) => b.name)).toEqual(['main']);
    expect(Object.values(listB.branches).map((b) => b.name)).toEqual(
      expect.arrayContaining(['main', 'tab-b-branch']),
    );

    await writerA.close();
    await writerB.close();
  });
});
