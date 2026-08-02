import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { JsonlFindingStore, resolveFindingStorePath } from './review-finding-store.js';
import { JsonlReportStore, resolveReportStorePath } from './review-report-store.js';

/** Start maintenance before full-file JSONL reads become a meaningful heap spike. */
export const REVIEW_STORE_COMPACTION_THRESHOLD_BYTES = 8 * 1024 * 1024;

/** Avoid repeatedly rewriting a large store that has no expired terminal records. */
export const REVIEW_STORE_COMPACTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const REVIEW_STORE_MAINTENANCE_FILE = '.review-store-maintenance.json';

export interface ReviewStoreMaintenanceResult {
  compacted: boolean;
  totalBytes: number;
  reason: 'below_threshold' | 'interval' | 'compacted';
  removedReports: number;
  removedFindings: number;
  eventsFolded: number;
}

export interface ReviewStoreMaintenanceOptions {
  thresholdBytes?: number | undefined;
  intervalMs?: number | undefined;
  now?: number | undefined;
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
    const reportResult = await new JsonlReportStore(projectDir).compact();
    const findingResult = await new JsonlFindingStore(projectDir).compact();
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
      removedFindings: findingResult.removed,
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
    removedFindings: 0,
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
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as Partial<MaintenanceState>;
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
