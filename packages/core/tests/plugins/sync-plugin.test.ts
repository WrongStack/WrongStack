import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cloudInstance } = vi.hoisted(() => ({
  cloudInstance: {
    loadState: vi.fn(async () => {}),
    status: vi.fn(async () => 'STATUS-OUTPUT'),
    disable: vi.fn(async () => 'DISABLED-OUTPUT'),
    push: vi.fn(async () => ({ ok: true, message: 'pushed ok' })),
    pull: vi.fn(async () => ({ ok: true, message: 'pulled ok' })),
  },
}));

vi.mock('../../src/storage/cloud-sync.js', async (orig) => ({
  ...(await orig<typeof import('../../src/storage/cloud-sync.js')>()),
  CloudSync: vi.fn(function MockCloudSync() {
    return cloudInstance; // a function (not arrow) so `new CloudSync()` returns the instance
  }),
}));

import { createSyncPlugin } from '../../src/plugins/sync-plugin.js';
import { CloudSync } from '../../src/storage/cloud-sync.js';
import type { Context, SlashCommand } from '../../src/index.js';

let tmp: string;
const ctx = {} as Context;

type CfgGetter = () => Record<string, unknown>;

function build(
  cfgGet: CfgGetter = () => ({}),
  apiConfig: Record<string, unknown> = {},
  withOpts = true,
) {
  const registered: SlashCommand[] = [];
  const warn = vi.fn();
  const configStore = { get: vi.fn(cfgGet), update: vi.fn() };
  const vault = { encrypt: vi.fn((t: string) => `enc:${t}`) };
  const api = {
    config: apiConfig,
    slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
    log: { info: vi.fn(), warn },
  } as never;
  const opts = withOpts
    ? {
        paths: {
          configDir: tmp,
          syncConfig: path.join(tmp, 'sync.json'),
        } as never,
        configStore: configStore as never,
        vault,
      }
    : undefined;
  const plugin = createSyncPlugin(opts);
  plugin.setup!(api);
  return { cmd: registered[0], configStore, vault, warn, registered, plugin, api };
}

/** SlashCommand.run returns void | result; tests always expect the result branch. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runCmd(cmd: SlashCommand | undefined, args: string, c: Context): Promise<any> {
  return cmd!.run!(args, c);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-plugin-'));
  for (const m of Object.values(cloudInstance)) m.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('createSyncPlugin lifecycle', () => {
  it('registers /sync when paths + configStore are available and loads state', () => {
    const { cmd, registered, plugin, api } = build();
    expect(cmd?.name).toBe('sync');
    expect(cloudInstance.loadState).toHaveBeenCalled();
    plugin.teardown!(api);
    expect(registered).toHaveLength(1);
  });

  it('warns and skips registration when paths/configStore are missing', () => {
    const { registered, warn } = build(() => ({}), {}, false);
    expect(registered).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  it('reads paths/configStore/vault from api.config as a fallback', async () => {
    const configStore = { get: vi.fn(() => ({})), update: vi.fn() };
    const registered: SlashCommand[] = [];
    const api = {
      config: {
        paths: { configDir: tmp },
        configStore,
        vault: { encrypt: (t: string) => `enc:${t}` },
      },
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
    createSyncPlugin().setup!(api);
    expect(registered[0]?.name).toBe('sync');
    await runCmd(registered[0], 'enable me/data token prompts', ctx);
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'))).toMatchObject({
      repo: 'me/data',
      githubToken: 'enc:token',
    });
  });

  it('health is ok', async () => {
    expect(await build().plugin.health!()).toMatchObject({ ok: true });
  });

  it('wires the config getter/setter callbacks into CloudSync', async () => {
    const sync = { enabled: true, repo: 'r', githubToken: 't', categories: [] };
    const { configStore } = build(() => ({ activeProfile: 'work', sync }));
    const call = (CloudSync as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    const getCfg = call[1] as () => unknown;
    const setCfg = call[2] as (c: unknown) => Promise<void>;
    const getSettingsPath = call[3] as () => string;
    expect(getCfg()).toBe(sync); // getter returns config.sync
    expect(getSettingsPath()).toBe(path.join(tmp, 'config.json'));
    await setCfg({ ...sync, enabled: false });
    expect(configStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({ enabled: false, githubToken: 't' }),
      }),
    );
    const persisted = JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'));
    expect(persisted).toMatchObject({ enabled: false, githubToken: 'enc:t' });
  });
});

describe('/sync verbs', () => {
  it('status (default and explicit)', async () => {
    const { cmd } = build();
    expect((await runCmd(cmd, '', ctx)).message).toBe('STATUS-OUTPUT');
    expect((await runCmd(cmd, 'status', ctx)).message).toBe('STATUS-OUTPUT');
  });

  it('disable delegates to CloudSync', async () => {
    const { cmd } = build();
    expect((await runCmd(cmd, 'disable', ctx)).message).toBe('DISABLED-OUTPUT');
  });

  it('persists disable changes through the CloudSync setter callback', async () => {
    const sync = {
      enabled: true,
      repo: 'me/data',
      githubToken: 'plain-token',
      categories: ['settings'],
    };
    const { cmd, configStore } = build(() => ({ sync }));
    cloudInstance.disable.mockImplementationOnce(async () => {
      const call = (CloudSync as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
      await (call[2] as (cfg: typeof sync) => Promise<void>)({ ...sync, enabled: false });
      return 'DISABLED-OUTPUT';
    });

    expect((await runCmd(cmd, 'disable', ctx)).message).toBe('DISABLED-OUTPUT');
    expect(configStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({ enabled: false, githubToken: 'plain-token' }),
      }),
    );
    const persisted = JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'));
    expect(persisted).toMatchObject({ enabled: false, githubToken: 'enc:plain-token' });
  });

  it('enable: usage, invalid repo, and success (encrypts + writes + updates)', async () => {
    const { cmd, configStore, vault } = build();
    expect((await runCmd(cmd, 'enable', ctx)).message).toContain('Usage');
    expect((await runCmd(cmd, 'enable badrepo ghp_x', ctx)).message).toContain('Invalid repo');
    expect((await runCmd(cmd, 'enable me/data ghp_x bogus', ctx)).message).toContain(
      'Unknown categories',
    );
    const out = await runCmd(cmd, 'enable me/data ghp_secret memory prompts', ctx);
    expect(out.message).toContain('CloudSync enabled for me/data');
    expect(vault.encrypt).toHaveBeenCalledWith('ghp_secret');
    expect(configStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({
          enabled: true,
          repo: 'me/data',
          githubToken: 'ghp_secret',
        }),
      }),
    );
    // Token is encrypted at rest but remains plaintext in memory for GitHub requests.
    const written = JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8'));
    expect(written.githubToken).toBe('enc:ghp_secret');
    expect(written.categories).toEqual(['memory', 'prompts']);
    expect(cloudInstance.loadState).toHaveBeenCalled();
  });

  it('refuses to enable without secure token storage', async () => {
    const registered: SlashCommand[] = [];
    const configStore = { get: () => ({}), update: vi.fn() };
    const api = {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
    createSyncPlugin({
      paths: { configDir: tmp, syncConfig: path.join(tmp, 'sync.json') } as never,
      configStore: configStore as never,
    }).setup!(api);
    const result = await runCmd(registered[0], 'enable me/data token', ctx);
    expect(result.message).toContain('Secure token storage is unavailable');
    expect(configStore.update).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(tmp, 'sync.json'), 'utf8')).rejects.toThrow();
  });

  it('rejects vault implementations that return plaintext unchanged', async () => {
    const registered: SlashCommand[] = [];
    const configStore = { get: () => ({}), update: vi.fn() };
    const api = {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
    createSyncPlugin({
      paths: { configDir: tmp, syncConfig: path.join(tmp, 'sync.json') } as never,
      configStore: configStore as never,
      vault: { encrypt: (token: string) => token },
    }).setup!(api);

    await expect(runCmd(registered[0], 'enable me/data plain-token', ctx)).rejects.toThrow(
      'Secure token storage failed',
    );
    expect(configStore.update).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(tmp, 'sync.json'), 'utf8')).rejects.toThrow();
  });

  it('fails closed when a persistence callback receives plaintext without a vault', async () => {
    const sync = {
      enabled: true,
      repo: 'me/data',
      githubToken: 'plain-token',
      categories: ['settings'],
    };
    const registered: SlashCommand[] = [];
    const configStore = { get: () => ({ sync }), update: vi.fn() };
    const api = {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
    createSyncPlugin({
      paths: { configDir: tmp, syncConfig: path.join(tmp, 'sync.json') } as never,
      configStore: configStore as never,
    }).setup!(api);
    const call = (CloudSync as never as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;

    await expect((call[2] as (cfg: typeof sync) => Promise<void>)(sync)).rejects.toThrow(
      'refusing to persist a plaintext token',
    );
    expect(configStore.update).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(tmp, 'sync.json'), 'utf8')).rejects.toThrow();
  });

  it('reports successful pushes even when only metadata persistence fails', async () => {
    const sync = { enabled: true, githubToken: 't', repo: 'r', categories: [] };
    const registered: SlashCommand[] = [];
    const configStore = { get: () => ({ sync }), update: vi.fn() };
    const api = {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() },
    } as never;
    createSyncPlugin({
      paths: { configDir: tmp, syncConfig: `${tmp}\0sync.json` } as never,
      configStore: configStore as never,
      vault: { encrypt: (token: string) => `enc:${token}` },
    }).setup!(api);

    const result = await runCmd(registered[0], 'push', ctx);

    expect(result.message).toContain('pushed ok');
    expect(result.message).toContain('metadata persistence failed');
  });

  it('push: not-enabled, no-token, success, and failure', async () => {
    expect(
      (await runCmd(build(() => ({ sync: { enabled: false } })).cmd, 'push', ctx)).message,
    ).toContain('not enabled');
    expect(
      (await runCmd(build(() => ({ sync: { enabled: true } })).cmd, 'push', ctx)).message,
    ).toContain('No GitHub token');

    const ok = build(() => ({
      sync: { enabled: true, githubToken: 't', repo: 'r', categories: [] },
    }));
    expect((await runCmd(ok.cmd, 'push', ctx)).message).toBe('pushed ok');
    expect(ok.configStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        sync: expect.objectContaining({ lastSyncedAt: expect.any(String) }),
      }),
    );

    cloudInstance.push.mockRejectedValueOnce(new Error('network down'));
    expect(
      (await runCmd(build(() => ({ sync: { enabled: true, githubToken: 't' } })).cmd, 'push', ctx))
        .message,
    ).toContain('Push failed: network down');
  });

  it('pull: not-enabled, no-token, success, and failure', async () => {
    expect(
      (await runCmd(build(() => ({ sync: { enabled: false } })).cmd, 'pull', ctx)).message,
    ).toContain('not enabled');
    expect(
      (await runCmd(build(() => ({ sync: { enabled: true } })).cmd, 'pull', ctx)).message,
    ).toContain('No GitHub token');

    const ok = build(() => ({
      sync: { enabled: true, githubToken: 't', repo: 'r', categories: [] },
    }));
    expect((await runCmd(ok.cmd, 'pull', ctx)).message).toBe('pulled ok');

    cloudInstance.pull.mockRejectedValueOnce(new Error('boom'));
    expect(
      (await runCmd(build(() => ({ sync: { enabled: true, githubToken: 't' } })).cmd, 'pull', ctx))
        .message,
    ).toContain('Pull failed: boom');
  });

  it('categories: gated, list, add (unknown/dup/success), remove (missing/success), usage', async () => {
    expect(
      (await runCmd(build(() => ({ sync: { enabled: false } })).cmd, 'categories', ctx)).message,
    ).toContain('not enabled');

    const enabled = (cats: string[]) =>
      build(() => ({ sync: { enabled: true, categories: cats } }));

    expect((await runCmd(enabled(['memory']).cmd, 'categories', ctx)).message).toContain(
      'Synced categories: memory',
    );
    expect((await runCmd(enabled(['memory']).cmd, 'categories list', ctx)).message).toContain(
      'Available:',
    );

    expect((await runCmd(enabled(['memory']).cmd, 'categories add bogus', ctx)).message).toContain(
      'Unknown',
    );
    expect((await runCmd(enabled(['memory']).cmd, 'categories add memory', ctx)).message).toContain(
      'already synced',
    );
    const added = enabled(['memory']);
    expect((await runCmd(added.cmd, 'categories add prompts', ctx)).message).toContain(
      'Added "prompts"',
    );
    expect(added.configStore.update).toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(path.join(tmp, 'sync.json'), 'utf8')).categories).toEqual([
      'memory',
      'prompts',
    ]);

    expect(
      (await runCmd(enabled(['memory']).cmd, 'categories remove prompts', ctx)).message,
    ).toContain('not in sync');
    const removed = enabled(['memory', 'prompts']);
    expect((await runCmd(removed.cmd, 'categories remove prompts', ctx)).message).toContain(
      'Removed "prompts"',
    );

    expect((await runCmd(enabled(['memory']).cmd, 'categories frobnicate', ctx)).message).toContain(
      'Usage',
    );
  });

  it('unknown verb prints the help block', async () => {
    expect((await runCmd(build().cmd, 'xyzzy', ctx)).message).toContain('Cloud Sync');
  });
});
