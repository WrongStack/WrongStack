import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '@wrongstack/core/agent';
import type { Provider, SessionWriter } from '@wrongstack/core/types';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { setWorkingDirTool } from '../src/set-working-dir.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const fakeProvider = {} as Provider;
const fakeSession: SessionWriter = {
  id: 't',
  pendingToolUses: [],
  append: async () => undefined,
  appendBatch: async () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
};

function mkSignal(): AbortSignal {
  return new AbortController().signal;
}

function mkContext(root: string, wd?: string, allowOutsideProjectRoot = false): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'hi' }],
    provider: fakeProvider,
    session: fakeSession,
    signal: mkSignal(),
    tokenCounter: new DefaultTokenCounter(),
    cwd: root,
    projectRoot: root,
    workingDir: wd ?? root,
    allowOutsideProjectRoot,
    model: 'm',
  });
}

// ── Temp dir ───────────────────────────────────────────────────────────────

let tmpRoot: string;
let subDir: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `wstack-swd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  subDir = path.join(tmpRoot, 'src');
  await fs.mkdir(subDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('set_working_dir tool', () => {
  it('has correct metadata', () => {
    expect(setWorkingDirTool.name).toBe('set_working_dir');
    expect(setWorkingDirTool.category).toBe('Context');
    expect(setWorkingDirTool.mutating).toBe(true);
    expect(setWorkingDirTool.capabilities).toContain('fs.read');
  });

  it('queries current directory when no path provided', async () => {
    const ctx = mkContext(tmpRoot, subDir);
    const result = await setWorkingDirTool.execute({}, ctx, { signal: mkSignal() });
    expect(result.current).toBe(path.resolve(subDir));
    expect(result.message).toContain('Current working directory');
  });

  it('changes to a relative subdirectory', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute({ path: 'src' }, ctx, { signal: mkSignal() });
    expect(result.current).toBe(path.resolve(subDir));
    expect(result.previous).toBe(path.resolve(tmpRoot));
    expect(result.message).toContain('src');
  });

  it('changes to an absolute path within project root', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute({ path: subDir }, ctx, { signal: mkSignal() });
    expect(result.current).toBe(path.resolve(subDir));
    expect(result.message).toContain('changed');
  });

  it('updates ctx.workingDir after successful navigation', async () => {
    const ctx = mkContext(tmpRoot);
    await setWorkingDirTool.execute({ path: 'src' }, ctx, { signal: mkSignal() });
    expect(ctx.workingDir).toBe(path.resolve(subDir));
  });

  it('returns error when directory does not exist', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute(
      { path: 'nope' },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.error).toContain('does not exist');
    expect(result.current).toBe(path.resolve(tmpRoot)); // stays at previous
  });

  it('rejects a path that is a file, not a directory', async () => {
    // fs.access() used to accept plain files, leaving workingDir pointing at
    // a file — every later spawn/path-resolve then failed confusingly.
    const filePath = path.join(tmpRoot, 'afile.txt');
    await fs.writeFile(filePath, 'not a directory');
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute(
      { path: 'afile.txt' },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.error).toContain('does not exist');
    expect(ctx.workingDir).toBe(path.resolve(tmpRoot)); // rolled back
  });

  it('returns error for path outside project root', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute(
      { path: '/etc' },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.error).toContain('outside project root');
    expect(result.current).toBe(path.resolve(tmpRoot)); // unchanged
  });

  it('returns error for relative path escaping via ..', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute(
      { path: '../../etc' },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.error).toContain('outside project root');
  });

  it('navigates outside the project root when filesystem access is unrestricted', async () => {
    // An existing directory outside tmpRoot. os.tmpdir() is the parent of tmpRoot.
    const outside = path.resolve(os.tmpdir());
    const ctx = mkContext(tmpRoot, undefined, /* allowOutsideProjectRoot */ true);
    const result = await setWorkingDirTool.execute(
      { path: outside },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.error).toBeUndefined();
    expect(ctx.workingDir).toBe(outside);
  });

  it('rolls back workingDir when directory does not exist', async () => {
    const ctx = mkContext(tmpRoot, subDir);
    const before = ctx.workingDir;
    // Try to navigate to a non-existent subdirectory
    await setWorkingDirTool.execute(
      { path: 'ghost' },
      ctx,
      { signal: mkSignal() },
    );
    // Should stay at the previous working directory
    expect(ctx.workingDir).toBe(before);
  });

  it('navigates to nested subdirectories (relative to project root)', async () => {
    const ctx = mkContext(tmpRoot);
    const libDir = path.join(subDir, 'lib');
    await fs.mkdir(libDir, { recursive: true });

    // Navigate to src (relative to projectRoot)
    await setWorkingDirTool.execute({ path: 'src' }, ctx, { signal: mkSignal() });
    expect(ctx.workingDir).toBe(path.resolve(subDir));

    // Navigate to src/lib — must use path relative to projectRoot, not cwd
    await setWorkingDirTool.execute({ path: 'src/lib' }, ctx, { signal: mkSignal() });
    expect(ctx.workingDir).toBe(path.resolve(libDir));
  });

  it('reports the previous directory in the result', async () => {
    const ctx = mkContext(tmpRoot);
    const result = await setWorkingDirTool.execute(
      { path: 'src' },
      ctx,
      { signal: mkSignal() },
    );
    expect(result.previous).toBe(path.resolve(tmpRoot));
  });
});
