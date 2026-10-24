import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  afterOpen: undefined as (() => Promise<void>) | undefined,
  duringWrite: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      if (String(args[0]).includes('.checkpoint-') && io.duringWrite) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          await write('partial temporary content');
          io.duringWrite?.();
        };
      } else if (io.afterOpen) {
        await io.afterOpen();
      }
      return handle;
    },
  };
});

import { removeProjectFixtureDirectory } from '../../core/tests/helpers/project-server-harness.js';
import plugin from '../src/checkpoint/index.js';

let root: string;
const cleanup: Array<() => unknown> = [];
beforeEach(async () => {
  io.afterOpen = undefined;
  io.duringWrite = undefined;
  root = await fs.mkdtemp(join(tmpdir(), 'checkpoint-isolation-'));
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
  await removeProjectFixtureDirectory(root, { maxRetries: 3, retryDelay: 100 });
});
function host(config: Record<string, unknown> = {}) {
  const tools = new Map<string, Tool>();
  const listeners = new Set<(event?: { id?: string }) => void>();
  let hook!: (input: unknown, runtime?: { signal: AbortSignal }) => Promise<unknown>;
  const api = {
    config: { cwd: root, extensions: { checkpoint: config } },
    tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
    log: { info() {}, warn() {}, error() {} },
    metrics: { counter() {} },
    registerHook: (_event: string, _matcher: string, fn: typeof hook) => {
      hook = fn;
      return () => {};
    },
    onEvent: (_event: string, listener: (event?: { id?: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as PluginAPI;
  plugin.setup(api);
  cleanup.push(() => plugin.teardown?.(api));
  return {
    api,
    listeners,
    hook,
    call(
      name: string,
      input: unknown = {},
      session = 'A',
      projectRoot = root,
      signal = new AbortController().signal,
    ) {
      return tools
        .get(name)!
        .execute(input, { cwd: projectRoot, projectRoot, session: { id: session } } as never, {
          signal,
        }) as Promise<Record<string, unknown>>;
    },
  };
}
function legacyRoot() {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
}

describe('checkpoint ownership and restore boundaries', () => {
  it('keeps the retained-byte budget shared across sessions of one host', async () => {
    const loaded = host({ maxTotalBytes: 1024 });
    await fs.writeFile(join(root, 'a.txt'), 'a'.repeat(700));
    await loaded.call('checkpoint_create', { paths: ['a.txt'] }, 'A');
    await loaded.call('checkpoint_create', { paths: ['a.txt'] }, 'B');
    expect(await loaded.call('checkpoint_list', {}, 'A')).toMatchObject({
      total: 0,
      counters: { evictedForBytes: 1 },
    });
    expect(await loaded.call('checkpoint_list', {}, 'B')).toMatchObject({
      total: 1,
      counters: { retainedBytes: 700 },
    });
  });
  it.each(['write-error', 'cancel'] as const)(
    'leaves the original intact after a partial temporary write: %s',
    async (failure) => {
      await fs.writeFile(join(root, 'a.txt'), 'snapshot');
      const loaded = host();
      await loaded.call('checkpoint_create', { paths: ['a.txt'] });
      await fs.writeFile(join(root, 'a.txt'), 'current must survive');
      const controller = new AbortController();
      io.duringWrite = () => {
        if (failure === 'cancel') controller.abort();
        else throw new Error('disk full');
      };
      await expect(
        loaded.call('checkpoint_restore', {}, 'A', root, controller.signal),
      ).rejects.toThrow();
      expect(await fs.readFile(join(root, 'a.txt'), 'utf8')).toBe('current must survive');
      expect(await fs.readdir(root)).toEqual(['a.txt']);
    },
  );
  it.each(['session-end', 'reload'] as const)(
    'cannot publish a pending capture after %s',
    async (action) => {
      await fs.writeFile(join(root, 'a.txt'), 'snapshot');
      const loaded = host();
      let opened!: () => void;
      const ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      io.afterOpen = async () => {
        opened();
        await waiting;
      };
      const capture = loaded.call('checkpoint_create', { paths: ['a.txt'] });
      const assertion = expect(capture).rejects.toThrow();
      await ready;
      if (action === 'session-end') for (const listener of loaded.listeners) listener({ id: 'A' });
      else await plugin.setup(loaded.api);
      finish();
      await assertion;
      expect(await loaded.call('checkpoint_list')).toMatchObject({ total: 0 });
    },
  );
  it('accepts a project accessed through a directory junction', async () => {
    const project = join(root, 'real');
    const alias = join(root, 'alias');
    await fs.mkdir(project);
    await fs.writeFile(join(project, 'a.txt'), 'original');
    await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const loaded = host();
    await loaded.call('checkpoint_create', { paths: [join(alias, 'a.txt')] }, 'A', alias);
    expect(await loaded.call('checkpoint_list', {}, 'A', project)).toMatchObject({ total: 1 });
  });
  it('uses the calling project without changing process cwd', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'original');
    const loaded = host();
    const created = await loaded.call('checkpoint_create', { paths: ['a.txt'] });
    expect(created).toMatchObject({
      capturedFiles: [{ path: join(root, 'a.txt'), existed: true }],
    });
    await fs.writeFile(join(root, 'a.txt'), 'edited');
    await loaded.call('checkpoint_restore', {});
    expect(await fs.readFile(join(root, 'a.txt'), 'utf8')).toBe('original');
  });
  it('does not lose or expose another host snapshot', async () => {
    legacyRoot();
    await fs.writeFile(join(root, 'a.txt'), 'original');
    const first = host();
    await first.call('checkpoint_create', { paths: ['a.txt'] });
    const second = host();
    expect(await first.call('checkpoint_list')).toMatchObject({ total: 1 });
    expect(await second.call('checkpoint_list')).toMatchObject({ total: 0 });
    await plugin.teardown?.(second.api);
    expect(await first.call('checkpoint_list')).toMatchObject({ total: 1 });
  });
  it('isolates overlapping sessions and only clears the session that ended', async () => {
    legacyRoot();
    const loaded = host();
    await fs.writeFile(join(root, 'a.txt'), 'A');
    const first = await loaded.call('checkpoint_create', { paths: ['a.txt'] }, 'A');
    await fs.writeFile(join(root, 'a.txt'), 'B');
    const second = await loaded.call('checkpoint_create', { paths: ['a.txt'] }, 'B');
    expect(await loaded.call('checkpoint_list', {}, 'B')).toMatchObject({ total: 1 });
    await expect(loaded.call('checkpoint_restore', { id: first.id }, 'B')).rejects.toThrow(
      /no snapshot/,
    );
    for (const listener of loaded.listeners) listener({ id: 'A' });
    expect(await loaded.call('checkpoint_list', {}, 'A')).toMatchObject({ total: 0 });
    expect(await loaded.call('checkpoint_list', {}, 'B')).toMatchObject({
      total: 1,
      snapshots: [{ id: second.id }],
    });
  });
  it('keeps projects separate within the same session', async () => {
    legacyRoot();
    const other = join(root, 'other');
    await fs.mkdir(other);
    await fs.writeFile(join(root, 'a.txt'), 'root');
    await fs.writeFile(join(other, 'a.txt'), 'other');
    const loaded = host();
    await loaded.call('checkpoint_create', { paths: ['a.txt'] });
    expect(await loaded.call('checkpoint_list', {}, 'A', other)).toMatchObject({ total: 0 });
  });
  it('uses hook session/project identity for snapshots visible to that session', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'original');
    const loaded = host();
    await loaded.hook({
      toolName: 'write',
      toolInput: { path: 'a.txt' },
      cwd: root,
      sessionId: 'A',
    });
    expect(await loaded.call('checkpoint_list', {}, 'A')).toMatchObject({
      total: 1,
      snapshots: [{ files: [{ path: join(root, 'a.txt'), existed: true }] }],
    });
    expect(await loaded.call('checkpoint_list', {}, 'B')).toMatchObject({ total: 0 });
  });
  it('does not write when restoration is already cancelled', async () => {
    legacyRoot();
    await fs.writeFile(join(root, 'a.txt'), 'original');
    const loaded = host();
    await loaded.call('checkpoint_create', { paths: ['a.txt'] });
    await fs.writeFile(join(root, 'a.txt'), 'edited');
    await expect(
      loaded.call('checkpoint_restore', {}, 'A', root, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(await fs.readFile(join(root, 'a.txt'), 'utf8')).toBe('edited');
  });
  it('does not recreate snapshots through a retained tool after teardown', async () => {
    legacyRoot();
    const loaded = host();
    await plugin.teardown?.(loaded.api);
    await expect(loaded.call('checkpoint_create', { paths: ['a.txt'] })).rejects.toThrow();
    expect(loaded.listeners.size).toBe(0);
  });
  it('preserves binary bytes instead of replacing invalid UTF-8 sequences', async () => {
    legacyRoot();
    const bytes = Buffer.from([0, 255, 254, 128, 65, 10]);
    await fs.writeFile(join(root, 'binary.dat'), bytes);
    const loaded = host();
    await loaded.call('checkpoint_create', { paths: ['binary.dat'] });
    await fs.writeFile(join(root, 'binary.dat'), 'edited');
    await loaded.call('checkpoint_restore', {});
    expect(await fs.readFile(join(root, 'binary.dat'))).toEqual(bytes);
  });
  it('preflights all restore paths and rejects an ancestor replaced by an outside junction', async () => {
    legacyRoot();
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    await fs.mkdir(join(project, 'child'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(join(project, 'a.txt'), 'original');
    await fs.writeFile(join(project, 'child', 'b.txt'), 'snapshot');
    await fs.writeFile(join(outside, 'b.txt'), 'outside must survive');
    // Both implementations can capture initially; only the restore path is attacked.
    vi.mocked(process.cwd).mockReturnValue(project);
    const loaded = host();
    await loaded.call('checkpoint_create', { paths: ['a.txt', 'child/b.txt'] }, 'A', project);
    await fs.writeFile(join(project, 'a.txt'), 'edited');
    await fs.rm(join(project, 'child'), { recursive: true });
    await fs.symlink(
      outside,
      join(project, 'child'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(loaded.call('checkpoint_restore', {}, 'A', project)).rejects.toThrow();
    expect(await fs.readFile(join(outside, 'b.txt'), 'utf8')).toBe('outside must survive');
    expect(await fs.readFile(join(project, 'a.txt'), 'utf8')).toBe('edited');
  });
});
