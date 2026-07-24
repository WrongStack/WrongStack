import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  detectPackageManager,
  installCommand,
  parseArgs,
  runCommand,
  runSetup,
  type SetupDeps,
} from '../../src/setup.js';

describe('wrongstack-lsp-setup', () => {
  it('parses options and reports help/errors', () => {
    const base = deps();
    expect(
      parseArgs(
        ['--cwd', 'x', '--languages', 'typescript, python', '--dry-run', '--no-toolchains'],
        base,
      ),
    ).toMatchObject({ languages: ['typescript', 'python'], dryRun: true, toolchains: false });
    expect(() => parseArgs(['--cwd'], base)).toThrow('--cwd requires a value');
    expect(() => parseArgs(['--wat'], base)).toThrow('Unknown option');
    const exit = vi.fn(() => {
      throw new Error('exit');
    }) as never;
    expect(() => parseArgs(['--help'], { ...base, exit })).toThrow('exit');
    expect(base.log).toHaveBeenCalledWith(expect.stringContaining('wrongstack-lsp-setup'));
  });

  it('detects package managers and builds install commands', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-pm-'));
    expect(await detectPackageManager(root)).toBe('npm');
    await fs.writeFile(path.join(root, 'yarn.lock'), '');
    expect(await detectPackageManager(root)).toBe('yarn');
    await fs.writeFile(path.join(root, 'bun.lock'), '');
    expect(await detectPackageManager(root)).toBe('bun');
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '');
    expect(await detectPackageManager(root)).toBe('pnpm');
    expect(installCommand('npm', ['a'])).toEqual({ command: 'npm', args: ['install', '-D', 'a'] });
    expect(installCommand('pnpm', ['a'])).toEqual({ command: 'pnpm', args: ['add', '-D', 'a'] });
    expect(installCommand('yarn', ['a'])).toEqual({ command: 'yarn', args: ['add', '-D', 'a'] });
    expect(installCommand('bun', ['a'])).toEqual({ command: 'bun', args: ['add', '-d', 'a'] });
  });

  it('dry-runs npm and toolchain installs, skips installed binaries, and validates languages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-setup-'));
    await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '');
    const d = deps(root);
    d.resolveServerCommand = vi.fn(async (binary) =>
      binary === 'pyright-langserver' ? '/bin/pyright' : null,
    );
    d.commandExistsOnPath = vi.fn(async (command) => command === 'go');

    await runSetup(['--cwd', root, '--languages', 'typescript,python,go,rust', '--dry-run'], d);

    expect(d.log).toHaveBeenCalledWith('Already available: python');
    expect(d.log).toHaveBeenCalledWith(
      expect.stringContaining('pnpm add -D typescript typescript-language-server'),
    );
    expect(d.log).toHaveBeenCalledWith(
      expect.stringContaining('Installing via Go toolchain: go install'),
    );
    expect(d.log).toHaveBeenCalledWith('Missing Rust toolchain: command "rustup" is not on PATH.');
    await expect(runSetup(['--languages', 'wat'], d)).rejects.toThrow('Unknown language');
  });

  it('runs real install commands when not dry-run and honors --no-toolchains', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-setup-run-'));
    const d = deps(root);
    d.resolveServerCommand = vi.fn(async () => null);
    await runSetup(['--languages', 'ruby', '--no-toolchains'], d);
    expect(d.log).toHaveBeenCalledWith(
      'Skipping RubyGems; rerun without --no-toolchains to install.',
    );

    await runSetup(['--languages', 'typescript'], d);
    expect(d.run).toHaveBeenCalledWith(
      'npm',
      ['install', '-D', 'typescript', 'typescript-language-server'],
      root,
    );
  });

  it('runs child commands and rejects failing exits', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(0)'], process.cwd()),
    ).resolves.toBeUndefined();
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(7)'], process.cwd()),
    ).rejects.toThrow('code 7');
    await expect(
      runCommand('definitely-missing-wrongstack-command', [], process.cwd()),
    ).rejects.toBeTruthy();
  });
});

function deps(cwd = process.cwd()): SetupDeps {
  return {
    resolveServerCommand: vi.fn(async () => null),
    commandExistsOnPath: vi.fn(async () => false),
    run: vi.fn(async () => undefined),
    log: vi.fn(),
    cwd: () => cwd,
    exit: ((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never,
  };
}
