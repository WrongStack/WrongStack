// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrainEvents } from '../src/hooks/use-brain-events.js';

describe('useBrainEvents', () => {
  it('uses the structured form surface without opening a duplicate Brain prompt', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch, () => 'A'));
    act(() =>
      events.emit('brain.decision_ask_human', {
        sessionId: 'A',
        request: {
          id: 'form',
          source: 'system',
          question: 'Pick',
          risk: 'medium',
          fallback: 'ask_human',
        },
        decision: { type: 'ask_human', prompt: 'Pick' },
        pending: true,
        structured: true,
        at: 1,
      }),
    );
    expect(dispatch.mock.calls.some(([action]) => action.type === 'brainPromptSet')).toBe(false);
    expect(dispatch.mock.calls.some(([action]) => action.type === 'brainStatus')).toBe(true);
    unmount();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const monitorRequest = {
    id: 'brainmon-reused',
    source: 'system' as const,
    question: 'Should we intervene?',
    risk: 'medium' as const,
    fallback: 'ask_human' as const,
  };
  const monitorDecision = { type: 'answer' as const, text: 'Continue' };

  it('does not render a foreign request when only the nested request names its session', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch, () => 'alpha'));
    act(() =>
      events.emit('brain.decision_answered', {
        request: { ...monitorRequest, id: 'ordinary-answer', sessionId: 'beta' },
        decision: monitorDecision,
        at: 1,
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
    unmount();
  });

  it('anchors an untagged delayed monitor reply to the session that received it', () => {
    vi.useFakeTimers();
    const events = new EventBus();
    const dispatch = vi.fn();
    let sessionId = 'alpha';
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch, () => sessionId));
    act(() =>
      events.emit('brain.decision_answered', {
        request: monitorRequest,
        decision: monitorDecision,
        at: 1,
      }),
    );
    sessionId = 'beta';
    act(() => vi.advanceTimersByTime(5000));
    expect(dispatch).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps monitor deduplication separate across sessions with the same request id', () => {
    vi.useFakeTimers();
    const events = new EventBus();
    const dispatch = vi.fn();
    let sessionId = 'alpha';
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch, () => sessionId));
    act(() => {
      events.emit('brain.decision_answered', {
        sessionId,
        request: monitorRequest,
        decision: monitorDecision,
        at: 1,
      });
      vi.advanceTimersByTime(5000);
    });
    sessionId = 'beta';
    act(() =>
      events.emit('brain.intervention', {
        sessionId,
        request: monitorRequest,
        decision: monitorDecision,
        kind: 'agent_stall',
        intervened: false,
        at: 2,
      }),
    );
    expect(dispatch.mock.calls.filter(([action]) => action.type === 'addEntry')).toHaveLength(2);
    unmount();
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

  it('attaches the tallied round rather than the last failed round', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.council_vote', councilVote({ round: 2, status: 'failed' }));
      events.emit('brain.council_resolved', {
        requestId: request.id,
        status: 'decided',
        resolution: 'majority',
        configuredSeatCount: 1,
        validVoteCount: 1,
        distinctTargetCount: 1,
        judgeUsed: false,
        rounds: 2,
        votes: [councilVote({ round: 1 })],
        at: 2,
      });
      events.emit('brain.decision_answered', {
        request,
        decision: { type: 'answer', text: 'merge' },
        at: 3,
      });
    });
    const entry = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === 'addEntry')?.entry;
    expect(entry.council.seats[0]).toMatchObject({ round: 1, status: 'valid' });
    unmount();
  });

  it('counts only current-round votes and ignores an older round replay', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch));
    act(() => {
      events.emit('brain.council_vote', councilVote({ round: 1 }));
      events.emit('brain.council_vote', councilVote({ seatId: 'voter-1', round: 1 }));
      events.emit('brain.council_vote', councilVote({ round: 2 }));
    });
    expect(dispatch.mock.calls.at(-1)?.[0].summary).toBe('council r2 · 1 seat voted');
    const count = dispatch.mock.calls.length;
    act(() => events.emit('brain.council_vote', councilVote({ round: 1 })));
    expect(dispatch).toHaveBeenCalledTimes(count);
    unmount();
  });

  it('does not attach another session council when request ids are reused after switching', () => {
    const events = new EventBus();
    const dispatch = vi.fn();
    let sessionId = 'alpha';
    const { unmount } = renderHook(() => useBrainEvents(events, dispatch, () => sessionId));
    act(() => {
      events.emit('brain.council_vote', councilVote({ sessionId: 'alpha' }));
      events.emit('brain.council_resolved', {
        sessionId: 'alpha',
        requestId: request.id,
        status: 'decided',
        resolution: 'majority',
        configuredSeatCount: 1,
        validVoteCount: 1,
        distinctTargetCount: 1,
        judgeUsed: false,
        usage: { calls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, durationMs: 1 },
        at: 1,
      });
      sessionId = 'beta';
      events.emit('brain.decision_answered', {
        sessionId,
        request,
        decision: { type: 'answer', text: 'Beta answer' },
        at: 2,
      });
    });
    const entries = () =>
      dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === 'addEntry');
    expect(entries().at(-1)?.entry.council).toBeUndefined();
    act(() => {
      sessionId = 'alpha';
      events.emit('brain.decision_answered', {
        sessionId,
        request,
        decision: { type: 'answer', text: 'Alpha answer' },
        at: 3,
      });
    });
    expect(entries().at(-1)?.entry.council?.seats).toHaveLength(1);
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
