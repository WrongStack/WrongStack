import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { HistoryEntry } from '../src/components/history/types.js';
import { TUI_RESUME_HISTORY_BUDGET } from '../src/history-retention.js';
import {
  appendResumeLog,
  RESUME_SPINNER_FRAMES,
  type ResumeLoadState,
  renderResumeLoadBlock,
  resumeBlockedReason,
  resumeChunkSize,
  resumeStageLabel,
  todosForScreen,
} from '../src/resume-load.js';
import { createTestState } from './helpers/create-test-state.js';

function load(overrides: Partial<ResumeLoadState> = {}): ResumeLoadState {
  return {
    sessionId: '2026-08-29/sess_01M16QFGAJ',
    label: 'fix the build',
    blockEntryId: 1,
    phase: 'reading',
    loadedBytes: 0,
    totalBytes: 0,
    log: [],
    replayed: 0,
    total: 0,
    frame: 0,
    ...overrides,
  };
}

describe('resume loading block', () => {
  it('never exceeds five rows however long the stage log gets', () => {
    // The block sits in the transcript. A progress indicator that grows without
    // bound would push the conversation it is about to render off the screen.
    const many = Array.from({ length: 40 }, (_, index) => `stage ${index}`);
    const block = renderResumeLoadBlock(load({ log: many, totalBytes: 100, loadedBytes: 50 }));
    expect(block.split('\n')).toHaveLength(5);
    // The newest stages are the ones kept.
    expect(block).toContain('stage 39');
    expect(block).not.toContain('stage 36');
  });

  it('marks finished stages done and the newest one live', () => {
    const block = renderResumeLoadBlock(
      load({ log: ['reserving ownership', 'reading the journal'], frame: 0 }),
    );
    expect(block).toContain('✓ reserving ownership');
    expect(block).toContain(`${RESUME_SPINNER_FRAMES[0]} reading the journal`);
  });

  it('keeps a stable height before the first byte report', () => {
    // The loader is throttled and a warm cache reports a single completed tick,
    // so the first frame usually has no total. An indeterminate row keeps the
    // block from growing by a line the moment the first tick lands.
    expect(renderResumeLoadBlock(load()).split('\n')).toHaveLength(2);
    expect(renderResumeLoadBlock(load())).toContain('reading…');
  });

  it('reports byte progress while reading', () => {
    expect(
      renderResumeLoadBlock(load({ loadedBytes: 68 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 })),
    ).toContain('68%');
  });

  it('collapses an immediately repeated stage line', () => {
    // A retried or renewed step can re-report the same stage, and three
    // identical visible rows say nothing.
    expect(appendResumeLog(['reading the journal'], 'reading the journal')).toEqual([
      'reading the journal',
    ]);
    expect(appendResumeLog(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('labels known stages and passes unknown ones through', () => {
    expect(resumeStageLabel('open_journal')).toBe('reading the journal');
    // A stage this table has not caught up with is still more useful than
    // silence, which is what made a stuck resume undiagnosable.
    expect(resumeStageLabel('some_future_stage')).toBe('some future stage');
  });

  it('spreads any transcript length over a comparable number of frames', () => {
    // 740 entries is what a 131 MB journal replays to; 30 is a short session.
    // Both should land near half a second, not "instant" and "a minute".
    expect(Math.ceil(740 / resumeChunkSize(740))).toBeLessThanOrEqual(36);
    expect(Math.ceil(30 / resumeChunkSize(30))).toBeLessThanOrEqual(36);
    expect(resumeChunkSize(1)).toBeGreaterThan(0);
  });
});

describe('resume loading reducer flow', () => {
  const banner = {
    id: 0,
    kind: 'banner' as const,
    version: 'v',
    provider: 'p',
    model: 'm',
    cwd: '/',
  };
  const entry = (id: number): HistoryEntry => ({ id, kind: 'info', text: `old-${id}` });

  const started = () =>
    reducer(createTestState({ entries: [banner, entry(1), entry(2), entry(3)], nextId: 4 }), {
      type: 'resumeLoadStart',
      sessionId: 'sess_x',
      label: 'my session',
    });

  it('wipes the screen to the banner and the block, like /clear', () => {
    const next = started();
    // The previous conversation must not sit under a different session's
    // loading block — that is how the user loses track of which transcript is
    // on screen.
    expect(next.entries).toHaveLength(2);
    expect(next.entries[0]).toBe(banner);
    expect(next.entries[1]?.kind).toBe('info');
    expect((next.entries[1] as { text: string }).text).toContain('my session');
    expect(next.historyScrolled).toBe(false);
    // Resume posture is taken at the START, not at the commit: no auto-proceed
    // countdown may arm during the seconds the journal is being read.
    expect(next.autoProceedHold).toBe(true);
    expect(next.historyBudget).toBe(TUI_RESUME_HISTORY_BUDGET);
    expect(next.resumeLoad?.sessionId).toBe('sess_x');
  });

  it('drops the leaving session context reading along with its transcript', () => {
    // `leader.ctxTokens` is the statusline's and /context's first-choice source
    // and nothing else clears it on a resume — the agent loop only rewrites it
    // on the next request. Left in place it outlives the conversation it
    // measured: a 5k session resumed from a 400k one kept reporting 400k.
    const stale = createTestState();
    const withReading = createTestState({
      entries: [banner],
      leader: { ...stale.leader, ctxTokens: 400_000, ctxMaxTokens: 1_000_000 },
    });

    const next = reducer(withReading, {
      type: 'resumeLoadStart',
      sessionId: 'sess_x',
      label: 'my session',
    });

    expect(next.leader.ctxTokens).toBeUndefined();
    expect(next.leader.ctxMaxTokens).toBeUndefined();
    expect(next.contextChipVersion).toBe(withReading.contextChipVersion + 1);
  });

  it('applies the resumed measurement, and leaves the chip to the local estimate without one', () => {
    const withReading = reducer(
      createTestState({
        entries: [banner],
        leader: { ...createTestState().leader, ctxTokens: 400_000 },
      }),
      { type: 'resumeLoadStart', sessionId: 'sess_x', label: 'my session' },
    );

    // A session that never reached the model reports 0 — that is an ABSENCE of
    // a measurement, not a measured zero, so the chip must stay cleared and
    // fall through to the estimate over the freshly loaded messages.
    const noMeasurement = reducer(withReading, {
      type: 'resumeStreamChunk',
      entries: [],
      total: 0,
      done: true,
      contextSnapshot: { tokens: 0, maxContext: 200_000 },
    });
    expect(noMeasurement.leader.ctxTokens).toBeUndefined();

    const measured = reducer(withReading, {
      type: 'resumeStreamChunk',
      entries: [],
      total: 0,
      done: true,
      contextSnapshot: { tokens: 12_000, maxContext: 200_000 },
    });
    expect(measured.leader.ctxTokens).toBe(12_000);
    expect(measured.leader.ctxMaxTokens).toBe(200_000);
  });

  it('rewrites the block in place, even when other entries land during the load', () => {
    let state = started();
    const blockId = state.resumeLoad?.blockEntryId;
    // Background producers (mailbox, fleet) keep appending while the journal
    // parses. A positionally-derived block id would rewrite one of THEM.
    state = reducer(state, { type: 'addEntry', entry: { kind: 'info', text: 'mailbox: hello' } });
    state = reducer(state, {
      type: 'resumeLoadTick',
      loadedBytes: 50,
      totalBytes: 100,
      note: 'reading the journal',
    });

    const block = state.entries.find((e) => e.id === blockId) as { text: string };
    expect(block.text).toContain('50%');
    expect(block.text).toContain('reading the journal');
    expect(state.entries.some((e) => (e as { text?: string }).text === 'mailbox: hello')).toBe(
      true,
    );
  });

  it('ignores ticks that arrive after the resume settled', () => {
    // The loader is throttled and the spinner interval can fire once more
    // before it is cleared; neither may resurrect a finished block.
    const state = reducer(started(), { type: 'resumeLoadAbort' });
    expect(reducer(state, { type: 'resumeLoadTick' })).toBe(state);
  });

  it('drops the block on the first chunk and streams the transcript under the banner', () => {
    let state = started();
    const first = [entry(101), entry(102)];
    state = reducer(state, { type: 'resumeStreamChunk', entries: first, total: 4 });

    // From here the transcript IS the progress indicator.
    expect(state.entries).toHaveLength(3);
    expect(state.entries[0]).toBe(banner);
    expect(state.resumeLoad?.phase).toBe('replaying');
    expect(state.resumeLoad?.replayed).toBe(2);

    state = reducer(state, {
      type: 'resumeStreamChunk',
      entries: [entry(103), entry(104)],
      total: 4,
      done: true,
      contextSnapshot: { tokens: 1234, maxContext: 200_000 },
    });

    expect(state.entries).toHaveLength(5);
    expect(state.resumeLoad).toBeNull();
    // Ids are reassigned contiguously so a streamed transcript is
    // indistinguishable from one committed in a single dispatch.
    expect(state.entries.map((e) => e.id)).toEqual([0, 1, 2, 3, 4]);
    expect(state.nextId).toBe(5);
    expect(state.leader.ctxTokens).toBe(1234);
    expect(state.historyScrolled).toBe(false);
  });

  it('finishes an empty transcript with a single terminating chunk', () => {
    // A session with nothing to replay still has to clear the loading block —
    // otherwise the spinner spins forever over an empty screen.
    const state = reducer(started(), {
      type: 'resumeStreamChunk',
      entries: [],
      total: 0,
      done: true,
    });
    expect(state.resumeLoad).toBeNull();
    expect(state.entries).toEqual([banner]);
  });

  it('leaves the block on screen when a resume is abandoned', () => {
    // The caller writes the reason underneath. Blanking here would erase the
    // only record of what was attempted.
    const state = reducer(started(), { type: 'resumeLoadAbort' });
    expect(state.resumeLoad).toBeNull();
    expect(state.entries).toHaveLength(2);
  });
});

describe('todosForScreen', () => {
  const board = [{ id: '1', status: 'in_progress' }];

  it('shows the live board when no resume is in flight', () => {
    // Same array back, not a copy: the sidebar's mission-row memo keys on it.
    expect(todosForScreen(board, null)).toBe(board);
    expect(todosForScreen(board, undefined)).toBe(board);
  });

  it('blanks the board for the length of a resume', () => {
    // The board lives in `agent.ctx` and the host does not replace it until it
    // has read the journal — so without this the LEAVING session's missions sat
    // in the swarm panel underneath the incoming session's loading block.
    expect(todosForScreen(board, load())).toEqual([]);
    expect(todosForScreen(board, load({ phase: 'replaying', replayed: 12, total: 40 }))).toEqual(
      [],
    );
  });

  it('returns one stable empty array across the whole resume', () => {
    // A fresh `[]` per render would re-run every downstream memo on every
    // spinner tick, for as long as the journal takes to parse.
    const first = todosForScreen(board, load({ frame: 1 }));
    const second = todosForScreen(board, load({ frame: 2 }));
    expect(first).toBe(second);
  });
});

describe('resumeBlockedReason', () => {
  it('allows an ordinary closed session', () => {
    expect(resumeBlockedReason({})).toBeUndefined();
    expect(resumeBlockedReason({ isCurrent: false, live: undefined })).toBeUndefined();
  });

  it('blocks the session this process is already in', () => {
    expect(resumeBlockedReason({ isCurrent: true })).toMatch(/this session/i);
  });

  it('blocks a session another process is writing, and names the surface', () => {
    // The whole point of carrying `clientType`: "open somewhere else" is not
    // actionable, "open in webui (pid 4242)" tells the user where to go.
    const reason = resumeBlockedReason({ live: { pid: 4242, clientType: 'webui' } });
    expect(reason).toContain('webui');
    expect(reason).toContain('4242');
  });

  it('blocks a live session from a registry row with no clientType', () => {
    // Older registry entries predate the field; liveness alone is enough to
    // refuse, and the message must not read "open in undefined".
    const reason = resumeBlockedReason({ live: { pid: 7 } });
    expect(reason).toContain('another wstack');
    expect(reason).not.toContain('undefined');
  });

  it('reports the current session before liveness', () => {
    // This process holds its own lease, so the current session is also "live".
    // Saying "open in another wstack" about the session you are sitting in
    // would be wrong; `isCurrent` wins.
    const reason = resumeBlockedReason({ isCurrent: true, live: { pid: 1, clientType: 'tui' } });
    expect(reason).toMatch(/this session/i);
  });
});
