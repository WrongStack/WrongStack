import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock };
});

import lintGatePlugin from '../src/lint-gate/index.js';

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { cwd: string; extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

interface StatusTool {
  execute(input: unknown): Promise<{ linter: string }>;
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function makeApi(cwd: string, options: Record<string, unknown> = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { cwd, extensions: { 'lint-gate': options } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getStatusTool(api: MockApi): StatusTool {
  const call = api.tools.register.mock.calls.find(
    ([tool]: unknown[]) => (tool as { name: string }).name === 'lint_gate_status',
  );
  if (!call) throw new Error('lint_gate_status not registered');
  return call[0] as StatusTool;
}

function getHook(api: MockApi): (input: unknown) => Promise<unknown> {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('lint-gate hook not registered');
  return call[2] as (input: unknown) => Promise<unknown>;
}

function completeExecCall(callIndex: number, error: Error | null, stdout = ''): void {
  const call = execFileMock.mock.calls[callIndex];
  if (!call) throw new Error(`execFile call ${callIndex} missing`);
  const callback = call[3] as ExecFileCallback;
  callback(error, stdout, '');
}

async function installFakeLinter(
  root: string,
  packageName: string,
  binName: string,
  relativeBin: string,
): Promise<string> {
  const packageDir = path.join(root, 'node_modules', ...packageName.split('/'));
  const entry = path.join(packageDir, relativeBin);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', bin: { [binName]: relativeBin } }),
    'utf-8',
  );
  await fs.writeFile(entry, '#!/usr/bin/env node\n', 'utf-8');
  // The plugin's resolver returns realpath-resolved entries; on macOS
  // os.tmpdir() (/var/folders/...) is a symlink to /private/var/...,
  // so the expected value must be realpath-resolved too or every
  // equality assertion diverges on darwin (plugin-guards macos-latest).
  return fs.realpath(entry);
}

describe('lint-gate local linter resolution', () => {
  let projectRoot: string;
  let api: MockApi | undefined;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-gate-platform-'));
    // Canonicalize the root once: macOS symlinks /var to /private/var, and
    // the resolver's entry path goes through require.resolve's toRealPath,
    // so the root must match that form or every path assertion diverges.
    // On Windows neither side expands 8.3 short names — require.resolve's
    // toRealPath and fs.promises.realpath share the same JS semantics, so
    // forms match by construction (only realpathSync.native expands them).
    projectRoot = await fs.realpath(projectRoot);
    await fs.writeFile(path.join(projectRoot, 'package.json'), '{"private":true}', 'utf-8');
    execFileMock.mockReset();
  });

  afterEach(async () => {
    if (api) lintGatePlugin.teardown?.(api as never);
    await fs.rm(projectRoot, { recursive: true, force: true });
    api = undefined;
  });

  it('prefers the project-local Biome entry and never invokes a Windows command shim', async () => {
    const biomeEntry = await installFakeLinter(
      projectRoot,
      '@biomejs/biome',
      'biome',
      'bin/biome.js',
    );
    await installFakeLinter(projectRoot, 'eslint', 'eslint', 'bin/eslint.js');

    execFileMock.mockImplementationOnce(() => {
      queueMicrotask(() => completeExecCall(0, null, 'Version: 1.0.0'));
      return {} as never;
    });

    api = makeApi(projectRoot);
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});

    expect(status.linter).toBe('biome');
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      [biomeEntry, '--version'],
      expect.objectContaining({ cwd: projectRoot, shell: false, windowsHide: true }),
      expect.any(Function),
    );
    const [command, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(command.toLowerCase()).not.toMatch(/(?:npx|\.cmd)$/);
    expect(args.every((arg) => !arg.toLowerCase().endsWith('.cmd'))).toBe(true);
  });

  it('falls back to the project-local ESLint entry when the Biome probe fails', async () => {
    const biomeEntry = await installFakeLinter(
      projectRoot,
      '@biomejs/biome',
      'biome',
      'bin/biome.js',
    );
    const eslintEntry = await installFakeLinter(projectRoot, 'eslint', 'eslint', 'bin/eslint.js');

    execFileMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => completeExecCall(0, new Error('Biome probe failed')));
        return {} as never;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => completeExecCall(1, null, 'v1.0.0'));
        return {} as never;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => completeExecCall(2, null, '[]'));
        return {} as never;
      });

    api = makeApi(projectRoot);
    lintGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    await getHook(api)({
      toolName: 'write',
      toolInput: { path: path.join(projectRoot, 'example.ts'), content: 'const x = 1;\n' },
    });

    expect(status.linter).toBe('eslint');
    expect(execFileMock.mock.calls.slice(0, 2).map((call) => call[1])).toEqual([
      [biomeEntry, '--version'],
      [eslintEntry, '--version'],
    ]);
    const lintCall = execFileMock.mock.calls[2];
    if (!lintCall) throw new Error('ESLint call missing');
    expect((lintCall[1] as string[]).slice(0, 2)).toEqual([eslintEntry, '--format=json']);
    expect(execFileMock.mock.calls.every((call) => call[0] === process.execPath)).toBe(true);
  });

  it('uses config.cwd for package resolution and child-process execution', async () => {
    const biomeEntry = await installFakeLinter(
      projectRoot,
      '@biomejs/biome',
      'biome',
      'bin/biome.js',
    );
    expect(path.resolve(projectRoot)).not.toBe(process.cwd());

    execFileMock.mockImplementationOnce(() => {
      queueMicrotask(() => completeExecCall(0, null, 'Version: 1.0.0'));
      return {} as never;
    });

    api = makeApi(projectRoot, { linter: 'biome' });
    lintGatePlugin.setup(api as never);
    await getStatusTool(api).execute({});

    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      [biomeEntry, '--version'],
      expect.objectContaining({ cwd: path.resolve(projectRoot), shell: false }),
      expect.any(Function),
    );
  });

  it('runs lint through the same local Node entry instead of npx or a .cmd shim', async () => {
    const biomeEntry = await installFakeLinter(
      projectRoot,
      '@biomejs/biome',
      'biome',
      'bin/biome.js',
    );

    execFileMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => completeExecCall(0, null, 'Version: 1.0.0'));
        return {} as never;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => completeExecCall(1, null, '{"diagnostics":[]}'));
        return {} as never;
      });

    api = makeApi(projectRoot, { linter: 'biome' });
    lintGatePlugin.setup(api as never);
    await getHook(api)({
      toolName: 'write',
      toolInput: { path: path.join(projectRoot, 'src', 'example.ts'), content: 'const x = 1;\n' },
    });

    const lintCall = execFileMock.mock.calls[1] as [
      string,
      string[],
      { cwd: string; shell: boolean },
    ];
    expect(lintCall[0]).toBe(process.execPath);
    expect(lintCall[1].slice(0, 3)).toEqual([biomeEntry, 'check', '--reporter=json']);
    expect(lintCall[1].at(-1)).toMatch(/lint-gate-.*input\.ts$/);
    expect(lintCall[2]).toEqual(expect.objectContaining({ cwd: projectRoot, shell: false }));
  });

  it.each([
    {
      name: 'Biome',
      linter: 'biome' as const,
      packageName: '@biomejs/biome',
      relativeBin: 'bin/biome.js',
      diagnostic: JSON.stringify({
        diagnostics: [{ category: 'lint/style/test', severity: 'error', description: 'fix me' }],
      }),
      fixArgs: ['check', '--write'],
    },
    {
      name: 'ESLint',
      linter: 'eslint' as const,
      packageName: 'eslint',
      relativeBin: 'bin/eslint.js',
      diagnostic: JSON.stringify([
        { messages: [{ ruleId: 'style/test', severity: 2, message: 'fix me', line: 1 }] },
      ]),
      fixArgs: ['--fix'],
    },
  ])(
    'builds $name fix arguments from the resolved local entry',
    async ({ linter, packageName, relativeBin, diagnostic, fixArgs }) => {
      const entry = await installFakeLinter(projectRoot, packageName, linter, relativeBin);
      execFileMock
        .mockImplementationOnce(() => {
          queueMicrotask(() => completeExecCall(0, null, 'Version: 1.0.0'));
          return {} as never;
        })
        .mockImplementationOnce(() => {
          queueMicrotask(() => completeExecCall(1, null, diagnostic));
          return {} as never;
        })
        .mockImplementationOnce(() => {
          queueMicrotask(() => completeExecCall(2, null, ''));
          return {} as never;
        });

      api = makeApi(projectRoot, { linter, mode: 'fix' });
      lintGatePlugin.setup(api as never);
      await getHook(api)({
        toolName: 'write',
        toolInput: { path: path.join(projectRoot, 'example.ts'), content: 'const x=1;\n' },
      });

      const fixCall = execFileMock.mock.calls[2] as [
        string,
        string[],
        { cwd: string; shell: boolean },
      ];
      expect(fixCall[0]).toBe(process.execPath);
      expect(fixCall[1].slice(0, fixArgs.length + 1)).toEqual([entry, ...fixArgs]);
      expect(fixCall[1][0]).not.toBe(linter);
      expect(fixCall[1].at(-1)).toMatch(/lint-gate-fix-.*input\.ts$/);
      expect(fixCall[2]).toEqual(expect.objectContaining({ cwd: projectRoot, shell: false }));
    },
  );
});
