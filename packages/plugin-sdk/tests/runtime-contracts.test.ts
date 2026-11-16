import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoundedMap,
  BoundedSet,
  clearLocalBinCache,
  type LanguageRuntime,
  parseLlmJsonObject,
  probeRunner,
  resolveNodeBin,
  resolveRunnerCommand,
  runOptionalPluginLlm,
  runRunnerCommand,
  stripOuterMarkdownFence,
} from '../src/runtime/index.js';

const directories: string[] = [];

afterEach(async () => {
  clearLocalBinCache();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe('runtime helper contracts', () => {
  it('returns false when deleting an already-expired entry from BoundedMap or BoundedSet', () => {
    let clock = 1_000;
    const map = new BoundedMap<string, number>({ max: 10, ttlMs: 100, now: () => clock });
    const set = new BoundedSet<string>({ max: 10, ttlMs: 100, now: () => clock });
    map.set('alpha', 1);
    set.add('alpha');

    clock = 1_200;
    expect(map.delete('alpha')).toBe(false);
    expect(set.delete('alpha')).toBe(false);
  });

  it('resolves secondary runtime subcommands and in-project absolute executable paths', () => {
    const projectRoot = path.resolve('/tmp/plugin-sdk-project');
    const runtime: LanguageRuntime = {
      id: 'typescript',
      packageManager: 'pnpm',
      executable: 'tsc',
      allowedFlags: new Set(['--noEmit', '--pretty']),
      subcommands: ['exec', 'dlx'],
      defaultCommand: 'tsc --noEmit',
    };
    const absExe = path.join(projectRoot, 'node_modules', '.bin', 'tsc');

    expect(resolveRunnerCommand(runtime, `${absExe} --noEmit`, { projectRoot })).toEqual({
      cmd: absExe,
      args: ['--noEmit'],
      display: `${absExe} --noEmit`,
    });
    expect(resolveRunnerCommand(runtime, 'pnpm dlx tsc --noEmit', { projectRoot })).toEqual({
      cmd: 'pnpm',
      args: ['dlx', 'tsc', '--noEmit'],
      display: 'pnpm dlx tsc --noEmit',
    });

    const absCmdShim = path.join(projectRoot, 'node_modules', '.bin', 'tsc.cmd');
    expect(resolveRunnerCommand(runtime, `${absCmdShim} --noEmit`, { projectRoot })).toEqual({
      cmd: absCmdShim,
      args: ['--noEmit'],
      display: `${absCmdShim} --noEmit`,
    });

    const absLauncher = path.join(projectRoot, 'bin', 'pnpm.cmd');
    expect(
      resolveRunnerCommand(runtime, `${absLauncher} exec tsc --noEmit`, { projectRoot }),
    ).toEqual({
      cmd: absLauncher,
      args: ['exec', 'tsc', '--noEmit'],
      display: `${absLauncher} exec tsc --noEmit`,
    });
    expect(
      resolveRunnerCommand(runtime, `${absLauncher} tsc --noEmit`, { projectRoot }),
    ).toBeNull();
  });

  it('strips indented or single-line outer markdown fences and classifies parse throws as invalid-response', async () => {
    expect(parseLlmJsonObject('```json\n{"ok":true}\n  ```')).toEqual({ ok: true });
    expect(parseLlmJsonObject('```json {"ok":true,"n":2} ```')).toEqual({ ok: true, n: 2 });
    expect(stripOuterMarkdownFence('```md\nLine 1\n```ts\nx\n```\n  ```')).toBe(
      'Line 1\n```ts\nx\n```',
    );

    const res = await runOptionalPluginLlm({
      requested: true,
      prompt: 'return json',
      label: 'test',
      api: {
        llm: { complete: async () => ({ text: '{malformed' }) } as never,
        log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      },
      parse: (text) => JSON.parse(text) as { ok: boolean },
    });
    expect(res).toEqual({
      used: false,
      value: null,
      fallbackReason: 'invalid-response',
    });
  });

  it('keeps the hard bound when undefined is a valid map key', () => {
    const map = new BoundedMap<string | undefined, number>({ max: 1 });

    map.set(undefined, 1);
    map.set('newest', 2);

    expect(map.size).toBe(1);
    expect(map.has(undefined)).toBe(false);
    expect(map.get('newest')).toBe(2);
    expect(map.evictionCount).toBe(1);
  });

  it('resolves a relative runner cwd against the declared project root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sdk-runner-'));
    directories.push(root);
    const relativeCwd = 'nested-workspace';
    const expectedCwd = path.join(root, relativeCwd);
    await fs.mkdir(expectedCwd);

    const result = await runRunnerCommand(
      [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
      { cwd: relativeCwd, projectRoot: root, timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({ code: 0, timedOut: false, spawnError: false });
    expect(path.resolve(result.stdout)).toBe(path.resolve(expectedCwd));
  });

  it('rejects package bin entries that do not resolve to a file inside the package', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-sdk-bin-'));
    directories.push(root);
    const packageRoot = path.join(root, 'node_modules', 'sdk-bin-fixture');
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'sdk-bin-fixture', bin: { fixture: 'missing.js' } }),
    );

    expect(resolveNodeBin('sdk-bin-fixture', 'fixture', root)).toBeNull();

    const outside = path.join(root, 'outside-bin');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'runner.js'), 'process.stdout.write("escaped")');
    const linkedBin = path.join(packageRoot, 'linked-bin');
    try {
      await fs.symlink(outside, linkedBin, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'sdk-bin-fixture', bin: { fixture: 'linked-bin/runner.js' } }),
    );
    clearLocalBinCache();

    expect(resolveNodeBin('sdk-bin-fixture', 'fixture', root)).toBeNull();
  });

  it.each([new Set(['--check']), null])(
    'probeRunner allows the probe flag without mutating allowedFlags (%s) (F855)',
    async (allowedFlags) => {
      const runtime: LanguageRuntime = {
        id: 'javascript',
        packageManager: 'none',
        // Bun's --bun test runner shadows `node` with its compatibility shim,
        // which rejects a standalone --version. Probe the pinned runtime itself.
        executable: 'bun',
        subcommands: [],
        allowedFlags,
        defaultCommand: 'bun --version',
      };
      const ok = await probeRunner(runtime, '--version', {
        cwd: process.cwd(),
        projectRoot: process.cwd(),
        timeoutMs: 5_000,
      });
      expect(ok).toBe(true);
      expect(runtime.allowedFlags?.has('--version') ?? false).toBe(false);
    },
  );

  it('strips UTF-8 BOM and ignores non-object package.json in resolveNodeBin (F487)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-bin-bom-'));
    try {
      const pkgDir = path.join(root, 'node_modules', 'demo-bin');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(pkgDir, 'cli.js'), 'console.log("ok");\n', 'utf8');
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        `\uFEFF${JSON.stringify({ name: 'demo-bin', bin: { 'demo-bin': 'cli.js' } })}`,
        'utf8',
      );
      clearLocalBinCache();
      expect(resolveNodeBin('demo-bin', 'demo-bin', root)).not.toBeNull();

      await fs.writeFile(path.join(pkgDir, 'package.json'), 'null', 'utf8');
      clearLocalBinCache();
      expect(resolveNodeBin('demo-bin', 'demo-bin', root)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
