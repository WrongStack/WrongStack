import { useEffect } from 'react';
import { getWSClient } from '@/lib/ws-client';
import { foregroundSessionId } from '@/lib/ws-client-utils';
import { useActiveSessionId, useSessionTabStore } from '@/stores';

/**
 * Tell the server which sessions this page is displaying.
 *
 * Four tabs share ONE WebSocket, so the server cannot infer the open set from
 * the last message's `sessionId`. Without this declaration its broadcast
 * filter delivers only the foreground tab's events and drops the other three
 * at the wire — the client-side lane routing never even sees them, and a
 * background tab looks like it stopped working.
 *
 * The set is re-sent in full on every change (it replaces, it does not merge,
 * so a closed tab actually stops receiving) and re-declared on reconnect,
 * because the server forgets it with the connection.
 */
export function useSessionSubscription(): void {
  const openTabIds = useSessionTabStore((s) => s.openTabIds);
  // The lane pointer, not the lane's SessionInfo: a tab is in front the moment
  // it is clicked, and its SessionInfo only lands with the `session.start`
  // answer. Reading the record left the newest tab out of the declared set for
  // exactly the window in which its first events arrive — the server dropped
  // them at the wire and the tab looked dead.
  const currentSessionId = useActiveSessionId();

  useEffect(() => {
    const ids =
      currentSessionId && !openTabIds.includes(currentSessionId)
        ? [...openTabIds, currentSessionId]
        : openTabIds;
    if (ids.length === 0) return;
    try {
      getWSClient().subscribeSessions(ids);
    } catch {
      // No socket yet — the reconnect effect below re-declares.
    }
  }, [openTabIds, currentSessionId]);

  /**
   * Re-read this tab's preferences from the server whenever the foreground
   * moves.
   *
   * The session-scoped half of the pref snapshot (autonomy, yolo, context
   * strategy, token-saving tier, reasoning, prompt variant) lives on the
   * session's own context meta. The browser keeps a per-tab override map, but
   * it can go stale — another surface, a slash command inside the run, or a
   * resume of a session this page has never seen all change the server's copy
   * without telling us. Asking on switch means the pickers describe the tab
   * that is actually on screen.
   */
  useEffect(() => {
    if (!currentSessionId) return;
    try {
      getWSClient().getPrefs(currentSessionId);
    } catch {
      // No socket yet — the connect path pulls the snapshot itself.
    }
  }, [currentSessionId]);

  useEffect(() => {
    let client: ReturnType<typeof getWSClient>;
    try {
      client = getWSClient();
    } catch {
      return;
    }
    return client.onStatus((status) => {
      if (status.state !== 'open') return;
      // A new connection knows nothing about our tabs. Drop the memo of what
      // we last declared so the next render re-sends the whole set.
      client.clearSessionSubscription();
      const ids = useSessionTabStore.getState().openTabIds;
      const active = foregroundSessionId();
      const full = active && !ids.includes(active) ? [...ids, active] : ids;
      if (full.length > 0) client.subscribeSessions(full);
      // And which of them is in front. A new connection's runtime is wherever
      // it was — after a RESTART, a session that has nothing to do with the
      // restored strip — so without this every message from the tab the user
      // is looking at comes back "this WebUI runtime is currently on …": a
      // page that looks alive and cannot be typed into. A focus on a session
      // the process is not holding opens it, so this is also the moment a
      // reconnecting page reclaims its conversation.
      //
      // `restoreOpenTabsOnBoot` sends the same focus, but only if the socket
      // happens to be open by the time it runs at mount. This one fires on
      // every open, which is the case that has to be covered.
      if (active) client.focusSessionById(active);
    });
  }, []);
}
