import { describe, expect, it } from 'vitest';
import {
  discoverExternalPlugins,
  resolvePluginTarget,
  type DiscoveryIo,
} from '../../src/plugin/discovery.js';

/** Minimal in-memory fs for discovery tests. */
function io(files: Record<string, string>, dirs: string[] = []): DiscoveryIo {
  const dirSet = new Set(dirs);
  const path = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '');
  return {
    async readdir(root) {
      if (!dirSet.has(path(root))) throw new Error('ENOENT');
      const names = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(`${path(root)}/`)) names.add(key.slice(path(root).length + 1).split('/')[0]!);
      }
      for (const dir of dirSet) {
        if (dir.startsWith(`${path(root)}/`)) names.add(dir.slice(path(root).length + 1).split('/')[0]!);
      }
      return [...names].map((name) => ({
        name,
        isDirectory: () => dirSet.has(`${path(root)}/${name}`),
        isFile: () => files[`${path(root)}/${name}`] !== undefined,
      }));
    },
    async stat(p) {
      const key = path(p);
      if (files[key] !== undefined) return { isFile: () => true, isDirectory: () => false };
      if (dirSet.has(key)) return { isFile: () => false, isDirectory: () => true };
      throw new Error('ENOENT');
    },
    async readFile(p) {
      const contents = files[path(p)];
      if (contents === undefined) throw new Error('ENOENT');
      return contents;
    },
  };
}

const JS = 'export default { name: "x", apiVersion: "^0.1", setup() {} };';

describe('discoverExternalPlugins', () => {
  it('resolves entries from package.json main', async () => {
    const i = io(
      { '/r/alpha/package.json': JSON.stringify({ main: './dist/entry.js' }), '/r/alpha/dist/entry.js': JS },
      ['/r', '/r/alpha', '/r/alpha/dist'],
    );
    const { candidates, skipped } = await discoverExternalPlugins(['/r'], i);
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: 'alpha', root: '/r' });
    expect(candidates[0]!.entryPath.replace(/\\/g, '/')).toBe('/r/alpha/dist/entry.js');
  });

  it('prefers exports["."] import condition over main and handles string exports', async () => {
    const withConditions = io(
      {
        '/r/a/package.json': JSON.stringify({ main: './old.js', exports: { '.': { import: './new.mjs' } } }),
        '/r/a/old.js': JS,
        '/r/a/new.mjs': JS,
      },
      ['/r', '/r/a'],
    );
    const fromConditions = await discoverExternalPlugins(['/r'], withConditions);
    expect(fromConditions.candidates[0]!.entryPath.replace(/\\/g, '/')).toBe('/r/a/new.mjs');

    const withString = io(
      {
        '/r/b/package.json': JSON.stringify({ main: './old.js', exports: { '.': './str.js' } }),
        '/r/b/old.js': JS,
        '/r/b/str.js': JS,
      },
      ['/r', '/r/b'],
    );
    const fromString = await discoverExternalPlugins(['/r'], withString);
    expect(fromString.candidates[0]!.entryPath.replace(/\\/g, '/')).toBe('/r/b/str.js');
  });

  it('falls back to index probing when package.json has no resolvable entry', async () => {
    const i = io(
      { '/r/no-manifest/index.mjs': JS, '/r/broken/package.json': '{ not json' },
      ['/r', '/r/no-manifest', '/r/broken'],
    );
    const { candidates, skipped } = await discoverExternalPlugins(['/r'], i);
    expect(candidates.map((c) => c.name)).toEqual(['no-manifest']);
    expect(candidates[0]!.entryPath.replace(/\\/g, '/')).toBe('/r/no-manifest/index.mjs');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ name: 'broken', reason: expect.stringContaining('package.json') });
  });

  it('accepts single entry files directly under the root', async () => {
    const i = io({ '/r/solo.js': JS, '/r/notes.txt': 'x' }, ['/r']);
    const { candidates } = await discoverExternalPlugins(['/r'], i);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.name).toBe('solo');
  });

  it('skips dot-entries and node_modules, and scans in alphabetical order', async () => {
    const i = io(
      {
        '/r/zeta/index.js': JS,
        '/r/alpha/index.js': JS,
        '/r/.hidden/index.js': JS,
      },
      ['/r', '/r/zeta', '/r/alpha', '/r/.hidden', '/r/node_modules/pkg'],
    );
    const { candidates } = await discoverExternalPlugins(['/r'], i);
    expect(candidates.map((c) => c.name)).toEqual(['alpha', 'zeta']);
  });

  it('treats a missing root as empty, not an error', async () => {
    const { candidates, skipped } = await discoverExternalPlugins(['/nope'], io({}, []));
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('scans multiple roots in order', async () => {
    const i = io({ '/one/a/index.js': JS, '/two/b/index.js': JS }, ['/one', '/two', '/one/a', '/two/b']);
    const { candidates } = await discoverExternalPlugins(['/one', '/two'], i);
    expect(candidates.map((c) => c.root)).toEqual(['/one', '/two']);
  });
});

describe('resolvePluginTarget', () => {
  it('returns files unchanged', async () => {
    const i = io({ '/x/plugin.js': JS }, []);
    expect(await resolvePluginTarget('/x/plugin.js', i)).toMatch(/plugin\.js$/);
  });

  it('resolves directories through package.json / index fallbacks', async () => {
    const i = io({ '/x/index.js': JS }, ['/x']);
    expect(await resolvePluginTarget('/x', i)).toMatch(/\/x\/index\.js$/);
  });

  it('returns null for missing targets', async () => {
    const i = io({}, []);
    expect(await resolvePluginTarget('/gone', i)).toBeNull();
  });
});
