import type { Message } from '@wrongstack/core/types';
import { DEFAULT_MIN_IMPORTANCE, DEFAULT_MIN_SCORE, MIN_RELATION_STRENGTH } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { buildRestoredEntries, createInitialState } from '../src/app-initial-state.js';
import { reducer } from '../src/app-reducer.js';
import type { HistoryEntry } from '../src/components/history/types.js';
import {
  retainTuiHistory,
  TUI_HISTORY_MAX_ENTRIES,
  TUI_HISTORY_MAX_ENTRY_BYTES,
  TUI_RESUME_HISTORY_BUDGET,
} from '../src/history-retention.js';

function infoEntries(count: number, startId = 1): HistoryEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: startId + index,
    kind: 'info' as const,
    text: `entry-${startId + index}`,
  }));
}

describe('bounded TUI display history', () => {
  it('returns the same array while it is within budget', () => {
    const entries = infoEntries(3);
    expect(retainTuiHistory(entries)).toBe(entries);
  });

  it('preserves the banner and newest entries and replaces the old prefix with a marker', () => {
    const banner: HistoryEntry = {
      id: 0,
      kind: 'banner',
      version: '1.0.0',
      provider: 'test',
      model: 'test',
      cwd: '/project',
    };
    const entries = [banner, ...infoEntries(TUI_HISTORY_MAX_ENTRIES + 50)];

    const retained = retainTuiHistory(entries);

    expect(retained).toHaveLength(TUI_HISTORY_MAX_ENTRIES + 2);
    expect(retained[0]).toBe(banner);
    expect(retained[1]).toMatchObject({
      kind: 'info',
      text: '… 50 earlier TUI entries omitted (full session remains on disk).',
    });
    expect(retained[2]).toMatchObject({ text: 'entry-51' });
    expect(retained.at(-1)).toMatchObject({ text: `entry-${TUI_HISTORY_MAX_ENTRIES + 50}` });
  });

  it('keeps only the first banner when history contains duplicates', () => {
    const first: HistoryEntry = {
      id: 0,
      kind: 'banner',
      version: '1.0.0',
      provider: 'first',
      model: 'first-model',
      cwd: '/first',
    };
    const second: HistoryEntry = {
      id: 9,
      kind: 'banner',
      version: '2.0.0',
      provider: 'second',
      model: 'second-model',
      cwd: '/second',
    };

    expect(retainTuiHistory([first, ...infoEntries(2), second])).toEqual([
      first,
      ...infoEntries(2),
    ]);
  });

  it('degrades a banner that cannot fit its custom per-entry budget to a transcript marker', () => {
    const banner: HistoryEntry = {
      id: 0,
      kind: 'banner',
      version: '1.0.0',
      provider: 'test',
      model: 'test',
      cwd: '/project',
    };

    expect(retainTuiHistory([banner], { maxBytes: 100, maxEntryBytes: 1 })).toEqual([
      {
        id: 0,
        kind: 'info',
        text: '… oversized banner entry omitted from TUI history (full session remains on disk).',
      },
    ]);
  });

  it('accumulates omission counts as a live managed history keeps growing', () => {
    const first = retainTuiHistory(infoEntries(4), { maxEntries: 2, maxBytes: 10_000 });
    const next = retainTuiHistory([...first, { id: 5, kind: 'info', text: 'entry-5' }], {
      maxEntries: 2,
      maxBytes: 10_000,
    });

    expect(next[0]).toMatchObject({
      text: '… 3 earlier TUI entries omitted (full session remains on disk).',
    });
    expect(next.slice(1).map((entry) => entry.id)).toEqual([4, 5]);
  });

  it('bounds live reducer history without waiting for a render effect', () => {
    let state = createInitialState({
      banner: false,
      model: 'test-model',
      cwd: '/project',
      restoredEntries: [],
      enhanceEnabled: false,
    });

    for (let index = 0; index < TUI_HISTORY_MAX_ENTRIES + 25; index += 1) {
      state = reducer(state, {
        type: 'addEntry',
        entry: { kind: 'info', text: `live-${index + 1}` },
      });
    }

    expect(state.entries).toHaveLength(TUI_HISTORY_MAX_ENTRIES + 1);
    expect(state.entries[0]).toMatchObject({
      text: '… 25 earlier TUI entries omitted (full session remains on disk).',
    });
    expect(state.entries.at(-1)).toMatchObject({ text: `live-${TUI_HISTORY_MAX_ENTRIES + 25}` });
    expect(state.nextId).toBe(TUI_HISTORY_MAX_ENTRIES + 26);
  });

  it('also enforces a byte budget without dropping the newest entry', () => {
    const entries: HistoryEntry[] = [
      { id: 1, kind: 'assistant', text: 'a'.repeat(80) },
      { id: 2, kind: 'assistant', text: 'b'.repeat(80) },
      { id: 3, kind: 'assistant', text: 'c'.repeat(80) },
    ];

    const retained = retainTuiHistory(entries, {
      maxEntries: 10,
      maxBytes: 100,
      maxEntryBytes: 100,
    });

    expect(retained[0]).toMatchObject({ kind: 'info' });
    expect(retained.at(-1)).toMatchObject({ id: 3, kind: 'assistant' });
    expect(retained).toHaveLength(2);
  });

  it('hard-caps a single oversized newest entry instead of exempting it from the budget', () => {
    const retained = retainTuiHistory([
      { id: 1, kind: 'assistant', text: '😀'.repeat(TUI_HISTORY_MAX_ENTRY_BYTES) },
    ]);

    const entry = retained[0];
    expect(entry).toMatchObject({ id: 1, kind: 'assistant' });
    expect(entry?.kind === 'assistant' ? entry.text : '').toContain('truncated for TUI history');
    expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(
      TUI_HISTORY_MAX_ENTRY_BYTES,
    );
  });

  it('drops oversized structured payloads to a bounded marker', () => {
    const retained = retainTuiHistory([
      {
        id: 7,
        kind: 'memory-activation',
        trigger: 'test',
        outcome: 'injected',
        candidates: 1,
        contextPressure: 0,
        injectedChars: 0,
        activated: [
          {
            id: 'memory-1',
            kind: 'fact',
            text: 'x'.repeat(TUI_HISTORY_MAX_ENTRY_BYTES * 2),
            score: 1,
            relationStrength: 1,
            anchors: [],
            tags: [],
            activationReasons: [],
            importance: 1,
            confidence: 1,
            freshness: 1,
            persistence: 'long_lived',
            metadataScore: 1,
            scoreTerms: [],
          },
        ],
        injectedIds: [],
        queryPreview: 'test',
        thresholds: {
          minScore: DEFAULT_MIN_SCORE,
          minImportance: DEFAULT_MIN_IMPORTANCE,
          relationFloor: MIN_RELATION_STRENGTH,
        },
        rejected: { duplicate: 0, belowScore: 0, alreadyVisible: 0, cooldown: 0, budget: 0 },
      },
    ]);

    expect(retained).toEqual([
      {
        id: 7,
        kind: 'info',
        text: '… oversized memory-activation entry omitted from TUI history (full session remains on disk).',
      },
    ]);
  });

  it('hydrates a resumed session against the wider resume budget, not the live one', () => {
    // A resume is not a scrollback window that grew a few entries at a time —
    // the whole conversation arrives at once and IS what the user asked to
    // see. Measured on real journals, a 131 MB session replays to 740 entries;
    // under the live 400-entry cap it lost 340 of them before anything
    // rendered, which reads as "resume did not load".
    const resumeMax = TUI_RESUME_HISTORY_BUDGET.maxEntries ?? 0;
    expect(resumeMax).toBeGreaterThan(TUI_HISTORY_MAX_ENTRIES);

    const belowResumeCap = Array.from({ length: TUI_HISTORY_MAX_ENTRIES + 25 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index + 1}`,
    })) as Message[];
    // Comfortably over the live cap, comfortably under the resume cap: nothing
    // is dropped and no omission marker is prepended.
    expect(buildRestoredEntries(belowResumeCap)).toHaveLength(TUI_HISTORY_MAX_ENTRIES + 25);

    // Still bounded — a resume may not make history unbounded.
    const messages = Array.from({ length: resumeMax + 25 }, (_, index) => ({
      role: 'user' as const,
      content: `message-${index + 1}`,
    })) as Message[];

    const restored = buildRestoredEntries(messages);

    expect(restored).toHaveLength(resumeMax + 1);
    expect(restored[0]).toMatchObject({
      text: '… 25 earlier TUI entries omitted (full session remains on disk).',
    });
    expect(restored.at(-1)).toMatchObject({ text: `message-${resumeMax + 25}` });

    const state = createInitialState({
      banner: false,
      model: 'test-model',
      cwd: '/project',
      restoredEntries: restored,
      enhanceEnabled: false,
    });
    expect(state.nextId).toBe(resumeMax + 26);
    // The widened budget has to PERSIST past the replace: the next `addEntry`
    // re-runs retention, so a budget scoped to the hydration alone would trim
    // the transcript back to 400 one dispatch later.
    expect(state.historyBudget).toBe(TUI_RESUME_HISTORY_BUDGET);
    // …and a resumed session lands waiting, never on an auto-proceed countdown.
    expect(state.autoProceedHold).toBe(true);
  });

  it('leaves a fresh session on the live budget with auto-proceed free', () => {
    const state = createInitialState({
      banner: false,
      model: 'test-model',
      cwd: '/project',
      restoredEntries: [],
      enhanceEnabled: false,
    });
    expect(state.historyBudget).toBeUndefined();
    expect(state.autoProceedHold).toBe(false);
  });
});
