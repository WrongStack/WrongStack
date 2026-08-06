import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { PluginAPI } from '../types/plugin.js';
import { isPidAlive } from '../utils/pid.js';
import type { ReviewContextBundle, ReviewFileEntry } from './review-types.js';

interface ReviewClaim {
  key: string;
  fingerprint: string;
  /** Host stamp so a release can only ever target its own claim. */
  sid: string;
  /** Claim time in ms since epoch — used for TTL expiry. */
  ts: number;
}

interface StartedReview {
  /** Claiming bus — a completion from another bus must not release these. */
  events: EventBus;
  /** Shared ledger dir, or null when the claim fell back to in-memory mode. */
  storeDir: string | null;
  claims: ReviewClaim[];
}

/** Ledger line persisted under `<cwd>/.wrongstack/review-claims.jsonl`. */
interface LedgerLine {
  op: 'claim' | 'release';
  key: string;
  fp: string;
  sid: string;
  /** For claims: the claim time. For releases: the CLAIM time it targets. */
  ts: number;
  /** For claims: absolute expiry (claim ts + the claiming caller's TTL). */
  exp?: number | undefined;
}

export interface ClaimStoreOptions {
  /**
   * Override the shared claim-ledger directory. Defaults to `<cwd>/.wrongstack`
   * (git-ignored, shared by every session on the same working tree). Tests
   * inject a temp dir; two EventBuses sharing one dir dedupe like two hosts.
   */
  storeDir?: string | undefined;
  /** Claim lifetime in ms before it is treated as stale (default 30 min). */
  ttlMs?: number | undefined;
  /** Ledger compaction threshold in lines (default 10,000). Test override. */
  maxLedgerLines?: number | undefined;
}

/**
 * In-flight review claims are scoped to the whole working tree, not to one
 * session: parallel hosts on the same tree share a JSONL claim ledger under
 * `<cwd>/.wrongstack/review-claims.jsonl`, so a fingerprint claimed by session
 * A is skipped by session B. Claims are released on review completion and
 * expire after {@link DEFAULT_CLAIM_TTL_MS} so a crashed host cannot wedge
 * the file forever.
 *
 * When the ledger is unwritable (read-only tree, minimal hosts, sandboxed
 * tests), the registry falls back to a per-EventBus in-memory ledger that
 * preserves the previous within-session dedup behavior.
 */
const CLAIMS_FILE = 'review-claims.jsonl';
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MAX_MS = 50;
const LOCK_STALE_MS = 30_000;
/** Same-host live-owner lock cap — sub-second holds never reach it. */
const SAME_HOST_STALE_MS = 2 * LOCK_STALE_MS;
/**
 * Extra budget for the one lock-contention retry before degraded fallback —
 * long enough to also cover a foreign-host lease break (LOCK_STALE_MS) and
 * the same-host wedged-holder cap (SAME_HOST_STALE_MS).
 */
const LOCK_RETRY_BUDGET_MS = SAME_HOST_STALE_MS + 5_000;
/** Distinguishes a wedged lock from a storage failure in the fallback path. */
const CLAIM_STORE_LOCK_TIMEOUT = 'CLAIM_STORE_LOCK_TIMEOUT';
/** Machine name stamped into locks so foreign hosts never misread a pid. */
const HOST_NAME = hostname();

function lockOwnerStamp(): string {
  return `${HOST_NAME}:${process.pid}`;
}

/** Throttle fallback warns — a wedged store must not spam the console. */
let lastFallbackWarnAt = 0;
const FALLBACK_WARN_INTERVAL_MS = 60_000;
function warnFallbackOnce(message: string): void {
  const now = Date.now();
  if (now - lastFallbackWarnAt < FALLBACK_WARN_INTERVAL_MS) return;
  lastFallbackWarnAt = now;
  console.warn(message);
}

/**
 * Decide whether a contended lock file is stale and may be removed.
 *
 * Locks are stamped `host:pid`. A pid is only interpretable on the host that
 * wrote it, so:
 *  - same-host locks: broken iff the owner pid is dead, or the lock is held
 *    implausibly long (past {@link SAME_HOST_STALE_MS}) — a live-but-wedged
 *    holder must not degrade cross-session dedup forever;
 *  - foreign-host or ownerless locks: broken only past the mtime lease cap.
 * Exported for unit tests.
 */
export async function breakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const ownerRaw = await fsp.readFile(lockPath, 'utf8').catch(() => null);
    if (ownerRaw !== null) {
      const [ownerHost, pidRaw] = ownerRaw.trim().split(':', 2);
      const ownerPid = Number.parseInt(pidRaw ?? '', 10);
      if (ownerHost === HOST_NAME && Number.isInteger(ownerPid) && ownerPid > 0) {
        if (isPidAlive(ownerPid)) {
          const st = await fsp.stat(lockPath);
          // Escape hatch for a same-host holder that is alive but wedged: its
          // critical section is sub-second, so a hold past this cap is either
          // a suspended process or pid reuse — break it to keep the feature.
          if (Date.now() - st.mtimeMs > SAME_HOST_STALE_MS) {
            return (await breakLockAtomically(lockPath)) === true;
          }
          return false;
        }
        return (await breakLockAtomically(lockPath)) === true;
      }
    }
    const st = await fsp.stat(lockPath);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      return (await breakLockAtomically(lockPath)) === true;
    }
  } catch {
    /* lock vanished — retry open */
  }
  return false;
}

/**
 * Remove a stale lock file via atomic RENAME to a unique tombstone, never
 * unlink: with unlink, two waiters can both read the stale lock and one's
 * unlink can remove the OTHER's fresh lock, letting both into the critical
 * section (POSIX). Rename wins for exactly one waiter; losers get ENOENT and
 * simply keep waiting on the winner's fresh lock.
 */
async function breakLockAtomically(lockPath: string): Promise<boolean> {
  // `.tmp` suffix so any store-level tmp pruner can reclaim a tombstone left
  // by a breaker that died before its fire-and-forget cleanup ran.
  const tombstone = `${lockPath}.stale-${randomUUID()}.tmp`;
  try {
    await fsp.rename(lockPath, tombstone);
  } catch {
    // EPERM (AV), ENOENT (already broken), or a lost race — not ours to break.
    return false;
  }
  // The tombstone is ours alone — remove it right away.
  void fsp.unlink(tombstone).catch(() => undefined);
  return true;
}

/**
 * Serialize read-modify-append cycles on the shared ledger with an exclusive
 * lock file (O_CREAT|O_EXCL), the same pattern session-registry.ts uses.
 * A crashed holder leaves a stale lock which is broken by pid liveness (same
 * host) or the mtime lease cap (foreign host / ownerless). Contention past
 * `waitMs` surfaces as a typed {@link CLAIM_STORE_LOCK_TIMEOUT} error so the
 * caller can retry with a longer budget before degrading.
 */
async function withStoreLock<T>(
  storeDir: string,
  fn: () => Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<T> {
  const lockPath = lockFilePath(storeDir);
  await fsp.mkdir(storeDir, { recursive: true });
  const deadline = Date.now() + waitMs;
  let attempt = 0;
  for (;;) {
    let handle = await fsp.open(lockPath, 'wx').catch(() => null);
    if (!handle && (await breakStaleLock(lockPath))) {
      handle = await fsp.open(lockPath, 'wx').catch(() => null);
    }
    if (handle) {
      try {
        // Stamp the owner BEFORE any critical-section work: an ownerless lock
        // would be stolen by a peer past the mtime cap while we are still
        // mid-critical-section. Retry transient Windows I/O, then fail closed.
        let stamped = false;
        for (let stampAttempt = 0; stampAttempt < 3 && !stamped; stampAttempt++) {
          try {
            await handle.writeFile(lockOwnerStamp());
            stamped = true;
          } catch {
            if (stampAttempt < 2) await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        if (!stamped) {
          throw new Error('failed to stamp claim lock owner');
        }
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        // Only unlink a lock we still own: a stale-lock breaker may have
        // stolen this lock and re-stamped it with another host:pid, in which
        // case the resumed holder must NOT remove the new owner's lock. An
        // EMPTY read is never ours to unlink — it may be the new owner's
        // lock in its open-to-stamp gap; that lock is mtime-bounded instead.
        const owner = await fsp.readFile(lockPath, 'utf8').catch(() => null);
        if (owner !== null && owner.trim() === lockOwnerStamp()) {
          await fsp.unlink(lockPath).catch(() => undefined);
        }
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw Object.assign(new Error('review claim store lock timeout'), {
        code: CLAIM_STORE_LOCK_TIMEOUT,
      });
    }
    const delay = Math.min(LOCK_RETRY_MAX_MS * (attempt + 1), remaining);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }
}
/** Rewrite the ledger (dropping releases/expired claims) past this size. */
const MAX_LEDGER_LINES = 10_000;

/**
 * Per-process host stamp. Two sessions in one process share it, which is safe
 * because release matching also requires the original claim time — a same-pid
 * re-claim after TTL expiry carries a new timestamp and cannot be released by
 * the older claim's completion.
 */
const HOST_SID = randomUUID();

/** Same-process fallback ledger, used only when the shared store is unwritable. */
const claimsByEventBus = new WeakMap<EventBus, Map<string, Set<string>>>();
const startedReviews = new WeakMap<ReviewContextBundle, StartedReview>();
/**
 * In-flight claim installation for raw-emitted reviews. `recordStartedReview`
 * installs the startedReviews entry only AFTER the async file claim lands, so
 * a completion handler dispatched synchronously in the same event emit (the
 * no-Director release) would otherwise no-op and orphan the claim until TTL.
 * This map lets the completion await the pending claim instead.
 */
const pendingStartedReviews = new WeakMap<ReviewContextBundle, Promise<StartedReview | null>>();

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Canonicalize a path component of a claim key so case/spelling variants of
 * the same working tree (Windows) still collide. The store DIRECTORY itself
 * is case-insensitive on win32, but the keys written inside it are not.
 */
function normalizeKeyPart(p: string): string {
  const forward = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

function claimKey(cwd: string, filePath: string): string {
  return `${normalizeKeyPart(cwd)}\0${normalizeKeyPart(filePath)}`;
}

function resolveStore(
  opts: ClaimStoreOptions | undefined,
  cwd: string,
): {
  storeDir: string;
  ttlMs: number;
  maxLedgerLines: number;
} {
  return {
    storeDir: opts?.storeDir ?? path.join(cwd, '.wrongstack'),
    ttlMs: opts?.ttlMs ?? DEFAULT_CLAIM_TTL_MS,
    maxLedgerLines: opts?.maxLedgerLines ?? MAX_LEDGER_LINES,
  };
}

function claimsFilePath(storeDir: string): string {
  return path.join(storeDir, CLAIMS_FILE);
}

function lockFilePath(storeDir: string): string {
  return path.join(storeDir, `${CLAIMS_FILE}.lock`);
}

/**
 * Replay the ledger in order into `key -> fingerprint -> {sid, ts, exp}`,
 * dropping claims past their PERSISTED absolute expiry. A release removes
 * exactly the matching claim. Staleness is evaluated from the stored `exp`,
 * never from a reader-local TTL — two callers with different TTL knobs must
 * agree on whether a fingerprint is claimed.
 */
async function readLedger(
  storeDir: string,
  now: number,
): Promise<Map<string, Map<string, { sid: string; ts: number; exp: number }>>> {
  const active = new Map<string, Map<string, { sid: string; ts: number; exp: number }>>();
  // ENOENT = first use (empty ledger); any other read failure is treated as a
  // store problem and surfaced so the caller can fall back conservatively
  // instead of treating the ledger as empty and duplicating every review.
  const raw = await fsp.readFile(claimsFilePath(storeDir), 'utf8').catch((err: unknown) => {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return '';
    throw err;
  });
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: LedgerLine | undefined;
    try {
      const parsed = JSON.parse(line) as Partial<LedgerLine>;
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.op === 'claim' || parsed.op === 'release') &&
        typeof parsed.key === 'string' &&
        typeof parsed.fp === 'string' &&
        typeof parsed.sid === 'string' &&
        typeof parsed.ts === 'number' &&
        (typeof parsed.exp === 'undefined' || typeof parsed.exp === 'number')
      ) {
        entry = parsed as LedgerLine;
      }
    } catch {
      /* torn/corrupt line — ignore */
    }
    if (!entry) continue;
    let bucket = active.get(entry.key);
    if (!bucket) {
      bucket = new Map();
      active.set(entry.key, bucket);
    }
    if (entry.op === 'claim') {
      // Legacy rows (pre-exp ledger) fall back to the default TTL.
      const exp = entry.exp ?? entry.ts + DEFAULT_CLAIM_TTL_MS;
      if (now > exp) continue;
      bucket.set(entry.fp, { sid: entry.sid, ts: entry.ts, exp });
    } else {
      const existing = bucket.get(entry.fp);
      // Match the ORIGINAL claim time too, so a late release can never delete
      // a newer claim of the same fingerprint that re-appeared after expiry
      // (same process shares HOST_SID, so sid alone is ambiguous).
      if (existing?.sid === entry.sid && existing.ts === entry.ts) bucket.delete(entry.fp);
    }
  }
  return active;
}

async function ledgerLineCount(storeDir: string): Promise<number> {
  const raw = await fsp.readFile(claimsFilePath(storeDir), 'utf8').catch(() => '');
  return raw.split('\n').filter((l) => l.trim()).length;
}

/** Rewrite the ledger with only the live claims (drops releases + expired). */
async function compactLedger(
  storeDir: string,
  active: Map<string, Map<string, { sid: string; ts: number; exp: number }>>,
): Promise<void> {
  const lines: string[] = [];
  for (const [key, fps] of active) {
    for (const [fp, claim] of fps) {
      lines.push(
        JSON.stringify({
          op: 'claim',
          key,
          fp,
          sid: claim.sid,
          ts: claim.ts,
          exp: claim.exp,
        } satisfies LedgerLine),
      );
    }
  }
  const tmp = `${claimsFilePath(storeDir)}.tmp-${randomUUID()}`;
  await fsp.writeFile(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
  // Windows rename can hit transient EPERM/EBUSY from file locks/AV scanners;
  // retry briefly, then fall back to copy+unlink (session-registry precedent).
  let replaced = false;
  for (let attempt = 0; attempt < 3 && !replaced; attempt++) {
    try {
      await fsp.rename(tmp, claimsFilePath(storeDir));
      replaced = true;
    } catch {
      if (attempt === 2) {
        // Never report success unless the replacement actually landed: a
        // failed copyFile can leave a partially-written destination whose
        // torn lines drop claims. Rethrow so the caller's best-effort catch
        // handles it (and the tmp is preserved for a later retry).
        await fsp.copyFile(tmp, claimsFilePath(storeDir)).catch(async (copyErr) => {
          throw copyErr;
        });
        await fsp.unlink(tmp).catch(() => undefined);
        replaced = true;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }
}

async function acquireClaims(
  storeDir: string,
  ttlMs: number,
  maxLedgerLines: number,
  cwd: string,
  files: ReviewFileEntry[],
  waitMs = LOCK_WAIT_MS,
): Promise<ReviewClaim[]> {
  return withStoreLock(
    storeDir,
    async () => {
      const now = Date.now();
      const active = await readLedger(storeDir, now);
      const claims: ReviewClaim[] = [];
      const lines: string[] = [];
      for (const file of files) {
        const key = claimKey(cwd, file.path);
        const fp = fingerprint(file.content);
        // Write each new claim into `active` as we go: this dedupes duplicate
        // entries inside ONE batch, and keeps the snapshot authoritative for a
        // compaction that may follow in the same lock window.
        let bucket = active.get(key);
        if (bucket?.has(fp)) continue;
        if (!bucket) {
          bucket = new Map();
          active.set(key, bucket);
        }
        bucket.set(fp, { sid: HOST_SID, ts: now, exp: now + ttlMs });
        claims.push({ key, fingerprint: fp, sid: HOST_SID, ts: now });
        lines.push(
          JSON.stringify({
            op: 'claim',
            key,
            fp,
            sid: HOST_SID,
            ts: now,
            exp: now + ttlMs,
          } satisfies LedgerLine),
        );
      }
      if (lines.length > 0) {
        await fsp.appendFile(claimsFilePath(storeDir), `${lines.join('\n')}\n`, 'utf8');
        try {
          if ((await ledgerLineCount(storeDir)) > maxLedgerLines) {
            await compactLedger(storeDir, active);
          }
        } catch (err) {
          // Compaction is best-effort — the appended claims are already valid.
          warnFallbackOnce(
            `[review-claim-registry] ledger compaction failed (${err instanceof Error ? err.message : String(err)}); will retry on a future acquire`,
          );
        }
      }
      return claims;
    },
    waitMs,
  );
}

/** Append release lines for exactly the claims that are still live. */
async function releaseSharedClaims(
  storeDir: string,
  claims: ReviewClaim[],
  waitMs = LOCK_WAIT_MS,
): Promise<void> {
  if (claims.length === 0) return;
  await withStoreLock(
    storeDir,
    async () => {
      const now = Date.now();
      const active = await readLedger(storeDir, now);
      const lines: string[] = [];
      for (const claim of claims) {
        const bucket = active.get(claim.key);
        const live = bucket?.get(claim.fingerprint);
        // Mirror readLedger's release matching: only release the exact claim
        // (sid + original claim time) that is still live.
        if (live && live.sid === claim.sid && live.ts === claim.ts) {
          lines.push(
            JSON.stringify({
              op: 'release',
              key: claim.key,
              fp: claim.fingerprint,
              sid: claim.sid,
              // Target the ORIGINAL claim time so a late release only ever
              // removes the claim it owns (see readLedger release matching).
              ts: claim.ts,
            } satisfies LedgerLine),
          );
        }
      }
      if (lines.length > 0) {
        await fsp.appendFile(claimsFilePath(storeDir), `${lines.join('\n')}\n`, 'utf8');
      }
    },
    waitMs,
  );
}

// ---------------------------------------------------------------------------
// In-memory fallback (only when the shared ledger is unwritable)
// ---------------------------------------------------------------------------
function ledgerFor(events: EventBus): Map<string, Set<string>> {
  let ledger = claimsByEventBus.get(events);
  if (!ledger) {
    ledger = new Map<string, Set<string>>();
    claimsByEventBus.set(events, ledger);
  }
  return ledger;
}

function claimFilesInMemory(
  events: EventBus,
  cwd: string,
  files: ReviewFileEntry[],
): ReviewClaim[] {
  const ledger = ledgerFor(events);
  const claims: ReviewClaim[] = [];
  for (const file of files) {
    const key = claimKey(cwd, file.path);
    const fileFingerprint = fingerprint(file.content);
    let activeFingerprints = ledger.get(key);
    if (!activeFingerprints) {
      activeFingerprints = new Set<string>();
      ledger.set(key, activeFingerprints);
    }
    if (activeFingerprints.has(fileFingerprint)) continue;
    activeFingerprints.add(fileFingerprint);
    claims.push({ key, fingerprint: fileFingerprint, sid: HOST_SID, ts: Date.now() });
  }
  return claims;
}

function releaseClaimsInMemory(events: EventBus, claims: ReviewClaim[]): void {
  const ledger = ledgerFor(events);
  for (const claim of claims) {
    const activeFingerprints = ledger.get(claim.key);
    if (!activeFingerprints) continue;
    activeFingerprints.delete(claim.fingerprint);
    if (activeFingerprints.size === 0) ledger.delete(claim.key);
  }
}

async function claimFiles(
  events: EventBus,
  cwd: string,
  files: ReviewFileEntry[],
  opts: ClaimStoreOptions | undefined,
): Promise<{ claims: ReviewClaim[]; storeDir: string | null }> {
  const { storeDir, ttlMs, maxLedgerLines } = resolveStore(opts, cwd);
  try {
    const claims = await acquireClaims(storeDir, ttlMs, maxLedgerLines, cwd, files);
    return { claims, storeDir };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === CLAIM_STORE_LOCK_TIMEOUT) {
      // Lock contention — retry once with a budget long enough to also cover a
      // foreign-host mtime lease break (LOCK_STALE_MS) before degrading.
      try {
        const claims = await acquireClaims(
          storeDir,
          ttlMs,
          maxLedgerLines,
          cwd,
          files,
          LOCK_RETRY_BUDGET_MS,
        );
        return { claims, storeDir };
      } catch (err2) {
        warnFallbackOnce(
          `[review-claim-registry] claim lock still contended after ${LOCK_WAIT_MS + LOCK_RETRY_BUDGET_MS}ms (${err2 instanceof Error ? err2.message : String(err2)}); falling back to in-memory dedup`,
        );
        return { claims: claimFilesInMemory(events, cwd, files), storeDir: null };
      }
    }
    // Storage failure (EACCES/EROFS/ENOSPC/ENOTDIR/...) — unwritable tree or
    // minimal host; fall back to per-session dedup so a storage problem never
    // turns into duplicate reviews inside one session.
    warnFallbackOnce(
      `[review-claim-registry] shared claim store unavailable (${err instanceof Error ? err.message : String(err)}); falling back to in-memory dedup`,
    );
    return { claims: claimFilesInMemory(events, cwd, files), storeDir: null };
  }
}

async function releaseClaims(
  events: EventBus,
  claims: ReviewClaim[],
  storeDir: string | null,
): Promise<void> {
  if (storeDir === null) {
    releaseClaimsInMemory(events, claims);
    return;
  }
  try {
    await releaseSharedClaims(storeDir, claims);
  } catch (err) {
    if ((err as { code?: string }).code === CLAIM_STORE_LOCK_TIMEOUT) {
      try {
        await releaseSharedClaims(storeDir, claims, LOCK_RETRY_BUDGET_MS);
        return;
      } catch {
        /* fall through to the warn below */
      }
    }
    // Best-effort: the claim is bounded by its stored expiry and the next
    // acquisition rewrites the ledger, so a failed release degrades gracefully.
    warnFallbackOnce(
      `[review-claim-registry] shared claim release failed (${err instanceof Error ? err.message : String(err)}); claim will expire via its stored TTL`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record review events emitted outside the automatic plugin paths, such as
 * `/review`, so the post-session pass also avoids repeating those files.
 */
export async function recordStartedReview(
  events: EventBus,
  payload: unknown,
  opts?: ClaimStoreOptions | undefined,
): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const bundle = payload as ReviewContextBundle;
  // Reviews emitted by emitReviewIfChanged are claimed and tracked BEFORE the
  // event fires, so this listener must never re-claim them: an async re-claim
  // that lands after the completion release would resurrect the fingerprint
  // claim and block the next review (observed as a cross-cycle flake).
  if (startedReviews.has(bundle)) return;
  const candidate = payload as Partial<ReviewContextBundle>;
  if (typeof candidate.cwd !== 'string' || !Array.isArray(candidate.files)) return;
  // Capture the narrowed values BEFORE the async IIFE — TS property narrowing
  // does not persist into the closure.
  const cwd: string = candidate.cwd;
  const files = candidate.files.filter(
    (file): file is ReviewFileEntry =>
      Boolean(file) &&
      typeof file === 'object' &&
      typeof (file as ReviewFileEntry).path === 'string' &&
      typeof (file as ReviewFileEntry).content === 'string',
  );

  // Install a SYNCHRONOUS pending marker before the first await: a completion
  // handler dispatched in the same event emit (e.g. the no-Director release)
  // must be able to await the claim installation instead of no-op'ing and
  // orphaning the claim until TTL.
  const pending = (async (): Promise<StartedReview | null> => {
    try {
      const { claims, storeDir } = await claimFiles(events, cwd, files, opts);
      if (claims.length === 0) return null;
      const entry: StartedReview = { events, storeDir, claims };
      startedReviews.set(bundle, entry);
      return entry;
    } catch {
      return null;
    }
  })();
  pendingStartedReviews.set(bundle, pending);
  try {
    await pending;
  } finally {
    if (pendingStartedReviews.get(bundle) === pending) {
      pendingStartedReviews.delete(bundle);
    }
  }
}

/**
 * Release the exact claims associated with a completed review bundle. Bundle
 * identity prevents an older completion from removing newer in-flight claims.
 */
export async function recordCompletedReview(events: EventBus, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const bundle = (payload as { bundle?: unknown }).bundle;
  if (!bundle || typeof bundle !== 'object') return;

  let startedReview = startedReviews.get(bundle as ReviewContextBundle);
  if (!startedReview) {
    // A raw-emitted review may still be installing its claim (recordStartedReview
    // is async). Await the pending installation so the completion releases it
    // instead of no-op'ing and orphaning the claim until its stored expiry.
    const pending = pendingStartedReviews.get(bundle as ReviewContextBundle);
    if (pending) startedReview = (await pending) ?? undefined;
  }
  // Bundle identity prevents an older completion from removing newer in-flight
  // claims; the events guard keeps a completion on one bus from releasing
  // claims made by another bus in the same process.
  if (!startedReview || startedReview.events !== events) return;
  await releaseClaims(events, startedReview.claims, startedReview.storeDir);
  startedReviews.delete(bundle as ReviewContextBundle);
}

/**
 * Atomically claim review inputs and emit only files whose exact content does
 * not already have a review in progress — across every session sharing the
 * working tree. The returned bundle contains only claimed files and may be a
 * strict subset of the input.
 *
 * Claims are installed in the shared ledger (under its exclusive lock) before
 * the event emission, so concurrent mid/post-session handlers — in this
 * process or another — cannot enqueue the same content twice. A synchronous
 * emit failure rolls the claims back.
 */
export async function emitReviewIfChanged(
  api: Pick<PluginAPI, 'events' | 'emitCustom'>,
  bundle: ReviewContextBundle,
  opts?: ClaimStoreOptions | undefined,
): Promise<ReviewContextBundle | null> {
  const { claims, storeDir } = await claimFiles(api.events, bundle.cwd, bundle.files, opts);
  if (claims.length === 0) return null;

  const claimedKeys = new Set(claims.map((claim) => claim.key));
  const claimedBundle: ReviewContextBundle = {
    ...bundle,
    files: bundle.files.filter((file) => claimedKeys.has(claimKey(bundle.cwd, file.path))),
  };

  startedReviews.set(claimedBundle, {
    events: api.events,
    storeDir,
    claims,
  });
  try {
    api.emitCustom('chimera.review_needed', claimedBundle);
    return claimedBundle;
  } catch (err) {
    startedReviews.delete(claimedBundle);
    await releaseClaims(api.events, claims, storeDir);
    throw err;
  }
}
