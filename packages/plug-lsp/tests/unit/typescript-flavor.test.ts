import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoDiscoverServers } from '../../src/auto-discover.js';
import {
  detectTypeScriptFlavor,
  typeScriptPresetFor,
  workspaceTypeScriptMajor,
} from '../../src/typescript-flavor.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function workspace(version: string | null): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-flavor-'));
  dirs.push(root);
  if (version !== null) {
    const dir = path.join(root, 'node_modules', 'typescript');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version }));
  }
  return root;
}

describe('workspaceTypeScriptMajor', () => {
  it('reads the nearest workspace TypeScript', async () => {
    expect(await workspaceTypeScriptMajor(await workspace('7.0.2'))).toBe(7);
    expect(await workspaceTypeScriptMajor(await workspace('5.9.3'))).toBe(5);
  });

  it('walks up from a nested directory', async () => {
    const root = await workspace('7.0.2');
    const nested = path.join(root, 'packages', 'a', 'src');
    await fs.mkdir(nested, { recursive: true });
    expect(await workspaceTypeScriptMajor(nested)).toBe(7);
  });

  it('is undefined when the project has no TypeScript, or a broken manifest', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-flavor-bare-'));
    dirs.push(bare);
    // A temp dir is under the OS temp root, which has no node_modules chain.
    expect(await workspaceTypeScriptMajor(bare)).toBeUndefined();

    const broken = await workspace('not-a-version');
    expect(await workspaceTypeScriptMajor(broken)).toBeUndefined();

    // A manifest with a non-string version stops the walk rather than
    // falling through to some unrelated TypeScript further up the tree.
    const numeric = await workspace(null);
    const dir = path.join(numeric, 'node_modules', 'typescript');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ version: 7 }));
    expect(await workspaceTypeScriptMajor(numeric)).toBeUndefined();
  });
});

describe('typeScriptPresetFor', () => {
  it('sends TypeScript 7 to the native server and everything else to tsserver', async () => {
    expect(await detectTypeScriptFlavor(await workspace('7.0.2'))).toBe('native');
    expect(await detectTypeScriptFlavor(await workspace('5.9.3'))).toBe('tsserver');
    expect(typeScriptPresetFor('native')).toBe('typescript-native');
    expect(typeScriptPresetFor('tsserver')).toBe('typescript');
    // A bare `tsc` on PATH with no workspace TypeScript is usually an
    // unrelated global install — guessing native there spawns a compiler that
    // never speaks LSP.
    expect(typeScriptPresetFor('unknown')).toBe('typescript');
  });
});

describe('autoDiscoverServers TypeScript selection', () => {
  const resolver = vi.hoisted(() => ({ resolve: vi.fn() }));
  vi.mock('../../src/utils/command-resolver.js', () => ({
    resolveServerCommand: (command: string) => resolver.resolve(command),
  }));

  it('discovers only the native server on a TypeScript 7 workspace', async () => {
    resolver.resolve.mockImplementation(async (command: string) =>
      command === 'tsc' || command === 'typescript-language-server' ? `/bin/${command}` : null,
    );
    const servers = await autoDiscoverServers({}, await workspace('7.0.2'));
    expect(Object.keys(servers)).toEqual(['typescript-native']);
    expect(servers['typescript-native']?.args).toEqual(['--lsp', '--stdio']);
  });

  it('discovers only tsserver on a TypeScript 5 workspace', async () => {
    resolver.resolve.mockImplementation(async (command: string) =>
      command === 'tsc' || command === 'typescript-language-server' ? `/bin/${command}` : null,
    );
    const servers = await autoDiscoverServers({}, await workspace('5.9.3'));
    expect(Object.keys(servers)).toEqual(['typescript']);
  });

  it('never probes for a TypeScript server the user configured by hand', async () => {
    // The mock is module-scoped; earlier cases in this file already probed.
    resolver.resolve.mockClear();
    resolver.resolve.mockResolvedValue(null);
    const mine = { command: 'my-tsls', languages: ['typescript'] };
    const servers = await autoDiscoverServers({ typescript: mine }, await workspace('7.0.2'));
    expect(servers['typescript']).toBe(mine);
    expect(servers['typescript-native']).toBeUndefined();
    expect(resolver.resolve).not.toHaveBeenCalledWith('tsc');
  });
});
