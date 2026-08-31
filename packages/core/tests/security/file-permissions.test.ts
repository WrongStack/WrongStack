/**
 * WS-045 — owner-only hardening for secret files.
 *
 * `restrictFilePermissions` was a private function inside `secret-vault.ts`,
 * reachable only by the config file. The HQ `auth.json` (bearer tokens) and
 * `runtime.json` (local client token) got `mode: 0o600` and nothing else —
 * which on Windows moves only the read-only bit, leaving both readable by
 * every other account on the machine.
 */
import * as childProcess from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  restrictDirPermissions,
  restrictFilePermissions,
  SECRET_DIR_MODE,
  SECRET_FILE_MODE,
} from '../../src/security/file-permissions.js';

const POSIX = process.platform !== 'win32';

// execFile is mocked (real impl by default) so a test can force an icacls
// failure that is NOT a missing path — a vanished file is silently skipped
// (nothing left to protect), so only a mocked outage exercises the warning.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe('file-permissions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wrongstack-fileperms-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes the owner-only constants the secret writers use', () => {
    expect(SECRET_FILE_MODE).toBe(0o600);
    expect(SECRET_DIR_MODE).toBe(0o700);
  });

  it.skipIf(!POSIX)('tightens a world-readable secret file to 0600', async () => {
    const target = join(dir, 'auth.json');
    await writeFile(target, '{"browserTokens":[]}');
    await chmod(target, 0o644);

    await restrictFilePermissions(target, { label: 'test' });

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!POSIX)('tightens a secret directory to 0700', async () => {
    const secretDir = join(dir, 'hq');
    await mkdir(secretDir);
    await chmod(secretDir, 0o755);

    await restrictDirPermissions(secretDir, { label: 'test' });

    expect((await stat(secretDir)).mode & 0o777).toBe(0o700);
  });

  it('never throws on a missing path — hardening must not block the write', async () => {
    const warnings: string[] = [];
    await expect(
      restrictFilePermissions(join(dir, 'does-not-exist'), {
        label: 'test',
        warn: (m) => warnings.push(m),
      }),
    ).resolves.toBeUndefined();
    await expect(
      restrictDirPermissions(join(dir, 'also-missing'), {
        label: 'test',
        warn: (m) => warnings.push(m),
      }),
    ).resolves.toBeUndefined();
  });

  it('labels its warnings so operators can tell which subsystem failed', async () => {
    // Only the Windows branch warns; on POSIX chmod failures are silent by
    // design (the caller already wrote the file with the right mode).
    if (POSIX) return;
    // Force an icacls failure on a LIVE path: the missing-path case is now
    // silent by design, so the warning contract needs a real outage.
    const target = join(dir, 'auth.json');
    await writeFile(target, '{"browserTokens":[]}');
    vi.mocked(childProcess.execFile).mockImplementationOnce(() => {
      throw new Error('mocked icacls outage');
    });
    const warnings: string[] = [];
    await restrictFilePermissions(target, {
      label: 'hq-auth',
      warn: (m) => warnings.push(m),
    });
    expect(warnings.some((w) => w.includes('[hq-auth]'))).toBe(true);
    expect(warnings.some((w) => w.includes('mocked icacls outage'))).toBe(true);
  });
});
