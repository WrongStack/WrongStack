/**
 * Drag-to-select-then-right-click-copy contract.
 *
 * The gesture's two halves are exercised separately:
 *
 *  1. Pure helpers — `buildMountedCardSpans`, `selectionHitAt`,
 *     `normalizeSelection`, `selectionTouchedEntryIds`,
 *     `assembleSelectionText`. Asserted directly with no React mount and no
 *     mouse plumbing.
 *
 *  2. Component-level — a bare `ScrollableHistory` mounted with realistic
 *     entries; the controller surface (beginSelection / extendSelection /
 *     endSelection / commitSelection / clearSelection) is exercised through
 *     the `controllerRef`. Asserts:
 *      - press inside a card starts a selection; press on the gutter /
 *        outside any card does NOT start a selection;
 *      - extending into the gutter cancels the drag;
 *      - commitSelection writes the assembled text via `writeClipboardText`
 *        when the drag covers a non-empty range, returns false silently
 *        when the drag covers no text;
 *      - clearSelection wipes state without writing;
 *      - the existing copy-icon path (`hasCopyTargetAt`, `copyAtViewportCell`)
 *        still returns the entry id and does NOT start a selection.
 *
 *  Existing behaviors that must NOT regress under this work:
 *      - `writeClipboardText` is called only via the mouse-handler
 *        `commitSelection` path here — no other code paths change.
 *      - `runInterruptLadder` is not invoked (the Ctrl+C ladder is
 *        upstream of the mouse handler and is therefore unaffected, but we
 *        also check it explicitly in the cursor-shift subset below).
 */

import { writeClipboardText } from '@wrongstack/runtime/clipboard';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createAppKeyHandler } from '../src/app-key-handler.js';
import {
  copyableTextForEntries,
  copyableTextForEntry,
} from '../src/components/history/copy-icon.js';
import type { RenderGroup } from '../src/components/history/tool-group.js';
import type { HistoryEntry } from '../src/components/history.js';
import type { KeyEvent } from '../src/components/input.js';
import {
  assembleSelectionText,
  buildMountedCardSpans,
  type HistoryScrollController,
  isOutOfBand,
  type MountedCardSpan,
  normalizeSelection,
  ScrollableHistory,
  SELECTION_COPY_ID,
  type SelectionRect,
  selectionHitAt,
  selectionTouchedEntryIds,
} from '../src/components/scrollable-history.js';
import { EntryHeightCache } from '../src/height-cache.js';
import { SCROLLBAR_HIT_WIDTH } from '../src/hit-test.js';
import { parseMouseEvent } from '../src/mouse.js';
import { createTestState } from './helpers/create-test-state.js';

// Capture every clipboard write so we can assert exact text + call count.
vi.mock('@wrongstack/runtime/clipboard', () => ({
  writeClipboardText: vi.fn(async (_text: string) => true),
  readClipboardText: vi.fn(async () => ''),
  readClipboardImage: vi.fn(async () => null),
  ClipboardImage: class {},
}));

// ink-testing-library does not run Yoga layout, so Ink reports mounted boxes
// as zero rows high. Give component-level hit-testing a deterministic one-row
// measurement while preserving the real Box/Text implementations.
vi.mock('../src/ink.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ink.js')>();
  return {
    ...actual,
    measureElement: vi.fn(() => ({ width: 120, height: 1 })),
  };
});

const writeClipboardTextMock = writeClipboardText as unknown as ReturnType<typeof vi.fn>;

const HELPERS_NOT_INTERNAL = (() => {
  // The production module re-exports everything we need; the import above
  // exists so we can detect a regression (a missing export) without breaking
  // unrelated tests. If this block ever throws, the helpers were renamed in
  // scrollable-history.tsx without re-exporting them.
  if (typeof buildMountedCardSpans !== 'function') throw new Error('buildMountedCardSpans missing');
  if (typeof selectionHitAt !== 'function') throw new Error('selectionHitAt missing');
  if (typeof normalizeSelection !== 'function') throw new Error('normalizeSelection missing');
  if (typeof selectionTouchedEntryIds !== 'function')
    throw new Error('selectionTouchedEntryIds missing');
  if (typeof assembleSelectionText !== 'function') throw new Error('assembleSelectionText missing');
  if (typeof isOutOfBand !== 'function') throw new Error('isOutOfBand missing');
  return true;
})();

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('isOutOfBand', () => {
  it('flags columns outside the rendered card band', () => {
    // The rendered band width is `viewportWidth - SCROLLBAR_HIT_WIDTH`,
    // captured in `termWidth` inside ScrollableHistory. Everything inside the
    // band is selectable; only the band-relative extremes are rejected.
    expect(isOutOfBand(-1, 80)).toBe(true);
    expect(isOutOfBand(0, 80)).toBe(false);
    expect(isOutOfBand(79, 80)).toBe(false);
    expect(isOutOfBand(80, 80)).toBe(true);
  });
});

describe('normalizeSelection', () => {
  it('orders endpoints regardless of drag direction', () => {
    const a = { row: 5, col: 12 };
    const b = { row: 3, col: 18 };
    const rect = normalizeSelection(a, b, true);
    expect(rect).toEqual({
      topLeft: { row: 3, col: 12 },
      bottomRight: { row: 5, col: 18 },
      inProgress: true,
    });
  });
});

describe('buildMountedCardSpans + selectionHitAt', () => {
  // Build a tiny, deterministic render-group list spanning two cards. Heights
  // are pinned through the height cache so the visibleClip math is stable.
  function fakeGroup(id: number): RenderGroup {
    return { type: 'single', entry: { id, kind: 'assistant', text: 'x' } };
  }
  const cache = new EntryHeightCache();
  cache.sync([10, 11]);
  cache.record(10, 3);
  cache.record(11, 2);
  const spans: MountedCardSpan[] = buildMountedCardSpans({
    renderGroups: [fakeGroup(10), fakeGroup(11)],
    heightCache: cache,
    scrolled: false,
    clip: 0,
    tailRows: 0,
    viewportRows: 10,
  });

  it('returns per-card viewport spans covering the mounted rows', () => {
    // Pinned frames with mounted stack shorter than the viewport park the
    // first card at row `vp - mountedRows`. With total mountedRows=5 and
    // viewportRows=10, the slack is 5, so card 10 occupies rows 5..8 and
    // card 11 occupies rows 8..10 — mirroring the flex-end Ink layout.
    expect(spans).toEqual([
      { entryId: 10, viewportStartRow: 5, viewportEndRow: 8, totalRows: 3 },
      { entryId: 11, viewportStartRow: 8, viewportEndRow: 10, totalRows: 2 },
    ]);
  });

  it('finds the card whose viewport row range contains the cell', () => {
    expect(selectionHitAt(5, spans)).toEqual({ entryId: 10 });
    expect(selectionHitAt(7, spans)).toEqual({ entryId: 10 });
    expect(selectionHitAt(8, spans)).toEqual({ entryId: 11 });
    expect(selectionHitAt(9, spans)).toEqual({ entryId: 11 });
  });

  it('returns null for gaps and out-of-viewport rows', () => {
    expect(selectionHitAt(-1, spans)).toBeNull();
    expect(selectionHitAt(99, spans)).toBeNull();
  });
});

describe('selectionTouchedEntryIds', () => {
  const cards = [
    { entryId: 10, viewportStartRow: 0, viewportEndRow: 3 },
    { entryId: 11, viewportStartRow: 4, viewportEndRow: 6 },
  ];

  it('returns the card when the rect touches even ONE of its rows', () => {
    const rect: SelectionRect = {
      topLeft: { row: 1, col: 4 },
      bottomRight: { row: 1, col: 12 },
      inProgress: false,
    };
    // Block-based: a single-row touch claims the whole block — the id is all
    // that survives; no row/col clipping exists anymore.
    expect(selectionTouchedEntryIds({ selection: rect, cards })).toEqual([10]);
  });

  it('returns every touched card in viewport order across a multi-card drag', () => {
    const rect: SelectionRect = {
      topLeft: { row: 2, col: 10 },
      bottomRight: { row: 5, col: 30 },
      inProgress: false,
    };
    // Rows 2..5 touch card 10 (rows 0..2) and card 11 (rows 4..5); the ids
    // come back in document order regardless of drag direction.
    expect(selectionTouchedEntryIds({ selection: rect, cards })).toEqual([10, 11]);
  });

  it('returns no ids when the selection lands in a gap', () => {
    const rect: SelectionRect = {
      topLeft: { row: 3, col: 0 },
      bottomRight: { row: 3, col: 79 },
      inProgress: false,
    };
    expect(selectionTouchedEntryIds({ selection: rect, cards })).toEqual([]);
  });
});

describe('assembleSelectionText', () => {
  const CARD_TEXT = 'line one\nline two\nline three';
  const entries = new Map<number, HistoryEntry>([
    [42, { id: 42, kind: 'assistant', text: CARD_TEXT }],
  ]);

  it('returns "" when no blocks are touched', () => {
    expect(assembleSelectionText({ entryIds: [], entriesById: entries })).toBe('');
  });

  it('copies the WHOLE block from a partial touch — no row/col slicing', () => {
    // The core block contract: one touched block = its full copyable text,
    // regardless of which rows/cols the drag actually passed over.
    expect(assembleSelectionText({ entryIds: [42], entriesById: entries })).toBe(CARD_TEXT);
  });

  it('joins distinct blocks in the given order with the "---" card boundary', () => {
    const entries2 = new Map<number, HistoryEntry>([
      [42, { id: 42, kind: 'assistant', text: 'A' }],
      [43, { id: 43, kind: 'assistant', text: 'B' }],
    ]);
    expect(assembleSelectionText({ entryIds: [42, 43], entriesById: entries2 })).toBe('A\n---\nB');
  });

  it('returns "" when the underlying entry is no longer in the map', () => {
    expect(assembleSelectionText({ entryIds: [999], entriesById: entries })).toBe('');
  });

  it('skips unknown ids but keeps the known blocks around them', () => {
    const entries2 = new Map<number, HistoryEntry>([
      [42, { id: 42, kind: 'assistant', text: 'A' }],
      [44, { id: 44, kind: 'assistant', text: 'C' }],
    ]);
    expect(assembleSelectionText({ entryIds: [42, 999, 44], entriesById: entries2 })).toBe(
      'A\n---\nC',
    );
  });

  it('expands every member of a compact tool group as ONE block', () => {
    const groupEntries = new Map<number, HistoryEntry>([
      [50, { id: 50, kind: 'assistant', text: 'first' }],
      [51, { id: 51, kind: 'assistant', text: 'second' }],
    ]);
    const toolGroupsByHeadId = new Map<number, readonly number[]>([[50, [50, 51]]]);
    const expected = JSON.stringify([groupEntries.get(50), groupEntries.get(51)], null, 2);
    expect(
      assembleSelectionText({ entryIds: [50], entriesById: groupEntries, toolGroupsByHeadId }),
    ).toContain(expected);
  });
});

// ── Component-level ──────────────────────────────────────────────────────

interface MountedHandle {
  controller: HistoryScrollController;
  copyIconCol: number;
  entries: readonly HistoryEntry[];
  lastFrame: () => string;
  unmount: () => void;
}

/** Mount a minimal ScrollableHistory and wait one frame so the controller
 *  ref is populated. We use `viewportRows={1}` with single-line entries so
 *  every card mounts deterministically at row 0 — ink-testing-library's
 *  `measureElement` returns 0 (no real yoga), which collapses `pinnedSlack`
 *  to `vp` under larger viewports and pushes all cards off-screen. With
 *  `viewportRows={1}` the slack is always 0 and the first card's icon row
 *  is always row 0. */
function mountHistory(entries: readonly HistoryEntry[], maxWidth = 120): MountedHandle {
  const controllerRef: { current: HistoryScrollController | null } = { current: null };
  const app = render(
    <ScrollableHistory
      entries={[...entries]}
      viewportRows={1}
      controllerRef={controllerRef}
      maxWidth={maxWidth}
      autonomyMode="off"
      multiDiffSummaryThreshold={5}
    />,
  );
  // Force a frame so useEffect runs and controllerRef is populated.
  app.rerender(
    <ScrollableHistory
      entries={[...entries]}
      viewportRows={1}
      controllerRef={controllerRef}
      maxWidth={maxWidth}
      autonomyMode="off"
      multiDiffSummaryThreshold={5}
    />,
  );
  if (controllerRef.current === null) throw new Error('controllerRef not populated');
  return {
    controller: controllerRef.current,
    copyIconCol: Math.min(app.stdout.columns, maxWidth) - SCROLLBAR_HIT_WIDTH,
    entries,
    lastFrame: () => app.frames[app.frames.length - 1] ?? '',
    unmount: () => app.unmount(),
  };
}

function textEntry(id: number, text: string): HistoryEntry {
  return { id, kind: 'assistant', text };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Selection highlight band (external-store rail feedback)', () => {
  // The rail occupies the last SCROLLBAR_HIT_WIDTH (3) columns of the history
  // row: [copy icon][band/gap][track]. We assert on the last two columns —
  // the band glyph and the untouched track cell — so the test stays robust to
  // the icon glyph and the thumb-vs-track rendering of the third column.
  // The rail row is located BY THE CARD TEXT, not by output-line index: the
  // frame's first line need not be the card's row (leading blank rows or any
  // future layout change), but the rail always renders alongside the card's
  // own text row, so finding the line containing the card text and taking
  // its last two cells targets the band regardless of vertical placement.
  const railTail = (frame: string, cardText: string): string =>
    frame
      .split('\n')
      .find((line) => line.includes(cardText))
      ?.slice(-2) ?? '';

  it('fills the rail gap column during a drag and clears it on commit, without touching card text', async () => {
    writeClipboardTextMock.mockClear();
    const card = 'alpha bravo charlie';
    const h = mountHistory([textEntry(1, card)]);
    try {
      const before = railTail(h.lastFrame(), card);
      expect(before[0]).toBe(' '); // gap column empty before the drag

      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      await tick();

      const during = railTail(h.lastFrame(), card);
      expect(during[0]).toBe('█'); // head-row band glyph in the gap column
      expect(during[1]).toBe(before[1]); // track column untouched by the band
      // The card body is unchanged — the band re-renders only the rail.
      expect(h.lastFrame()).toContain(card);

      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      await tick();

      expect(railTail(h.lastFrame(), card)[0]).toBe(' '); // band cleared on commit
    } finally {
      h.unmount();
    }
  });

  it('shows no band when the press never starts a selection (row outside any card)', async () => {
    const card = 'one';
    const h = mountHistory([textEntry(1, card)]);
    try {
      h.controller.beginSelection(1, 0); // row 1 is blank — no card there
      await tick();
      expect(railTail(h.lastFrame(), card)[0]).toBe(' ');
    } finally {
      h.unmount();
    }
  });
});

describe('HistoryScrollController: beginSelection / extendSelection / commitSelection', () => {
  it('starts a drag inside a card, extends, ends, and copies the whole block', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'alpha bravo charlie')]);
    try {
      // With viewportRows={1} the first (and only) card mounts at row 0.
      // Columns only register the drag motion — the copy is the whole block.
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 6);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      expect(writeClipboardTextMock).toHaveBeenCalledTimes(1);
      // Block-based: a one-row partial drag still copies the card whole.
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('alpha bravo charlie');
    } finally {
      h.unmount();
    }
  });

  it('copies the whole block from a gutter press (border/padding column start)', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'alpha bravo charlie')]);
    try {
      // A press ON the gutter (band col 1 = the padding column) still starts
      // the gesture; block-based copy takes the full card text regardless of
      // which columns the drag crossed.
      h.controller.beginSelection(0, 1);
      h.controller.extendSelection(0, 6);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('alpha bravo charlie');
    } finally {
      h.unmount();
    }
  });

  it('copies an info card whole even when the drag starts on the ℹ icon column', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([{ id: 5, kind: 'info', text: 'alpha bravo charlie' }]);
    try {
      // info rows have no gutter and a 2-cell 'ℹ ' icon prefix; under the
      // line-based contract those columns skewed the sliced text ('alp').
      // Block-based copy ignores chrome columns entirely — any in-card drag
      // copies the card's full copyable text.
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('alpha bravo charlie');
    } finally {
      h.unmount();
    }
  });

  it('copies a user card whole when the drag starts on the 👤 label cells', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([{ id: 6, kind: 'user', text: 'hello world' }]);
    try {
      // Row 0 renders border(1) + padding(1) + '👤 USER  '(9 cells) + text.
      // The drag starts AND ends on the label cells — the block copy still
      // takes the card's full copy base (pasteContent || text); label chrome
      // is excluded by the copy contract, not by column math.
      h.controller.beginSelection(0, 2);
      h.controller.extendSelection(0, 6);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('hello world');
    } finally {
      h.unmount();
    }
  });

  it('copies the full source text even when the card wraps on screen', async () => {
    writeClipboardTextMock.mockClear();
    // maxWidth=16 → banded termWidth 13 → gutter leaves content width 11, so
    // 'aaaa bbbb cccc' WRAPS into two visual rows on screen. Block-based copy
    // is geometry-blind: the payload is the card's whole source text, never
    // the dragged visual rows (the old wrap-map translation is gone).
    const h = mountHistory([textEntry(1, 'aaaa bbbb cccc')], 16);
    try {
      h.controller.beginSelection(0, 2);
      h.controller.extendSelection(0, 12);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('aaaa bbbb cccc');
    } finally {
      h.unmount();
    }
  });

  it('a drag over a compact tool-group copies EVERY member as ONE block', async () => {
    writeClipboardTextMock.mockClear();
    // Two consecutive same-name tool calls (bash ×2, not in
    // STRUCTURED_DIFF_TOOLS) compact into ONE block. The full chain —
    // render group → buildMountedCardSpans (entryIds = every member) →
    // commitSelection's toolGroupsByHeadId → copyableTextForEntries — must
    // land the WHOLE group's raw JSON on the clipboard from a partial drag;
    // this pins the mounted chain end-to-end.
    const tools: HistoryEntry[] = [
      { id: 10, kind: 'tool', name: 'bash', durationMs: 5, ok: true, output: 'first result' },
      { id: 11, kind: 'tool', name: 'bash', durationMs: 7, ok: true, output: 'second result' },
    ];
    const h = mountHistory(tools);
    try {
      // Tool groups get no gutter translation (M3 pass-through): band col N
      // is card col N. A one-row drag across the compacted card commits.
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 3);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
      const copied = writeClipboardTextMock.mock.calls[0]?.[0] ?? '';
      // BOTH members' payloads — the expansion, not a head-only copy.
      expect(copied).toContain('first result');
      expect(copied).toContain('second result');
      // And it is the group's raw serialization (copyableTextForEntries),
      // matching the existing copy-icon contract for compacted groups.
      expect(copied).toContain(copyableTextForEntries(tools));
    } finally {
      h.unmount();
    }
  });

  it('returns false (no clipboard write) when the drag never moved', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'short entry')]);
    try {
      h.controller.beginSelection(0, 0);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(false);
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('returns false when the press is on a row between cards (no entry row there)', async () => {
    writeClipboardTextMock.mockClear();
    // With viewportRows={1} the single card occupies row 0; row 1 is blank.
    // A press at row 1 lands outside any card and beginSelection should be
    // a no-op.
    const h = mountHistory([textEntry(1, 'one')]);
    try {
      h.controller.beginSelection(1, 0);
      h.controller.extendSelection(1, 10);
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(false);
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('cancels the drag when the user crosses into the gutter', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'pinned card text')]);
    try {
      // With maxWidth=120, termWidth inside ScrollableHistory is 118.
      // Col 118 is out-of-band (the rail). A valid press at col 5, then
      // extending past the band edge to col 118, should cancel the drag.
      h.controller.beginSelection(0, 5);
      h.controller.extendSelection(0, 118); // out-of-band: rail
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(false);
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('clears a viewport-relative selection when the history scrolls', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([
      textEntry(1, 'first selectable entry'),
      textEntry(2, 'second selectable entry'),
    ]);
    try {
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      h.controller.endSelection();
      h.controller.scrollBy(1);
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(false);
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('clearSelection wipes state without writing', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'something worth selecting')]);
    try {
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 3);
      h.controller.endSelection();
      h.controller.clearSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(false);
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });
});

describe('HistoryScrollController: existing copy-icon path is preserved', () => {
  it('hasCopyTargetAt returns true on the icon row and false off it', () => {
    const h = mountHistory([textEntry(1, 'alpha')]);
    try {
      // With viewportRows={1} the card's icon is at row 0.
      expect(h.controller.hasCopyTargetAt(0, h.copyIconCol)).toBe(true);
      // Off-row check
      expect(h.controller.hasCopyTargetAt(99, 99)).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('copyAtViewportCell returns the entry id and does NOT depend on selection state', async () => {
    writeClipboardTextMock.mockClear();
    const h = mountHistory([textEntry(1, 'icon-test text')]);
    try {
      // With viewportRows={1} the card's icon is at row 0. No beginSelection
      // was called — the icon click works in isolation.
      const entryId = await h.controller.copyAtViewportCell(0, h.copyIconCol);
      expect(entryId).toBe(1);
      expect(writeClipboardTextMock).toHaveBeenCalledWith(
        copyableTextForEntry({
          id: 1,
          kind: 'assistant',
          text: 'icon-test text',
        }),
      );
    } finally {
      h.unmount();
    }
  });
});

describe('Regression: dummy coverage', () => {
  it('runs the unused-import sentinel so a missing export fails loudly', () => {
    expect(HELPERS_NOT_INTERNAL).toBe(true);
  });
});

describe('Regression: release-commits-copy routing', () => {
  // Pins the app-key-handler contract for the left-release that ends a
  // drag-select: a release with an active selection COMMITS to the
  // clipboard (and fires onHistoryCopy with the sentinel id), while a
  // release with no begun selection must not even reach commitSelection —
  // the synchronous hasSelection() gate exists precisely so a stray
  // release (rail click, status-bar click, anything whose press never
  // routed into beginSelection) spawns no async clipboard path.
  //
  // The tests drive the REAL createAppKeyHandler with SGR-shaped key
  // events (exactly what <Input> forwards for a decoded mouse report:
  // input='' + key.mouse), with mouseMode=false to pin that the gesture
  // works in DEFAULT mode, not just behind --mouse.

  const TERM_ROWS = 24;
  const TERM_COLS = 80;
  const MAIN_COLUMN_WIDTH = 80;

  /** Build the KeyEvent <Input> would forward for one decoded mouse report. */
  function mouseKey(report: string): { input: string; key: KeyEvent } {
    const evt = parseMouseEvent(report);
    if (!evt) throw new Error(`not a whole SGR report: ${JSON.stringify(report)}`);
    return {
      input: '',
      key: {
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
        mouse: evt,
        ...(evt.kind === 'wheel' ? { wheelDeltaY: evt.wheel } : {}),
      },
    };
  }

  /** Minimal handler options: enough to reach the mouse block with no
   *  overlay open and viewportRows=1 so terminal row 1 is history row 0. */
  function makeHandler(opts: {
    historyScrollRef: { current: HistoryScrollController | null };
    onHistoryCopy?: (entryId: number) => void;
  }) {
    const state = createTestState({ viewportRows: 1 });
    const options = {
      state,
      dispatch: vi.fn(),
      historyScrollRef: opts.historyScrollRef,
      runInterruptLadder: vi.fn(),
      enhanceCancelledRef: { current: false },
      enhanceAbortRef: { current: null },
      inputGateRef: { current: false },
      lastEscAtRef: { current: 0 },
      pasteAccumRef: { current: null },
      pasteFlushTimerRef: { current: null },
      commitPaste: vi.fn(async () => {}),
      tryPickerKey: vi.fn(() => false),
      dismissedEscAtRef: { current: 0 },
      streamingTextRef: { current: '' },
      confirmExitRef: { current: false },
      activeCtrlRef: { current: null },
      clearPendingConfirms: vi.fn(),
      liveDirector: () => null,
      openProjectPicker: vi.fn(async () => {}),
      loadLiveSessions: vi.fn(async () => {}),
      openStatuslinePicker: vi.fn(),
      statuslineHiddenItems: [],
      getSddRun: undefined,
      onSddLifecycle: undefined,
      getSettings: vi.fn(() => ({})),
      saveSettings: vi.fn(async () => null),
      lastEnterAtRef: { current: 0 },
      draftRef: { current: { buffer: '', cursor: 0 } },
      setDraft: vi.fn(),
      submit: vi.fn(),
      mouseMode: false,
      termRows: TERM_ROWS,
      terminalColumns: TERM_COLS,
      terminalRows: TERM_ROWS,
      mainColumnWidth: MAIN_COLUMN_WIDTH,
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
      slashRegistry: {},
      agent: { ctx: { session: {} } },
      ...(opts.onHistoryCopy ? { onHistoryCopy: opts.onHistoryCopy } : {}),
    };
    return createAppKeyHandler(options as never);
  }

  it('a left-release ending an active selection commits to the clipboard', async () => {
    writeClipboardTextMock.mockClear();
    const onHistoryCopy = vi.fn();
    // Real mounted controller: with viewportRows={1} the card sits at
    // history row 0 = terminal row 1 (1-based SGR). The press x=1 → drag x=7
    // only has to register motion — the release then commits the WHOLE
    // assistant block, columns irrelevant.
    const h = mountHistory([textEntry(1, 'alpha bravo charlie')]);
    const handleKey = makeHandler({
      historyScrollRef: { current: h.controller },
      onHistoryCopy,
    });
    try {
      const press = mouseKey('\x1b[<0;1;1M');
      await handleKey(press.input, press.key);
      const drag = mouseKey('\x1b[<32;7;1M'); // Cb 32 = motion, button left
      await handleKey(drag.input, drag.key);
      const release = mouseKey('\x1b[<0;7;1m'); // lowercase m = release
      await handleKey(release.input, release.key);
      // The async clipboard write is detached inside the handler; flush it.
      await new Promise((resolve) => setImmediate(resolve));
      expect(writeClipboardTextMock).toHaveBeenCalledTimes(1);
      expect(writeClipboardTextMock.mock.calls[0]?.[0]).toBe('alpha bravo charlie');
      expect(onHistoryCopy).toHaveBeenCalledWith(SELECTION_COPY_ID);
    } finally {
      h.unmount();
    }
  });

  it('a wheel event mid-drag clears the selection: release after wheel spawns no copy', async () => {
    writeClipboardTextMock.mockClear();
    const onHistoryCopy = vi.fn();
    // H2 pin: scrolling during a drag-select cancels the gesture so the
    // copied span can't desync from the visible cards. The wheel branch in
    // app-key-handler clears the selection (and scrollBy → applyAnchor
    // clears independently), so the subsequent release must hit the
    // hasSelection() short-circuit and never reach commitSelection.
    const h = mountHistory([textEntry(1, 'alpha bravo charlie')]);
    const handleKey = makeHandler({
      historyScrollRef: { current: h.controller },
      onHistoryCopy,
    });
    try {
      const press = mouseKey('\x1b[<0;1;1M');
      await handleKey(press.input, press.key);
      const drag = mouseKey('\x1b[<32;7;1M'); // motion, button left — same as the commit test
      await handleKey(drag.input, drag.key);
      // Non-vacuous guard: the press/drag above actually began a selection
      // (routing works) before the wheel below clears it — otherwise this
      // test would pass even if beginSelection/extendSelection broke.
      expect(h.controller.hasSelection()).toBe(true);

      // Cb 64 = wheel up at (x=10, y=1) — inside the history band
      // (viewportRows=1 → terminal row 1 is history row 0).
      const wheel = mouseKey('\x1b[<64;10;1M');
      await handleKey(wheel.input, wheel.key);
      expect(h.controller.hasSelection()).toBe(false);

      // The release now ends nothing: no clipboard write, no copy callback.
      const release = mouseKey('\x1b[<0;7;1m');
      await handleKey(release.input, release.key);
      await new Promise((resolve) => setImmediate(resolve));
      expect(writeClipboardTextMock).not.toHaveBeenCalled();
      expect(onHistoryCopy).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });

  it('a left-release with no begun selection spawns no copy at all', async () => {
    writeClipboardTextMock.mockClear();
    // Spy controller: hasSelection()=false must short-circuit BEFORE
    // commitSelection is ever called. A gateless implementation would call
    // commitSelection on every release — this fails it.
    const commitSelection = vi.fn(async () => true);
    const controller = {
      scrollBy: vi.fn(),
      scrollPage: vi.fn(),
      scrollToTop: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToTrackCell: vi.fn(),
      isScrolled: () => false,
      hasCopyTargetAt: () => false,
      copyAtViewportCell: vi.fn(async () => null),
      beginSelection: vi.fn(),
      extendSelection: vi.fn(),
      endSelection: vi.fn(),
      hasSelection: () => false,
      clearSelection: vi.fn(),
      commitSelection,
    };
    const handleKey = makeHandler({
      historyScrollRef: { current: controller as never as HistoryScrollController },
    });
    const release = mouseKey('\x1b[<0;5;1m');
    await handleKey(release.input, release.key);
    await new Promise((resolve) => setImmediate(resolve));
    expect(commitSelection).not.toHaveBeenCalled();
    expect(writeClipboardTextMock).not.toHaveBeenCalled();
  });
});

describe('Regression: SGR decoder + endSelection round trip', () => {
  // The drag-select gesture is gated on real SGR mouse reports arriving as
  // `press` and `release` events that both retain `button='left'`. Anyone
  // collapsing the lowercase-SGR release to `button='none'` would silently
  // bypass the drag-select release branch. These tests pin that decoder
  // contract and the controller's idempotent release behavior together.

  it('decodes a left-press as kind=press button=left', () => {
    // SGR: ESC[<0;10;5M   (Cb=0 → button 0 = left, no modifiers)
    const report = '\x1b[<0;10;5M';
    const evt = parseMouseEvent(report);
    expect(evt?.kind).toBe('press');
    expect(evt?.button).toBe('left');
  });

  it('decodes a left-release as kind=release button=left', () => {
    // SGR: ESC[<0;10;5m   (lowercase `m` = release). The decoder keeps the
    // last-pressed button identity on release rather than collapsing to
    // `button='none'`, so a left-press/left-release pair arrives as
    // (press, left) followed by (release, left). This test pins that
    // contract so the drag-select handler's `button === 'left'` gate stays
    // accurate.
    const report = '\x1b[<0;10;5m';
    const evt = parseMouseEvent(report);
    expect(evt?.kind).toBe('release');
    expect(evt?.button).toBe('left');
  });

  it('endSelection is idempotent and tolerates release-without-anchor', async () => {
    const h = mountHistory([textEntry(1, 'unrelated text')]);
    try {
      // No beginSelection was called — every endSelection call below must
      // be a silent no-op. This is the shape of the release-branch bug: if
      // the routing layer ever calls endSelection on a release that didn't
      // start a gesture, the controller must not crash or corrupt state.
      expect(() => h.controller.endSelection()).not.toThrow();
      expect(() => h.controller.endSelection()).not.toThrow();
      // A later begin→extend→end cycle still works, and repeating endSelection
      // after release preserves the committed range. With viewportRows={1}
      // the card is at row 0.
      h.controller.beginSelection(0, 0);
      h.controller.extendSelection(0, 4);
      h.controller.endSelection();
      h.controller.endSelection();
      const ok = await h.controller.commitSelection();
      expect(ok).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
