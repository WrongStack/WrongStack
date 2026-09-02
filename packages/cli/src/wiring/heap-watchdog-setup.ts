import { startSharedHeapWatchdog } from '@wrongstack/core/utils';

interface SetupCliHeapWatchdogOptions {
  flags: Record<string, unknown>;
  tuiOwnsScreen: boolean;
  context: {
    session: { id: string };
    state: { messages: readonly { _estTokens?: number | undefined }[] };
  };
  metricsSink?: { droppedObservations: () => number } | undefined;
  hqPublisherRef: {
    current?:
      | {
          getQueueStats: () => {
            entries: number;
            bytes: number;
            maxBytes: number;
            droppedFrames: number;
            droppedBytes: number;
            coalescedFrames: number;
            coalescedBytes: number;
          };
        }
      | undefined;
    getKanbanSyncStats?:
      | (() =>
          | {
              localPublishActive: boolean;
              pendingBoardIds: number;
              fullRescanPending: boolean;
              remoteApplyQueued: boolean;
              pendingRemoteBoards: number;
              localPublishRuns: number;
              coalescedLocalRefreshes: number;
            }
          | undefined)
      | undefined;
  };
  brainMailbox: {
    getHqSnapshotStats: () => {
      inFlight: boolean;
      pending: boolean;
      timerScheduled: boolean;
      eventInFlight: boolean;
      pendingEvents: number;
      coalescedEvents: number;
      droppedEvents: number;
    };
  };
  teardownHandlers: Array<() => void>;
}

export function setupCliHeapWatchdog({
  flags,
  tuiOwnsScreen,
  context,
  metricsSink,
  hqPublisherRef,
  brainMailbox,
  teardownHandlers,
}: SetupCliHeapWatchdogOptions): void {
  const stopHeapWatchdog = startSharedHeapWatchdog({
    collectStats: () => {
      const hqQueue = hqPublisherRef.current?.getQueueStats();
      const hqSnapshot = brainMailbox.getHqSnapshotStats();
      const kanbanSync = hqPublisherRef.getKanbanSyncStats?.();
      return {
        surface: flags['simpleui']
          ? 'simpleui'
          : flags['webui']
            ? 'webui'
            : tuiOwnsScreen
              ? 'tui'
              : 'cli',
        sessionId: context.session.id,
        messages: context.state.messages.length,
        messageEstimatedTokens: context.state.messages.reduce(
          (sum, message) => sum + (message._estTokens ?? 0),
          0,
        ),
        metricsDroppedObservations: metricsSink?.droppedObservations() ?? 0,
        ...(hqQueue
          ? {
              hqQueueEntries: hqQueue.entries,
              hqQueueBytes: hqQueue.bytes,
              hqQueueMaxBytes: hqQueue.maxBytes,
              hqQueueDroppedFrames: hqQueue.droppedFrames,
              hqQueueDroppedBytes: hqQueue.droppedBytes,
              hqQueueCoalescedFrames: hqQueue.coalescedFrames,
              hqQueueCoalescedBytes: hqQueue.coalescedBytes,
            }
          : {}),
        hqSnapshotInFlight: hqSnapshot.inFlight ? 1 : 0,
        hqSnapshotPending: hqSnapshot.pending ? 1 : 0,
        hqSnapshotTimerScheduled: hqSnapshot.timerScheduled ? 1 : 0,
        hqEventInFlight: hqSnapshot.eventInFlight ? 1 : 0,
        hqEventPending: hqSnapshot.pendingEvents,
        hqEventCoalesced: hqSnapshot.coalescedEvents,
        hqEventDropped: hqSnapshot.droppedEvents,
        kanbanSyncActive: kanbanSync?.localPublishActive ? 1 : 0,
        kanbanSyncPendingBoards: kanbanSync?.pendingBoardIds ?? 0,
        kanbanSyncFullRescanPending: kanbanSync?.fullRescanPending ? 1 : 0,
        kanbanSyncRemoteApplyQueued: kanbanSync?.remoteApplyQueued ? 1 : 0,
        kanbanSyncPendingRemoteBoards: kanbanSync?.pendingRemoteBoards ?? 0,
        kanbanSyncPublishRuns: kanbanSync?.localPublishRuns ?? 0,
        kanbanSyncCoalescedRefreshes: kanbanSync?.coalescedLocalRefreshes ?? 0,
      };
    },
  });

  teardownHandlers.push(() => {
    void stopHeapWatchdog();
  });
}
