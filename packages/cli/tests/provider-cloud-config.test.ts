import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretVault } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerCloudConfig } from '../src/provider-cloud-config.js';
import { buildAuthCommand } from '../src/slash-commands/auth.js';
import { authCmd } from '../src/subcommands/handlers/auth.js';

const roots: string[] = [];
const vault = {
  isEncrypted: (value: string) => value.startsWith('enc:'),
  encrypt: (value: string) => `enc:${value}`,
  decrypt: (value: string) => (value.startsWith('enc:') ? value.slice(4) : value),
} as SecretVault;
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith('wrongstack-cloud-config-')
    )
      throw new Error('Unknown fixture path');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-cloud-config-'));
  roots.push(root);
  const directory = path.join(root, 'profiles', 'default');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      providers: {
        work: {
          type: 'google-vertex',
          apiKey: 'enc:private-key',
          cloud: { project: 'old-project', location: 'us-central1' },
        },
      },
    }),
  );
  return {
    root,
    file,
    paths: {
      globalRoot: root,
      globalConfig: path.join(root, 'config.json'),
      profileName: 'default',
      profileConfig: () => file,
    },
  };
}
describe('cloud profile configuration surfaces', () => {
  it('merges routing settings while preserving encryption and clears without touching keys', async () => {
    const { file } = await fixture();
    expect(await providerCloudConfig('work', { project: 'new-project' }, file, vault)).toEqual({
      project: 'new-project',
      location: 'us-central1',
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.providers.work.apiKey).toBe('enc:private-key');
    expect(await providerCloudConfig('work', null, file, vault)).toEqual({});
    await expect(
      providerCloudConfig('work', { resourceName: 'wrong-cloud' }, file, vault),
    ).rejects.toThrow('does not apply');
  });
  it('writes the same settings through CLI and TUI slash entry points', async () => {
    const { file, paths } = await fixture();
    const renderer = { write: vi.fn(), writeError: vi.fn() };
    expect(
      await authCmd(['cloud', 'work'], {
        paths,
        config: {},
        vault,
        renderer,
        flags: { project: 'cli-project' },
      } as never),
    ).toBe(0);
    const command = buildAuthCommand({ paths, configStore: { get: () => ({}) }, vault } as never);
    await command.run('cloud work location europe-west4');
    expect(await providerCloudConfig('work', undefined, file, vault)).toEqual({
      project: 'cli-project',
      location: 'europe-west4',
    });
  });
});
