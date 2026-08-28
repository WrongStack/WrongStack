/**
 * The eternal-autonomy block follows the conversation that is in that mode.
 *
 * The block is gated by a process-wide autonomy ref, and the system-prompt
 * builder that consults it is one instance for the whole process. Switching a
 * background tab to `eternal` therefore moved the ref and put the loop-control
 * instructions — `[GOAL_COMPLETE]`, the todo protocol, the no-confirmation
 * rule — into the system prompt of every other conversation, none of which
 * were in autonomy mode.
 *
 * The gate now receives the build context, so the answer comes from the
 * conversation being built for; the process ref stays as the fallback, which
 * is the only answer a CLI or TUI has.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeAutonomyPromptContributor } from '../../src/execution/autonomy-prompt-contributor.js';
import { emptyGoal, goalFilePath, saveGoal } from '../../src/storage/goal-store.js';
import type { BuildContext } from '../../src/types/system-prompt.js';

let tmp: string;
let goalPath: string;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-autonomy-scope-'));
  goalPath = goalFilePath(tmp);
  await fs.mkdir(path.dirname(goalPath), { recursive: true });
  await saveGoal(goalPath, emptyGoal('ship the thing'));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function buildContext(overrides: Partial<BuildContext> = {}): BuildContext {
  return { cwd: '/repo', projectRoot: '/repo', tools: [], ...overrides } as BuildContext;
}

/** The wiring the CLI uses: conversation first, process ref as fallback. */
function contributor(processMode: string) {
  return makeAutonomyPromptContributor({
    goalPath,
    enabled: (ctx) => {
      const scoped = ctx.autonomy;
      const mode = typeof scoped === 'string' ? scoped : processMode;
      return mode === 'eternal' || mode === 'eternal-parallel';
    },
  });
}

describe('autonomy prompt block scope', () => {
  it('is absent for a conversation that is not in autonomy, whatever the process says', async () => {
    const blocks = await contributor('eternal')(buildContext({ autonomy: 'off' }));

    expect(blocks).toEqual([]);
  });

  it('is present for the conversation that IS in autonomy', async () => {
    const blocks = await contributor('off')(buildContext({ autonomy: 'eternal' }));

    expect(blocks.length).toBeGreaterThan(0);
  });

  it('falls back to the process mode when the conversation names none', async () => {
    // Single-session hosts never pass one.
    expect(await contributor('eternal')(buildContext())).not.toEqual([]);
    expect(await contributor('off')(buildContext())).toEqual([]);
  });

  it('stays out of a subagent prompt regardless', async () => {
    const blocks = await contributor('eternal')(
      buildContext({ autonomy: 'eternal', subagent: true }),
    );

    expect(blocks).toEqual([]);
  });
});
