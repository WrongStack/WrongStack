import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BuildContext } from '@wrongstack/contracts/types/system-prompt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAutonomyPromptContributor } from '../../src/execution/autonomy-prompt-contributor.js';
import {
  appendJournal,
  emptyGoal,
  type GoalFile,
  goalFilePath,
  saveGoal,
} from '../../src/storage/goal-store.js';

const emptyCtx: BuildContext = {
  cwd: '/tmp',
  projectRoot: '/tmp',
  tools: [],
} as never as BuildContext;

describe('makeAutonomyPromptContributor', () => {
  let tmp: string;
  let projectRoot: string;
  let goalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-autopcb-'));
    projectRoot = tmp;
    goalPath = goalFilePath(projectRoot);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns [] when enabled() is false', async () => {
    await saveGoal(goalPath, emptyGoal('mission text'));
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => false,
    });
    const blocks = await contrib(emptyCtx);
    expect(blocks).toEqual([]);
  });

  it('returns [] when no goal file exists', async () => {
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const blocks = await contrib(emptyCtx);
    expect(blocks).toEqual([]);
  });

  it('returns [] when the goal is completed', async () => {
    const goal: GoalFile = { ...emptyGoal('done already'), goalState: 'completed' };
    await saveGoal(goalPath, goal);
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const blocks = await contrib(emptyCtx);
    expect(blocks).toEqual([]);
  });

  it('returns [] when the goal is abandoned', async () => {
    const goal: GoalFile = { ...emptyGoal('gave up'), goalState: 'abandoned' };
    await saveGoal(goalPath, goal);
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const blocks = await contrib(emptyCtx);
    expect(blocks).toEqual([]);
  });

  it('injects an ephemeral block carrying the mission text and iteration counter', async () => {
    const goal = emptyGoal('refactor the parser');
    const withJournal = appendJournal(goal, {
      source: 'todo',
      task: 'rename Token to Tok',
      status: 'success',
    });
    await saveGoal(goalPath, withJournal);

    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const blocks = await contrib(emptyCtx);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' });
    const text = blocks[0]!.text;
    expect(text).toContain('ETERNAL AUTONOMY');
    expect(text).toContain('refactor the parser');
    expect(text).toContain('Iteration: #1');
    expect(text).toContain('rename Token to Tok');
  });

  it('respects journalTailSize and pulls the LAST N entries', async () => {
    let goal = emptyGoal('long mission');
    for (let i = 0; i < 8; i++) {
      goal = appendJournal(goal, {
        source: 'brainstorm',
        task: `step ${i}`,
        status: 'success',
      });
    }
    await saveGoal(goalPath, goal);

    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
      journalTailSize: 3,
    });
    const blocks = await contrib(emptyCtx);
    const text = blocks[0]!.text;
    // Only the last 3 should appear (#6, #7, #8).
    expect(text).toContain('step 5');
    expect(text).toContain('step 6');
    expect(text).toContain('step 7');
    expect(text).not.toContain('step 0');
    expect(text).not.toContain('step 1');
  });

  it('teaches the loop-control markers ([continue], [done], [GOAL_COMPLETE])', async () => {
    await saveGoal(goalPath, emptyGoal('mission'));
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const text = (await contrib(emptyCtx))[0]!.text;
    expect(text).toContain('[continue]');
    expect(text).toContain('[done]');
    expect(text).toContain('[GOAL_COMPLETE]');
    // The block must caution against false positives — the engine
    // halts on this marker, so the rubric matters.
    expect(text.toLowerCase()).toContain('verifiably');
  });

  it('survives a corrupt goal file by returning [] (does not throw)', async () => {
    await fs.writeFile(goalPath, 'not json {{{', 'utf8');
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const blocks = await contrib(emptyCtx);
    expect(blocks).toEqual([]);
  });

  it('returns [] for subagent prompt builds — subagents do not drive the engine', async () => {
    await saveGoal(goalPath, emptyGoal('mission'));
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => true,
    });
    const subagentCtx = { ...emptyCtx, subagent: true } as BuildContext;
    const blocks = await contrib(subagentCtx);
    expect(blocks).toEqual([]);
    // Host (non-subagent) build still gets the block — guard is scoped.
    expect((await contrib(emptyCtx)).length).toBe(1);
  });

  it('observes the enabled() result on every call (does not cache)', async () => {
    await saveGoal(goalPath, emptyGoal('mission'));
    let on = false;
    const contrib = makeAutonomyPromptContributor({
      goalPath,
      enabled: () => on,
    });
    expect(await contrib(emptyCtx)).toEqual([]);
    on = true;
    expect((await contrib(emptyCtx)).length).toBe(1);
    on = false;
    expect(await contrib(emptyCtx)).toEqual([]);
  });
});
