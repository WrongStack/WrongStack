/**
 * Hygiene runner and maintenance scheduler for the SAGE project server.
 *
 * An `automatic` request is served from the last report for
 * {@link AUTO_HYGIENE_INTERVAL_MS} and single-flighted; an explicit request
 * always runs.
 *
 * The daemon also OWNS periodic maintenance. Automatic hygiene used to be
 * requested only from host teardown, as a fire-and-forget call made while the
 * host process was already exiting — so it rarely reached the daemon. On this
 * repository's store the last pass predated 225 expired session digests that
 * were still active two weeks later. Hosts now register their hygiene options
 * at boot (`schedule`), and the daemon runs the pass itself once it is due and
 * no request is in flight. The last run is persisted next to the store, so
 * the cadence survives the daemon's idle shutdowns instead of restarting with
 * every spawn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import { acceptDueConsolidations } from './consolidation/auto-accept.js';
import type { SageDoctorCheck, SageMaintenanceStatus } from './memory-doctor-types.js';
import type { SageHygieneOptions, SageHygieneReport } from './memory-hygiene-types.js';
import type { CompleteSageStore } from './project-server-options.js';
import type { SageServerOperations } from './project-server-protocol.js';

const AUTO_HYGIENE_INTERVAL_MS = 60 * 60_000;
/** Default cadence of daemon-owned maintenance. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000;
/** Delay after a due schedule before running, so boot traffic settles first. */
export const MAINTENANCE_SETTLE_MS = 90_000;
/** Re-check delay while requests are in flight. */
const MAINTENANCE_BUSY_RETRY_MS = 5_000;
/** After this many busy retries the pass runs anyway; it must not starve. */
const MAINTENANCE_MAX_BUSY_RETRIES = 120;

interface PersistedMaintenance {
  lastRunAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastReport?: SageHygieneReport;
}

export interface HygieneRunnerOptions {
  /** `hygiene/maintenance.json` under the storage root; omit to keep state in memory. */
  statePath?: string | undefined;
  /** True while client requests are in flight; maintenance waits for quiet. */
  isBusy?: (() => boolean) | undefined;
  intervalMs?: number | undefined;
  settleMs?: number | undefined;
  now?: (() => number) | undefined;
  log?: ((message: string) => void) | undefined;
  /**
   * Runs after every scheduled pass (the daemon's self-healing doctor).
   * Failures are logged, never thrown: they must not stop the schedule.
   */
  afterMaintenance?: (() => Promise<void>) | undefined;
}

export interface ProjectServerHygieneRunner {
  run(
    args: SageServerOperations['hygiene']['args'],
  ): Promise<SageServerOperations['hygiene']['result']>;
  /** True while an automatic pass is running (heap-watchdog stats). */
  automaticInFlight(): boolean;
  /** Register host hygiene options and arm the periodic pass. */
  schedule(options?: SageHygieneOptions): SageMaintenanceStatus;
  /** Run the maintenance pass now (doctor `hygiene` repair), recording it like a scheduled one. */
  runNow(options?: SageHygieneOptions): Promise<SageHygieneReport>;
  status(): SageMaintenanceStatus;
  dispose(): void;
}

export function createHygieneRunner(
  store: CompleteSageStore,
  runnerOptions: HygieneRunnerOptions = {},
): ProjectServerHygieneRunner {
  const now = runnerOptions.now ?? Date.now;
  const intervalMs = runnerOptions.intervalMs ?? maintenanceIntervalFromEnv();
  const settleMs = runnerOptions.settleMs ?? maintenanceSettleFromEnv();
  const log = runnerOptions.log ?? (() => {});
  const persisted = readState(runnerOptions.statePath);
  let lastAutomaticHygieneAt = persisted.lastRunAt ? Date.parse(persisted.lastRunAt) || 0 : 0;
  let lastAutomaticHygieneReport: SageServerOperations['hygiene']['result'] | undefined =
    persisted.lastReport;
  let automaticHygieneInFlight: Promise<SageServerOperations['hygiene']['result']> | undefined;
  let scheduledOptions: SageHygieneOptions | undefined;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextRunAt: number | undefined;
  let busyRetries = 0;
  let disposed = false;

  function runAutomatic(
    options: SageHygieneOptions | undefined,
  ): Promise<SageServerOperations['hygiene']['result']> {
    if (automaticHygieneInFlight) return automaticHygieneInFlight;
    const startedAt = now();
    automaticHygieneInFlight = store
      .hygiene(options)
      .then((report) => {
        lastAutomaticHygieneAt = now();
        lastAutomaticHygieneReport = report;
        persisted.lastRunAt = new Date(lastAutomaticHygieneAt).toISOString();
        persisted.lastDurationMs = lastAutomaticHygieneAt - startedAt;
        persisted.lastReport = report;
        delete persisted.lastError;
        writeState(runnerOptions.statePath, persisted, log);
        return report;
      })
      .catch((error: unknown) => {
        persisted.lastError = error instanceof Error ? error.message : String(error);
        writeState(runnerOptions.statePath, persisted, log);
        throw error;
      })
      .finally(() => {
        automaticHygieneInFlight = undefined;
      });
    return automaticHygieneInFlight;
  }

  function arm(delayMs: number): void {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    nextRunAt = now() + safeDelay;
    const chunk = Math.min(safeDelay, 2_147_483_647);
    timer = setTimeout(() => {
      if (disposed) return;
      const remaining = (nextRunAt ?? 0) - now();
      if (remaining > 0) {
        arm(remaining);
        return;
      }
      void tick();
    }, chunk);
    // Maintenance must never keep an idle daemon alive.
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    timer = undefined;
    if (disposed) return;
    if (runnerOptions.isBusy?.() && busyRetries < MAINTENANCE_MAX_BUSY_RETRIES) {
      busyRetries++;
      arm(MAINTENANCE_BUSY_RETRY_MS);
      return;
    }
    busyRetries = 0;
    try {
      const report = await runAutomatic(scheduledOptions);
      log(
        `sage maintenance: hygiene examined=${report.examined} deleted=${report.deleted} staled=${report.staled} candidates=${report.reviewCandidatesCreated} in ${persisted.lastDurationMs ?? 0}ms`,
      );
    } catch (error) {
      log(
        `sage maintenance: hygiene failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      // Consolidation proposals nobody rejected within the review window.
      const due = await acceptDueConsolidations(store, now());
      if (due.accepted.length > 0 || due.failed > 0 || due.held > 0) {
        log(
          `sage maintenance: consolidation accepted=${due.accepted.length} failed=${due.failed} heldForReview=${due.held}`,
        );
      }
    } catch (error) {
      log(
        `sage maintenance: consolidation auto-accept failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      await runnerOptions.afterMaintenance?.();
    } catch (error) {
      log(
        `sage maintenance: doctor failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    arm(intervalMs);
  }

  function status(): SageMaintenanceStatus {
    return {
      owner: 'daemon',
      scheduled,
      intervalMs,
      running: automaticHygieneInFlight !== undefined,
      ...(persisted.lastRunAt ? { lastRunAt: persisted.lastRunAt } : {}),
      ...(persisted.lastDurationMs !== undefined
        ? { lastDurationMs: persisted.lastDurationMs }
        : {}),
      ...(persisted.lastError ? { lastError: persisted.lastError } : {}),
      ...(persisted.lastReport ? { lastReport: persisted.lastReport } : {}),
      ...(nextRunAt !== undefined ? { nextRunAt: new Date(nextRunAt).toISOString() } : {}),
    };
  }

  return {
    automaticInFlight: () => automaticHygieneInFlight !== undefined,
    async run(args) {
      if (args.automatic) {
        if (
          lastAutomaticHygieneReport &&
          now() - lastAutomaticHygieneAt < AUTO_HYGIENE_INTERVAL_MS
        ) {
          return lastAutomaticHygieneReport;
        }
        return runAutomatic(args.options);
      }
      return store.hygiene(args.options);
    },
    schedule(options) {
      // The latest host's options win; every host derives them from the same
      // `Sage.hygiene` config, so this is a refresh, not a contest.
      if (options) scheduledOptions = options;
      if (!scheduled) {
        scheduled = true;
        const dueIn = Math.max(0, lastAutomaticHygieneAt + intervalMs - now());
        arm(Math.max(dueIn, settleMs));
      }
      return status();
    },
    runNow: (options) => runAutomatic(options ?? scheduledOptions),
    status,
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      nextRunAt = undefined;
    },
  };
}

function maintenanceSettleFromEnv(): number {
  const raw = Number(process.env['WRONGSTACK_SAGE_MAINTENANCE_SETTLE_MS']);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 2_147_483_647) : MAINTENANCE_SETTLE_MS;
}

function maintenanceIntervalFromEnv(): number {
  const raw = Number(process.env['WRONGSTACK_SAGE_MAINTENANCE_INTERVAL_MS']);
  // Below a minute the pass would hold the single daemon thread most of the
  // time; above 2^31-1 Node clamps the timer to 1ms.
  return Number.isFinite(raw) && raw >= 60_000
    ? Math.min(raw, 2_147_483_647)
    : MAINTENANCE_INTERVAL_MS;
}

/**
 * A recorded pass can never be in the future; tolerate a small clock skew
 * between the daemon and whoever reads its state.
 */
const MAINTENANCE_CLOCK_SKEW_MS = 60 * 60_000;

/**
 * The recorded pass time, or `undefined` when the state cannot be trusted:
 * not a timestamp string, unreadable, or implausibly in the future.
 *
 * `Date.parse` is generous - `"17500"` parses as the year 17500, and a
 * number parses too - so "it parsed" is not enough to believe the stamp.
 */
function trustedLastRunMs(value: unknown, nowMs: number): number | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed > nowMs + MAINTENANCE_CLOCK_SKEW_MS) return undefined;
  return parsed;
}

function readState(statePath: string | undefined): PersistedMaintenance {
  if (!statePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^﻿/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const state = parsed as PersistedMaintenance;
    // A `lastRunAt` the runtime cannot read is not evidence of a pass. The
    // catch below only covers invalid JSON, so a file that parses but carries
    // a garbage timestamp would otherwise reach the health check verbatim and
    // be reported as a healthy pass. Drop it: the status then says "never
    // ran", which is what it means.
    if (
      state.lastRunAt !== undefined &&
      trustedLastRunMs(state.lastRunAt, Date.now()) === undefined
    ) {
      const { lastRunAt: _unreadable, ...rest } = state;
      return rest;
    }
    return state;
  } catch {
    // Missing or corrupt state only means "never ran": the next pass is due.
    return {};
  }
}

function writeState(
  statePath: string | undefined,
  state: PersistedMaintenance,
  log: (message: string) => void,
): void {
  if (!statePath) return;
  void fs.promises
    .mkdir(path.dirname(statePath), { recursive: true })
    .then(() => atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`))
    .catch((error: unknown) =>
      log(
        `sage maintenance: state write failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}

/** Hours after which an unrun maintenance pass is reported as overdue. */
const MAINTENANCE_OVERDUE_FACTOR = 4;

/**
 * Doctor check for the scheduler itself: a pass that never ran, failed last
 * time, or is far past its interval is exactly the silent failure that left
 * expired memories active for weeks.
 */
export function maintenanceDoctorCheck(
  status: SageMaintenanceStatus,
  nowMs: number,
): SageDoctorCheck {
  const base = { id: 'maintenance', title: 'Automatic maintenance', fix: 'hygiene' as const };
  if (status.lastError) {
    return {
      ...base,
      severity: 'error',
      summary: `Last maintenance pass failed: ${status.lastError}`,
    };
  }
  if (!status.lastRunAt) {
    return {
      ...base,
      severity: 'warn',
      summary: status.scheduled
        ? 'Maintenance is scheduled but has never completed on this store'
        : 'No host has scheduled maintenance and it has never run on this store',
    };
  }
  const lastRunMs = trustedLastRunMs(status.lastRunAt, nowMs);
  if (lastRunMs === undefined) {
    // A timestamp the runtime cannot read is NOT evidence of a healthy pass.
    // `ageMs` would be NaN, every age comparison would be false, and the
    // check would fall through to "ok" - hiding exactly the silent failure
    // this check exists to catch.
    return {
      ...base,
      severity: 'warn',
      summary: `Maintenance state is unreadable (lastRunAt: ${status.lastRunAt}) — treat the pass as never run`,
    };
  }
  const ageMs = nowMs - lastRunMs;
  if (ageMs > status.intervalMs * MAINTENANCE_OVERDUE_FACTOR) {
    return {
      ...base,
      severity: 'warn',
      summary: `Last maintenance pass was ${Math.round(ageMs / 3_600_000)}h ago (interval ${Math.round(status.intervalMs / 3_600_000)}h)`,
    };
  }
  return {
    id: base.id,
    title: base.title,
    severity: 'ok',
    summary: `Last pass ${status.lastRunAt} took ${status.lastDurationMs ?? 0}ms`,
  };
}
