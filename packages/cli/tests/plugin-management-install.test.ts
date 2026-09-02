import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderConfiguredPlugins,
  renderPluginAuditReport,
  runPluginManagementCommand,
} from '../src/plugin-management.js';

let tmpDir: string;
let globalRoot: string;
let configPath: string;

function config(overrides: Partial<Config> = {}): Config {
  return {
    features: { plugins: true },
    ...overrides,
  } as Config;
}

async function readConfigFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
}

async function writePluginPackage(name: string, contents = 'export default 1;'): Promise<string> {
  if (!/^@?[a-z0-9/-]+$/i.test(name) || name.includes('..')) {
    throw new Error(`unsafe test package name: ${name}`);
  }
  const modulesRoot = path.resolve(globalRoot, 'plugins', 'node_modules');
  const dir = path.resolve(modulesRoot, name);
  if (dir !== modulesRoot && !dir.startsWith(modulesRoot + path.sep)) {
    throw new Error(`test package dir escaped node_modules: ${dir}`);
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), contents, 'utf8');
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', main: './index.js' }),
    'utf8',
  );
  return path.join(dir, 'index.js');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plugin-install-'));
  globalRoot = path.join(tmpDir, 'home', '.wrongstack');
  configPath = path.join(tmpDir, 'config.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('wstack plugin add --install', () => {
  it('installs via the detected package manager and registers a path entry', async () => {
    // Detection falls back to npm when no --pm override is given; pin the
    // ambient user agent (vitest itself may run under pnpm/yarn/bun) so the
    // expectation is deterministic on every developer machine and in CI.
    vi.stubEnv('npm_config_user_agent', 'npm/10.9.0 node/v22.19.0 linux x64');

    // The fake install: pretend npm laid the package down.
    await writePluginPackage('wstack-plugin-x');
    const runPackageManager = vi.fn(async (_pm: string, args: readonly string[], _cwd: string) => {
      expect(args).toContain('wstack-plugin-x');
      expect(args).toContain('--ignore-scripts');
      return { code: 0, stdout: 'added 1 package', stderr: '' };
    });

    const result = await runPluginManagementCommand(['add', 'wstack-plugin-x', '--install'], {
      config: config(),
      configPath,
      globalRoot,
      runPackageManager,
    });

    expect(result.code).toBe(0);
    expect(result.message).toContain('Installed');
    expect(result.message).toContain('--ignore-scripts');
    expect(runPackageManager).toHaveBeenCalledTimes(1);
    const [pm, args, cwd] = runPackageManager.mock.calls[0]!;
    expect(pm).toBe('npm');
    expect(args).toContain('--prefix');
    expect(cwd.replaceAll('\\', '/')).toContain('plugins');
    // Config received a { name, path, enabled } entry pointing at the install.
    const written = await readConfigFile();
    const plugins = written.plugins as Array<Record<string, unknown>>;
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({ name: 'wstack-plugin-x', enabled: true });
    expect(String(plugins[0]!.path).replaceAll('\\', '/')).toContain(
      'node_modules/wstack-plugin-x',
    );
    // The bootstrap manifest exists for future --prefix installs.
    const bootstrap = JSON.parse(
      await fs.readFile(path.join(globalRoot, 'plugins', 'package.json'), 'utf8'),
    ) as { private: boolean };
    expect(bootstrap.private).toBe(true);
    // The registered path exists on disk (the faked install target).
    await expect(fs.access(String(plugins[0]!.path))).resolves.toBeUndefined();
  });

  it('honours --pm=pnpm and --run-scripts', async () => {
    await writePluginPackage('wstack-plugin-y');
    const runPackageManager = vi.fn(
      async (_pm: string, _args: readonly string[], _cwd: string) => ({
        code: 0,
        stdout: '',
        stderr: '',
      }),
    );

    const result = await runPluginManagementCommand(
      ['add', 'wstack-plugin-y', '--install', '--pm=pnpm', '--run-scripts'],
      { config: config(), configPath, globalRoot, runPackageManager },
    );

    expect(result.code).toBe(0);
    const [pm, args] = runPackageManager.mock.calls[0]!;
    expect(pm).toBe('pnpm');
    expect(args[0]).toBe('add');
    expect(args).toContain('--dir');
    expect(args).not.toContain('--ignore-scripts');
  });

  it('surfaces package-manager failures with the stderr tail', async () => {
    const result = await runPluginManagementCommand(['add', 'wstack-plugin-z', '--install'], {
      config: config(),
      configPath,
      globalRoot,
      runPackageManager: async () => ({
        code: 1,
        stdout: '',
        stderr: 'line1\nline2\n404 not found',
      }),
    });
    expect(result.code).toBe(1);
    expect(result.level).toBe('error');
    expect(result.message).toContain('404 not found');
    // Nothing was written to config on failure.
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('routes official aliases to plain registration (no install)', async () => {
    const result = await runPluginManagementCommand(['add', 'lsp', '--install'], {
      config: config(),
      configPath,
      globalRoot,
      runPackageManager: async () => {
        throw new Error('must not run');
      },
    });
    expect(result.code).toBe(0);
    expect(result.message).toContain('Added');
  });
});

describe('wstack plugin trust', () => {
  it('lists, re-pins, and removes pins for config path entries', async () => {
    const entry = await writePluginPackage('wstack-plugin-t', 'export default 1;');
    const deps = {
      config: config({ plugins: [{ name: 'wstack-plugin-t', path: entry } as never] }),
      configPath,
      globalRoot,
    };

    // Pin something wrong (as if the code had changed).
    const trustPath = path.join(globalRoot, 'plugin-trust.json');
    await fs.mkdir(globalRoot, { recursive: true });
    await fs.writeFile(
      trustPath,
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

    const list = await runPluginManagementCommand(['trust', '--list'], deps);
    expect(list.code).toBe(0);
    expect(list.message).toContain('Pinned external plugins');
    expect(list.message).toContain('wstack-plugin-t/index.js');

    const repin = await runPluginManagementCommand(['trust', 'wstack-plugin-t'], deps);
    expect(repin.code).toBe(0);
    expect(repin.message).toContain('Re-pinned');
    const afterRepin = JSON.parse(await fs.readFile(trustPath, 'utf8')) as {
      pinned: Record<string, { integrity: string }>;
    };
    const pin = afterRepin.pinned[entry.replaceAll('\\', '/')];
    expect(pin).toBeDefined();
    expect(pin!.integrity).not.toBe('sha256-' + '0'.repeat(64));

    const remove = await runPluginManagementCommand(['trust', 'wstack-plugin-t', '--remove'], deps);
    expect(remove.code).toBe(0);
    const afterRemove = JSON.parse(await fs.readFile(trustPath, 'utf8')) as {
      pinned: Record<string, unknown>;
    };
    expect(afterRemove.pinned[entry.replaceAll('\\', '/')]).toBeUndefined();
  });

  it('errors clearly for unresolvable names', async () => {
    const result = await runPluginManagementCommand(['trust', 'ghost-plugin'], {
      config: config(),
      configPath,
      globalRoot,
    });
    expect(result.code).toBe(1);
    expect(result.message).toContain('Could not resolve');
  });
});

describe('plugin listings mark external plugins', () => {
  it('shows (external) for path entries and risk=external in the audit report', () => {
    const cfg = config({
      plugins: [
        { name: 'wstack-plugin-x', path: '/somewhere/node_modules/wstack-plugin-x' } as never,
      ],
    });
    expect(renderConfiguredPlugins(cfg)).toContain('wstack-plugin-x (external)');
    const report = renderPluginAuditReport(cfg);
    expect(report).toContain('risk=external');
    expect(report).toContain('/somewhere/node_modules/wstack-plugin-x');
  });

  it('keeps plain custom entries as risk=custom', () => {
    const cfg = config({ plugins: ['some-user-plugin'] });
    const report = renderPluginAuditReport(cfg);
    expect(report).toContain('risk=custom');
    expect(report).not.toContain('risk=external');
  });
});
