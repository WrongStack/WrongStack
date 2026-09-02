import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendJournal,
  emptyGoal,
  formatGoal,
  goalFilePath,
  loadGoal,
  MAX_JOURNAL_ENTRIES,
  saveGoal,
  summarizeUsage,
} from '../../src/storage/goal-store.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-'));
}

describe('goal-store', () => {
  it('round-trips a goal through save/load', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'goal.json');
    try {
      const goal = emptyGoal('Ship the v1');
      await saveGoal(file, goal);
      const loaded = await loadGoal(file);
      expect(loaded?.goal).toBe('Ship the v1');
      expect(loaded?.iterations).toBe(0);
      expect(loaded?.engineState).toBe('idle');
      expect(loaded?.journal).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file is missing', async () => {
    const dir = await tmpDir();
    try {
      const loaded = await loadGoal(path.join(dir, 'absent.json'));
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for corrupted JSON instead of throwing', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'goal.json');
    try {
      await fs.writeFile(file, '{ this is { not :: valid');
      const loaded = await loadGoal(file);
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when version is wrong', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'goal.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 99, goal: 'x', journal: [] }));
      const loaded = await loadGoal(file);
      expect(loaded).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('appendJournal bumps iteration counters', () => {
    const goal = emptyGoal('do stuff');
    const next = appendJournal(goal, { source: 'todo', task: 'first', status: 'success' });
    expect(next.iterations).toBe(1);
    expect(next.journal).toHaveLength(1);
    expect(next.journal[0]?.iteration).toBe(1);
    expect(next.journal[0]?.source).toBe('todo');

    const after = appendJournal(next, {
      source: 'git',
      task: 'second',
      status: 'failure',
      note: 'bad',
    });
    expect(after.iterations).toBe(2);
    expect(after.journal[1]?.iteration).toBe(2);
    expect(after.journal[1]?.note).toBe('bad');
  });

  it('trims the journal ring buffer to MAX_JOURNAL_ENTRIES', () => {
    let goal = emptyGoal('stress');
    // Stuff 5 over the cap to verify oldest are evicted first.
    for (let i = 0; i < MAX_JOURNAL_ENTRIES + 5; i++) {
      goal = appendJournal(goal, { source: 'brainstorm', task: `task-${i}`, status: 'success' });
    }
    expect(goal.journal).toHaveLength(MAX_JOURNAL_ENTRIES);
    expect(goal.iterations).toBe(MAX_JOURNAL_ENTRIES + 5);
    // Oldest survivor is the (5+1)th entry, newest is the last.
    expect(goal.journal[0]?.task).toBe('task-5');
    expect(goal.journal[goal.journal.length - 1]?.task).toBe(`task-${MAX_JOURNAL_ENTRIES + 4}`);
  });

  it('does not mutate the input goal in appendJournal', () => {
    const goal = emptyGoal('immut');
    const before = JSON.stringify(goal);
    appendJournal(goal, { source: 'todo', task: 'x', status: 'success' });
    expect(JSON.stringify(goal)).toBe(before);
  });

  it('formatGoal includes header + recent journal', () => {
    let goal = emptyGoal('Mission X');
    goal = appendJournal(goal, {
      source: 'todo',
      task: 'pick low-hanging fruit',
      status: 'success',
    });
    goal = appendJournal(goal, {
      source: 'git',
      task: 'finish WIP',
      status: 'failure',
      note: 'tests red',
    });
    const out = formatGoal(goal);
    expect(out).toContain('Goal: Mission X');
    expect(out).toContain('Iterations: 2');
    expect(out).toContain('[todo] pick low-hanging fruit');
    expect(out).toContain('[git] finish WIP');
    expect(out).toContain('tests red');
  });

  it('goalFilePath resolves to the canonical per-project goal path (same as resolveWstackPaths.projectGoal)', () => {
    const p = goalFilePath('/projects/foo');
    const expected = resolveWstackPaths({ projectRoot: '/projects/foo' }).projectGoal;
    expect(p).toBe(expected);
    // Single source of truth: lives under the global root's projects/ dir
    // (~/.wrongstack or the WRONGSTACK_HOME override), NOT the repo.
    expect(p.replace(/\\/g, '/')).toContain('/projects/foo-');
    expect(p.replace(/\\/g, '/')).not.toContain('/projects/foo/.wrongstack');
  });

  it('summarizeUsage aggregates tokens + cost across the journal', () => {
    let goal = emptyGoal('cost test');
    goal = appendJournal(goal, {
      source: 'todo',
      task: 'one',
      status: 'success',
      tokens: { input: 1000, output: 500 },
      costUsd: 0.01,
    });
    goal = appendJournal(goal, {
      source: 'git',
      task: 'two',
      status: 'failure',
      tokens: { input: 200, output: 50 },
      costUsd: 0.003,
    });
    // Legacy entry without telemetry — should be ignored, not crash.
    goal = appendJournal(goal, { source: 'brainstorm', task: 'three', status: 'success' });

    const u = summarizeUsage(goal);
    expect(u.totalInputTokens).toBe(1200);
    expect(u.totalOutputTokens).toBe(550);
    expect(u.totalCostUsd).toBeCloseTo(0.013, 6);
    expect(u.iterationsWithUsage).toBe(2);
  });

  it('formatGoal includes Spent line when telemetry is present', () => {
    let goal = emptyGoal('with cost');
    goal = appendJournal(goal, {
      source: 'todo',
      task: 'paid work',
      status: 'success',
      tokens: { input: 100, output: 50 },
      costUsd: 0.0125,
    });
    const out = formatGoal(goal);
    expect(out).toContain('Spent: $0.0125');
    expect(out).toContain('in 100 / out 50 tokens');
    expect(out).toContain('paid work ($0.0125)');
  });

  it('formatGoal omits Spent line when no entries have telemetry', () => {
    let goal = emptyGoal('no cost');
    goal = appendJournal(goal, { source: 'todo', task: 'free work', status: 'success' });
    const out = formatGoal(goal);
    expect(out).not.toContain('Spent:');
  });
});
