import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnStreamMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));

vi.mock('../src/_spawn-stream.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, spawnStream: spawnStreamMocks.spawnStream };
});

import { typecheckTool } from '../src/typecheck.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

function fakeSpawn(stdout: string, exitCode = 0) {
  // biome-ignore lint/correctness/useYield: test mock returns the final result
  return async function* () {
    return { stdout, stderr: '', exitCode, truncated: false };
  };
}

let capturedArgs: string[] = [];
let capturedCmd = '';

beforeEach(() => {
  spawnStreamMocks.spawnStream.mockReset();
  spawnStreamMocks.spawnStream.mockImplementation((opts: { cmd: string; args: string[] }) => {
    capturedCmd = opts.cmd;
    capturedArgs = opts.args;
    return fakeSpawn('')();
  });
});

afterEach(() => vi.restoreAllMocks());

describe('typecheckTool', () => {
  it('has correct metadata', () => {
    expect(typecheckTool.name).toBe('typecheck');
    expect(typecheckTool.permission).toBe('confirm');
    expect(typecheckTool.mutating).toBe(false);
  });

  it('runs all when all=true (workspace project)', async () => {
    const result = await typecheckTool.execute({ all: true }, makeCtx(), makeOpts());
    expect(result.project).toBe('workspace');
    expect(result).toHaveProperty('exit_code');
    // No pnpm lockfile at /fake → falls back to a single root-level tsc run.
    expect(capturedCmd).toBe('npx');
    expect(capturedArgs).toEqual(['tsc', '--noEmit']);
  });

  it('runs pnpm -r --no-bail exec tsc when all=true in a pnpm workspace', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-pnpm-'));
    try {
      await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), '');
      const ctx = { cwd: dir, tools: [], projectRoot: dir } as any;
      const result = await typecheckTool.execute({ all: true }, ctx, makeOpts());
      expect(result.project).toBe('workspace');
      expect(capturedCmd).toBe('pnpm');
      expect(capturedArgs).toEqual(['-r', '--no-bail', 'exec', 'tsc', '--noEmit']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('respects strict flag', async () => {
    await typecheckTool.execute({ strict: true } as any, makeCtx(), makeOpts());
    expect(capturedArgs).toContain('--strict');
  });

  it('uses an explicit project path', async () => {
    const result = await typecheckTool.execute({ project: 'tsconfig.json' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('project');
    expect(capturedArgs).toContain('--project');
  });

  it('auto-discovers tsconfig.json in cwd (findTsConfig returns a file)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-tool-'));
    try {
      await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');
      const ctx = { cwd: dir, tools: [], projectRoot: dir } as any;
      const result = await typecheckTool.execute({}, ctx, makeOpts());
      expect(result.project).toBe(path.join(dir, 'tsconfig.json'));
      expect(capturedArgs).toContain('--project');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to "default" project when no tsconfig is found', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-empty-'));
    try {
      const ctx = { cwd: dir, tools: [], projectRoot: dir } as any;
      const result = await typecheckTool.execute({}, ctx, makeOpts());
      expect(result.project).toBe('default');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('counts errors and warnings from tsc output', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('a.ts(1,1): error TS1: bad\nb.ts(2,2): warning TS2: meh\n', 1),
    );
    const result = await typecheckTool.execute({ all: true }, makeCtx(), makeOpts());
    expect(result.errors).toBe(1);
    expect(result.warnings).toBe(1);
  });

  it('does not count prose mentions of "error" as diagnostics', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn(
        "a.ts(1,1): error TS2322: Type 'error' is not assignable to type 'never'.\n" +
          'Found 1 error in a.ts:1\n', // summary line — no TS code, must not count
        1,
      ),
    );
    const result = await typecheckTool.execute({ all: true }, makeCtx(), makeOpts());
    expect(result.errors).toBe(1);
  });

  it('never passes the non-existent --json flag to tsc', async () => {
    await typecheckTool.execute({ all: true, json: true } as any, makeCtx(), makeOpts());
    expect(capturedArgs).not.toContain('--json');
  });

  it('resolves an explicit cwd', async () => {
    const result = await typecheckTool.execute({ all: true, cwd: '.' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('project');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = typecheckTool.executeStream;
    typecheckTool.executeStream = undefined;
    try {
      await expect(typecheckTool.execute({ all: true }, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      typecheckTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = typecheckTool.executeStream!;
    typecheckTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(typecheckTool.execute({ all: true }, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      typecheckTool.executeStream = original;
    }
  });
});
