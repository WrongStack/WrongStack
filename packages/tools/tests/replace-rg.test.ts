import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control ripgrep availability + output so the rg glob path runs deterministically.
const cfg: {
  versionThrows: boolean;
  versionCode: number;
  files: string[];
  findErrors: boolean;
} = {
  versionThrows: false,
  versionCode: 0,
  files: [],
  findErrors: false,
};

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EventEmitter();
      const isVersion = args.includes('--version');
      if (isVersion && cfg.versionThrows) throw new Error('spawn rg ENOENT (sync)');
      process.nextTick(() => {
        if (isVersion) {
          child.emit('close', cfg.versionCode); // checkRg: 0 = available
          return;
        }
        // spawnRgFind: optionally error, else emit the file list then close.
        if (cfg.findErrors) {
          child.emit('error', new Error('rg find failed'));
          return;
        }
        if (cfg.files.length) child.stdout.emit('data', Buffer.from(`${cfg.files.join('\n')}\n`));
        child.emit('close', 0);
      });
      return child;
    },
  };
});

import { __resetRgDetectionForTests, replaceTool } from '../src/replace.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-rg-'));
  cfg.versionThrows = false;
  cfg.versionCode = 0;
  cfg.files = [];
  cfg.findErrors = false;
  // rg availability is memoized per process; each test varies it via cfg.
  __resetRgDetectionForTests();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ctx = () => ({ cwd: dir, projectRoot: dir, tools: [] }) as never as Context;
const opts = () => ({ signal: new AbortController().signal });

describe('replaceTool ripgrep glob path (faked rg)', () => {
  it('uses rg --files output to drive the replacement when rg is available', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'const OLD = 1;');
    cfg.versionCode = 0; // rg available
    cfg.files = [file]; // rg --files returns this path
    const result = await replaceTool.execute(
      { pattern: 'OLD', replacement: 'NEW', files: '**/*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('const NEW = 1;');
  });

  it('falls back to the native walker when rg is unavailable', async () => {
    const file = path.join(dir, 'b.ts');
    await fs.writeFile(file, 'foo foo');
    cfg.versionCode = 1; // rg --version exits non-zero → unavailable
    const result = await replaceTool.execute(
      { pattern: 'foo', replacement: 'bar', files: '**/*.ts' },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(2);
  });

  it('falls back to the native walker when the rg probe throws synchronously', async () => {
    const file = path.join(dir, 'c.ts');
    await fs.writeFile(file, 'x');
    cfg.versionThrows = true; // checkRg outer catch → resolve(false)
    const result = await replaceTool.execute(
      { pattern: 'x', replacement: 'y', files: '**/*.ts' },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(1);
  });

  it('throws on an unsafe (catastrophic-backtracking) pattern', async () => {
    await expect(
      replaceTool.execute({ pattern: '(a+)+', replacement: 'x', files: 'a.ts' }, ctx(), opts()),
    ).rejects.toThrow(/replace:/);
  });

  it('applies the extra glob filter on the rg path (previously dropped)', async () => {
    const keep = path.join(dir, 'keep.ts');
    const skip = path.join(dir, 'skip.md');
    await fs.writeFile(keep, 'TARGET');
    await fs.writeFile(skip, 'TARGET');
    cfg.versionCode = 0; // rg available
    cfg.files = [keep, skip]; // rg enumerates both; glob must narrow to .ts
    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: '**/*', glob: '*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(keep, 'utf8')).toBe('DONE');
    expect(await fs.readFile(skip, 'utf8')).toBe('TARGET');
  });

  it('applies subpath extra glob filter on the rg path', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'other'), { recursive: true });
    const keep = path.join(dir, 'src', 'keep.ts');
    const skip = path.join(dir, 'other', 'skip.ts');
    await fs.writeFile(keep, 'TARGET');
    await fs.writeFile(skip, 'TARGET');
    cfg.versionCode = 0; // rg available
    cfg.files = [keep, skip];
    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: '**/*', glob: 'src/*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(keep, 'utf8')).toBe('DONE');
    expect(await fs.readFile(skip, 'utf8')).toBe('TARGET');
  });

  it('skips paths that rg returns but no longer exist (lstat ENOENT)', async () => {
    cfg.versionCode = 0;
    cfg.files = [path.join(dir, 'vanished.ts')]; // never created
    const result = await replaceTool.execute(
      { pattern: 'x', replacement: 'y', files: '**/*.ts' },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(0);
  });

  it('falls back to the native walker when rg --files errors', async () => {
    const file = path.join(dir, 'e.ts');
    await fs.writeFile(file, 'm');
    cfg.versionCode = 0; // rg "available"
    cfg.findErrors = true; // but --files errors → reject → globNative fallback
    const result = await replaceTool.execute(
      { pattern: 'm', replacement: 'n', files: '**/*.ts' },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(1);
  });

  it('applies the extra glob filter in the native walker', async () => {
    await fs.writeFile(path.join(dir, 'keep.ts'), 'TARGET');
    await fs.writeFile(path.join(dir, 'skip.md'), 'TARGET');
    cfg.versionCode = 1; // native walker
    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: '**/*', glob: '*.ts' },
      ctx(),
      opts(),
    );
    // Only keep.ts matches the *.ts extra glob; skip.md is filtered out.
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(path.join(dir, 'skip.md'), 'utf8')).toBe('TARGET');
  });

  it('applies subpath extra glob filter in the native walker', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'other'), { recursive: true });
    const keep = path.join(dir, 'src', 'keep.ts');
    const skip = path.join(dir, 'other', 'skip.ts');
    await fs.writeFile(keep, 'TARGET');
    await fs.writeFile(skip, 'TARGET');
    cfg.versionCode = 1; // native walker
    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: '**/*', glob: 'src/*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(keep, 'utf8')).toBe('DONE');
    expect(await fs.readFile(skip, 'utf8')).toBe('TARGET');
  });

  it('recurses into subdirectories in the native walker', async () => {
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, 'nested', 'deep.ts'), 'AA');
    cfg.versionCode = 1;
    const result = await replaceTool.execute(
      { pattern: 'AA', replacement: 'BB', files: '**/*.ts' },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(1);
  });

  it('replace_all=false only replaces the first match per file', async () => {
    const file = path.join(dir, 'd.ts');
    await fs.writeFile(file, 'z z z');
    cfg.versionCode = 1; // native walker
    const result = await replaceTool.execute(
      { pattern: 'z', replacement: 'Q', files: '**/*.ts', replace_all: false, dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.total_replacements).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('Q z z');
  });

  it('native walker expands a relative single-star glob (src/*.ts)', async () => {
    // Regression: globNative only tested basename + absolute path, so a
    // relative-anchored pattern like src/*.ts (compiled to ^src/[^/]*\.ts$)
    // could never match and the walker returned nothing. It must now match
    // the path relative to the walk base as well.
    await fs.mkdir(path.join(dir, 'src', 'sub'), { recursive: true });
    const a = path.join(dir, 'src', 'a.ts');
    const b = path.join(dir, 'src', 'b.ts');
    const nested = path.join(dir, 'src', 'sub', 'c.ts');
    await fs.writeFile(a, 'TARGET');
    await fs.writeFile(b, 'TARGET');
    await fs.writeFile(nested, 'TARGET');
    cfg.versionCode = 1; // rg unavailable → native walker

    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: 'src/*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(2);
    expect(await fs.readFile(a, 'utf8')).toBe('DONE');
    expect(await fs.readFile(b, 'utf8')).toBe('DONE');
    // Single `*` must not cross a directory boundary.
    expect(await fs.readFile(nested, 'utf8')).toBe('TARGET');
  });

  it('rg path expands a relative single-star glob (src/*.ts)', async () => {
    // Regression: spawnRgFind spawned rg WITHOUT cwd, so anchored globs were
    // resolved against the host process cwd instead of the search base and
    // returned nothing; the tool then reported files_modified=0 with no
    // native-walker fallback (the rg call resolved — just empty).
    await fs.mkdir(path.join(dir, 'src'));
    const a = path.join(dir, 'src', 'a.ts');
    const b = path.join(dir, 'src', 'b.ts');
    await fs.writeFile(a, 'TARGET');
    await fs.writeFile(b, 'TARGET');
    cfg.versionCode = 0; // rg available
    cfg.files = [a, b]; // rg --files enumerates both
    const result = await replaceTool.execute(
      { pattern: 'TARGET', replacement: 'DONE', files: 'src/*.ts', dry_run: false },
      ctx(),
      opts(),
    );
    expect(result.files_modified).toBe(2);
    expect(await fs.readFile(a, 'utf8')).toBe('DONE');
    expect(await fs.readFile(b, 'utf8')).toBe('DONE');
  });
});
