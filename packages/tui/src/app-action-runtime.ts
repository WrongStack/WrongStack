import type {
  ContextSnapshot,
  DesignKitEntry,
  FleetChatVerbosity,
} from '@wrongstack/contracts/types';
import type { State } from './app-state.js';
import type {
  DraftEntry,
  QueueItem,
  ResumeSessionEntry,
  SlashCommandMatch,
} from './app-state-core-types.js';
import type { HistoryEntry } from './history-entry.js';
import type { HelpEntry, PluginPickerItem, ProjectPickerItem } from './ui-contracts.js';
export type AppActionRuntime =
  | { type: 'addEntry'; entry: DraftEntry }
  | { type: 'archiveLoaded'; entries: HistoryEntry[] }
  | { type: 'startArchiveLoad' }
  | { type: 'compactHistory' }
  | { type: 'setBuffer'; buffer: string; cursor: number }
  | { type: 'clearInput' }
  | { type: 'bashModeEnter' }
  | { type: 'bashModeExit' }
  | {
      type: 'clearHistory';
      model?: string | undefined;
      provider?: string | undefined;
      cwd?: string | undefined;
      sessionId?: string | undefined;
      /**
       * Tells the reducer the boot-time restored transcript source has been
       * discarded (e.g. by `/clear`). When explicitly `null` (not just
       * omitted), the reducer resets the resume-derived state slice to the
       * fresh values `createInitialState` would have produced with no
       * restored entries: `historyBudget = undefined`, `autoProceedHold = false`,
       * and `nextId` re-seeded from the surviving banner only. Pass
       * `undefined` to leave the resume slice intact (existing behavior for
       * `session.rewound` / `project.switched`).
       */
      restoredMessages?: readonly unknown[] | null | undefined;
      restoredToolCalls?: readonly unknown[] | null | undefined;
      restoredEvents?: readonly unknown[] | null | undefined;
      /**
       * Keep the checkpoint list. A rewind clears the screen but the
       * checkpoints up to its target still belong to this conversation.
       */
      keepCheckpoints?: boolean | undefined;
    }
  | { type: 'streamDelta'; delta: string }
  | { type: 'streamReset' }
  | { type: 'status'; status: State['status'] }
  | { type: 'interrupt' }
  | { type: 'resetInterrupts' }
  | { type: 'steerStart'; snapshot: State['steerSnapshot'] }
  | { type: 'steerConsume' }
  | { type: 'hint'; text: string }
  | { type: 'copiedNotice'; text: string; entryId: number | null }
  | {
      type: 'inspectOverlayOpen';
      entryId: number;
      entryIds?: readonly number[] | undefined;
    }
  | { type: 'inspectOverlayClose' }
  | { type: 'inspectOverlayScroll'; delta: number }
  | { type: 'chatSearchOpen'; query?: string | undefined; includeReasoning: boolean }
  | { type: 'chatSearchSetQuery'; query: string; includeReasoning: boolean }
  | { type: 'chatSearchStep'; delta: -1 | 1; includeReasoning: boolean }
  | { type: 'chatSearchClose' }
  | { type: 'messageJump'; direction: -1 | 1 }
  | { type: 'messageJumpClear' }
  | { type: 'pickerOpen'; query: string }
  | { type: 'pickerClose' }
  | { type: 'pickerSetMatches'; query: string; matches: string[] }
  | { type: 'pickerMove'; delta: number }
  | { type: 'enqueue'; item: Omit<QueueItem, 'id'> }
  | { type: 'dequeueFirst' }
  | { type: 'queueClear' }
  | { type: 'queueDelete'; positions: number[] }
  | { type: 'queueToggleRefine'; position: number }
  | { type: 'slashPickerOpen'; query: string; matches: SlashCommandMatch[] }
  | { type: 'slashPickerClose' }
  | { type: 'slashPickerMove'; delta: number }
  | { type: 'designPickerOpen'; kits: DesignKitEntry[] }
  | { type: 'designPickerClose' }
  | { type: 'designPickerMove'; delta: number }
  | { type: 'designPickerStack'; stack: string }
  | { type: 'resumePickerOpen'; sessions: ResumeSessionEntry[] }
  | { type: 'resumePickerClose' }
  | { type: 'resumePickerMove'; delta: number }
  | { type: 'resumePickerBusy'; on: boolean }
  | { type: 'resumePickerHint'; text?: string | undefined }
  | { type: 'resumePickerError'; text: string }
  | { type: 'autoProceedRelease' }
  | { type: 'resumeLoadStart'; sessionId: string; label: string }
  | {
      type: 'resumeLoadTick';
      sessionId?: string | undefined;
      loadedBytes?: number | undefined;
      totalBytes?: number | undefined;
      /** Human-readable stage line to push onto the rolling log. */
      note?: string | undefined;
    }
  | {
      type: 'resumeStreamChunk';
      /**
       * Session the chunk belongs to. Stamped by the runResume chain so the
       * reducer can drop a SUPERSEDED run's terminating `done` chunk instead
       * of settling the winning load with another session's transcript.
       * Unstamped chunks keep legacy semantics.
       */
      sessionId?: string | undefined;
      entries: HistoryEntry[];
      /** Total entries in the replay, for the batch counter. */
      total: number;
      done?: boolean | undefined;
      /** Keep input gated until replay effects and suggestion restoration settle. */
      holdUntilSettled?: boolean | undefined;
      /** Actual attached session metadata; absent for read-only replay. */
      banner?:
        | {
            sessionId: string;
            cwd?: string | undefined;
            model?: string | undefined;
            provider?: string | undefined;
          }
        | undefined;
      contextSnapshot?: ContextSnapshot | undefined;
    }
  | { type: 'resumeLoadAbort'; sessionId?: string | undefined }
  | {
      type: 'replaceHistory';
      entries: HistoryEntry[];
      nextId: number;
      /**
       * Optional context-window snapshot forwarded from the host's
       * `onResumeSession` return. When present, the reducer writes
       * `tokens` to `state.leader.ctxTokens` and bumps
       * `state.contextChipVersion` so the statusline chip and `/context`
       * panel reflect the rebuilt context immediately, instead of staying
       * at zero until the next ctx.pct event.
       */
      contextSnapshot?: ContextSnapshot | undefined;
    }
  | { type: 'pluginPickerOpen'; items?: PluginPickerItem[] | undefined }
  | { type: 'pluginPickerClose' }
  | { type: 'pluginPickerMove'; delta: number }
  | { type: 'pluginPickerSetItems'; items: PluginPickerItem[] }
  | { type: 'pluginPickerBusy'; busy: boolean }
  | { type: 'pluginPickerHint'; text?: string | undefined }
  | { type: 'helpOpen'; entries: HelpEntry[] }
  | { type: 'helpClose' }
  | { type: 'helpMove'; delta: number }
  | { type: 'helpFilter'; filter: string }
  | { type: 'helpHint'; text?: string | undefined }
  | { type: 'helpScrollDetail'; delta: number }
  | { type: 'projectPickerOpen'; items: ProjectPickerItem[] }
  | { type: 'projectPickerClose' }
  | { type: 'projectPickerMove'; delta: number }
  | { type: 'projectPickerFilter'; filter: string }
  | { type: 'projectPickerHint'; text?: string | undefined }
  | { type: 'fKeyPickerOpen' }
  | { type: 'fKeyPickerClose' }
  | { type: 'fKeyPickerMove'; delta: number }
  | { type: 'setInputHistory'; entries: string[] }
  | { type: 'clearInputHistory' }
  | { type: 'confirmOpen'; info: State['confirmQueue'][0] }
  | { type: 'confirmClose' }
  | { type: 'confirmResolved'; toolUseId: string }
  | { type: 'confirmClearAll' }
  | { type: 'shellCommandWarningOpen'; info: NonNullable<State['shellCommandWarning']> }
  | { type: 'shellCommandWarningClose' }
  | { type: 'enhanceOpen'; info: NonNullable<State['enhance']> }
  | { type: 'enhanceClose' }
  | { type: 'enhanceSet'; enabled: boolean }
  | { type: 'enhanceBusy'; on: boolean }
  | { type: 'topicCheckBusy'; on: boolean }
  | { type: 'refineCountdownOpen'; info: NonNullable<State['refineCountdown']> }
  | { type: 'refineCountdownClose'; info?: NonNullable<State['refineCountdown']> }
  | { type: 'refineFailureOpen'; info: NonNullable<State['refineFailure']> }
  | { type: 'refineFailureClose' }
  | { type: 'continueConfirmOpen'; info: NonNullable<State['continueConfirm']> }
  | { type: 'continueConfirmClose' }
  | { type: 'clearConfirmOpen'; info: NonNullable<State['clearConfirm']> }
  | { type: 'clearConfirmSetValue'; value: string }
  | { type: 'clearConfirmClose' }
  | { type: 'exitConfirmOpen'; info: NonNullable<State['exitConfirm']> }
  | { type: 'exitConfirmClose' }
  | { type: 'slashConfirmOpen'; info: NonNullable<State['slashConfirm']> }
  | { type: 'slashConfirmClose' }
  | { type: 'escConfirmOpen'; snapshot: NonNullable<State['steerSnapshot']> }
  | { type: 'escConfirmClose' }
  | { type: 'fallbackOverlayOpen'; info: NonNullable<State['fallbackOverlay']> }
  | { type: 'fallbackOverlayMove'; delta: number }
  | { type: 'fallbackOverlayClose' }
  | { type: 'sendModePickerOpen'; info: NonNullable<State['sendModePicker']> }
  | { type: 'sendModePickerMove'; delta: number }
  | { type: 'sendModePickerClose' }
  | { type: 'resetContextChip' }
  | { type: 'leaderIterStart' }
  | { type: 'leaderIterEnd' }
  | { type: 'leaderToolStart'; name: string }
  | {
      type: 'leaderToolEnd';
      name: string;
      ok?: boolean | undefined;
      durationMs?: number | undefined;
    }
  | { type: 'leaderCtxPct'; load: number; tokens: number; maxContext: number }
  | { type: 'setFleetChat'; mode: FleetChatVerbosity }
  | { type: 'toggleMonitor' }
  | { type: 'toggleAgentsMonitor' }
  | { type: 'toggleHelp' }
  | { type: 'toggleTodosMonitor' }
  | { type: 'toggleQueuePanel' }
  | { type: 'checkpointReceived'; cp: State['checkpoints'][0] }
  | { type: 'rewindOverlayOpen'; selected?: number | undefined }
  | { type: 'rewindOverlayClose' }
  | { type: 'checkpointFork'; promptIndex: number }
  | { type: 'forkRequestDone' }
  | { type: 'rewindOverlayMove'; delta: number }
  | { type: 'toggleSddBoardMonitor' }
  | { type: 'toggleWorktreeMonitor' }
  | { type: 'setHistoryScrolled'; scrolled: boolean }
  | { type: 'setViewportRows'; rows: number }
  | { type: 'toggleProcessList' }
  | { type: 'toggleCronMonitor' }
  | { type: 'toggleAuditPanel' }
  | { type: 'togglePlanPanel' }
  | { type: 'closeAllPanels' }
  | { type: 'toggleSidebarFocus' }
  | {
      type: 'sidebarScroll';
      delta: number;
      viewportHeight?: number | undefined;
      /**
       * Rows occupied by routed twin panels (Todos / Plan / Kanban / …)
       * mounted above `SidebarContent` inside `RightSidebar`. Subtracted
       * from `viewportHeight` so the scroll clamp matches the actual
       * viewport the user can scroll through. Defaults to 0 (no twins
       * mounted) when omitted so existing call sites stay correct.
       */
      sidebarTwinRowCount?: number | undefined;
      /**
       * Whether the swarm panel is on the sidebar using the effective
       * source (picker draft when the picker is open, persisted
       * `liveSettings` otherwise — see `app-view.tsx`). Drives the
       * mission-queue reservation in `computeMaxSidebarScroll`; without
       * this field the reducer only sees the picker draft and under-
       * reserves the mission card when a config-only 'sidebar' swarm
       * mode is persisted but the picker has never been opened.
       */
      effectiveSwarmOnSidebar?: boolean | undefined;
    }
  | { type: 'sidebarScrollReset' }
  | {
      type: 'sidebarScrollSet';
      /** Absolute offset in rows from the content top; clamped to [0, max]. */
      offset: number;
      viewportHeight?: number | undefined;
      /** See the `sidebarScroll` twin field — identical clamp semantics. */
      sidebarTwinRowCount?: number | undefined;
      /** See the `sidebarScroll` twin field — identical clamp semantics. */
      effectiveSwarmOnSidebar?: boolean | undefined;
    }
  | { type: 'toggleKanbanPanel' }
  | { type: 'toggleGoalPanel' }
  | { type: 'toggleGoalKanbanPanel' }
  | { type: 'toggleContextPanel' }
  | { type: 'toggleConnectionsPanel' }
  | { type: 'toggleSessionsPanel' }
  | {
      type: 'debugStreamStats';
      chunkCount: number;
      lastChunkSize: number;
      lastDeltaMs: number;
      totalBytes: number;
      lastChunkAt: string;
    }
  | { type: 'debugStreamStatsClear' }
  | { type: 'countdownTick'; remainingSeconds: number }
  | { type: 'countdownEnded' }
  | {
      type: 'coordinatorEvent';
      event: {
        type: string;
        goalId?: string | undefined;
        taskId?: string | undefined;
        knowledgeId?: string | undefined;
        title?: string | undefined;
        text?: string | undefined;
        participants?: string[] | undefined;
      };
    }
  | { type: 'toggleCoordinatorMonitor' };
