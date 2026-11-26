import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearGoalManually } from '../../src/execution/eternal-completion.js';

const ROCKET = '\u{1F680}';

/**
 * F2651: the eternal-goal journal caps the task/note at 240 UTF-16 units with a
 * plain `.slice`. The note is model/user text persisted to the goal journal and
 * re-rendered by `/goal`.
 */
describe('eternal goal journal keeps valid UTF-16 (F2651)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'eternal-completion-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function clearWith(note: string): Promise<string | undefined> {
    const captured: { note?: string } = {};
    const host = {
      loadGoal: async () => ({ goal: 'g', goalState: 'active', journal: [] }),
      goalPath: path.join(dir, 'goal.json'),
      opts: {},
      appendIterationEntry: async (entry: { note?: string }) => {
        captured.note = entry.note;
      },
      onEternalStop: () => {},
    };
    await clearGoalManually.call(host as never, note);
    return captured.note;
  }

  it('drops the orphaned half in a manual-clear note', async () => {
    const note = await clearWith(`${'n'.repeat(239)}${ROCKET}tail`);

    expect(note?.isWellFormed()).toBe(true);
    expect(note).toBe('n'.repeat(239));
  });

  it('keeps a short note unchanged (control)', async () => {
    expect(await clearWith('short note')).toBe('short note');
  });
});
