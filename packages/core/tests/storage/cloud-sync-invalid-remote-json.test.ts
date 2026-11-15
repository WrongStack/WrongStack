import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudSync } from '../../src/storage/cloud-sync.js';

const temps: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('CloudSync.pull remote settings JSON validation (F379)', () => {
  it('throws a contextual error naming the blob path when remote settings JSON is invalid', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f379-sync-'));
    temps.push(tmp);
    const configDir = path.join(tmp, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const settingsPath = path.join(configDir, 'config.json');
    await fs.writeFile(settingsPath, '{"theme":"dark"}\n', 'utf8');

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/git/refs/heads/main')) {
        return new Response(JSON.stringify({ object: { sha: 'c1' } }), { status: 200 });
      }
      if (url.includes('/git/commits/c1')) {
        return new Response(JSON.stringify({ tree: { sha: 't1' } }), { status: 200 });
      }
      if (url.includes('/git/trees/t1')) {
        return new Response(
          JSON.stringify({
            tree: [{ path: 'data/settings', mode: '100644', type: 'blob', sha: 'b1' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/git/blobs/b1')) {
        return new Response(
          JSON.stringify({
            content: Buffer.from('{CORRUPT_REMOTE_JSON', 'utf8').toString('base64'),
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const sync = new CloudSync(
      { globalRoot: tmp, configDir } as never,
      () => ({ enabled: true, repo: 'owner/repo', categories: ['settings'] }) as never,
      async () => {},
      () => settingsPath,
    );

    await expect(sync.pull('ghp_test')).rejects.toThrow(
      'Invalid remote settings JSON at data/settings',
    );
  });
});
