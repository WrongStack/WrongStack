import type { SurfaceClient, SurfaceMessage } from '@wrongstack/project-surfaces/host';
import type {
  OfficeCurrentSession,
  OfficeFeed,
  OfficeSelf,
} from '@wrongstack/project-surfaces/office/feed';
import {
  mailboxVizEvent,
  normalizeLiveSessions,
  retainMailboxAgents,
  retainMailboxMessages,
} from '@wrongstack/project-surfaces/office/feed-model';
import type {
  AgentTranscriptEntry,
  LiveSession,
  MailboxAgent,
  MailboxMessage,
  SubagentView,
  VizEvent,
} from '@wrongstack/project-surfaces/office/types';
import type { SurfaceSend } from '@wrongstack/project-surfaces/sage/socket';
import { createStore, useStore } from 'zustand';

interface OfficeState {
  liveSessions: LiveSession[];
  currentSession: OfficeCurrentSession;
  mailboxMessages: MailboxMessage[];
  mailboxAgents: MailboxAgent[];
  vizEvents: VizEvent[];
}

/** Activity feed entries kept, newest first. */
export const OFFICE_FEED_LIMIT = 200;
/** Mailbox traffic arrives in bursts; one refresh per burst. */
const MAILBOX_REFRESH_DEBOUNCE_MS = 300;
/** At most one mailbox refresh per registry snapshot interval. */
const MAILBOX_REFRESH_MIN_GAP_MS = 5000;

export const DESKTOP_SELF: OfficeSelf = { label: 'This desktop', sublabel: 'Desktop' };

const NO_AGENTS: ReadonlyMap<string, SubagentView> = new Map();
const NO_TRANSCRIPTS: ReadonlyMap<string, AgentTranscriptEntry[]> = new Map();
const NO_EVENTS: VizEvent[] = [];

function payloadOf(message: SurfaceMessage): Record<string, unknown> {
  const payload = message.payload as unknown;
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function currentSessionFrom(payload: Record<string, unknown>): OfficeCurrentSession {
  const text = (key: string) => (typeof payload[key] === 'string' ? payload[key] : undefined);
  const count = (key: string) => (typeof payload[key] === 'number' ? payload[key] : undefined);
  return {
    clientType: text('clientType'),
    agentCount: count('agentCount'),
    model: text('model'),
    mode: text('mode'),
    toolCalls: count('toolCalls'),
    costUsd: count('costUsd'),
  };
}

/**
 * The office feed for one desktop project, read from the project's frames: the session
 * registry snapshot (`sessions.status_update`, every few seconds), the mailbox (asked for on
 * start and after mailbox traffic) and the mailbox traffic itself as the activity feed.
 * Fleet agents and their transcripts are conversation frames and stay empty here; the
 * registry snapshot already carries each agent's tools, mail, todos and activity.
 */
export function desktopOfficeFeed({
  client,
  send,
  projectName,
  pingFleet,
}: {
  client: SurfaceClient;
  send: SurfaceSend;
  projectName: string;
  /** Asks the engine for a registry snapshot now instead of at its next poll. */
  pingFleet?: (() => Promise<unknown>) | undefined;
}): { feed: OfficeFeed; start: () => () => void } {
  const store = createStore<OfficeState>(() => ({
    liveSessions: [],
    currentSession: {},
    mailboxMessages: [],
    mailboxAgents: [],
    vizEvents: [],
  }));
  let lastRefresh = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let eventSeq = 0;

  const refreshMailbox = () => {
    lastRefresh = Date.now();
    send({ type: 'mailbox.messages', payload: { limit: 30, incompleteOnly: true } });
    send({ type: 'mailbox.agents', payload: {} });
  };
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshMailbox, MAILBOX_REFRESH_DEBOUNCE_MS);
  };

  const start = () => {
    const offs = [
      client.on('sessions.status_update', (message) => {
        const sessions = payloadOf(message)['sessions'];
        if (!Array.isArray(sessions)) return;
        store.setState({ liveSessions: normalizeLiveSessions(sessions as LiveSession[]) });
        if (Date.now() - lastRefresh >= MAILBOX_REFRESH_MIN_GAP_MS) refreshMailbox();
      }),
      client.on('client.status_update', (message) =>
        store.setState({ currentSession: currentSessionFrom(payloadOf(message)) }),
      ),
      client.on('mailbox.messages', (message) => {
        const messages = payloadOf(message)['messages'];
        if (Array.isArray(messages))
          store.setState({ mailboxMessages: retainMailboxMessages(messages as MailboxMessage[]) });
      }),
      client.on('mailbox.agents', (message) => {
        const agents = payloadOf(message)['agents'];
        if (Array.isArray(agents))
          store.setState({
            mailboxAgents: retainMailboxAgents(agents as MailboxAgent[], Date.now()),
          });
      }),
      client.on('mailbox.agent_deregistered', (message) => {
        const agentId = payloadOf(message)['agentId'];
        store.setState((state) => ({
          mailboxAgents: state.mailboxAgents.filter((agent) => agent.agentId !== agentId),
        }));
      }),
      client.on('mailbox.cleared', () => store.setState({ mailboxMessages: [] })),
      client.on('mailbox.event', (message) => {
        eventSeq += 1;
        const event = mailboxVizEvent(payloadOf(message), `office-mailbox-${eventSeq}`);
        // Heartbeats keep agents alive every few seconds; they are not traffic.
        if (!event) return;
        store.setState((state) => ({
          vizEvents: [event, ...state.vizEvents].slice(0, OFFICE_FEED_LIMIT),
        }));
        scheduleRefresh();
      }),
      ...['mailbox.received', 'mailbox.agent_registered', 'mailbox.purged'].map((type) =>
        client.on(type, scheduleRefresh),
      ),
    ];
    refreshMailbox();
    void pingFleet?.().catch(() => undefined);
    return () => {
      for (const off of offs) off();
      clearTimeout(refreshTimer);
    };
  };

  const feed: OfficeFeed = {
    useLiveSessions: () => useStore(store, (state) => state.liveSessions),
    useCurrentSession: () => useStore(store, (state) => state.currentSession),
    useFleetAgents: () => NO_AGENTS,
    useAgentTranscripts: () => NO_TRANSCRIPTS,
    useLeaderId: () => undefined,
    useMailboxMessages: () => useStore(store, (state) => state.mailboxMessages),
    useMailboxAgents: () => useStore(store, (state) => state.mailboxAgents),
    useVizEvents: () => useStore(store, (state) => state.vizEvents),
    useToolEvents: () => NO_EVENTS,
    useProjectName: () => projectName,
    self: DESKTOP_SELF,
  };
  return { feed, start };
}
