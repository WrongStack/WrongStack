import { describe, expect, it } from 'vitest';
import {
  BrainDecisionQueue,
  DefaultBrainArbiter,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  formatHumanPrompt,
} from '../../src/coordination/brain.js';
import { EventBus } from '../../src/kernel/events.js';
import type { BrainDecisionRequest } from '../../src/coordination/brain.js';

function request(overrides: Partial<BrainDecisionRequest> = {}): BrainDecisionRequest {
  return {
    id: 'decision-1',
    source: 'goal',
    question: 'Resolve the merge conflict automatically?',
    context: 'A phase completed but squash merge conflicted in x.ts.',
    risk: 'high',
    fallback: 'ask_human',
    options: [
      {
        id: 'resolve',
        label: 'Try resolver subagent',
        consequence: 'May edit conflicted files in the base tree.',
        risk: 'medium',
      },
      {
        id: 'review',
        label: 'Keep worktree for review',
        consequence: 'No automatic merge is attempted.',
        risk: 'low',
      },
    ],
    ...overrides,
  };
}

describe('DefaultBrainArbiter', () => {
  it('auto-answers low-risk requests with an explicit recommended option', async () => {
    const brain = new DefaultBrainArbiter();
    const decision = await brain.decide(
      request({
        risk: 'low',
        options: [
          { id: 'continue', label: 'Continue', recommended: true, risk: 'low' },
          { id: 'stop', label: 'Stop', risk: 'low' },
        ],
      }),
    );

    expect(decision).toEqual({
      type: 'answer',
      optionId: 'continue',
      text: 'Continue',
      rationale: 'Low-risk request with an explicit recommended option.',
    });
  });

  it('asks the human for high-risk requests when fallback is ask_human', async () => {
    const brain = new DefaultBrainArbiter();
    const decision = await brain.decide(request());

    expect(decision.type).toBe('ask_human');
    if (decision.type !== 'ask_human') return;
    expect(decision.prompt).toContain('Brain requires human decision for goal');
    expect(decision.prompt).toContain('Resolve the merge conflict automatically?');
    expect(decision.options).toHaveLength(2);
  });

  it('denies when fallback is deny and no safe auto-answer exists', async () => {
    const brain = new DefaultBrainArbiter();
    const decision = await brain.decide(request({ fallback: 'deny', options: [] }));

    expect(decision.type).toBe('deny');
    if (decision.type !== 'deny') return;
    expect(decision.reason).toContain('Brain could not safely decide');
  });

  it('continues with caller default when fallback is continue', async () => {
    const brain = new DefaultBrainArbiter({ allowLowRiskAutoAnswer: false });
    const decision = await brain.decide(request({ fallback: 'continue', risk: 'low' }));

    expect(decision).toEqual({
      type: 'answer',
      text: 'Continue with the caller default.',
      rationale: 'No safe Brain decision was available; request fallback is continue.',
    });
  });

  describe('blocked-resolved heuristic', () => {
    const blockedRequest = (overrides: Partial<BrainDecisionRequest> = {}) =>
      request({
        question: 'The build is blocked by a missing dependency',
        context: 'The dependency has been resolved and merged',
        fallback: 'continue',
        risk: 'medium',
        options: [],
        ...overrides,
      });

    it('auto-continues when blocked question has resolution evidence in context', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(blockedRequest());

      expect(decision).toEqual({
        type: 'answer',
        text: 'Blocker resolved. Continue with the previously blocked work.',
        rationale: 'Heuristic: blocking dependency explicitly resolved — resuming.',
      });
    });

    it('matches all resolution markers', async () => {
      const brain = new DefaultBrainArbiter();
      const markers = [
        'resolved',
        'fixed',
        'completed',
        'unblocked',
        'available',
        'done',
        'merged',
        'landed',
        'shipped',
      ];

      for (const marker of markers) {
        const decision = await brain.decide(
          blockedRequest({ context: `The dependency is now ${marker}` }),
        );
        expect(decision.type).toBe('answer');
        if (decision.type === 'answer') {
          expect(decision.text).toBe(
            'Blocker resolved. Continue with the previously blocked work.',
          );
        }
      }
    });

    it('does NOT fire when options are present (structured choice required)', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({
          risk: 'low',
          options: [
            { id: 'continue', label: 'Continue', recommended: true, risk: 'low' },
            { id: 'wait', label: 'Wait', risk: 'low' },
          ],
        }),
      );

      // Should fall through to low-risk auto-answer (recommended option), not the heuristic
      expect(decision.type).toBe('answer');
      if (decision.type === 'answer') {
        expect(decision.optionId).toBe('continue');
        expect(decision.rationale).toBe('Low-risk request with an explicit recommended option.');
      }
    });

    it('does NOT fire when fallback is not continue', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(blockedRequest({ fallback: 'ask_human' }));

      expect(decision.type).toBe('ask_human');
    });

    it('does NOT fire when context has no resolution marker', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({ context: 'The dependency is still being investigated' }),
      );

      // Falls through to the continue fallback
      expect(decision).toEqual({
        type: 'answer',
        text: 'Continue with the caller default.',
        rationale: 'No safe Brain decision was available; request fallback is continue.',
      });
    });

    it('does NOT fire when question does not mention blocked', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({ question: 'Should we proceed with the deployment?' }),
      );

      expect(decision).toEqual({
        type: 'answer',
        text: 'Continue with the caller default.',
        rationale: 'No safe Brain decision was available; request fallback is continue.',
      });
    });

    it('does NOT fire when question contains competing alternative (or)', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({ question: 'Should we unblock and continue or wait for review?' }),
      );

      expect(decision).toEqual({
        type: 'answer',
        text: 'Continue with the caller default.',
        rationale: 'No safe Brain decision was available; request fallback is continue.',
      });
    });

    it('does NOT fire when context is undefined', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(blockedRequest({ context: undefined }));

      expect(decision).toEqual({
        type: 'answer',
        text: 'Continue with the caller default.',
        rationale: 'No safe Brain decision was available; request fallback is continue.',
      });
    });

    it('does NOT match false positives like unresolved', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({ context: 'The issue remains unresolved and needs more work' }),
      );

      expect(decision).toEqual({
        type: 'answer',
        text: 'Continue with the caller default.',
        rationale: 'No safe Brain decision was available; request fallback is continue.',
      });
    });

    it('is case-insensitive for question and context', async () => {
      const brain = new DefaultBrainArbiter();
      const decision = await brain.decide(
        blockedRequest({
          question: 'THE BUILD IS BLOCKED BY A MISSING DEPENDENCY',
          context: 'THE DEPENDENCY HAS BEEN RESOLVED AND MERGED',
        }),
      );

      expect(decision.type).toBe('answer');
      if (decision.type === 'answer') {
        expect(decision.text).toBe('Blocker resolved. Continue with the previously blocked work.');
      }
    });
  });
});

describe('ObservableBrainArbiter', () => {
  it('emits request and terminal decision events', async () => {
    const events = new EventBus();
    const seen: string[] = [];
    events.on('brain.decision_requested', ({ request }) => {
      seen.push(`request:${request.id}`);
    });
    events.on('brain.decision_answered', ({ request, decision }) => {
      seen.push(`answer:${request.id}:${decision.type}`);
    });

    const brain = new ObservableBrainArbiter(
      {
        decide: async () => ({ type: 'answer', optionId: 'continue', text: 'Continue' }),
      },
      events,
    );

    const decision = await brain.decide(request({ risk: 'low' }));

    expect(decision.type).toBe('answer');
    expect(seen).toEqual(['request:decision-1', 'answer:decision-1:answer']);
  });
});

describe('HumanEscalatingBrainArbiter', () => {
  it('passes through non-human decisions', async () => {
    const events = new EventBus();
    const queue = new BrainDecisionQueue(events);
    const brain = new HumanEscalatingBrainArbiter(
      { decide: async () => ({ type: 'answer', text: 'Continue' }) },
      queue,
    );

    await expect(brain.decide(request())).resolves.toEqual({ type: 'answer', text: 'Continue' });
    queue.dispose();
  });

  it('escalates ask_human decisions to the queue and resolves from human answer', async () => {
    const events = new EventBus();
    const queue = new BrainDecisionQueue(events);
    const brain = new HumanEscalatingBrainArbiter(
      { decide: async () => ({ type: 'ask_human', prompt: 'Pick one' }) },
      queue,
    );

    events.once('brain.decision_ask_human', ({ request }) => {
      events.emit('brain.human_answered', {
        id: request.id,
        optionId: 'review',
        at: Date.now(),
      });
    });
    const pending = brain.decide(request());

    await expect(pending).resolves.toMatchObject({
      type: 'answer',
      optionId: 'review',
      text: 'Keep worktree for review',
    });
    queue.dispose();
  });
});

describe('BrainDecisionQueue', () => {
  it('waits for a human answer event and resolves to the selected option', async () => {
    const events = new EventBus();
    const queue = new BrainDecisionQueue(events);
    const pending = queue.requestHumanDecision(request());

    events.emit('brain.human_answered', {
      id: 'decision-1',
      optionId: 'review',
      at: Date.now(),
    });

    await expect(pending).resolves.toMatchObject({
      type: 'answer',
      optionId: 'review',
      text: 'Keep worktree for review',
    });
    queue.dispose();
  });

  it('resolves to deny when the human denies', async () => {
    const events = new EventBus();
    const queue = new BrainDecisionQueue(events);
    const pending = queue.requestHumanDecision(request());

    events.emit('brain.human_answered', {
      id: 'decision-1',
      deny: true,
      text: 'Not safe',
      at: Date.now(),
    });

    await expect(pending).resolves.toEqual({ type: 'deny', reason: 'Not safe' });
    queue.dispose();
  });
});

describe('formatHumanPrompt', () => {
  it('formats context, options, consequences, and risk for the human', () => {
    const prompt = formatHumanPrompt(request());

    expect(prompt).toContain('Context:');
    expect(prompt).toContain('- resolve: Try resolver subagent [risk: medium]');
    expect(prompt).toContain('May edit conflicted files in the base tree.');
    expect(prompt).toContain('Risk: high');
  });
});
