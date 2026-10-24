import type { SessionEvent } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { buildRestoredCheckpoints, createInitialState } from '../src/app-initial-state.js';
import { reducer } from '../src/app-reducer.js';
import {
  type CheckpointEntry,
  retainCheckpoints,
  TUI_CHECKPOINTS_MAX_ENTRIES,
} from '../src/checkpoint-retention.js';

function cp(promptIndex: number, preview = `prompt ${promptIndex}`): CheckpointEntry {
  return {
    promptIndex,
    promptPreview: preview,
    ts: `2026-07-05T10:00:${String(promptIndex % 60).padStart(2, '0')}.000Z`,
    fileCount: 1,
  };
}

function checkpointEvent(promptIndex: number, preview?: string): SessionEvent {
  const c = cp(promptIndex, preview);
  return {
    type: 'checkpoint',
    ts: c.ts,
    promptIndex: c.promptIndex,
    promptPreview: c.promptPreview,
  } as SessionEvent;
}

function initialStateWith(checkpoints: CheckpointEntry[]) {
  const state = createInitialState({
    banner: false,
    model: 'test-model',
    cwd: '/project',
    restoredEntries: [],
    restoredCheckpoints: [],
    enhanceEnabled: false,
  });
  return { ...state, checkpoints };
}

describe('retainCheckpoints', () => {
  it('returns the same array reference while within budget', () => {
    const list = [cp(0), cp(1), cp(2)];
    expect(retainCheckpoints(list)).toBe(list);
  });

  it('keeps the newest checkpoints when the entry budget is exceeded', () => {
    const list = Array.from({ length: 10 }, (_, i) => cp(i));
    const retained = retainCheckpoints(list, { maxEntries: 4 });
    expect(retained.map((c) => c.promptIndex)).toEqual([6, 7, 8, 9]);
  });

  it('keeps the newest checkpoints when the byte budget is exceeded', () => {
    const list = Array.from({ length: 5 }, (_, i) => cp(i, 'x'.repeat(100)));
    // Each serialized entry is ~160 bytes; a 400-byte budget fits the newest 2.
    const retained = retainCheckpoints(list, { maxBytes: 400 });
    expect(retained.map((c) => c.promptIndex)).toEqual([3, 4]);
  });

  it('always keeps the newest checkpoint even when it alone exceeds the budget', () => {
    const list = [cp(0), cp(1, 'x'.repeat(10_000))];
    const retained = retainCheckpoints(list, { maxBytes: 100 });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.promptIndex).toBe(1);
  });

  it('clamps pathological budgets to at least one entry / one byte', () => {
    const list = [cp(0), cp(1)];
    const retained = retainCheckpoints(list, { maxEntries: 0, maxBytes: 0 });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.promptIndex).toBe(1);
  });

  it('stays within the default entry budget under a long-session workload', () => {
    const list = Array.from({ length: TUI_CHECKPOINTS_MAX_ENTRIES * 3 }, (_, i) => cp(i));
    const retained = retainCheckpoints(list);
    expect(retained).toHaveLength(TUI_CHECKPOINTS_MAX_ENTRIES);
    expect(retained[0]?.promptIndex).toBe(list.length - TUI_CHECKPOINTS_MAX_ENTRIES);
  });
});

describe('buildRestoredCheckpoints retention', () => {
  it('prunes a long resumed session to the newest checkpoints', () => {
    const events = Array.from({ length: TUI_CHECKPOINTS_MAX_ENTRIES + 50 }, (_, i) =>
      checkpointEvent(i),
    );
    const restored = buildRestoredCheckpoints(events);
    expect(restored).toHaveLength(TUI_CHECKPOINTS_MAX_ENTRIES);
    expect(restored[0]?.promptIndex).toBe(50);
    expect(restored.at(-1)?.promptIndex).toBe(TUI_CHECKPOINTS_MAX_ENTRIES + 49);
  });

  it('keeps small resumes untouched (sorted, deduped, fileCount 0)', () => {
    const restored = buildRestoredCheckpoints([checkpointEvent(1, 'b'), checkpointEvent(0, 'a')]);
    expect(restored.map((c) => c.promptIndex)).toEqual([0, 1]);
    expect(restored[0]).toMatchObject({ promptPreview: 'a', fileCount: 0 });
  });
});

describe('checkpointReceived reducer retention', () => {
  it('appends live checkpoints within budget', () => {
    const state = initialStateWith([cp(0)]);
    const next = reducer(state, { type: 'checkpointReceived', cp: cp(1) });
    expect(next.checkpoints.map((c) => c.promptIndex)).toEqual([0, 1]);
  });

  it('dedupes by promptIndex without growing the list', () => {
    const state = initialStateWith([cp(0)]);
    // The same checkpoint again (a resume replaying it) changes nothing.
    expect(reducer(state, { type: 'checkpointReceived', cp: cp(0) })).toBe(state);
    // A new prompt at that index (sent after a rewind to it) replaces it.
    const next = reducer(state, { type: 'checkpointReceived', cp: cp(0, 'rewritten') });
    expect(next.checkpoints).toHaveLength(1);
    expect(next.checkpoints[0]?.promptPreview).toBe('rewritten');
  });

  it('drops the oldest checkpoint when the entry budget is exceeded live', () => {
    const full = Array.from({ length: TUI_CHECKPOINTS_MAX_ENTRIES }, (_, i) => cp(i));
    const state = initialStateWith(full);
    const next = reducer(state, {
      type: 'checkpointReceived',
      cp: cp(TUI_CHECKPOINTS_MAX_ENTRIES),
    });
    expect(next.checkpoints).toHaveLength(TUI_CHECKPOINTS_MAX_ENTRIES);
    expect(next.checkpoints[0]?.promptIndex).toBe(1);
    expect(next.checkpoints.at(-1)?.promptIndex).toBe(TUI_CHECKPOINTS_MAX_ENTRIES);
  });
});
