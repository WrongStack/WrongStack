/**
 * Shared fixture for {@link createAppKeyHandler} tests.
 *
 * Was private to key-handler-replay-corpus.test.ts until the raw-byte-path
 * suite needed the same option plumbing: the corpus pins the handler's ROUTING
 * with synthesized events, the byte-path suite pins the events the real input
 * layer produces. Both must exercise one identical host.
 *
 * The stubs return inert values so every route branch is reachable and
 * deterministic. One deliberate cast: the host pins routing, not option
 * plumbing (which app.tsx owns).
 */

import { type Mock, vi } from 'vitest';
import { createAppKeyHandler } from '../../src/app-key-handler.js';
import type { State } from '../../src/app-state.js';
import type { KeyEvent } from '../../src/components/input.js';

type KeyOverrides = Partial<KeyEvent>;

const NO_KEY: KeyEvent = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  pageUp: false,
  pageDown: false,
  home: false,
  end: false,
};

export function key(overrides: KeyOverrides = {}): KeyEvent {
  return { ...NO_KEY, ...overrides };
}

/** Everything a test needs to drive and observe the key handler host. */
export interface KeyHandlerFixture {
  handler: (input: string, key: KeyEvent) => Promise<void>;
  dispatch: Mock;
  runInterruptLadder: Mock;
  submit: Mock;
  commitPaste: Mock;
  openProjectPicker: Mock;
  loadLiveSessions: Mock;
  openStatuslinePicker: Mock;
  setDraft: Mock;
  cancelNextStepsCountdown: Mock;
  refs: {
    lastEscAtRef: { current: number };
    draftRef: { current: { buffer: string; cursor: number } };
    pasteAccumRef: { current: unknown };
  };
}

export function makeHandler(
  state: State,
  draft: { buffer: string; cursor: number } = { buffer: '', cursor: 0 },
  overrides: Partial<Parameters<typeof createAppKeyHandler>[0]> = {},
): KeyHandlerFixture {
  const dispatch = vi.fn();
  const runInterruptLadder = vi.fn();
  const submit = vi.fn();
  const commitPaste = vi.fn(async () => {});
  const openProjectPicker = vi.fn(async () => {});
  const loadLiveSessions = vi.fn(async () => {});
  const openStatuslinePicker = vi.fn();
  const setDraft = vi.fn();
  const cancelNextStepsCountdown = vi.fn();
  const lastEscAtRef = { current: 0 };
  const draftRef = { current: { ...draft } };
  const pasteAccumRef = { current: null as unknown };

  const options = {
    state,
    dispatch,
    historyScrollRef: { current: null },
    runInterruptLadder,
    enhanceCancelledRef: { current: false },
    enhanceAbortRef: { current: null },
    inputGateRef: { current: false },
    lastEscAtRef,
    pasteAccumRef,
    pasteFlushTimerRef: { current: null },
    commitPaste,
    tryPickerKey: vi.fn(() => false),
    dismissedEscAtRef: { current: 0 },
    streamingTextRef: { current: '' },
    confirmExitRef: { current: false },
    activeCtrlRef: { current: null },
    clearPendingConfirms: vi.fn(),
    liveDirector: vi.fn(() => null),
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    statuslineHiddenItems: [],
    getSddRun: vi.fn(() => undefined),
    onSddLifecycle: undefined,
    getSettings: vi.fn(() => undefined),
    saveSettings: vi.fn(async () => null),
    lastEnterAtRef: { current: 0 },
    draftRef,
    setDraft,
    submit,
    mouseMode: false,
    termRows: 40,
    terminalColumns: 120,
    terminalRows: 40,
    mainColumnWidth: 0,
    overlayOpen: false,
    effectiveSwarmOnSidebar: false,
    sidebarTwinRowCount: 0,
    statusBarWrapRef: { current: null },
    belowStatusBarRef: { current: null },
    statusBarClickMapRef: { current: null },
    openModelPicker: vi.fn(async () => {}),
    nextStepsAutoSubmitTimerRef: { current: undefined },
    nextStepsAutoSubmitSuggestionRef: { current: null },
    nextStepsAutoSubmitLabel: null,
    setNextStepsAutoSubmitCountdown: vi.fn(),
    setNextStepsAutoSubmitLabel: vi.fn(),
    cancelNextStepsCountdown,
    pasteClipboardText: vi.fn(async () => {}),
    pasteClipboardImage: vi.fn(async () => {}),
    slashRegistry: {} as never,
    agent: { ctx: {} } as never,
    onHistoryCopy: undefined,
  };

  // One deliberate cast: the corpus pins routing, not option plumbing.
  const handler = createAppKeyHandler({ ...options, ...overrides } as never as Parameters<
    typeof createAppKeyHandler
  >[0]);
  return {
    handler,
    dispatch,
    runInterruptLadder,
    submit,
    commitPaste,
    openProjectPicker,
    loadLiveSessions,
    openStatuslinePicker,
    setDraft,
    cancelNextStepsCountdown,
    refs: { lastEscAtRef, draftRef, pasteAccumRef },
  };
}
