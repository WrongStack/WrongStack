import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it, vi } from 'vitest';
import { formatTool } from '../src/format.js';
import { installTool } from '../src/install.js';
import { lintTool } from '../src/lint.js';
import { testTool } from '../src/test.js';
import { typecheckTool } from '../src/typecheck.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/_spawn-stream.js', () => ({ spawnStream: mocks.spawn }));
vi.mock('../src/_bun-typechecker.js', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  bunTypecheckInvocation: async (cwd: string, args: string[]) => ({ cmd: 'bun', args, cwd }),
}));

describe('development tools follow the session working directory', () => {
  it.each([
    ['test', testTool, { runner: 'vitest' }],
    ['lint', lintTool, { linter: 'biome' }],
    ['format', formatTool, { fixer: 'biome', check: true }],
    ['install', installTool, {}],
    ['typecheck', typecheckTool, {}],
  ] as const)(
    '%s uses the selected directory while honoring an explicit override',
    async (_name, tool, input) => {
      const root = await mkdtemp(join(tmpdir(), 'wstack-working-dir-'));
      const selected = join(root, 'selected');
      const explicit = join(root, 'explicit');
      await mkdir(selected);
      await mkdir(explicit);
      for (const directory of [root, selected, explicit]) {
        await writeFile(
          join(directory, 'package.json'),
          JSON.stringify({ name: 'fixture', packageManager: 'npm@1.0.0' }),
        );
        await writeFile(join(directory, 'tsconfig.json'), '{}');
      }
      mocks.spawn.mockReset().mockImplementation(async function* () {
        yield { type: 'stdout', chunk: '' };
        return { stdout: '', stderr: '', exitCode: 0, truncated: false };
      });
      const ctx = { projectRoot: root, cwd: root, workingDir: selected } as Context;
      const opts = { signal: new AbortController().signal };
      try {
        await tool.execute(input as never, ctx, opts);
        expect(mocks.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: selected });
        mocks.spawn.mockClear();
        await tool.execute({ ...input, cwd: explicit } as never, ctx, opts);
        expect(mocks.spawn.mock.calls[0]?.[0]).toMatchObject({ cwd: explicit });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
