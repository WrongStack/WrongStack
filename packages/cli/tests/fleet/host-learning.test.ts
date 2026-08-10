/**
 * The host is where the environment's verdict on a task meets the role's
 * learning files. Two orderings here are load-bearing and neither is obvious
 * from the call site, so they are pinned.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  captureLearnedFromAgentOutputDetailed,
  directiveTrials,
  loadSkillAffinity,
  readRawLearnedEntries,
  resetCaptureWindows,
} from '@wrongstack/core/agent-catalog';
import type { TaskResult } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostLearningRoleTracker } from '../../src/fleet/host-learning-tracker.js';
import type { MultiAgentDeps } from '../../src/fleet/host-types.js';

let projectRoot: string;

const DIRECTIVE =
  'Always run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.';

/** Minimal deps: the host only ever asks the container for a logger. */
function deps(): Pick<MultiAgentDeps, 'container' | 'projectRoot'> {
  return {
    container: { safeResolve: () => undefined } as unknown as MultiAgentDeps['container'],
    projectRoot,
  };
}

function taskResult(status: TaskResult['status'], text: string): TaskResult {
  return {
    subagentId: 'sub-1',
    taskId: 'task-1',
    status,
    result: text,
    iterations: 1,
    toolCalls: 1,
    durationMs: 10,
  };
}

function trialsFor(needle: string): { applied: number; wins: number; losses: number } {
  const entry = readRawLearnedEntries('verifier', projectRoot).find((candidate) =>
    candidate.what.includes(needle),
  );
  return entry ? directiveTrials(entry) : { applied: 0, wins: 0, losses: 0 };
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-host-learning-'));
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('task outcome → learning files', () => {
  it('credits an existing directive the report exercised', () => {
    captureLearnedFromAgentOutputDetailed(
      `## LEARNED\n${DIRECTIVE}`,
      'verifier',
      projectRoot,
      true,
    );
    const tracker = new HostLearningRoleTracker();
    tracker.record('sub-1', 'verifier', ['testing']);

    tracker.capture(taskResult('success', 'Ran `pnpm vitest run` at the root; all green.'), deps());

    expect(trialsFor('vitest run')).toEqual({ applied: 1, wins: 1, losses: 0 });
    expect(loadSkillAffinity('verifier', projectRoot).entries['testing']?.succeeded).toBe(1);
  });

  it('does not let a directive open its record on the task that wrote it', () => {
    const tracker = new HostLearningRoleTracker();
    tracker.record('sub-1', 'verifier', ['testing']);

    // The same text both introduces the directive and mentions its anchor, so
    // attribution running after capture would credit it with a free win.
    tracker.capture(taskResult('success', `Ran the suite.\n\n## LEARNED\n${DIRECTIVE}`), deps());

    expect(trialsFor('vitest run')).toEqual({ applied: 0, wins: 0, losses: 0 });
  });

  it('records a failed task against the directives it exercised', () => {
    captureLearnedFromAgentOutputDetailed(
      `## LEARNED\n${DIRECTIVE}`,
      'verifier',
      projectRoot,
      true,
    );
    const tracker = new HostLearningRoleTracker();
    tracker.record('sub-1', 'verifier', ['testing']);

    tracker.capture(
      taskResult('failed', '`pnpm vitest run` could not resolve the config.'),
      deps(),
    );

    expect(trialsFor('vitest run')).toEqual({ applied: 1, wins: 0, losses: 1 });
    expect(loadSkillAffinity('verifier', projectRoot).entries['testing']?.failed).toBe(1);
  });

  it('scores nothing when the user cancelled the task', () => {
    captureLearnedFromAgentOutputDetailed(
      `## LEARNED\n${DIRECTIVE}`,
      'verifier',
      projectRoot,
      true,
    );
    const tracker = new HostLearningRoleTracker();
    tracker.record('sub-1', 'verifier', ['testing']);

    tracker.capture(taskResult('stopped', 'Was running `pnpm vitest run` when cancelled.'), deps());

    expect(trialsFor('vitest run')).toEqual({ applied: 0, wins: 0, losses: 0 });
    // The routing counter is set by the earlier capture; the outcome counters
    // are what must stay untouched.
    const entry = loadSkillAffinity('verifier', projectRoot).entries['testing'];
    expect({ succeeded: entry?.succeeded, failed: entry?.failed }).toEqual({
      succeeded: 0,
      failed: 0,
    });
  });
});
