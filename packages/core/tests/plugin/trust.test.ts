import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultPluginTrustPath,
  hashFileContents,
  hashPluginDirectoryClosure,
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

  it('refuses a store it cannot read instead of reporting it empty', async () => {
    // An empty result is written back by the next pin, deleting every pin.
    const busy = async (): Promise<string> => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    await expect(readPluginTrustStore('plugin-trust.json', busy)).rejects.toThrow(
      /could not be read/,
    );
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

  it('keeps every pin when several are written at the same time', async () => {
    // Unlocked read-modify-write: concurrent pins all read the old store and
    // the last write dropped the others.
    const path = join(await tempDir(), 'trust.json');
    await Promise.all(['a', 'b', 'c', 'd'].map((n) => pinPluginTrust(path, n, n, `sha-${n}`)));
    const store = await readPluginTrustStore(path);
    expect(Object.keys(store.pinned).sort()).toEqual(['a', 'b', 'c', 'd']);
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
  it('produces a stable bare hex digest of file contents', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plugin.js');
    await writeFile(file, 'export default 1;', 'utf8');
    const a = await hashFileContents(file);
    const b = await hashFileContents(file);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
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

  it('rejects top-level JSON arrays and normalizes/guards plugin keys with Object.hasOwn (F122)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'trust.json');
    await writeFile(path, '[]', 'utf8');
    await expect(readPluginTrustStore(path)).rejects.toThrow(/unexpected shape/);

    const validPath = join(dir, 'valid-trust.json');
    await pinPluginTrust(
      validPath,
      'C:\\plugins\\my-plugin.js',
      'C:\\plugins\\my-plugin.js',
      'sha-1',
    );
    const store = await readPluginTrustStore(validPath);
    expect(store.pinned['C:/plugins/my-plugin.js']).toBeDefined();
    expect(verifyPluginTrust('C:\\plugins\\my-plugin.js', 'sha-1', store).status).toBe('trusted');
    expect(verifyPluginTrust('toString', 'sha-1', store).status).toBe('unpinned');

    await unpinPluginTrust(validPath, 'C:\\plugins\\my-plugin.js');
    const afterUnpin = await readPluginTrustStore(validPath);
    expect(afterUnpin.pinned['C:/plugins/my-plugin.js']).toBeUndefined();
  });
});

describe('hashPluginDirectoryClosure — single-file plugins in a discovery root', () => {
  it('covers imported local helpers but ignores sibling plugins', async () => {
    const root = await tempDir();
    const entry = join(root, 'alpha.ts');
    const helper = join(root, 'helper.ts');
    const sibling = join(root, 'beta.ts');

    await writeFile(helper, 'export const MSG: string = "v1";\n', 'utf8');
    await writeFile(
      entry,
      'import { MSG } from "./helper.ts";\nexport default { name: "alpha", msg: MSG, setup() {} };\n',
      'utf8',
    );
    await writeFile(sibling, 'export default { name: "beta", setup() {} };\n', 'utf8');

    const before = await hashPluginDirectoryClosure(entry, [root]);

    // An unrelated sibling plugin must not invalidate this plugin's pin.
    await writeFile(
      sibling,
      'export default { name: "beta", setup() {}, tampered: true };\n',
      'utf8',
    );
    expect(await hashPluginDirectoryClosure(entry, [root])).toBe(before);

    // Tampering with the imported helper MUST invalidate the pin.
    await writeFile(helper, 'export const MSG: string = "tampered";\n', 'utf8');
    expect(await hashPluginDirectoryClosure(entry, [root])).not.toBe(before);
  });

  it('keeps the legacy single-file digest for plugins without local imports', async () => {
    const root = await tempDir();
    const entry = join(root, 'solo.ts');
    await writeFile(entry, 'export default { name: "solo", setup() {} };\n', 'utf8');

    expect(await hashPluginDirectoryClosure(entry, [root])).toBe(await hashFileContents(entry));
  });

  it('covers a helper imported with a NodeNext ".js" specifier', async () => {
    // The runtime resolves "./helper.js" to the on-disk helper.ts — the pin
    // must hash the same file, or a rewritten helper keeps the old pin valid.
    const root = await tempDir();
    const entry = join(root, 'alpha.ts');
    const helper = join(root, 'helper.ts');
    await writeFile(helper, 'export const MSG: string = "v1";\n', 'utf8');
    await writeFile(
      entry,
      'import { MSG } from "./helper.js";\nexport default { name: "alpha", msg: MSG, setup() {} };\n',
      'utf8',
    );

    const before = await hashPluginDirectoryClosure(entry, [root]);
    await writeFile(helper, 'export const MSG: string = "tampered";\n', 'utf8');
    expect(await hashPluginDirectoryClosure(entry, [root])).not.toBe(before);
  });

  it('covers local dependencies imported from outside the plugin directory', async () => {
    // foo/index.ts imports ../shared/util.ts — the helper is executed code
    // even though it lives outside the plugin's own directory.
    const root = await tempDir();
    const pkgDir = join(root, 'foo');
    const sharedDir = join(root, 'shared');
    await mkdir(pkgDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    const entry = join(pkgDir, 'index.ts');
    const helper = join(sharedDir, 'util.ts');
    await writeFile(helper, 'export const U: string = "v1";\n', 'utf8');
    await writeFile(
      entry,
      'import { U } from "../shared/util.ts";\nexport default { name: "foo", u: U, setup() {} };\n',
      'utf8',
    );

    const before = await hashPluginDirectoryClosure(entry, [root]);
    await writeFile(helper, 'export const U: string = "tampered";\n', 'utf8');
    expect(await hashPluginDirectoryClosure(entry, [root])).not.toBe(before);
  });

  it('still keeps unrelated sibling plugins out of a directory-mode pin', async () => {
    // A shared helper must be covered, but an unrelated sibling plugin
    // directory must not invalidate this plugin's pin.
    const root = await tempDir();
    const pkgDir = join(root, 'foo');
    const siblingDir = join(root, 'bar');
    await mkdir(pkgDir, { recursive: true });
    await mkdir(siblingDir, { recursive: true });
    const entry = join(pkgDir, 'index.ts');
    await writeFile(entry, 'export default { name: "foo", setup() {} };\n', 'utf8');
    await writeFile(
      join(siblingDir, 'index.ts'),
      'export default { name: "bar", setup() {} };\n',
      'utf8',
    );

    const before = await hashPluginDirectoryClosure(entry, [root]);
    await writeFile(
      join(siblingDir, 'index.ts'),
      'export default { name: "bar", setup() {}, tampered: true };\n',
      'utf8',
    );
    expect(await hashPluginDirectoryClosure(entry, [root])).toBe(before);
  });

  it('covers imported dot-directory helpers, NodeNext .js -> .mts, and ?query/#hash specifiers while ignoring unimported .git', async () => {
    const root = await tempDir();
    const pkgDir = join(root, 'dot-plug');
    await mkdir(join(pkgDir, '.internal'), { recursive: true });
    await mkdir(join(pkgDir, '.git'), { recursive: true });
    const entry = join(pkgDir, 'index.ts');
    const dotHelper = join(pkgDir, '.internal', 'helper.ts');
    await writeFile(dotHelper, 'export const S = "v1";\n', 'utf8');
    await writeFile(join(pkgDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await writeFile(
      entry,
      'import { S } from "./.internal/helper.js";\nexport default { name: "dot-plug", setup() { return S; } };\n',
      'utf8',
    );

    const h1 = await hashPluginDirectoryClosure(entry, [root]);
    await writeFile(dotHelper, 'export const S = "tampered";\n', 'utf8');
    const h2 = await hashPluginDirectoryClosure(entry, [root]);
    expect(h2).not.toBe(h1);

    // Unimported .git metadata inside the plugin folder must stay excluded
    await writeFile(join(pkgDir, '.git', 'HEAD'), 'ref: refs/heads/other\n', 'utf8');
    expect(await hashPluginDirectoryClosure(entry, [root])).toBe(h2);

    // Single-file plugin importing .mts via .js and ?query/#hash specifiers
    const soloEntry = join(root, 'solo.ts');
    const mtsHelper = join(root, 'mod.mts');
    const qHelper = join(root, 'q.ts');
    await writeFile(mtsHelper, 'export const M = 1;\n', 'utf8');
    await writeFile(qHelper, 'export const Q = 1;\n', 'utf8');
    await writeFile(
      soloEntry,
      'import { M } from "./mod.js";\nimport { Q } from "./q.ts?v=1#top";\nexport default { name: "solo", setup() { return M + Q; } };\n',
      'utf8',
    );
    const s1 = await hashPluginDirectoryClosure(soloEntry, [root]);
    await writeFile(mtsHelper, 'export const M = 2;\n', 'utf8');
    const s2 = await hashPluginDirectoryClosure(soloEntry, [root]);
    expect(s2).not.toBe(s1);
    await writeFile(qHelper, 'export const Q = 2;\n', 'utf8');
    expect(await hashPluginDirectoryClosure(soloEntry, [root])).not.toBe(s2);
  });
});
