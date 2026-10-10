/**
 * Project-wide frames must not carry a tab's session id.
 *
 * `broadcast` decides delivery from the payload's `sessionId`: a stamped frame
 * only reaches connections that declared that session. The mailbox and the
 * cron scheduler are one per project and their client handlers write global
 * stores without reading a session at all, so stamping them with whichever
 * session the runtime happened to be on could only ever lose frames — a
 * second browser page would see no mail arrive and a cron table that never
 * ticks. Chimera and memory events retain their existing session behavior;
 * Brain events must already name their owning session before broadcasting.
 */
import { ObservableBrainArbiter } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws/native';
import { registerSetupEventsPatternHandlers } from '../src/server/setup-events-pattern-handlers.js';
import { createSetupEventSessionHelpers } from '../src/server/setup-events-session-helpers.js';
import { broadcast } from '../src/server/ws-utils.js';

const RUNTIME_SESSION = 'sess_whichever_tab_the_runtime_is_on';

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

function register() {
  const patterns = new Map<string, (event: string, payload: unknown) => void>();
  const sent: Sent[] = [];

  registerSetupEventsPatternHandlers({
    events: {
      onPattern: (pattern: string, fn: (event: string, payload: unknown) => void) => {
        patterns.set(pattern, fn);
        return () => patterns.delete(pattern);
      },
    } as never,
    broadcast: (_clients, msg) => {
      sent.push(msg as unknown as Sent);
    },
    clients: new Map(),
    // The real helper fills the gap with the runtime's current session.
    sessionPayload: ((payload: Record<string, unknown>) => ({
      sessionId: RUNTIME_SESSION,
      ...payload,
    })) as never,
  });

  return {
    emit(pattern: string, event: string, payload: unknown) {
      const fn = patterns.get(pattern);
      if (!fn) throw new Error(`no handler registered for ${pattern}`);
      fn(event, payload);
      const last = sent.at(-1);
      if (!last) throw new Error(`${pattern} broadcast nothing`);
      return last;
    },
  };
}

describe('setup-events pattern handlers — session scope', () => {
  it.each([
    ['mailbox.received', 'mailbox.received'],
    ['mailbox.agent_registered', 'mailbox.agent_registered'],
    ['mailbox.agent_deregistered', 'mailbox.agent_deregistered'],
    ['cron:state_snapshot', 'cron:state_snapshot'],
    ['cron:job_fired', 'cron:job_fired'],
  ])('broadcasts %s to every connection, unstamped', (pattern, event) => {
    const sent = register().emit(pattern, event, { from: 'chimera', count: 2 });

    expect(sent.payload['sessionId']).toBeUndefined();
    // The rest of the payload survives.
    expect(sent.payload['count']).toBe(2);
  });

  it('drops a session the emitter put on a project-wide payload', () => {
    // A mailbox event that happens to name a session is still a project fact;
    // keeping the id would filter it back down to that one tab.
    const sent = register().emit('mailbox.*', 'mailbox.message_sent', {
      sessionId: 'sess_a',
      to: 'leader',
    });

    expect(sent.payload['sessionId']).toBeUndefined();
    expect(sent.payload['event']).toBe('mailbox.message_sent');
    expect(sent.payload['to']).toBe('leader');
  });

  it.each([
    ['chimera.report_available', 'chimera.report_available'],
    ['memory.*', 'memory.injected'],
  ])('keeps the stamp on %s, whose handlers address a lane', (pattern, event) => {
    const sent = register().emit(pattern, event, { detail: 1 });

    expect(sent.payload['sessionId']).toBe(RUNTIME_SESSION);
  });

  it('does not overwrite a session the emitter already named', () => {
    const sent = register().emit('memory.*', 'memory.injected', { sessionId: 'sess_b' });

    expect(sent.payload['sessionId']).toBe('sess_b');
  });

  it('delivers a background Brain decision only to its owning session and drops unattributable events', async () => {
    const events = new EventBus();
    const foreground = { session: { id: 'tab-1' } };
    const { sessionPayload } = createSetupEventSessionHelpers(foreground as never, undefined);
    const socket = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn() });
    const page = socket();
    const foregroundOnly = socket();
    const backgroundOnly = socket();
    const clients = new Map([
      [
        page as never,
        { ws: page, sessionId: 'tab-1', sessionIds: new Set(['tab-1', 'tab-2', 'tab-3', 'tab-4']) },
      ],
      [
        foregroundOnly as never,
        { ws: foregroundOnly, sessionId: 'tab-1', sessionIds: new Set(['tab-1']) },
      ],
      [
        backgroundOnly as never,
        { ws: backgroundOnly, sessionId: 'tab-3', sessionIds: new Set(['tab-3']) },
      ],
    ]) as never;
    const disposers = registerSetupEventsPatternHandlers({
      events,
      broadcast,
      clients,
      sessionPayload,
    });
    const arbiter = new ObservableBrainArbiter(
      { decide: async () => ({ type: 'answer', text: 'Retry the task' }) },
      events,
    );
    const request = {
      id: 'sdd-rescue-tab-3',
      sessionId: 'tab-3',
      source: 'system' as const,
      question: 'Retry the failed task?',
      risk: 'medium' as const,
      fallback: 'continue' as const,
    };

    try {
      await arbiter.decide(request);
      expect(page.send).toHaveBeenCalledTimes(2);
      expect(backgroundOnly.send).toHaveBeenCalledTimes(2);
      expect(foregroundOnly.send).not.toHaveBeenCalled();
      const frames = page.send.mock.calls.map(([raw]) => JSON.parse(raw as string));
      expect(backgroundOnly.send.mock.calls.map(([raw]) => JSON.parse(raw as string))).toEqual(
        frames,
      );
      expect(frames.map((frame) => [frame.payload.event, frame.payload.sessionId])).toEqual([
        ['brain.decision_requested', 'tab-3'],
        ['brain.decision_answered', 'tab-3'],
      ]);
      expect(frames[1].payload.decision.text).toBe('Retry the task');

      await arbiter.decide({ ...request, id: 'orphan', sessionId: undefined });
      events.emit('brain.outcome', {
        sessionId: '',
        requestId: 'orphan',
        outcome: 'failure',
        at: Date.now(),
      });
      events.emit('brain.outcome', {
        sessionId: ' ',
        requestId: 'orphan',
        outcome: 'failure',
        at: Date.now(),
      });
      expect(page.send).toHaveBeenCalledTimes(2);
      expect(backgroundOnly.send).toHaveBeenCalledTimes(2);
      expect(foregroundOnly.send).not.toHaveBeenCalled();
    } finally {
      for (const dispose of disposers) dispose();
    }
  });
});
