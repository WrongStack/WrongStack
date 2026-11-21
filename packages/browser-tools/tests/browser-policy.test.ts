import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPrivateOrigins, setBrowserPrivateOrigin } from '../src/policy.js';
import { assertBrowserUrlAllowed } from '../src/security.js';

let root: string;
beforeEach(async () => {
  vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', '');
  root = await mkdtemp(join(tmpdir(), 'browser-policy-'));
  vi.stubEnv('WRONGSTACK_HOME', join(root, 'home'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('project browser origin policy', () => {
  it('persists an exact allowance, updates active guard references, and revokes it', async () => {
    const origins = browserPrivateOrigins(root);
    const opts = { allowedPrivateOrigins: origins, navigation: true };
    await expect(assertBrowserUrlAllowed('http://localhost:3210/', opts)).rejects.toThrow(
      '/browser allow',
    );
    await setBrowserPrivateOrigin(root, 'http://localhost:3210', true);
    await expect(
      assertBrowserUrlAllowed('http://localhost:3210/app', opts),
    ).resolves.toBeInstanceOf(URL);
    await expect(assertBrowserUrlAllowed('http://localhost:3211/', opts)).rejects.toThrow(
      'localhost',
    );
    expect(
      JSON.parse(
        await readFile(
          join(resolveWstackPaths({ projectRoot: root }).projectDir, 'browser-policy.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ privateOrigins: ['http://localhost:3210'] });
    await setBrowserPrivateOrigin(root, 'http://localhost:3210', false);
    await expect(assertBrowserUrlAllowed('http://localhost:3210/', opts)).rejects.toThrow(
      'localhost',
    );
  });

  it('rejects multiple origins and paths without writing a policy', async () => {
    await expect(
      setBrowserPrivateOrigin(root, 'http://localhost:1,http://localhost:2', true),
    ).rejects.toThrow('one HTTP(S) origin');
    await expect(setBrowserPrivateOrigin(root, 'http://localhost:1/admin', true)).rejects.toThrow(
      'origin',
    );
    expect(browserPrivateOrigins(root)).toEqual([]);
  });

  it('preserves environment allowances and unrelated policy properties', async () => {
    vi.stubEnv('WRONGSTACK_BROWSER_PRIVATE_ORIGINS', 'http://localhost:3212');
    await setBrowserPrivateOrigin(root, 'http://localhost:3210', true);
    const file = join(resolveWstackPaths({ projectRoot: root }).projectDir, 'browser-policy.json');
    await writeFile(
      file,
      JSON.stringify({ privateOrigins: ['http://localhost:3210'], other: 'keep' }),
    );
    await setBrowserPrivateOrigin(root, 'http://localhost:3210', false);
    expect(browserPrivateOrigins(root)).toEqual(['http://localhost:3212']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      other: 'keep',
      privateOrigins: [],
    });
  });
});
