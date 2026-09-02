import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Logger, Plugin } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadExternalPlugins } from '../src/wiring/external-plugins.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const hooks = {
  nameFromSpec: () => null,
  isBuiltinSpec: () => false,
  warnIfDeprecated: () => false,
};

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function makeConfig(plugins: Config['plugins']): Config {
  return {
    version: 1,
    features: { plugins: true, mcp: false, modelsRegistry: false, skills: false },
    plugins,
  } as unknown as Config;
}

function pluginFixture(name: string): Plugin {
  return { name, apiVersion: '^0.1', setup: () => undefined } as Plugin;
}

/** importModule stub keyed by import target (file URL or bare spec). */
function importStub(fixtures: Record<string, Plugin>) {
  const calls: string[] = [];
  const importModule = async (target: string): Promise<unknown> => {
    calls.push(target);
    const key = target.startsWith('file:') ? (fileURLToPath(target) as string) : target;
    const plugin = fixtures[key] ?? fixtures[target];
    if (!plugin) throw new Error(`no fixture for ${target}`);
    return { default: plugin };
  };
  return { importModule, calls };
}

async function writeEntry(dir: string, contents = 'export default 1;'): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const entry = join(dir, 'index.js');
  await fs.writeFile(entry, contents, 'utf8');
  return entry;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadExternalPlugins — config path entries', () => {
  it('loads a path-entry plugin through a file:// import and pins it on first use', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'my-plugin'));
    const stub = importStub({ [entry]: pluginFixture('my-plugin') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'my-plugin', path: entry }]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );

    expect(loaded.map((p) => p.name)).toEqual(['my-plugin']);
    // The import target is the entry file as a file: URL.
    expect(stub.calls[0]).toMatch(/^file:\/\//);
    expect(stub.calls[0]).toContain('my-plugin');
    // First use wrote a TOFU pin keyed by the entry file.
    const store = JSON.parse(await fs.readFile(join(globalRoot, 'plugin-trust.json'), 'utf8')) as {
      pinned: Record<string, unknown>;
    };
    const pinKey = Object.keys(store.pinned)[0]!.replaceAll('\\', '/');
    expect(pinKey.endsWith('my-plugin/index.js')).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('resolves relative paths against the project root', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'rel-plugin'));
    const stub = importStub({ [entry]: pluginFixture('rel-plugin') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'rel-plugin', path: './rel-plugin' }]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(loaded).toHaveLength(1);
    expect(stub.calls[0]).toContain('rel-plugin');
  });

  it('REFUSES a plugin whose entry hash changed since the pin', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'changed-plugin'), 'export default 1;');
    // Pin a hash that does NOT match the file on disk.
    await fs.writeFile(
      join(globalRoot, 'plugin-trust.json'),
      JSON.stringify({
        pinned: {
          [entry.replaceAll('\\', '/')]: {
            entry,
            integrity: 'sha256-' + '0'.repeat(64),
            pinnedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    const stub = importStub({ [entry]: pluginFixture('changed-plugin') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'changed-plugin', path: entry }]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );

    expect(loaded).toEqual([]);
    expect(stub.calls).toEqual([]); // never even imported
    const refused = (log.error as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(refused).toContain('REFUSING');
    expect(refused).toContain('wstack plugin trust');
  });

  it('skips pinning entirely when features.pluginsTrust is false', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'no-trust-plugin'));
    const stub = importStub({ [entry]: pluginFixture('no-trust-plugin') });
    const config = makeConfig([{ name: 'no-trust-plugin', path: entry }]);
    (config.features as unknown as Record<string, unknown>).pluginsTrust = false;

    const loaded = await loadExternalPlugins(
      {
        config,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(loaded).toHaveLength(1);
    await expect(fs.access(join(globalRoot, 'plugin-trust.json'))).rejects.toThrow();
  });
});

describe('loadExternalPlugins — validation and guards', () => {
  it('rejects modules without a valid plugin shape', async () => {
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'bad'));
    const importModule = async () => ({ default: { name: 'x' } }); // no apiVersion/setup
    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'bad', path: entry }]),
        log,
        projectRoot,
        reservedNames: new Set(),
        importModule,
      },
      hooks,
    );
    expect(loaded).toEqual([]);
    const warned = (log.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain('invalid');
    expect(warned).toContain('apiVersion');
  });

  it('blocks external plugins that declare a reserved built-in name', async () => {
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, 'spoof'));
    const importModule = async () => ({ default: pluginFixture('lint-gate') });
    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'spoof', path: entry }]),
        log,
        projectRoot,
        reservedNames: new Set(['lint-gate']),
        importModule,
      },
      hooks,
    );
    expect(loaded).toEqual([]);
    const warned = (log.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join('\n');
    expect(warned).toContain('reserved name');
  });

  it('keeps the first plugin when two sources declare the same name', async () => {
    const projectRoot = await tempDir('ws-ext-project-');
    const entryOne = await writeEntry(join(projectRoot, 'one'));
    const entryTwo = await writeEntry(join(projectRoot, 'two'));
    const first = pluginFixture('dup');
    const second = pluginFixture('dup');
    const importModule = async (target: string) => ({
      default: String(target).includes('one') ? first : second,
    });
    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([
          { name: 'one', path: entryOne },
          { name: 'two', path: entryTwo },
        ]),
        log,
        projectRoot,
        reservedNames: new Set(),
        importModule,
      },
      hooks,
    );
    expect(loaded).toEqual([first]);
    expect(
      (log.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n'),
    ).toContain('duplicates');
  });
});

describe('loadExternalPlugins — directory discovery', () => {
  it('discovers user-global plugins (active by default)', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(globalRoot, 'plugins', 'disc-a'));
    const stub = importStub({ [entry]: pluginFixture('disc-a') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(loaded.map((p) => p.name)).toEqual(['disc-a']);
  });

  it('leaves project-local plugins inactive until explicitly enabled', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(projectRoot, '.wrongstack', 'plugins', 'local-b'));
    const stub = importStub({ [entry]: pluginFixture('local-b') });

    const inactive = await loadExternalPlugins(
      {
        config: makeConfig([]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(inactive).toEqual([]);
    expect(stub.calls).toEqual([]);

    const enabledConfig = makeConfig([]);
    (enabledConfig as { extensions?: Record<string, unknown> }).extensions = {
      'local-b': { enabled: true },
    };
    const active = await loadExternalPlugins(
      {
        config: enabledConfig,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(active.map((p) => p.name)).toEqual(['local-b']);
  });

  it('prefers a config.plugins entry over a discovered plugin with the same name', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    await writeEntry(join(globalRoot, 'plugins', 'shared'));
    const stub = importStub({ shared: pluginFixture('shared') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig(['shared']),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      {
        ...hooks,
        nameFromSpec: (spec) => (spec === 'shared' ? 'shared' : null),
      },
    );
    expect(loaded).toHaveLength(1);
    // Only the config-spec import happened; the discovery candidate was skipped.
    expect(stub.calls).toEqual(['shared']);
    expect(
      (log.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n'),
    ).toContain('config entry wins');
  });

  it('respects enablement for discovered plugins via plugins[] entries', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    const entry = await writeEntry(join(globalRoot, 'plugins', 'disc-off'));
    const stub = importStub({ [entry]: pluginFixture('disc-off') });

    const loaded = await loadExternalPlugins(
      {
        config: makeConfig([{ name: 'disc-off', enabled: false }]),
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: stub.importModule,
      },
      hooks,
    );
    expect(loaded).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it('respects the global features.plugins kill switch', async () => {
    const globalRoot = await tempDir('ws-ext-global-');
    const projectRoot = await tempDir('ws-ext-project-');
    await writeEntry(join(globalRoot, 'plugins', 'never'));
    const config = makeConfig([]);
    (config.features as unknown as Record<string, unknown>).plugins = false;
    const loaded = await loadExternalPlugins(
      {
        config,
        log,
        globalRoot,
        projectRoot,
        reservedNames: new Set(),
        importModule: async () => {
          throw new Error('should not import');
        },
      },
      hooks,
    );
    expect(loaded).toEqual([]);
  });
});
