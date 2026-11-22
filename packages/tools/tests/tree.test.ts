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

  it('renders correct tree branch connectors for sibling directories', async () => {
    const dir1 = path.join(tmpDir, 'dir1');
    const dir2 = path.join(tmpDir, 'dir2');
    await fs.mkdir(path.join(dir1, 'subdir1'), { recursive: true });
    await fs.writeFile(path.join(dir1, 'subdir1', 'file.txt'), 'content');
    await fs.mkdir(dir2, { recursive: true });
    await fs.writeFile(path.join(dir2, 'file2.txt'), 'content');

    const ctx = makeCtx();
    const result = await treeTool.execute({ depth: 5 }, ctx, makeOpts());
    const lines = result.tree.split('\n');
    const subdirLine = lines.find((l) => l.includes('subdir1'));
    expect(subdirLine).toBeDefined();
    // Non-last root directory's children must be prefixed with '│   '
    expect(subdirLine!.startsWith('│   ')).toBe(true);
  });

  it('defaults to the project root', async () => {
    const ctx = makeCtx();
    const result = await treeTool.execute({}, ctx, makeOpts());
    expect(result.path).toBe(tmpDir);
  });

  it('roots the default tree at projectRoot, not a nested session cwd', async () => {
    // The schema promises "defaults to project root". Rooting the walk at
    // `ctx.cwd` meant a session working in a subdirectory (worktrees,
    // set_working_dir, a daemon started elsewhere) silently treed only that
    // subdirectory — and, unlike an explicit `path`, the default never passed
    // safeResolveReal's containment check. `glob` was fixed to this rule; the
    // fixture above cannot show it because cwd and projectRoot are the same dir.
    await fs.writeFile(path.join(tmpDir, 'root-level.txt'), '');
    const nested = path.join(tmpDir, 'nested-cwd');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'nested-only.txt'), '');

    const nestedCtx = { cwd: nested, tools: [], projectRoot: tmpDir } as any;
    const result = await treeTool.execute({}, nestedCtx, makeOpts());
    expect(result.path).toBe(tmpDir);
    expect(result.tree).toContain('root-level.txt');
    expect(result.tree).toContain('nested-only.txt');
  });

  // The option tests below used to run against an EMPTY tmpDir and only check
  // that a `tree` field existed, so an ignored option still passed.
  it('respects depth option', async () => {
    await fs.mkdir(path.join(tmpDir, 'outer', 'inner'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'outer', 'shallow.txt'), '');
    await fs.writeFile(path.join(tmpDir, 'outer', 'inner', 'deep.txt'), '');
    const ctx = makeCtx();
    const shallow = await treeTool.execute({ depth: 1 }, ctx, makeOpts());
    expect(shallow.tree).toContain('outer');
    expect(shallow.tree).not.toContain('deep.txt');
    const full = await treeTool.execute({ depth: 0 }, ctx, makeOpts());
    expect(full.tree).toContain('deep.txt');
  });

  it('respects show_files=false', async () => {
    await fs.mkdir(path.join(tmpDir, 'keepdir'));
    await fs.writeFile(path.join(tmpDir, 'hidden-by-option.txt'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_files: false }, ctx, makeOpts());
    expect(result.tree).toContain('keepdir');
    expect(result.tree).not.toContain('hidden-by-option.txt');
  });

  it('respects show_dirs=false', async () => {
    await fs.mkdir(path.join(tmpDir, 'somedir'));
    await fs.writeFile(path.join(tmpDir, 'visible.txt'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ show_dirs: false }, ctx, makeOpts());
    expect(result.tree).not.toContain('somedir/');
    expect(result.tree).toContain('visible.txt');
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
    await fs.writeFile(path.join(tmpDir, '.dotfile'), '');
    await fs.writeFile(path.join(tmpDir, 'plain.txt'), '');
    const ctx = makeCtx();
    const hiddenByDefault = await treeTool.execute({}, ctx, makeOpts());
    expect(hiddenByDefault.tree).not.toContain('.dotfile');
    expect(hiddenByDefault.tree).toContain('plain.txt');
    const shown = await treeTool.execute({ show_hidden: true }, ctx, makeOpts());
    expect(shown.tree).toContain('.dotfile');
  });

  it('respects exclude option', async () => {
    // A custom name: node_modules is already excluded by default, so it could
    // not tell whether the caller's list was applied.
    await fs.mkdir(path.join(tmpDir, 'skipme'));
    await fs.writeFile(path.join(tmpDir, 'skipme', 'inside.txt'), '');
    await fs.mkdir(path.join(tmpDir, 'keepme'));
    const ctx = makeCtx();
    const result = await treeTool.execute({ exclude: ['skipme'] }, ctx, makeOpts());
    expect(result.tree).not.toContain('skipme');
    expect(result.tree).not.toContain('inside.txt');
    expect(result.tree).toContain('keepme');
  });

  it('respects glob filter', async () => {
    await fs.writeFile(path.join(tmpDir, 'wanted.ts'), '');
    await fs.writeFile(path.join(tmpDir, 'unwanted.js'), '');
    const ctx = makeCtx();
    const result = await treeTool.execute({ glob: '*.ts' }, ctx, makeOpts());
    expect(result.tree).toContain('wanted.ts');
    expect(result.tree).not.toContain('unwanted.js');
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
    (treeTool as { executeStream: typeof treeTool.executeStream | undefined }).executeStream =
      undefined;
    try {
      await expect(treeTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      (treeTool as { executeStream: typeof treeTool.executeStream | undefined }).executeStream =
        original;
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

  it('throws when the base path is not a directory (not an empty tree)', async () => {
    const file = path.join(tmpDir, 'afile.txt');
    await fs.writeFile(file, 'hi');
    const ctx = makeCtx();
    await expect(treeTool.execute({ path: 'afile.txt' }, ctx, makeOpts())).rejects.toThrow(
      /tree: cannot list/,
    );
  });

  it('throws when the base path does not exist', async () => {
    const ctx = makeCtx();
    await expect(treeTool.execute({ path: 'no-such-dir-xyz' }, ctx, makeOpts())).rejects.toThrow(
      /tree: cannot list/,
    );
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
