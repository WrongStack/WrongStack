import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  restrictDirPermissions,
  restrictFilePermissions,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
} from '../src/file-permissions.js';

describe('file-permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-fileperms-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exposes mode constants', () => {
    expect(SECRET_FILE_MODE).toBe(0o600);
    expect(SECRET_DIR_MODE).toBe(0o700);
  });

  it('restrictFilePermissions applies file mode without throwing on non-existent file', async () => {
    await expect(restrictFilePermissions(path.join(dir, 'missing.txt'))).resolves.toBeUndefined();
  });

  it('restrictDirPermissions applies dir mode without throwing on non-existent dir', async () => {
    await expect(restrictDirPermissions(path.join(dir, 'missing-dir'))).resolves.toBeUndefined();
  });

  it('applies (OI)(CI) inheritance flags on Windows for directories', async () => {
    if (process.platform !== 'win32') return;
    const testDir = path.join(dir, 'secret-dir');
    await fs.mkdir(testDir);
    await restrictDirPermissions(testDir);

    const cp = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFile = promisify(cp.execFile);
    const { stdout } = await execFile('icacls', [testDir]);
    expect(stdout).toContain('(OI)(CI)');

    // Verify child files inherit permissions
    const childFile = path.join(testDir, 'child.txt');
    await fs.writeFile(childFile, 'secret');
    const { stdout: childStdout } = await execFile('icacls', [childFile]);
    expect(childStdout).toContain('(I)(F)');
  });
});
