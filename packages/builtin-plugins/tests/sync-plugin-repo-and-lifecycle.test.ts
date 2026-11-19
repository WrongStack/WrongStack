import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/contracts/types/slash-command';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncPlugin } from '../src/sync-plugin.js';

describe('sync-plugin repo validation, error handling, and health lifecycle', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-plugin-sec-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('rejects malformed or traversal owner/repo inputs and handles vault failures without throwing', async () => {
    const registered: SlashCommand[] = [];
    let storedSync: unknown = null;
    const configStore = {
      get: () => ({ sync: storedSync }),
      update: (patch: { sync?: unknown }) => {
        if ('sync' in patch) storedSync = patch.sync;
      },
    };
    let failEncrypt = false;
    const vault = {
      encrypt: (t: string) => {
        if (failEncrypt) throw new Error('vault locked');
        return `enc:${t}`;
      },
    };
    const api = {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: () => {} },
      log: { info: () => {}, warn: () => {} },
    } as never;

    const plugin = createSyncPlugin({
      paths: { configDir: tmp, syncConfig: path.join(tmp, 'sync.json') } as never,
      configStore: configStore as never,
      vault,
    });
    expect((await plugin.health!()).ok).toBe(false);

    plugin.setup!(api);
    expect((await plugin.health!()).ok).toBe(true);
    const cmd = registered[0]!;

    for (const bad of [
      '/',
      'owner/',
      '/repo',
      '../repo',
      'owner/..',
      './repo',
      'owner/repo/../../evil',
      'owner/repo?q=1',
    ]) {
      const res = (await cmd.run(`enable ${bad} ghp_tok`, {} as never)) as { message?: string };
      expect(res?.message).toContain('Invalid repo format');
    }

    failEncrypt = true;
    await expect(cmd.run('enable my-org/my.repo-1 ghp_tok', {} as never)).rejects.toThrow(
      'vault locked',
    );

    failEncrypt = false;
    const ok = (await cmd.run('enable my-org/my.repo-1 ghp_tok prompts', {} as never)) as {
      message?: string;
    };
    expect(ok?.message).toContain('CloudSync enabled for my-org/my.repo-1');

    const addMissing = (await cmd.run('categories add', {} as never)) as { message?: string };
    expect(addMissing?.message).toContain('Usage: /sync categories');
    const rmMissing = (await cmd.run('categories remove', {} as never)) as { message?: string };
    expect(rmMissing?.message).toContain('Usage: /sync categories');

    plugin.teardown!(api);
    expect((await plugin.health!()).ok).toBe(false);
  });
});
