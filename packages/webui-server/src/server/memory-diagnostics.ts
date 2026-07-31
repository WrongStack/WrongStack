import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const DEFAULT_TAIL_BYTES = 1024 * 1024;
const MAX_PROCESSES = 32;

export interface ProcessMemoryDiagnostic {
  pid: number;
  surface: string;
  sessionId?: string | undefined;
  ts: string;
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    retainedHeapUsed?: number | undefined;
    nativeResidual?: number | undefined;
    external?: number | undefined;
    arrayBuffers?: number | undefined;
  };
  signal?: string | undefined;
  heapGrowthBytesPerHour?: number | undefined;
  rssGrowthBytesPerHour?: number | undefined;
  workload: {
    messages?: number | undefined;
    messageEstimatedTokens?: number | undefined;
    historyEntries?: number | undefined;
    historyMountedEntries?: number | undefined;
    historyCachedGroups?: number | undefined;
    appRenders?: number | undefined;
    metricsDroppedObservations?: number | undefined;
    kanbanSyncActive?: boolean | undefined;
    kanbanSyncPendingBoards?: number | undefined;
    kanbanSyncFullRescanPending?: boolean | undefined;
    kanbanSyncRemoteApplyQueued?: boolean | undefined;
    kanbanSyncPendingRemoteBoards?: number | undefined;
    kanbanSyncPublishRuns?: number | undefined;
    kanbanSyncCoalescedRefreshes?: number | undefined;
    kanbanSupervisorSnapshots?: number | undefined;
    kanbanSupervisorScheduledBoards?: number | undefined;
    kanbanSupervisorAgentCooldowns?: number | undefined;
    kanbanSupervisorRunningAgents?: number | undefined;
  };
  resources: {
    active?: number | undefined;
    types?: string | undefined;
  };
  hqQueue?:
    | {
        entries: number;
        bytes: number;
        maxBytes: number;
        droppedFrames: number;
        droppedBytes: number;
        coalescedFrames: number;
        coalescedBytes: number;
      }
    | undefined;
  hqSnapshot?:
    | {
        inFlight: boolean;
        pending: boolean;
        timerScheduled: boolean;
        eventInFlight: boolean;
        pendingEvents: number;
        coalescedEvents: number;
        droppedEvents: number;
      }
    | undefined;
  profileTopStack?: string | undefined;
  profileTopStackBytes?: number | undefined;
}

function finiteNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toProcessDiagnostic(record: Record<string, unknown>): ProcessMemoryDiagnostic | null {
  const pid = finiteNumber(record, 'pid');
  const ts = stringValue(record, 'ts');
  if (pid === undefined || ts === undefined) return null;

  const queueEntries = finiteNumber(record, 'hqQueueEntries');
  const queueBytes = finiteNumber(record, 'hqQueueBytes');
  const queueMaxBytes = finiteNumber(record, 'hqQueueMaxBytes');
  const snapshotInFlight = finiteNumber(record, 'hqSnapshotInFlight');
  const snapshotPending = finiteNumber(record, 'hqSnapshotPending');
  const snapshotTimerScheduled = finiteNumber(record, 'hqSnapshotTimerScheduled');
  const eventInFlight = finiteNumber(record, 'hqEventInFlight');
  const eventPending = finiteNumber(record, 'hqEventPending');
  const eventCoalesced = finiteNumber(record, 'hqEventCoalesced');
  const eventDropped = finiteNumber(record, 'hqEventDropped');

  return {
    pid,
    surface: stringValue(record, 'surface') ?? 'unknown',
    ...(stringValue(record, 'sessionId') !== undefined
      ? { sessionId: stringValue(record, 'sessionId') }
      : {}),
    ts,
    memory: {
      rss: finiteNumber(record, 'rss') ?? 0,
      heapUsed: finiteNumber(record, 'heapUsed') ?? 0,
      heapTotal: finiteNumber(record, 'heapTotal') ?? 0,
      retainedHeapUsed: finiteNumber(record, 'retainedHeapUsed'),
      nativeResidual: finiteNumber(record, 'nativeResidual'),
      external: finiteNumber(record, 'external'),
      arrayBuffers: finiteNumber(record, 'arrayBuffers'),
    },
    signal: stringValue(record, 'memorySignal'),
    heapGrowthBytesPerHour: finiteNumber(record, 'heapGrowthBytesPerHour'),
    rssGrowthBytesPerHour: finiteNumber(record, 'rssGrowthBytesPerHour'),
    workload: {
      messages: finiteNumber(record, 'messages'),
      messageEstimatedTokens: finiteNumber(record, 'messageEstimatedTokens'),
      historyEntries: finiteNumber(record, 'historyEntries'),
      historyMountedEntries: finiteNumber(record, 'historyMountedEntries'),
      historyCachedGroups: finiteNumber(record, 'historyCachedGroups'),
      appRenders: finiteNumber(record, 'appRenders'),
      metricsDroppedObservations: finiteNumber(record, 'metricsDroppedObservations'),
      kanbanSyncActive: finiteNumber(record, 'kanbanSyncActive') === 1,
      kanbanSyncPendingBoards: finiteNumber(record, 'kanbanSyncPendingBoards'),
      kanbanSyncFullRescanPending: finiteNumber(record, 'kanbanSyncFullRescanPending') === 1,
      kanbanSyncRemoteApplyQueued: finiteNumber(record, 'kanbanSyncRemoteApplyQueued') === 1,
      kanbanSyncPendingRemoteBoards: finiteNumber(record, 'kanbanSyncPendingRemoteBoards'),
      kanbanSyncPublishRuns: finiteNumber(record, 'kanbanSyncPublishRuns'),
      kanbanSyncCoalescedRefreshes: finiteNumber(record, 'kanbanSyncCoalescedRefreshes'),
      kanbanSupervisorSnapshots: finiteNumber(record, 'kanbanSupervisorSnapshots'),
      kanbanSupervisorScheduledBoards: finiteNumber(record, 'kanbanSupervisorScheduledBoards'),
      kanbanSupervisorAgentCooldowns: finiteNumber(record, 'kanbanSupervisorAgentCooldowns'),
      kanbanSupervisorRunningAgents: finiteNumber(record, 'kanbanSupervisorRunningAgents'),
    },
    resources: {
      active: finiteNumber(record, 'activeResources'),
      types: stringValue(record, 'activeResourceTypes'),
    },
    ...(queueEntries !== undefined && queueBytes !== undefined && queueMaxBytes !== undefined
      ? {
          hqQueue: {
            entries: queueEntries,
            bytes: queueBytes,
            maxBytes: queueMaxBytes,
            droppedFrames: finiteNumber(record, 'hqQueueDroppedFrames') ?? 0,
            droppedBytes: finiteNumber(record, 'hqQueueDroppedBytes') ?? 0,
            coalescedFrames: finiteNumber(record, 'hqQueueCoalescedFrames') ?? 0,
            coalescedBytes: finiteNumber(record, 'hqQueueCoalescedBytes') ?? 0,
          },
        }
      : {}),
    ...(snapshotInFlight !== undefined ||
    snapshotPending !== undefined ||
    snapshotTimerScheduled !== undefined
      ? {
          hqSnapshot: {
            inFlight: snapshotInFlight === 1,
            pending: snapshotPending === 1,
            timerScheduled: snapshotTimerScheduled === 1,
            eventInFlight: eventInFlight === 1,
            pendingEvents: eventPending ?? 0,
            coalescedEvents: eventCoalesced ?? 0,
            droppedEvents: eventDropped ?? 0,
          },
        }
      : {}),
    profileTopStack: stringValue(record, 'memoryProfileTopStack'),
    profileTopStackBytes: finiteNumber(record, 'memoryProfileTopStackBytes'),
  };
}

/**
 * Read only the tail of the process-wide heap JSONL flight recorder and
 * return the newest sample for each PID. This endpoint must stay cheap even
 * after weeks of uptime, so it never loads the full log into the WebUI server.
 */
export async function readRecentProcessMemoryDiagnostics(
  globalRoot: string | undefined,
  tailBytes = DEFAULT_TAIL_BYTES,
): Promise<ProcessMemoryDiagnostic[]> {
  if (!globalRoot) return [];
  const heapLog = path.join(globalRoot, 'logs', 'heap.jsonl');
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(heapLog, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, Math.max(1, tailBytes));
    if (length === 0) return [];
    const start = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline === -1) return [];
      text = text.slice(firstNewline + 1);
    }

    const newestByPid = new Map<number, ProcessMemoryDiagnostic>();
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        const diagnostic = toProcessDiagnostic(parsed as Record<string, unknown>);
        if (!diagnostic || newestByPid.has(diagnostic.pid)) continue;
        newestByPid.set(diagnostic.pid, diagnostic);
        if (newestByPid.size >= MAX_PROCESSES) break;
      } catch {
        // A concurrent append can leave the final line temporarily partial.
      }
    }
    return [...newestByPid.values()].sort((a, b) => b.ts.localeCompare(a.ts));
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
