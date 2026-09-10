/**
 * The directory holding `auth.json` must be hardened, not just the file.
 *
 * `restrictDirPermissions` had NO production call site anywhere in the repo
 * (audit 2026-08-20, re-reported 2026-09-10) — a correct, tested helper that
 * nothing reached, which is this codebase's most common security defect.
 *
 * The mode-bit assertion in `auth-store.test.ts` is POSIX-only and skips on
 * Windows, so it cannot pin the wiring on a Windows checkout — which is where
 * this repo is primarily developed. This file asserts the CALL instead, so the
 * helper going back to zero callers fails everywhere.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const restrictDirPermissions = vi.fn(async () => {});
const restrictFilePermissions = vi.fn(async () => {});

vi.mock('../../src/security/file-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/security/file-permissions.js')>();
  return {
    ...actual,
    restrictDirPermissions: (...args: unknown[]) => restrictDirPermissions(...(args as [])),
    restrictFilePermissions: (...args: unknown[]) => restrictFilePermissions(...(args as [])),
  };
});

let dir: string;

beforeEach(async () => {
  restrictDirPermissions.mockClear();
  restrictFilePermissions.mockClear();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-auth-dir-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeHqAuthFile hardens its data directory', () => {
  it('restricts the directory as well as the file', async () => {
    const { emptyHqAuthFile, hqAuthFilePath, writeHqAuthFile } = await import(
      '../../src/hq/auth-store.js'
    );

    await writeHqAuthFile(dir, emptyHqAuthFile());

    expect(restrictFilePermissions).toHaveBeenCalledWith(
      hqAuthFilePath(dir),
      expect.objectContaining({ label: 'hq-auth' }),
    );
    expect(restrictDirPermissions).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ label: 'hq-auth-dir' }),
    );
  });

  it('hardens on every write, not only the first', async () => {
    const { emptyHqAuthFile, writeHqAuthFile } = await import('../../src/hq/auth-store.js');
    await writeHqAuthFile(dir, emptyHqAuthFile());
    await writeHqAuthFile(dir, emptyHqAuthFile());
    expect(restrictDirPermissions).toHaveBeenCalledTimes(2);
  });
});
