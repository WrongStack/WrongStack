import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ProviderApiKey } from '@wrongstack/contracts/types';
import {
  DefaultSecretVault,
  decryptConfigSecrets,
  encryptConfigSecrets,
} from '@wrongstack/core/security';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('two real processes share one exchange and persist the rotated token encrypted before releasing the lock', async () => {
  const root = fileURLToPath(new URL('../../../.temp_files/', import.meta.url));
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, 'subscription-process-test-'));
  try {
    const configPath = join(dir, 'config.json');
    const keyPath = join(dir, '.key');
    const logPath = join(dir, 'exchanges');
    const vault = new DefaultSecretVault({ keyFile: keyPath });
    const source: ProviderApiKey = {
      label: 'personal',
      apiKey: 'expired-access',
      refreshToken: 'one-use-refresh',
      createdAt: '',
      authMethod: 'oauth',
      oauthStrategyId: 'chatgpt-api',
      oauthClientId: 'oaiapp_user',
      oauthSubject: 'subject',
      scope: 'chatgpt.tokens.use.direct',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await writeFile(
      configPath,
      JSON.stringify(
        encryptConfigSecrets(
          {
            providers: {
              work: { type: 'openai-chatgpt', apiKeys: [source], activeKey: 'personal' },
            },
          },
          vault,
        ),
      ),
    );
    const fixture = fileURLToPath(
      new URL('./fixtures/subscription-refresh-worker.mjs', import.meta.url),
    );
    const args = [
      '--experimental-strip-types',
      fixture,
      configPath,
      keyPath,
      logPath,
      JSON.stringify(source),
    ];
    await Promise.all([
      exec(process.execPath, args, { timeout: 20_000 }),
      exec(process.execPath, args, { timeout: 20_000 }),
    ]);
    expect((await readFile(logPath, 'utf8')).trim().split('\n')).toHaveLength(1);
    const raw = await readFile(configPath, 'utf8');
    expect(raw).not.toContain('renewed-access');
    expect(raw).not.toContain('renewed-refresh');
    const stored = decryptConfigSecrets(JSON.parse(raw), vault);
    expect(stored.providers.work.apiKeys[0]).toMatchObject({
      apiKey: 'renewed-access',
      refreshToken: 'renewed-refresh',
    });
    expect(stored.providers.work.activeKey).toBe('personal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
