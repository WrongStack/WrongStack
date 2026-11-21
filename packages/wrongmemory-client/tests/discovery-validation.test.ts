import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WrongMemoryClient } from '../src/client.js';
import { loadDiscovery } from '../src/discovery.js';
import { WrongMemoryError } from '../src/errors.js';

const dirs: string[] = [];

async function makeRoot(): Promise<{ root: string; endpointFile: string; tokenFile: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-disc-'));
  dirs.push(root);
  const runtimeDir = path.join(root, 'runtime');
  await fs.mkdir(runtimeDir, { recursive: true });
  return {
    root,
    endpointFile: path.join(runtimeDir, 'endpoint.json'),
    tokenFile: path.join(runtimeDir, 'token'),
  };
}

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('wrongmemory-client discovery & endpoint validation', () => {
  it('rejects empty host tokens as UNAVAILABLE', async () => {
    const { root, endpointFile, tokenFile } = await makeRoot();
    await fs.writeFile(endpointFile, JSON.stringify({ endpoint: '\\\\.\\pipe\\wm' }));
    await fs.writeFile(tokenFile, '   \n');

    expect(() => loadDiscovery(root)).toThrow(WrongMemoryError);
    try {
      loadDiscovery(root);
    } catch (e) {
      expect((e as WrongMemoryError).code).toBe('UNAVAILABLE');
    }
  });

  it('rejects missing or blank endpoint strings in connect() as UNAVAILABLE', async () => {
    const { root, endpointFile, tokenFile } = await makeRoot();
    await fs.writeFile(tokenFile, 'valid-token');
    await fs.writeFile(endpointFile, JSON.stringify({ pid: 100 }));

    await expect(
      WrongMemoryClient.connect({ dataRoot: root, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await fs.writeFile(endpointFile, JSON.stringify({ endpoint: '   ' }));
    await expect(
      WrongMemoryClient.connect({ dataRoot: root, timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});
