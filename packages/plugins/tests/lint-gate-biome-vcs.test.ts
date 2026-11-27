/**
 * lint-gate against the real Biome binary in a git-ignore-aware project.
 *
 * lint-gate lints the would-be content from a temp file under the OS temp
 * directory. With `vcs.useIgnoreFile: true` in biome.json (what `biome init`
 * writes in a git repository, and what this repository uses) Biome panics on
 * a path outside the project root — "path is expected to be under the root",
 * exit 101 — so every lint call failed, the gate counted a linter error and
 * let every write through without a word. Measured on this repository.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import lintGate from '../src/lint-gate/index.js';
import { linterCache, resolveLocalLinter } from '../src/lint-gate/linter-runner.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const biome = resolveLocalLinter('biome', repoRoot);
let root = '';

beforeEach(async () => {
  linterCache.clear();
  root = await mkdtemp(join(tmpdir(), 'lint-gate-vcs-'));
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.gitignore'), 'dist\n');
  await writeFile(
    join(root, 'biome.json'),
    JSON.stringify({
      vcs: { enabled: true, clientKind: 'git', useIgnoreFile: true },
      linter: { enabled: true, rules: { recommended: true } },
    }),
  );
  // Resolve the repository's own Biome from the temp project.
  await writeFile(join(root, 'package.json'), '{}');
  await mkdir(join(root, 'node_modules', '@biomejs'), { recursive: true });
});

afterEach(async () => {
  linterCache.clear();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!biome)('lint-gate with Biome VCS ignore integration', () => {
  it('reports lint findings instead of failing the linter silently', async () => {
    const { symlink } = await import('node:fs/promises');
    const biomePackage = join(repoRoot, 'node_modules', '@biomejs', 'biome');
    await symlink(
      biomePackage,
      join(root, 'node_modules', '@biomejs', 'biome'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    let hook: ((input: unknown) => Promise<unknown>) | undefined;
    let status: { execute: () => Promise<{ counters: Record<string, number> }> } | undefined;
    const api = {
      config: { cwd: root, extensions: { 'lint-gate': { linter: 'biome', mode: 'warn' } } },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tools: {
        register: (tool: never) => {
          if (!status) status = tool;
        },
      },
      registerHook: (_event: string, _matcher: string, fn: typeof hook) => {
        hook = fn;
        return () => {};
      },
    };
    lintGate.setup(api as never);
    const result = (await hook!({
      toolName: 'write',
      toolInput: {
        path: join(root, 'src', 'probe.ts'),
        content: 'export function f(a: number) {\n  debugger;\n  return a == 1;\n}\n',
      },
    })) as { additionalContext?: string } | undefined;
    const counters = (await status!.execute()).counters;
    expect(counters['linterErrors']).toBe(0);
    expect(result?.additionalContext ?? '').toMatch(/noDebugger|noDoubleEquals/);
    await lintGate.teardown?.(api as never);
  }, 60_000);
});
