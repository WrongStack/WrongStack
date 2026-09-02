import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathInside, resolveWorkingDirInsideProject } from '@wrongstack/webui-server';

describe('path containment helpers', () => {
  let tempDir: string;
  let projectRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-webui-path-'));
    projectRoot = path.join(tempDir, 'project');
    outsideRoot = path.join(tempDir, 'outside');
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('detects lexical containment using path.relative semantics', () => {
    expect(isPathInside('/repo', '/repo')).toBe(true);
    expect(isPathInside('/repo', '/repo/src')).toBe(true);
    expect(isPathInside('/repo', '/repo-other')).toBe(false);
    expect(isPathInside('/repo', '/tmp')).toBe(false);
  });

  it('accepts an existing directory inside the project root', async () => {
    await expect(resolveWorkingDirInsideProject(projectRoot, 'src')).resolves.toBe(
      path.join(projectRoot, 'src'),
    );
  });

  it('rejects a lexical escape outside the project root', async () => {
    await expect(resolveWorkingDirInsideProject(projectRoot, '../outside')).rejects.toThrow(
      'Path must stay inside the project root',
    );
  });

  it('rejects an in-project symlink that resolves outside the project root', async () => {
    const linkPath = path.join(projectRoot, 'outside-link');
    try {
      await fs.symlink(outsideRoot, linkPath, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    }

    await expect(resolveWorkingDirInsideProject(projectRoot, 'outside-link')).rejects.toThrow(
      'Path must stay inside the project root',
    );
  });
});
