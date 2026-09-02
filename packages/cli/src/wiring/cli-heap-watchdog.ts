import { startSharedHeapWatchdog } from '@wrongstack/core/utils';

interface CliHeapWatchdogParams {
  flags: { simpleui?: boolean; webui?: boolean; [key: string]: unknown };
  tuiOwnsScreen: boolean;
  context: {
    session: { id: string };
    state: { messages: ReadonlyArray<{ _estTokens?: number | undefined }> };
  };
  hqPublisherRef: {
    // biome-ignore lint/suspicious/noExplicitAny: stats shape
    current?: { getQueueStats: () => any } | null | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: stats shape
    getKanbanSyncStats?: (() => any) | undefined;
  };
  // biome-ignore lint/suspicious/noExplicitAny: stats shape
  brainMailbox: { getHqSnapshotStats: () => any };
  metricsSink?: { droppedObservations: () => number } | undefined;
  teardownHandlers: Array<() => void>;
}

export function startCliHeapWatchdog(params: CliHeapWatchdogParams): void {
  const {
    flags,
    tuiOwnsScreen,
    context,
    hqPublisherRef,
    brainMailbox,
    metricsSink,
    teardownHandlers,
  } = params;

  const stopHeapWatchdog = startSharedHeapWatchdog({
    collectStats: () => {
      const hqQueue = hqPublisherRef.current?.getQueueStats();
      const hqSnapshot = brainMailbox.getHqSnapshotStats();
      const kanbanSync = hqPublisherRef.getKanbanSyncStats?.();
      return {
        surface: flags.simpleui
          ? 'simpleui'
          : flags.webui
            ? 'webui'
            : tuiOwnsScreen
              ? 'tui'
              : 'cli',
        sessionId: context.session.id,
        messages: context.state.messages.length,
        messageEstimatedTokens: context.state.messages.reduce(
          (sum: number, message: { _estTokens?: number | undefined }) =>
            sum + (message._estTokens ?? 0),
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
