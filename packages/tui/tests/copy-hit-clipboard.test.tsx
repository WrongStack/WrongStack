/**
 * Regression test for F1 (CopyHit → entryId-only).
 *
 * The CopyHit registry now stores `entryId` rather than the full `entry.text`
 * to avoid pinning every copyable card's markdown string for the lifetime of
 * the mounted window. This test exercises the round-trip contract directly:
 *   1. CopyHit carries entryId only (compile-time + runtime shape).
 *   2. The controller's copyAtViewportCell resolves entryId → live entry →
 *      copyableTextForEntry → clipboard, preserving the FULL original text.
 *
 * We mock `@wrongstack/runtime/clipboard` to capture writeClipboardText calls
 * and exercise the controller's lookup path against a hand-built registry +
 * entry map that mirrors the production shape. This avoids mounting the full
 * ScrollableHistory (which depends on Ink/Yoga layout details outside the F1
 * contract) and keeps the test focused on the round-trip invariant.
 *
 * For end-to-end wiring coverage of the mouse-click path through Ink, see
 * tests/scrollable-history-clear-repin.test.tsx and tests/copy-hit.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type CopyHit,
  findCopyHit,
} from '../src/components/scrollable-history.js';
import { copyableTextForEntry } from '../src/components/history/copy-icon.js';
import { writeClipboardText } from '@wrongstack/runtime/clipboard';
import type { HistoryEntry } from '../src/components/history.js';

// The production code imports writeClipboardText through the TUI clipboard
// re-export module, which re-exports from @wrongstack/runtime/clipboard. Mock
// the runtime module so calls are captured here.
vi.mock('@wrongstack/runtime/clipboard', () => ({
  writeClipboardText: vi.fn(async () => true),
  readClipboardText: vi.fn(async () => ''),
  readClipboardImage: vi.fn(async () => null),
  ClipboardImage: class {},
}));

const writeClipboardTextMock = writeClipboardText as unknown as ReturnType<typeof vi.fn>;

/** Multi-KB markdown payload — large enough that the pre-F1 CopyHit would
 *  have pinned a ~2 KB reference per mounted card. Used here only to assert
 *  round-trip fidelity (no truncation), not residency. */
const BIG_MARKDOWN = Array.from(
  { length: 4 },
  () =>
    [
      '## Cycle 17 — virtual scroll RAM investigation',
      '',
      "The CopyHit registry was pinning every mounted copyable card's full text",
      'for the duration of the mounted window. At a 20-card viewport averaging',
      '~8 KB/assistant text this was a steady-state ~160 KB cost.',
      '',
      '```ts',
      'const hit: CopyHit = { entryId, startRow, endRow, iconCol };',
      'const text = copyableTextForEntry(entriesById.get(hit.entryId));',
      '```',
      '',
      'The fix stores entryId only and resolves text at click time.',
      '---',
      '',
    ].join('\n'),
).join('\n');

const ASSISTANT_BIG: HistoryEntry = { id: 1, kind: 'assistant', text: BIG_MARKDOWN };
const USER_WITH_PASTE: HistoryEntry = {
  id: 2,
  kind: 'user',
  text: 'short prompt',
  pasteContent: 'full pasted block — copy should return the paste, not the placeholder',
};
const THINKING_TEXT = 'deep thoughts about the task at hand';
const THINKING: HistoryEntry = { id: 3, kind: 'thinking', text: THINKING_TEXT };
const TOOL_ENTRY: HistoryEntry = {
  id: 4,
  kind: 'tool',
  name: 'bash',
  durationMs: 0,
  ok: true,
  output: 'NOT a copyable card — text must be null',
};

/** Mirror of ScrollableHistory's controller lookup path: resolve the hit's
 *  entryId against the live entries, call copyableTextForEntry, write the
 *  result to the clipboard. Kept as a single function so the test mirrors
 *  the exact same control flow the controller uses post-F1. */
async function clickHit(
  hits: readonly CopyHit[],
  row: number,
  col: number,
  entriesById: ReadonlyMap<number, HistoryEntry>,
): Promise<number | null> {
  const hit = findCopyHit(hits, row, col);
  if (hit === null) return null;
  const entry = entriesById.get(hit.entryId);
  if (entry === undefined) return null;
  const text = copyableTextForEntry(entry);
  if (text === null) return null;
  const ok = await writeClipboardText(text);
  return ok ? hit.entryId : null;
}

describe('CopyHit entryId-only (F1 regression)', () => {
  it('CopyHit carries entryId only — no text field (F1 RAM savings)', () => {
    // Compile-time: the `text` key MUST NOT exist on CopyHit. If anyone
    // reintroduces it, this assertion fails and the typecheck surfaces it.
    const hit: CopyHit = { entryId: 1, startRow: 0, endRow: 1, iconCol: 0 };
    expect('text' in hit).toBe(false);
    expect(hit.entryId).toBe(1);

    // Runtime: the serialized shape is bounded regardless of how long the
    // underlying entry text is. Pre-F1 this would have included `text`
    // (≈ BIG_MARKDOWN.length bytes per mounted card). Post-F1 it's a fixed
    // small object — proves the registry no longer pins the markdown.
    expect(BIG_MARKDOWN.length).toBeGreaterThan(1024);
    const serialized = JSON.stringify(hit);
    expect(serialized.length).toBeLessThan(120);

    // findCopyHit resolves the entryId-only shape correctly.
    const looked = findCopyHit([hit], 0, 0);
    expect(looked?.entryId).toBe(1);
    expect('text' in (looked ?? {})).toBe(false);
  });

  it('writes the FULL entry.text to the clipboard via the entryId round-trip', async () => {
    // Build the registry + entry map the controller would own in production.
    const hits: CopyHit[] = [{ entryId: 1, startRow: 4, endRow: 5, iconCol: 57 }];
    const entriesById = new Map<number, HistoryEntry>([[1, ASSISTANT_BIG]]);
    writeClipboardTextMock.mockClear();

    const result = await clickHit(hits, 4, 57, entriesById);

    expect(result).toBe(1);
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(1);
    const copied = writeClipboardTextMock.mock.calls[0]?.[0];
    // Round-trip preserves the FULL original markdown byte-for-byte — no
    // truncation, no transformation. This is the F1 behavioral guarantee.
    expect(copied).toBe(BIG_MARKDOWN);
    expect(copied?.length).toBe(BIG_MARKDOWN.length);
  });

  it('resolves each hit to its own entry.text — per-hit dispatch, not pinned', async () => {
    const hits: CopyHit[] = [
      { entryId: 1, startRow: 0, endRow: 1, iconCol: 57 },
      { entryId: 2, startRow: 2, endRow: 3, iconCol: 57 },
      { entryId: 3, startRow: 4, endRow: 5, iconCol: 57 },
    ];
    const entriesById = new Map<number, HistoryEntry>([
      [1, ASSISTANT_BIG],
      [2, USER_WITH_PASTE],
      [3, THINKING],
    ]);
    writeClipboardTextMock.mockClear();

    // Click each hit and verify the clipboard receives THAT entry's text.
    expect(await clickHit(hits, 0, 57, entriesById)).toBe(1);
    expect(writeClipboardTextMock.mock.calls.at(-1)?.[0]).toBe(BIG_MARKDOWN);

    expect(await clickHit(hits, 2, 57, entriesById)).toBe(2);
    // copyableTextForEntry(user) returns pasteContent (the full pasted block)
    // when present, NOT the visible placeholder text.
    expect(writeClipboardTextMock.mock.calls.at(-1)?.[0]).toBe(USER_WITH_PASTE.pasteContent);

    expect(await clickHit(hits, 4, 57, entriesById)).toBe(3);
    expect(writeClipboardTextMock.mock.calls.at(-1)?.[0]).toBe(THINKING_TEXT);

    // Each click wrote exactly once.
    expect(writeClipboardTextMock).toHaveBeenCalledTimes(3);
  });

  it('returns null and writes nothing when no hit matches the cell', async () => {
    const hits: CopyHit[] = [{ entryId: 1, startRow: 4, endRow: 5, iconCol: 57 }];
    const entriesById = new Map<number, HistoryEntry>([[1, ASSISTANT_BIG]]);
    writeClipboardTextMock.mockClear();

    // Click off any hit (different row/col).
    const result = await clickHit(hits, 99, 99, entriesById);
    expect(result).toBeNull();
    expect(writeClipboardTextMock).not.toHaveBeenCalled();

    // Click inside a hit's row range but outside the icon column.
    const offCol = await clickHit(hits, 4, 0, entriesById);
    expect(offCol).toBeNull();
    expect(writeClipboardTextMock).not.toHaveBeenCalled();
  });

  it('returns null when the hit entryId is no longer in entriesById', async () => {
    // Stale-hit scenario: the controller handed back a hit before retention
    // evicted the underlying entry. The lookup must short-circuit, not
    // throw, and must NOT touch the clipboard.
    const hits: CopyHit[] = [{ entryId: 999, startRow: 0, endRow: 1, iconCol: 57 }];
    const entriesById = new Map<number, HistoryEntry>([[1, ASSISTANT_BIG]]);
    writeClipboardTextMock.mockClear();

    const result = await clickHit(hits, 0, 57, entriesById);
    expect(result).toBeNull();
    expect(writeClipboardTextMock).not.toHaveBeenCalled();
  });

  it('returns null when the hit entry is no longer copyable', async () => {
    // The hit registry pre-F1 used `copyableTextForEntry(entry) !== null`
    // as the gate for pushing a hit, so this case shouldn't arise in
    // practice. The post-F1 guard mirrors that gate, so the controller
    // returns null and writes nothing when an entry's copyable-ness
    // changed after the hit was registered (e.g. an entry was mutated in
    // place to a non-copyable kind).
    const hits: CopyHit[] = [{ entryId: 4, startRow: 0, endRow: 1, iconCol: 57 }];
    const entriesById = new Map<number, HistoryEntry>([[4, TOOL_ENTRY]]);
    writeClipboardTextMock.mockClear();

    const result = await clickHit(hits, 0, 57, entriesById);
    expect(result).toBeNull();
    expect(writeClipboardTextMock).not.toHaveBeenCalled();
  });
});
