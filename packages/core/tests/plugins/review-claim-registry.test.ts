import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewContextBundle } from '../../src/plugins/chimera-plugin.js';
import {
  breakStaleLock,
  emitReviewIfChanged,
  recordCompletedReview,
  recordStartedReview,
} from '../../src/plugins/review-claim-registry.js';

function bundle(content: string, filePath = 'src/file.ts'): ReviewContextBundle {
  return {
    cwd: 'C:\\project',
    config: {
      enabled: true,
      provider: 'test',
      model: 'test',
      maxFiles: 15,
      autoFix: 'off',
      cascadeOn: 'off',
      maxCascadeDepth: 0,
    },
    files: [
      {
        path: filePath,
        status: 'modified',
        content,
      },
    ],
  };
}

/** Distinct "session" objects — two sessions are two separate EventBuses. */
const sessionA = {};
const sessionB = {};

describe('review claim registry', () => {
  let storeDir: string;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(os.tmpdir(), 'claim-registry-'));
  });

  afterEach(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  it('allows only one plugin to emit the same file content on a shared session bus', async () => {
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();

    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: firstEmit } as never,
        bundle('v1'),
        { storeDir },
      ),
    ).not.toBeNull();
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: secondEmit } as never,
        bundle('v1'),
        { storeDir },
      ),
    ).toBeNull();
    expect(firstEmit).toHaveBeenCalledOnce();
    expect(secondEmit).not.toHaveBeenCalled();
  });

  it('allows a later review when the file content changes', async () => {
    const emitCustom = vi.fn();

    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v1'), {
        storeDir,
      }),
    ).not.toBeNull();
    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v2'), {
        storeDir,
      }),
    ).not.toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
  });

  it('counts an externally started manual review as a claim', async () => {
    const emitCustom = vi.fn();
    await recordStartedReview(sessionA as never, bundle('v1'), { storeDir });

    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v1'), {
        storeDir,
      }),
    ).toBeNull();
    expect(emitCustom).not.toHaveBeenCalled();
  });

  it('allows the same content to be reviewed again after completion', async () => {
    const emitCustom = vi.fn();
    const completedBundle = await emitReviewIfChanged(
      { events: sessionA, emitCustom } as never,
      bundle('v1'),
      { storeDir },
    );

    expect(completedBundle).not.toBeNull();
    await recordCompletedReview(sessionA as never, { bundle: completedBundle });

    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v1'), {
        storeDir,
      }),
    ).not.toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer content claim when an older review completes', async () => {
    const emitCustom = vi.fn();
    const olderBundle = await emitReviewIfChanged(
      { events: sessionA, emitCustom } as never,
      bundle('v1'),
      { storeDir },
    );

    expect(olderBundle).not.toBeNull();
    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v2'), {
        storeDir,
      }),
    ).not.toBeNull();
    await recordCompletedReview(sessionA as never, { bundle: olderBundle });

    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v2'), {
        storeDir,
      }),
    ).toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
  });

  it('rolls back the claim when synchronous event emission fails', async () => {
    const failedEmit = vi.fn(() => {
      throw new Error('emit failed');
    });
    const retryEmit = vi.fn();

    await expect(
      emitReviewIfChanged({ events: sessionA, emitCustom: failedEmit } as never, bundle('v1'), {
        storeDir,
      }),
    ).rejects.toThrow('emit failed');
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: retryEmit } as never,
        bundle('v1'),
        {
          storeDir,
        },
      ),
    ).not.toBeNull();
    expect(retryEmit).toHaveBeenCalledOnce();
  });

  it('lets a second session skip a fingerprint the first session already claimed', async () => {
    const sessionAEmit = vi.fn();
    const sessionBEmit = vi.fn();

    // Session A claims `v1` content on the shared store.
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: sessionAEmit } as never,
        bundle('v1'),
        { storeDir },
      ),
    ).not.toBeNull();

    // Session B — a different EventBus, same working tree — must NOT review
    // the same fingerprint while A's review is in flight.
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: sessionBEmit } as never,
        bundle('v1'),
        { storeDir },
      ),
    ).toBeNull();
    expect(sessionBEmit).not.toHaveBeenCalled();

    // Once A completes, B may review the same content again (sequential).
    const aBundle = vi.mocked(sessionAEmit).mock.calls[0]![1] as ReviewContextBundle;
    await recordCompletedReview(sessionA as never, { bundle: aBundle });
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: sessionBEmit } as never,
        bundle('v1'),
        { storeDir },
      ),
    ).not.toBeNull();
  });

  it('does not false-positive across sessions with separate working trees', async () => {
    const otherTree = await mkdtemp(path.join(os.tmpdir(), 'claim-registry-other-'));
    try {
      const emitA = vi.fn();
      const emitB = vi.fn();

      expect(
        await emitReviewIfChanged({ events: sessionA, emitCustom: emitA } as never, bundle('v1'), {
          storeDir,
        }),
      ).not.toBeNull();
      // Different store dir = different tree → B is not blocked by A's claim.
      expect(
        await emitReviewIfChanged({ events: sessionB, emitCustom: emitB } as never, bundle('v1'), {
          storeDir: otherTree,
        }),
      ).not.toBeNull();
      expect(emitA).toHaveBeenCalledOnce();
      expect(emitB).toHaveBeenCalledOnce();
    } finally {
      await rm(otherTree, { recursive: true, force: true });
    }
  });

  it('treats an expired claim as stale and allows re-claiming', async () => {
    const firstEmit = vi.fn();
    const secondEmit = vi.fn();

    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: firstEmit } as never,
        bundle('v1'),
        {
          storeDir,
          ttlMs: 50,
        },
      ),
    ).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: secondEmit } as never,
        bundle('v1'),
        { storeDir, ttlMs: 50 },
      ),
    ).not.toBeNull();
    expect(secondEmit).toHaveBeenCalledOnce();
  });

  it('keeps fresh claims when the ledger compacts in the same lock window', async () => {
    const emit = vi.fn();
    // Tiny threshold: the second claim batch crosses it and triggers a
    // compaction while the lock is still held.
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: emit } as never,
        bundle('v1', 'src/a.ts'),
        {
          storeDir,
          maxLedgerLines: 1,
        },
      ),
    ).not.toBeNull();
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: emit } as never,
        bundle('v2', 'src/b.ts'),
        {
          storeDir,
          maxLedgerLines: 1,
        },
      ),
    ).not.toBeNull();

    // Both claims — including the one appended in the compacting call — must
    // still be live for a second session after the rewrite.
    const emitB = vi.fn();
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: emitB } as never,
        bundle('v1', 'src/a.ts'),
        { storeDir, maxLedgerLines: 1 },
      ),
    ).toBeNull();
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: emitB } as never,
        bundle('v2', 'src/b.ts'),
        { storeDir, maxLedgerLines: 1 },
      ),
    ).toBeNull();
    expect(emitB).not.toHaveBeenCalled();
  });

  it('does not let a late release delete a newer claim of the same fingerprint', async () => {
    const firstEmit = vi.fn();
    const reClaimEmit = vi.fn();
    const checkEmit = vi.fn();

    // Session A claims v1 with a short TTL.
    const aBundle = await emitReviewIfChanged(
      { events: sessionA, emitCustom: firstEmit } as never,
      bundle('v1'),
      { storeDir, ttlMs: 50 },
    );
    expect(aBundle).not.toBeNull();

    // Claim expires; session B (same process, same HOST_SID) re-claims v1.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      await emitReviewIfChanged(
        { events: sessionB, emitCustom: reClaimEmit } as never,
        bundle('v1'),
        { storeDir, ttlMs: 50 },
      ),
    ).not.toBeNull();

    // A's completion arrives late. It must NOT release B's newer claim.
    await recordCompletedReview(sessionA as never, { bundle: aBundle });
    expect(
      await emitReviewIfChanged(
        { events: sessionA, emitCustom: checkEmit } as never,
        bundle('v1'),
        { storeDir, ttlMs: 50 },
      ),
    ).toBeNull();
    expect(checkEmit).not.toHaveBeenCalled();
  });

  it('breaks a lock whose owner process is dead even when freshly created', async () => {
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');
    await writeFile(lockPath, `${os.hostname()}:999999999`, 'utf8');
    // Backdate the mtime so only the pid check can classify it as stale.
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('keeps a lock whose owner process is alive even when the mtime is old', async () => {
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');
    await writeFile(lockPath, `${os.hostname()}:${process.pid}`, 'utf8');
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);
    // The live-owner check must protect it — an mtime-only breaker would steal
    // a lock from a holder that is mid-critical-section.
    expect(await breakStaleLock(lockPath)).toBe(false);
  });

  it('does not break a foreign-host lock on pid grounds, only past the lease cap', async () => {
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');
    const foreignHost = os.hostname() === 'host-a' ? 'host-b' : 'host-a';
    await writeFile(lockPath, `${foreignHost}:12345`, 'utf8');
    // Fresh mtime: the foreign pid is not interpretable here, so no break.
    expect(await breakStaleLock(lockPath)).toBe(false);
    // Past the lease cap: the foreign host is presumed crashed/wedged.
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('breaks an ownerless lock older than the age cap', async () => {
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');
    await writeFile(lockPath, '', 'utf8');
    const past = new Date(Date.now() - 120_000);
    await utimes(lockPath, past, past);
    expect(await breakStaleLock(lockPath)).toBe(true);
  });

  it('falls back to per-session dedup when the shared ledger is unwritable', async () => {
    // A plain file where a directory is expected → every ledger op fails.
    const blocker = path.join(storeDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const unwritable = path.join(blocker, 'sub');
    const emitCustom = vi.fn();

    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
      }),
    ).not.toBeNull();
    // Same session still dedupes via the in-memory fallback ledger.
    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
      }),
    ).toBeNull();
    expect(emitCustom).toHaveBeenCalledOnce();
  });
});
