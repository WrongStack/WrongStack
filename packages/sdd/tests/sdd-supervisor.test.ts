import { describe, expect, it } from 'vitest';
import { SddSupervisor } from '../src/sdd-supervisor.js';
import {
  DefaultBrainArbiter,
  type BrainArbiter,
  type BrainDecision,
} from '@wrongstack/core/coordination/brain.js';
import type { TaskNode } from '@wrongstack/core/types/task-graph.js';

const task = (): TaskNode => ({
  id: 't1',
  title: 'Do the thing',
  description: 'desc',
  type: 'feature',
  priority: 'high',
  status: 'failed',
  createdAt: 0,
  updatedAt: 0,
});

/** A brain that always answers a fixed option id. */
function brainAnswering(optionId: string): BrainArbiter {
  return {
    async decide(): Promise<BrainDecision> {
      return { type: 'answer', optionId, text: optionId };
    },
  };
}

describe('SddSupervisor', () => {
  it('defaults to retry under the conservative DefaultBrainArbiter (no LLM)', async () => {
    const sup = new SddSupervisor({ brain: new DefaultBrainArbiter() });
    const verdict = await sup.superviseFailure({ task: task(), error: 'boom', attempts: 0 });
    // fallback:'continue' → answer with no optionId → retry (keeps the run moving).
    expect(verdict).toEqual({ action: 'retry' });
  });

  it('maps a reassign decision to the next reassign model', async () => {
    const sup = new SddSupervisor({
      brain: brainAnswering('reassign'),
      reassignModels: ['m-a', 'm-b'],
    });
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'reassign',
      model: 'm-a',
    });
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 1 })).toEqual({
      action: 'reassign',
      model: 'm-b',
    });
  });

  it('splits a provider/model reassign ref into model + provider', async () => {
    const sup = new SddSupervisor({
      brain: brainAnswering('reassign'),
      reassignModels: ['anthropic/claude-haiku-4-5', 'bare-model'],
    });
    // provider/model ref → both fields set.
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'reassign',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
    });
    // bare model → provider undefined (keeps the task's current provider).
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 1 })).toEqual({
      action: 'reassign',
      model: 'bare-model',
      provider: undefined,
    });
  });

  it('maps a split decision through the subtask generator (empty → retry)', async () => {
    const withSubtasks = new SddSupervisor({
      brain: brainAnswering('split'),
      generateSubtasks: async () => [{ title: 'A', description: 'a' }],
    });
    expect(await withSubtasks.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'split',
      subtasks: [{ title: 'A', description: 'a' }],
    });

    const emptyGen = new SddSupervisor({
      brain: brainAnswering('split'),
      generateSubtasks: async () => [],
    });
    expect(await emptyGen.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'retry',
    });
  });

  it('maps a fail decision and a deny to fail', async () => {
    const failSup = new SddSupervisor({ brain: brainAnswering('fail') });
    expect(await failSup.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'fail',
    });
    const denyBrain: BrainArbiter = {
      async decide() {
        return { type: 'deny', reason: 'no' };
      },
    };
    expect(
      await new SddSupervisor({ brain: denyBrain }).superviseFailure({
        task: task(),
        error: 'e',
        attempts: 0,
      }),
    ).toEqual({
      action: 'fail',
    });
  });

  it('requestLlmVerdict escalates via ask_human and degrades an unresolved verdict to retry', async () => {
    // Capture the fallback the supervisor requests.
    let seenFallback: string | undefined;
    const recordingBrain: BrainArbiter = {
      async decide(req) {
        seenFallback = req.fallback;
        // A brain with no LLM answer returns ask_human (the policy escalation).
        return { type: 'ask_human', prompt: 'x', options: req.options };
      },
    };
    const sup = new SddSupervisor({ brain: recordingBrain, requestLlmVerdict: true });
    // Unresolved escalation must NOT dead-end — it degrades to a bounded retry.
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'retry',
    });
    expect(seenFallback).toBe('ask_human');

    // Default (no flag) requests 'continue' instead.
    const plain: BrainArbiter = {
      async decide(req) {
        seenFallback = req.fallback;
        return { type: 'answer', text: 'continue' };
      },
    };
    await new SddSupervisor({ brain: plain }).superviseFailure({
      task: task(),
      error: 'e',
      attempts: 0,
    });
    expect(seenFallback).toBe('continue');
  });

  it('requestLlmVerdict lets the LLM pick split/reassign', async () => {
    const sup = new SddSupervisor({
      brain: brainAnswering('split'),
      requestLlmVerdict: true,
      generateSubtasks: async () => [{ title: 'A', description: 'a' }],
    });
    expect(await sup.superviseFailure({ task: task(), error: 'e', attempts: 0 })).toEqual({
      action: 'split',
      subtasks: [{ title: 'A', description: 'a' }],
    });
  });
});
