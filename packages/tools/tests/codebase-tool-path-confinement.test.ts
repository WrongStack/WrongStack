import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codebaseAstReplaceTool,
  codebaseInvariantCheckTool,
  codebaseSkeletonTool,
  securityAstScanTool,
} from '../src/index.js';

// H-5/H-6 (security report VF-06/VF-07): the four codebase tools that resolved
// input paths with a bare `path.isAbsolute(input…) ? input : resolve(root, …)`
// passthrough are now routed through `safeResolveReal` — the same realpath
// containment check every sibling file tool uses. `permission: 'auto'` tools
// (skeleton, ast-scan, invariant-check) previously read arbitrary out-of-root
// files without ever prompting; ast-replace WROTE them. Restricted mode
// (`allowOutsideProjectRoot: false`) must actually restrict.
describe('codebase tool path confinement (H-5/H-6 / VF-06, VF-07)', () => {
  let projectDir: string;
  let outsideDir: string;

  const ctx = (allowOutside = false) =>
    ({
      projectRoot: projectDir,
      cwd: projectDir,
      workingDir: projectDir,
      allowOutsideProjectRoot: allowOutside,
    }) as never;
  const execOpts = { signal: new AbortController().signal };

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-confine-in-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-confine-out-'));
    await fs.writeFile(path.join(outsideDir, 'target.ts'), 'export const a = 1;\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'inside.ts'), 'export const b = 2;\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  const outside = () => path.join(outsideDir, 'target.ts');

  it('codebase-skeleton refuses an out-of-root absolute path', async () => {
    await expect(
      codebaseSkeletonTool.execute({ path: outside() }, ctx(), execOpts),
    ).rejects.toThrow(/outside project root/);
  });

  it('codebase-skeleton honors allowOutsideProjectRoot', async () => {
    const result = await codebaseSkeletonTool.execute({ path: outside() }, ctx(true), execOpts);
    expect(result.isDir).toBe(false);
  });

  it('security-ast-scan errors on an out-of-root path', async () => {
    const result = await securityAstScanTool.execute({ file: outside() }, ctx(), execOpts);
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside project root');
  });

  it('codebase-invariant-check errors on an out-of-root path', async () => {
    const result = await codebaseInvariantCheckTool.execute(
      { file: outside(), modifiedCode: 'export const a = 2;\n' },
      ctx(),
      execOpts,
    );
    expect(result.error).toContain('outside project root');
  });

  it('codebase-ast-replace errors on an out-of-root path', async () => {
    const result = await codebaseAstReplaceTool.execute(
      { file: outside(), symbol: 'a', newBody: '2' },
      ctx(),
      execOpts,
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside project root');
  });

  it('in-root targets still resolve (skeleton reads the project file)', async () => {
    const result = await codebaseSkeletonTool.execute(
      { path: path.join(projectDir, 'inside.ts') },
      ctx(),
      execOpts,
    );
    expect(result.isDir).toBe(false);
  });

  // Contract pin (Chimera review of the H-6 fix): these four tools' schemas
  // document "relative to projectRoot" — a nested workingDir (worktree,
  // set_working_dir) must NOT redirect a relative input.
  it('relative input stays project-root-relative when cwd is nested', async () => {
    const nested = path.join(projectDir, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'only-here.ts'), 'export const c = 3;\n', 'utf8');
    const nestedCtx = {
      projectRoot: projectDir,
      cwd: nested,
      workingDir: nested,
      allowOutsideProjectRoot: false,
    } as never;

    // 'inside.ts' lives at the project ROOT — resolving it against the nested
    // cwd would look for nested/inside.ts and fail.
    const result = await codebaseSkeletonTool.execute({ path: 'inside.ts' }, nestedCtx, execOpts);
    expect(result.isDir).toBe(false);

    // And the file that exists ONLY under nested/ is not reachable by bare
    // name — proving the resolve was root-relative, not cwd-relative.
    await expect(
      codebaseSkeletonTool.execute({ path: 'only-here.ts' }, nestedCtx, execOpts),
    ).rejects.toThrow(/not found/);
  });
});
