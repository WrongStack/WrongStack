import {
  collectDisplayedSessionIds,
  scheduleOwnerlessEmptySessionCleanup,
  toSessionHistoryEntries,
} from '@wrongstack/webui-server';
import { consoleLogger } from './webui-server/logger-shim.js';

interface SetupWebuiSessionMaintenanceInput {
  opts: import('./webui-server-options.js').CliWebUIOptions;
  broadcastEveryone: (msg: import('./webui-server/contracts.js').WSServerMessage) => void;
  getForegroundSession: () => import('@wrongstack/contracts/types').SessionWriter;
  clients: Map<
    import('ws').default,
    import('./webui-server/connection-handler.js').ConnectedClient
  >;
  abortControllers: Map<string, AbortController>;
}

export function setupWebuiSessionMaintenance({
  opts,
  broadcastEveryone,
  getForegroundSession,
  clients,
  abortControllers,
}: SetupWebuiSessionMaintenanceInput): {
  stopEmptySessionCleanup: {
    runNow: ReturnType<typeof scheduleOwnerlessEmptySessionCleanup>['runNow'];
    dispose: () => Promise<void>;
  } | null;
} {
  /**
   * Sweep sessions that were started and never used.
   *
   * Every launch of this host opens a session, and so does every `New tab`
   * the user then closes without typing. This sweeper existed but was wired
   * into the STANDALONE WebUI host only, so the host `wstack --webui` actually
   * runs accumulated one dead, empty record per launch forever. They filled
   * the history list, and the ones the runtime or a tab still held could not
   * even be deleted by hand — "empty sessions I can't delete, and it says
   * they are live".
   *
   * Everything volatile is read at sweep time, never captured: the runtime's
   * current session, every session a connected page declares (a background
   * tab's brand-new session is empty BY DEFINITION and must not be swept out
   * from under it), and — stricter than the standalone host — every session
   * with a live run, whose journal is empty only because its first turn has
   * not landed yet. The store's own fail-closed `isEmpty` is the final word.
   */
  const refreshSessionHistory = async (): Promise<void> => {
    const list = await opts.sessionStore?.list(200);
    if (!list) return;
    broadcastEveryone({
      type: 'sessions.list',
      payload: { sessions: toSessionHistoryEntries(list, getForegroundSession().id) },
    });
  };
  const emptySessionCleanup = opts.sessionStore
    ? scheduleOwnerlessEmptySessionCleanup({
        getSessionStore: () => opts.sessionStore as NonNullable<typeof opts.sessionStore>,
        getActiveSessionId: () => getForegroundSession().id,
        getActiveSessionIds: () =>
          collectDisplayedSessionIds({ getSession: getForegroundSession, clients }),
        // A run outlives the tab that started it, and a turn that has not
        // written its first record yet looks exactly like a session nobody
        // ever used.
        hasParticipants: (sessionId) => abortControllers.has(sessionId),
        refreshSessions: refreshSessionHistory,
        logger: consoleLogger,
      })
    : null;
  // A session the model renamed (`session_rename`) shows its new name in
  // every open history list, as a rename from the list itself does. Not in
  // `eventUnsubscribers`: setupEvents() flushes that list when it subscribes.
  const offSessionRenamed = opts.sessionStore
    ? opts.events.on('session.renamed', () => {
        void refreshSessionHistory().catch(() => undefined);
      })
    : undefined;
  const stopEmptySessionCleanup = emptySessionCleanup && {
    runNow: emptySessionCleanup.runNow,
    dispose: async () => {
      offSessionRenamed?.();
      await emptySessionCleanup.dispose();
    },
  };
  return { stopEmptySessionCleanup };
}
