import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnStreamMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));

vi.mock('../src/_spawn-stream.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, spawnStream: spawnStreamMocks.spawnStream };
});

import { createToolOutputSerializer } from '@wrongstack/core/utils';
import { formatTool, parseFormatterCounts } from '../src/format.js';

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

  it('runs biome in check mode (no --write) when check=true is passed', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    let receivedArgs: string[] = [];
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      receivedArgs = opts.args;
      return fakeSpawn('')();
    });
    await formatTool.execute({ check: true, fixer: 'biome' }, ctx, makeOpts());
    // Biome has no `--check` flag (it rejects it); format without --write IS the check.
    expect(receivedArgs).toEqual(['format']);
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

  it('falls back to stderr when stdout is empty', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawn('', { stderr: 'permission denied' }));
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.output).toBe('permission denied');
  });

  it('throws when the formatter cannot be started', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('', { error: 'spawn prettier ENOENT', exitCode: 1 }),
    );
    await expect(formatTool.execute({ fixer: 'prettier' }, makeCtx(), makeOpts())).rejects.toThrow(
      /could not run prettier: spawn prettier ENOENT/,
    );
  });

  it('throws when executeStream is unavailable', async () => {
    const original = formatTool.executeStream;
    (formatTool as { executeStream: typeof original | undefined }).executeStream = undefined;
    try {
      await expect(formatTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      (formatTool as any).executeStream = original;
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
    const result = await (formatTool.execute as any)({ fixer: 'biome' }, makeCtx());
    expect(result.fixer).toBe('biome');
    expect(result.files_checked).toBe(1);
    expect(result.files_changed).toBe(0);
  });

  // Regression for C1 (CMDI-005) — argument injection via `files[]`.
  // The prettier branch pushes `files` into the argv WITHOUT a `--`
  // separator, so a value like `--config=.cache/evil.js` is parsed as
  // a CLI option. Prettier's `--config` is also executable JavaScript.
  // The containment check above accepts `--config=path` because
  // `<cwd>/--config=path` resolves inside the root, so this leading-dash
  // guard is the only thing that closes the injection.
  it('rejects file paths beginning with "-" (flag injection)', async () => {
    await expect(
      (formatTool.execute as any)(
        { fixer: 'prettier', files: ['--config=.cache/evil.js'] },
        makeCtx(),
      ),
    ).rejects.toThrow(/flag injection/);
  });
});

describe('parseFormatterCounts', () => {
  it('reads Biome 2 "No fixes applied" as zero files changed', () => {
    // Real Biome 2.5.13 summaries: N files processed, none written — already
    // formatted, or aborted on a parse error. "Formatted N" was taken as N changed.
    expect(parseFormatterCounts('biome', 'Formatted 2 files in 1758µs. No fixes applied.')).toEqual(
      { checked: 2, changed: 0 },
    );
    expect(
      parseFormatterCounts(
        'biome',
        'Code formatting aborted due to parsing errors.\nFormatted 1 file in 1518µs. No fixes applied.\nFound 1 error.',
      ),
    ).toEqual({ checked: 1, changed: 0 });
    expect(parseFormatterCounts('biome', 'Formatted 2 files in 2ms. Fixed 1 file.')).toEqual({
      checked: 2,
      changed: 1,
    });
  });

  it('detectFixer strips UTF-8 BOM from package.json when checking prettier', async () => {
    const fsPromises = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { detectFixer } = await import('../src/format.js');
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'fmt-bom-'));
    try {
      await fsPromises.writeFile(
        path.join(dir, 'package.json'),
        `\uFEFF${JSON.stringify({ name: 'app', prettier: {} })}`,
        'utf8',
      );
      expect(await detectFixer(dir)).toBe('prettier');
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });
});

// Regression: `format` with `check: true` published no process exit status, so
// the shared verifier renderer (which defaults `exit_code` to 0) printed
// `status=passed` for a project the formatter had just rejected. Real Biome
// 2.6.5 exits 1 on violations and writes `Checked N files … Found 1 error.`;
// `files_changed` is legitimately 0 in check mode, so the exit code is the
// only failure signal the payload can carry.
describe('formatTool exit status (check-mode false green)', () => {
  const serialize = (value: unknown) =>
    createToolOutputSerializer().serialize(value, {
      toolName: 'format',
      input: { check: true },
    });

  // Captured verbatim from the measured run, minus the box-drawing ruler.
  const BIOME_REJECTION = [
    'src/a.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '  × Formatter would have printed the following content:',
    '',
    'Checked 1 file in 1594µs. No fixes applied.',
    'Found 1 error.',
  ].join('\n');

  it('propagates the formatter exit code when a check fails', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('', { stderr: BIOME_REJECTION, exitCode: 1 }),
    );
    const result = await formatTool.execute({ check: true, fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.exit_code).toBe(1);
    // The check-mode count contract is unchanged: nothing was written.
    expect(result.files_changed).toBe(0);
    const rendered = serialize(result);
    expect(rendered).not.toContain('status=passed');
    expect(rendered).toContain('error_context');
  });

  it('still reports a clean check as passed (control)', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('', { stderr: 'Checked 1 file in 2ms. No fixes applied.', exitCode: 0 }),
    );
    const result = await formatTool.execute({ check: true, fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.exit_code).toBe(0);
    expect(serialize(result)).toContain('status=passed');
  });

  it('keeps the write-mode verdict intact: changed files, exit 0 (control)', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(
      fakeSpawn('', { stderr: 'Formatted 2 files in 2ms. Fixed 1 file.', exitCode: 0 }),
    );
    const result = await formatTool.execute({ fixer: 'biome' }, makeCtx(), makeOpts());
    expect(result.exit_code).toBe(0);
    expect(result.files_changed).toBe(1);
    expect(serialize(result)).toContain('status=changed');
  });

  it('pins the causality: a format payload without exit_code renders as passed', () => {
    // The pre-fix shape — exactly what `format` used to yield on a rejected
    // project. Kept as a guard so the field is never dropped again: the
    // renderer cannot infer failure from a check run any other way.
    const preFixShape = {
      fixer: 'biome',
      files_checked: 1,
      files_changed: 0,
      output: BIOME_REJECTION,
      truncated: false,
    };
    expect(serialize(preFixShape)).toContain('status=passed');
  });
});
