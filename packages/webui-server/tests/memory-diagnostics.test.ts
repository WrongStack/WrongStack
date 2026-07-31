import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRecentProcessMemoryDiagnostics } from '../src/server/memory-diagnostics.js';

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-memory-debug-'));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, 'logs'), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('readRecentProcessMemoryDiagnostics', () => {
  it('returns the newest bounded diagnostic for each process', async () => {
    const root = await createRoot();
    const lines = [
      {
        pid: 10,
        surface: 'tui',
        ts: '2026-07-31T00:00:00.000Z',
        rss: 100,
        heapUsed: 50,
        heapTotal: 80,
      },
      {
        pid: 20,
        surface: 'codebase-index-project-server',
        ts: '2026-07-31T00:00:01.000Z',
        rss: 200,
        heapUsed: 60,
        heapTotal: 90,
        activeResources: 2,
        activeResourceTypes: 'PipeWrap=2',
      },
      {
        pid: 10,
        surface: 'tui',
        sessionId: 'session-1',
        ts: '2026-07-31T00:00:02.000Z',
        rss: 300,
        heapUsed: 120,
        heapTotal: 160,
        external: 25,
        arrayBuffers: 12,
        retainedHeapUsed: 100,
        memorySignal: 'js-retention',
        historyEntries: 200,
        historyMountedEntries: 15,
        metricsDroppedObservations: 7,
        hqQueueEntries: 1,
        hqQueueBytes: 4096,
        hqQueueMaxBytes: 16 * 1024 * 1024,
        hqQueueDroppedFrames: 3,
        hqQueueCoalescedFrames: 9,
        hqSnapshotInFlight: 1,
        hqSnapshotPending: 1,
        hqSnapshotTimerScheduled: 0,
        hqEventInFlight: 1,
        hqEventPending: 5,
        hqEventCoalesced: 40,
        hqEventDropped: 2,
        kanbanSyncActive: 1,
        kanbanSyncPendingBoards: 4,
        kanbanSyncFullRescanPending: 1,
        kanbanSyncRemoteApplyQueued: 0,
        kanbanSyncPendingRemoteBoards: 2,
        kanbanSyncPublishRuns: 11,
        kanbanSyncCoalescedRefreshes: 250,
        kanbanSupervisorSnapshots: 3,
        kanbanSupervisorScheduledBoards: 3,
        kanbanSupervisorAgentCooldowns: 1,
        kanbanSupervisorRunningAgents: 1,
      },
    ];
    await fs.writeFile(
      path.join(root, 'logs', 'heap.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    );

    const diagnostics = await readRecentProcessMemoryDiagnostics(root);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({
      pid: 10,
      surface: 'tui',
      sessionId: 'session-1',
      memory: {
        rss: 300,
        heapUsed: 120,
        retainedHeapUsed: 100,
        external: 25,
        arrayBuffers: 12,
      },
      signal: 'js-retention',
      workload: {
        historyEntries: 200,
        historyMountedEntries: 15,
        metricsDroppedObservations: 7,
        kanbanSyncActive: true,
        kanbanSyncPendingBoards: 4,
        kanbanSyncFullRescanPending: true,
        kanbanSyncRemoteApplyQueued: false,
        kanbanSyncPendingRemoteBoards: 2,
        kanbanSyncPublishRuns: 11,
        kanbanSyncCoalescedRefreshes: 250,
        kanbanSupervisorSnapshots: 3,
        kanbanSupervisorScheduledBoards: 3,
        kanbanSupervisorAgentCooldowns: 1,
        kanbanSupervisorRunningAgents: 1,
      },
      hqQueue: {
        entries: 1,
        bytes: 4096,
        droppedFrames: 3,
        coalescedFrames: 9,
      },
      hqSnapshot: {
        inFlight: true,
        pending: true,
        timerScheduled: false,
        eventInFlight: true,
        pendingEvents: 5,
        coalescedEvents: 40,
        droppedEvents: 2,
      },
    });
    expect(diagnostics[1]).toMatchObject({
      pid: 20,
      resources: { active: 2, types: 'PipeWrap=2' },
    });
  });

  it('ignores a partial leading line when reading a bounded tail', async () => {
    const root = await createRoot();
    const latest = JSON.stringify({
      pid: 42,
      surface: 'simpleui',
      ts: '2026-07-31T00:00:03.000Z',
      rss: 400,
      heapUsed: 150,
      heapTotal: 200,
    });
    await fs.writeFile(
      path.join(root, 'logs', 'heap.jsonl'),
      `${JSON.stringify({ pid: 1, body: 'x'.repeat(4096) })}\n${latest}\n`,
    );

    const diagnostics = await readRecentProcessMemoryDiagnostics(root, latest.length + 16);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ pid: 42, surface: 'simpleui' });
  });

  it('returns an empty list when the flight recorder does not exist', async () => {
    const root = await createRoot();
    await fs.rm(path.join(root, 'logs', 'heap.jsonl'), { force: true });

    await expect(readRecentProcessMemoryDiagnostics(root)).resolves.toEqual([]);
    await expect(readRecentProcessMemoryDiagnostics(undefined)).resolves.toEqual([]);
  });
});
