import { describe, it, expect } from 'vitest';
import {
  validateStdinFragment,
  validatePasteContent,
  validateMouseEvent,
  validateAction,
  validateFleetEntry,
  validateRestoreEntry,
  safeDispatch,
  ensureValidAction,
  MAX_INPUT_BUFFER_CHARS,
  MAX_PASTE_CHARS,
  MAX_PASTE_FRAGMENT_CHARS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_BATCHED_ACTIONS,
  MAX_ACTION_STRING_FIELD,
} from '../src/input-validation.js';

// ── validateStdinFragment ───────────────────────────────────────────

describe('validateStdinFragment', () => {
  it('allows printable ASCII characters', () => {
    const result = validateStdinFragment(Buffer.from('hello world'));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('hello world');
  });

  it('allows Unicode characters', () => {
    const result = validateStdinFragment(Buffer.from('héllo wörld 🔥', 'utf8'));
    expect(result.valid).toBe(true);
  });

  it('allows known control sequences (arrows)', () => {
    const result = validateStdinFragment(Buffer.from('\x1b[A', 'utf8')); // Up arrow
    expect(result.valid).toBe(true);
  });

  it('allows known CSI sequences (Home, End)', () => {
    expect(validateStdinFragment(Buffer.from('\x1b[H', 'utf8')).valid).toBe(true); // Home
    expect(validateStdinFragment(Buffer.from('\x1b[F', 'utf8')).valid).toBe(true); // End
    expect(validateStdinFragment(Buffer.from('\x1b[1~', 'utf8')).valid).toBe(true); // Home alt
    expect(validateStdinFragment(Buffer.from('\x1b[4~', 'utf8')).valid).toBe(true); // End alt
  });

  it('allows function keys (F1-F12)', () => {
    expect(validateStdinFragment(Buffer.from('\x1b[11~', 'utf8')).valid).toBe(true); // F1
    expect(validateStdinFragment(Buffer.from('\x1bOP', 'utf8')).valid).toBe(true); // F1 SS3
    expect(validateStdinFragment(Buffer.from('\x1b[24~', 'utf8')).valid).toBe(true); // F12
  });

  it('allows mouse SGR reports', () => {
    const result = validateStdinFragment(Buffer.from('\x1b[<0;10;5M', 'utf8'));
    expect(result.valid).toBe(true);
  });

  it('allows tab and newline', () => {
    expect(validateStdinFragment(Buffer.from('\t', 'utf8')).valid).toBe(true);
    expect(validateStdinFragment(Buffer.from('\n', 'utf8')).valid).toBe(true);
  });

  it('rejects C0 control characters other than tab/newline/esc', () => {
    expect(validateStdinFragment(Buffer.from('\x00', 'utf8')).valid).toBe(false); // NUL
    expect(validateStdinFragment(Buffer.from('\x03', 'utf8')).valid).toBe(false); // ETX (Ctrl+C is handled before fragment validation)
    expect(validateStdinFragment(Buffer.from('\x07', 'utf8')).valid).toBe(false); // BEL
    expect(validateStdinFragment(Buffer.from('\x0b', 'utf8')).valid).toBe(false); // VT
  });

  it('rejects oversized fragments', () => {
    const big = 'x'.repeat(MAX_PASTE_FRAGMENT_CHARS + 1);
    const result = validateStdinFragment(Buffer.from(big, 'utf8'));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('rejects ESC followed by unexpected bytes', () => {
    const result = validateStdinFragment(Buffer.from('\x1bQ', 'utf8')); // ESC+Q is not a CSI start
    expect(result.valid).toBe(false);
  });

  it('allows standalone ESC (the buffer timer handles it)', () => {
    const result = validateStdinFragment(Buffer.from('\x1b', 'utf8'));
    expect(result.valid).toBe(true);
  });
});

// ── validatePasteContent ────────────────────────────────────────────

describe('validatePasteContent', () => {
  it('allows normal text', () => {
    const result = validatePasteContent('Hello world\nThis is a paste');
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe('Hello world\nThis is a paste');
  });

  it('rejects empty paste', () => {
    const result = validatePasteContent('');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('empty');
  });

  it('rejects oversized paste', () => {
    const big = 'x'.repeat(MAX_PASTE_CHARS + 1);
    const result = validatePasteContent(big);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('rejects paste with C0 control chars', () => {
    expect(validatePasteContent('hello\x00world').valid).toBe(false);
    expect(validatePasteContent('hello\x07world').valid).toBe(false);
  });

  it('allows paste with tab/newline/carriage-return', () => {
    expect(validatePasteContent('hello\tworld').valid).toBe(true);
    expect(validatePasteContent('hello\nworld').valid).toBe(true);
    expect(validatePasteContent('hello\r\nworld').valid).toBe(true);
  });

  it('rejects paste with C0 control chars', () => {
    // C0 control chars (0x01-0x08) are caught by the C0 check
    const binary = '\x01\x02\x03\x04' + 'aaaaaa';
    const result = validatePasteContent(binary);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('C0 control char');
  });

  it('allows paste with valid Unicode', () => {
    expect(validatePasteContent('🔥 📦 🚀 emoji paste').valid).toBe(true);
    expect(validatePasteContent('日本語の貼り付け').valid).toBe(true);
  });
});

// ── validateMouseEvent ──────────────────────────────────────────────

describe('validateMouseEvent', () => {
  it('validates a complete click event', () => {
    const result = validateMouseEvent({
      kind: 'press',
      button: 'left',
      x: 10,
      y: 20,
      wheel: 0,
      shift: false,
      meta: false,
      ctrl: false,
      motion: false,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.kind).toBe('press');
      expect(result.value.x).toBe(10);
    }
  });

  it('validates a wheel event', () => {
    const result = validateMouseEvent({
      kind: 'wheel',
      button: 'none',
      x: 100,
      y: 50,
      wheel: 1, // scroll up
    });
    expect(result.valid).toBe(true);
  });

  it('rejects unknown mouse kind', () => {
    const result = validateMouseEvent({
      kind: 'swipe',
      button: 'none',
      x: 10,
      y: 10,
      wheel: 0,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('allow-list');
  });

  it('rejects unknown button', () => {
    const result = validateMouseEvent({
      kind: 'press',
      button: 'fifth',
      x: 10,
      y: 10,
      wheel: 0,
    });
    expect(result.valid).toBe(false);
  });

  it('rejects out-of-range x coordinate', () => {
    expect(validateMouseEvent({ kind: 'press', button: 'left', x: 0, y: 10, wheel: 0 }).valid).toBe(
      false,
    );
    expect(
      validateMouseEvent({ kind: 'press', button: 'left', x: 5001, y: 10, wheel: 0 }).valid,
    ).toBe(false);
    expect(
      validateMouseEvent({ kind: 'press', button: 'left', x: -1, y: 10, wheel: 0 }).valid,
    ).toBe(false);
  });

  it('rejects out-of-range wheel value', () => {
    expect(
      validateMouseEvent({ kind: 'wheel', button: 'none', x: 10, y: 10, wheel: 2 }).valid,
    ).toBe(false);
    expect(
      validateMouseEvent({ kind: 'wheel', button: 'none', x: 10, y: 10, wheel: -2 }).valid,
    ).toBe(false);
  });
});

// ── validateAction ──────────────────────────────────────────────────

describe('validateAction', () => {
  it('accepts a known action type', () => {
    const result = validateAction({ type: 'clearInput' });
    expect(result.valid).toBe(true);
  });

  it('accepts toggle actions', () => {
    expect(validateAction({ type: 'toggleHelp' }).valid).toBe(true);
    expect(validateAction({ type: 'toggleMonitor' }).valid).toBe(true);
    expect(validateAction({ type: 'closeAllPanels' }).valid).toBe(true);
  });

  it('accepts the copiedNotice action (transient copy confirmation)', () => {
    // Must be on the allow-list or safeDispatch would silently drop it and the
    // "Copied" status-line confirmation would never appear.
    expect(validateAction({ type: 'copiedNotice', text: '✓ Copied', entryId: 1 }).valid).toBe(true);
    expect(validateAction({ type: 'copiedNotice', text: '', entryId: null }).valid).toBe(true);
  });

  it('rejects unknown action type', () => {
    const result = validateAction({ type: 'nukeEverything' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('not on the allow-list');
  });

  it('rejects empty action type', () => {
    expect(validateAction({ type: '' }).valid).toBe(false);
    expect(validateAction({ type: '   ' }).valid).toBe(false);
  });

  it('validates setBuffer with correct range', () => {
    const result = validateAction({ type: 'setBuffer', buffer: 'hello', cursor: 3 });
    expect(result.valid).toBe(true);
  });

  it('rejects setBuffer with cursor past buffer length', () => {
    const result = validateAction({ type: 'setBuffer', buffer: 'hi', cursor: 99 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('cursor');
  });

  it('rejects setBuffer with oversized buffer', () => {
    const big = 'x'.repeat(MAX_INPUT_BUFFER_CHARS + 1);
    const result = validateAction({ type: 'setBuffer', buffer: big, cursor: 0 });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('validates setHistoryScrolled flag', () => {
    expect(validateAction({ type: 'setHistoryScrolled', scrolled: true }).valid).toBe(true);
    expect(validateAction({ type: 'setHistoryScrolled', scrolled: false }).valid).toBe(true);
    expect(validateAction({ type: 'setHistoryScrolled', scrolled: 'yes' }).valid).toBe(false);
  });

  it('accepts current run-state and mid-run delivery actions', () => {
    expect(validateAction({ type: 'status', status: 'running' }).valid).toBe(true);
    expect(validateAction({ type: 'sendModePickerOpen', info: {} }).valid).toBe(true);
    expect(validateAction({ type: 'enqueue', item: {} }).valid).toBe(true);
  });

  it('validates setFleetChat', () => {
    expect(validateAction({ type: 'setFleetChat', mode: 'off' }).valid).toBe(true);
    expect(validateAction({ type: 'setFleetChat', mode: 'full' }).valid).toBe(true);
    expect(validateAction({ type: 'setFleetChat', mode: 'verbose' }).valid).toBe(false);
  });

  it('validates addEntry', () => {
    const result = validateAction({
      type: 'addEntry',
      entry: { kind: 'user', text: 'hello' },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects addEntry with unknown kind', () => {
    const result = validateAction({
      type: 'addEntry',
      entry: { kind: 'alien', text: 'hello' },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('allow-list');
  });

  it('rejects addEntry with oversized text', () => {
    const big = 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1);
    const result = validateAction({
      type: 'addEntry',
      entry: { kind: 'user', text: big },
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('validates fleetBatch action count', () => {
    const actions = Array.from({ length: MAX_BATCHED_ACTIONS }, (_, i) => ({
      type: 'fleetDelta',
      id: `a${i}`,
    }));
    const result = validateAction({ type: 'fleetBatch', actions });
    expect(result.valid).toBe(true);
  });

  it('rejects fleetBatch with too many actions', () => {
    const actions = Array.from({ length: MAX_BATCHED_ACTIONS + 1 }, (_, i) => ({
      type: 'fleetDelta',
      id: `a${i}`,
    }));
    const result = validateAction({ type: 'fleetBatch', actions });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('rejects actions with deeply nested payload', () => {
    type Nested = Record<string, unknown> & { type: string };
    const deep: Nested = { type: 'setBuffer', buffer: 'hi', cursor: 0 };
    let cur = deep;
    for (let i = 0; i < 12; i++) {
      const next: Nested = { type: 'setBuffer', buffer: 'deep', cursor: 0 };
      cur.next = next;
      cur = next;
    }
    const result = validateAction(deep);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('nesting depth');
  });

  it('rejects actions with oversized string fields', () => {
    const long = 'x'.repeat(MAX_ACTION_STRING_FIELD + 1);
    const result = validateAction({ type: 'hint', text: long });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('exceeds');
  });

  it('accepts slash-menu and picker actions used by the input router', () => {
    expect(validateAction({ type: 'statuslineOpen', hiddenItems: [] }).valid).toBe(true);
    expect(validateAction({ type: 'settingsClose' }).valid).toBe(true);
    expect(
      validateAction({ type: 'modelPickerPickProvider', providerId: 'openai', models: [] }).valid,
    ).toBe(true);
  });

  it('validates debugStreamStats', () => {
    const result = validateAction({
      type: 'debugStreamStats',
      chunkCount: 10,
      lastChunkSize: 256,
      lastDeltaMs: 100,
      totalBytes: 10240,
      lastChunkAt: '2026-07-19T00:00:00.000Z',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects debugStreamStats with negative chunkCount', () => {
    const result = validateAction({
      type: 'debugStreamStats',
      chunkCount: -1,
      lastChunkSize: 0,
      totalBytes: 0,
    });
    expect(result.valid).toBe(false);
  });

  it('validates countdownTick', () => {
    expect(validateAction({ type: 'countdownTick', remainingSeconds: 5 }).valid).toBe(true);
    expect(validateAction({ type: 'countdownTick', remainingSeconds: 0 }).valid).toBe(true);
  });

  it('rejects countdownTick with negative value', () => {
    expect(validateAction({ type: 'countdownTick', remainingSeconds: -1 }).valid).toBe(false);
  });

  it('validates collabSessionDone verdict', () => {
    expect(
      validateAction({ type: 'collabSessionDone', sessionId: 's1', verdict: 'approve' }).valid,
    ).toBe(true);
    expect(
      validateAction({ type: 'collabSessionDone', sessionId: 's1', verdict: 'reject' }).valid,
    ).toBe(true);
    expect(
      validateAction({ type: 'collabSessionDone', sessionId: 's1', verdict: 'maybe' }).valid,
    ).toBe(false);
  });

  it('validates plannerMove with delta -1/0/1 only', () => {
    expect(validateAction({ type: 'pickerMove', delta: -1 }).valid).toBe(true);
    expect(validateAction({ type: 'pickerMove', delta: 0 }).valid).toBe(true);
    expect(validateAction({ type: 'pickerMove', delta: 1 }).valid).toBe(true);
    expect(validateAction({ type: 'pickerMove', delta: 2 }).valid).toBe(false);
    expect(validateAction({ type: 'pickerMove', delta: -2 }).valid).toBe(false);
  });

  it('accepts current picker search and hint actions', () => {
    expect(validateAction({ type: 'modelPickerSearch', query: 'claude-sonnet' }).valid).toBe(true);
    expect(validateAction({ type: 'statuslineHint', text: 'saved' }).valid).toBe(true);
  });

  it('accepts current input-history actions', () => {
    expect(validateAction({ type: 'historyPush', text: '/model' }).valid).toBe(true);
    expect(validateAction({ type: 'historyUp' }).valid).toBe(true);
    expect(validateAction({ type: 'historyDown' }).valid).toBe(true);
  });

  it('accepts current settings editor actions', () => {
    expect(validateAction({ type: 'settingsFieldMove', delta: 1 }).valid).toBe(true);
    expect(validateAction({ type: 'settingsValueChange', delta: -1 }).valid).toBe(true);
    expect(validateAction({ type: 'settingsThinkingEditChange', draft: 'working' }).valid).toBe(
      true,
    );
  });

  it('accepts current auth and help panel actions', () => {
    expect(validateAction({ type: 'authOpen' }).valid).toBe(true);
    expect(validateAction({ type: 'authFilter', filter: 'openai' }).valid).toBe(true);
    expect(validateAction({ type: 'helpClose' }).valid).toBe(true);
  });

  it('validates worktree operations', () => {
    expect(validateAction({ type: 'worktreeUpsert', handleId: 'abc' }).valid).toBe(true);
    expect(validateAction({ type: 'worktreeUpsert', handleId: '' }).valid).toBe(false);
    expect(validateAction({ type: 'worktreeRemove', handleId: 'abc' }).valid).toBe(true);
    expect(validateAction({ type: 'worktreeRemove', handleId: '' }).valid).toBe(false);
  });

  it('rejects stale action names that are no longer reducer actions', () => {
    expect(validateAction({ type: 'replaceEntry', id: 5 }).valid).toBe(false);
    expect(validateAction({ type: 'setLiveModel', value: 'model' }).valid).toBe(false);
  });
});

// ── validateFleetEntry ──────────────────────────────────────────────

describe('validateFleetEntry', () => {
  it('validates a well-formed fleet entry', () => {
    const result = validateFleetEntry({
      id: 'subagent-1',
      name: 'bug-hunter',
      status: 'running',
      iterations: 5,
      toolCalls: 12,
      cost: 0.05,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects missing id', () => {
    const result = validateFleetEntry({ id: '', name: 'x', status: 'idle' });
    expect(result.valid).toBe(false);
  });

  it('rejects unknown status', () => {
    const result = validateFleetEntry({ id: 'a', name: 'x', status: 'zombie' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('allow-list');
  });

  it('rejects non-finite cost', () => {
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: NaN }).valid).toBe(false);
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: -1 }).valid).toBe(false);
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: Infinity }).valid).toBe(
      false,
    );
  });

  it('rejects oversized streamingText', () => {
    const result = validateFleetEntry({
      id: 'a',
      name: 'x',
      status: 'running',
      streamingText: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1),
    });
    expect(result.valid).toBe(false);
  });

  it('rejects oversized recentTools', () => {
    const recentTools = Array.from({ length: 101 }, (_, i) => ({ name: `tool${i}`, at: i }));
    const result = validateFleetEntry({ id: 'a', name: 'x', status: 'running', recentTools });
    expect(result.valid).toBe(false);
  });
});

// ── validateRestoreEntry ────────────────────────────────────────────

describe('validateRestoreEntry', () => {
  it('validates a well-formed history entry', () => {
    const result = validateRestoreEntry({ kind: 'user', text: 'hello' }, 0);
    expect(result.valid).toBe(true);
  });

  it('rejects non-object', () => {
    expect(validateRestoreEntry('string', 0).valid).toBe(false);
    expect(validateRestoreEntry(null, 0).valid).toBe(false);
    expect(validateRestoreEntry(42, 0).valid).toBe(false);
  });

  it('rejects unknown entry kind', () => {
    const result = validateRestoreEntry({ kind: 'fakekind' }, 0);
    expect(result.valid).toBe(false);
  });

  it('allows tool entries loosely (from our own JSONL)', () => {
    const result = validateRestoreEntry({ kind: 'tool', input: 'some big payload' }, 0);
    expect(result.valid).toBe(true);
  });

  it('rejects oversized text in text-bearing entries', () => {
    const result = validateRestoreEntry(
      { kind: 'user', text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1) },
      0,
    );
    expect(result.valid).toBe(false);
  });
});

// ── safeDispatch ────────────────────────────────────────────────────

describe('safeDispatch', () => {
  it('dispatches valid actions', () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatch = (a: Record<string, unknown>) => {
      dispatched.push(a);
    };

    const result = safeDispatch({ type: 'clearInput' }, dispatch);
    expect(result).toBe(true);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.type).toBe('clearInput');
  });

  it('rejects invalid actions without dispatching', () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const dispatch = (a: Record<string, unknown>) => {
      dispatched.push(a);
    };

    const result = safeDispatch({ type: 'unknownType' }, dispatch);
    expect(result).toBe(false);
    expect(dispatched.length).toBe(0);
  });
});

// ── ensureValidAction ───────────────────────────────────────────────

describe('ensureValidAction', () => {
  it('returns validated action on success', () => {
    const result = ensureValidAction({ type: 'closeAllPanels' });
    expect(result.type).toBe('closeAllPanels');
  });

  it('throws on invalid action', () => {
    expect(() => ensureValidAction({ type: '' })).toThrow('Input validation rejected');
  });
});
