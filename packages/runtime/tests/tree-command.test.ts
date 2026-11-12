import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Message } from '@wrongstack/contracts/types';
import { DefaultSessionStore, SessionTreeCoordinator } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('wires LLM fold synthesis, config.session.branchFoldMaxTokens, and SAGE onFoldInsight memory promotion', async () => {
    const store = new DefaultSessionStore({ dir: tmpDir });
    const writer = await store.create({ id: '', model: 'claude-sonnet', provider: 'anthropic' });
    const liveMessages: Message[] = [];
    const remembered: Array<{ text: string; scope?: string; metadata?: Record<string, unknown> }> =
      [];
    const llmPrompts: string[] = [];

    await writer.append({
      type: 'user_input',
      ts: '2026-11-12T10:00:00.000Z',
      content: 'Investigate lock contention',
    });

    const cmd = buildTreeCommand({
      sessionStore: store,
      sessionRef: { current: writer },
      context: {
        session: writer,
        messages: liveMessages,
      },
      configStore: {
        get: () => ({
          version: 1,
          provider: 'anthropic',
          model: 'claude-sonnet',
          session: { branchFoldMaxTokens: 25 },
          features: {
            mcp: false,
            plugins: false,
            memory: true,
            sageBranchInsights: true,
            modelsRegistry: false,
            skills: false,
          },
        }),
        update: () => {},
        replace: () => {},
        watch: () => () => {},
      } as never,
      llmProvider: {
        id: 'anthropic',
        capabilities: {} as never,
        async *stream() {},
        async complete(req) {
          const userMsg = req.messages[0]?.content;
          llmPrompts.push(JSON.stringify(userMsg));
          return {
            model: req.model,
            stopReason: 'end_turn',
            usage: { input: 10, output: 10 },
            content: [
              {
                type: 'text',
                text: `LLM-SYNTHESIZED INSIGHT: Redis Lua script eliminated lock contention across all worker queues. ${'extra padding '.repeat(30)}`,
              },
            ],
          };
        },
      },
      llmModel: 'claude-sonnet',
      memoryStore: {
        remember: async (text: string, scope?: string, metadata?: unknown) => {
          remembered.push({
            text,
            ...(scope ? { scope } : {}),
            ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
          });
        },
      } as never,
    });

    await cmd.run('branch spike-lua');
    await writer.append({
      type: 'user_input',
      ts: '2026-11-12T10:01:00.000Z',
      content: 'Test atomic evalsha script in packages/core/src/lock.ts',
    });

    const foldOut = await cmd.run(
      'fold spike-lua --into main --focus "Lock contention root cause"',
    );
    expect(foldOut?.message).toContain('Folded branch');
    expect(llmPrompts).toHaveLength(1);
    expect(llmPrompts[0]).toContain('Lock contention root cause');

    // Token cap (25 tokens ≈ 100 chars) enforced on LLM output
    expect(remembered).toHaveLength(1);
    expect(remembered[0]?.scope).toBe('project-memory');
    expect(remembered[0]?.text).toContain('LLM-SYNTHESIZED INSIGHT');
    expect(remembered[0]?.metadata?.['tags']).toEqual(
      expect.arrayContaining(['branch-fold', 'spike-lua']),
    );

    await writer.flush?.();
    const persisted = await store.load(writer.id);
    const foldEvent = persisted.events.find((e) => e.type === 'branch_folded') as
      | { sageMemoryIds?: readonly string[] }
      | undefined;
    expect(foldEvent?.sageMemoryIds?.[0]).toMatch(new RegExp(`^sage:${writer.id}:br_`));

    await writer.close();
  });

  it('clears Context file-tracking on branch switch and surfaces ResumeValidation stale-file notice with --keep-files', async () => {
    const projectRoot = path.join(tmpDir, 'proj');
    const sessionsDir = path.join(tmpDir, 'sessions');
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    const observedPath = path.join(projectRoot, 'src', 'config.ts');
    const v1Content = 'export const PORT = 3000;\n';
    await fs.writeFile(observedPath, v1Content, 'utf8');
    const v1Hash = createHash('sha256').update(v1Content, 'utf8').digest('hex');

    const store = new DefaultSessionStore({ dir: sessionsDir });
    const writer = await store.create({
      id: 'sess_tree_stale_1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      checkout: projectRoot,
    });
    await writer.append({
      type: 'file_observation',
      ts: '2026-11-12T11:00:00.000Z',
      path: 'src/config.ts',
      source: 'user',
      mtimeMs: 1_700_000_000_000,
      hash: v1Hash,
    });

    const clearFileTracking = vi.fn();
    const messages: Message[] = [];
    const cmd = buildTreeCommand({
      sessionStore: store,
      sessionRef: { current: writer },
      projectRoot,
      context: {
        session: { id: writer.id },
        messages,
        clearFileTracking,
      },
    });

    await cmd.run('branch spike-port');
    expect(clearFileTracking).toHaveBeenCalledTimes(1);

    // Mutate src/config.ts on spike-port, then switch back to main with --keep-files so disk stays mutated
    await fs.writeFile(observedPath, 'export const PORT = 9090;\n', 'utf8');
    const switchOut = await cmd.run('switch main --keep-files');
    expect(clearFileTracking).toHaveBeenCalledTimes(2);
    expect(switchOut?.message).toContain('[SESSION RESUME FILE VALIDATION]');
    expect(switchOut?.message).toMatch(/src[/\\]+config\.ts.*\[modified\]/);

    await writer.close();
  });
});
