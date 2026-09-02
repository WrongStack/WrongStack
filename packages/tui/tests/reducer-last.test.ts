import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import { initial } from './reducer.test.js';

describe('reducer — last branches', () => {
  // ── confirmQueue (not confirm field) ─────────────────────────────
  it('confirmOpen adds to queue, confirmClose shifts', () => {
    const s = reducer(initial(), {
      type: 'confirmOpen',
      info: { text: 'Sure?' } as never as never,
    });
    expect(s.confirmQueue).toHaveLength(1);
    expect(s.confirmQueue[0]).toEqual({ text: 'Sure?' });
    const r = reducer(s, { type: 'confirmClose' });
    expect(r.confirmQueue).toHaveLength(0);
  });

  // ── clearConfirm uses action.info ────────────────────────────────
  it('clearConfirmOpen/SetValue/Close', () => {
    const open = reducer(initial(), {
      type: 'clearConfirmOpen',
      info: { text: 'Clear?' } as never,
    });
    expect(open.clearConfirm).toEqual({ text: 'Clear?' });
    const val = reducer(open, { type: 'clearConfirmSetValue', value: 'yes' });
    expect(val.clearConfirm?.value).toBe('yes');
    expect(reducer(val, { type: 'clearConfirmClose' }).clearConfirm).toBeNull();
  });

  // ── exitConfirm uses action.info ─────────────────────────────────
  it('exitConfirmOpen/Close', () => {
    const open = reducer(initial(), { type: 'exitConfirmOpen', info: { reason: 'exit' } as never });
    expect(open.exitConfirm).toEqual({ reason: 'exit' });
    expect(reducer(open, { type: 'exitConfirmClose' }).exitConfirm).toBeNull();
  });

  // ── slashConfirm uses action.info ────────────────────────────────
  it('slashConfirmOpen/Close', () => {
    const open = reducer(initial(), { type: 'slashConfirmOpen', info: { cmd: '/test' } as never });
    expect(open.slashConfirm).toEqual({ cmd: '/test' });
    expect(reducer(open, { type: 'slashConfirmClose' }).slashConfirm).toBeNull();
  });

  // ── escConfirm uses action.snapshot ──────────────────────────────
  it('escConfirmOpen/Close', () => {
    const snapshot = {
      runningTools: [],
      subagents: [],
      subagentsTerminated: 0,
      partialAssistantText: '',
    };
    const open = reducer(initial(), { type: 'escConfirmOpen', snapshot });
    expect(open.escConfirm).toEqual({ snapshot });
    expect(reducer(open, { type: 'escConfirmClose' }).escConfirm).toBeNull();
  });

  // ── collabSession actions (reducer uses collabSession, not collab)─
  it('collabSubagentSpawned bootstraps collabSession', () => {
    const r = reducer(initial(), {
      type: 'collabSubagentSpawned',
      role: 'bug-hunter',
      goal: 'find bugs',
    } as never);
    expect(r.collabSession).not.toBeNull();
    expect(r.collabSession?.overallVerdict).toBeNull();
    expect(r.collabSession?.timeline).toHaveLength(1);
  });
  it('collabSubagentSpawned is no-op when collabSession exists', () => {
    const s = reducer(initial(), {
      type: 'collabSubagentSpawned',
      role: 'hunter',
      goal: 'hunt',
    } as never);
    const r = reducer(s, { type: 'collabSubagentSpawned', role: 'second', goal: 'more' } as never);
    expect(r.collabSession?.timeline).toHaveLength(1); // not extended
  });
  it('collabBugFound bootstraps with description', () => {
    const r = reducer(initial(), {
      type: 'collabBugFound',
      sessionId: 's1',
      description: 'null pointer',
      severity: 'high',
    } as never);
    expect(r.collabSession).not.toBeNull();
    expect(r.collabSession?.bugCount).toBe(1);
  });
  it('collabBugFound appends to existing', () => {
    const s = reducer(initial(), {
      type: 'collabBugFound',
      sessionId: 's1',
      description: 'bug1',
      severity: 'high',
    } as never);
    const r = reducer(s, {
      type: 'collabBugFound',
      sessionId: 's1',
      description: 'bug2',
      severity: 'medium',
    } as never);
    expect(r.collabSession?.bugCount).toBe(2);
  });
  it('collabSessionDone sets verdict', () => {
    const s = reducer(initial(), {
      type: 'collabBugFound',
      sessionId: 's1',
      description: 'bug',
      severity: 'low',
    } as never);
    const r = reducer(s, {
      type: 'collabSessionDone',
      sessionId: 's1',
      verdict: 'approve',
      score: 9,
    } as never);
    expect(r.collabSession?.overallVerdict).toBe('approve');
  });
  it('collabSessionDone no-op when no session', () => {
    const r = reducer(initial(), {
      type: 'collabSessionDone',
      sessionId: 's1',
      verdict: 'approve',
      score: 9,
    } as never);
    expect(r.collabSession).toBeNull();
  });
});
