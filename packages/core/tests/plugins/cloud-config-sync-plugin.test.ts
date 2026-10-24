import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CloudSyncConfig } from '@wrongstack/contracts/types/config';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudConfigSyncPlugin } from '../../src/plugins/cloud-config-sync-plugin.js';

const VALID_TOKEN = `wst_${'a'.repeat(43)}`;

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-sync-plugin-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function setup(initial?: CloudSyncConfig) {
  let config: Record<string, unknown> = initial ? { cloudSync: initial } : {};
  const configStore = {
    get: () => config,
    update: vi.fn((patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    }),
  };
  const vault = {
    encrypt: (value: string) => `enc:${Buffer.from(value).toString('base64')}`,
    decrypt: (value: string) => Buffer.from(value.replace(/^enc:/, ''), 'base64').toString(),
  };
  const registered: SlashCommand[] = [];
  const unregister = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    config: {},
    slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister },
    log,
  } as never;
  const plugin = createCloudConfigSyncPlugin({
    paths: { configDir: tmp } as never,
    configStore: configStore as never,
    vault: vault as never,
    appVersion: '0.0.0-test',
  });
  const run = (args: string) => {
    const cmd = registered.find((c) => c.name === 'cloudsync');
    if (!cmd) throw new Error('cloudsync not registered');
    return cmd.run(args, {} as never) as Promise<{ message: string }>;
  };
  return { plugin, api, configStore, registered, unregister, log, run };
}

describe('createCloudConfigSyncPlugin', () => {
  it('disables itself with a warning when dependencies are missing', () => {
    const registered: SlashCommand[] = [];
    const warn = vi.fn();
    const plugin = createCloudConfigSyncPlugin();
    plugin.setup?.({
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
      log: { info: vi.fn(), warn },
    } as never);
    expect(registered).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/cloudsync disabled'));
  });

  it('registers /cloudsync and unregisters it on teardown', () => {
    const { plugin, api, registered, unregister } = setup();
    plugin.setup?.(api);
    expect(registered.map((c) => c.name)).toEqual(['cloudsync']);
    plugin.teardown?.(api);
    expect(unregister).toHaveBeenCalledWith('cloudsync');
  });

  it('does not schedule a background loop while disabled', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { plugin, api } = setup({ enabled: false, url: 'https://x', token: VALID_TOKEN });
    plugin.setup?.(api);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    plugin.teardown?.(api);
  });

  it.each([
    [undefined, 300_000],
    [120, 120_000],
    [5, 60_000],
    [Number.NaN, 300_000],
    [Number.POSITIVE_INFINITY, 300_000],
    ['5m', 300_000],
    // Past 2^31-1 ms Node fires every 1 ms: a monthly sync hammered the portal.
    [2_592_000, 2_147_483_000],
    [1e12, 2_147_483_000],
  ])('schedules intervalSeconds=%j at %dms', (intervalSeconds, expectedMs) => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { plugin, api } = setup({
      enabled: true,
      url: 'https://portal.test',
      token: VALID_TOKEN,
      intervalSeconds: intervalSeconds as number,
    });
    plugin.setup?.(api);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(expectedMs);
    plugin.teardown?.(api);
  });

  it('refuses to enable before url and token are set', async () => {
    const { plugin, api, run } = setup();
    plugin.setup?.(api);
    const result = await run('on');
    expect(result.message).toContain('Set the portal first');
  });

  it('validates set url and strips trailing slashes from the stored and reported value', async () => {
    const { plugin, api, run, configStore } = setup();
    plugin.setup?.(api);
    expect((await run('set url ftp://nope')).message).toContain('Usage: /cloudsync set url');
    const ok = await run('set url https://portal.test///');
    expect(ok.message).toBe('Portal URL set to https://portal.test.');
    expect((configStore.get().cloudSync as CloudSyncConfig).url).toBe('https://portal.test');
  });

  it('encrypts the machine token at rest and rejects malformed tokens', async () => {
    const { plugin, api, run } = setup();
    plugin.setup?.(api);
    expect((await run('set token wst_short')).message).toContain('does not look like');
    expect((await run(`set token ${VALID_TOKEN}x`)).message).toContain('does not look like');
    expect((await run(`set token ${VALID_TOKEN}`)).message).toContain('encrypted at rest');
    const onDisk = await fs.readFile(path.join(tmp, 'config.json'), 'utf8');
    expect(onDisk).not.toContain(VALID_TOKEN.slice(4));
  });

  it('validates set interval against the 60s floor', async () => {
    const { plugin, api, run, configStore } = setup();
    plugin.setup?.(api);
    expect((await run('set interval 59')).message).toContain('seconds ≥ 60');
    expect((await run('set interval abc')).message).toContain('seconds ≥ 60');
    expect((await run('set interval 90')).message).toBe('Sync interval set to 90s.');
    expect((configStore.get().cloudSync as CloudSyncConfig).intervalSeconds).toBe(90);
    expect((await run('set bogus 1')).message).toBe(
      'Usage: /cloudsync set url|token|interval <value>',
    );
  });

  it('reports status, disables, runs a skipped pass and prints help for unknown verbs', async () => {
    const { plugin, api, run, configStore } = setup();
    plugin.setup?.(api);
    expect((await run('')).message).toContain('disabled');
    expect((await run('status')).message).toContain('disabled');
    expect((await run('now')).message).toBe('Cloud sync is not configured.');
    expect((await run('off')).message).toContain('disabled');
    expect((configStore.get().cloudSync as CloudSyncConfig).enabled).toBe(false);
    expect((await run('wat')).message).toContain('/cloudsync — my.wrongstack.com config sync');
  });

  it('enables, persists and immediately runs a pass once configured', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    // The first pass talks to the portal; stub fetch so the pass fails fast
    // and is summarized rather than escaping the command. The sync engine
    // captures `fetch` at construction, so the stub must precede setup().
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const { plugin, api, run } = setup();
    plugin.setup?.(api);
    await run('set url https://portal.test');
    await run(`set token ${VALID_TOKEN}`);
    const result = await run('on');
    expect(result.message).toMatch(/^Cloud config sync enabled\.\n/);
    expect(result.message).toContain('network down');
    expect(fetchSpy).toHaveBeenCalled();
    expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 300_000)).toHaveLength(1);
    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, 'config.json'), 'utf8'));
    expect(onDisk.cloudSync.enabled).toBe(true);
    plugin.teardown?.(api);
  });
});
