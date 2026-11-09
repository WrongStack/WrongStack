/**
 * WrongMemory daemon wire types and mapping helpers shared by the
 * WrongMemory port modules. Nothing here talks to the network.
 */

import * as path from 'node:path';
import { isWrongMemoryError } from '@wrongstack/wrongmemory-client';
import type { SageMaintenanceStatus } from './memory-doctor-types.js';
import type { Sage, SageSearchOptions, SageStatus } from './types.js';

export interface MutationOutcome<R = unknown> {
  outcome: string;
  id: string;
  revision?: number;
  replayed: boolean;
  record: R;
}

export interface CandidateOutcome {
  candidateId: string;
  status: string;
  memoryId?: string;
  decision?: string;
  targetMemoryId?: string;
  applied: boolean;
  alreadyResolved: boolean;
  /** The target mutation failed; the candidate stays pending for a retry. */
  error?: string;
}

export interface WireGraphView {
  edges: Array<{ from: string; to: string; relation: string; weight: number; createdAt: string }>;
}

export interface WirePage {
  memories: Sage[];
  nextCursor: string | null;
  total: number;
  statusCounts: Record<string, number>;
}

export interface WireStats {
  byStatus: Record<string, number>;
  byKind: Record<string, number>;
  pendingCandidates?: number;
  edges: number;
}

export type CallOpts = { timeoutMs?: number; idempotencyKey?: string };
/** `undefined` session = release any binding; a string binds that host session. */
export type SessionChoice = { sessionId: string | undefined };

export function normalizeRoot(root: string): string {
  // Extended-length paths: `\\?\C:\x` -> `C:\x` and `\\?\UNC\srv\share` ->
  // `\\srv\share`. The generic prefix strip alone would leave the UNC form as a
  // relative path on the current drive.
  let r = path.resolve(root.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, ''));
  r = r.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Drop `undefined` members so the wire carries only intended fields. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function pick(source: object, keys: readonly string[]): Record<string, unknown> {
  const rec = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (rec[k] !== undefined) out[k] = rec[k];
  return out;
}

export function isTransportFailure(error: unknown): boolean {
  return (
    isWrongMemoryError(error) &&
    (error.code === 'UNAVAILABLE' ||
      error.code === 'TRANSPORT' ||
      error.code === 'DEADLINE_EXCEEDED' ||
      error.code === 'SHUTTING_DOWN')
  );
}

export function filterStatuses(memories: Sage[], statuses: SageStatus[] | undefined): Sage[] {
  if (!statuses || statuses.length === 0) return memories;
  const allowed = new Set<string>(statuses);
  return memories.filter((m) => allowed.has(m.status));
}

export function rankScore(index: number, total: number): number {
  return total <= 1 ? 1 : 1 - index / (total - 1);
}

export interface WireMaintenanceStatus {
  schedule?: {
    enabled: boolean;
    cadenceMs: number;
    nextDueMs: number;
    lastRunMs?: number | null;
  } | null;
  recentJobs?: Array<{
    state: string;
    startedAtMs?: number | null;
    finishedAtMs?: number | null;
    result?: unknown;
    error?: { code?: string; message?: string } | null;
  }>;
}

/** A daemon millisecond timestamp as ISO, or `undefined` when it is not a valid Date. */
function isoTimestamp(ms: number | null | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** `maintenance.status` (newest job first) onto {@link SageMaintenanceStatus}. */
export function toMaintenanceStatus(wire: WireMaintenanceStatus): SageMaintenanceStatus {
  const schedule = wire.schedule ?? undefined;
  const jobs = wire.recentJobs ?? [];
  const last = jobs.find((j) => j.state === 'succeeded' || j.state === 'failed');
  const lastRunAt = schedule?.lastRunMs ? isoTimestamp(schedule.lastRunMs) : undefined;
  const nextRunAt = schedule?.enabled === true ? isoTimestamp(schedule.nextDueMs) : undefined;
  return {
    owner: 'daemon',
    scheduled: schedule?.enabled === true,
    intervalMs: schedule?.cadenceMs ?? 0,
    running: jobs.some((j) => j.state === 'running'),
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(last?.startedAtMs && last.finishedAtMs
      ? { lastDurationMs: last.finishedAtMs - last.startedAtMs }
      : {}),
    ...(last?.state === 'failed'
      ? { lastError: last.error?.message ?? last.error?.code ?? 'hygiene failed' }
      : {}),
    ...(last?.state === 'succeeded' && last.result
      ? { lastReport: last.result as SageMaintenanceStatus['lastReport'] }
      : {}),
    ...(nextRunAt !== undefined ? { nextRunAt } : {}),
  };
}

export interface WireChangeEvent {
  generation: number;
  change: string;
  memoryId?: string;
  candidateId?: string;
  revision?: number;
  telemetry?: boolean;
  atMs: number;
  origin?: string;
}

export interface WireEventsSince {
  daemonInstanceId: string;
  generation: number;
  resync: boolean;
  events: WireChangeEvent[];
}

/** A committed change from another connection as in-process host events. */
export function hostEventsFor(event: WireChangeEvent): Array<[string, Record<string, unknown>]> {
  const memoryId = event.memoryId;
  if (!memoryId) return [];
  const payload = {
    memoryId,
    ...(event.revision ? { revision: event.revision } : {}),
    remote: true,
  };
  switch (event.change) {
    case 'memory.remember':
    case 'candidate.accept':
      return [['memory.accepted', payload]];
    case 'memory.update':
    case 'memory.feedback':
      return [['memory.updated', payload]];
    case 'memory.delete':
      return [
        ['memory.deleted', payload],
        ['memory.updated', { ...payload, status: 'deleted' }],
      ];
    case 'memory.recover':
      return [['memory.recovered', payload]];
    default:
      return [];
  }
}

/** `HqSageRecord` (`@wrongstack/hq`) as it crosses the daemon boundary. */
export interface WireHqSageRecord {
  id: string;
  revision: number;
  changeId: string;
  memory: Record<string, unknown> | null;
}

/** The caller supplied a vector channel: fuse here (once), like the in-process store. */
export function ownsFusion(options: SageSearchOptions | undefined): boolean {
  return typeof (options?.vectorRecall as { search?: unknown } | undefined)?.search === 'function';
}
