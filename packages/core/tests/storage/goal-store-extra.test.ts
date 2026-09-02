import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendJournal,
  emptyGoal,
  formatGoal,
  loadGoal,
  parseProgressFromText,
  recordProgress,
  saveGoal,
  setProgress,
  updateGoal,
  type GoalFile,
} from '../../src/storage/goal-store.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goal-extra-'));
  file = path.join(dir, 'goal.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('setProgress', () => {
  it('clamps to 0..100 and defaults the note', () => {
    const g = emptyGoal('mission');
    expect(setProgress(g, 150).progress).toBe(100);
    expect(setProgress(g, -5).progress).toBe(0);
    expect(setProgress(g, 40).progressNote).toBe('40% complete');
    expect(setProgress(g, 40, 'custom').progressNote).toBe('custom');
  });
});

describe('parseProgressFromText', () => {
  it('parses a bare percentage', () => {
    expect(parseProgressFromText('status [PROGRESS: 45%]')).toEqual({ progress: 45 });
  });
  it('parses a percentage with a note', () => {
    expect(parseProgressFromText('[progress: 80%] — 4/5 done')).toEqual({
      progress: 80,
      note: '4/5 done',
    });
  });
  it('clamps out-of-range percentages', () => {
    expect(parseProgressFromText('[PROGRESS: 250%]')?.progress).toBe(100);
  });
  it('returns null when there is no marker', () => {
    expect(parseProgressFromText('nothing here')).toBeNull();
  });
});

describe('recordProgress + trend', () => {
  it('records a snapshot and leaves trend undefined below 3 points', () => {
    let g = emptyGoal('m');
    g = recordProgress(g, 10);
    g = recordProgress(g, 20);
    expect(g.progress).toBe(20);
    expect(g.progressHistory?.length).toBe(2);
    expect(g.progressTrend).toBeUndefined();
  });

  it('detects an accelerating trend', () => {
    let g = emptyGoal('m');
    for (const p of [0, 10, 25, 45, 70]) g = recordProgress(g, p); // deltas avg > 2
    expect(g.progressTrend).toBe('accelerating');
  });

  it('detects a stalling trend', () => {
    let g = emptyGoal('m');
    for (const p of [80, 78, 75, 72, 70]) g = recordProgress(g, p); // negative deltas
    expect(g.progressTrend).toBe('stalling');
  });

  it('detects a steady trend', () => {
    let g = emptyGoal('m');
    for (const p of [50, 51, 51, 52, 52]) g = recordProgress(g, p); // tiny positive deltas
    expect(g.progressTrend).toBe('steady');
  });

  it('trims progress history to the cap', () => {
    let g = emptyGoal('m');
    for (let i = 0; i < 210; i++) g = recordProgress(g, i % 100);
    expect(g.progressHistory?.length).toBe(200);
  });
});

describe('updateGoal', () => {
  it('creates/updates the goal under a lock', async () => {
    await updateGoal(file, () => emptyGoal('first'));
    const loaded = await loadGoal(file);
    expect(loaded?.goal).toBe('first');

    await updateGoal(file, (cur) => ({ ...(cur as GoalFile), goal: 'second' }));
    expect((await loadGoal(file))?.goal).toBe('second');
  });

  it('deletes the goal file when fn returns null', async () => {
    await saveGoal(file, emptyGoal('to delete'));
    await updateGoal(file, () => null);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('tolerates a delete when the file is already gone (best-effort)', async () => {
    // No file exists; fn returns null → unlink throws ENOENT → swallowed.
    await expect(updateGoal(file, () => null)).resolves.toBeUndefined();
  });
});

describe('saveGoal error path', () => {
  it('wraps an atomic-write failure in an FsError', async () => {
    // Target a directory path → atomicWrite cannot write a file there.
    await expect(saveGoal(dir, emptyGoal('x'))).rejects.toThrow();
  });
});

describe('loadGoal error paths', () => {
  it('returns null for invalid schema', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 2, goal: 'x' }));
    expect(await loadGoal(file)).toBeNull();
  });

  it('returns null for non-JSON content', async () => {
    await fs.writeFile(file, 'not json at all');
    expect(await loadGoal(file)).toBeNull();
  });

  it('rethrows a non-ENOENT read error (path is a directory)', async () => {
    await expect(loadGoal(dir)).rejects.toThrow();
  });
});

describe('formatGoal branches', () => {
  it('renders refined goal, progress bar, trend, deliverables, and journal', () => {
    let g = emptyGoal('build the thing properly with lots of detail here for the snippet');
    g = {
      ...g,
      refinedGoal: 'Refined: ship feature X with tests',
      progress: 60,
      progressNote: 'over halfway',
      progressTrend: 'accelerating',
      deliverables: ['[x] done item', 'pending item'],
    };
    g = appendJournal(g, { source: 'todo', task: 'did a thing', status: 'success', costUsd: 0.01 });
    g = appendJournal(g, { source: 'git', task: 'failed thing', status: 'failure', note: 'oops' });
    g = appendJournal(g, { source: 'manual', task: 'aborted thing', status: 'aborted' });
    const out = formatGoal(g);
    expect(out).toContain('Refined: ship feature X');
    expect(out).toContain('(original:');
    expect(out).toMatch(/60%/);
    expect(out).toContain('over halfway');
    expect(out).toContain('accelerating');
    expect(out).toContain('✓'); // done deliverable + success journal
    expect(out).toContain('did a thing');
    expect(out).toContain('oops');
  });

  it('renders the stalling and steady trend icons', () => {
    const base = emptyGoal('m');
    expect(formatGoal({ ...base, progress: 10, progressTrend: 'stalling' })).toContain('stalling');
    expect(formatGoal({ ...base, progress: 10, progressTrend: 'steady' })).toContain('steady');
  });
});
