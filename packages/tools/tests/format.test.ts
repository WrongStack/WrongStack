import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const spawnStreamMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));

vi.mock('../src/_spawn-stream.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, spawnStream: spawnStreamMocks.spawnStream };
});

import { formatTool } from '../src/format.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

function fakeSpawn(
  stdout: string,
  opts: { stderr?: string; error?: string; truncated?: boolean; exitCode?: number } = {},
) {
  // biome-ignore lint/correctness/useYield: test mock doesn't need actual yield
  return async function* () {
    return {
      stdout,
      stderr: opts.stderr ?? '',
      error: opts.error,
      truncated: opts.truncated ?? false,
      exitCode: opts.exitCode ?? 0,
    };
  };
}

let tmp: string;

beforeEach(async () => {
  spawnStreamMocks.spawnStream.mockReset();
  spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn(''));
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fmt-tool-'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('formatTool', () => {
  it('has correct metadata', () => {
    expect(formatTool.name).toBe('format');
    expect(formatTool.permission).toBe('confirm');
    expect(formatTool.mutating).toBe(true);
    expect(formatTool.capabilities).toEqual(['fs.write', 'shell.restricted']);
  });

  it('uses biome when neither biome.json nor .prettierrc exists (fallback)', async () => {
    // detectFixer falls through to return 'biome' when neither file is found
    const ctx = { cwd: tmp, tools: [], projectRoot: tmp } as any;
    const result = await formatTool.execute({ fixer: 'auto' }, ctx, makeOpts());
    // biome is the fallback when nothing is detected
    expect(result.fixer).toBe('biome');
  });

  it('detects biome from biome.json in cwd', async () => {
    await fs.writeFile(path.join(tmp, 'biome.json'), '{}');
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('formatted 3 files\n'));
    const result = await formatTool.execute(
      { fixer: 'auto' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('biome');
  });

  it('detects prettier from .prettierrc when biome.json is absent', async () => {
    await fs.writeFile(path.join(tmp, '.prettierrc'), '{}');
    const result = await formatTool.execute(
      { fixer: 'auto' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('prettier');
  });

  it.each([
    '.prettierrc.json',
    '.prettierrc.js',
    '.prettierrc.cjs',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
  ])('detects prettier from %s', async (cfg) => {
    await fs.writeFile(path.join(tmp, cfg), '');
    const result = await formatTool.execute(
      { fixer: 'auto' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('prettier');
  });

  it('detects prettier from a package.json#prettier field', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ prettier: {} }));
    const result = await formatTool.execute(
      { fixer: 'auto' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('prettier');
  });

  it('prefers biome when both biome.json and prettier configs exist', async () => {
    await fs.writeFile(path.join(tmp, 'biome.json'), '{}');
    await fs.writeFile(path.join(tmp, '.prettierrc'), '{}');
    const result = await formatTool.execute(
      { fixer: 'auto' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('biome');
  });

  it('uses the explicit fixer when provided (overrides auto-detection)', async () => {
    await fs.writeFile(path.join(tmp, 'biome.json'), '{}');
    const result = await formatTool.execute(
      { fixer: 'prettier' },
      { cwd: tmp, tools: [], projectRoot: tmp } as any,
      makeOpts(),
    );
    expect(result.fixer).toBe('prettier');
  });

  it('switches to --check argument when check=true is passed', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute({ check: true, fixer: 'biome' }, ctx, makeOpts());
    expect(receivedArgs).toContain('--check');
    expect(receivedArgs).not.toContain('--write');
  });

  it('parses files_checked/files_changed from biome summary lines', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('Checked 12 files in 30ms. Fixed 3 files.\n'),
    );
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.files_checked).toBe(12);
    expect(result.files_changed).toBe(3);
  });

  it('returns undefined counts when biome output has no summary line', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('some unrelated noise\n'));
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.files_checked).toBeUndefined();
    expect(result.files_changed).toBeUndefined();
  });

  it('returns undefined counts for prettier (per-file listing is not parsed)', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('a.ts 20ms\nb.ts 5ms\n'));
    const result = await formatTool.execute({ fixer: 'prettier' }, makeCtx(), makeOpts());
    expect(result.files_checked).toBeUndefined();
    expect(result.files_changed).toBeUndefined();
  });

  it('builds a valid prettier command (--write, no "format" subcommand)', async () => {
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute({ fixer: 'prettier', files: 'a.ts, b.ts' }, makeCtx(), makeOpts());
    expect(receivedArgs).toEqual(['--write', 'a.ts', 'b.ts']);
  });

  it('prettier check mode targets "." when no files given', async () => {
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute({ fixer: 'prettier', check: true }, makeCtx(), makeOpts());
    expect(receivedArgs).toEqual(['--check', '.']);
  });

  it('passes files list to formatter via "--" separator', async () => {
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute({ fixer: 'biome', files: 'a.ts, b.ts' }, makeCtx(), makeOpts());
    expect(receivedArgs).toContain('--');
    expect(receivedArgs).toContain('a.ts');
    expect(receivedArgs).toContain('b.ts');
  });

  it('handles files passed as an array', async () => {
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute(
      { fixer: 'biome', files: ['x.ts', 'y.ts'] as never },
      makeCtx(),
      makeOpts(),
    );
    expect(receivedArgs).toContain('x.ts');
    expect(receivedArgs).toContain('y.ts');
  });

  it('falls back to stderr or error when stdout is empty', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('', { stderr: 'permission denied' }));
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.output).toBe('permission denied');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = formatTool.executeStream;
    (formatTool as { executeStream: typeof original | undefined }).executeStream = undefined;
    try {
      await expect(formatTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      formatTool.executeStream = original;
    }
  });

  it('resolves an explicit cwd', async () => {
    const result = await formatTool.execute({ fixer: 'biome', cwd: '.' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('fixer');
  });

  it('execute throws when stream ends without a final event', async () => {
    const original = formatTool.executeStream!;
    formatTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(formatTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      formatTool.executeStream = original;
    }
  });

  it('uses explicit fixer biome without auto-detection', async () => {
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.fixer).toBe('biome');
    expect(receivedArgs).toContain('format');
  });

  it('executes cleanly when opts parameter is omitted', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('Checked 1 file. Fixed 0 files.'));
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx());
    expect(result.fixer).toBe('biome');
    expect(result.files_checked).toBe(1);
    expect(result.files_changed).toBe(0);
  });
});
