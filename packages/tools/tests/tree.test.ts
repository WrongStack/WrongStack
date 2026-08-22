import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { treeTool } from '../src/tree.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

describe('treeTool', () => {
  it('has correct metadata', () => {
    expect(treeTool.name).toBe('tree');
    expect(treeTool.permission).toBe('auto');
    expect(treeTool.mutating).toBe(false);
  });

  it('returns tree for valid path', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
    expect(result).toHaveProperty('total_files');
    expect(result).toHaveProperty('total_dirs');
  });

  it('defaults to cwd', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({}, ctx, makeOpts());
    expect(result.path).toBe(tmpDir);
  });

  it('respects depth option', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ depth: 1 }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('respects show_files=false', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_files: false }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('respects show_dirs=false', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_dirs: false }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('skips directories when show_dirs=false (with a real subdir present)', async () => {
    await fs.mkdir(path.join(tmpDir, 'adir'));
    await fs.writeFile(path.join(tmpDir, 'keep.txt'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_dirs: false }, ctx, makeOpts());
    expect(result.tree).not.toContain('adir/');
    expect(result.tree).toContain('keep.txt');
  });

  it('matches directory-prefixed globs against a POSIX-relative path', async () => {
    await fs.mkdir(path.join(tmpDir, 'src'));
    await fs.writeFile(path.join(tmpDir, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'src', 'b.js'), '');
    await fs.writeFile(path.join(tmpDir, 'root.ts'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir, glob: 'src/*.ts' }, ctx, makeOpts());
    expect(result.tree).toContain('a.ts');
    expect(result.tree).not.toContain('b.js');
    expect(result.tree).not.toContain('root.ts');
  });

  it('counts direct children of the root in total_files/total_dirs', async () => {
    // Regression: a `depth > 0` guard in walkDir excluded the root's own
    // entries from the totals — a flat directory always reported 0/0.
    await fs.mkdir(path.join(tmpDir, 'sub'));
    await fs.writeFile(path.join(tmpDir, 'a.txt'), '');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), '');
    await fs.writeFile(path.join(tmpDir, 'sub', 'c.txt'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir }, ctx, makeOpts());
    expect(result.total_files).toBe(3);
    expect(result.total_dirs).toBe(1);
  });

  it('walks a deep nested tree (drives the queue-drain poll loop)', async () => {
    let dir = tmpDir;
    for (let i = 0; i < 8; i++) {
      dir = path.join(dir, `level${i}`);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, `f${i}.txt`), '');
    }
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir, depth: 20 }, ctx, makeOpts());
    expect(result.total_dirs).toBeGreaterThanOrEqual(6);
  });

  it('respects show_hidden=true', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_hidden: true }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('respects exclude option', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ exclude: ['node_modules'] }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('respects glob filter', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({ glob: '*.ts' }, ctx, makeOpts());
    expect(result).toHaveProperty('tree');
  });

  it('emits progress metric events past the flush threshold (>200 entries)', async () => {
    const sub = path.join(tmpDir, 'many');
    await fs.mkdir(sub);
    await Promise.all(
      Array.from({ length: 250 }, (_, i) => fs.writeFile(path.join(sub, `f${i}.txt`), '')),
    );
    const ctx = makeCtx();
    const events: string[] = [];
    let final: unknown;
    for await (const ev of treeTool.executeStream!({ path: tmpDir }, ctx, {
      signal: new AbortController().signal,
    })) {
      events.push(ev.type);
      if (ev.type === 'final') final = ev.output;
    }
    expect(events).toContain('metric'); // flush path (tickProgress + queue drain)
    expect(final).toBeDefined();
  });

  it('bounds retained entries even when unlimited depth is requested', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => fs.writeFile(path.join(tmpDir, `f${i}.txt`), '')),
    );

    const result = await treeTool.execute({ path: tmpDir, depth: 0, max_entries: 10 }, makeCtx(), {
      signal: new AbortController().signal,
    });

    expect(result.truncated).toBe(true);
    expect(result.tree.split('\n')).toHaveLength(11);
    expect(Buffer.byteLength(result.tree, 'utf8')).toBeLessThanOrEqual(256 * 1024);
  });

  it('stops traversal when its abort signal is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      treeTool.execute({ path: tmpDir, depth: 0 }, makeCtx(), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws when executeStream is unavailable', async () => {
    const original = treeTool.executeStream;
    treeTool.executeStream = undefined;
    try {
      await expect(treeTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      treeTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = treeTool.executeStream!;
    treeTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(treeTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      treeTool.executeStream = original;
    }
  });

  it('handles a base path that is not a directory (readdir error → empty)', async () => {
    const file = path.join(tmpDir, 'afile.txt');
    await fs.writeFile(file, 'hi');
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: 'afile.txt' }, ctx, makeOpts());
    expect(result.total_files).toBe(0);
    expect(result.total_dirs).toBe(0);
  });

  it('filters files by glob pattern', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.ts'), 'ts');
    await fs.writeFile(path.join(tmpDir, 'b.txt'), 'txt');
    const ctx = makeCtx();
    const result = await treeTool.execute({ path: tmpDir, glob: '*.ts' }, ctx, makeOpts());
    expect(result.tree).toContain('a.ts');
    expect(result.tree).not.toContain('b.txt');
    expect(result.total_files).toBe(1);
  });
});

