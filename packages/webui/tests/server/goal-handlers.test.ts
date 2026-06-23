import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point goal resolution at a temp project root by mocking resolveWstackPaths.
const tmpGoal = vi.hoisted(() => ({ path: '' }));
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return { ...actual, resolveWstackPaths: () => ({ projectGoal: tmpGoal.path }) };
});

const { handleGoalGet } = await import('../../src/server/goal-handlers.js');

describe('handleGoalGet', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(process.env.TEMP || '/tmp', `goaltest-${randomBytes(4).toString('hex')}`);
    fsSync.mkdirSync(dir, { recursive: true });
    tmpGoal.path = path.join(dir, 'goal.json');
  });

  afterEach(() => {
    try {
      fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('broadcasts the parsed goal when the file exists', async () => {
    const goal = { mission: 'ship it', goalState: 'active' };
    fsSync.writeFileSync(tmpGoal.path, JSON.stringify(goal));
    const sent: object[] = [];
    await handleGoalGet('/proj', (m) => sent.push(m));
    expect(sent).toEqual([{ type: 'goal.updated', payload: goal }]);
  });

  it('broadcasts null when the goal file is missing', async () => {
    const sent: Array<{ type: string; payload: unknown }> = [];
    await handleGoalGet('/proj', (m) => sent.push(m as never));
    expect(sent[0]).toEqual({ type: 'goal.updated', payload: null });
  });

  it('broadcasts null when the goal file is malformed', async () => {
    fsSync.writeFileSync(tmpGoal.path, '{ not json');
    const sent: Array<{ type: string; payload: unknown }> = [];
    await handleGoalGet('/proj', (m) => sent.push(m as never));
    expect(sent[0]).toEqual({ type: 'goal.updated', payload: null });
  });
});
