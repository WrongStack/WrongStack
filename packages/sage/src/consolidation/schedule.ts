import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { LlmCallFn } from '../triage/llm-evaluator.js';
import { type ConsolidationSurface, runConsolidationPass } from './run.js';

const DAY_MS = 24 * 60 * 60_000;
const CHECK_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_MS = 10 * 60_000;
/** The session must have been quiet this long: background work never competes with a turn. */
const IDLE_MS = 10 * 60_000;
/** A pass that holds the lock longer than this crashed; the lock is taken over. */
const STALE_LOCK_MS = 2 * 60 * 60_000;
/** Retry delay after an outdated store owner dropped a proposal's member list. */
const STALE_OWNER_RETRY_MS = 60 * 60_000;
const STATE_FILE = 'consolidation.json';
const LOCK_FILE = 'consolidation.lock';

export interface ConsolidationScheduleDeps {
  surface: ConsolidationSurface;
  getLlmCall: () => LlmCallFn | undefined;
  /** The SAGE `hygiene/` directory; the state and cross-process lock live there. */
  stateDir: string;
  projectRoot?: string | undefined;
  maxCalls: number;
  logger: Logger;
  events?: EventBus | undefined;
  now?: (() => number) | undefined;
  checkIntervalMs?: number | undefined;
  firstCheckMs?: number | undefined;
  idleMs?: number | undefined;
}

/** A member the model saw but did not retire is not sent again for this long. */
const SEEN_SKIP_MS = 30 * DAY_MS;

interface ConsolidationState {
  lastRunAt: number;
  /** Member id → when it was last sent to the model. */
  seen: Record<string, string>;
}

function readState(file: string): ConsolidationState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      lastRunAt?: unknown;
      seen?: unknown;
    };
    const at = typeof parsed.lastRunAt === 'string' ? Date.parse(parsed.lastRunAt) : Number.NaN;
    const seen =
      parsed.seen && typeof parsed.seen === 'object' && !Array.isArray(parsed.seen)
        ? (parsed.seen as Record<string, string>)
        : {};
    return { lastRunAt: Number.isFinite(at) ? at : 0, seen };
  } catch {
    return { lastRunAt: 0, seen: {} };
  }
}

const readLastRun = (file: string) => readState(file).lastRunAt;

let lockSeq = 0;

/** Exclusive create; a lock older than {@link STALE_LOCK_MS} is taken over. */
function acquireLock(file: string, nowMs: number, token: string): boolean {
  try {
    fs.writeFileSync(file, token, { flag: 'wx' });
    return true;
  } catch {
    try {
      if (nowMs - fs.statSync(file).mtimeMs < STALE_LOCK_MS) return false;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, token, { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }
}

function releaseOwnedLock(file: string, token: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === token) {
      fs.rmSync(file, { force: true });
    }
  } catch {
    // A leftover lock goes stale and is taken over.
  }
}

/**
 * Run consolidation at most once a day per project, only while this host's
 * session is idle. Every CLI/WebUI host of a project schedules it; the state
 * file and the exclusive lock in the shared SAGE directory make one of them do
 * the pass. Returns a disposer.
 */
export function scheduleConsolidation(deps: ConsolidationScheduleDeps): () => void {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const statePath = path.join(deps.stateDir, STATE_FILE);
  const lockPath = path.join(deps.stateDir, LOCK_FILE);
  let lastActivity = now();
  let running = false;
  let disposed = false;
  let currentAbort: AbortController | undefined;
  const offActivity = deps.events?.on('iteration.started', () => {
    lastActivity = now();
    currentAbort?.abort();
  });

  const check = async (): Promise<void> => {
    if (running || disposed) return;
    const at = now();
    if (at - lastActivity < idleMs || at - readLastRun(statePath) < DAY_MS) return;
    const llm = deps.getLlmCall();
    if (!llm) return;
    try {
      fs.mkdirSync(deps.stateDir, { recursive: true });
    } catch {
      return;
    }
    const lockToken = `${process.pid}:${at}:${++lockSeq}`;
    if (!acquireLock(lockPath, at, lockToken)) return;
    running = true;
    const abortController = new AbortController();
    currentAbort = abortController;
    try {
      // Re-read under the lock: another host may have finished a pass.
      const state = readState(statePath);
      if (at - state.lastRunAt < DAY_MS) return;
      const seen = Object.fromEntries(
        Object.entries(state.seen).filter(([, iso]) => at - Date.parse(iso) < SEEN_SKIP_MS),
      );
      const { seenIds, ...report } = await runConsolidationPass(deps.surface, llm, {
        maxCalls: deps.maxCalls,
        now,
        signal: abortController.signal,
        projectRoot: deps.projectRoot,
        skipIds: new Set(Object.keys(seen)),
      });
      if (disposed || abortController.signal.aborted) return;
      // An outdated store owner withdrew the pass's proposal: remember nothing
      // as seen and retry an hour later instead of tomorrow.
      const stamp = new Date(
        report.staleOwner ? now() - DAY_MS + STALE_OWNER_RETRY_MS : now(),
      ).toISOString();
      if (!report.staleOwner) for (const id of seenIds) seen[id] = stamp;
      fs.writeFileSync(
        statePath,
        `${JSON.stringify({ lastRunAt: stamp, lastReport: report, seen }, null, 2)}\n`,
      );
      deps.logger.debug(
        `sage consolidation: pool=${report.pool} batches=${report.batches} calls=${report.calls} proposed=${report.proposed} noLesson=${report.noLesson} skippedMissing=${report.skippedMissing} errors=${report.errors}${report.staleOwner ? ' staleOwner=restart the SAGE daemon' : ''}`,
      );
    } catch (error) {
      deps.logger.debug(
        `sage consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (currentAbort === abortController) currentAbort = undefined;
      running = false;
      releaseOwnedLock(lockPath, lockToken);
    }
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    if (disposed) return;
    void check();
    interval = setInterval(() => void check(), deps.checkIntervalMs ?? CHECK_INTERVAL_MS);
    interval.unref?.();
  }, deps.firstCheckMs ?? FIRST_CHECK_MS);
  first.unref?.();

  return () => {
    disposed = true;
    currentAbort?.abort();
    offActivity?.();
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
