/**
 * Rewind and fork from a message: which checkpoint a message was sent under,
 * the prompt handed back to the composer, and the fork flow.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-action-type.js';
import { createInitialState } from '../src/app-initial-state.js';
import { reducer } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import type { HistoryEntry } from '../src/history-entry.js';
import { forkAtCheckpoint } from '../src/hooks/fork-at-checkpoint.js';
import { validateAction } from '../src/input-validation.js';
import { checkpointForMessage } from '../src/message-checkpoint.js';
import { restoreRewoundPrompt, showRewind } from '../src/rewind-prompt.js';

const cp = (promptIndex: number, promptPreview: string) => ({
  promptIndex,
  promptPreview,
  ts: 't',
  fileCount: 0,
});
const user = (id: number, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ id, kind: 'user', text, ...extra }) as HistoryEntry;

describe('checkpointForMessage', () => {
  it('pairs messages with checkpoints in order by the start of their text', () => {
    const entries = [
      user(1, 'fix the parser'),
      { id: 2, kind: 'assistant', text: 'done', final: true } as HistoryEntry,
      user(3, '↯ also check the tests'),
      user(4, 'fix the parser'),
    ];
    const checkpoints = [cp(0, 'fix the parser'), cp(4, 'fix the parser')];
    expect(checkpointForMessage(entries, checkpoints, 1)).toBe(0);
    // Same text twice: the second message gets the second checkpoint.
    expect(checkpointForMessage(entries, checkpoints, 4)).toBe(1);
    // A steering note is folded into a running turn and has none.
    expect(checkpointForMessage(entries, checkpoints, 3)).toBeUndefined();
  });

  it('matches a long prompt against its truncated preview', () => {
    const long = `summarise ${'x'.repeat(200)}`;
    const entries = [user(1, long)];
    expect(checkpointForMessage(entries, [cp(0, `${long.slice(0, 80)}…`)], 1)).toBe(0);
  });

  it('falls back to order when the screen text differs from what was sent', () => {
    const entries = [user(1, 'hello'), user(2, '[Pasted text #1 +40 lines] explain')];
    const checkpoints = [cp(0, 'hello'), cp(3, 'line one of the paste')];
    expect(checkpointForMessage(entries, checkpoints, 2)).toBe(1);
    // Without one checkpoint per message the order says nothing.
    expect(checkpointForMessage(entries, [cp(3, 'line one of the paste')], 2)).toBeUndefined();
    expect(checkpointForMessage(entries, checkpoints, 99)).toBeUndefined();
  });

  it('skips queued messages, which have not run yet', () => {
    const entries = [user(1, 'a'), user(2, 'b', { queued: true })];
    expect(checkpointForMessage(entries, [cp(0, 'a')], 2)).toBeUndefined();
  });

  // F1330: history retention (400 entries / 1 MB) and checkpoint retention
  // (200) drop different prefixes. Pairing from the oldest end matched the
  // first message still on screen to the oldest checkpoint of the same text,
  // so Enter in the rewind overlay took back extra turns.
  it('pairs from the newest end when older messages left the screen', () => {
    const entries = [
      {
        id: -41,
        kind: 'info',
        text: '… 40 earlier TUI entries omitted (full session remains on disk).',
      } as HistoryEntry,
      user(41, 'continue'),
    ];
    const checkpoints = [cp(0, 'continue'), cp(1, 'fix X'), cp(2, 'continue')];
    expect(checkpointForMessage(entries, checkpoints, 41)).toBe(2);
  });

  it('does not lend a message a newer checkpoint after its own was retired', () => {
    const entries = [user(1, 'fix A'), user(2, 'fix B'), user(3, 'fix A')];
    const checkpoints = [cp(1, 'fix B'), cp(2, 'fix A')];
    expect(checkpointForMessage(entries, checkpoints, 3)).toBe(1);
    expect(checkpointForMessage(entries, checkpoints, 1)).toBeUndefined();
  });
});

describe('restoreRewoundPrompt', () => {
  const run = (draft: string, prompt: string | undefined) => {
    const dispatch = vi.fn<(action: Action) => void>();
    restoreRewoundPrompt(dispatch, draft, prompt);
    return dispatch.mock.calls.map((c) => c[0]);
  };

  it('puts the prompt back in an empty composer', () => {
    expect(run('', 'fix it\nplease')).toEqual([
      { type: 'setBuffer', buffer: 'fix it\nplease', cursor: 13 },
    ]);
  });

  it('keeps a draft the rewind wiped, and shows the prompt instead', () => {
    const actions = run('my draft', 'fix it');
    expect(actions[0]).toEqual({ type: 'setBuffer', buffer: 'my draft', cursor: 8 });
    expect(actions[1]).toMatchObject({ type: 'addEntry', entry: { kind: 'info' } });
    expect((actions[1] as { entry: { text: string } }).entry.text).toContain('fix it');
  });

  it('does nothing without a prompt or a draft', () => {
    expect(run('', undefined)).toEqual([]);
    expect(run('', '   ')).toEqual([]);
  });
});

describe('showRewind', () => {
  it('redraws the turns that survived, then hands the prompt back', () => {
    const dispatch = vi.fn<(action: Action) => void>();
    showRewind(dispatch, '', {
      promptText: 'second prompt',
      conversation: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
        ],
        events: [],
      },
    });
    const [redraw, restore] = dispatch.mock.calls.map((c) => c[0]);
    expect(redraw?.type).toBe('replaceHistory');
    const entries = (redraw as { entries: HistoryEntry[] }).entries;
    expect(entries.map((e) => [e.kind, 'text' in e ? e.text : ''])).toEqual([
      ['user', 'first prompt'],
      ['assistant', 'first answer'],
    ]);
    expect(restore).toEqual({ type: 'setBuffer', buffer: 'second prompt', cursor: 13 });
  });

  it('only hands the prompt back when there is no conversation to redraw', () => {
    const dispatch = vi.fn<(action: Action) => void>();
    showRewind(dispatch, '', { promptText: 'x' });
    expect(dispatch.mock.calls.map((c) => c[0].type)).toEqual(['setBuffer']);
  });
});

describe('forkAtCheckpoint', () => {
  const deps = (over: Partial<Parameters<typeof forkAtCheckpoint>[0]> = {}) => {
    const dispatch = vi.fn<(action: Action) => void>();
    let current = 'sess_a';
    const resume = vi.fn(async (id: string) => {
      current = id;
    });
    return {
      dispatch,
      resume,
      deps: {
        forkSession: vi.fn(async () => ({ id: 'sess_fork' })),
        promptAt: vi.fn(async () => 'the prompt'),
        resume,
        currentSessionId: () => current,
        dispatch,
        ...over,
      },
    };
  };

  it('forks, switches to the fork and hands the prompt back', async () => {
    const d = deps();
    await forkAtCheckpoint(d.deps, { sessionId: 'sess_a', promptIndex: 4, draft: '' });
    expect(d.deps.promptAt).toHaveBeenCalledWith('sess_a', 4);
    expect(d.deps.forkSession).toHaveBeenCalledWith('sess_a', 4);
    expect(d.resume).toHaveBeenCalledWith('sess_fork', 'fork of sess_a at #4');
    const actions = d.dispatch.mock.calls.map((c) => c[0]);
    expect(actions[0]).toMatchObject({ type: 'addEntry', entry: { kind: 'info' } });
    expect(actions[1]).toEqual({ type: 'setBuffer', buffer: 'the prompt', cursor: 10 });
  });

  it('reports a failed fork and does not switch', async () => {
    const d = deps({
      forkSession: vi.fn(async () => {
        throw new Error('Checkpoint 4 not found');
      }),
    });
    await forkAtCheckpoint(d.deps, { sessionId: 'sess_a', promptIndex: 4, draft: '' });
    expect(d.resume).not.toHaveBeenCalled();
    expect(d.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'addEntry',
      entry: { kind: 'error', text: 'Fork failed: Checkpoint 4 not found' },
    });
  });

  it('leaves the composer alone when the resume did not attach the fork', async () => {
    const d = deps({ resume: vi.fn(async () => undefined) });
    await forkAtCheckpoint(d.deps, { sessionId: 'sess_a', promptIndex: 4, draft: '' });
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});

describe('rewind and fork state', () => {
  const base = (): State =>
    createInitialState({
      banner: false,
      model: 'm',
      cwd: '/p',
      restoredEntries: [],
      enhanceEnabled: false,
    });

  it('a checkpoint for an index seen before replaces it', () => {
    let s = reducer(base(), { type: 'checkpointReceived', cp: cp(1, 'rewound prompt') });
    s = reducer(s, { type: 'checkpointReceived', cp: cp(1, 'prompt sent after the rewind') });
    expect(s.checkpoints.map((c) => c.promptPreview)).toEqual(['prompt sent after the rewind']);
  });

  it('a rewind keeps the checkpoints it did not take back', () => {
    let s = base();
    for (const c of [cp(0, 'a'), cp(1, 'b'), cp(2, 'c')]) {
      s = reducer(s, { type: 'checkpointReceived', cp: c });
    }
    // The order the event bridge dispatches on `session.rewound`.
    s = reducer(s, { type: 'sessionRewound', toPromptIndex: 1 });
    s = reducer(s, { type: 'clearHistory', keepCheckpoints: true });
    expect(s.checkpoints.map((c) => c.promptIndex)).toEqual([0, 1]);
    // `/clear` still starts the list over.
    expect(reducer(s, { type: 'clearHistory' }).checkpoints).toEqual([]);
  });

  it('opening the timeline selects the newest row unless told otherwise', () => {
    let s = base();
    for (const c of [cp(0, 'a'), cp(2, 'b'), cp(5, 'c')]) {
      s = reducer(s, { type: 'checkpointReceived', cp: c });
    }
    expect(reducer(s, { type: 'rewindOverlayOpen' }).rewindOverlay?.selected).toBe(2);
    expect(reducer(s, { type: 'rewindOverlayOpen', selected: 0 }).rewindOverlay?.selected).toBe(0);
    expect(reducer(s, { type: 'rewindOverlayOpen', selected: 9 }).rewindOverlay?.selected).toBe(2);
  });

  it('a fork request closes the timeline until the fork is taken up', () => {
    let s = reducer(base(), { type: 'checkpointReceived', cp: cp(0, 'a') });
    s = reducer(s, { type: 'rewindOverlayOpen' });
    s = reducer(s, { type: 'checkpointFork', promptIndex: 0 });
    expect(s.rewindOverlay).toBeNull();
    expect(s.forkRequest).toEqual({ promptIndex: 0 });
    expect(reducer(s, { type: 'forkRequestDone' }).forkRequest).toBeNull();
  });

  it('accepts the new actions and refuses a bad index', () => {
    expect(validateAction({ type: 'checkpointFork', promptIndex: 3 }).valid).toBe(true);
    expect(validateAction({ type: 'checkpointFork', promptIndex: -1 } as never).valid).toBe(false);
    expect(validateAction({ type: 'forkRequestDone' }).valid).toBe(true);
    expect(validateAction({ type: 'messageJumpClear' }).valid).toBe(true);
  });
});
