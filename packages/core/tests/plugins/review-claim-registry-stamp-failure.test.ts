// Fault-injection coverage for the claim-store stamp-failure branch.
// Every lock acquisition's owner-stamp writeFile is forced to reject, so
// withStoreLock must: (1) remove its own freshly-created ownerless lock, and
// (2) surface the failure so claimFiles falls back to in-memory dedup — a
// silent swallow would leave an empty lock that degrades waiters until the
// mtime cap.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitReviewIfChanged } from '../../src/plugins/review-claim-registry.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (filePath: string, flags?: string) => {
      // Only the advisory-lock open is intercepted; everything else is real.
      if (flags === 'wx') {
        const handle = await actual.open(filePath, flags);
        const fake = Object.create(handle) as typeof handle;
        fake.writeFile = vi.fn().mockRejectedValue(new Error('injected EPERM'));
        return fake;
      }
      return actual.open(filePath, flags as string);
    }),
  };
});

function bundle(
  content: string,
): import('../../src/plugins/chimera-plugin.js').ReviewContextBundle {
  return {
    cwd: 'C:\\project',
    config: {
      enabled: true,
      provider: 'test',
      model: 'test',
      maxFiles: 15,
      autoFix: 'off',
      fallbackModels: [],
      fallbackProfile: undefined,
      cascadeOn: 'off',
      maxCascadeDepth: 0,
    },
    files: [{ path: 'src/file.ts', status: 'modified', content }],
  };
}

describe('review claim registry — stamp-failure branch', () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(os.tmpdir(), 'claim-stamp-'));
  });
  afterEach(async () => {
    vi.clearAllMocks();
    await rm(storeDir, { recursive: true, force: true });
  });

  it('removes the ownerless lock and falls back to in-memory dedup', async () => {
    const events = {};
    const emitCustom = vi.fn();
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');

    // The stamp writeFile rejects 3× → fail-closed throw → ownerless lock
    // must be unlinked, and the caller must still emit via the fallback.
    const emitted = await emitReviewIfChanged({ events, emitCustom } as never, bundle('v1'), {
      storeDir,
    });
    expect(emitted).not.toBeNull();
    expect(emitCustom).toHaveBeenCalledOnce();
    // The orphan lock is gone (removed by the stamp-failure cleanup).
    await expect(readFile(lockPath)).rejects.toThrow();
  });

  it('still dedupes same-content reviews within the session via the fallback', async () => {
    const events = {};
    const emitCustom = vi.fn();

    expect(
      await emitReviewIfChanged({ events, emitCustom } as never, bundle('v1'), { storeDir }),
    ).not.toBeNull();
    // Same content, same session → blocked by the in-memory fallback ledger.
    expect(
      await emitReviewIfChanged({ events, emitCustom } as never, bundle('v1'), { storeDir }),
    ).toBeNull();
    expect(emitCustom).toHaveBeenCalledOnce();
  });
});
