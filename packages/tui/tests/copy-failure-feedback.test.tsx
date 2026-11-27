/**
 * Failed clipboard writes must reach the user (silent-copy defect).
 *
 * Pins the full feedback chain for every TUI copy path:
 *  1. Real HistoryScrollController — `commitSelection` / `copyAtViewportCell`
 *     report an actual WRITE failure through the optional `onCopyFailure`
 *     callback (with a message naming the size limit when over-cap), while
 *     no-op commits (no selection / empty text / missed target) stay silent
 *     and the boolean / entry-id return contracts are unchanged.
 *  2. Pointer routes — `routePointerEvents` wires that callback to a warn
 *     transcript entry for the copy icon, the release-commits-copy gesture,
 *     and the right-press fallback.
 *  3. Inspect overlay — `routeModalOverlay`'s Copy action dispatches a warn
 *     entry on failure instead of doing nothing.
 *  4. Composer pointer — the transient notice distinguishes "too large for
 *     terminal clipboard" from "no clipboard available".
 */

import { writeClipboardText } from '@wrongstack/runtime/clipboard';
import { render } from 'ink-testing-library';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../src/components/history.js';
import type { KeyEvent } from '../src/components/input.js';
import {
  type HistoryScrollController,
  ScrollableHistory,
} from '../src/components/scrollable-history.js';
import { SCROLLBAR_HIT_WIDTH } from '../src/hit-test.js';
import { useComposerPointer } from '../src/hooks/use-composer-pointer.js';
import type { DOMElement } from '../src/ink.js';
import { Text } from '../src/ink.js';
import type { KeyRouteContext } from '../src/key-handler-context.js';
import { routeModalOverlay } from '../src/key-routes/key-route-overlay.js';
import { routePointerEvents } from '../src/key-routes/key-route-pointer.js';
import type { MouseEventInfo } from '../src/mouse.js';
import { createTestState } from './helpers/create-test-state.js';

vi.mock('@wrongstack/runtime/clipboard', () => ({
  writeClipboardText: vi.fn(async () => true),
  readClipboardText: vi.fn(async () => ''),
  readClipboardImage: vi.fn(async () => null),
}));

// ink-testing-library does not run Yoga layout; give hit-testing a
// deterministic measurement (same approach as drag-selection-copy.test.tsx).
// The inspect-overlay header hit-test also reads this: width 120 at (0,0)
// puts [Copy] at columns 107..112 of row 1.
vi.mock('../src/ink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ink.js')>();
  return {
    ...actual,
    measureElement: vi.fn(() => ({ width: 120, height: 1, x: 0, y: 0 })),
  };
});

// Composer-pointer geometry without a real mounted composer.
const composerPayload = vi.hoisted(() => ({ text: 'hello' }));
vi.mock('../src/cell-selection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cell-selection.js')>();
  return {
    ...actual,
    screenOrigin: () => ({ x: 0, y: 0 }),
    selectionText: () => composerPayload.text,
  };
});

const nativeMock = writeClipboardText as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  nativeMock.mockReset();
  nativeMock.mockResolvedValue(true);
  composerPayload.text = 'hello';
  vi.restoreAllMocks();
});

/** Run `fn` with process.stdout pretending to be a TTY (OSC 52 reachable). */
async function withTty<T>(fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    return await fn();
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'isTTY', desc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

// ── 1. Real controller: failure callback vs silent no-ops ─────────────

function mountHistory(entries: readonly HistoryEntry[]): {
  controller: HistoryScrollController;
  copyIconCol: number;
  unmount: () => void;
} {
  const controllerRef: { current: HistoryScrollController | null } = { current: null };
  const element = (
    <ScrollableHistory
      entries={[...entries]}
      viewportRows={1}
      controllerRef={controllerRef}
      maxWidth={120}
      autonomyMode="off"
      multiDiffSummaryThreshold={5}
    />
  );
  const app = render(element);
  app.rerender(element);
  if (controllerRef.current === null) throw new Error('controllerRef not populated');
  return {
    controller: controllerRef.current,
    copyIconCol: Math.min(app.stdout.columns, 120) - SCROLLBAR_HIT_WIDTH,
    unmount: () => app.unmount(),
  };
}

describe('history controller copy failure feedback', () => {
  it('commitSelection reports a write failure through onCopyFailure and still returns false', async () => {
    nativeMock.mockResolvedValue(false);
    const h = mountHistory([{ id: 1, kind: 'assistant', text: 'alpha bravo charlie' }]);
    try {
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      const failures: string[] = [];
      expect(await h.controller.commitSelection((m) => failures.push(m))).toBe(false);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/Copy failed/);
    } finally {
      h.unmount();
    }
  });

  it('commitSelection names the size limit when the payload is over the OSC 52 cap', async () => {
    nativeMock.mockResolvedValue(false);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const h = mountHistory([{ id: 1, kind: 'assistant', text: 'x'.repeat(80_000) }]);
    try {
      await withTty(async () => {
        h.controller.beginSelection(0, 0);
        h.controller.extendSelection(0, 4);
        const failures: string[] = [];
        expect(await h.controller.commitSelection((m) => failures.push(m))).toBe(false);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/size limit/);
        // Over-cap text is never chunked into partial OSC 52 writes.
        expect(writeSpy).not.toHaveBeenCalled();
      });
    } finally {
      h.unmount();
    }
  });

  it('no-op commits stay silent: no selection, degenerate drag, empty text', async () => {
    nativeMock.mockResolvedValue(false);
    const h = mountHistory([{ id: 1, kind: 'assistant', text: 'alpha' }]);
    try {
      const failures: string[] = [];
      const cb = (m: string): void => {
        failures.push(m);
      };
      // No begun selection.
      expect(await h.controller.commitSelection(cb)).toBe(false);
      // Degenerate press without motion.
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 0);
      expect(await h.controller.commitSelection(cb)).toBe(false);
      expect(failures).toEqual([]);
      expect(nativeMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('copyAtViewportCell reports a write failure but keeps the null-on-miss contract', async () => {
    const h = mountHistory([{ id: 1, kind: 'user', text: 'alpha bravo charlie' }]);
    try {
      // Success: entry id returned, no failure callback.
      const noFailures: string[] = [];
      expect(
        await h.controller.copyAtViewportCell(0, h.copyIconCol, (m) => noFailures.push(m)),
      ).toBe(1);
      expect(noFailures).toEqual([]);

      // Write failure: null AND a failure message.
      nativeMock.mockResolvedValue(false);
      const failures: string[] = [];
      expect(
        await h.controller.copyAtViewportCell(0, h.copyIconCol, (m) => failures.push(m)),
      ).toBeNull();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/Copy failed/);

      // Missed target: null, silent.
      const missFailures: string[] = [];
      expect(await h.controller.copyAtViewportCell(0, 0, (m) => missFailures.push(m))).toBeNull();
      expect(missFailures).toEqual([]);
    } finally {
      h.unmount();
    }
  });

  it('successful commitSelection returns true without invoking the failure callback', async () => {
    const h = mountHistory([{ id: 1, kind: 'assistant', text: 'alpha bravo charlie' }]);
    try {
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      const failures: string[] = [];
      expect(await h.controller.commitSelection((m) => failures.push(m))).toBe(true);
      expect(failures).toEqual([]);
      expect(nativeMock).toHaveBeenCalledWith('alpha bravo charlie');
    } finally {
      h.unmount();
    }
  });
});

// ── 2. Pointer routes wire the callback to a warn transcript entry ────

function pointerCtx(controller: Partial<HistoryScrollController>): {
  ctx: KeyRouteContext;
  dispatch: ReturnType<typeof vi.fn>;
  onHistoryCopy: ReturnType<typeof vi.fn>;
  detached: Promise<unknown>[];
} {
  const dispatch = vi.fn();
  const onHistoryCopy = vi.fn();
  const detached: Promise<unknown>[] = [];
  const ctx = {
    state: createTestState({ viewportRows: 20 }),
    dispatch,
    draftRef: { current: { buffer: '', cursor: 0 } },
    overlayOpen: false,
    stdout: { columns: 80, rows: 24 },
    termRows: 24,
    historyWidth: 80,
    sidebarTwinRowCount: 0,
    effectiveSwarmOnSidebar: false,
    mouseMode: false,
    historyScrollRef: { current: controller as HistoryScrollController },
    onHistoryCopy,
    statusBarWrapRef: { current: null },
    belowStatusBarRef: { current: null },
    statusBarClickMapRef: { current: null },
    openModelPicker: vi.fn(),
    openStatuslinePicker: vi.fn(),
    detach: (work: Promise<unknown> | undefined) => {
      if (work) detached.push(work);
    },
  } as unknown as KeyRouteContext;
  return { ctx, dispatch, onHistoryCopy, detached };
}

const mouseKey = (kind: 'press' | 'release', button: 'left' | 'right', x: number, y: number) =>
  ({ mouse: { kind, button, x, y, wheel: 0, shift: false } }) as unknown as KeyEvent;

describe('routePointerEvents copy failure feedback', () => {
  it('release-commits-copy dispatches a warn entry when the write fails', async () => {
    const commitSelection = vi.fn(async (onFailure?: (m: string) => void) => {
      onFailure?.('Copy failed: no system clipboard tool is available.');
      return false;
    });
    const { ctx, dispatch, onHistoryCopy, detached } = pointerCtx({
      hasSelection: () => true,
      extendSelection: vi.fn(),
      commitSelection,
    });
    await routePointerEvents(ctx, '', mouseKey('release', 'left', 5, 2));
    await Promise.all(detached);
    expect(commitSelection).toHaveBeenCalledWith(expect.any(Function));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'warn', text: 'Copy failed: no system clipboard tool is available.' },
    });
    expect(onHistoryCopy).not.toHaveBeenCalled();
  });

  it('right-press fallback dispatches a warn entry when the write fails', async () => {
    const commitSelection = vi.fn(async (onFailure?: (m: string) => void) => {
      onFailure?.('Copy failed: over the size limit.');
      return false;
    });
    const { ctx, dispatch, detached } = pointerCtx({
      commitSelection,
      clearSelection: vi.fn(),
    });
    await routePointerEvents(ctx, '', mouseKey('press', 'right', 5, 1));
    await Promise.all(detached);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'warn', text: 'Copy failed: over the size limit.' },
    });
  });

  it('copy-icon click dispatches a warn entry when the write fails', async () => {
    const copyAtViewportCell = vi.fn(
      async (_row: number, _col: number, onFailure?: (m: string) => void) => {
        onFailure?.('Copy failed: no system clipboard tool is available.');
        return null;
      },
    );
    const { ctx, dispatch, onHistoryCopy } = pointerCtx({
      hasInspectTargetAt: () => false,
      hasCopyTargetAt: () => true,
      copyAtViewportCell,
      clearSelection: vi.fn(),
    });
    await routePointerEvents(ctx, '', mouseKey('press', 'left', 5, 1));
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Copy failed: no system clipboard tool is available.' },
      });
    });
    expect(copyAtViewportCell).toHaveBeenCalledWith(0, 4, expect.any(Function));
    expect(onHistoryCopy).not.toHaveBeenCalled();
  });

  it('successful copies keep the transient confirmation and dispatch no warn', async () => {
    const commitSelection = vi.fn(async () => true);
    const { ctx, dispatch, onHistoryCopy, detached } = pointerCtx({
      hasSelection: () => true,
      extendSelection: vi.fn(),
      commitSelection,
    });
    await routePointerEvents(ctx, '', mouseKey('release', 'left', 5, 2));
    await Promise.all(detached);
    expect(onHistoryCopy).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'addEntry' }));
  });
});

// ── 3. Inspect overlay Copy surfaces failures ─────────────────────────

function overlayCtx(): {
  ctx: KeyRouteContext;
  dispatch: ReturnType<typeof vi.fn>;
  onHistoryCopy: ReturnType<typeof vi.fn>;
  detached: Promise<unknown>[];
} {
  const dispatch = vi.fn();
  const onHistoryCopy = vi.fn();
  const detached: Promise<unknown>[] = [];
  const ctx = {
    state: createTestState({
      inspectOverlay: { entryId: 1, scroll: 0 },
      entries: [{ id: 1, kind: 'assistant', text: 'inspect body' }],
    }),
    dispatch,
    enhanceCancelledRef: { current: false },
    enhanceAbortRef: { current: null },
    inspectOverlayHeaderRef: { current: {} as DOMElement },
    onHistoryCopy,
    detach: (work: Promise<unknown> | undefined) => {
      if (work) detached.push(work);
    },
  } as unknown as KeyRouteContext;
  return { ctx, dispatch, onHistoryCopy, detached };
}

describe('inspect overlay copy failure feedback', () => {
  // measureElement mock: header width 120 at row 1 → [Copy] spans cols 107..112.
  const copyClick = {
    mouse: { kind: 'press', button: 'left', x: 110, y: 1 },
  } as unknown as KeyEvent;

  it('dispatches a warn entry when the clipboard write fails', async () => {
    nativeMock.mockResolvedValue(false);
    const { ctx, dispatch, onHistoryCopy, detached } = overlayCtx();
    expect(routeModalOverlay(ctx, '', copyClick)).toBe(true);
    await Promise.all(detached);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: { kind: 'warn', text: expect.stringMatching(/Copy failed/) },
    });
    expect(onHistoryCopy).not.toHaveBeenCalled();
  });

  it('keeps the success confirmation when the write succeeds', async () => {
    const { ctx, dispatch, onHistoryCopy, detached } = overlayCtx();
    expect(routeModalOverlay(ctx, '', copyClick)).toBe(true);
    await Promise.all(detached);
    expect(onHistoryCopy).toHaveBeenCalledWith(1);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'addEntry' }));
  });
});

// ── 4. Composer pointer notice is accurate ────────────────────────────

const composerModel = {
  node: {} as DOMElement,
  runs: [],
  width: 40,
  rows: 3,
  hidden: false,
  disabled: false,
  value: 'v',
  scroll: 0,
  mode: 'block' as const,
};

function ComposerHarness({
  expose,
}: {
  expose: { current: ReturnType<typeof useComposerPointer> | null };
}): React.ReactElement {
  const pointer = useComposerPointer();
  pointer.model.current = composerModel;
  expose.current = pointer;
  return <Text>composer</Text>;
}

const composerMouse = (kind: 'press' | 'move' | 'release', x: number): MouseEventInfo =>
  ({
    kind,
    button: 'left',
    x,
    y: 2,
    wheel: 0,
    shift: false,
    meta: false,
    ctrl: false,
    motion: false,
  }) as MouseEventInfo;

/** Press → drag → release inside the mocked composer band. */
function dragCopy(pointer: ReturnType<typeof useComposerPointer>): void {
  pointer.handle(composerMouse('press', 5));
  pointer.handle(composerMouse('move', 10));
  pointer.handle(composerMouse('release', 10));
}

describe('composer pointer copy notice', () => {
  function mountComposer(): {
    expose: { current: ReturnType<typeof useComposerPointer> | null };
    unmount: () => void;
  } {
    const expose: { current: ReturnType<typeof useComposerPointer> | null } = { current: null };
    const app = render(<ComposerHarness expose={expose} />);
    if (expose.current === null) throw new Error('composer hook not exposed');
    return { expose, unmount: () => app.unmount() };
  }

  it('shows Copied on success', async () => {
    const { expose, unmount } = mountComposer();
    try {
      dragCopy(expose.current!);
      await vi.waitFor(() => expect(expose.current?.notice).toBe('Copied'));
    } finally {
      unmount();
    }
  });

  it('names the missing clipboard when no tool works and there is no TTY', async () => {
    nativeMock.mockResolvedValue(false);
    const { expose, unmount } = mountComposer();
    try {
      dragCopy(expose.current!);
      await vi.waitFor(() =>
        expect(expose.current?.notice).toBe('Copy failed: no clipboard available'),
      );
    } finally {
      unmount();
    }
  });

  it('names the size limit when the selection is over the OSC 52 cap', async () => {
    nativeMock.mockResolvedValue(false);
    composerPayload.text = 'x'.repeat(80_000);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { expose, unmount } = mountComposer();
    try {
      await withTty(async () => {
        dragCopy(expose.current!);
        await vi.waitFor(() =>
          expect(expose.current?.notice).toBe('Copy failed: too large for terminal clipboard'),
        );
        expect(writeSpy).not.toHaveBeenCalled();
      });
    } finally {
      unmount();
    }
  });
});
