/**
 * Regression coverage for the Windows atomic-publish hardening in
 * packages/core/src/session-registry.ts.
 *
 * Before the fix, fs.rename on Windows returned EPERM/EBUSY when the
 * destination file was briefly held by an antivirus scan, an indexer, or a
 * peer process reading the file. SessionRegistry escalated that to a
 * SessionRegistryWriteError and aborted every subsequent ownership claim for
 * the lifetime of the process, so a single Windows hiccup left the TUI
 * unable to start.
 *
 * The hardened writeAtomicFile() falls back to fs.copyFile + tmp unlink when
 * rename fails with EPERM/EBUSY/EACCES; atomicUpdate() wraps the publish in
 * writeAtomicWithRetry() which re-attempts on the transient code set with a
 * short bounded backoff.
 *
 * Mocking strategy: ESM module namespaces are sealed on Node 22+, so we
 * cannot mutate the fs/promises export at runtime. vi.mock() replaces the
 * module before any consumer imports it; we keep the real fs/promises
 * available through vi.importActual() so unrelated paths (mkdtemp, readFile,
 * writeFile, open, etc.) stay genuine.
 *
 * What this pins:
 *   1. EPERM on rename is recoverable via the copyFile fallback.
 *   2. EBUSY and EACCES follow the same recovery path.
 *   3. Repeated transient failures escalate after the retry budget is
 *      exhausted (we never silently lose writes).
 *   4. Non-transient failures (EXDEV, etc.) are rethrown unchanged so the
 *      original failure mode is never masked.
 *
 * Atomicity caveat: the Windows publish is no longer strictly atomic
 * (copyFile + unlink instead of rename). Cross-process safety still holds
 * because we hold the cross-process advisory lock; readers must rely on the
 * 5 s heartbeat for the next snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PathLike } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

let renameFailureCode: string | null = null;
let copyFileFailureCode: string | null = null;

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    rename: vi.fn(async (src: PathLike, dst: PathLike) => {
      const isRegistryPublish =
        String(dst).endsWith('session-registry.json') && String(src).endsWith('.tmp');
      if (isRegistryPublish && renameFailureCode) {
        const err = new Error(`Simulated ${renameFailureCode}`) as NodeJS.ErrnoException;
        err.code = renameFailureCode;
        throw err;
      }
      return real.rename(src, dst);
    }),
    copyFile: vi.fn(async (src: PathLike, dst: PathLike) => {
      const isRegistryPublish =
        String(dst).endsWith('session-registry.json') && String(src).endsWith('.tmp');
      if (isRegistryPublish && copyFileFailureCode) {
        const err = new Error(`Simulated ${copyFileFailureCode}`) as NodeJS.ErrnoException;
        err.code = copyFileFailureCode;
        throw err;
      }
      return real.copyFile(src, dst);
    }),
  };
});

// Import the SUT AFTER vi.mock so it picks up the mocked fs/promises.
const { SessionRegistry } = await import('../../src/session-catalog/session-registry.js');

async function mktmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-reg-'));
}

const baseEntry = () => ({
  sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  projectSlug: 'test',
  projectRoot: process.cwd(),
  projectName: 'test',
  workingDir: process.cwd(),
  agents: [],
});

describe('SessionRegistry — Windows atomic publish hardening', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    renameFailureCode = null;
    copyFileFailureCode = null;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('writes the registry file through the rename path when fs.rename succeeds', async () => {
    const reg = new SessionRegistry(dir, { ownershipLockWaitMs: 5000 });
    const entry = baseEntry();
    await reg.register(entry);
    const file = path.join(dir, 'session-registry.json');
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed[entry.sessionId]?.sessionId).toBe(entry.sessionId);
    const leftover = (await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('falls back to fs.copyFile when fs.rename throws EPERM, leaving the registry consistent and no tmp leftovers', async () => {
    renameFailureCode = 'EPERM';
    const reg = new SessionRegistry(dir, { ownershipLockWaitMs: 5000 });
    const entry = baseEntry();
    await reg.register(entry);
    const file = path.join(dir, 'session-registry.json');
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(parsed[entry.sessionId]?.sessionId).toBe(entry.sessionId);
    const leftover = (await fsp.readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  });

  it('recovers from EBUSY and EACCES through the same fallback path', async () => {
    for (const code of ['EBUSY', 'EACCES'] as const) {
      renameFailureCode = code;
      const localDir = await mktmp();
      try {
        const reg = new SessionRegistry(localDir, { ownershipLockWaitMs: 5000 });
        const entry = baseEntry();
        await reg.register(entry);
        const parsed = JSON.parse(
          await fsp.readFile(path.join(localDir, 'session-registry.json'), 'utf8'),
        );
        expect(parsed[entry.sessionId]?.sessionId).toBe(entry.sessionId);
      } finally {
        await fsp.rm(localDir, { recursive: true, force: true });
      }
    }
  });

  it('escalates after the retry budget is exhausted on persistent EPERM', async () => {
    // Both paths fail: rename throws EPERM, the copyFile fallback also throws
    // EPERM. With ~5 attempts and ~250 ms backoff, retry budget exhausts and
    // the registry MUST escalate — we never silently lose writes.
    renameFailureCode = 'EPERM';
    copyFileFailureCode = 'EPERM';
    const reg = new SessionRegistry(dir, { ownershipLockWaitMs: 5000 });
    // Required = true (matches the production register() path), so we expect
    // a SessionRegistryWriteError after the retry budget is spent.
    await expect(reg.register(baseEntry())).rejects.toThrow(/EPERM/);
  });

  it('rethrows non-transient errors without retrying (no silent masking)', async () => {
    renameFailureCode = 'EXDEV';
    const reg = new SessionRegistry(dir, { ownershipLockWaitMs: 5000 });
    await expect(reg.register(baseEntry())).rejects.toThrow(/Simulated EXDEV/);
  });
});
