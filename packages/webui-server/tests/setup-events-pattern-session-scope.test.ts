/**
 * Project-wide frames must not carry a tab's session id.
 *
 * `broadcast` decides delivery from the payload's `sessionId`: a stamped frame
 * only reaches connections that declared that session. The mailbox and the
 * cron scheduler are one per project and their client handlers write global
 * stores without reading a session at all, so stamping them with whichever
 * session the runtime happened to be on could only ever lose frames — a
 * second browser page would see no mail arrive and a cron table that never
 * ticks. The three families whose handlers DO address a lane keep the stamp;
 * this pins both halves so neither drifts into the other.
 */
import { describe, expect, it } from 'vitest';
import { registerSetupEventsPatternHandlers } from '../src/server/setup-events-pattern-handlers.js';

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
    ['brain.*', 'brain.decision'],
    ['memory.*', 'memory.injected'],
  ])('keeps the stamp on %s, whose handlers address a lane', (pattern, event) => {
    const sent = register().emit(pattern, event, { detail: 1 });

    expect(sent.payload['sessionId']).toBe(RUNTIME_SESSION);
  });

  it('does not overwrite a session the emitter already named', () => {
    const sent = register().emit('memory.*', 'memory.injected', { sessionId: 'sess_b' });

    expect(sent.payload['sessionId']).toBe('sess_b');
  });
});
