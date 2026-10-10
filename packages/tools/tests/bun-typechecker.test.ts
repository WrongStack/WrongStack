import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bunPlatformPackage,
  bunTypecheckInvocation,
  ensureBunTypechecker,
  extractBunExecutable,
} from '../src/_bun-typechecker.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const cacheRoot = path.join(repoRoot, '.bun/typecheck');
const temporaryRoots: string[] = [];
let binary: string;

beforeAll(async () => {
  binary = await ensureBunTypechecker({ cacheRoot });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'bun-typecheck-test-'));
  temporaryRoots.push(root);
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, types: [] },
      files: ['entry.ts'],
    }),
  );
  await writeFile(path.join(root, 'entry.ts'), source);
  return root;
}

function archive(name: string, content: string, declaredSize = Buffer.byteLength(content)) {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(declaredSize.toString(8).padStart(11, '0'), 124);
  header[156] = 48;
  const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
  body.write(content);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

describe('required Bun typechecker', () => {
  it('checks the requested project and never runs its check script', async () => {
    const root = await fixture('const value: number = "incorrect";');
    const marker = path.join(root, 'script-ran');
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          check: `node -e "require('fs').writeFileSync('script-ran', 'yes')"`,
        },
      }),
    );
    vi.stubEnv('WRONGSTACK_BUN_TYPECHECK', binary);
    const invocation = await bunTypecheckInvocation(root, ['-p', 'tsconfig.json'], { cacheRoot });
    const result = spawnSync(invocation.cmd, invocation.args, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('error TS2322:');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(invocation.args).toContain(path.join(root, 'tsconfig.json'));
  });

  it('passes correct code without writing declaration or buildinfo files', async () => {
    const root = await fixture('const value: number = 1;');
    vi.stubEnv('WRONGSTACK_BUN_TYPECHECK', binary);
    const invocation = await bunTypecheckInvocation(root, ['--project=tsconfig.json'], {
      cacheRoot,
    });
    const result = spawnSync(invocation.cmd, invocation.args, {
      cwd: invocation.cwd,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    await expect(readFile(path.join(root, 'entry.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'tsconfig.tsbuildinfo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('executes the TypeScript language plan with Bun and reports the original file path', async () => {
    const root = await fixture('const value: number = "incorrect";');
    vi.stubEnv('WRONGSTACK_BUN_TYPECHECK', binary);
    const { planLanguageOperation, executeLanguagePlan } = await import(
      '../src/languages/index.js'
    );
    const planned = await planLanguageOperation({
      projectRoot: root,
      language: 'typescript',
      operation: 'semantic',
    });
    expect(planned.status).toBe('planned');
    if (planned.status !== 'planned') throw new Error('No TypeScript plan');
    const execution = executeLanguagePlan({
      projectRoot: root,
      workspace: planned.workspace,
      plan: planned.plan,
      signal: new AbortController().signal,
    });
    for (;;) {
      const next = await execution.next();
      if (!next.done) continue;
      expect(next.value.status).toBe('failed');
      expect(next.value.exitCode).toBe(1);
      expect(next.value.diagnostics).toMatchObject([
        {
          file: path.join(root, 'entry.ts'),
          code: 'TS2322',
          severity: 'error',
        },
      ]);
      break;
    }
  });

  it('fails an unsupported explicit executable without downloading or falling back', async () => {
    const root = await fixture('const value = 1;');
    const unsupported = path.join(root, 'unsupported.exe');
    await writeFile(unsupported, 'not an executable');
    vi.stubEnv('WRONGSTACK_BUN_TYPECHECK', unsupported);
    const network = vi.spyOn(globalThis, 'fetch');
    await expect(ensureBunTypechecker({ cacheRoot })).rejects.toThrow('does not provide a working');
    expect(network).not.toHaveBeenCalled();
  });

  it('allows concurrent invocations to publish the private cwd manifest once', async () => {
    const root = await fixture('const value: number = 1;');
    const freshCache = path.join(root, 'checker-cache');
    vi.stubEnv('WRONGSTACK_BUN_TYPECHECK', binary);
    const invocations = await Promise.all(
      Array.from({ length: 3 }, () =>
        bunTypecheckInvocation(root, ['-p', 'tsconfig.json'], { cacheRoot: freshCache }),
      ),
    );
    for (const invocation of invocations) {
      const result = spawnSync(invocation.cmd, invocation.args, {
        cwd: invocation.cwd,
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
  });

  it('honors cancellation before provisioning or starting a checker', async () => {
    const signal = AbortSignal.abort(new Error('cancelled by caller'));
    await expect(ensureBunTypechecker({ cacheRoot, signal })).rejects.toThrow(
      'cancelled by caller',
    );
  });

  it('selects native platform packages and rejects unsupported platforms', () => {
    expect(bunPlatformPackage('win32', 'x64')).toBe('@oven/bun-windows-x64');
    expect(bunPlatformPackage('darwin', 'arm64')).toBe('@oven/bun-darwin-aarch64');
    expect(() => bunPlatformPackage('aix', 'ppc64')).toThrow('unavailable');
  });

  it('extracts only the executable rather than trusting archive paths', () => {
    expect(extractBunExecutable(archive('package/bin/bun', 'executable'), 'bun').toString()).toBe(
      'executable',
    );
    expect(() => extractBunExecutable(archive('../../escape', 'x'), 'bun')).toThrow('has no bun');
  });

  it('rejects an archive entry extending beyond the archive', () => {
    expect(() => extractBunExecutable(archive('package/bin/bun', 'x', 9999), 'bun')).toThrow(
      'Invalid Bun runtime archive',
    );
  });
});
