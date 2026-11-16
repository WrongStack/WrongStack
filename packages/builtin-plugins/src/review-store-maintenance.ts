import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '@wrongstack/core/utils';
import { JsonlFindingStore, resolveFindingStorePath } from './review-finding-store.js';
import { JsonlReportStore, resolveReportStorePath } from './review-report-store.js';

/** Start maintenance before full-file JSONL reads become a meaningful heap spike. */
export const REVIEW_STORE_COMPACTION_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Avoid repeatedly rewriting a large store that has no expired terminal records. */
export const REVIEW_STORE_COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Bounded retention for reports that never reached a terminal state.
 *
 * A report is only ever removed by `JsonlReportStore.compact()` when its
 * materialized lifecycle is `completed` or `skipped`. A review that produced
 * findings stays `open` until an operator closes it out through the WebUI
 * report route, so in practice most reports are never closed and were retained
 * forever: one long-running project accumulated 8,126 `open` reports (~22 MiB
 * of its 30 MiB store) that no age could ever evict.
 *
 * This cap evicts `open`/`actioned` reports older than the window. It is
 * deliberately LONGER than the 90-day terminal retention: an item nobody ever
 * acted on must not expire before an item that was resolved, or the audit trail
 * would preferentially lose the reports a user still owed a decision on.
 *
 * Pass `Number.POSITIVE_INFINITY` to disable the sweep and restore the previous
 * retain-forever behavior.
 */
export const REVIEW_STORE_NON_TERMINAL_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Bounded retention for findings that never reached a terminal status — the
 * direct analogue of {@link REVIEW_STORE_NON_TERMINAL_RETENTION_MS} for the
 * finding store.
 *
 * `JsonlFindingStore.compact()` keyed only on `resolved` (30d) and `ignored`
 * (14d), so `active`, `triaged` and `in_progress` findings were immortal at any
 * age: a finding nobody ever resolved or ignored stayed forever.
 *
 * Same 2× ratio as the report store (180d = 2x90d): 60d = 2x the longest
 * terminal finding window, so an untriaged finding outlives a resolved one
 * rather than expiring first.
 */
export const REVIEW_FINDING_NON_TERMINAL_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export const REVIEW_STORE_MAINTENANCE_FILE = '.review-store-maintenance.json';

export interface ReviewStoreMaintenanceResult {
  compacted: boolean;
  totalBytes: number;
  reason: 'below_threshold' | 'interval' | 'compacted';
  /** Terminal reports (completed/skipped) dropped by their own retention. */
  removedReports: number;
  /** Non-terminal reports (open/actioned) dropped by the bounded-retention cap. */
  removedOpenReports: number;
  removedFindings: number;
  /** Non-terminal findings (active/triaged/in_progress) dropped by the cap. */
  removedActiveFindings: number;
  eventsFolded: number;
}

export interface ReviewStoreMaintenanceOptions {
  thresholdBytes?: number | undefined;
  intervalMs?: number | undefined;
  now?: number | undefined;
  /**
   * Cap for non-terminal reports in **milliseconds**. Defaults to
   * {@link REVIEW_STORE_NON_TERMINAL_RETENTION_MS}; pass
   * `Number.POSITIVE_INFINITY` to disable that sweep without touching terminal
   * retention. Takes precedence over {@link openRetentionDays}.
   *
   * WARNING: this programmatic form is passed through verbatim — it is the
   * store's own comparison (`age > cap`), so `0` or any negative value evicts
   * **every** non-terminal report on the next compaction, not "nothing". That
   * is what makes `Number.POSITIVE_INFINITY` the only disable sentinel here,
   * unlike {@link openRetentionDays} where `0` means "off".
   */
  nonTerminalRetentionMs?: number | undefined;
  /**
   * Config-facing form of the same cap, in **whole days**, read from
   * `config.extensions['wstack-chimera'].openRetentionDays`. Interpreted here so
   * the semantics live in exactly one place:
   * - positive finite days → that many days;
   * - `0` → the sweep is disabled (never evict an unacknowledged report);
   * - anything else (negative, `NaN`, non-finite) → treated as unset, so a
   *   malformed config value falls back to the default instead of wiping history
   *   or throwing on the review hot path.
   */
  openRetentionDays?: number | undefined;
  /**
   * Cap for non-terminal findings in **milliseconds**. Defaults to
   * {@link REVIEW_FINDING_NON_TERMINAL_RETENTION_MS}. Same verbatim warning as
   * {@link nonTerminalRetentionMs}: `0` or negative evicts **every**
   * active/triaged/in_progress finding. Takes precedence over
   * {@link activeRetentionDays}.
   */
  nonTerminalFindingsRetentionMs?: number | undefined;
  /**
   * Config-facing form of the finding cap, in whole days, read from
   * `config.extensions['wstack-chimera'].activeRetentionDays`. Same rules as
   * {@link openRetentionDays}: `0` disables the sweep, malformed falls back to
   * the default.
   */
  activeRetentionDays?: number | undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Shared days→cap rules for both stores, so the `0` = off and
 * malformed = default semantics exist in exactly one place.
 */
function capFromDays(days: number | undefined, fallbackMs: number): number {
  if (days === undefined) return fallbackMs;
  if (!Number.isFinite(days) || days < 0) return fallbackMs;
  if (days === 0) return Number.POSITIVE_INFINITY;
  return days * MS_PER_DAY;
}

/**
 * Resolve the non-terminal **report** cap from its two spellings. Kept separate
 * from `maybeCompactReviewStores` so the config-value rules are directly
 * unit-testable without touching the filesystem.
 */
export function resolveNonTerminalRetentionMs(
  opts: Pick<ReviewStoreMaintenanceOptions, 'nonTerminalRetentionMs' | 'openRetentionDays'> = {},
): number {
  if (opts.nonTerminalRetentionMs !== undefined) return opts.nonTerminalRetentionMs;
  return capFromDays(opts.openRetentionDays, REVIEW_STORE_NON_TERMINAL_RETENTION_MS);
}

/** Resolve the non-terminal **finding** cap. Same rules, longer default. */
export function resolveFindingNonTerminalRetentionMs(
  opts: Pick<
    ReviewStoreMaintenanceOptions,
    'nonTerminalFindingsRetentionMs' | 'activeRetentionDays'
  > = {},
): number {
  if (opts.nonTerminalFindingsRetentionMs !== undefined) {
    return opts.nonTerminalFindingsRetentionMs;
  }
  return capFromDays(opts.activeRetentionDays, REVIEW_FINDING_NON_TERMINAL_RETENTION_MS);
}

interface MaintenanceState {
  compactedAt: string;
  totalBytesBefore: number;
}

/**
 * Compact the two Chimera JSONL stores only after they are large enough and
 * no more than once per interval. The maintenance lock coordinates multiple
 * CLI/WebUI processes; each store also takes its own mutation lock while it
 * performs the atomic replacement.
 */
export async function maybeCompactReviewStores(
  projectDir: string,
  opts: ReviewStoreMaintenanceOptions = {},
): Promise<ReviewStoreMaintenanceResult> {
  const thresholdBytes = opts.thresholdBytes ?? REVIEW_STORE_COMPACTION_THRESHOLD_BYTES;
  const intervalMs = opts.intervalMs ?? REVIEW_STORE_COMPACTION_INTERVAL_MS;
  const now = opts.now ?? Date.now();
  const nonTerminalRetentionMs = resolveNonTerminalRetentionMs(opts);
  const nonTerminalFindingsRetentionMs = resolveFindingNonTerminalRetentionMs(opts);
  const maintenancePath = path.join(projectDir, REVIEW_STORE_MAINTENANCE_FILE);

  return withFileLock(maintenancePath, async () => {
    const totalBytes =
      (await fileSize(resolveReportStorePath(projectDir))) +
      (await fileSize(resolveFindingStorePath(projectDir)));

    if (totalBytes < thresholdBytes) {
      return emptyResult('below_threshold', totalBytes);
    }

    const state = await readMaintenanceState(maintenancePath);
    if (state && now - new Date(state.compactedAt).getTime() < intervalMs) {
      return emptyResult('interval', totalBytes);
    }

    // Sequential compaction keeps peak heap bounded to one materialized store.
    // The report store gets both caps: terminal retention stays at its own
    // default, while the non-terminal cap is the bounded policy from above.
    const reportResult = await new JsonlReportStore(projectDir).compact({
      nonTerminalMaxAgeMs: nonTerminalRetentionMs,
    });
    const findingResult = await new JsonlFindingStore(projectDir).compact({
      nonTerminalMaxAgeMs: nonTerminalFindingsRetentionMs,
    });
    const nextState: MaintenanceState = {
      compactedAt: new Date(now).toISOString(),
      totalBytesBefore: totalBytes,
    };
    await atomicWrite(maintenancePath, `${JSON.stringify(nextState)}\n`, { mode: 0o600 });

    return {
      compacted: true,
      totalBytes,
      reason: 'compacted',
      removedReports: reportResult.removed,
      removedOpenReports: reportResult.removedNonTerminal,
      removedFindings: findingResult.removed,
      removedActiveFindings: findingResult.removedNonTerminal,
      eventsFolded: reportResult.eventsFolded + findingResult.eventsFolded,
    };
  });
}

function emptyResult(
  reason: 'below_threshold' | 'interval',
  totalBytes: number,
): ReviewStoreMaintenanceResult {
  return {
    compacted: false,
    totalBytes,
    reason,
    removedReports: 0,
    removedOpenReports: 0,
    removedFindings: 0,
    removedActiveFindings: 0,
    eventsFolded: 0,
  };
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function readMaintenanceState(filePath: string): Promise<MaintenanceState | null> {
  try {
    const raw = (await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    const parsedRaw: unknown = JSON.parse(raw);
    if (!parsedRaw || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) return null;
    const parsed = parsedRaw as Partial<MaintenanceState>;
    return typeof parsed.compactedAt === 'string' && Number.isFinite(parsed.totalBytesBefore)
      ? (parsed as MaintenanceState)
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
