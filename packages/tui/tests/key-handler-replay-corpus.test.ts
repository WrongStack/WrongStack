// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createAppKeyHandler } from '../src/app-key-handler.js';
import type { State } from '../src/app-state.js';
import type { KeyEvent } from '../src/components/input.js';
import { createRunningState, createTestState } from './helpers/create-test-state.js';

/**
 * TUI decomposition Phase 0.3 (docs/decomposition-plan.md, decision D3):
 * characterization corpus for `createAppKeyHandler`. Each case drives the
 * CURRENT handler with representative (input, key, state) tuples and
 * snapshots the observable trace — dispatched action types in order plus
 * host-callback flags. Phase 3's route extraction is accepted only when
 * every trace is identical.
 *
 * Options are stubbed with one deliberate cast: the corpus pins the handler's
 * ROUTING behavior, not its option plumbing (which app.tsx owns). The stubs
 * return inert values so every route branch is reachable and deterministic.
 */

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

function key(overrides: KeyOverrides = {}): KeyEvent {
  return { ...NO_KEY, ...overrides };
}

interface Step {
  input: string;
  key: KeyEvent;
}

interface CorpusCase {
  /** Snapshot name — must stay stable across Phase 3. */
  name: string;
  makeState: () => State;
  /** Tweaks applied to the handler's mutable refs before the first step. */
  refs?: (refs: {
    lastEscAtRef: { current: number };
    draftRef: { current: { buffer: string; cursor: number } };
    pasteAccumRef: { current: unknown };
  }) => void;
  draft?: { buffer: string; cursor: number };
  steps: Step[];
}

function makeHandler(
  state: State,
  draft: { buffer: string; cursor: number } = { buffer: '', cursor: 0 },
) {
  const dispatch = vi.fn();
  const runInterruptLadder = vi.fn();
  const submit = vi.fn();
  const commitPaste = vi.fn(async () => {});
  const openProjectPicker = vi.fn(async () => {});
  const loadLiveSessions = vi.fn(async () => {});
  const openStatuslinePicker = vi.fn();
  const setDraft = vi.fn();
  const lastEscAtRef = { current: 0 };
  const draftRef = { current: { ...draft } };
  const pasteAccumRef = { current: null as unknown };

  const options = {
    state,
    dispatch,
    historyScrollRef: { current: null },
    onHistoryScrollActivity: vi.fn(),
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
    cancelNextStepsCountdown: vi.fn(),
    pasteClipboardText: vi.fn(async () => {}),
    pasteClipboardImage: vi.fn(async () => {}),
    slashRegistry: {} as never,
    agent: { ctx: {} } as never,
    onHistoryCopy: undefined,
  };

  // One deliberate cast: the corpus pins routing, not option plumbing.
  const handler = createAppKeyHandler(
    options as never as Parameters<typeof createAppKeyHandler>[0],
  );
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
    refs: { lastEscAtRef, draftRef, pasteAccumRef },
  };
}

const CASES: CorpusCase[] = [
  {
    name: 'ctrl+c escalates the interrupt ladder before any other route',
    makeState: () => createRunningState(),
    steps: [{ input: 'c', key: key({ ctrl: true }) }],
  },
  {
    name: 'plain character lands in the composer buffer',
    makeState: () => createTestState(),
    steps: [{ input: 'x', key: key() }],
  },
  {
    name: 'backspace deletes the last buffered character',
    makeState: () => createTestState({ buffer: 'ab', cursor: 2 }),
    draft: { buffer: 'ab', cursor: 2 },
    steps: [{ input: '', key: key({ backspace: true }) }],
  },
  {
    name: 'enter submits the composer draft',
    makeState: () => createTestState({ buffer: 'hi', cursor: 2 }),
    draft: { buffer: 'hi', cursor: 2 },
    steps: [{ input: '', key: key({ return: true }) }],
  },
  {
    name: 'stray newline from crlf terminals normalizes to enter',
    makeState: () => createTestState({ buffer: 'hi', cursor: 2 }),
    draft: { buffer: 'hi', cursor: 2 },
    steps: [{ input: '\n', key: key({ return: false }) }],
  },
  {
    name: 'single esc with empty buffer only arms the double-esc window',
    makeState: () => createTestState(),
    steps: [{ input: '', key: key({ escape: true }) }],
  },
  {
    name: 'double esc inside the window clears the buffer',
    makeState: () => createTestState({ buffer: 'ab', cursor: 2 }),
    draft: { buffer: 'ab', cursor: 2 },
    refs: (r) => {
      r.lastEscAtRef.current = Date.now();
    },
    steps: [{ input: '', key: key({ escape: true }) }],
  },
  {
    name: 'esc exits bash mode instead of touching the interrupt ladder',
    makeState: () => createTestState({ bashMode: true }),
    steps: [{ input: '', key: key({ escape: true }) }],
  },
  {
    name: 'esc with an open sessions panel routes the panel close',
    makeState: () => createTestState({ sessionsPanelOpen: true }),
    steps: [{ input: '', key: key({ escape: true }) }],
  },
  {
    name: 'bracketed paste accumulates and commits on the end marker',
    makeState: () => createTestState(),
    steps: [
      { input: '\x1b[200~', key: key() },
      { input: 'hello', key: key() },
      { input: '\x1b[201~', key: key() },
    ],
  },
  {
    name: 'F2 toggles the fleet monitor overlay',
    makeState: () => createTestState(),
    steps: [{ input: '', key: key({ fn: 2 }) }],
  },
  {
    name: 'ctrl+b opens the sdd board monitor',
    makeState: () => createTestState(),
    steps: [{ input: 'b', key: key({ ctrl: true }) }],
  },
  {
    name: 'ctrl+y toggles the kanban panel',
    makeState: () => createTestState(),
    steps: [{ input: 'y', key: key({ ctrl: true }) }],
  },
  {
    name: 'slash at buffer start opens the command picker',
    makeState: () => createTestState(),
    steps: [{ input: '/', key: key() }],
  },
  {
    name: '@ opens the file picker',
    makeState: () => createTestState(),
    steps: [{ input: '@', key: key() }],
  },
  {
    name: 'question mark on an empty draft opens help',
    makeState: () => createTestState(),
    steps: [{ input: '?', key: key() }],
  },
  {
    name: 'upArrow on an empty buffer recalls input history',
    makeState: () => createTestState(),
    steps: [{ input: '', key: key({ upArrow: true }) }],
  },
  {
    name: 'shift+tab on an empty draft toggles sidebar focus',
    makeState: () => createTestState(),
    steps: [{ input: '', key: key({ shift: true, tab: true }) }],
  },
  {
    name: 'pageUp pages the chat history viewport',
    makeState: () => createTestState(),
    steps: [{ input: '', key: key({ pageUp: true }) }],
  },
  {
    name: 'wheel up in mouse mode scrolls the history viewport',
    makeState: () => createTestState({ viewportRows: 20 }),
    steps: [{ input: '', key: key({ wheelDeltaY: 1 }) }],
  },
];

describe('createAppKeyHandler replay corpus (decomposition Phase 0.3)', () => {
  for (const corpusCase of CASES) {
    it(corpusCase.name, async () => {
      const state = corpusCase.makeState();
      const draft = corpusCase.draft ?? { buffer: state.buffer, cursor: state.cursor };
      const harness = makeHandler(state, draft);
      corpusCase.refs?.(harness.refs);

      const trace = {
        dispatch: [] as string[],
        ladder: 0,
        submit: 0,
        commitPaste: 0,
        openProjectPicker: 0,
        loadLiveSessions: 0,
        openStatuslinePicker: 0,
        setDraft: 0,
        setDraftBuffer: null as string | null,
      };

      for (const step of corpusCase.steps) {
        await harness.handler(step.input, step.key);
        for (const call of harness.dispatch.mock.calls) {
          const action = call[0] as { type: string };
          if (!trace.dispatch.includes(action.type)) trace.dispatch.push(action.type);
        }
        harness.dispatch.mockClear();
      }

      trace.ladder = harness.runInterruptLadder.mock.calls.length;
      trace.submit = harness.submit.mock.calls.length;
      trace.commitPaste = harness.commitPaste.mock.calls.length;
      trace.openProjectPicker = harness.openProjectPicker.mock.calls.length;
      trace.loadLiveSessions = harness.loadLiveSessions.mock.calls.length;
      trace.openStatuslinePicker = harness.openStatuslinePicker.mock.calls.length;
      trace.setDraft = harness.setDraft.mock.calls.length;
      const lastDraftCall = harness.setDraft.mock.calls.at(-1) as
        | [string, number]
        | undefined;
      trace.setDraftBuffer = lastDraftCall ? lastDraftCall[0] : null;

      expect(trace).toMatchSnapshot();
    });
  }
});
