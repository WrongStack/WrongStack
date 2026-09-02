/**
 * Tests for src/lib/goal.ts — GoalState parsing and transformation.
 * Pure function with no React or external dependencies.
 */

import { describe, expect, it } from 'vitest';
import {
  parseGoalState,
  type GoalDeliverable,
  type GoalJournalEntry,
  type GoalState,
} from '../../src/lib/goal';

// ─── Null / invalid input ─────────────────────────────────────────────────────

describe('parseGoalState — null guard', () => {
  it('returns null for null input', () => {
    expect(parseGoalState(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseGoalState(undefined as never as Record<string, unknown>)).toBeNull();
  });

  it('returns null when goal is missing', () => {
    expect(parseGoalState({ goal: undefined as never as string })).toBeNull();
  });

  it('returns null when goal is an empty string', () => {
    expect(parseGoalState({ goal: '' })).toBeNull();
  });

  it('returns null when goal is whitespace-only', () => {
    expect(parseGoalState({ goal: '   \t\n  ' })).toBeNull();
  });

  it('returns null when goal is a non-string type', () => {
    expect(parseGoalState({ goal: null as never as string })).toBeNull();
    expect(parseGoalState({ goal: null as string })).toBeNull();
  });
});

// ─── Minimal valid input ───────────────────────────────────────────────────────

describe('parseGoalState — minimal valid input', () => {
  it('returns a GoalState for a valid minimal goal', () => {
    const result = parseGoalState({ goal: 'Ship the feature' });
    expect(result).not.toBeNull();
    expect(result!.goal).toBe('Ship the feature');
    expect(result!.goalState).toBe('active');
    expect(result!.iterations).toBe(0);
    expect(result!.progress).toBe(0);
  });

  it('includes refinedGoal when present as a string', () => {
    const result = parseGoalState({ goal: 'Ship it', refinedGoal: 'Ship v2' });
    expect(result!.refinedGoal).toBe('Ship v2');
  });

  it('omits refinedGoal when not a string', () => {
    const result = parseGoalState({ goal: 'Ship it', refinedGoal: 42 });
    expect(result!.refinedGoal).toBeUndefined();
  });

  it('accepts all five valid goalState values', () => {
    const states: GoalState['goalState'][] = [
      'active',
      'paused',
      'completed',
      'failed',
      'abandoned',
    ];
    for (const gs of states) {
      const result = parseGoalState({ goal: 'Test', goalState: gs });
      expect(result!.goalState).toBe(gs);
    }
  });

  it('defaults invalid goalState to active', () => {
    const result = parseGoalState({ goal: 'Test', goalState: 'not-a-state' });
    expect(result!.goalState).toBe('active');
    expect(result!.goal).toBe('Test');
  });
});

// ─── Numeric fields ────────────────────────────────────────────────────────────

describe('parseGoalState — iterations and progress', () => {
  it('preserves numeric iterations', () => {
    const result = parseGoalState({ goal: 'Test', iterations: 42 });
    expect(result!.iterations).toBe(42);
  });

  it('defaults iterations to 0 when not a number', () => {
    expect(parseGoalState({ goal: 'Test', iterations: '10' })!.iterations).toBe(0);
    expect(parseGoalState({ goal: 'Test', iterations: null })!.iterations).toBe(0);
  });

  it('preserves numeric progress', () => {
    const result = parseGoalState({ goal: 'Test', progress: 75 });
    expect(result!.progress).toBe(75);
  });

  it('defaults progress to 0 when not a number', () => {
    expect(parseGoalState({ goal: 'Test', progress: '50' })!.progress).toBe(0);
    expect(parseGoalState({ goal: 'Test', progress: undefined })!.progress).toBe(0);
  });

  it('caps progress at 100 (data may exceed)', () => {
    // The parser itself does not clamp; we test what it stores
    const result = parseGoalState({ goal: 'Test', progress: 150 });
    expect(result!.progress).toBe(150);
  });
});

// ─── progressTrend mapping ─────────────────────────────────────────────────────

describe('parseGoalState — progressTrend mapping', () => {
  it('maps accelerating → up', () => {
    expect(parseGoalState({ goal: 'T', progressTrend: 'accelerating' })!.progressTrend).toBe('up');
  });

  it('maps stalling → down', () => {
    expect(parseGoalState({ goal: 'T', progressTrend: 'stalling' })!.progressTrend).toBe('down');
  });

  it('maps steady → stable', () => {
    expect(parseGoalState({ goal: 'T', progressTrend: 'steady' })!.progressTrend).toBe('stable');
  });

  it('returns undefined for unknown progressTrend values', () => {
    const unknown = ['fast', 'slow', '', 'UP', null, undefined];
    for (const v of unknown) {
      expect(
        parseGoalState({ goal: 'T', progressTrend: v as string })!.progressTrend,
      ).toBeUndefined();
    }
  });

  it('omits progressTrend when field is absent', () => {
    expect(parseGoalState({ goal: 'T' })!.progressTrend).toBeUndefined();
  });
});

// ─── progressNote ─────────────────────────────────────────────────────────────

describe('parseGoalState — progressNote', () => {
  it('includes progressNote when a non-empty string', () => {
    const result = parseGoalState({ goal: 'T', progressNote: 'On track' });
    expect(result!.progressNote).toBe('On track');
  });

  it('omits progressNote when not a string', () => {
    expect(parseGoalState({ goal: 'T', progressNote: 42 })!.progressNote).toBeUndefined();
    // Empty string is still a string — the code returns it as-is.
    expect(parseGoalState({ goal: 'T', progressNote: '' })!.progressNote).toBe('');
  });
});

// ─── Deliverables ─────────────────────────────────────────────────────────────

describe('parseGoalState — deliverables parsing', () => {
  it('returns undefined when deliverables is not an array', () => {
    expect(parseGoalState({ goal: 'T', deliverables: 'not-array' })!.deliverables).toBeUndefined();
    expect(parseGoalState({ goal: 'T', deliverables: null })!.deliverables).toBeUndefined();
  });

  it('returns empty array when deliverables is an empty array', () => {
    // Array.isArray([]) === true — empty array is still an array, returned as-is.
    expect(parseGoalState({ goal: 'T', deliverables: [] })!.deliverables).toEqual([]);
  });

  it('parses string deliverables with auto id and status', () => {
    // String deliverable — status inferred from done markers
    const result = parseGoalState({
      goal: 'T',
      deliverables: ['[x] design done', 'Implement feature'],
    });
    const d = result!.deliverables!;
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ id: 'd0', text: '[x] design done', status: 'done' });
    expect(d[1]).toMatchObject({ id: 'd1', text: 'Implement feature', status: 'pending' });
  });

  it.each([
    ['[x] done', 'done'],
    ['[X] also done', 'done'],
    ['[✓] checkmark', 'done'],
    ['✅ emoji done', 'done'],
    ['(done) parens', 'done'],
    ['DONE no parens', 'pending'],
    ['pending item', 'pending'],
    ['in progress', 'pending'],
    ['not done', 'pending'],
    ['[ ] unchecked', 'pending'],
  ])('status detection: %s → %s', (text, expectedStatus) => {
    const result = parseGoalState({ goal: 'T', deliverables: [text] });
    expect(result!.deliverables![0].status).toBe(expectedStatus);
  });

  it('passes through GoalDeliverable objects unchanged', () => {
    const obj: GoalDeliverable = { id: 'custom-id', text: 'My task', status: 'done' };
    const result = parseGoalState({ goal: 'T', deliverables: [obj] });
    expect(result!.deliverables![0]).toEqual(obj);
  });

  it('mixes string and object deliverables in the same array', () => {
    const obj: GoalDeliverable = { id: 'OBJ', text: 'object task', status: 'pending' };
    const result = parseGoalState({
      goal: 'T',
      deliverables: ['[x] string done', obj],
    });
    expect(result!.deliverables).toHaveLength(2);
    expect(result!.deliverables![0].status).toBe('done');
    expect(result!.deliverables![1]).toEqual(obj);
  });

  it('assigns auto-incremented ids to string deliverables', () => {
    const result = parseGoalState({
      goal: 'T',
      deliverables: ['a', 'b', 'c'],
    });
    const ids = result!.deliverables!.map((d) => d.id);
    expect(ids).toEqual(['d0', 'd1', 'd2']);
  });
});

// ─── Journal ───────────────────────────────────────────────────────────────────

describe('parseGoalState — journal', () => {
  it('includes journal entries when present as an array', () => {
    const entries: GoalJournalEntry[] = [
      { iteration: 1, task: 'Write tests' },
      { iteration: 2, status: 'in_progress' },
    ];
    const result = parseGoalState({ goal: 'T', journal: entries });
    expect(result!.journal).toEqual(entries);
  });

  it('omits journal when not an array', () => {
    expect(parseGoalState({ goal: 'T', journal: {} })!.journal).toBeUndefined();
    expect(parseGoalState({ goal: 'T', journal: 'not-array' })!.journal).toBeUndefined();
  });

  it('drops entries with a missing or non-numeric iteration', () => {
    // GoalPanel uses entry.iteration as both the React key and the row
    // label. A malformed entry (missing iteration or a string) would
    // produce a non-unique key warning and `#{undefined}` in the UI.
    // The parser must drop such rows instead of passing them through.
    const raw = {
      goal: 'T',
      journal: [
        { iteration: 1, task: 'valid' },
        { task: 'no iteration field at all' },
        { iteration: '2' },
        { iteration: undefined },
        null,
        'not-an-object',
        { iteration: NaN },
        { iteration: Infinity },
      ],
    };
    const result = parseGoalState(raw);
    expect(result!.journal).toEqual([{ iteration: 1, task: 'valid' }]);
  });

  it('drops entries with wrong-typed optional fields', () => {
    // Anything that violates the GoalJournalEntry contract — e.g.,
    // a numeric `task` or a string `progress` — is dropped so we never
    // hand the panel an entry that would render undefined or crash a
    // numeric formatter downstream.
    const raw = {
      goal: 'T',
      journal: [
        { iteration: 1, task: 123 },
        { iteration: 2, progress: '50' },
        { iteration: 3, progressNote: 5 },
        { iteration: 4, timestamp: 1234567890 },
        // Valid control row
        { iteration: 5, task: 'ok', progress: 50, timestamp: 'now' },
      ],
    };
    const result = parseGoalState(raw);
    expect(result!.journal).toEqual([{ iteration: 5, task: 'ok', progress: 50, timestamp: 'now' }]);
  });

  it('drops entries with wrong-typed status field (line 51)', () => {
    const raw = {
      goal: 'T',
      journal: [
        { iteration: 1, status: 123 }, // numeric status → dropped
        { iteration: 2, status: true }, // boolean status → dropped
        { iteration: 3, status: 'active' }, // valid string status → kept
      ],
    };
    const result = parseGoalState(raw);
    expect(result!.journal).toHaveLength(1);
    expect(result!.journal![0].iteration).toBe(3);
    expect(result!.journal![0].status).toBe('active');
  });

  it('drops entries with non-finite progress (NaN/Infinity)', () => {
    const raw = {
      goal: 'T',
      journal: [
        { iteration: 1, progress: Number.NaN }, // NaN → dropped
        { iteration: 2, progress: Number.POSITIVE_INFINITY }, // Infinity → dropped
        { iteration: 3, progress: 50 }, // valid → kept
      ],
    };
    const result = parseGoalState(raw);
    expect(result!.journal).toHaveLength(1);
    expect(result!.journal![0].iteration).toBe(3);
    expect(result!.journal![0].progress).toBe(50);
  });

  it('preserves optional string fields that are missing or undefined', () => {
    // A row with only the required `iteration` field is valid.
    // Optional fields are allowed to be absent.
    const raw = {
      goal: 'T',
      journal: [
        { iteration: 1 },
        {
          iteration: 2,
          task: undefined,
          status: undefined,
          progress: undefined,
          progressNote: undefined,
          timestamp: undefined,
        },
      ],
    };
    const result = parseGoalState(raw);
    expect(result!.journal).toEqual([
      { iteration: 1 },
      {
        iteration: 2,
        task: undefined,
        status: undefined,
        progress: undefined,
        progressNote: undefined,
        timestamp: undefined,
      },
    ]);
  });
});

// ─── lastTask / lastStatus ─────────────────────────────────────────────────────

describe('parseGoalState — lastTask and lastStatus', () => {
  it('includes lastTask when a string', () => {
    expect(parseGoalState({ goal: 'T', lastTask: 'Running tests' })!.lastTask).toBe(
      'Running tests',
    );
  });

  it('omits lastTask when not a string', () => {
    expect(parseGoalState({ goal: 'T', lastTask: 123 })!.lastTask).toBeUndefined();
    // Empty string is still a string — the code returns it as-is.
    expect(parseGoalState({ goal: 'T', lastTask: '' })!.lastTask).toBe('');
  });

  it('includes lastStatus when a string', () => {
    expect(parseGoalState({ goal: 'T', lastStatus: 'completed' })!.lastStatus).toBe('completed');
  });

  it('omits lastStatus when not a string', () => {
    expect(parseGoalState({ goal: 'T', lastStatus: null })!.lastStatus).toBeUndefined();
  });
});

// ─── Full integration ──────────────────────────────────────────────────────────

describe('parseGoalState — full GoalState', () => {
  it('assembles all fields into a complete GoalState', () => {
    const result = parseGoalState({
      goal: 'Ship v2',
      refinedGoal: 'Ship v2.1',
      goalState: 'completed',
      iterations: 14,
      progress: 100,
      progressNote: 'All tests passing',
      progressTrend: 'steady',
      deliverables: [
        { id: 'existing', text: 'Already done', status: 'done' },
        '[x] Code written',
        'Write tests',
      ],
      journal: [{ iteration: 1, task: 'Init' }],
      lastTask: 'Review PR',
      lastStatus: 'success',
    });

    expect(result).toMatchObject({
      goal: 'Ship v2',
      refinedGoal: 'Ship v2.1',
      goalState: 'completed',
      iterations: 14,
      progress: 100,
      progressNote: 'All tests passing',
      progressTrend: 'stable',
      lastTask: 'Review PR',
      lastStatus: 'success',
      deliverables: [
        { id: 'existing', text: 'Already done', status: 'done' },
        { id: 'd1', text: '[x] Code written', status: 'done' },
        { id: 'd2', text: 'Write tests', status: 'pending' },
      ],
    });
    expect(result!.journal).toHaveLength(1);
    expect(result!.journal![0].iteration).toBe(1);
  });
});
