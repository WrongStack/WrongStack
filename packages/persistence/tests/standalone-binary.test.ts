import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cliSpawnArgs,
  daemonSpawnArgs,
  installedCliExecutable,
  isStandaloneBinary,
  moduleDirFor,
  moduleUrlFor,
  STANDALONE_DAEMON_ARG,
  STANDALONE_SCRIPT_ARG,
  type StandaloneDaemonName,
  scriptSpawnArgs,
  standaloneAssetRoot,
  standaloneBinaryBuildId,
  standaloneDaemonUrl,
  standaloneMain,
  standalonePackageDir,
  wrongstackPackageJsonPath,
} from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const g = globalThis as Record<string | symbol, unknown>;
const ASSET_KEY = Symbol.for('wrongstack.standalone-assets');
const BUILD_KEY = Symbol.for('wrongstack.standalone-build');
const WIN_ENTRY = 'B:/~BUN/root/wstack.exe';
const POSIX_ENTRY = '/$bunfs/root/wstack';

let savedArgv1: string | undefined;
let hadBun = false;

/**
 * Pretend to be the compiled executable: Bun global + bunfs argv[1], and
 * optionally the asset root the bootstrap extracted and the main it stamped.
 */
function enterBinary(entry = WIN_ENTRY, assetRoot?: string, main?: 'cli' | 'engine'): void {
  savedArgv1 = process.argv[1];
  hadBun = 'Bun' in g;
  if (!hadBun) g.Bun = {};
  process.argv[1] = entry;
  if (assetRoot !== undefined) g[ASSET_KEY] = assetRoot;
  if (main !== undefined) g[BUILD_KEY] = { main };
}

afterEach(() => {
  if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  savedArgv1 = undefined;
  if (!hadBun) delete g.Bun;
  delete g[ASSET_KEY];
  delete g[BUILD_KEY];
});

describe('isStandaloneBinary', () => {
  it('is false for a normal script entry, even under Bun', () => {
    enterBinary('/usr/lib/node_modules/@wrongstack/cli/dist/index.js');
    expect(isStandaloneBinary()).toBe(false);
  });

  it('recognises both bunfs roots, but only with the Bun global present', () => {
    expect(isStandaloneBinary(WIN_ENTRY)).toBe('Bun' in g);
    enterBinary();
    expect(isStandaloneBinary(WIN_ENTRY)).toBe(true);
    expect(isStandaloneBinary('B:\\~BUN\\root\\wstack.exe')).toBe(true);
    expect(isStandaloneBinary(POSIX_ENTRY)).toBe(true);
    expect(isStandaloneBinary('')).toBe(false);
  });
});

describe('standaloneMain', () => {
  it('is undefined outside a compiled executable, whatever a stamp left behind says', () => {
    g[BUILD_KEY] = { main: 'engine' };
    enterBinary('/usr/lib/node_modules/@wrongstack/cli/dist/index.js');
    expect(standaloneMain()).toBeUndefined();
  });

  it("reads the executable's main: the CLI unless its entry declared the engine", () => {
    enterBinary();
    expect(standaloneMain()).toBe('cli');
    // What the desktop engine's entry hands the shared bootstrap.
    g[BUILD_KEY] = { main: 'engine' };
    expect(standaloneMain()).toBe('engine');
  });
});

describe('installedCliExecutable', () => {
  it("is the installer's `bin/wstack` under the global root, when it is there", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-installed-cli-'));
    const file = path.join(root, 'bin', process.platform === 'win32' ? 'wstack.exe' : 'wstack');
    try {
      expect(installedCliExecutable(root)).toBeUndefined();
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, '');
      expect(installedCliExecutable(root)).toBe(file);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('daemon spawn argv', () => {
  it('passes the built script through unchanged in an install', () => {
    const script = path.resolve('dist/project-server.js');
    expect(daemonSpawnArgs(pathToFileURL(script), ['--project-root', 'x'])).toEqual([
      script,
      '--project-root',
      'x',
    ]);
  });

  it('routes an embedded daemon through the hidden dispatch', () => {
    const names: StandaloneDaemonName[] = [
      'chronicle',
      'mailbox',
      'session-catalog',
      'governance',
      'kanban',
      'sage',
      'codebase-index',
    ];
    for (const name of names) {
      expect(daemonSpawnArgs(standaloneDaemonUrl(name), ['--a', 'b'])).toEqual([
        STANDALONE_DAEMON_ARG,
        name,
        '--a',
        'b',
      ]);
    }
  });
});

describe('CLI and script re-launch argv', () => {
  it('keeps the entry script in an install', () => {
    expect(cliSpawnArgs('/x/cli/dist/index.js', ['--no-interactive'])).toEqual([
      '/x/cli/dist/index.js',
      '--no-interactive',
    ]);
    expect(scriptSpawnArgs('/p/node_modules/eslint/bin/eslint.js', ['--format=json'])).toEqual([
      '/p/node_modules/eslint/bin/eslint.js',
      '--format=json',
    ]);
  });

  it('drops the CLI entry and wraps scripts in the binary', () => {
    enterBinary();
    expect(cliSpawnArgs(WIN_ENTRY, ['mailbox', 'serve'])).toEqual(['mailbox', 'serve']);
    expect(scriptSpawnArgs('/p/bin.js', ['a'])).toEqual([STANDALONE_SCRIPT_ARG, '/p/bin.js', 'a']);
  });
});

describe('asset root resolution', () => {
  it('is inert outside the binary even if the global is set', () => {
    g[ASSET_KEY] = '/should/not/be/used';
    expect(standaloneAssetRoot()).toBeNull();
    expect(standalonePackageDir('@wrongstack/core')).toBeNull();
    expect(moduleDirFor(import.meta.url, '@wrongstack/core')).toBe(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    expect(moduleUrlFor(import.meta.url, '@wrongstack/core')).toBe(import.meta.url);
    expect(wrongstackPackageJsonPath('@wrongstack/core', (id) => `resolved:${id}`)).toBe(
      'resolved:@wrongstack/core/package.json',
    );
  });

  it('maps packages into the extracted tree so relative lookups keep working', () => {
    const assets = path.resolve('/tmp/wstack-runtime/1.0.0-abc');
    enterBinary(POSIX_ENTRY, assets);
    expect(standalonePackageDir('@wrongstack/core')).toBe(path.join(assets, 'core'));
    expect(wrongstackPackageJsonPath('@wrongstack/hq-next', () => 'unused')).toBe(
      path.join(assets, 'hq-next', 'package.json'),
    );
    const dir = moduleDirFor('file:///B:/%7EBUN/root/wstack.exe', '@wrongstack/core');
    expect(path.resolve(dir, '../instructions')).toBe(path.join(assets, 'core', 'instructions'));
    const wasm = new URL('./wasm/', moduleUrlFor(import.meta.url, '@wrongstack/tools'));
    expect(fileURLToPath(wasm)).toBe(path.join(assets, 'tools', 'dist', 'wasm') + path.sep);
  });

  it('falls back to normal lookup when the entry could not extract assets', () => {
    enterBinary();
    expect(standaloneAssetRoot()).toBeNull();
    expect(wrongstackPackageJsonPath('@wrongstack/core', (id) => `resolved:${id}`)).toBe(
      'resolved:@wrongstack/core/package.json',
    );
  });
});

describe('standaloneBinaryBuildId', () => {
  it('is stable for one executable', () => {
    const id = standaloneBinaryBuildId();
    expect(id).toMatch(/^standalone:[0-9a-z]+:[0-9a-z]+$/);
    expect(standaloneBinaryBuildId()).toBe(id);
  });
});

/**
 * The binary entry and the spawn sites are two halves of one contract: every
 * daemon a client can ask for must be dispatched by the entry, from a module
 * the build actually emits.
 */
describe('binary entry contract', () => {
  const entry = fs.readFileSync(path.join(repoRoot, 'scripts/binary/entry.mjs'), 'utf8');
  const daemonNames = [...entry.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);

  it('dispatches exactly the daemons the spawn sites can request', () => {
    const helper = fs.readFileSync(
      path.join(repoRoot, 'packages/persistence/src/standalone-binary.ts'),
      'utf8',
    );
    const union = helper.slice(helper.indexOf('export type StandaloneDaemonName'));
    const declared = [...union.slice(0, union.indexOf(';')).matchAll(/'([a-z-]+)'/g)].map(
      (m) => m[1],
    );
    expect([...daemonNames].sort()).toEqual([...declared].sort());
  });

  it('imports daemon modules the package builds emit as their own entries', () => {
    const build = fs.readFileSync(path.join(repoRoot, 'scripts/build-package.mjs'), 'utf8');
    const imports = [
      ...entry.matchAll(/import\('\.\.\/\.\.\/packages\/([a-z-]+)\/dist\/([^']+)\.js'\)/g),
    ];
    expect(imports.length).toBeGreaterThanOrEqual(daemonNames.length);
    for (const [, pkg, distPath] of imports) {
      if (pkg === 'cli' || distPath === undefined) continue;
      const source = `src/${distPath}`;
      const leaf = path.posix.basename(distPath);
      // Either a `src/<path>.ts` entry or a named `'<leaf>': 'src/…'` entry.
      expect(build.includes(`'${source}.ts'`) || build.includes(`'${leaf}': 'src/`)).toBe(true);
    }
  });

  it('uses the same hidden arguments as the runtime helpers', () => {
    // The dispatch on these arguments lives in the runtime shared by every binary entry.
    const runtime = fs.readFileSync(path.join(repoRoot, 'scripts/binary/runtime.mjs'), 'utf8');
    expect(entry).toContain("from './runtime.mjs'");
    expect(runtime).toContain(`const DAEMON_ARG = '${STANDALONE_DAEMON_ARG}';`);
    expect(runtime).toContain(`const SCRIPT_ARG = '${STANDALONE_SCRIPT_ARG}';`);
  });

  it('declares the CLI as its main, which the shared runtime stamps for every binary', () => {
    // `standaloneMain()` reads the stamp to tell the CLI binary from the desktop engine.
    expect(entry).toContain("main: 'cli',");
    const runtime = fs.readFileSync(path.join(repoRoot, 'scripts/binary/runtime.mjs'), 'utf8');
    expect(runtime).toMatch(/\{ main = 'cli', runMain, runDaemon \}/);
    expect(runtime).toMatch(/wrongstack\.standalone-build'\)\] = \{[^}]*\bmain,/);
  });
});
