import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import { EternalAutonomyEngine } from '../../src/execution/eternal-autonomy.js';
import { emptyGoal, goalFilePath, saveGoal } from '../../src/storage/goal-store.js';

function makeAgent(): Agent {
  return {
    run: vi.fn(async () => ({ status: 'done', iterations: 1, finalText: 'ok' })),
    register: vi.fn(),
    use: vi.fn(),
    events: new EventBus(),
    ctx: { todos: [], eventSessionId: () => '2026-11-08/sess_01TESTSELFSTOPSTATE00000' },
  } as never as Agent;
}

// Regression: the REPL/TUI drives the engine with prime() + runOneIteration()
// and stops its loop on `currentState === 'stopped'`. When the engine stopped
// itself (goal file gone, mission completed) it only raised `stopRequested`,
// so `currentState` stayed 'running' and the TUI loop kept re-entering
// runOneIteration every 200 ms with the status bar flapping running/idle.
describe('EternalAutonomyEngine self-stop is visible in currentState', () => {
  let tmp: string;
  let goalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-eternal-selfstop-'));
    goalPath = goalFilePath(tmp);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function makeEngine() {
    return new EternalAutonomyEngine({
      agent: makeAgent(),
      projectRoot: tmp,
      cycleGapMs: 0,
      noTaskCoolDownMs: 0,
      gitStatusReader: async () => '',
    });
  }

  it('reports stopped after the goal file disappears', async () => {
    await saveGoal(goalPath, emptyGoal('Make the project better'));
    const engine = makeEngine();
    await engine.prime();
    expect(engine.currentState).toBe('running');

    await fs.rm(goalPath, { force: true });
    await expect(engine.runOneIteration()).resolves.toBe(false);

    expect(engine.currentState).toBe('stopped');
  });

  it('reports stopped once the mission is completed', async () => {
    await saveGoal(goalPath, { ...emptyGoal('Ship it'), goalState: 'completed' });
    const engine = makeEngine();
    await engine.prime();

    await expect(engine.runOneIteration()).resolves.toBe(false);

    expect(engine.currentState).toBe('stopped');
  });

  it('keeps a paused mission running so /goal resume can pick it back up', async () => {
    await saveGoal(goalPath, { ...emptyGoal('Ship it'), goalState: 'paused' });
    const engine = makeEngine();
    await engine.prime();

    await expect(engine.runOneIteration()).resolves.toBe(false);

    expect(engine.currentState).toBe('running');
  });
});
