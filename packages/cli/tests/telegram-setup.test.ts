import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTelegramSetupCommand } from '../src/slash-commands/telegram-setup.js';

const TOKEN = '123456:superSecretToken';
const originalFetch = globalThis.fetch;

function configStore() {
  let config: Record<string, unknown> = {};
  return {
    get: vi.fn(() => config),
    update: vi.fn((patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    }),
  };
}

async function rig(secret = TOKEN) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-tg-setup-'));
  const configPath = path.join(dir, 'config.json');
  const vault = new DefaultSecretVault({ keyFile: path.join(dir, '.key') });
  const readSecret = vi.fn(async () => secret);
  const store = configStore();
  const command = buildTelegramSetupCommand({
    configStore: store,
    paths: { globalConfig: configPath },
    readSecret,
    vault,
  } as never);
  return { dir, configPath, vault, readSecret, command };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('/telegram-setup secure token flow', () => {
  it('rejects token-bearing slash arguments without echoing token material', async () => {
    const { command, readSecret } = await rig();
    const result = await command.run(`${TOKEN} 42`);
    expect(readSecret).not.toHaveBeenCalled();
    expect(result?.message).not.toContain(TOKEN);
    expect(result?.message).not.toContain('superSecretToken');
  });

  it('does not echo the entered token on format or network errors', async () => {
    const bad = 'not-a-token-superSecretToken';
    const first = await rig(bad);
    const invalid = await first.command.run('');
    expect(invalid?.message).not.toContain(bad);
    expect(invalid?.message).not.toContain('superSecretToken');

    globalThis.fetch = vi.fn(async () => {
      throw new Error(`network failure while using ${TOKEN}`);
    }) as unknown as typeof fetch;
    const second = await rig();
    const failed = await second.command.run('');
    expect(failed?.message).not.toContain(TOKEN);
    expect(failed?.message).not.toContain('superSecretToken');
  });

  it('refuses a manual group chat ID without persisting configuration', async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'SecureBot', username: 'secure_bot' },
      }),
    })) as unknown as typeof fetch;
    const { command, configPath, readSecret } = await rig();

    const result = await command.run('-10042');

    expect(readSecret).toHaveBeenCalledOnce();
    expect(result?.message).toContain('cannot be paired by manual ID');
    expect(result?.message).toContain('No configuration was changed');
    expect(result?.message).not.toContain(TOKEN);
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
