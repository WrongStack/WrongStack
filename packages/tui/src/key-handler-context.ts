import type { Director } from '@wrongstack/core/coordination';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { Action } from './app-action-type.js';
import type { AppProps } from './app-props.js';
import type { State } from './app-state.js';
import type { KeyEvent } from './components/input.js';
import type { HistoryScrollController } from './components/scrollable-history.js';
import type { StatusBarClickMap } from './components/status-bar-types.js';
import type { StatuslineItem } from './components/statusline-picker.js';
import type { DOMElement } from './ink.js';
import type { PasteAccumState } from './paste-accumulator.js';

export interface AppKeyHandlerOptions {
  state: State;
  dispatch: Dispatch<Action>;
  historyScrollRef: MutableRefObject<HistoryScrollController | null>;
  /** Resets the live-tail timeout after a user-driven history navigation. */
  onHistoryScrollActivity?: (() => void) | undefined;
  runInterruptLadder: () => void;
  enhanceCancelledRef: MutableRefObject<boolean>;
  enhanceAbortRef: MutableRefObject<AbortController | null>;
  inputGateRef: MutableRefObject<boolean>;
  lastEscAtRef: MutableRefObject<number>;
  pasteAccumRef: MutableRefObject<PasteAccumState>;
  pasteFlushTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  commitPaste: (full: string) => Promise<void>;
  tryPickerKey: (input: string, key: KeyEvent, isEnter: boolean) => boolean;
  dismissedEscAtRef: MutableRefObject<number>;
  streamingTextRef: MutableRefObject<string>;
  confirmExitRef: MutableRefObject<boolean>;
  activeCtrlRef: MutableRefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  liveDirector: () => Director | null;
  openProjectPicker: () => Promise<void>;
  loadLiveSessions: () => Promise<void>;
  openStatuslinePicker: (field?: number) => void;
  statuslineHiddenItems: StatuslineItem[];
  getSddRun: AppProps['getSddRun'];
  onSddLifecycle: AppProps['onSddLifecycle'];
  getSettings: AppProps['getSettings'];
  saveSettings: AppProps['saveSettings'];
  lastEnterAtRef: MutableRefObject<number>;
  draftRef: MutableRefObject<{ buffer: string; cursor: number }>;
  setDraft: (buffer: string, cursor: number) => void;
  /** Submits the composer. `overrideRaw` bypasses the buffer (bash mode
   *  forwards its draft through the `!` shell path this way). */
  submit: (overrideRaw?: string) => void;
  mouseMode: boolean;
  termRows: number;
  terminalColumns: number;
  terminalRows: number;
  /** Width of the main column (terminal width minus sidebar). When > 0,
   *  scrollbar hit-tests use this instead of terminalColumns so the scrollbar
   *  track is correctly positioned to the left of the sidebar. */
  mainColumnWidth: number;
  /**
   * Whether a full-width overlay owns the screen.
   *
   * Passed in rather than derived. The old proxy —
   * `mainColumnWidth >= stdout.columns` — is true whenever the sidebar is
   * ZERO wide, and `computeSidebarWidth` returns 0 for any terminal under
   * `SIDEBAR_MIN_TERMINAL` (64 columns). So on a narrow terminal the flag was
   * permanently true with nothing open, and the whole `if (!overlayOpen)`
   * block below — wheel scrolling, scrollbar drag, drag-select, copy icons,
   * every status-bar chip click, PageUp/PageDown — silently stopped working,
   * along with Shift+Tab, `?` help, and (via `routeInputKey`) up/down input
   * history. `app.tsx` already hands the real value to `useMouseTracking`.
   */
  overlayOpen: boolean;
  /**
   * Effective swarm-on-sidebar read: `panelPositions.fleet === 'sidebar'`
   * OR the legacy `showAgentSwarmPanel === 'sidebar'` flag from
   * `liveSettings`. The renderer at `app-view.tsx:897-899` reads
   * ONLY the legacy `showAgentSwarmPanel` field (not the panel-
   * position map) to decide whether to show the mission card; the
   * scroll-clamp reservation must match that source or a config-only
   * legacy 'sidebar' swarm mode (no recent picker open) will render
   * the mission card but the clamp will under-reserve, hiding the
   * bottom mission rows behind `RightSidebar`'s `overflowY="hidden"`
   * viewport. The OR with `panelPositions.fleet` is directionally
   * safe (over-reservation is harmless) and aligns with the field
   * that gates whether the swarm twin is mounted. See
   * {@link SidebarLayoutState.effectiveSwarmOnSidebar}. Threaded into
   * `sidebarScroll` dispatches so the reducer's mission-queue
   * reservation matches the actual render.
   */
  effectiveSwarmOnSidebar: boolean;
  /**
   * Approximate row count for routed sidebar twin panels mounted above
   * `SidebarContent`. Subtracted from `viewportHeight` by the reducer's
   * scroll clamp so the user can't scroll past the end into blank space.
   * See {@link SidebarLayoutState.sidebarTwinRowCount}.
   */
  sidebarTwinRowCount: number;
  statusBarWrapRef: MutableRefObject<DOMElement | null>;
  belowStatusBarRef: MutableRefObject<DOMElement | null>;
  /** Chip click map published by StatusBar on every render. */
  statusBarClickMapRef: MutableRefObject<StatusBarClickMap | null>;
  /** Actual rendered title row for inspect-modal Copy/Close hit-testing. */
  inspectOverlayHeaderRef: MutableRefObject<DOMElement | null>;
  openModelPicker: () => Promise<void>;
  nextStepsAutoSubmitTimerRef: MutableRefObject<ReturnType<typeof setInterval> | undefined>;
  nextStepsAutoSubmitSuggestionRef: MutableRefObject<string | null>;
  nextStepsAutoSubmitLabel: string | null;
  setNextStepsAutoSubmitCountdown: Dispatch<SetStateAction<number | null>>;
  setNextStepsAutoSubmitLabel: Dispatch<SetStateAction<string | null>>;
  cancelNextStepsCountdown: () => void;
  pasteClipboardText: () => Promise<void>;
  pasteClipboardImage: () => Promise<void>;
  slashRegistry: AppProps['slashRegistry'];
  agent: AppProps['agent'];
  /**
   * Called with the copied entry's id after a chat card's copy icon is clicked
   * and its content was successfully written to the clipboard. Lets the host
   * surface a transient "Copied" confirmation and flash that card's icon. Not
   * called when the click missed or the write failed.
   */
  onHistoryCopy?: ((entryId: number) => void) | undefined;
}

/**
 * The shared view of the key-handler wiring that the ordered route modules
 * (decomposition Phase 3 — docs/decomposition-plan.md) receive. It is the
 * factory's full `AppKeyHandlerOptions` plus the three values the factory
 * derives once per session: the resolved stdout shape, the effective history
 * width (terminal minus sidebar), and the `detach` helper that runs route
 * promises without risking the process.
 */
export interface KeyRouteContext extends AppKeyHandlerOptions {
  stdout: { columns: number; rows: number };
  /** Effective width of the history area (terminal minus sidebar). */
  historyWidth: number;
  /** Runs a detached promise from a route; failures surface as error entries. */
  detach: (work: Promise<unknown> | undefined, what: string) => void;
}

/** Re-exported for route modules that need the ref/callback shapes. */
export type {
  Action,
  AppProps,
  Director,
  Dispatch,
  DOMElement,
  HistoryScrollController,
  MutableRefObject,
  PasteAccumState,
  SetStateAction,
  StatusBarClickMap,
  StatuslineItem,
};
