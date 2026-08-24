/**
 * Shared WrongTrace pre-flight gate for every host process.
 *
 * Originally lived in `@wrongstack/cli/wiring`; moved here so the CLI
 * leader, fleet subagents, AND the standalone WebUI server can all pass
 * their mutating tool calls through the exact same lock gate without any
 * of them importing `@wrongstack/cli` (dep direction cli -> webui-server
 * forbids the reverse edge).
 *
 * Wraps the @wrongstack/wrongtrace client into tiny entry points a host
 * can call without caring whether the daemon is running:
 *
 *   - `preflightFileEdit(path)`  -> health/lock check BEFORE a heavy edit.
 *     Locked files hard-block; fragile files soften the edit strategy.
 *   - `withFileLock(path, fn)`   -> claim the daemon's lock around a heavy
 *     edit so peer agents don't thrash the same file; unlocks in `finally`.
 *
 * Design rules (kept deliberately):
 *   - The daemon is OPTIONAL. Every path degrades to "allow" - an offline
 *     WrongTrace must never block an edit (mirrors proxy-probe's soft
 *     -signal philosophy).
 *   - Discovery runs ONCE, lazily, fire-and-forget per process. Each host
 *     process gets its own singleton here; the CLI additionally warms it
 *     at boot (`void getWrongTrace()`).
 *   - Stale locks (TTL already elapsed) do not block; the risk fusion in
 *     agent-helpers already ignores them.
 */

import { createWrongTraceClient, type WrongTraceClientInternal } from "./client.js";
import { getCrossAgentRisk, type CrossAgentRisk } from "./agent-helpers.js";

/** Outcome the caller dispatches on. `allow` is always the safe default. */
export type PreflightVerdict =
  | { kind: "allow"; risk: CrossAgentRisk | null }
  | { kind: "blocked"; risk: CrossAgentRisk };

let clientPromise: Promise<WrongTraceClientInternal> | undefined;

/** Lazily created singleton — resolves to isAvailable:false when offline. */
export function getWrongTrace(): Promise<WrongTraceClientInternal> {
  if (clientPromise === undefined) {
    clientPromise = createWrongTraceClient().catch(() => {
      // Never let a discovery rejection poison the singleton.
      return { isAvailable: false } as WrongTraceClientInternal;
    });
  }
  return clientPromise;
}

/** Test seam: reset the singleton between suites. */
export function resetWrongTraceGate(): void {
  clientPromise = undefined;
}

export interface PreflightOptions {
  /** Caller identity stamped on locks (e.g. session id / agent name). */
  owner?: string;
  ownerRunId?: string;
}

/**
 * Pre-flight check before a heavy edit. Fast (single file-health fetch
 * behind the adapter's risk fusion). Locked by ANOTHER owner → blocked;
 * everything else, including daemon-offline → allow. A lock the caller
 * itself holds (`selfOwner` matching the daemon's `lock_owner`) is exempted.
 *
 * Verified live (2026-08-24): `/api/file/health` returns `is_locked`,
 * `lock_owner`, `lock_reason`, `lock_expires_at` while a lock is held, so
 * this CAN return `blocked` on the current daemon schema.
 */
export async function preflightFileEdit(
  path: string,
  selfOwner?: string,
): Promise<PreflightVerdict> {
  const wt = await getWrongTrace();
  if (!wt.isAvailable) return { kind: "allow", risk: null };

  const risk = await getCrossAgentRisk(wt, path, 50, selfOwner);
  if (risk.band === "locked") return { kind: "blocked", risk };
  return { kind: "allow", risk };
}

/**
 * Run `fn` under the daemon's file lock. Best-effort: if the daemon is
 * offline, or lock acquisition fails for any transport reason, `fn` still
 * runs — coordination is an optimization, not a hard dependency.
 */
export async function withFileLock<T>(
  path: string,
  reason: string,
  fn: () => Promise<T>,
  opts: PreflightOptions = {},
): Promise<T> {
  const wt = await getWrongTrace();
  if (!wt.isAvailable) return fn();

  const lockOpts: { ttlSeconds: number; owner?: string; ownerRunId?: string } = {
    // Generous TTL: heavy edits can run long; the lock self-reaps if we
    // crash mid-edit so a dead session can never block the file forever.
    ttlSeconds: 900,
  };
  if (opts.owner !== undefined) lockOpts.owner = opts.owner;
  if (opts.ownerRunId !== undefined) lockOpts.ownerRunId = opts.ownerRunId;

  const res = await wt.lockFile(path, reason, lockOpts);

  // Conflict body carries ok:false + owner/expires_at — do NOT steal the
  // file; run unlocked rather than forcing a peer's lock away.
  const acquired = res?.ok === true;
  try {
    return await fn();
  } finally {
    if (acquired) await wt.unlockFile(path);
  }
}
