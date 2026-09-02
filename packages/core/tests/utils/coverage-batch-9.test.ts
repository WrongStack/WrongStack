import { describe, it, expect } from 'vitest';
import { extractToolCallEnds } from '../../src/storage/session-tool-call-ends.js';
import { DirectorBtwNotes } from '../../src/coordination/director/director-btw-notes.js';
import {
  FleetSpawnBudgetError,
  FleetCostCapError,
  FleetTokenCapError,
  FleetContextOverflowError,
} from '../../src/coordination/director/director-errors.js';

// ── extractToolCallEnds ──────────────────────────────────────────────────

describe('extractToolCallEnds', () => {
  it('extracts tool_call_end events', () => {
    const events = [
      {
        type: 'tool_call_end',
        name: 'read',
        id: 'tc1',
        durationMs: 50,
        ok: true,
        outputBytes: 100,
        outputTokens: 25,
        outputLines: 3,
      },
      { type: 'tool_call_start', name: 'write', id: 'tc2' },
    ] as any;
    const ends = extractToolCallEnds(events);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ name: 'read', id: 'tc1', durationMs: 50, ok: true });
  });

  it('defaults ok to true when undefined', () => {
    const events = [{ type: 'tool_call_end', name: 'bash', id: 'tc1', durationMs: 10 }] as any;
    const ends = extractToolCallEnds(events);
    expect(ends[0]?.ok).toBe(true);
  });

  it('uses outputSize as fallback when outputBytes undefined', () => {
    const events = [{ type: 'tool_call_end', name: 'grep', id: 'tc1', outputSize: 999 }] as any;
    const ends = extractToolCallEnds(events);
    expect(ends[0]?.outputBytes).toBe(999);
  });

  it('returns empty array for non-tool events', () => {
    const events = [{ type: 'user_input', content: 'hi' }] as any;
    expect(extractToolCallEnds(events)).toEqual([]);
  });
});

// ── DirectorBtwNotes ─────────────────────────────────────────────────────

describe('DirectorBtwNotes', () => {
  it('adds and drains notes in FIFO order', () => {
    const notes = new DirectorBtwNotes();
    notes.add('first');
    notes.add('second');
    expect(notes.drain()).toEqual(['first', 'second']);
  });

  it('drain clears the buffer', () => {
    const notes = new DirectorBtwNotes();
    notes.add('note');
    notes.drain();
    expect(notes.drain()).toEqual([]);
  });

  it('ignores empty/whitespace-only notes', () => {
    const notes = new DirectorBtwNotes();
    notes.add('');
    notes.add('   ');
    expect(notes.peek()).toEqual([]);
  });

  it('trims notes', () => {
    const notes = new DirectorBtwNotes();
    notes.add('  spaced  ');
    expect(notes.peek()).toEqual(['spaced']);
  });

  it('caps at 20 entries (evicts oldest)', () => {
    const notes = new DirectorBtwNotes();
    for (let i = 0; i < 25; i++) notes.add(`note-${i}`);
    const drained = notes.drain();
    expect(drained).toHaveLength(20);
    expect(drained[0]).toBe('note-5'); // first 5 evicted
    expect(drained[19]).toBe('note-24');
  });

  it('peek returns a copy (does not drain)', () => {
    const notes = new DirectorBtwNotes();
    notes.add('n1');
    const peeked = notes.peek();
    peeked.push('injected');
    expect(notes.peek()).toEqual(['n1']);
  });

  it('add returns the pending count', () => {
    const notes = new DirectorBtwNotes();
    expect(notes.add('a')).toBe(1);
    expect(notes.add('b')).toBe(2);
  });
});

// ── director-errors ──────────────────────────────────────────────────────

describe('FleetSpawnBudgetError', () => {
  it('creates max_spawns error with default message', () => {
    const err = new FleetSpawnBudgetError('max_spawns', 10, 11);
    expect(err.name).toBe('FleetSpawnBudgetError');
    expect(err.kind).toBe('max_spawns');
    expect(err.limit).toBe(10);
    expect(err.observed).toBe(11);
    expect(err.message).toContain('spawn budget exceeded');
    expect(err.message).toContain('#11');
    expect(err.message).toContain('10');
  });

  it('creates max_spawn_depth error with default message', () => {
    const err = new FleetSpawnBudgetError('max_spawn_depth', 2, 3);
    expect(err.kind).toBe('max_spawn_depth');
    expect(err.message).toContain('depth');
    expect(err.message).toContain('3');
  });

  it('accepts a custom message', () => {
    const err = new FleetSpawnBudgetError('max_spawns', 5, 6, 'custom');
    expect(err.message).toBe('custom');
  });
});

describe('FleetCostCapError', () => {
  it('formats cost values in message', () => {
    const err = new FleetCostCapError(1.5, 2.5);
    expect(err.name).toBe('FleetCostCapError');
    expect(err.kind).toBe('max_cost_usd');
    expect(err.limit).toBe(1.5);
    expect(err.observed).toBe(2.5);
    expect(err.message).toContain('1.5000');
    expect(err.message).toContain('2.5000');
  });
});

describe('FleetTokenCapError', () => {
  it('rounds token values in message', () => {
    const err = new FleetTokenCapError(10000.5, 15000.7);
    expect(err.name).toBe('FleetTokenCapError');
    expect(err.kind).toBe('max_tokens');
    expect(err.message).toContain('10001');
    expect(err.message).toContain('15001');
  });
});

describe('FleetContextOverflowError', () => {
  it('includes token counts in message', () => {
    const err = new FleetContextOverflowError(50000, 60000);
    expect(err.name).toBe('FleetContextOverflowError');
    expect(err.kind).toBe('max_context_load');
    expect(err.message).toContain('60000');
    expect(err.message).toContain('50000');
    expect(err.message).toContain('Compact');
  });
});
