import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import { isPathInside, resolveWorkingDirInsideProject } from '../src/server/path-containment.js';

describe('isPathInside', () => {
  const root = '/project/root';

  it('returns true when target is inside the root', () => {
    expect(isPathInside(root, '/project/root/subdir/file.txt')).toBe(true);
  });

  it('returns true when target equals the root', () => {
    expect(isPathInside(root, root)).toBe(true);
  });

  it('returns false when target is outside the root (sibling)', () => {
    expect(isPathInside(root, '/project/other/file.txt')).toBe(false);
  });

  it('returns false when target uses parent path traversal', () => {
    expect(isPathInside(root, '/project/root/../outside/file.txt')).toBe(false);
  });

  it('returns false when target is an absolute path outside', () => {
    expect(isPathInside(root, '/outside')).toBe(false);
  });

  it('handles Windows-style paths (forward slash normalized)', () => {
    // On Windows, the real path.resolve would handle drive letters
    // But isPathInside normalizes via path.relative which works correctly
    expect(isPathInside('C:/project', 'C:/project/file.txt')).toBe(true);
    expect(isPathInside('C:/project', 'D:/other/file.txt')).toBe(false);
  });

  it('returns false for empty relative target that does not equal root', () => {
    // path.relative('/project/root', '/project/root/../other') would be '../other'
    expect(isPathInside('/project/root', '/project/root/..')).toBe(false);
  });
});

describe('resolveWorkingDirInsideProject', () => {
  let tmpDir: string;
  let projectRoot: string;

  it('resolves a subdirectory inside the project root', async () => {
    // Create a real temp structure for integration testing
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    const subdir = path.join(projectRoot, 'subdir');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(subdir, { recursive: true });

    try {
      const result = await resolveWorkingDirInsideProject(projectRoot, './subdir');
      expect(result).toBe(path.resolve(projectRoot, 'subdir'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves the project root itself', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    try {
      const result = await resolveWorkingDirInsideProject(projectRoot, '.');
      expect(result).toBe(path.resolve(projectRoot));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when the directory does not exist', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    try {
      await expect(resolveWorkingDirInsideProject(projectRoot, './nonexistent')).rejects.toThrow(
        /Directory not found/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when the path is a file, not a directory', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });
    const filePath = path.join(projectRoot, 'file.txt');
    await fs.writeFile(filePath, 'hello');

    try {
      await expect(resolveWorkingDirInsideProject(projectRoot, './file.txt')).rejects.toThrow(
        /Directory not found/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when the resolved path escapes the project root', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    const outside = path.join(tmpDir, 'outside');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });

    try {
      await expect(resolveWorkingDirInsideProject(projectRoot, `../outside`)).rejects.toThrow(
        /Path must stay inside the project root/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Windows: `D:` (no slash) is drive-relative. path.resolve(project, 'D:')
  // becomes the current directory on D:, which is often process.cwd() and
  // need not be inside projectRoot (e.g. project in %TEMP% on C:, cwd on D:).
  it('rejects a drive-relative path that resolves to cwd outside the project', async () => {
    if (process.platform !== 'win32') return;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-test-'));
    projectRoot = path.join(tmpDir, 'project');
    await fs.mkdir(projectRoot, { recursive: true });

    const cwdRoot = path.parse(process.cwd()).root;
    const projectRootDrive = path.parse(path.resolve(projectRoot)).root;
    if (cwdRoot.toLowerCase() === projectRootDrive.toLowerCase()) {
      // Same-drive cwd cannot demonstrate the jump; lexical `..` is covered above.
      await fs.rm(tmpDir, { recursive: true, force: true });
      return;
    }

    const driveLetter = cwdRoot.replace(/[\\/]/g, '');
    try {
      await expect(resolveWorkingDirInsideProject(projectRoot, driveLetter)).rejects.toThrow(
        /Path must stay inside the project root/,
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// B-07: migrated from packages/webui/tests/server/path-containment.test.ts —
// the symlink escape regression. The server suite pins lexical `..` traversal
// (`../outside`) but never a symlink pointing OUTSIDE the project root, which
// is the more dangerous vector: a normal-looking in-project entry like
// `node_modules/.bin/shim` can resolve to an attacker-controlled directory
// outside the project. The webui file used a real fs.symlink() to model the
// production scenario; the server test below keeps that pattern.
describe('resolveWorkingDirInsideProject — symlink escape (WS-016 regression)', () => {
  let tmpDir: string;
  let projectRoot: string;
  let outsideRoot: string;

  it('rejects an in-project symlink that resolves outside the project root', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-symlink-'));
    projectRoot = path.join(tmpDir, 'project');
    outsideRoot = path.join(tmpDir, 'outside');
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });

    const linkPath = path.join(projectRoot, 'outside-link');
    try {
      await fs.symlink(outsideRoot, linkPath, 'dir');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        // Some sandboxes forbid symlink creation; skip rather than fail.
        await fs.rm(tmpDir, { recursive: true, force: true });
        return;
      }
      throw err;
    }

    try {
      await expect(resolveWorkingDirInsideProject(projectRoot, 'outside-link')).rejects.toThrow(
        'Path must stay inside the project root',
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
