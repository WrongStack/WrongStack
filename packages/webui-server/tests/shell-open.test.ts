import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockRealpath = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  realpath: mockRealpath,
}));

import { handleShellOpen } from '../src/server/shell-open.js';

describe('shell-open', () => {
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const testPath = path.resolve('/tmp/test');
  const projectsPath = path.resolve('C:/Projects');

  beforeEach(() => {
    vi.clearAllMocks();
    // realpath returns the input by default (no symlinks in test paths)
    mockRealpath.mockImplementation((p: string) => Promise.resolve(p));
  });

  describe('handleShellOpen', () => {
    it('opens file manager on Windows', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });

      const result = await handleShellOpen(
        { path: projectsPath, target: 'file-manager' },
        logger as any,
        { projectRoot: projectsPath },
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('file-manager');
    });

    it('opens file manager on macOS', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });

      const result = await handleShellOpen(
        { path: testPath, target: 'file-manager' },
        logger as any,
        { projectRoot: testPath },
      );
      expect(result.success).toBe(true);
    });

    it('opens terminal on Windows', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });

      const result = await handleShellOpen(
        { path: testPath, target: 'terminal' },
        logger as any,
        { projectRoot: testPath },
      );
      expect(result.success).toBe(true);
    });

    it('rejects paths with metacharacters (ampersand)', async () => {
      mockAccess.mockResolvedValue(undefined);
      const badPath = path.resolve('/tmp/test&danger');
      // The METACHAR_REGEX includes & so a path with & should be rejected
      const result = await handleShellOpen(
        { path: badPath, target: 'file-manager' },
        logger as any,
        { projectRoot: path.resolve('/tmp') },
      );
      expect(result.success).toBe(false);
      expect(result.message).toBe('Path contains unsupported characters.');
    });

    it('rejects paths with pipe metacharacter', async () => {
      mockAccess.mockResolvedValue(undefined);
      const badPath = path.resolve('/tmp/test|danger');
      const result = await handleShellOpen(
        { path: badPath, target: 'file-manager' },
        logger as any,
        { projectRoot: path.resolve('/tmp') },
      );
      expect(result.success).toBe(false);
    });

    it('rejects paths with semicolon metacharacter', async () => {
      mockAccess.mockResolvedValue(undefined);
      const badPath = path.resolve('/tmp/test;danger');
      const result = await handleShellOpen(
        { path: badPath, target: 'file-manager' },
        logger as any,
        { projectRoot: path.resolve('/tmp') },
      );
      expect(result.success).toBe(false);
    });

    it('rejects paths with percent metacharacter', async () => {
      mockAccess.mockResolvedValue(undefined);
      const badPath = path.resolve('/tmp/test%danger');
      const result = await handleShellOpen(
        { path: badPath, target: 'file-manager' },
        logger as any,
        { projectRoot: path.resolve('/tmp') },
      );
      expect(result.success).toBe(false);
    });

    it('rejects when realpath resolves to a metacharacter path (symlink bypass)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });
      // Benign lexical path inside the project; the symlink's REAL target
      // carries a cmd.exe metacharacter but stays inside the project, so it
      // passes lexical AND canonical containment. The metacharacter guard
      // must also apply to the realpath result, not just the lexical path.
      const projectRoot = path.resolve('/tmp/proj');
      const linkPath = path.join(projectRoot, 'link');
      mockRealpath.mockImplementation((p: string) =>
        Promise.resolve(p === linkPath ? path.join(projectRoot, 'target&payload') : p),
      );
      const result = await handleShellOpen(
        { path: linkPath, target: 'file-manager' },
        logger as any,
        { projectRoot },
      );
      expect(result.success).toBe(false);
      expect(result.message).toBe('Path contains unsupported characters.');
    });

    it('returns error for unknown target', async () => {
      mockAccess.mockResolvedValue(undefined);
      const result = await handleShellOpen(
        { path: testPath, target: 'invalid' as any },
        logger as any,
        { projectRoot: testPath },
      );
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown shell.open target');
    });

    it('returns error when path does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT: path not found'));
      const result = await handleShellOpen(
        { path: '/nonexistent', target: 'file-manager' },
        logger as any,
        { projectRoot: '/nonexistent' },
      );
      expect(result.success).toBe(false);
    });

    it('correctly resolves relative paths against options.projectRoot rather than process.cwd()', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockSpawn.mockReturnValue({ on: vi.fn().mockReturnThis(), unref: vi.fn() });
      const customRoot = path.resolve('/var/my-custom-project-root');
      mockRealpath.mockImplementation((p: string) => Promise.resolve(p));

      const result = await handleShellOpen(
        { path: 'src/components', target: 'terminal' },
        logger as any,
        { projectRoot: customRoot },
      );
      expect(result.success).toBe(true);
    });
  });
});

