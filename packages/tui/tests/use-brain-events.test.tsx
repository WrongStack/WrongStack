// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrainEvents } from '../src/hooks/use-brain-events.js';

describe('useBrainEvents', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a monitor decision and its outcome as one history card', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const request = {
      id: 'brainmon-file-churn',
      source: 'system' as const,
      question: 'Should the agent be steered?',
      risk: 'medium' as const,
      fallback: 'ask_human' as const,
    };
    const decision = {
      type: 'answer' as const,
      optionId: 'continue',
      text: 'Let the agent continue unaided',
      rationale: 'Council (majority)',
    };

    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.decision_answered', { request, decision, at: Date.now() });
      events.emit('brain.intervention', {
        kind: 'file_churn',
        request,
        decision,
        intervened: false,
        at: Date.now(),
      });
    });

    const historyActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(historyActions).toHaveLength(1);
    expect(historyActions[0].entry).toMatchObject({
      kind: 'brain',
      status: 'answered',
      source: 'monitor',
      decision: 'continue',
      outcome: 'observed — no action needed',
      interventionKind: 'file_churn',
      rationale: 'Council (majority)',
    });
    unmount();
  });

  it('renders a monitor answer after the intervention grace period expires', () => {
    vi.useFakeTimers();
    const events = new EventBus();
    const dispatch = vi.fn();
    const request = {
      id: 'brainmon-stalled-delivery',
      source: 'system' as const,
      question: 'Should the stalled agent be steered?',
      risk: 'medium' as const,
      fallback: 'ask_human' as const,
    };
    const decision = {
      type: 'answer' as const,
      optionId: 'steer',
      text: 'Steer the agent',
    };

    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.decision_answered', { request, decision, at: Date.now() });
    });
    expect(dispatch.mock.calls.some(([action]) => action.type === 'addEntry')).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const historyActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(historyActions).toHaveLength(1);
    expect(historyActions[0].entry).toMatchObject({
      kind: 'brain',
      status: 'answered',
      source: 'system',
      decision: 'steer',
    });

    act(() => {
      events.emit('brain.intervention', {
        kind: 'agent_stall',
        request,
        decision,
        intervened: true,
        at: Date.now(),
      });
    });
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'addEntry')).toHaveLength(1);
    unmount();
  });

  it('renders a non-monitor answered decision without an intervention event', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const request = {
      id: 'permission-read',
      source: 'tool' as const,
      question: 'Allow this read?',
      risk: 'low' as const,
      fallback: 'deny' as const,
    };
    const decision = {
      type: 'answer' as const,
      optionId: 'allow',
      text: 'Allow the read',
    };

    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.decision_answered', { request, decision, at: Date.now() });
    });

    const historyActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(historyActions).toHaveLength(1);
    expect(historyActions[0].entry).toMatchObject({
      kind: 'brain',
      status: 'answered',
      decision: 'allow',
    });
    unmount();
  });

  it('renders a standalone denied intervention with its human-readable reason', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const request = {
      id: 'brainmon-error-storm',
      source: 'system' as const,
      question: 'Should the agent be steered?',
      risk: 'medium' as const,
      fallback: 'ask_human' as const,
    };
    const decision = {
      type: 'deny' as const,
      reason: 'The signal is too ambiguous to intervene safely',
    };

    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.intervention', {
        kind: 'error_storm',
        request,
        decision,
        intervened: false,
        at: Date.now(),
      });
    });

    const historyActions = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(historyActions).toHaveLength(1);
    expect(historyActions[0].entry).toMatchObject({
      kind: 'brain',
      status: 'answered',
      source: 'monitor',
      decision: 'The signal is too ambiguous to intervene safely',
      outcome: 'observed — no action needed',
      interventionKind: 'error_storm',
    });
    unmount();
  });
});

describe('useBrainEvents — council tier', () => {
  const request = {
    id: 'req-council',
    source: 'director' as const,
    question: 'Merge the risky change?',
    risk: 'high' as const,
    fallback: 'ask_human' as const,
  };
  const councilVote = (over: Record<string, unknown>) => ({
    requestId: request.id,
    seatId: 'voter-0',
    persona: 'executor',
    status: 'valid' as const,
    optionId: 'merge',
    at: Date.now(),
    ...over,
  });

  it('attaches the panel trace to the decision entry the council produced', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));

    act(() => {
      // Ordering is guaranteed: both council events are emitted from inside
      // council.decide(), which resolves before the decision_* event.
      events.emit('brain.council_vote', councilVote({}));
      events.emit(
        'brain.council_vote',
        councilVote({ seatId: 'voter-1', persona: 'skeptic', veto: true, model: 'gpt-5' }),
      );
      events.emit('brain.council_resolved', {
        requestId: request.id,
        status: 'decided',
        resolution: 'majority',
        optionId: 'merge',
        configuredSeatCount: 2,
        validVoteCount: 2,
        distinctTargetCount: 1,
        judgeUsed: false,
        usage: { calls: 2, inputTokens: 10, outputTokens: 5, totalTokens: 15, durationMs: 1200 },
        warnings: ['Council distinctness policy "model" was not met.'],
        at: Date.now(),
      });
      events.emit('brain.decision_answered', {
        request,
        decision: { type: 'answer' as const, optionId: 'merge', text: 'Merge it' },
        at: Date.now(),
      });
    });

    const entry = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === 'addEntry')?.entry;
    expect(entry.council).toMatchObject({
      resolution: 'majority',
      configuredSeatCount: 2,
      validVoteCount: 2,
      distinctTargetCount: 1,
      judgeUsed: false,
      totalTokens: 15,
      durationMs: 1200,
    });
    expect(entry.council.seats).toHaveLength(2);
    expect(entry.council.seats[1]).toMatchObject({
      persona: 'skeptic',
      veto: true,
      model: 'gpt-5',
    });
    expect(entry.council.warnings).toHaveLength(1);
    unmount();
  });

  it('reports seat progress while the panel is still voting', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));

    act(() => {
      events.emit('brain.council_vote', councilVote({}));
      events.emit('brain.council_vote', councilVote({ seatId: 'voter-1', persona: 'skeptic' }));
    });

    const statuses = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'brainStatus');
    expect(statuses.at(-1)).toMatchObject({
      state: 'deciding',
      source: 'council',
      summary: 'council · 2 seats voted',
    });
    unmount();
  });

  it('leaves non-council decisions without a council trace', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));

    act(() => {
      events.emit('brain.decision_denied', {
        request,
        decision: { type: 'deny' as const, reason: 'policy' },
        at: Date.now(),
      });
    });

    const entry = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === 'addEntry')?.entry;
    expect(entry.council).toBeUndefined();
    unmount();
  });
});

describe('useBrainEvents — interactive escalation', () => {
  const request = {
    id: 'req-esc',
    source: 'director' as const,
    question: 'Merge the risky change?',
    risk: 'high' as const,
    fallback: 'ask_human' as const,
    options: [{ id: 'merge', label: 'Merge' }],
  };

  it('raises the prompt on a pending ask_human without writing a history row', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));

    act(() => {
      events.emit('brain.decision_ask_human', {
        request,
        decision: { type: 'ask_human', prompt: 'pick one' },
        at: Date.now(),
        pending: true,
      });
    });

    const actions = dispatch.mock.calls.map(([action]) => action);
    // The prompt UI is the visible waiting state...
    expect(actions.some((a) => a.type === 'brainPromptSet')).toBe(true);
    // ...but the row belongs to whatever the human actually decides.
    expect(actions.filter((a) => a.type === 'addEntry')).toHaveLength(0);
    unmount();
  });

  it('writes exactly one row per escalated decision, carrying the council panel', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));

    act(() => {
      events.emit('brain.council_resolved', {
        requestId: request.id,
        status: 'abstained',
        resolution: 'none',
        configuredSeatCount: 3,
        validVoteCount: 1,
        distinctTargetCount: 1,
        judgeUsed: false,
        at: Date.now(),
      });
      events.emit('brain.decision_ask_human', {
        request,
        decision: { type: 'ask_human', prompt: 'pick one' },
        at: Date.now(),
        pending: true,
      });
      events.emit('brain.decision_answered', {
        request,
        decision: { type: 'answer', optionId: 'merge', text: 'Merge' },
        at: Date.now(),
        tier: 'human',
      });
    });

    const rows = dispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action.type === 'addEntry');
    expect(rows).toHaveLength(1);
    expect(rows[0].entry).toMatchObject({ status: 'answered', decision: 'merge' });
    // The buffered panel used to be drained by the prompt event, so the row
    // that carried the real verdict showed no council at all.
    expect(rows[0].entry.council).toMatchObject({ configuredSeatCount: 3 });
    unmount();
  });
});
