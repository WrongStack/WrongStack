import { describe, expect, it, vi } from 'vitest';
import { startBrainTelemetryBridge } from '../../src/hq/brain-bridge.js';
import type { HqBrainEventPayload } from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { EventBus } from '../../src/kernel/events.js';

function fakePublisher(spy: ReturnType<typeof vi.fn>): HqPublisher {
  return {
    publishEvent: (o: { type: string; payload: unknown }) => {
      spy(o);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

const baseRequest = {
  id: 'req-1',
  source: 'system' as const,
  question: 'Should I deploy?',
  risk: 'medium' as const,
  fallback: 'deny' as const,
};

describe('startBrainTelemetryBridge', () => {
  it('forwards brain.decision_requested', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startBrainTelemetryBridge({ events, publisher, sessionId: 's1' });
    events.emit('brain.decision_requested', { sessionId: 's1', request: baseRequest, at: 1000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.type).toBe('brain.event');
    expect(call.payload.kind).toBe('decision_requested');
    expect(call.payload.requestId).toBe('req-1');
    expect(call.payload.question).toBe('Should I deploy?');
    expect(call.payload.source).toBe('system');
    expect(call.payload.risk).toBe('medium');
    expect(call.payload.at).toBe(1000);
    stop();
  });

  it('forwards brain.decision_answered with decision fields', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startBrainTelemetryBridge({ events, publisher });
    events.emit('brain.decision_answered', {
      request: baseRequest,
      decision: { type: 'answer', text: 'yes', rationale: 'looks good' },
      at: 2000,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('decision_answered');
    expect(payload.decision).toBe('answer');
    expect(payload.detail).toBe('yes');
  });

  it('forwards brain.decision_denied with reason as detail', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startBrainTelemetryBridge({ events, publisher });
    events.emit('brain.decision_denied', {
      request: baseRequest,
      decision: { type: 'deny', reason: 'too risky' },
      at: 3000,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('decision_denied');
    expect(payload.decision).toBe('deny');
    expect(payload.detail).toBe('too risky');
  });

  it('forwards brain.decision_ask_human with prompt as detail', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startBrainTelemetryBridge({ events, publisher });
    events.emit('brain.decision_ask_human', {
      request: baseRequest,
      decision: { type: 'ask_human', prompt: 'please confirm' },
      at: 4000,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('decision_ask_human');
    expect(payload.detail).toBe('please confirm');
  });

  it('forwards brain.intervention with kind and intervened flag', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startBrainTelemetryBridge({ events, publisher });
    events.emit('brain.intervention', {
      kind: 'tool_failure_streak',
      request: baseRequest,
      decision: { type: 'answer', text: 'steer' },
      intervened: true,
      at: 5000,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('intervention');
    expect(payload.interventionKind).toBe('tool_failure_streak');
    expect(payload.intervened).toBe(true);
  });

  it('forwards brain.human_answered', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startBrainTelemetryBridge({ events, publisher });
    events.emit('brain.human_answered', { id: 'req-1', optionId: 'opt-a', at: 6000 });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('human_answered');
    expect(payload.detail).toBe('opt-a');
  });

  it('disposer unsubscribes all listeners', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startBrainTelemetryBridge({ events, publisher });
    stop();
    events.emit('brain.decision_requested', { request: baseRequest, at: 1 });
    events.emit('brain.intervention', {
      kind: 'error_storm',
      request: baseRequest,
      decision: { type: 'deny', reason: 'x' },
      intervened: false,
      at: 1,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws on publisher failure', () => {
    const events = new EventBus();
    const publisher = {
      publishEvent: () => {
        throw new Error('boom');
      },
    } as unknown as HqPublisher;
    const stop = startBrainTelemetryBridge({ events, publisher });
    expect(() =>
      events.emit('brain.decision_requested', { request: baseRequest, at: 1 }),
    ).not.toThrow();
    stop();
  });
});

describe('startBrainTelemetryBridge — tier and council visibility', () => {
  it('carries the resolving tier onto the HQ envelope', () => {
    const events = new EventBus();
    const spy = vi.fn();
    startBrainTelemetryBridge({ events, publisher: fakePublisher(spy) });
    events.emit('brain.decision_answered', {
      request: baseRequest,
      decision: { type: 'answer', text: 'yes' },
      at: 1,
      tier: 'council',
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    // Without this a free rule hit and a multi-model council call are the
    // same row at the command centre.
    expect(payload.tier).toBe('council');
  });

  it('marks a pending escalation so an operator can see a blocked agent', () => {
    const events = new EventBus();
    const spy = vi.fn();
    startBrainTelemetryBridge({ events, publisher: fakePublisher(spy) });
    events.emit('brain.decision_ask_human', {
      request: baseRequest,
      decision: { type: 'ask_human', prompt: 'pick' },
      at: 1,
      pending: true,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.pending).toBe(true);
  });

  it('forwards a council resolution with its panel-integrity signals', () => {
    const events = new EventBus();
    const spy = vi.fn();
    startBrainTelemetryBridge({ events, publisher: fakePublisher(spy) });
    events.emit('brain.council_resolved', {
      requestId: 'req-1',
      status: 'decided',
      resolution: 'judge',
      configuredSeatCount: 3,
      validVoteCount: 2,
      distinctTargetCount: 1,
      judgeUsed: true,
      judgeLabel: 'p/m1',
      judgeIsVoter: true,
      usage: {
        calls: 4,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        durationMs: 900,
      },
      warnings: ['1 distinct target(s) served 2 valid vote(s)'],
      at: 5,
    });
    const payload: HqBrainEventPayload = spy.mock.calls[0]![0].payload;
    expect(payload.kind).toBe('council_resolved');
    expect(payload.resolution).toBe('judge');
    expect(payload.distinctTargetCount).toBe(1);
    expect(payload.judgeIsVoter).toBe(true);
    expect(payload.totalTokens).toBe(150);
    expect(payload.warnings).toHaveLength(1);
  });
});
