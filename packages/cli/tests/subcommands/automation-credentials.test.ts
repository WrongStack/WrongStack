import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecretVault } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAutomationCredentials } from '../../src/subcommands/handlers/automation-credentials.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('automation profile references', () => {
  it('reads each key at use time, observes rotation and returns no copied provider configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'automation-key-ref-'));
    roots.push(root);
    const file = path.join(root, 'config.json');
    const vault = {
      decrypt: (value: string) => (value.startsWith('enc:') ? value.slice(4) : value),
      isEncrypted: (value: string) => value.startsWith('enc:'),
    } as SecretVault;
    const ref = {
      profile: 'default',
      provider: 'openai',
      keyLabel: 'work',
      envName: 'OPENAI_API_KEY',
    };
    const save = async (apiKey: string, authMethod = 'api_key') =>
      writeFile(
        file,
        JSON.stringify({
          providers: { openai: { apiKeys: [{ label: 'work', apiKey, authMethod }] } },
        }),
      );
    await save('enc:first');
    expect(await resolveAutomationCredentials([ref], { profileConfig: () => file }, vault)).toEqual(
      { OPENAI_API_KEY: 'first' },
    );
    await save('enc:rotated');
    expect(await resolveAutomationCredentials([ref], { profileConfig: () => file }, vault)).toEqual(
      { OPENAI_API_KEY: 'rotated' },
    );
    await save('enc:oauth-token', 'oauth');
    await expect(
      resolveAutomationCredentials([ref], { profileConfig: () => file }, vault),
    ).rejects.toThrow('unavailable');
  });
});
