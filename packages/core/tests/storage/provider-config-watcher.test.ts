import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultSecretVault } from '../../src/security/secret-vault.js';
import {
  type ProviderConfigSnapshot,
  readProviderSnapshot,
  watchProviderConfig,
} from '../../src/storage/provider-config-watcher.js';
import { atomicWrite } from '../../src/utils/atomic-write.js';

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-cfgwatch-'));
  const configPath = path.join(dir, 'config.json');
  const vault = new DefaultSecretVault({ keyFile: path.join(dir, '.key') });
  return { dir, configPath, vault };
}

async function writeConfig(configPath: string, obj: unknown): Promise<void> {
  await atomicWrite(configPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()?.();
});

describe('watchProviderConfig', () => {
  it('normalizes inline provider models in a hot-reload snapshot', async () => {
    const { configPath, vault } = await makeFixture();
    await writeConfig(configPath, {
      version: 1,
      fallbackBridge: 'acme/acme-large',
      providers: {
        acme: {
          type: 'acme',
          family: 'openai-compatible',
          models: [
            {
              id: 'acme-large',
              name: 'Acme Large',
              limit: { context: 262_144, output: 32_768 },
              tool_call: true,
            },
          ],
        },
      },
    });

    const snapshot = await readProviderSnapshot(configPath, vault);
    expect(snapshot?.fallbackBridge).toBe('acme/acme-large');
    expect(snapshot?.providers.acme?.models).toEqual(['acme-large']);
    expect(snapshot?.providers.acme?.customModels?.['acme-large']).toMatchObject({
      name: 'Acme Large',
      maxOutput: 32_768,
      capabilities: { maxContext: 262_144, tools: true },
      // ME-2: full inline object now round-trips via modelsDev.
      modelsDev: {
        name: 'Acme Large',
        limit: { context: 262_144, output: 32_768 },
        tool_call: true,
      },
    });
  });

  it('fires onChange with the decrypted providers map after a change', async () => {
    const { configPath, vault } = await makeFixture();
    await writeConfig(configPath, { version: 1, providers: {} });

    const snapshots: ProviderConfigSnapshot[] = [];
    const { close } = watchProviderConfig(configPath, vault, (s) => snapshots.push(s), {
      debounceMs: 20,
    });
    closers.push(close);
    // Let the seed read settle so the first real change is what fires.
    await vi.waitFor(() => fsSync.existsSync(configPath));

    await writeConfig(configPath, {
      version: 1,
      providers: { anthropic: { type: 'anthropic', apiKey: 'sk-plain-123' } },
    });

    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 2000 });
    const last = snapshots.at(-1)!;
    expect(last.providers.anthropic?.apiKey).toBe('sk-plain-123');
  });

  it('decrypts encrypted key material', async () => {
    const { configPath, vault } = await makeFixture();
    await writeConfig(configPath, { version: 1, providers: {} });

    const snapshots: ProviderConfigSnapshot[] = [];
    const { close } = watchProviderConfig(configPath, vault, (s) => snapshots.push(s), {
      debounceMs: 20,
    });
    closers.push(close);
    await vi.waitFor(() => fsSync.existsSync(configPath));

    const enc = vault.encrypt('sk-secret-xyz');
    expect(vault.isEncrypted(enc)).toBe(true);
    await writeConfig(configPath, {
      version: 1,
      providers: { openai: { type: 'openai', apiKey: enc } },
    });

    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(snapshots.at(-1)!.providers.openai?.apiKey).toBe('sk-secret-xyz');
  });

  it('does not fire when the providers slice is unchanged', async () => {
    const { configPath, vault } = await makeFixture();
    const content = {
      version: 1,
      providers: { anthropic: { type: 'anthropic', apiKey: 'k1' } },
    };
    await writeConfig(configPath, content);

    const snapshots: ProviderConfigSnapshot[] = [];
    const { close } = watchProviderConfig(configPath, vault, (s) => snapshots.push(s), {
      debounceMs: 20,
    });
    closers.push(close);
    await vi.waitFor(() => fsSync.existsSync(configPath));
    // Give the seed read time to record lastSerialized.
    await new Promise((r) => setTimeout(r, 60));

    // Re-write identical providers (a non-provider field changes — must be ignored).
    await writeConfig(configPath, { ...content, model: 'changed' });
    await new Promise((r) => setTimeout(r, 200));

    expect(snapshots).toHaveLength(0);
  });

  it('is lenient on corrupt JSON and recovers on the next valid write', async () => {
    const { configPath, vault } = await makeFixture();
    await writeConfig(configPath, { version: 1, providers: {} });

    const warnings: string[] = [];
    const snapshots: ProviderConfigSnapshot[] = [];
    const { close } = watchProviderConfig(configPath, vault, (s) => snapshots.push(s), {
      debounceMs: 20,
      warn: (m) => warnings.push(m),
    });
    closers.push(close);
    await vi.waitFor(() => fsSync.existsSync(configPath));

    // Corrupt write — must not throw, must not fire onChange.
    await atomicWrite(configPath, '{ not valid json', { mode: 0o600 });
    await new Promise((r) => setTimeout(r, 120));
    expect(snapshots).toHaveLength(0);
    expect(warnings.some((w) => /not valid JSON/i.test(w))).toBe(true);

    // Watcher stays live: a subsequent valid write fires.
    await writeConfig(configPath, {
      version: 1,
      providers: { z: { type: 'z', family: 'openai-compat', apiKey: 'kk' } },
    });
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0), { timeout: 2000 });
    expect(snapshots.at(-1)!.providers.z?.apiKey).toBe('kk');
  });

  it('stops firing after close()', async () => {
    const { configPath, vault } = await makeFixture();
    await writeConfig(configPath, { version: 1, providers: {} });
    const snapshots: ProviderConfigSnapshot[] = [];
    const { close } = watchProviderConfig(configPath, vault, (s) => snapshots.push(s), {
      debounceMs: 20,
    });
    await vi.waitFor(() => fsSync.existsSync(configPath));
    await new Promise((r) => setTimeout(r, 40));
    close();

    await writeConfig(configPath, {
      version: 1,
      providers: { a: { type: 'a', apiKey: 'after-close' } },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(snapshots).toHaveLength(0);
  });
});
