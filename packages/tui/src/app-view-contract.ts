import type { AgentTimelineEntry, Director } from '@wrongstack/core/coordination';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppProps } from './app-props.js';
import type { State } from './app-state.js';
import type { deriveAppViewState } from './app-view-state.js';
import type { KeyEvent } from './components/input.js';
import type { CronListResult } from './cron-slash.js';
import type { useGitSessionStatus } from './hooks/use-git-session-status.js';
import type { useLiveTodos } from './hooks/use-live-todos.js';
import type { useMailboxViewModel } from './hooks/use-mailbox-view-model.js';
import type { useStatusbarViewModel } from './hooks/use-statusbar-view-model.js';
import type { useTuiActivity } from './hooks/use-tui-activity.js';
import type { useTuiEnvironmentState } from './hooks/use-tui-environment-state.js';
import type { DOMElement } from './ink.js';
import type { StatuslineMode } from './settings-contracts.js';

interface AppViewRuntime {
  state: State;
  dispatch: Dispatch<Action>;
  activity: ReturnType<typeof useTuiActivity>;
  environment: ReturnType<typeof useTuiEnvironmentState>;
  statusbar: ReturnType<typeof useStatusbarViewModel>;
  mailbox: ReturnType<typeof useMailboxViewModel>;
  gitInfo: ReturnType<typeof useGitSessionStatus>;
  viewState: ReturnType<typeof deriveAppViewState>;
  mouseMode: boolean;
  /**
   * Live terminal row count. AppView caps its root box at exactly this height
   * (overflowY hidden) so a frame can never be taller than the terminal: a
   * taller frame scrolls the terminal, strands the top rows in native
   * scrollback and desyncs Ink's erase math — the root cause of the
   * accumulated-garbage / jumping-viewport artifacts.
   */
  termRows: number;
  /**
   * Receives the imperative scroll controller assigned by ScrollableHistory.
   * The app key/mouse handlers and the submit path drive scrolling through it.
   */
  historyScrollRef: MutableRefObject<
    import('./components/scrollable-history.js').HistoryScrollController | null
  >;
  /**
   * Stable callback ScrollableHistory calls on scroll-state transitions
   * (scrolled away from / re-pinned to the newest output). Drives the
   * "managed" key hint via `state.historyScrolled`.
   */
  onScrollInfo?: ((info: { scrolled: boolean }) => void) | undefined;
  /**
   * Called by ScrollableHistory when the user scrolls to the oldest loaded
   * entries. The host should load older entries from the history archive and
   * dispatch `archiveLoaded` to prepend them into the scroll window.
   */
  onRequestOlderEntries?: (() => void) | undefined;
  bottomRegionRef: MutableRefObject<DOMElement | null>;
  statusBarWrapRef: MutableRefObject<DOMElement | null>;
  belowStatusBarRef: MutableRefObject<DOMElement | null>;
  /**
   * Measured rows consumed by the status chrome below the pickers (status
   * bar + mailbox/monitors/key-hint). Picker overlays use it to size their
   * window against the real remaining space instead of a hardcoded guess.
   */
  statusBarRows: number;
  /** Chip click map published by StatusBar; consumed by the mouse hit-test. */
  statusBarClickMapRef: MutableRefObject<
    import('./components/status-bar-types.js').StatusBarClickMap | null
  >;
  stableOnKey: (input: string, key: KeyEvent) => void;
  liveTodos: ReturnType<typeof useLiveTodos>;
  liveSettings: ReturnType<NonNullable<AppProps['getSettings']>> | undefined;
  liveAnimationStyle: State['settingsPicker']['animationStyle'];
  liveStatuslineMode: StatuslineMode;
  projectName: string | undefined;
  workingDirChip: string | undefined;
  handleRewindTo: (checkpointIndex: number) => Promise<void>;
  activeCtrlRef: MutableRefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  liveDirector: () => Director | null;
  dismissedEscAtRef: MutableRefObject<number>;
  enhanceOriginalRef: MutableRefObject<string>;
  enhanceStartedAt: number | null;
  enhanceDurationMs: number | null;
  refineProviderId: string | null;
  refineModel: string | null;
  setEnhanceCountdown: Dispatch<SetStateAction<number | null>>;
  enhanceCountdown: number | null;
  nextStepsAutoSubmitCountdown: number | null;
  nextStepsAutoSubmitLabel: string | null;
  setDraft: (buffer: string, cursor: number) => void;
  focusedBoardId: string | null;
  getCronJobs: () => Promise<CronListResult>;
  getLeaderTranscript: () => AgentTimelineEntry[];
  coordinatorRunning: boolean;
  enhanceDelayMs: number;
  /** Per-session layout store for virtual-scroll positioning. */
  layoutStore: import('./layout-store.js').LayoutStore;
}

export interface AppViewProps {
  host: AppProps;
  runtime: AppViewRuntime;
}
