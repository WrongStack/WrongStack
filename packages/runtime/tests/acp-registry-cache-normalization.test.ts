import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { loadCachedAcpRegistry } from '../src/portable-commands/acp-registry-cache.js';

async function load(id: string, command: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-cache-normalize-'));
  try {
    await fs.writeFile(
      path.join(dir, 'acp-registry.json'),
      JSON.stringify({ fetchedAt: 'fixed', agents: [{ id, acp: { command } }] }),
    );
    return await loadCachedAcpRegistry({ cacheDir: dir } as never);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

it('normalizes cached IDs and commands before rebuilding the resolver map', async () => {
  const value = await load('  demo  ', '  demo.exe  ');
  expect(value?.agents[0]?.id).toBe('demo');
  expect(value?.byId['demo']?.command).toBe('demo.exe');
});

it('drops cached identifiers containing control characters', async () => {
  const value = await load('bad\nid', 'demo');
  expect(value?.agents).toEqual([]);
});
