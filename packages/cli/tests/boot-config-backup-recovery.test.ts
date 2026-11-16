import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { backupConfigFile } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultProfileProvidersAreEmpty,
  findLatestProviderBackup,
  maybeRestoreDefaultProfileFromBackup,
} from '../src/boot/config-backup-recovery.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

describe('interactive config backup recovery', () => {
  let globalRoot: string;
  let profilePath: string;

  beforeEach(async () => {
    globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-config-recovery-'));
    profilePath = path.join(globalRoot, 'profiles', 'default', 'config.json');
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    await fs.mkdir(path.join(globalRoot, 'config-history'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(globalRoot, { recursive: true, force: true });
  });

  it('only considers a valid profile with no providers empty', async () => {
    await fs.writeFile(profilePath, JSON.stringify({ providers: {}, theme: 'dark' }));
    expect(await defaultProfileProvidersAreEmpty(profilePath)).toBe(true);

    await fs.writeFile(profilePath, JSON.stringify({ providers: { anthropic: {} } }));
    expect(await defaultProfileProvidersAreEmpty(profilePath)).toBe(false);

    await fs.writeFile(profilePath, '{broken');
    expect(await defaultProfileProvidersAreEmpty(profilePath)).toBe(false);
  });

  it('selects the newest valid dated profile snapshot that contains providers', async () => {
    const historyDir = path.join(globalRoot, 'config-history');
    await fs.writeFile(
      path.join(historyDir, 'profiles-default-config-2026-07-19T10-00-00-000.json'),
      JSON.stringify({ providers: { old: {} } }),
    );
    await fs.writeFile(
      path.join(historyDir, 'profiles-default-config-2026-07-19T13-00-00-000.json'),
      '{broken',
    );
    await fs.writeFile(
      path.join(historyDir, 'profiles-default-config-2026-07-19T12-00-00-000.json'),
      JSON.stringify({ providers: { newestUsable: {} }, theme: 'light' }),
    );
    await fs.writeFile(
      path.join(historyDir, 'profiles-work-config-2026-07-19T14-00-00-000.json'),
      JSON.stringify({ providers: { wrongProfile: {} } }),
    );

    const backup = await findLatestProviderBackup(globalRoot);
    expect(backup?.fileName).toBe('profiles-default-config-2026-07-19T12-00-00-000.json');
    expect(backup?.providerIds).toEqual(['newestUsable']);

    const workBackup = await findLatestProviderBackup(globalRoot, 'work');
    expect(workBackup?.fileName).toBe('profiles-work-config-2026-07-19T14-00-00-000.json');
    expect(workBackup?.providerIds).toEqual(['wrongProfile']);
  });

  it('finds the snapshot backupConfigFile wrote for a profile name it slugifies', async () => {
    // backupConfigFile stores `profiles/my_work/config.json` as
    // `profiles-my-work-config-<ts>.json`; the reader must use the same prefix.
    const workPath = path.join(globalRoot, 'profiles', 'my_work', 'config.json');
    await fs.mkdir(path.dirname(workPath), { recursive: true });
    await fs.writeFile(workPath, JSON.stringify({ providers: { anthropic: {} } }));
    await backupConfigFile(workPath, { globalRoot });
    const written = await fs.readdir(path.join(globalRoot, 'config-history'));
    expect(written).toEqual([expect.stringMatching(/^profiles-my-work-config-/)]);

    const backup = await findLatestProviderBackup(globalRoot, 'my_work');
    expect(backup?.fileName).toBe(written[0]);
    expect(backup?.providerIds).toEqual(['anthropic']);
    // Other profiles' snapshots stay out of scope.
    expect(await findLatestProviderBackup(globalRoot, 'default')).toBeUndefined();
  });

  it('orders a non-default profile by the timestamp in the file name, not mtime', async () => {
    const historyDir = path.join(globalRoot, 'config-history');
    const older = path.join(historyDir, 'profiles-work-config-2026-07-19T10-00-00-000.json');
    const newer = path.join(historyDir, 'profiles-work-config-2026-07-19T12-00-00-000.json');
    await fs.writeFile(newer, JSON.stringify({ providers: { newer: {} } }));
    await fs.writeFile(older, JSON.stringify({ providers: { older: {} } }));
    // Make mtime disagree with the name: the older snapshot was touched last.
    await fs.utimes(newer, new Date('2026-07-19T00:00:00Z'), new Date('2026-07-19T00:00:00Z'));
    await fs.utimes(older, new Date('2026-07-20T00:00:00Z'), new Date('2026-07-20T00:00:00Z'));

    const backup = await findLatestProviderBackup(globalRoot, 'work');
    expect(backup?.providerIds).toEqual(['newer']);
  });

  it('defaults to yes and restores the complete backup JSON', async () => {
    const current = { providers: {}, theme: 'current', yolo: false };
    const saved = {
      provider: 'anthropic',
      model: 'claude-test',
      providers: { anthropic: { type: 'anthropic', apiKey: 'enc:test' } },
      theme: 'backup',
      yolo: true,
      customSetting: { keep: 'everything' },
    };
    await fs.writeFile(profilePath, JSON.stringify(current));
    await fs.writeFile(
      path.join(
        globalRoot,
        'config-history',
        'profiles-default-config-2026-07-19T12-00-00-000.json',
      ),
      JSON.stringify(saved, null, 2),
    );
    const renderer = {
      write: vi.fn(),
      writeWarning: vi.fn(),
    } as unknown as TerminalRenderer;
    const reader: Pick<ReadlineInputReader, 'readLine'> = {
      readLine: vi.fn().mockResolvedValue(''),
    } as never;

    const restored = await maybeRestoreDefaultProfileFromBackup({
      globalRoot,
      profilePath,
      renderer,
      reader: reader as never,
    });

    expect(restored).toBe(true);
    expect(JSON.parse(await fs.readFile(profilePath, 'utf8'))).toEqual(saved);
    expect(reader.readLine).toHaveBeenCalledWith(expect.stringContaining('[Y/n]'));
    const historyFiles = await fs.readdir(path.join(globalRoot, 'config-history'));
    expect(historyFiles.some((name) => name.startsWith('profiles-default-config-'))).toBe(true);
  });

  it('leaves the empty profile untouched when recovery is declined', async () => {
    const current = { providers: {}, theme: 'current' };
    await fs.writeFile(profilePath, JSON.stringify(current));
    await fs.writeFile(
      path.join(
        globalRoot,
        'config-history',
        'profiles-default-config-2026-07-19T12-00-00-000.json',
      ),
      JSON.stringify({ providers: { openai: {} }, theme: 'backup' }),
    );
    const reader = { readLine: vi.fn().mockResolvedValue('n') } as never;

    const restored = await maybeRestoreDefaultProfileFromBackup({
      globalRoot,
      profilePath,
      renderer: { write: vi.fn(), writeWarning: vi.fn() } as unknown as TerminalRenderer,
      reader: reader as never,
    });

    expect(restored).toBe(false);
    expect(JSON.parse(await fs.readFile(profilePath, 'utf8'))).toEqual(current);
  });

  it('strips UTF-8 BOM from profile and backup snapshots (F443)', async () => {
    await fs.writeFile(profilePath, `\uFEFF${JSON.stringify({ providers: {} })}`);
    await fs.writeFile(
      path.join(
        globalRoot,
        'config-history',
        'profiles-default-config-2026-07-19T12-00-00-000.json',
      ),
      `\uFEFF${JSON.stringify({ providers: { anthropic: { type: 'anthropic' } } })}`,
    );
    const backup = await findLatestProviderBackup(globalRoot, 'default');
    expect(backup?.providerIds).toEqual(['anthropic']);
  });
});
