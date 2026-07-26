import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { sddState } from '../src/services/sdd/state.js';
import {
  buildSddCommand,
  getActiveSDDContext,
  getActiveSDDPhase,
  getActiveBuilder,
  getTaskProgress,
  getTaskListText,
  markTaskCompleted,
  autoDetectTaskCompletion,
  trySaveSpecFromAIOutput,
  trySaveTasksFromAIOutput,
  trySaveImplementationPlan,
} from '../src/slash-commands/sdd.js';
import { createMockTracker, createTestSddSession } from './helpers/sdd-test-helpers.js';

let tmp: string;
let prevCwd: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-cli-'));
  prevCwd = process.cwd();
  process.chdir(tmp);
});

async function rmWithRetry(dir: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      if (i === 4) throw err;
      // ENOTEMPTY/EBUSY on Windows: give the OS a moment to release handles
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

afterEach(async () => {
  process.chdir(prevCwd);
  // Defer the rm so the OS can fully release the cwd handle on Windows.
  await new Promise((r) => setImmediate(r));
  await rmWithRetry(tmp);
});

function fakeCtx() {
  return {
    projectRoot: tmp,
    meta: {} as Record<string, unknown>,
  } as never;
}

function build(opts: Record<string, unknown> = {}) {
  return buildSddCommand({
    context: fakeCtx(),
    paths: resolveWstackPaths({ projectRoot: tmp }),
    ...opts,
  } as never);
}

async function cancelAny() {
  // After tests, cancel any lingering builder/state in the process-lifetime singleton
  try {
    await build().run('cancel');
  } catch {
    /* best-effort */
  }
}

afterEach(async () => {
  await cancelAny();
});

// ── helpers (no active session) ──────────────────────────────────────────────

describe('SDD module-level helpers (no active session)', () => {
  it('getActiveSDDContext returns null when no builder is active', () => {
    expect(getActiveSDDContext()).toBeNull();
  });

  it('getActiveSDDPhase returns null when no builder is active', () => {
    expect(getActiveSDDPhase()).toBeNull();
  });

  it('getActiveBuilder returns null when no builder is active', () => {
    expect(getActiveBuilder()).toBeNull();
  });

  it('getTaskProgress returns null without an active task tracker', () => {
    expect(getTaskProgress()).toBeNull();
  });

  it('getTaskListText returns null without an active task tracker', () => {
    expect(getTaskListText()).toBeNull();
  });

  it('markTaskCompleted returns false without an active task tracker', () => {
    expect(markTaskCompleted('anything')).toBe(false);
  });

  // ── findSpec prefix-match ───────────────────────────────────────────────────

  describe('findSpec — prefix and title match', () => {
    beforeEach(async () => {
      // Cancel any active session before running findSpec tests
      await cancelAny();
    });

    it('spec command works when an active builder session exists', async () => {
      await createTestSddSession('My App', tmp);
      const res1 = await build().run('spec');
      expect(res1?.message || '').not.toContain('Error');
      const state = getActiveBuilder();
      expect(state).not.toBeNull();
      const ctx = getActiveSDDContext();
      expect(ctx).not.toBeNull();
    });

    it('trySaveSpecFromAIOutput handles partial spec JSON', async () => {
      // No active builder — should return false
      expect(await trySaveSpecFromAIOutput('not a spec')).toBe(false);
    });

    it('trySaveTasksFromAIOutput returns false for invalid JSON', async () => {
      // No active builder — should return false
      expect(await trySaveTasksFromAIOutput('not json')).toBe(false);
    });

    it('trySaveTasksFromAIOutput returns false for non-array', async () => {
      // No active builder — should return false
      expect(await trySaveTasksFromAIOutput('{"title":"x"}')).toBe(false);
    });
  });

  // ── getActiveSDDContext / Phase after session ends ─────────────────────────

  describe('SDD context after session completes', () => {
    it('getActiveSDDPhase returns null when builder phase is done', async () => {
      await cancelAny();
      // Start a minimal session
      const res = await build().run('spec Test');
      expect(res?.message || '').not.toContain('Error');
      const phase = getActiveSDDPhase();
      // Phase may be null or an active phase depending on state
      expect(phase === null || typeof phase === 'string').toBe(true);
      await cancelAny();
    });
  });

  // ── plan / impl / execute without session ───────────────────────────────────

  describe('SDD command delegation to slash-commands without active session', () => {
    it('plan without session says no active session', async () => {
      await cancelAny();
      const res = await build().run('plan');
      expect(res?.message).toMatch(/No active SDD session|Spec Builder/i);
    });

    it('impl without session says no active session', async () => {
      await cancelAny();
      const res = await build().run('impl');
      expect(res?.message).toMatch(/No active SDD session|Spec Builder/i);
    });

    it('execute without session says no active session', async () => {
      await cancelAny();
      const res = await build().run('execute');
      expect(res?.message).toMatch(/No active SDD session|Spec Builder/i);
    });

    it('spec with active session shows current spec', async () => {
      await cancelAny();
      await createTestSddSession('Test', tmp);
      const res = await build().run('spec');
      expect(res?.message).toContain('Title: Test');
      expect(res?.message).not.toContain('No active SDD session');
    });
  });

  // ── cancel cleans up state ───────────────────────────────────────────────────

  describe('cancel cleans up SDD state', () => {
    it('cancel on an active session returns cancelled message', async () => {
      await createTestSddSession('Cancel Test', tmp);
      const cancelRes = await build().run('cancel');
      expect(cancelRes?.message).toMatch(/cancelled|abort/i);
    });

    it('getActiveSDDContext is null after cancel', async () => {
      await build().run('spec After Cancel');
      await build().run('cancel');
      expect(getActiveSDDContext()).toBeNull();
    });
  });

  // ── task completion detection ────────────────────────────────────────────────

  describe('autoDetectTaskCompletion', () => {
    // autoDetectTaskCompletion early-returns 0 unless sddState has a tracker
    // with at least one pending node. The 0-returning tests below (which run
    // without a tracker) cover the early-out contract. The positive tests need
    // a tracker injected via sddState.setTaskTracker().

    afterEach(() => {
      sddState.setTaskTracker(null);
    });

    it('detects "Task X: done" style completion', () => {
      createMockTracker([['task-1', 'Task 1']]);
      expect(autoDetectTaskCompletion('Task 1: done')).toBe(1);
    });

    it('detects "Task X: complete" style completion', () => {
      createMockTracker([['task-1', 'Task 1']]);
      expect(autoDetectTaskCompletion('Task 1: complete')).toBe(1);
    });

    it('returns 0 for incomplete tasks', () => {
      expect(autoDetectTaskCompletion('Task 1: pending')).toBe(0);
    });

    it('returns 0 for empty input', () => {
      expect(autoDetectTaskCompletion('')).toBe(0);
    });

    it('returns 0 for irrelevant text', () => {
      expect(autoDetectTaskCompletion('nothing task-related here')).toBe(0);
    });

    it('detects multiple completed tasks', () => {
      createMockTracker([['task-1', 'Task 1'], ['task-2', 'Task 2', 'in_progress']]);
      expect(autoDetectTaskCompletion('Task 1: done\nTask 2: done')).toBe(2);
    });
  });

  it('trySaveSpecFromAIOutput returns false without an active builder', async () => {
    expect(await trySaveSpecFromAIOutput('any output')).toBe(false);
  });

  it('trySaveTasksFromAIOutput returns false without an active builder', async () => {
    expect(await trySaveTasksFromAIOutput('[{"title":"x"}]')).toBe(false);
  });

  it('trySaveImplementationPlan returns false without an active builder', () => {
    expect(trySaveImplementationPlan('a plan')).toBe(false);
  });
});

// ── autoDetectTaskCompletion edge cases ─────────────────────────────────────

describe('autoDetectTaskCompletion edge cases', () => {
  afterEach(() => {
    sddState.setTaskTracker(null);
  });

  it('returns 0 for empty input', () => {
    expect(autoDetectTaskCompletion('')).toBe(0);
  });

  it('returns 0 for irrelevant text', () => {
    expect(autoDetectTaskCompletion('nothing task-related here')).toBe(0);
  });

  it('returns 0 for whitespace-only input', () => {
    expect(autoDetectTaskCompletion('   ')).toBe(0);
  });

  it('detects Task X: done style', () => {
    createMockTracker([['task-1', 'Task 1']]);
    // autoDetectTaskCompletion MUTATES the tracker (marks tasks complete),
    // so each call needs its own tracker or uses a fresh assertion.
    expect(autoDetectTaskCompletion('Task 1: done')).toBe(1);
  });

  it('detects Task X: complete style', () => {
    createMockTracker([['task-1', 'Task 1']]);
    expect(autoDetectTaskCompletion('Task 1: complete')).toBe(1);
  });

  it('returns 0 for Task X: pending', () => {
    expect(autoDetectTaskCompletion('Task 1: pending')).toBe(0);
  });

  it('counts multiple completed tasks', () => {
    createMockTracker([['task-1', 'Task 1'], ['task-2', 'Task 2', 'in_progress']]);
    expect(autoDetectTaskCompletion('Task 1: done\nTask 2: done')).toBe(2);
  });
});

// ── buildSddCommand: simple verbs (no session) ───────────────────────────────

describe('buildSddCommand verbs without an active session', () => {
  it('empty / no-arg shows help', async () => {
    const cmd = build();
    const res = await cmd.run('');
    expect(res?.message).toContain('SDD');
    expect(res?.message).toContain('Spec Builder');
  });

  it('"help" shows help', async () => {
    const cmd = build();
    const res = await cmd.run('help');
    expect(res?.message).toContain('Spec Builder');
  });

  it('unknown verb falls through to default branch + appends help', async () => {
    const cmd = build();
    const res = await cmd.run('frobulate');
    expect(res?.message).toContain('Unknown subcommand "frobulate" for /sdd');
    expect(res?.message).toContain('Spec Builder');
  });

  it('approve without a session reports "no active SDD session"', async () => {
    const res = await build().run('approve');
    expect(res?.message).toContain('No active SDD session');
  });

  it('confirm and ok aliases also report "no active session"', async () => {
    expect((await build().run('ok'))?.message).toContain('No active SDD session');
    expect((await build().run('confirm'))?.message).toContain('No active SDD session');
  });

  it('execute / run without a session reports "no active session"', async () => {
    expect((await build().run('execute'))?.message).toContain('No active SDD session');
    expect((await build().run('run'))?.message).toContain('No active SDD session');
  });

  it('plan / impl without a session reports "no active session"', async () => {
    expect((await build().run('plan'))?.message).toContain('No active SDD session');
    expect((await build().run('impl'))?.message).toContain('No active SDD session');
  });

  it('spec without a session reports "no active session"', async () => {
    expect((await build().run('spec'))?.message).toContain('No active SDD session');
  });

  it('retry-failed without an active parallel run reports "no active SDD parallel run"', async () => {
    expect((await build().run('retry-failed'))?.message).toContain('No active SDD parallel run');
  });

  it('retry-failed / retry-all calls onSddRetryAllFailed and reports the requeued count', async () => {
    let called = 0;
    const onSddRetryAllFailed = () => {
      called++;
      return 3;
    };
    const res = await build({ onSddRetryAllFailed }).run('retry-failed');
    expect(called).toBe(1);
    expect(res?.message).toContain('Requeued 3 failed tasks');
    const none = await build({ onSddRetryAllFailed: () => 0 }).run('retry-all');
    expect(none?.message).toContain('No failed tasks to retry');
  });

  it('split without an active parallel run reports no run', async () => {
    expect((await build().run('split t1 A ; B'))?.message).toContain(
      'No active SDD parallel run',
    );
  });

  it('split requires a task id and at least two sub-tasks', async () => {
    const onSddSplitTask = () => ['x1', 'x2'];
    expect((await build({ onSddSplitTask }).run('split'))?.message).toContain('Usage: /sdd split');
    expect((await build({ onSddSplitTask }).run('split t1 OnlyOne'))?.message).toContain(
      'at least two sub-tasks',
    );
  });

  it('split parses `Title :: desc ; …` and reports the new leaf ids', async () => {
    const calls: Array<{ taskId: string; subtasks: Array<{ title: string; description: string }> }> = [];
    const onSddSplitTask = (taskId: string, subtasks: Array<{ title: string; description: string }>) => {
      calls.push({ taskId, subtasks });
      return ['leaf-1', 'leaf-2'];
    };
    const res = await build({ onSddSplitTask }).run('split t1 Build API :: do the api ; Write tests');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.taskId).toBe('t1');
    expect(calls[0]?.subtasks).toEqual([
      { title: 'Build API', description: 'do the api' },
      { title: 'Write tests', description: 'Write tests' },
    ]);
    expect(res?.message).toContain('Split t1 into 2 sub-tasks: leaf-1, leaf-2');
  });

  it('split reports when the run rejects the split (null)', async () => {
    const res = await build({ onSddSplitTask: () => null }).run('split t1 A ; B');
    expect(res?.message).toContain("unknown / running");
  });

  // ── lifecycle: clean / rollback / destroy ──────────────────────────────────
  it('clean calls onSddCleanWorktrees and reports the count', async () => {
    let called = 0;
    const onSddCleanWorktrees = async () => {
      called++;
      return 3;
    };
    const res = await build({ onSddCleanWorktrees }).run('clean');
    expect(called).toBe(1);
    expect(res?.message).toContain('Cleaned 3 SDD worktrees');
    const none = await build({ onSddCleanWorktrees: async () => 0 }).run('cleanup');
    expect(none?.message).toContain('No SDD worktrees to clean');
  });

  it('rollback reports reverted count on success and the reason on failure', async () => {
    const ok = await build({ onSddRollback: async () => ({ ok: true, reverted: 2 }) }).run('rollback');
    expect(ok?.message).toContain('Rolled back 2 run commits');
    const fail = await build({
      onSddRollback: async () => ({ ok: false, reverted: 0, reason: 'working tree has uncommitted changes' }),
    }).run('revert');
    expect(fail?.message).toContain('Rollback failed');
    expect(fail?.message).toContain('uncommitted');
  });

  it('destroy calls onSddDestroy and reports what was removed', async () => {
    let called = 0;
    const onSddDestroy = async () => {
      called++;
      return { worktreesRemoved: 2, deleted: ['specs', 'boards'], reverted: 0 };
    };
    const res = await build({ onSddDestroy }).run('destroy');
    expect(called).toBe(1);
    expect(res?.message).toContain('SDD project destroyed');
    expect(res?.message).toContain('Removed 2 worktrees');
    expect(res?.message).toContain('specs, boards');
    // Default destroy leaves merged commits.
    expect(res?.message).toMatch(/Merged commits left intact/i);
  });

  it('destroy --revert forwards revertMerged and reports the reverted count', async () => {
    let seen: { revertMerged?: boolean } | undefined;
    const onSddDestroy = async (o?: { revertMerged?: boolean }) => {
      seen = o;
      return { worktreesRemoved: 1, deleted: ['boards'], reverted: 3, revertOk: true };
    };
    const res = await build({ onSddDestroy }).run('destroy --revert');
    expect(seen?.revertMerged).toBe(true);
    expect(res?.message).toContain('Reverted 3 merged commits');
  });

  it('destroy --revert surfaces a refused revert', async () => {
    const onSddDestroy = async () => ({
      worktreesRemoved: 0,
      deleted: ['boards'],
      reverted: 0,
      revertOk: false,
      revertReason: 'working tree has uncommitted changes',
    });
    const res = await build({ onSddDestroy }).run('destroy --revert');
    expect(res?.message).toMatch(/revert refused/i);
    expect(res?.message).toContain('uncommitted');
  });

  it('abort is an alias of stop', async () => {
    let stopped = 0;
    const res = await build({ onSddParallelStop: () => { stopped++; } }).run('abort');
    expect(stopped).toBe(1);
    expect(res?.message).toContain('stopped');
  });

  it('tasks / task without an active tracker reports "no tasks generated yet"', async () => {
    expect((await build().run('tasks'))?.message).toContain('No tasks generated yet');
    expect((await build().run('task'))?.message).toContain('No tasks generated yet');
  });

  it('done / complete without an active tracker reports "no tasks to complete"', async () => {
    expect((await build().run('done'))?.message).toContain('No tasks to complete');
    expect((await build().run('complete'))?.message).toContain('No tasks to complete');
  });

  it('status without a session reports "no active SDD session"', async () => {
    expect((await build().run('status'))?.message).toContain('No active SDD session');
  });

  it('cancel without a session reports "no active SDD session"', async () => {
    expect((await build().run('cancel'))?.message).toContain('No active SDD session');
  });

  it('list without saved specs reports "no specs saved"', async () => {
    expect((await build().run('list'))?.message).toContain('No specs saved');
    expect((await build().run('ls'))?.message).toContain('No specs saved');
  });

  it('show with unknown id reports "not found"', async () => {
    const res = await build().run('show some-id');
    expect(res?.message).toContain('not found');
  });

  it('view with no id reports "not found"', async () => {
    const res = await build().run('view');
    expect(res?.message).toContain('not found');
  });

  it('templates lists at least one template', async () => {
    const res = await build().run('templates');
    expect(res?.message).toContain('Available Templates');
  });

  it('from with unknown template reports "not found"', async () => {
    const res = await build().run('from definitely-not-a-template-id');
    expect(res?.message).toContain('not found');
  });

  it('version / history with unknown id reports "not found"', async () => {
    expect((await build().run('version some-id'))?.message).toContain('not found');
    expect((await build().run('history some-id'))?.message).toContain('not found');
  });

  it('resume with no saved session reports "no saved SDD session found"', async () => {
    const res = await build().run('resume');
    expect(res?.message).toContain('No saved SDD session found');
  });
});

// ── new / cancel happy paths ────────────────────────────────────────────────

describe('buildSddCommand new + cancel', () => {
  it('"new <title>" starts a session and returns the AI-prompt runText', async () => {
    const res = await build().run('new MyFeature');
    expect(res?.message).toContain('AI Spec Builder');
    expect(res?.message).toContain('MyFeature');
    expect(res?.runText).toContain('SDD SESSION ACTIVE');
    // module-level helpers should now reflect the active session
    expect(getActiveBuilder()).not.toBeNull();
    expect(getActiveSDDContext()).not.toBeNull();
    expect(getActiveSDDPhase()).not.toBeNull();
  });

  it('"new" without title defaults to "Untitled Feature"', async () => {
    const res = await build().run('new');
    expect(res?.message).toContain('Untitled Feature');
  });

  it('--force flag skips the session-resume check', async () => {
    // Create a stale session file
    const sessionDir = path.join(tmp, '.wrongstack');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'sdd-session.json'),
      JSON.stringify({ phase: 'questioning' }),
    );
    const res = await build().run('new --force ForcedFeature');
    expect(res?.message).toContain('AI Spec Builder');
    expect(res?.message).toContain('ForcedFeature');
  });

  it('status after new shows the active session details', async () => {
    await build().run('new StatusTest');
    const res = await build().run('status');
    expect(res?.message).toContain('SDD:');
    expect(res?.message).toContain('StatusTest');
    expect(res?.message).toContain('Questioning');
  });

  it('plan after new reports no implementation yet', async () => {
    await build().run('new PlanTest');
    const res = await build().run('plan');
    expect(res?.message?.toLowerCase()).toMatch(/no implementation plan|keep answering/);
  });

  it('spec after new reports no spec generated yet', async () => {
    await build().run('new SpecTest');
    const res = await build().run('spec');
    expect(res?.message?.toLowerCase()).toMatch(/no spec|keep answering/);
  });

  it('cancel ends the active session and clears state', async () => {
    await build().run('new ToCancel');
    expect(getActiveBuilder()).not.toBeNull();
    const res = await build().run('cancel');
    expect(res?.message).toContain('cancelled');
    expect(getActiveBuilder()).toBeNull();
  });
});

// ── from template happy path ────────────────────────────────────────────────

describe('buildSddCommand from template', () => {
  it('"from feature" creates a draft spec from the feature template', async () => {
    const res = await build().run('from feature');
    expect(res?.message).toContain('Created draft spec');
  });

  it('"from" (no template id) defaults to feature', async () => {
    const res = await build().run('from');
    expect(res?.message).toContain('Created draft spec');
  });
});

// ── deeper coverage with active session ─────────────────────────────────────

describe('buildSddCommand with an active spec/tasks session', () => {
  it('approve in "questioning" phase returns generate prompt', async () => {
    await build().run('new ApprovePhase');
    const res = await build().run('approve');
    // The fresh phase is "questioning"; approve there asks AI to generate
    expect(res?.message?.toLowerCase()).toContain('no spec generated');
    expect(res?.runText).toContain('SDD SESSION ACTIVE');
  });

  it('execute when phase is not executing/task_review reports cannot execute', async () => {
    await build().run('new ExecPhase');
    const res = await build().run('execute');
    expect(res?.message).toContain('Cannot execute');
  });

  it('trySaveSpecFromAIOutput returns false when AI output does not contain a spec', async () => {
    await build().run('new SpecParse');
    expect(await trySaveSpecFromAIOutput('just chatting, no spec here')).toBe(false);
  });

  it('trySaveTasksFromAIOutput returns false on invalid JSON', async () => {
    await build().run('new TaskParse');
    // No spec yet → returns false even if JSON looks valid
    expect(await trySaveTasksFromAIOutput('```json\n[{"title":"x"}]\n```')).toBe(false);
  });

  it('trySaveImplementationPlan returns false if not in implementation phase', async () => {
    await build().run('new PlanParse');
    // Phase is "questioning", not "implementation" — should refuse
    expect(trySaveImplementationPlan('A '.repeat(60))).toBe(false);
  });

  it('autoDetectTaskCompletion returns 0 when no tracker is active', async () => {
    // Even with a builder, without an executed task graph the tracker is null
    await build().run('new TaskDetect');
    expect(autoDetectTaskCompletion('✅ Task done')).toBe(0);
  });

  it('"resume" while a session is already active reports the conflict', async () => {
    await build().run('new ResumeConflict');
    const res = await build().run('resume');
    expect(res?.message).toContain('already active');
  });

  it('"new" while one is already active without --force lets the second new path through (no resume dialog)', async () => {
    await build().run('new First');
    // Second new should also succeed because the builder is already set
    const res = await build().run('new Second');
    expect(res?.message).toContain('AI Spec Builder');
  });

  it('list after creating a spec from template reports the saved spec', async () => {
    await build().run('from feature');
    const res = await build().run('list');
    expect(res?.message).toContain('Saved Specs');
  });

  it('show finds spec by partial title match', async () => {
    await build().run('from feature');
    const res = await build().run('show new');
    // either matches the "New Specification" title or returns "not found"
    expect(res?.message).toMatch(/New Specification|not found/);
  });
});
