import { scheduleOwnerlessEmptySessionCleanup } from './session-cleanup-scheduler.js';
import { collectDisplayedSessionIds } from './session-handlers.js';
import { toSessionHistoryEntries } from './session-history.js';
import { broadcast } from './ws-utils.js';

interface SetupStandaloneSessionMaintenanceInput {
  state: import('./route-contracts.js').WebuiMutableState;
  clients: Map<import('ws').default, import('./types.js').ConnectedClient>;
  collabHandler: import('./collaboration-ws-handler.js').CollaborationWebSocketHandler;
  logger: import('@wrongstack/core/infrastructure').DefaultLogger;
  events: import('@wrongstack/contracts/kernel').EventBus;
}

export function setupStandaloneSessionMaintenance({
  state,
  clients,
  collabHandler,
  logger,
  events,
}: SetupStandaloneSessionMaintenanceInput): {
  stopEmptySessionCleanup: ReturnType<typeof scheduleOwnerlessEmptySessionCleanup>;
  offSessionRenamed: () => void;
} {
  const refreshSessionHistory = async (): Promise<void> => {
    const list = await state.getSessionStore().list(200);
    broadcast(clients, {
      type: 'sessions.list',
      payload: { sessions: toSessionHistoryEntries(list, state.getSession().id) },
    });
  };
  const stopEmptySessionCleanup = scheduleOwnerlessEmptySessionCleanup({
    getSessionStore: state.getSessionStore,
    getActiveSessionId: () => state.getSession().id,
    // Every tab the browser declared, not just the one in front — a
    // background tab's brand-new session is empty and would otherwise be
    // swept out from under it.
    getActiveSessionIds: () =>
      collectDisplayedSessionIds({ getSession: state.getSession, clients }),
    hasParticipants: (sessionId) => collabHandler.hasParticipants(sessionId),
    refreshSessions: refreshSessionHistory,
    logger,
  });
  // A session the model renamed (`session_rename`) shows its new name in
  // every open history list, as a rename from the list itself does.
  const offSessionRenamed = events.on('session.renamed', () => {
    void refreshSessionHistory().catch(() => undefined);
  });
  return { stopEmptySessionCleanup, offSessionRenamed };
}
