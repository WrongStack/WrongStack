/**
 * W4 #4 (RFC hq-improvements-2026-09.md) — correlation ids.
 *
 * `HqEventEnvelope.correlationId` groups envelopes that belong to one logical
 * activity. The contract under test is deliberately narrow: the id is
 * PRODUCER-assigned and HQ must not invent or merge it, so what matters is
 * that a bridge stamps the same value on every event of one activity and a
 * different value on the next one's. A test that only asserted "the field is
 * present" would pass on a constant, which is precisely the bug this guards.
 *
 * @module tests/hq/correlation-id
 */

import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it, vi } from 'vitest';
import { startBrainTelemetryBridge } from '../src/brain-bridge.js';
import { startFleetTelemetryBridge } from '../src/fleet-bridge.js';
import { createHqEventEnvelope } from '../src/index.js';
import { HqPublisher, type HqSocketLike } from '../src/publisher.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const client = {
  clientId: 'c1',
  kind: 'cli' as const,
  machineId: 'm1',
  startedAt: '2026-09-13T00:00:00.000Z',
};
const project = {
  projectId: 'p1',
  projectRoot: '/repo',
  projectName: 'repo',
  machineId: 'm1',
  workspaceKind: 'git' as const,
};

const baseRequest = {
  id: 'req-1',
  source: 'system' as const,
  question: 'Should I deploy?',
  risk: 'medium' as const,
  fallback: 'deny' as const,
};

/** Captures the options each bridge hands to the publisher. */
function fakePublisher(
  spy: (options: { correlationId?: string }) => void,
  fleetSpy?: (options: { payload: unknown; correlationId?: string }) => void,
) {
  return {
    publishEvent: (o: { correlationId?: string }) => {
      spy(o);
      return {} as never;
    },
    publishFleetSnapshot: (payload: unknown, opts: { correlationId?: string }) => {
      fleetSpy?.({ payload, ...opts });
      return {} as never;
    },
    // The fleet bridge re-announces its last snapshot on every reconnect, so
    // it subscribes here at start-up; a stub without this throws before any
    // event is ever emitted.
    onConnected: () => () => {},
  } as never;
}

class FakeSocket implements HqSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
  }
  listener(): void {}
  on(): void {}
  off(): void {}
}

/** Parse the last frame the publisher actually put on the wire. */
function lastEvent(socket: FakeSocket): { event: Record<string, unknown> } {
  const raw = socket.sent.at(-1);
  if (raw === undefined) throw new Error('no frame was sent');
  return JSON.parse(raw) as { event: Record<string, unknown> };
}

// ── Envelope factory ──────────────────────────────────────────────────────

describe('HqEventEnvelope.correlationId (W4 #4)', () => {
  it('carries the correlationId it is given', () => {
    const envelope = createHqEventEnvelope({
      id: 'e1',
      type: 'brain.event',
      timestamp: '2026-09-13T00:00:00.000Z',
      clientId: 'c1',
      projectId: 'p1',
      seq: 1,
      payload: {},
      correlationId: 'req-1',
    });
    expect(envelope.correlationId).toBe('req-1');
  });

  it('omits the key entirely when no id is supplied', () => {
    const envelope = createHqEventEnvelope({
      id: 'e1',
      type: 'brain.event',
      timestamp: '2026-09-13T00:00:00.000Z',
      clientId: 'c1',
      projectId: 'p1',
      seq: 1,
      payload: {},
    });
    // `in` rather than `toBeUndefined()`: an explicit `correlationId: undefined`
    // serialises as an absent key anyway, so only the key-presence check can
    // tell the two apart before serialisation.
    expect('correlationId' in envelope).toBe(false);
  });

  it('is additive — an uncorrelated envelope still satisfies the old shape', () => {
    const envelope = createHqEventEnvelope({
      id: 'e1',
      type: 'session.status',
      timestamp: '2026-09-13T00:00:00.000Z',
      clientId: 'c1',
      projectId: 'p1',
      seq: 7,
      payload: { status: 'running' },
      sessionId: 's1',
      runId: 'r1',
    });
    expect(envelope.sessionId).toBe('s1');
    expect(envelope.runId).toBe('r1');
    expect(envelope.seq).toBe(7);
  });
});

// ── Brain bridge ──────────────────────────────────────────────────────────

describe('brain bridge correlation (W4 #4)', () => {
  it('gives two events of ONE decision the same correlation id', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const stop = startBrainTelemetryBridge({
      events,
      publisher: fakePublisher(spy),
      sessionId: 's1',
    });

    events.emit('brain.decision_requested', {
      sessionId: 's1',
      request: baseRequest,
      at: 1000,
    });
    events.emit('brain.decision_answered', {
      sessionId: 's1',
      request: baseRequest,
      decision: { type: 'answer', text: 'yes' },
      at: 1010,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    const [requested, answered] = spy.mock.calls.map((c) => c[0] as { correlationId?: string });
    expect(requested?.correlationId).toBe('req-1');
    expect(answered?.correlationId).toBe('req-1');
    // The whole point: they are linked to each other, not merely both tagged.
    expect(requested?.correlationId).toBe(answered?.correlationId);
    stop();
  });

  it('gives events of DIFFERENT decisions different ids', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const stop = startBrainTelemetryBridge({
      events,
      publisher: fakePublisher(spy),
      sessionId: 's1',
    });

    events.emit('brain.decision_requested', { sessionId: 's1', request: baseRequest, at: 1000 });
    events.emit('brain.decision_requested', {
      sessionId: 's1',
      request: { ...baseRequest, id: 'req-2' },
      at: 2000,
    });

    const [first, second] = spy.mock.calls.map((c) => c[0] as { correlationId?: string });
    expect(first?.correlationId).toBe('req-1');
    expect(second?.correlationId).toBe('req-2');
    expect(first?.correlationId).not.toBe(second?.correlationId);
    stop();
  });

  it('correlates every decision outcome kind, not just the request', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const stop = startBrainTelemetryBridge({
      events,
      publisher: fakePublisher(spy),
      sessionId: 's1',
    });

    events.emit('brain.decision_denied', {
      sessionId: 's1',
      request: baseRequest,
      decision: { type: 'deny', reason: 'unsafe' },
      at: 1000,
    });
    events.emit('brain.decision_ask_human', {
      sessionId: 's1',
      request: baseRequest,
      decision: { type: 'ask_human', prompt: 'really?' },
      at: 1010,
    });
    events.emit('brain.intervention', {
      sessionId: 's1',
      request: baseRequest,
      decision: { type: 'answer', text: 'stop' },
      kind: 'tool_failure_streak',
      intervened: true,
      at: 1020,
    });

    const ids = spy.mock.calls.map((c) => (c[0] as { correlationId?: string }).correlationId);
    expect(ids).toEqual(['req-1', 'req-1', 'req-1']);
    stop();
  });

  it('uses the council answer id when the event has no full request', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const stop = startBrainTelemetryBridge({
      events,
      publisher: fakePublisher(spy),
      sessionId: 's1',
    });

    // A council answer names its request directly rather than carrying a full
    // decision request. Its id remains the correlation key.
    events.emit('brain.human_answered', {
      sessionId: 's1',
      id: 'req-council',
      optionId: 'a',
      at: 1000,
    });

    const [call] = spy.mock.calls.map((c) => c[0] as { correlationId?: string });
    expect(call?.correlationId).toBe('req-council');
    stop();
  });
});

// ── Fleet bridge ──────────────────────────────────────────────────────────

describe('fleet bridge correlation (W4 #4)', () => {
  it('stamps the run id as the correlation id', () => {
    const events = new EventBus();
    const fleetSpy = vi.fn();
    const stop = startFleetTelemetryBridge({
      events,
      publisher: fakePublisher(vi.fn(), fleetSpy),
      runId: 'run-7',
    });

    events.emit('coordinator.stats', {
      total: 1,
      running: 1,
      idle: 0,
      stopped: 0,
      inFlight: 0,
      pending: 0,
      completed: 0,
      subagentStatuses: [],
    });

    expect(fleetSpy).toHaveBeenCalledTimes(1);
    expect((fleetSpy.mock.calls[0]![0] as { correlationId?: string }).correlationId).toBe('run-7');
    stop();
  });

  it('uses a different id for a different run', () => {
    const events = new EventBus();
    const fleetSpy = vi.fn();
    const stop = startFleetTelemetryBridge({
      events,
      publisher: fakePublisher(vi.fn(), fleetSpy),
      runId: 'run-8',
    });

    events.emit('coordinator.stats', {
      total: 0,
      running: 0,
      idle: 0,
      stopped: 0,
      inFlight: 0,
      pending: 0,
      completed: 0,
      subagentStatuses: [],
    });

    expect((fleetSpy.mock.calls[0]![0] as { correlationId?: string }).correlationId).toBe('run-8');
    stop();
  });
});

// ── Wire normalisation ────────────────────────────────────────────────────

describe('publisher correlation normalisation (W4 #4)', () => {
  it('puts the correlationId on the frame it sends', () => {
    const socket = new FakeSocket();
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      socketFactory: () => socket,
      reconnect: false,
    });
    publisher.connect();
    socket.open();

    publisher.publishEvent({ type: 'brain.event', payload: {}, correlationId: 'req-9' });

    expect(lastEvent(socket).event.correlationId).toBe('req-9');
  });

  it('drops an EMPTY correlationId rather than forwarding it', () => {
    const socket = new FakeSocket();
    const publisher = new HqPublisher({
      url: 'http://localhost:3499',
      client,
      project,
      socketFactory: () => socket,
      reconnect: false,
    });
    publisher.connect();
    socket.open();

    // Normalised at this single choke point, so no bridge has to remember to.
    // An empty string on the wire reads as a real id matching nothing, which
    // would make two unrelated activities look like one broken chain.
    publisher.publishEvent({ type: 'brain.event', payload: {}, correlationId: '' });

    expect('correlationId' in lastEvent(socket).event).toBe(false);
  });
});
