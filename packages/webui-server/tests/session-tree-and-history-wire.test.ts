import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultSessionStore, SessionTreeCoordinator } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApiSessionTree } from '../src/server/http-server/api-handlers.js';
import { buildInspectPayload, toSessionHistoryEntries } from '../src/server/session-history.js';

function createMockRes(): {
  res: http.ServerResponse;
  getStatus: () => number;
  getBody: () => string;
} {
  let status = 200;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      }
      return this;
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => body,
  };
}

describe('GET /api/sessions/:id/tree and session-history branch metadata', () => {
  let rootDir = '';
  let globalRoot = '';
  let projectRoot = '';

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'wstack-webui-tree-'));
    globalRoot = join(rootDir, 'global');
    projectRoot = join(rootDir, 'project');
    await mkdir(globalRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('reconstructs and returns multi-branch session tree JSON and 404s on missing session', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const store = new DefaultSessionStore({ dir: paths.projectSessions, projectRoot });
    const writer = await store.create({
      id: '',
      model: 'gpt-5',
      provider: 'openai',
      title: 'Tree Demo',
    });
    await writer.append({
      type: 'user_input',
      ts: '2026-11-11T10:00:00.000Z',
      content: 'Initial plan',
    });

    const coordinator = new SessionTreeCoordinator({
      sessionId: writer.id,
      writer,
      getEvents: async () => {
        await writer.flush?.();
        return (await store.load(writer.id)).events;
      },
    });
    await coordinator.createBranch({ name: 'alt-design', label: 'Explore SQLite' });
    await writer.close();

    const okMock = createMockRes();
    await handleApiSessionTree(okMock.res, { globalRoot, projectRoot }, writer.id);
    expect(okMock.getStatus()).toBe(200);
    const parsed = JSON.parse(okMock.getBody()) as {
      sessionId: string;
      tree: { activeBranchId: string; branches: Record<string, { name: string }> };
    };
    expect(parsed.sessionId).toBe(writer.id);
    expect(Object.values(parsed.tree.branches).map((b) => b.name)).toEqual(
      expect.arrayContaining(['main', 'alt-design']),
    );
    expect(parsed.tree.branches[parsed.tree.activeBranchId]?.name).toBe('alt-design');

    const summaries = await store.list(10);
    const wireEntries = toSessionHistoryEntries(summaries, writer.id);
    expect(wireEntries[0]?.branchCount).toBe(2);
    expect(wireEntries[0]?.activeBranchName).toBe('alt-design');

    const loaded = await store.load(writer.id);
    const inspected = buildInspectPayload(summaries[0], loaded.events, {
      id: writer.id,
      title: 'Tree Demo',
      model: 'gpt-5',
      provider: 'openai',
      startedAt: '2026-11-11T10:00:00.000Z',
    });
    expect(inspected.events.some((ev) => ev.type === 'branch_created')).toBe(true);

    const notFoundMock = createMockRes();
    await handleApiSessionTree(
      notFoundMock.res,
      { globalRoot, projectRoot },
      '2099-01-01/does-not-exist',
    );
    expect(notFoundMock.getStatus()).toBe(404);
  });

  it('invalidates cached commands & broadcasts command.catalog on plugin.reloaded, and emits file.activity on workspace.files_materialized', async () => {
    const { EventBus } = await import('@wrongstack/contracts/kernel');
    const { SlashCommandRegistry } = await import('@wrongstack/core/registry');
    const { portableCommandRoute } = await import('../src/server/portable-command-route.js');
    const { setupWebUICodebaseIndexing } = await import('../src/server/codebase-indexing.js');
    const typeWs = {} as never;

    const events = new EventBus();
    const pluginSlashRegistry = new SlashCommandRegistry();
    pluginSlashRegistry.register(
      {
        name: 'hello',
        description: 'v1 command',
        run: async () => ({ message: 'v1' }),
      },
      'demo-ext',
    );

    const broadcasted: unknown[] = [];
    const route = portableCommandRoute({
      getSessionStore: () => undefined,
      getProjectRoot: () => projectRoot,
      getContext: () => ({}),
      getConfigStore: () => undefined,
      events,
      pluginSlashRegistry,
      broadcast: (msg) => broadcasted.push(msg),
      send: () => undefined,
    });

    const initialCommands = await route.getCommands();
    expect(initialCommands.some((c) => c.name === 'demo-ext:hello')).toBe(true);
    expect(initialCommands.some((c) => c.name === 'demo-ext:v2')).toBe(false);

    // Hot-reload adds a new external plugin command and emits `plugin.reloaded`
    pluginSlashRegistry.register(
      {
        name: 'v2',
        description: 'v2 command',
        run: async () => ({ message: 'v2' }),
      },
      'demo-ext',
    );
    events.emit('plugin.reloaded', {
      name: 'demo-ext',
      durationMs: 3,
    });

    const refreshedCommands = await route.getCommands();
    expect(refreshedCommands.some((c) => c.name === 'demo-ext:v2')).toBe(true);
    // Allow microtask broadcast to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(
      broadcasted.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string }).type === 'command.catalog',
      ),
    ).toBe(true);
    void typeWs;

    // Verify `setupWebUICodebaseIndexing` translates `workspace.files_materialized` into `file.activity`
    const fileActivities: Array<{ filePath: string; operation: string }> = [];
    events.on('file.activity', (ev) => {
      fileActivities.push({ filePath: ev.filePath, operation: ev.operation });
    });
    const indexing = setupWebUICodebaseIndexing({
      config: {},
      context: { meta: {}, signal: new AbortController().signal } as never,
      projectRoot,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
      events,
    });

    events.emit('workspace.files_materialized', {
      sessionId: 'sess-mat',
      branchId: 'br-2',
      targetRoot: projectRoot,
      writtenFiles: ['src/restored.ts'],
      deletedFiles: ['src/removed.ts'],
      manifestHash: 'abc123',
      at: Date.now(),
    });

    expect(fileActivities).toEqual([
      { filePath: join(projectRoot, 'src', 'restored.ts'), operation: 'write' },
      { filePath: join(projectRoot, 'src', 'removed.ts'), operation: 'delete' },
    ]);
    indexing.dispose();
  });
});
