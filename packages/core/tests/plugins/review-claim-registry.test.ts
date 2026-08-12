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
      fallbackModels: [],
      fallbackProfile: undefined,
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
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
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
      now += 80;
      const ttlMs = 500;
      expect(
        await emitReviewIfChanged(
          { events: sessionA, emitCustom: secondEmit } as never,
          bundle('v1'),
          { storeDir, ttlMs },
        ),
      ).not.toBeNull();
      expect(secondEmit).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
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
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      // Session A claims v1 with a short TTL.
      const aBundle = await emitReviewIfChanged(
        { events: sessionA, emitCustom: firstEmit } as never,
        bundle('v1'),
        { storeDir, ttlMs: 50 },
      );
      expect(aBundle).not.toBeNull();

      // Claim expires; session B (same process, same HOST_SID) re-claims v1.
      now += 80;
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
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('releases a raw-emitted review whose claim is still installing', async () => {
    const rawBundle = bundle('v1');
    // A raw emitter dispatches recordStartedReview and the completion in the
    // same event emit (the no-Director release); the completion must await the
    // pending claim installation instead of no-op'ing and orphaning it.
    const started = recordStartedReview(sessionA as never, rawBundle, { storeDir });
    const completed = recordCompletedReview(sessionA as never, { bundle: rawBundle });
    await Promise.all([started, completed]);

    // The claim was released, so the same content is claimable again.
    const emit = vi.fn();
    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom: emit } as never, bundle('v1'), {
        storeDir,
      }),
    ).not.toBeNull();
    expect(emit).toHaveBeenCalledOnce();
  });

  it('emits only fingerprint-claimed files, not every entry for a shared path', async () => {
    // Session A holds a live claim on src/file.ts v1.
    const emitA = vi.fn();
    expect(
      await emitReviewIfChanged({ events: sessionA, emitCustom: emitA } as never, bundle('v1'), {
        storeDir,
      }),
    ).not.toBeNull();

    // Session B batches two entries for the SAME path — v1 (claimed by A) and
    // v2 (new). Only the v2 fingerprint may be emitted.
    const emitB = vi.fn();
    const dupBatch: ReviewContextBundle = {
      ...bundle('v1'),
      files: [
        { path: 'src/file.ts', status: 'modified', content: 'v1' },
        { path: 'src/file.ts', status: 'modified', content: 'v2' },
      ],
    };
    const emitted = await emitReviewIfChanged(
      { events: sessionB, emitCustom: emitB } as never,
      dupBatch,
      { storeDir },
    );
    expect(emitted).not.toBeNull();
    expect(emitted!.files).toHaveLength(1);
    expect(emitted!.files[0]!.content).toBe('v2');
    expect(emitB).toHaveBeenCalledOnce();
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
    // Backdate beyond the foreign lease cap (30s) but below the same-host
    // wedged-holder cap (60s): only the live-owner check can protect this lock.
    const past = new Date(Date.now() - 45_000);
    await utimes(lockPath, past, past);
    expect(await breakStaleLock(lockPath)).toBe(false);
  });

  it('breaks a same-host lock held implausibly long by a live owner', async () => {
    const lockPath = path.join(storeDir, 'review-claims.jsonl.lock');
    await writeFile(lockPath, `${os.hostname()}:${process.pid}`, 'utf8');
    // Past the same-host wedged-holder cap: a live-but-wedged holder must not
    // degrade cross-session dedup forever.
    const past = new Date(Date.now() - 61_000);
    await utimes(lockPath, past, past);
    expect(await breakStaleLock(lockPath)).toBe(true);
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

  it('expires in-memory fallback claims like the shared ledger', async () => {
    // Fresh session object so the per-EventBus fallback ledger starts empty.
    const sessionC = {};
    const blocker = path.join(storeDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const unwritable = path.join(blocker, 'sub');
    const emitCustom = vi.fn();

    expect(
      await emitReviewIfChanged({ events: sessionC, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 50,
      }),
    ).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // After the TTL, the same content is claimable again in the fallback path.
    expect(
      await emitReviewIfChanged({ events: sessionC, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 50,
      }),
    ).not.toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
  });

  it('does not let a late in-memory release delete a newer fallback claim', async () => {
    // Fresh session object so the per-EventBus fallback ledger starts empty.
    const sessionD = {};
    const blocker = path.join(storeDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const unwritable = path.join(blocker, 'sub');
    const emitCustom = vi.fn();

    const first = await emitReviewIfChanged(
      { events: sessionD, emitCustom } as never,
      bundle('v1'),
      { storeDir: unwritable, ttlMs: 50 },
    );
    expect(first).not.toBeNull();
    // Claim expires; the same content is re-claimed in the fallback path.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      await emitReviewIfChanged({ events: sessionD, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 50,
      }),
    ).not.toBeNull();
    // A's late completion must not delete B's newer live claim.
    await recordCompletedReview(sessionD as never, { bundle: first });
    expect(
      await emitReviewIfChanged({ events: sessionD, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 50,
      }),
    ).toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
  });

  it('evicts in-memory claims against the stored expiry, not the reader TTL', async () => {
    // Fresh session object so the per-EventBus fallback ledger starts empty.
    const sessionE = {};
    const blocker = path.join(storeDir, 'not-a-dir');
    await writeFile(blocker, 'x', 'utf8');
    const unwritable = path.join(blocker, 'sub');
    const emitCustom = vi.fn();

    // Claim with a short TTL → the stored exp is now+50ms.
    expect(
      await emitReviewIfChanged({ events: sessionE, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 50,
      }),
    ).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // A LATER reader with a much longer TTL must still see the claim as
    // expired (stored exp elapsed). Reader-local eviction (now - ts > 5000)
    // would wrongly keep it live and block this re-claim.
    expect(
      await emitReviewIfChanged({ events: sessionE, emitCustom } as never, bundle('v1'), {
        storeDir: unwritable,
        ttlMs: 5000,
      }),
    ).not.toBeNull();
    expect(emitCustom).toHaveBeenCalledTimes(2);
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
