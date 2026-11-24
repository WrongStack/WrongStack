import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { loadCachedAcpRegistry } from '../src/portable-commands/acp-registry-cache.js';

async function load(agents: unknown[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-cache-boundary-'));
  try {
    await fs.writeFile(
      path.join(dir, 'acp-registry.json'),
      JSON.stringify({ fetchedAt: 'fixed', agents }),
    );
    return await loadCachedAcpRegistry({ cacheDir: dir } as never);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

it('keeps the first cached descriptor for a duplicate ID', async () => {
  const value = await load([
    { id: 'same', acp: { command: 'first' } },
    { id: 'same', acp: { command: 'second' } },
  ]);
  expect(value?.agents).toHaveLength(1);
  expect(value?.byId['same']?.command).toBe('first');
});

it('drops cached launch shapes that cannot be passed to child_process', async () => {
  const value = await load([
    { id: 'bad-args', acp: { command: 'demo', args: 'oops' } },
    { id: 'bad-env', acp: { command: 'demo', env: { TOKEN: 42 } } },
    { id: 'bad-nul', acp: { command: 'demo', args: ['bad\0arg'] } },
  ]);
  expect(value?.agents).toEqual([]);
  expect(value?.byId).toEqual({});
});
