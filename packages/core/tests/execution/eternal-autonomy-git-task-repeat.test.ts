import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import { EternalAutonomyEngine } from '../../src/execution/eternal-autonomy.js';
import { emptyGoal, goalFilePath, loadGoal, saveGoal } from '../../src/storage/goal-store.js';

function makeAgent(): Agent {
  return {
    run: vi.fn(async (input: Array<{ text: string }>) =>
      input[0]?.text.startsWith('You are deciding the next action')
        ? { status: 'done', iterations: 1, finalText: 'Write the release notes' }
        : { status: 'done', iterations: 1, finalText: 'ok [done]' },
    ),
    register: vi.fn(),
    use: vi.fn(),
    container: null,
    tools: null,
    providers: null,
    events: new EventBus(),
    pipelines: null,
    ctx: { todos: [], eventSessionId: () => '2026-10-23/sess_01GITTASKREPEAT' },
  } as never as Agent;
}

// A successful "finish or revert the dirty tree" iteration usually leaves the
// tree dirty (nothing commits it). Re-picking the identical git task every
// tick starved the goal forever (F588).
describe('EternalAutonomyEngine git task on an unchanged dirty tree', () => {
  let root: string;
  let goalPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-eternal-git-'));
    goalPath = goalFilePath(root);
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    await saveGoal(goalPath, emptyGoal('Ship the release'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sources = async () => ((await loadGoal(goalPath))?.journal ?? []).map((e) => e.source);

  it('moves on to the goal once the git task succeeded', async () => {
    const engine = new EternalAutonomyEngine({
      agent: makeAgent(),
      projectRoot: root,
      cycleGapMs: 0,
      noTaskCoolDownMs: 0,
      gitStatusReader: async () => ' M src/app.ts\n',
    });
    for (let i = 0; i < 3; i++) await engine.runOneIteration();
    expect(await sources()).toEqual(['git', 'brainstorm', 'brainstorm']);
  });

  it('picks the git task again when the dirty set changes', async () => {
    let status = ' M a.ts\n';
    const engine = new EternalAutonomyEngine({
      agent: makeAgent(),
      projectRoot: root,
      cycleGapMs: 0,
      noTaskCoolDownMs: 0,
      gitStatusReader: async () => status,
    });
    await engine.runOneIteration();
    await engine.runOneIteration();
    status = ' M a.ts\n M b.ts\n';
    await engine.runOneIteration();
    expect(await sources()).toEqual(['git', 'brainstorm', 'git']);
  });
});
