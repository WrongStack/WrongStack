import type { EventBus } from '@wrongstack/core/kernel';
import type { WebSocket } from 'ws';
import type { ConnectedClient, WSServerMessage } from './types.js';

export function registerSetupEventsPatternHandlers(options: {
  events: EventBus;
  broadcast: (
    clients: Map<WebSocket, ConnectedClient>,
    msg: WSServerMessage,
    /** Deliver to the tab that owns this session, overriding the id on the
     *  payload. Needed when the payload names a SUBAGENT's session, which no
     *  tab subscribes to. */
    targetSessionId?: string,
  ) => void;
  clients: Map<WebSocket, ConnectedClient>;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T;
}): Array<() => void> {
  const { events, broadcast, clients, sessionPayload } = options;

  /**
   * Strip the session from a frame that belongs to the PROJECT, not a tab.
   *
   * The mailbox and the cron scheduler are one per project — there is exactly
   * one of each behind four tabs — and their client handlers write global
   * stores without ever reading a session id. Stamping them was therefore
   * pure loss: `broadcast` filters on the payload's `sessionId`, so a frame
   * carrying whichever session the runtime happened to be on is dropped for
   * every connection that has not declared that session. On one page with
   * four tabs the declared set covers it; a second page sees no mail arrive
   * and a frozen cron table. Unstamped frames reach every connection, which
   * is what a project-wide fact needs.
   *
   * Only for events whose consumers are genuinely global. `chimera.*`,
   * `brain.*` and `memory.*` keep the stamp — their handlers address the
   * lane the id names.
   */
  const projectWide = (payload: unknown): Record<string, unknown> => {
    const { sessionId: _dropped, ...rest } = (payload ?? {}) as Record<string, unknown>;
    return rest;
  };
  return [
    events.onPattern('chimera.report_available', (_event, payload) => {
      broadcast(clients, {
        type: 'chimera.report_available',
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.received', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.received',
        payload: projectWide(payload),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.agent_registered', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.agent_registered',
        payload: projectWide(payload),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.agent_deregistered', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.agent_deregistered',
        payload: projectWide(payload),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'mailbox.event',
        payload: { event: eventName, ...projectWide(payload) },
      });
    }),
    events.onPattern('brain.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'brain.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
      } as never as WSServerMessage);
    }),
    events.onPattern('memory.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'memory.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
      });
    }),
    events.onPattern('cron:state_snapshot', (_eventName, payload) => {
      broadcast(clients, {
        type: 'cron.snapshot',
        payload: projectWide(payload),
      } as never as WSServerMessage);
    }),
    events.onPattern('cron:job_fired', (_eventName, payload) => {
      broadcast(clients, {
        type: 'cron.job_fired',
        payload: projectWide(payload),
      } as never as WSServerMessage);
    }),
  ];
}
