import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { runPluginManagementCommand } from '../src/plugin-management/management.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('plugin-management file-lock serialization and telegram alias parity (F532)', () => {
  it('serializes concurrent config.json writers via file lock and unifies telegram/@wrongstack/telegram across subcommands', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-mgmt-f532-'));
    dirs.push(tmpDir);
    const baseConfig = { features: { plugins: true } } as Config;

    // 1. Gated concurrent writes preserve every mutation and invoke backupConfig on each write.
    const gatedPath = path.join(tmpDir, 'gated.json');
    await fs.writeFile(
      gatedPath,
      `\uFEFF${JSON.stringify({ model: 'keep', plugins: [] })}`,
      'utf8',
    );
    const firstEnteredBackup = deferred<void>();
    const releaseFirstBackup = deferred<void>();
    let backupCalls = 0;

    const p1 = runPluginManagementCommand(['toggle', 'format-on-save'], {
      config: baseConfig,
      configPath: gatedPath,
      backupConfig: async () => {
        backupCalls += 1;
        firstEnteredBackup.resolve();
        await releaseFirstBackup.promise;
      },
    });
    await firstEnteredBackup.promise;

    const p2 = runPluginManagementCommand(['add', 'branch-guard'], {
      config: baseConfig,
      configPath: gatedPath,
      backupConfig: async () => {
        backupCalls += 1;
      },
    });
    const p3 = runPluginManagementCommand(['manager', 'lock', 'secret-scanner'], {
      config: baseConfig,
      configPath: gatedPath,
      backupConfig: async () => {
        backupCalls += 1;
      },
    });
    const p4 = runPluginManagementCommand(['llm', 'error-lens', 'openai', 'gpt-5'], {
      config: baseConfig,
      configPath: gatedPath,
      backupConfig: async () => {
        backupCalls += 1;
      },
    });

    releaseFirstBackup.resolve();
    const results = await Promise.all([p1, p2, p3, p4]);
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(backupCalls).toBe(4);

    const gatedDisk = JSON.parse(await fs.readFile(gatedPath, 'utf8')) as Record<string, unknown>;
    expect(gatedDisk).toMatchObject({
      model: 'keep',
      plugins: ['format-on-save', 'branch-guard'],
      pluginManager: { locked: ['secret-scanner'] },
      extensions: { 'error-lens': { llm: { provider: 'openai', model: 'gpt-5' } } },
    });

    // 2. Official telegram alias round-trips cleanly across toggle -> official -> disable -> remove.
    const tgPath = path.join(tmpDir, 'tg.json');
    await fs.writeFile(tgPath, JSON.stringify({ features: { plugins: true } }), 'utf8');
    await runPluginManagementCommand(['toggle', 'telegram'], {
      config: baseConfig,
      configPath: tgPath,
    });

    const tgDisk1 = JSON.parse(await fs.readFile(tgPath, 'utf8')) as Config;
    const official1 = await runPluginManagementCommand(['official'], {
      config: tgDisk1,
      configPath: tgPath,
    });
    const tgRow =
      official1.message.split('\n').find((line) => line.trim().startsWith('telegram ')) ?? '';
    expect(tgRow).toMatch(/\benabled\b/);

    await runPluginManagementCommand(['disable', 'telegram'], {
      config: tgDisk1,
      configPath: tgPath,
    });
    const tgDisk2 = JSON.parse(await fs.readFile(tgPath, 'utf8')) as Config;
    expect(tgDisk2.plugins).toHaveLength(1);

    const removed = await runPluginManagementCommand(['remove', 'telegram'], {
      config: tgDisk2,
      configPath: tgPath,
    });
    expect(removed.code).toBe(0);
    const tgDisk3 = JSON.parse(await fs.readFile(tgPath, 'utf8')) as Config;
    expect(tgDisk3.plugins).toEqual([]);
  });
});
