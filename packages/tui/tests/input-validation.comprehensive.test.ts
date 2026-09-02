/** Comprehensive tests for input-validation.ts - targets uncovered branches */
import { describe, it, expect, vi } from 'vitest';
import {
  validateStdinFragment,
  validatePasteContent,
  validateMouseEvent,
  validateAction,
  validateFleetEntry,
  validateRestoreEntry,
  safeDispatch,
  ensureValidAction,
  normalizedEquals,
  MAX_PASTE_CHARS,
  MAX_PASTE_FRAGMENT_CHARS,
  MAX_ENTRY_TEXT_CHARS,
  MAX_BATCHED_ACTIONS,
  MAX_ACTION_STRING_FIELD,
} from '../src/input-validation.js';

describe('normalizedEquals', () => {
  it('identical', () => expect(normalizedEquals('a', 'a')).toBe(true));
  it('whitespace diff', () => expect(normalizedEquals('  a  ', 'a')).toBe(true));
  it('different', () => expect(normalizedEquals('a', 'b')).toBe(false));
  it('empty', () => expect(normalizedEquals('', '')).toBe(true));
  it('space empty', () => expect(normalizedEquals('  ', '')).toBe(true));
});

describe('validateStdinFragment extra', () => {
  it('allows ESC O (SS3)', () => {
    const r = validateStdinFragment(Buffer.from('\x1bOP', 'utf8'));
    expect(r.valid).toBe(true);
  });
  it('rejects ESC ] (OSC) with BEL terminator (BEL is C0)', () => {
    const r = validateStdinFragment(Buffer.from('\x1b]0;title\x07', 'utf8'));
    expect(r.valid).toBe(false);
  });
  it('rejects C0 0x01', () => {
    expect(validateStdinFragment(Buffer.from('a\x01b', 'utf8')).valid).toBe(false);
  });
  it('allows exact size', () => {
    const x = 'x'.repeat(MAX_PASTE_FRAGMENT_CHARS);
    expect(validateStdinFragment(Buffer.from(x, 'utf8')).valid).toBe(true);
  });
});

describe('validatePasteContent extra', () => {
  it('rejects 0x0b VT', () => {
    expect(validatePasteContent('a\x0bb').valid).toBe(false);
  });
  it('rejects 0x0c FF', () => {
    expect(validatePasteContent('a\x0cb').valid).toBe(false);
  });
  it('rejects 0x0e-0x1f', () => {
    expect(validatePasteContent('a\x0eb').valid).toBe(false);
    expect(validatePasteContent('a\x1bb').valid).toBe(false);
  });
  it('allows CR', () => {
    expect(validatePasteContent('a\rb').valid).toBe(true);
  });
  it('allows exact max', () => {
    const x = 'x'.repeat(MAX_PASTE_CHARS);
    expect(validatePasteContent(x).valid).toBe(true);
  });
  it('rejects oversized', () => {
    const x = 'x'.repeat(MAX_PASTE_CHARS + 1);
    expect(validatePasteContent(x).valid).toBe(false);
  });
  it('rejects empty', () => {
    expect(validatePasteContent('').valid).toBe(false);
  });
});

describe('validateMouseEvent extra', () => {
  it('move kind', () => {
    expect(validateMouseEvent({ kind: 'move', button: 'none', x: 1, y: 1, wheel: 0 }).valid).toBe(
      true,
    );
  });
  it('release kind', () => {
    expect(
      validateMouseEvent({ kind: 'release', button: 'left', x: 1, y: 1, wheel: 0 }).valid,
    ).toBe(true);
  });
  it('non-int x rejected', () => {
    expect(
      validateMouseEvent({ kind: 'press', button: 'left', x: 1.5, y: 1, wheel: 0 }).valid,
    ).toBe(false);
  });
  it('non-int y rejected', () => {
    expect(
      validateMouseEvent({ kind: 'press', button: 'left', x: 1, y: 1.5, wheel: 0 }).valid,
    ).toBe(false);
  });
  it('y=0 rejected', () => {
    expect(validateMouseEvent({ kind: 'press', button: 'left', x: 1, y: 0, wheel: 0 }).valid).toBe(
      false,
    );
  });
  it('non-int wheel rejected', () => {
    expect(
      validateMouseEvent({ kind: 'wheel', button: 'none', x: 1, y: 1, wheel: 0.5 }).valid,
    ).toBe(false);
  });
  it('defaults optional fields', () => {
    const r = validateMouseEvent({ kind: 'press', button: 'left', x: 1, y: 1, wheel: 0 });
    if (r.valid) {
      expect(r.value.shift).toBe(false);
      expect(r.value.motion).toBe(false);
    }
  });
});

describe('validateAction setup checks', () => {
  it('rejects unknown type', () => {
    const r = validateAction({ type: 'unknownType12345' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('allow-list');
  });
  it('rejects deep nesting', () => {
    type Nested = { type: string; [key: string]: unknown };
    const d: Nested = { type: 'clearInput' };
    let c = d;
    for (let i = 0; i < 12; i++) {
      const next: Nested = { type: 'clearInput' };
      c.n = next;
      c = next;
    }
    const r = validateAction(d);
    expect(r.valid).toBe(false);
  });
  it('rejects oversized string', () => {
    const l = 'x'.repeat(MAX_ACTION_STRING_FIELD + 1);
    expect(validateAction({ type: 'hint', text: l }).valid).toBe(false);
  });
});

describe('validateAction actions with validators', () => {
  it('setBuffer', () => {
    expect(validateAction({ type: 'setBuffer', buffer: 'hi', cursor: 1 }).valid).toBe(true);
    expect(validateAction({ type: 'setBuffer', buffer: 'hi', cursor: -1 }).valid).toBe(false);
    expect(validateAction({ type: 'setBuffer', buffer: 'hi', cursor: 1.5 }).valid).toBe(false);
  });
  it('setHistoryScrolled', () => {
    expect(validateAction({ type: 'setHistoryScrolled', scrolled: true }).valid).toBe(true);
    expect(validateAction({ type: 'setHistoryScrolled', scrolled: 'x' }).valid).toBe(false);
  });
  it('addEntry', () => {
    expect(validateAction({ type: 'addEntry', entry: { kind: 'banner' } }).valid).toBe(true);
    expect(validateAction({ type: 'addEntry', entry: { kind: 'divider' } }).valid).toBe(true);
    expect(validateAction({ type: 'addEntry', entry: 'str' }).valid).toBe(false);
  });
  it('replaceEntry (not in allow-list)', () => {
    expect(validateAction({ type: 'replaceEntry', id: 5 }).valid).toBe(false);
  });
  it('replaceHistory', () => {
    expect(validateAction({ type: 'replaceHistory', entries: [1, 2] }).valid).toBe(true);
    expect(validateAction({ type: 'replaceHistory', entries: 'str' }).valid).toBe(false);
    expect(
      validateAction({ type: 'replaceHistory', entries: Array.from({ length: 401 }) }).valid,
    ).toBe(false);
  });
  it('pickerMove', () => {
    expect(validateAction({ type: 'pickerMove', delta: -1 }).valid).toBe(true);
    expect(validateAction({ type: 'pickerMove', delta: 2 }).valid).toBe(false);
    expect(validateAction({ type: 'pickerMove', delta: 0.5 }).valid).toBe(false);
  });
  it('pickerSetMatches', () => {
    expect(validateAction({ type: 'pickerSetMatches', matches: ['a'] }).valid).toBe(true);
    expect(validateAction({ type: 'pickerSetMatches', matches: 's' }).valid).toBe(false);
  });
  it('fleetBatch', () => {
    expect(validateAction({ type: 'fleetBatch', actions: [{ type: 'clearInput' }] }).valid).toBe(
      true,
    );
    expect(validateAction({ type: 'fleetBatch', actions: 's' }).valid).toBe(false);
    const tooMany = Array.from({ length: MAX_BATCHED_ACTIONS + 1 });
    expect(validateAction({ type: 'fleetBatch', actions: tooMany }).valid).toBe(false);
  });
  it('fleetSeed', () => {
    expect(validateAction({ type: 'fleetSeed', entries: [{ id: 'a', name: 'x' }] }).valid).toBe(
      true,
    );
    expect(validateAction({ type: 'fleetSeed', entries: 's' }).valid).toBe(false);
  });
  it('id-based fleet and leader actions', () => {
    expect(validateAction({ type: 'fleetDelta', id: 'a' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetDelta', id: '' }).valid).toBe(false);
    expect(validateAction({ type: 'fleetDone', id: 'b' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetRemove', id: 'c' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetSpawn', id: 'd' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetStart', id: 'e' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetToolStart', id: 'f' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetToolEnd', id: 'g' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetTool', id: 'h' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetMessage', id: 'i' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetUsage', id: 'j' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetCost', id: 'k' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetConcurrency', id: 'l' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetCtxPct', id: 'm' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetBudgetExtended', id: 'n' }).valid).toBe(true);
    expect(validateAction({ type: 'fleetBudgetWarning', id: 'o' }).valid).toBe(true);
    expect(validateAction({ type: 'leaderCtxPct', id: 'p' }).valid).toBe(true);
    expect(validateAction({ type: 'leaderIterStart', id: 'q' }).valid).toBe(true);
    expect(validateAction({ type: 'leaderIterEnd', id: 'r' }).valid).toBe(true);
    expect(validateAction({ type: 'leaderToolStart', id: 's' }).valid).toBe(true);
    expect(validateAction({ type: 'leaderToolEnd', id: 't' }).valid).toBe(true);
  });
  it('setFleetChat', () => {
    expect(validateAction({ type: 'setFleetChat', mode: 'off' }).valid).toBe(true);
    expect(validateAction({ type: 'setFleetChat', mode: 'verbose' }).valid).toBe(false);
  });
  it('status', () => {
    expect(validateAction({ type: 'status', status: 'running' }).valid).toBe(true);
  });
  it('setViewportRows', () => {
    expect(validateAction({ type: 'setViewportRows', rows: 40 }).valid).toBe(true);
    expect(validateAction({ type: 'setViewportRows', rows: -1 }).valid).toBe(false);
  });
  it('collabSessionDone', () => {
    expect(
      validateAction({ type: 'collabSessionDone', sessionId: 's1', verdict: 'approve' }).valid,
    ).toBe(true);
    expect(
      validateAction({ type: 'collabSessionDone', sessionId: 's1', verdict: 'maybe' }).valid,
    ).toBe(false);
  });
  it('coordinatorEvent', () => {
    expect(validateAction({ type: 'coordinatorEvent', event: {} }).valid).toBe(true);
    expect(validateAction({ type: 'coordinatorEvent' }).valid).toBe(false);
  });
  it('sessionsPanelSet', () => {
    expect(validateAction({ type: 'sessionsPanelSet', sessions: [1] }).valid).toBe(true);
    expect(validateAction({ type: 'sessionsPanelSet', sessions: 's' }).valid).toBe(false);
    expect(
      validateAction({ type: 'sessionsPanelSet', sessions: Array.from({ length: 201 }) }).valid,
    ).toBe(false);
  });
  it('sessionsPanelBusy', () => {
    expect(validateAction({ type: 'sessionsPanelBusy', on: true }).valid).toBe(true);
    expect(validateAction({ type: 'sessionsPanelBusy', on: 1 }).valid).toBe(false);
  });
  it('sessionResumeConfirmSet', () => {
    expect(validateAction({ type: 'sessionResumeConfirmSet', sessionId: 's1' }).valid).toBe(true);
    expect(validateAction({ type: 'sessionResumeConfirmSet', sessionId: '' }).valid).toBe(false);
  });
  it('debugStreamStats', () => {
    expect(
      validateAction({
        type: 'debugStreamStats',
        chunkCount: 10,
        lastChunkSize: 256,
        totalBytes: 1024,
      }).valid,
    ).toBe(true);
    expect(
      validateAction({ type: 'debugStreamStats', chunkCount: -1, lastChunkSize: 0, totalBytes: 0 })
        .valid,
    ).toBe(false);
  });
  it('countdownTick', () => {
    expect(validateAction({ type: 'countdownTick', remainingSeconds: 5 }).valid).toBe(true);
    expect(validateAction({ type: 'countdownTick', remainingSeconds: -1 }).valid).toBe(false);
  });
  it('autonomyPickerOpen', () => {
    expect(validateAction({ type: 'autonomyPickerOpen', mode: 'off' }).valid).toBe(true);
    expect(validateAction({ type: 'autonomyPickerOpen', mode: 'invalid' }).valid).toBe(true);
  });
  it('enqueue', () => {
    expect(validateAction({ type: 'enqueue', item: {} }).valid).toBe(true);
    expect(validateAction({ type: 'enqueue', item: 'str' }).valid).toBe(true);
  });
  it('sendModePickerOpen', () => {
    expect(validateAction({ type: 'sendModePickerOpen', info: {} }).valid).toBe(true);
    expect(validateAction({ type: 'sendModePickerOpen' }).valid).toBe(true);
  });
  it('clearConfirmOpen/etc', () => {
    expect(validateAction({ type: 'clearConfirmOpen', info: {} }).valid).toBe(true);
    expect(validateAction({ type: 'clearConfirmOpen' }).valid).toBe(false);
    expect(validateAction({ type: 'clearConfirmSetValue', value: 'yes' }).valid).toBe(true);
    expect(validateAction({ type: 'clearConfirmSetValue', value: 'x'.repeat(101) }).valid).toBe(
      false,
    );
  });
  it('checkpointReceived', () => {
    expect(validateAction({ type: 'checkpointReceived', cp: { promptIndex: 0 } }).valid).toBe(true);
    expect(validateAction({ type: 'checkpointReceived' }).valid).toBe(false);
  });
  it('rewindOverlayOpen', () => {
    expect(validateAction({ type: 'rewindOverlayOpen', checkpoints: [1] }).valid).toBe(true);
    expect(validateAction({ type: 'rewindOverlayOpen', checkpoints: 's' }).valid).toBe(false);
  });
  it('goal actions', () => {
    expect(validateAction({ type: 'goalRunInit', title: 'test' }).valid).toBe(true);
    expect(validateAction({ type: 'goalRunInit', title: 'x'.repeat(501) }).valid).toBe(false);
    expect(
      validateAction({ type: 'goalRunPhaseUpdate', completedTasks: 1, totalTasks: 5 }).valid,
    ).toBe(true);
    expect(
      validateAction({ type: 'goalRunPhaseUpdate', completedTasks: -1, totalTasks: 5 }).valid,
    ).toBe(false);
    expect(validateAction({ type: 'goalRunRunningPhases', phaseIds: ['p1'] }).valid).toBe(true);
    expect(validateAction({ type: 'goalRunRunningPhases', phaseIds: 's' }).valid).toBe(false);
    expect(validateAction({ type: 'goalRunElapsed', ms: 100 }).valid).toBe(true);
    expect(validateAction({ type: 'goalRunElapsed', ms: -1 }).valid).toBe(false);
    expect(validateAction({ type: 'goalRunTaskActive', active: true }).valid).toBe(true);
    expect(validateAction({ type: 'goalRunTaskActive', active: 1 }).valid).toBe(false);
  });
  it('sddBoardSnapshot', () => {
    expect(validateAction({ type: 'sddBoardSnapshot', snapshot: {} }).valid).toBe(true);
    expect(validateAction({ type: 'sddBoardSnapshot' }).valid).toBe(false);
  });
  it('worktreeUpsert/Remove', () => {
    expect(validateAction({ type: 'worktreeUpsert', handleId: 'abc' }).valid).toBe(true);
    expect(validateAction({ type: 'worktreeUpsert', handleId: '' }).valid).toBe(false);
    expect(validateAction({ type: 'worktreeRemove', handleId: 'abc' }).valid).toBe(true);
    expect(validateAction({ type: 'worktreeRemove', handleId: '' }).valid).toBe(false);
  });
  it('collabBugFound', () => {
    expect(validateAction({ type: 'collabBugFound', bugId: 'b1' }).valid).toBe(true);
    expect(validateAction({ type: 'collabBugFound', bugId: '' }).valid).toBe(false);
  });
  it('collabSubagentSpawned', () => {
    expect(validateAction({ type: 'collabSubagentSpawned', role: 'r' }).valid).toBe(true);
    expect(validateAction({ type: 'collabSubagentSpawned', role: '' }).valid).toBe(false);
  });
  it('enhanceResult/refineFailureOpen', () => {
    expect(validateAction({ type: 'enhanceResult', result: {} }).valid).toBe(false);
    expect(validateAction({ type: 'enhanceResult' }).valid).toBe(false);
    expect(validateAction({ type: 'refineFailureOpen', info: {} }).valid).toBe(true);
    expect(validateAction({ type: 'refineFailureOpen' }).valid).toBe(false);
  });
  it('no-payload actions group', () => {
    expect(validateAction({ type: 'closeAllPanels' }).valid).toBe(true);
    expect(validateAction({ type: 'resetContextChip' }).valid).toBe(true);
    expect(validateAction({ type: 'refineFailureClose' }).valid).toBe(true);
    expect(validateAction({ type: 'sendModePickerClose' }).valid).toBe(true);
    expect(validateAction({ type: 'enhanceClose' }).valid).toBe(true);
    expect(validateAction({ type: 'enhanceBusy' }).valid).toBe(true);
    expect(validateAction({ type: 'countdownEnded' }).valid).toBe(true);
    expect(validateAction({ type: 'clearInput' }).valid).toBe(true);
    expect(validateAction({ type: 'toggleCoordinatorMonitor' }).valid).toBe(true);
  });
});

describe('validateFleetEntry', () => {
  it('valid', () => {
    const r = validateFleetEntry({ id: 'a1', name: 'agent1', status: 'running' });
    expect(r.valid).toBe(true);
  });
  it('rejects missing id', () => {
    expect(validateFleetEntry({ id: '', name: 'x', status: 'idle' }).valid).toBe(false);
  });
  it('rejects missing name', () => {
    expect(validateFleetEntry({ id: 'a', name: '', status: 'idle' }).valid).toBe(false);
  });
  it('rejects unknown status', () => {
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'zombie' }).valid).toBe(false);
  });
  it('rejects bad cost', () => {
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: NaN }).valid).toBe(false);
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: -1 }).valid).toBe(false);
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: Infinity }).valid).toBe(
      false,
    );
  });
  it('accepts cost 0', () => {
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle', cost: 0 }).valid).toBe(true);
  });
  it('rejects oversized streamingText', () => {
    const b = 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1);
    expect(
      validateFleetEntry({ id: 'a', name: 'x', status: 'running', streamingText: b }).valid,
    ).toBe(false);
  });
  it('rejects non-array recentTools', () => {
    expect(
      validateFleetEntry({
        id: 'a',
        name: 'x',
        status: 'running',
        recentTools: 'not-array' as unknown as unknown[],
      }).valid,
    ).toBe(false);
  });
  it('rejects oversized recentTools', () => {
    expect(
      validateFleetEntry({
        id: 'a',
        name: 'x',
        status: 'running',
        recentTools: Array.from({ length: 101 }),
      }).valid,
    ).toBe(false);
  });
  it('rejects non-array recentMessages', () => {
    const r = validateFleetEntry({
      id: 'a',
      name: 'x',
      status: 'running',
      recentMessages: 'not-array' as unknown as unknown[],
    });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('recentMessages');
  });
  it('rejects oversized recentMessages', () => {
    const r = validateFleetEntry({
      id: 'a',
      name: 'x',
      status: 'running',
      recentMessages: Array.from({ length: 51 }),
    }).valid;
    expect(r).toBe(false);
  });
  it('accepts recentTools and recentMessages', () => {
    expect(
      validateFleetEntry({
        id: 'a',
        name: 'x',
        status: 'running',
        recentTools: [1],
        recentMessages: [2],
      }).valid,
    ).toBe(true);
  });
  it('accepts undefined cost', () => {
    expect(validateFleetEntry({ id: 'a', name: 'x', status: 'idle' }).valid).toBe(true);
  });
});

describe('validateRestoreEntry', () => {
  it('valid user entry', () => {
    const r = validateRestoreEntry({ kind: 'user', text: 'hi' }, 0);
    expect(r.valid).toBe(true);
  });
  it('rejects non-object', () => {
    expect(validateRestoreEntry('str', 0).valid).toBe(false);
    expect(validateRestoreEntry(null, 0).valid).toBe(false);
    expect(validateRestoreEntry(42, 0).valid).toBe(false);
  });
  it('rejects unknown kind', () => {
    expect(validateRestoreEntry({ kind: 'fakekind' }, 0).valid).toBe(false);
  });
  it('accepts tool loosely', () => {
    expect(validateRestoreEntry({ kind: 'tool', input: 'big' }, 0).valid).toBe(true);
    expect(validateRestoreEntry({ kind: 'tool' }, 0).valid).toBe(true);
  });
  it('rejects oversized text', () => {
    expect(
      validateRestoreEntry({ kind: 'user', text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1) }, 0).valid,
    ).toBe(false);
  });
  it('accepts text-bearing without text', () => {
    expect(validateRestoreEntry({ kind: 'thinking' }, 0).valid).toBe(true);
  });
  it('accepts text-bearing with non-string text', () => {
    expect(validateRestoreEntry({ kind: 'assistant', text: 123 }, 0).valid).toBe(true);
  });
  it('accepts info/error/warn/turn-summary', () => {
    expect(validateRestoreEntry({ kind: 'info', text: 'm' }, 0).valid).toBe(true);
    expect(validateRestoreEntry({ kind: 'error', text: 'm' }, 0).valid).toBe(true);
    expect(validateRestoreEntry({ kind: 'warn', text: 'm' }, 0).valid).toBe(true);
    expect(validateRestoreEntry({ kind: 'turn-summary', text: 'm' }, 0).valid).toBe(true);
  });
  it('rejects oversized warn', () => {
    expect(
      validateRestoreEntry({ kind: 'warn', text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1) }, 0).valid,
    ).toBe(false);
  });
});

describe('safeDispatch', () => {
  it('dispatches valid actions', () => {
    const d = [];
    const r = safeDispatch({ type: 'clearInput' }, (a) => d.push(a));
    expect(r).toBe(true);
    expect(d.length).toBe(1);
  });
  it('rejects invalid and warns', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = [];
    const r = safeDispatch({ type: 'unknown' }, (a) => d.push(a));
    expect(r).toBe(false);
    expect(d.length).toBe(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ensureValidAction', () => {
  it('returns action on success', () => {
    const r = ensureValidAction({ type: 'closeAllPanels' });
    expect(r.type).toBe('closeAllPanels');
  });
  it('throws on invalid', () => {
    expect(() => ensureValidAction({ type: '' })).toThrow('Input validation rejected');
  });
});
