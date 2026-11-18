import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { withFileLock } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudConfigSyncPlugin } from '../src/cloud-config-sync-plugin.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const VALID_TOKEN = `wst_${'c'.repeat(43)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('createCloudConfigSyncPlugin teardown & reload ownership fence (F531)', () => {
  it('prevents in-flight /cloudsync commands and sync passes from leaking timers, writing config, or mutating configStore after teardown/reload', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudsync-teardown-f531-'));
    dirs.push(tmp);

    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const liveTimers = new Set<ReturnType<typeof setInterval>>();
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const handle = origSetInterval(...args);
      liveTimers.add(handle);
      return handle;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      handle?: Parameters<typeof clearInterval>[0],
    ) => {
      if (handle !== undefined) liveTimers.delete(handle as ReturnType<typeof setInterval>);
      return origClearInterval(handle);
    }) as typeof clearInterval);

    const vault = {
      encrypt: (v: string) => `enc:${Buffer.from(v).toString('base64')}`,
      decrypt: (v: string) => Buffer.from(v.replace(/^enc:/, ''), 'base64').toString(),
    };

    try {
      // 1. Gated writeLocalConfig lock across teardown() neither writes disk/store, leaks timers, nor fetches.
      const dir1 = path.join(tmp, 'case-1');
      await fs.mkdir(dir1, { recursive: true });
      const cfgPath1 = path.join(dir1, 'config.json');
      let cfg1: Record<string, unknown> = {
        uiLocale: 'tr',
        cloudSync: { enabled: false, url: 'https://portal.test', token: VALID_TOKEN },
      };
      await fs.writeFile(cfgPath1, JSON.stringify(cfg1), 'utf8');

      let tornDown1 = false;
      let fetchesAfterTeardown1 = 0;
      let storeUpdatesAfterTeardown1 = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
        if (tornDown1) fetchesAfterTeardown1 += 1;
        return jsonResponse({ cursor: 1, full: false, changed: [] });
      }) as typeof fetch);

      let cmd1: SlashCommand | undefined;
      const api1 = {
        config: {},
        slashCommands: { register: (c: SlashCommand) => (cmd1 = c), unregister: () => {} },
        log: { info: () => {}, warn: () => {} },
      } as never;
      const plugin1 = createCloudConfigSyncPlugin({
        paths: { configDir: dir1, globalRoot: tmp } as never,
        configStore: {
          get: () => cfg1,
          update: (next: Record<string, unknown>) => {
            if (tornDown1) storeUpdatesAfterTeardown1 += 1;
            cfg1 = { ...cfg1, ...next };
          },
        } as never,
        vault: vault as never,
      });
      plugin1.setup?.(api1);

      const lockEntered = deferred<void>();
      const releaseLock = deferred<void>();
      const holdLock = withFileLock(cfgPath1, async () => {
        lockEntered.resolve();
        await releaseLock.promise;
      });
      await lockEntered.promise;

      const pendingOn = cmd1!.run('on', {} as never);
      plugin1.teardown?.(api1);
      tornDown1 = true;
      releaseLock.resolve();
      await holdLock;
      await pendingOn;

      expect(liveTimers.size).toBe(0);
      expect(fetchesAfterTeardown1).toBe(0);
      expect(storeUpdatesAfterTeardown1).toBe(0);
      const disk1 = JSON.parse(await fs.readFile(cfgPath1, 'utf8')) as {
        cloudSync?: { enabled?: boolean };
      };
      expect(disk1.cloudSync?.enabled).toBe(false);

      // 2. In-flight syncOnce() across teardown() + re-setup() does not clobber gen2 passRunning or config.
      const dir2 = path.join(tmp, 'case-2');
      await fs.mkdir(dir2, { recursive: true });
      const cfgPath2 = path.join(dir2, 'config.json');
      let cfg2: Record<string, unknown> = {
        uiLocale: 'tr',
        cloudSync: { enabled: true, url: 'https://portal.test', token: VALID_TOKEN },
      };
      await fs.writeFile(cfgPath2, JSON.stringify(cfg2), 'utf8');

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockImplementation((async (...args: Parameters<typeof fetch>) => {
        const u = String(args[0]);
        const method = args[1]?.method ?? 'GET';
        if (u.includes('/api/sync/v1/config?')) {
          return jsonResponse({ cursor: 1, full: false, changed: [] });
        }
        if (method === 'PUT') {
          return jsonResponse({ revision: 1, cursor: 1 });
        }
        return jsonResponse({ ok: true });
      }) as typeof fetch);

      let cmd2: SlashCommand | undefined;
      const api2 = {
        config: {},
        slashCommands: { register: (c: SlashCommand) => (cmd2 = c), unregister: () => {} },
        log: { info: () => {}, warn: () => {} },
      } as never;
      const plugin2 = createCloudConfigSyncPlugin({
        paths: { configDir: dir2, globalRoot: tmp } as never,
        configStore: {
          get: () => cfg2,
          update: (next: Record<string, unknown>) => {
            cfg2 = { ...cfg2, ...next };
          },
        } as never,
        vault: vault as never,
      });
      plugin2.setup?.(api2);
      await cmd2!.run('now', {} as never);

      const gen1SnapshotStarted = deferred<void>();
      const gen1ReleaseSnapshot = deferred<Response>();
      fetchSpy.mockImplementation((async (...args: Parameters<typeof fetch>) => {
        const u = String(args[0]);
        const method = args[1]?.method ?? 'GET';
        if (u.includes('/api/sync/v1/config?')) {
          return jsonResponse({
            cursor: 2,
            full: false,
            changed: [{ namespace: 'ui.preferences', revision: 2 }],
          });
        }
        if (method === 'GET' && u.endsWith('/api/sync/v1/config/ui.preferences')) {
          gen1SnapshotStarted.resolve();
          return gen1ReleaseSnapshot.promise;
        }
        return jsonResponse({ ok: true });
      }) as typeof fetch);

      const gen1Cmd = cmd2!;
      const gen1Pass = gen1Cmd.run('now', {} as never);
      await gen1SnapshotStarted.promise;

      plugin2.teardown?.(api2);
      fetchSpy.mockImplementation((async (...args: Parameters<typeof fetch>) => {
        const u = String(args[0]);
        if (u.includes('/api/sync/v1/config?')) {
          return jsonResponse({ cursor: 2, full: false, changed: [] });
        }
        return jsonResponse({ ok: true });
      }) as typeof fetch);
      plugin2.setup?.(api2);
      const gen2Cmd = cmd2!;

      const gen2Out = (await gen2Cmd.run('now', {} as never)) as { message: string };
      expect(gen2Out.message).not.toBe('A sync pass is already running.');

      gen1ReleaseSnapshot.resolve(
        jsonResponse({
          namespace: 'ui.preferences',
          revision: 2,
          schemaVersion: 1,
          payload: { uiLocale: 'stale-from-gen1' },
        }),
      );
      await gen1Pass;

      expect(cfg2.uiLocale).toBe('tr');
      const disk2 = JSON.parse(await fs.readFile(cfgPath2, 'utf8')) as { uiLocale?: string };
      expect(disk2.uiLocale).toBe('tr');

      plugin2.teardown?.(api2);
      expect(liveTimers.size).toBe(0);
    } finally {
      for (const t of [...liveTimers]) origClearInterval(t);
    }
  });
});
