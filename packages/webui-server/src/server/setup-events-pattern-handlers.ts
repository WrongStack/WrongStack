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
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.agent_registered', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.agent_registered',
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.agent_deregistered', (_e, payload) => {
      broadcast(clients, {
        type: 'mailbox.agent_deregistered',
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
    events.onPattern('mailbox.*', (eventName, payload) => {
      broadcast(clients, {
        type: 'mailbox.event',
        payload: sessionPayload({ event: eventName, ...(payload as Record<string, unknown>) }),
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
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
    events.onPattern('cron:job_fired', (_eventName, payload) => {
      broadcast(clients, {
        type: 'cron.job_fired',
        payload: sessionPayload(payload as Record<string, unknown>),
      } as never as WSServerMessage);
    }),
  ];
}
