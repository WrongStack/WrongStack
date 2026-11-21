import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globTool } from '../src/glob.js';
import { mkSandbox, newSignal, type Sandbox } from './fixtures.js';

describe('glob tool', () => {
  let sb: Sandbox;
  let outsideRoot: string;

  beforeEach(async () => {
    sb = await mkSandbox();
    // A sibling tmp dir used as the destination for out-of-root symlinks.
    // We clean it up in `afterEach` so tests can't leak files across runs.
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-glob-outside-'));
  });
  afterEach(async () => {
    await sb.cleanup();
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  it('matches files with simple pattern', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'b.js'), '');
    const out = await globTool.execute({ pattern: '*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(out.files.some((f) => f.endsWith('b.js'))).toBe(false);
  });

  it('expands brace alternation instead of matching nothing', async () => {
    for (const f of ['a.ts', 'b.tsx', 'c.md', '{id}.ts'])
      await fs.writeFile(path.join(sb.dir, f), '');
    const names = async (pattern: string) =>
      (await globTool.execute({ pattern }, sb.ctx, { signal: newSignal() })).files
        .map((f) => path.basename(f))
        .sort();
    expect(await names('*.{ts,tsx}')).toEqual(['a.ts', 'b.tsx', '{id}.ts']);
    // A comma-less group is a literal file name.
    expect(await names('{id}.ts')).toEqual(['{id}.ts']);
  });

  it('throws for a non-existent base path instead of returning no files', async () => {
    await expect(
      globTool.execute({ pattern: '*.ts', path: 'does-not-exist' }, sb.ctx, {
        signal: newSignal(),
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('throws when the base path is a file, not a directory', async () => {
    await fs.writeFile(path.join(sb.dir, 'plain.txt'), '');
    await expect(
      globTool.execute({ pattern: '*', path: 'plain.txt' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/is not a directory/);
  });

  it('recurses with **', async () => {
    await fs.mkdir(path.join(sb.dir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'deep', 'a.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.length).toBe(1);
  });

  it('ignores node_modules by default', async () => {
    await fs.mkdir(path.join(sb.dir, 'node_modules', 'foo'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'node_modules', 'foo', 'index.js'), '');
    await fs.writeFile(path.join(sb.dir, 'me.js'), '');
    const out = await globTool.execute({ pattern: '**/*.js' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(out.files.some((f) => f.endsWith('me.js'))).toBe(true);
  });

  it('matches a nested file by basename when the pattern has no slashes', async () => {
    // rel ("src/deep/x.ts") won't match "x.ts", but the basename does → exercises
    // the `re.test(name)` arm of the match check.
    await fs.mkdir(path.join(sb.dir, 'src', 'deep'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'deep', 'x.ts'), '');
    const out = await globTool.execute({ pattern: 'x.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('x.ts'))).toBe(true);
  });

  it('requires a pattern', async () => {
    await expect(
      globTool.execute({ pattern: '' }, sb.ctx, { signal: newSignal() }),
    ).rejects.toThrow(/pattern is required/);
  });

  it('stops the walk when the abort signal is already aborted', async () => {
    await fs.writeFile(path.join(sb.dir, 'a.ts'), '');
    const ctrl = new AbortController();
    ctrl.abort();
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: ctrl.signal });
    expect(out.files).toEqual([]);
    expect(out.truncated).toBe(true);
  });

  it('reads and applies .gitignore entries', async () => {
    await fs.writeFile(path.join(sb.dir, '.gitignore'), '# comment\nignored\n\n');
    await fs.mkdir(path.join(sb.dir, 'ignored'));
    await fs.writeFile(path.join(sb.dir, 'ignored', 'hidden.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'visible.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    expect(out.files.some((f) => f.endsWith('visible.ts'))).toBe(true);
    expect(out.files.some((f) => f.includes('ignored'))).toBe(false);
  });

  it('applies full .gitignore semantics: globs, anchored dirs, and nested paths', async () => {
    await fs.writeFile(path.join(sb.dir, '.gitignore'), '*.generated.ts\n/artifacts/\nsrc/tmp/\n');
    await fs.mkdir(path.join(sb.dir, 'artifacts'));
    await fs.writeFile(path.join(sb.dir, 'artifacts', 'bundle.ts'), '');
    await fs.mkdir(path.join(sb.dir, 'src', 'tmp'), { recursive: true });
    await fs.writeFile(path.join(sb.dir, 'src', 'tmp', 'scratch.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'src', 'api.generated.ts'), '');
    await fs.writeFile(path.join(sb.dir, 'src', 'api.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, { signal: newSignal() });
    const names = out.files.map((f) => f.replaceAll('\\', '/'));
    expect(names.some((f) => f.endsWith('src/api.ts'))).toBe(true);
    expect(names.some((f) => f.includes('artifacts/'))).toBe(false);
    expect(names.some((f) => f.includes('src/tmp/'))).toBe(false);
    expect(names.some((f) => f.endsWith('api.generated.ts'))).toBe(false);
  });

  it('hits limit and truncates', async () => {
    // Create more files than the default limit of 1000
    for (let i = 0; i < 50; i++) {
      await fs.writeFile(path.join(sb.dir, `file${i}.ts`), '');
    }
    const out = await globTool.execute({ pattern: '*.ts', limit: 5 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBeLessThanOrEqual(5);
  });

  it('stops walking sibling entries once a subdirectory hits the limit', async () => {
    // The limit is reached inside `sub`, so the parent walk returns at the
    // post-recursion `if (truncated) return` guard.
    await fs.mkdir(path.join(sb.dir, 'sub'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      await fs.writeFile(path.join(sb.dir, 'sub', `f${i}.ts`), '');
    }
    await fs.writeFile(path.join(sb.dir, 'zzz-sibling.ts'), '');
    const out = await globTool.execute({ pattern: '**/*.ts', limit: 2 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(true);
    expect(out.files.length).toBeLessThanOrEqual(2);
  });

  /** Write `count` files with distinct, deterministic mtimes (seconds). */
  async function writeDatedFiles(count: number): Promise<Array<{ name: string; mtime: number }>> {
    const out: Array<{ name: string; mtime: number }> = [];
    for (let i = 0; i < count; i++) {
      const name = `f${i}.ts`;
      const full = path.join(sb.dir, name);
      await fs.writeFile(full, '');
      const t = 1_700_000_000 + i;
      await fs.utimes(full, t, t);
      out.push({ name, mtime: t });
    }
    return out;
  }

  it('keeps exactly the N newest files by mtime when truncated (regression)', async () => {
    // Pins the min-heap retention: the previous linear rescan picked the same
    // set, so this guards the rewrite rather than the old cost.
    const files = await writeDatedFiles(12);
    const limit = 5;
    const out = await globTool.execute({ pattern: '*.ts', limit }, sb.ctx, {
      signal: newSignal(),
    });

    const expected = files
      .slice()
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map((f) => f.name);

    expect(out.truncated).toBe(true);
    expect(out.files).toHaveLength(limit);
    expect(out.files.map((f) => path.basename(f)).sort()).toEqual([...expected].sort());
    // Newest first.
    expect(path.basename(out.files[0]!)).toBe(expected[0]);
    // The oldest file must have been evicted.
    expect(out.files.some((f) => f.endsWith('f0.ts'))).toBe(false);
  });

  it('keeps only the single newest file at limit=1 (regression)', async () => {
    const files = await writeDatedFiles(6);
    const newest = files.reduce((a, b) => (b.mtime > a.mtime ? b : a)).name;
    const out = await globTool.execute({ pattern: '*.ts', limit: 1 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(true);
    expect(out.files.map((f) => path.basename(f))).toEqual([newest]);
  });

  it('returns every match with truncated=false when the limit is not reached', async () => {
    const files = await writeDatedFiles(4);
    const out = await globTool.execute({ pattern: '*.ts', limit: 1000 }, sb.ctx, {
      signal: newSignal(),
    });
    expect(out.truncated).toBe(false);
    expect(out.files).toHaveLength(files.length);
    expect([...out.files.map((f) => path.basename(f))].sort()).toEqual(
      [...files.map((f) => f.name)].sort(),
    );
  });

  describe('symlink containment (CWE-59)', () => {
    it('does not recurse into a symlink whose target is outside the project root', async () => {
      // Place files inside the sandbox and inside the sibling outsideRoot.
      await fs.mkdir(path.join(sb.dir, 'in-root'), { recursive: true });
      await fs.writeFile(path.join(sb.dir, 'in-root', 'safe.ts'), '');
      await fs.mkdir(path.join(outsideRoot, 'secret'), { recursive: true });
      await fs.writeFile(path.join(outsideRoot, 'secret', 'leaked.ts'), '');
      // Symlink inside the workspace, pointing at the outside directory.
      await fs.symlink(outsideRoot, path.join(sb.dir, 'escape'), 'dir');

      const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, {
        signal: newSignal(),
      });

      expect(out.files.some((f) => f.endsWith('safe.ts'))).toBe(true);
      // The leak: the file under the symlinked directory must NOT be returned.
      expect(out.files.some((f) => f.includes('leaked.ts'))).toBe(false);
      expect(out.files.some((f) => f.includes('escape'))).toBe(false);
    });

    it('does not include a symlink file whose target is outside the project root', async () => {
      await fs.writeFile(path.join(sb.dir, 'real.ts'), '');
      await fs.writeFile(path.join(outsideRoot, 'passwd'), 'shadow');
      await fs.symlink(path.join(outsideRoot, 'passwd'), path.join(sb.dir, 'alias'));

      const out = await globTool.execute({ pattern: '*' }, sb.ctx, { signal: newSignal() });

      expect(out.files.some((f) => f.endsWith('real.ts'))).toBe(true);
      expect(out.files.some((f) => f.endsWith('alias'))).toBe(false);
    });

    it('still recurses into symlinks that stay inside the project root', async () => {
      // A legitimate in-workspace symlink should continue to work — the
      // containment check must not be so broad that it blocks real use.
      await fs.mkdir(path.join(sb.dir, 'real'), { recursive: true });
      await fs.writeFile(path.join(sb.dir, 'real', 'a.ts'), '');
      await fs.symlink(path.join(sb.dir, 'real'), path.join(sb.dir, 'link'), 'dir');

      const out = await globTool.execute({ pattern: '**/*.ts' }, sb.ctx, {
        signal: newSignal(),
      });

      // Both the real path and the symlink path should surface a.ts — the
      // walker recurses into the linked directory and matches the file.
      const hits = out.files.filter((f) => f.endsWith('a.ts'));
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    it('rejects a base path that itself resolves outside the project root', async () => {
      // The user-named base path is symlinked to outsideRoot. The base
      // should fail the realpath-containment check loudly (like single-file
      // tools do) rather than silently returning nothing.
      await fs.writeFile(path.join(outsideRoot, 'elsewhere.ts'), '');
      await fs.symlink(outsideRoot, path.join(sb.dir, 'outside-link'), 'dir');

      await expect(
        globTool.execute({ pattern: '**/*.ts', path: 'outside-link' }, sb.ctx, {
          signal: newSignal(),
        }),
      ).rejects.toThrow(/outside project root/);
    });

    it('honors ctx.signal when opts is omitted and ctx.signal is aborted', async () => {
      await fs.mkdir(path.join(sb.dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(sb.dir, 'src', 'a.ts'), '');
      await fs.writeFile(path.join(sb.dir, 'src', 'b.ts'), '');

      const ctrl = new AbortController();
      ctrl.abort();
      const ctxWithSignal = { ...sb.ctx, signal: ctrl.signal };

      const out = await globTool.execute(
        { pattern: '**/*.ts' },
        ctxWithSignal as any,
        undefined as unknown as { signal: AbortSignal },
      );
      expect(out.truncated).toBe(true);
      expect(out.files.length).toBe(0);
    });
  });

  // The schema says `path` "defaults to project root" and the usage hint says
  // returned paths are "relative to the project root". The default base and the
  // relativizer instead used `ctx.cwd`, which is only the root by coincidence:
  // a nested working dir (worktrees / set_working_dir) sent the walk into one
  // subdirectory, and a server launched elsewhere walked — unvalidated — a
  // directory outside the root that an explicit `path` would have been refused
  // for (safeResolveReal).
  it('searches the documented project root when the session cwd is nested', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-glob-root-'));
    const nested = path.join(project, 'pkg');
    await fs.mkdir(path.join(nested, 'src'), { recursive: true });
    await fs.writeFile(path.join(project, 'top.ts'), '');
    await fs.writeFile(path.join(nested, 'src', 'a.ts'), '');
    try {
      const ctx = { ...sb.ctx, projectRoot: project, cwd: nested };
      const out = await globTool.execute({ pattern: '**/*.ts' }, ctx as any, {
        signal: newSignal(),
      });
      expect(out.files.slice().sort()).toEqual([path.join('pkg', 'src', 'a.ts'), 'top.ts'].sort());
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it('never walks outside the project root through the default base', async () => {
    await fs.writeFile(path.join(outsideRoot, 'secret.txt'), '');
    const ctx = { ...sb.ctx, projectRoot: sb.dir, cwd: outsideRoot };
    const out = await globTool.execute({ pattern: '*.txt' }, ctx as any, {
      signal: newSignal(),
    });
    expect(out.files).toEqual([]);
  });
});
