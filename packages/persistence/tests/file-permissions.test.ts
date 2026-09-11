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

  it('hardens on Windows even when USERNAME and USER environment variables are unset', async () => {
    if (process.platform !== 'win32') return;
    const origUsername = process.env['USERNAME'];
    const origUser = process.env['USER'];
    delete process.env['USERNAME'];
    delete process.env['USER'];

    try {
      const testFile = path.join(dir, 'secret.json');
      await fs.writeFile(testFile, 'token');

      let warned = false;
      await restrictFilePermissions(testFile, {
        warn: () => {
          warned = true;
        },
      });

      expect(warned).toBe(false);

      const cp = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFile = promisify(cp.execFile);
      const { stdout } = await execFile('icacls', [testFile]);

      const expectedUser = os.userInfo().username;
      expect(stdout).toContain(expectedUser);
      expect(stdout).toContain(':(F)');
    } finally {
      if (origUsername !== undefined) process.env['USERNAME'] = origUsername;
      if (origUser !== undefined) process.env['USER'] = origUser;
    }
  });

  it('does not duplicate domain prefix when USERNAME is already domain-qualified', async () => {
    if (process.platform !== 'win32') return;
    const origUsername = process.env['USERNAME'];
    const origUser = process.env['USER'];
    const origDomain = process.env['USERDOMAIN'];
    const baseUser = origUsername ?? origUser ?? os.userInfo().username;
    const domain = origDomain ?? 'LOCALDOMAIN';

    process.env['USERDOMAIN'] = domain;
    process.env['USERNAME'] = `${domain}\\${baseUser}`;
    delete process.env['USER'];

    try {
      const testFile = path.join(dir, 'secret-domain.json');
      await fs.writeFile(testFile, 'token');

      let warned = false;
      await restrictFilePermissions(testFile, {
        warn: () => {
          warned = true;
        },
      });

      expect(warned).toBe(false);
    } finally {
      if (origUsername !== undefined) process.env['USERNAME'] = origUsername;
      else delete process.env['USERNAME'];
      if (origUser !== undefined) process.env['USER'] = origUser;
      else delete process.env['USER'];
      if (origDomain !== undefined) process.env['USERDOMAIN'] = origDomain;
      else delete process.env['USERDOMAIN'];
    }
  });

  it('hardens secret files written with mode 0o400 as owner-only on Windows', async () => {
    if (process.platform !== 'win32') return;
    const testFile = path.join(dir, 'readonly-secret.txt');
    const { atomicWrite } = await import('../src/atomic-write.js');
    await atomicWrite(testFile, 'read-only-token', { mode: 0o400 });

    const cp = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFile = promisify(cp.execFile);
    const { stdout } = await execFile('icacls', [testFile]);

    expect(stdout).not.toContain('BUILTIN\\Users:(I)(RX)');
    expect(stdout).toContain(':(F)');
  });
});

