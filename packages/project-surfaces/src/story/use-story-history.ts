import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChronicleEventView } from './chronicle-types';
import { useStoryFeed } from './feed';

const MAX_EVENTS = 10000;
const REPLY_TIMEOUT_MS = 15000;

interface HistoryState {
  sessionId: string | null;
  events: ChronicleEventView[];
  total: number;
  loading: boolean;
  error: string | null;
  cursor?: string | undefined;
}

/** The conversation's Chronicle history, newest first, refreshed while it runs. */
export function useStoryHistory(sessionId: string | null, live: boolean) {
  const feed = useStoryFeed();
  const [state, setState] = useState<HistoryState>({
    sessionId: null,
    events: [],
    total: 0,
    loading: false,
    error: null,
  });
  /** The query in flight; a newer session or an unmount makes its reply stale. */
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(
    (cursor?: string) => {
      if (!sessionId || pending.current) return;
      if (!feed.supportsChronicle()) {
        setState({
          sessionId,
          events: [],
          total: 0,
          loading: false,
          error: 'Chronicle history is unavailable on this backend.',
        });
        return;
      }
      const request = new AbortController();
      pending.current = request;
      const append = Boolean(cursor);
      setState((previous) =>
        previous.sessionId === sessionId
          ? { ...previous, loading: true, error: null }
          : { sessionId, events: [], total: 0, loading: true, error: null },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          request.abort();
          reject(new Error('No matching history reply. Reconnect or restart the backend.'));
        }, REPLY_TIMEOUT_MS);
      });
      void Promise.race([
        feed.queryChronicle(
          { sessionId, order: 'desc', limit: 5000, ...(cursor ? { cursor } : {}) },
          request.signal,
        ),
        timeout,
      ])
        .then((result) => {
          if (pending.current !== request) return;
          setState((previous) => {
            const records =
              append && previous.sessionId === sessionId
                ? [...previous.events, ...result.events]
                : result.events;
            const events = [
              ...new Map(
                records
                  .filter((event) => event.scope['sessionId'] === sessionId)
                  .map((event) => [event.eventId, event]),
              ).values(),
            ].slice(0, MAX_EVENTS);
            return {
              sessionId,
              events,
              total: append ? Math.max(previous.total, result.total, events.length) : result.total,
              loading: false,
              error: null,
              cursor: events.length < MAX_EVENTS ? result.nextCursor : undefined,
            };
          });
        })
        .catch((cause: unknown) => {
          if (pending.current !== request) return;
          setState((previous) => ({
            ...previous,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          }));
        })
        .finally(() => {
          clearTimeout(timer);
          if (pending.current === request) pending.current = null;
        });
      feed.refreshMail();
    },
    [feed, sessionId],
  );
  useEffect(() => {
    setState({ sessionId, events: [], total: 0, loading: false, error: null });
    load();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [sessionId, load]);
  useEffect(() => {
    if (!live) return;
    const poll = setInterval(() => load(), 10000);
    return () => clearInterval(poll);
  }, [live, load]);
  return {
    ...state,
    events: state.sessionId === sessionId ? state.events : [],
    refresh: () => load(),
    loadEarlier: () => load(state.cursor),
  };
}
