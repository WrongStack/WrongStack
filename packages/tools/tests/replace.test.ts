import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replaceTool } from '../src/replace.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'replace-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;

describe('replaceTool', () => {
  it('has correct metadata', () => {
    expect(replaceTool.name).toBe('replace');
    expect(replaceTool.permission).toBe('confirm');
    expect(replaceTool.mutating).toBe(true);
  });

  it('throws when pattern is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ files: 'a.txt', pattern: '', replacement: 'x' } as any, ctx),
    ).rejects.toThrow('pattern is required');
  });

  it('throws when replacement is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ files: 'a.txt', pattern: 'foo', replacement: undefined } as any, ctx),
    ).rejects.toThrow('replacement is required');
  });

  it('throws when files is missing', async () => {
    const ctx = makeCtx();
    await expect(
      replaceTool.execute({ pattern: 'foo', replacement: 'x' } as any, ctx),
    ).rejects.toThrow('files is required');
  });

  it('dry_run does not modify files', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: true },
      ctx,
    );
    expect(result.files_modified).toBe(1);
    expect(result.dry_run).toBe(true);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello world'); // unchanged
  });

  it('expands $1..$9 capture groups in the replacement (String.replace semantics)', async () => {
    const filePath = path.join(tmpDir, 'swap.txt');
    await fs.writeFile(filePath, 'foo-bar baz-qux', 'utf8');
    const result = await replaceTool.execute(
      { pattern: '(\\w+)-(\\w+)', replacement: '$2-$1', files: filePath, dry_run: false },
      makeCtx(),
    );
    expect(result.total_replacements).toBe(2);
    expect(await fs.readFile(filePath, 'utf8')).toBe('bar-foo qux-baz');
  });

  it('expands $& (whole match) and $$ (literal dollar)', async () => {
    const filePath = path.join(tmpDir, 'amp.txt');
    await fs.writeFile(filePath, 'abc', 'utf8');
    await replaceTool.execute(
      { pattern: 'b', replacement: '[$&]$$', files: filePath, dry_run: false },
      makeCtx(),
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe('a[b]$c');
  });

  it('keeps $N literal when the pattern has no such group', async () => {
    const filePath = path.join(tmpDir, 'lit.txt');
    await fs.writeFile(filePath, 'x', 'utf8');
    await replaceTool.execute(
      { pattern: 'x', replacement: '$5y', files: filePath, dry_run: false },
      makeCtx(),
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe('$5y');
  });

  it('unmatched optional groups expand to the empty string', async () => {
    const filePath = path.join(tmpDir, 'opt.txt');
    await fs.writeFile(filePath, 'ab', 'utf8');
    await replaceTool.execute(
      { pattern: 'a(x)?(b)', replacement: '<$1|$2>', files: filePath, dry_run: false },
      makeCtx(),
    );
    expect(await fs.readFile(filePath, 'utf8')).toBe('<|b>');
  });

  it('honors the extra glob filter on a comma-separated files list', async () => {
    const keep = path.join(tmpDir, 'keep.ts');
    const skip = path.join(tmpDir, 'skip.md');
    await fs.writeFile(keep, 'TARGET', 'utf8');
    await fs.writeFile(skip, 'TARGET', 'utf8');
    const result = await replaceTool.execute(
      {
        pattern: 'TARGET',
        replacement: 'DONE',
        files: `${keep},${skip}`,
        glob: '*.ts',
        dry_run: false,
      },
      makeCtx(),
    );
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(keep, 'utf8')).toBe('DONE');
    expect(await fs.readFile(skip, 'utf8')).toBe('TARGET');
  });

  it('actually replaces when not dry_run', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: false },
      ctx,
    );
    expect(result.files_modified).toBe(1);
    expect(result.total_replacements).toBe(1);
    expect(result.dry_run).toBe(false);
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello wstack');
  });

  it('replaces when the project root is a symlink (CI tmpdir / short-name case)', async () => {
    // Repro of the CI failure: realpath(file) resolves through the symlinked
    // root, so comparing it against a non-normalized projectRoot made every
    // legitimately-inside file look "outside" and skipped it (files_modified=0).
    const realRoot = path.join(tmpDir, 'real');
    const linkRoot = path.join(tmpDir, 'link');
    await fs.mkdir(realRoot, { recursive: true });
    try {
      await fs.symlink(realRoot, linkRoot, os.platform() === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // environment can't create symlinks/junctions — skip
    }
    const filePath = path.join(linkRoot, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = { cwd: linkRoot, tools: [], projectRoot: linkRoot } as any;
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: false },
      ctx,
    );
    expect(result.files_modified).toBe(1);
    expect(await fs.readFile(filePath, 'utf8')).toBe('hello wstack');
  });

  it('dry_run defaults to true — no write without explicit dry_run: false', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath },
      ctx,
    );
    expect(result.dry_run).toBe(true);
    expect(result.files_modified).toBe(1);
    expect(result.total_replacements).toBe(1);
    // File must be unchanged — dry-run is the default
    const content = await fs.readFile(filePath, 'utf8');
    expect(content).toBe('hello world');
  });

  it('returns empty results when no matches', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'nonexistent', replacement: 'x', files: filePath },
      ctx,
    );
    expect(result.files_modified).toBe(0);
    expect(result.total_replacements).toBe(0);
  });

  it('handles glob pattern', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'foo bar', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'foo', replacement: 'baz', files: '*.txt', dry_run: false },
      ctx,
    );
    expect(result).toHaveProperty('files_modified');
  });

  it('reports diff for dry run', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'world', replacement: 'wstack', files: filePath, dry_run: true },
      ctx,
    );
    expect(result.results[0].diff).toBeDefined();
  });

  it('skips binary files', async () => {
    const filePath = path.join(tmpDir, 'binary.bin');
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    await fs.writeFile(filePath, buf);
    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'foo', replacement: 'bar', files: filePath },
      ctx,
    );
    expect(result.files_modified).toBe(0);
  });
});

describe('globNative walk exception paths', () => {
  it('walk skips entries where fs.lstat throws (broken symlink)', async () => {
    // When lstat throws (e.g., for broken symlinks), the entry is skipped (lines 281-285).
    // We create a broken symlink pointing to a nonexistent target.
    // The realpath check will skip it (throws ENOENT), but the lstat path is also tested.
    const linkPath = path.join(tmpDir, 'broken.link');
    await fs.symlink('nonexistent-target-file-xyz', linkPath);

    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'hello', replacement: 'hi', files: linkPath },
      ctx,
    );
    // Should not crash; the broken link is filtered by realpath check
    expect(result.files_modified).toBe(0);
  });

  it('walk recursively descends into subdirectories', async () => {
    // Creates: tmpDir/a.txt, tmpDir/sub/b.txt, tmpDir/sub/deep/c.txt
    // Uses glob pattern **/*.txt → recursive walk (line 287) must find all three.
    const subDir = path.join(tmpDir, 'sub');
    const deepDir = path.join(subDir, 'deep');
    await fs.mkdir(deepDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'apple banana', 'utf8');
    await fs.writeFile(path.join(subDir, 'b.txt'), 'banana cherry', 'utf8');
    await fs.writeFile(path.join(deepDir, 'c.txt'), 'cherry date', 'utf8');

    const ctx = makeCtx();
    const result = await replaceTool.execute(
      { pattern: 'banana', replacement: 'BERRIES', files: '**/*.txt', dry_run: false },
      ctx,
    );
    expect(result.files_modified).toBe(2);
    expect(result.total_replacements).toBe(2);
  });
});

describe('replace change tracking', () => {
  it('records mtime+hash (write-tagged) and a session file change on apply', async () => {
    const filePath = path.join(tmpDir, 'tracked.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');

    const recorded: Array<{ path: string; source: string; hash?: string }> = [];
    const changes: Array<{ path: string; action: string; before: unknown; after: unknown }> = [];
    const ctx = {
      cwd: tmpDir,
      tools: [],
      projectRoot: tmpDir,
      recordRead(p: string, _m: number, source = 'user', hash?: string) {
        recorded.push({ path: p, source, hash });
      },
      session: {
        recordFileChange(c: { path: string; action: string; before: unknown; after: unknown }) {
          changes.push(c);
        },
      },
    } as any;

    const result = await replaceTool.execute(
      { pattern: 'hello', replacement: 'goodbye', files: filePath, dry_run: false },
      ctx,
    );
    expect(result.files_modified).toBe(1);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.source).toBe('write');
    expect(recorded[0]?.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.action).toBe('modified');
    expect(changes[0]?.before).toBe('hello world');
    expect(changes[0]?.after).toBe('goodbye world');
  });

  it('dry_run records nothing', async () => {
    const filePath = path.join(tmpDir, 'untracked.txt');
    await fs.writeFile(filePath, 'hello world', 'utf8');
    const recorded: unknown[] = [];
    const ctx = {
      cwd: tmpDir,
      tools: [],
      projectRoot: tmpDir,
      recordRead(...args: unknown[]) {
        recorded.push(args);
      },
      session: { recordFileChange: (c: unknown) => recorded.push(c) },
    } as any;
    await replaceTool.execute({ pattern: 'hello', replacement: 'goodbye', files: filePath }, ctx);
    expect(recorded).toHaveLength(0);
  });
});
