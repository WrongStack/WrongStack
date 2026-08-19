import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultPluginTrustPath,
  hashFileContents,
  pinPluginTrust,
  readPluginTrustStore,
  unpinPluginTrust,
  verifyPluginTrust,
  writePluginTrustStore,
} from '../../src/plugin/trust.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ws-trust-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('plugin trust store', () => {
  it('treats a missing store as empty', async () => {
    const dir = await tempDir();
    const store = await readPluginTrustStore(join(dir, 'trust.json'));
    expect(store).toEqual({ pinned: {} });
  });

  it('refuses to silently downgrade a corrupt store', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await writeFile(path, '{ not json', 'utf8');
    await expect(readPluginTrustStore(path)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses an invalid pinned section', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await writeFile(path, JSON.stringify({ pinned: [1, 2] }), 'utf8');
    await expect(readPluginTrustStore(path)).rejects.toThrow(/invalid "pinned"/);
  });

  it('round-trips pins through write/read', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await pinPluginTrust(path, '/p/entry.js', '/p/entry.js', 'sha256-abc', 'my-plugin');
    const store = await readPluginTrustStore(path);
    expect(store.pinned['/p/entry.js']).toMatchObject({
      entry: '/p/entry.js',
      integrity: 'sha256-abc',
      spec: 'my-plugin',
    });
    expect(typeof store.pinned['/p/entry.js']!.pinnedAt).toBe('string');
  });

  it('unpin removes only the targeted entry', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await pinPluginTrust(path, '/p/a.js', '/p/a.js', 'sha256-a');
    await pinPluginTrust(path, '/p/b.js', '/p/b.js', 'sha256-b');
    await unpinPluginTrust(path, '/p/a.js');
    const store = await readPluginTrustStore(path);
    expect(store.pinned['/p/a.js']).toBeUndefined();
    expect(store.pinned['/p/b.js']).toBeDefined();
    // Unpinning an unknown key is a no-op, not an error.
    await unpinPluginTrust(path, '/p/missing.js');
  });

  it('writes the store as JSON with a trailing newline', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await writePluginTrustStore(path, { pinned: {} });
    const raw = await readFile(path, 'utf8');
    expect(raw.trim()).toBe(JSON.stringify({ pinned: {} }, null, 2));
    expect(raw.endsWith('\n')).toBe(true);
  });
});

describe('verifyPluginTrust', () => {
  const store = {
    pinned: {
      '/p/entry.js': {
        entry: '/p/entry.js',
        integrity: 'sha256-known',
        pinnedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };

  it('reports unpinned for unknown entries', () => {
    expect(verifyPluginTrust('/other.js', 'sha256-x', store)).toEqual({
      status: 'unpinned',
      integrity: 'sha256-x',
    });
  });

  it('reports trusted on matching integrity', () => {
    expect(verifyPluginTrust('/p/entry.js', 'sha256-known', store)).toEqual({
      status: 'trusted',
      integrity: 'sha256-known',
    });
  });

  it('reports changed with both hashes when the entry file differs', () => {
    expect(verifyPluginTrust('/p/entry.js', 'sha256-tampered', store)).toEqual({
      status: 'changed',
      expected: 'sha256-known',
      actual: 'sha256-tampered',
      pinnedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('hashFileContents', () => {
  it('produces a stable sha256- prefix of file contents', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plugin.js');
    await writeFile(file, 'export default 1;', 'utf8');
    const a = await hashFileContents(file);
    const b = await hashFileContents(file);
    expect(a).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(a).toBe(b);
    await writeFile(file, 'export default 2;', 'utf8');
    const c = await hashFileContents(file);
    expect(c).not.toBe(a);
  });
});

describe('defaultPluginTrustPath', () => {
  it('anchors the store at the global root', () => {
    const sep = defaultPluginTrustPath('/home/u/.wrongstack').replaceAll('\\', '/');
    expect(sep.endsWith('plugin-trust.json')).toBe(true);
    expect(sep.startsWith('/home/u/.wrongstack')).toBe(true);
  });
});
