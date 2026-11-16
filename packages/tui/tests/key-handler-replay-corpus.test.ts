// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { State } from '../src/app-state.js';
import type { KeyEvent } from '../src/components/input.js';
import type { MouseEventInfo } from '../src/mouse.js';
import { createRunningState, createTestState } from './helpers/create-test-state.js';
import { key, makeHandler } from './helpers/key-handler-fixture.js';

/**
 * TUI decomposition Phase 0.3 (docs/decomposition-plan.md, decision D3):
 * characterization corpus for `createAppKeyHandler`. Each case drives the
 * CURRENT handler with representative (input, key, state) tuples and
 * snapshots the observable trace — dispatched action types in order plus
 * host-callback flags. Phase 3's route extraction is accepted only when
 * every trace is identical.
 *
 * The handler host (option plumbing + event helper) lives in
 * `tests/helpers/key-handler-fixture.ts`, shared with the raw-byte-path suite
 * so both halves of the input chain drive one identical host. The stubs return
 * inert values so every route branch is reachable and deterministic.
 */

interface Step {
  input: string;
  key: KeyEvent;
}

it('submits the current draft when typing and Enter arrive before React commits', async () => {
  const h = makeHandler(createTestState({ buffer: 'previous render' }), {
    buffer: 'complete current draft',
    cursor: 22,
  });
  await h.handler('', key({ return: true }));
  expect(h.submit).toHaveBeenCalledWith('complete current draft');
});

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

it('navigates wrapped input at the main-column width when the sidebar is open', async () => {
  const buffer = 'a'.repeat(100);
  const h = makeHandler(
    createTestState(),
    { buffer, cursor: 5 },
    {
      terminalColumns: 120,
      mainColumnWidth: 60,
    },
  );
  await h.handler('', key({ downArrow: true }));
  expect(h.setDraft).toHaveBeenCalledWith(buffer, 61);
  expect(h.dispatch).not.toHaveBeenCalledWith({ type: 'historyDown' });
});

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
      const lastDraftCall = harness.setDraft.mock.calls.at(-1) as [string, number] | undefined;
      trace.setDraftBuffer = lastDraftCall ? lastDraftCall[0] : null;

      expect(trace).toMatchSnapshot();
    });
  }
});

describe('Escape ownership', () => {
  it('closes a panel before an already armed double-Escape can erase the draft', async () => {
    const fixture = makeHandler(
      createTestState({ sessionsPanelOpen: true, buffer: 'keep', cursor: 4 }),
      { buffer: 'keep', cursor: 4 },
    );
    fixture.refs.lastEscAtRef.current = Date.now();
    await fixture.handler('', key({ escape: true }));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'toggleSessionsPanel' });
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: 'clearInput' });
    expect(fixture.refs.lastEscAtRef.current).toBe(0);
  });

  it('closes the /mailbox panel (hook-owned state) instead of interrupting the run', async () => {
    const closeMailboxPanel = vi.fn();
    const fixture = makeHandler(createRunningState(), undefined, { closeMailboxPanel });
    await fixture.handler('', key({ escape: true }));
    expect(closeMailboxPanel).toHaveBeenCalledOnce();
    expect(fixture.runInterruptLadder).not.toHaveBeenCalled();
    expect(fixture.refs.lastEscAtRef.current).toBe(0);
  });

  it('does not interpret Esc, typing, Esc as a double press', async () => {
    const fixture = makeHandler(createTestState({ buffer: 'keep', cursor: 4 }), {
      buffer: 'keep',
      cursor: 4,
    });
    await fixture.handler('', key({ escape: true }));
    await fixture.handler('x', key());
    await fixture.handler('', key({ escape: true }));
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: 'clearInput' });
  });
});

describe('function panel keyboard ownership', () => {
  const panels: [number, Partial<State>][] = [
    [1, { projectPicker: { ...createTestState().projectPicker, open: true } }],
    [2, { monitorOpen: true }],
    [3, { agentsMonitorOpen: true }],
    [4, { worktreeMonitorOpen: true }],
    [5, { planPanelOpen: true }],
    [6, { todosMonitorOpen: true }],
    [7, { queuePanelOpen: true }],
    [8, { processListOpen: true }],
    [9, { goalPanelOpen: true }],
    [10, { sessionsPanelOpen: true }],
    [11, { coordinator: { ...createTestState().coordinator, monitorOpen: true } }],
    [12, { kanbanPanelOpen: true }],
  ];
  it.each(panels)('F%i preserves a hidden draft and does not submit it', async (_fn, flags) => {
    const fixture = makeHandler(createTestState({ ...flags, buffer: 'keep me', cursor: 7 }), {
      buffer: 'keep me',
      cursor: 7,
    });
    for (const [input, event] of [
      ['d', key()],
      ['', key({ backspace: true })],
      ['', key({ return: true })],
    ] as const) {
      await fixture.handler(input, event);
    }
    expect(fixture.setDraft).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });
  it.each([1, 10])('F%i does not swallow the next F-key through picker routing', async (fn) => {
    const flags = panels.find(([candidate]) => candidate === fn)![1];
    const fixture = makeHandler(createTestState(flags), undefined, { tryPickerKey: () => true });
    await fixture.handler('', key({ fn: 6 }));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'toggleTodosMonitor' });
  });
});

describe('sidebar panel and pointer cancellation ownership', () => {
  it.each([
    ['worktreeMonitorOpen', 'worktree', 'toggleWorktreeMonitor'],
    ['kanbanPanelOpen', 'kanban', 'toggleKanbanPanel'],
  ] as const)(
    'Esc closes %s when its keyboard-owning bottom component is unmounted',
    async (flag, panelId, action) => {
      const settings = createTestState().settingsPicker;
      const fixture = makeHandler(createTestState({ [flag]: true }), undefined, {
        getSettings: () => ({
          ...settings,
          fleetChatVerbosity: 'full',
          featureTokenSaving: 'off',
          panelPositions: { ...settings.panelPositions, [panelId]: 'sidebar' },
        }),
      });
      await fixture.handler('', key({ escape: true }));
      expect(fixture.dispatch).toHaveBeenCalledWith({ type: action });
      expect(fixture.runInterruptLadder).not.toHaveBeenCalled();
    },
  );

  it('right-click goes through the picker Escape lifecycle before a fallback close', async () => {
    const tryPickerKey = vi.fn(() => true);
    const fixture = makeHandler(
      createTestState({ authPanel: { ...createTestState().authPanel, open: true } }),
      undefined,
      { tryPickerKey },
    );
    await fixture.handler(
      '',
      key({
        mouse: {
          kind: 'press',
          button: 'right',
          x: 5,
          y: 30,
          wheel: 0,
          shift: false,
          meta: false,
          ctrl: false,
          motion: false,
        },
      }),
    );
    expect(tryPickerKey).toHaveBeenCalledWith('', expect.objectContaining({ escape: true }), false);
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: 'authClose' });
  });
});

describe('operational panel composer ownership', () => {
  it.each([
    'cronMonitorOpen',
    'connectionsPanelOpen',
    'contextPanelOpen',
    'goalKanbanPanelOpen',
  ] as const)('%s cannot also edit or submit the composer', async (flag) => {
    const fixture = makeHandler(createTestState({ [flag]: true, buffer: 'preserve', cursor: 8 }), {
      buffer: 'preserve',
      cursor: 8,
    });
    await fixture.handler('x', key());
    await fixture.handler('', key({ return: true }));
    expect(fixture.setDraft).not.toHaveBeenCalled();
    expect(fixture.submit).not.toHaveBeenCalled();
  });
});

/**
 * The input layer delivers SGR mouse reports as `KeyEvent`s carrying `mouse`
 * (components/input.tsx builds them as EMPTY_KEY + mouse). The handler used to
 * treat every event as a user takeover, so a click, a wheel scroll, or a drag
 * through the transcript silently killed the armed next-steps countdown and the
 * automatic turn never advanced. Pointer reports are navigation, not typing.
 *
 * Transcript/caret navigation on the keyboard is the same case: PgUp/PgDn
 * page the managed history viewport and Home/End/←/→ move a caret that has
 * nothing to move. On an EMPTY composer none of them can change what the armed
 * submit would do, so they must not cancel either. Text in the composer is the
 * line: the armed submit calls `clearDraft()` when it fires, so any event at
 * all — including a pointer report — is a takeover once a draft exists.
 */
describe('next-steps countdown ownership', () => {
  function mouse(
    report: Pick<MouseEventInfo, 'kind' | 'button'> & Partial<MouseEventInfo>,
  ): MouseEventInfo {
    return {
      x: 10,
      y: 5,
      wheel: 0,
      shift: false,
      meta: false,
      ctrl: false,
      motion: false,
      ...report,
    };
  }

  /** Keys that only move through the transcript or the caret. */
  const NAVIGATION: [name: string, overrides: Partial<KeyEvent>, input: string][] = [
    ['PageUp', { pageUp: true }, ''],
    ['PageDown', { pageDown: true }, ''],
    ['left arrow', { leftArrow: true }, ''],
    ['right arrow', { rightArrow: true }, ''],
    ['Home', { home: true }, ''],
    ['End', { end: true }, ''],
    ['Ctrl+U paging', { ctrl: true }, 'u'],
    ['Ctrl+D paging', { ctrl: true }, 'd'],
  ];

  it.each([
    ['left press', mouse({ kind: 'press', button: 'left' })],
    ['left release', mouse({ kind: 'release', button: 'left' })],
    ['right press', mouse({ kind: 'press', button: 'right' })],
    ['drag motion', mouse({ kind: 'move', button: 'left', motion: true })],
    ['wheel up', mouse({ kind: 'wheel', button: 'none', wheel: 1 })],
    ['wheel down', mouse({ kind: 'wheel', button: 'none', wheel: -1 })],
  ])('%s does not cancel the armed automatic turn', async (_name, report) => {
    const fixture = makeHandler(createTestState());

    await fixture.handler('', key({ mouse: report, wheelDeltaY: report.wheel }));

    expect(fixture.cancelNextStepsCountdown).not.toHaveBeenCalled();
  });

  it.each(NAVIGATION)(
    '%s over an empty composer leaves the armed automatic turn running',
    async (_name, overrides, input) => {
      const fixture = makeHandler(createTestState());

      await fixture.handler(input, key(overrides));

      expect(fixture.cancelNextStepsCountdown).not.toHaveBeenCalled();
    },
  );

  it.each(NAVIGATION)(
    '%s over a non-empty composer still cancels: the armed submit clears the draft',
    async (_name, overrides, input) => {
      const draft = { buffer: 'half typed', cursor: 10 };
      const fixture = makeHandler(createTestState(draft), draft);

      await fixture.handler(input, key(overrides));

      expect(fixture.cancelNextStepsCountdown).toHaveBeenCalled();
    },
  );

  // ↑/↓ are NOT navigation here: with an empty composer they recall input
  // history into the draft (input-key-router historyUp/historyDown), which is
  // exactly the text the armed submit would destroy.
  it.each([
    ['Up arrow', { upArrow: true }],
    ['Down arrow', { downArrow: true }],
  ] as const)('%s still cancels an empty-composer countdown', async (_name, overrides) => {
    const fixture = makeHandler(createTestState());

    await fixture.handler('', key(overrides));

    expect(fixture.cancelNextStepsCountdown).toHaveBeenCalled();
  });

  it('a typed character still cancels the armed automatic turn', async () => {
    const fixture = makeHandler(createTestState());

    await fixture.handler('x', key());

    // Twice by design: this handler's takeover guard plus the composer's own
    // text-insertion cancel in input-key-router (routeInputKey).
    expect(fixture.cancelNextStepsCountdown).toHaveBeenCalled();
  });
});
