import { useCallback, useSyncExternalStore } from 'react';
import { invokePortableCommand } from '@/lib/portable-command-rpc';
import { useSessionStore } from '@/stores';

interface InboxSummary {
  projectId: string;
  pending: number;
  total: number;
  version: string;
}
interface InboxState {
  summary: InboxSummary | null;
  unavailable: boolean;
}
interface Subscription {
  state: InboxState;
  listeners: Set<() => void>;
  refresh: () => void;
  stop: () => void;
}

const EMPTY: InboxState = { summary: null, unavailable: false };
const subscriptions = new Map<string, Subscription>();
const POLL_MS = 15_000;

function start(key: string, sessionId: string): Subscription {
  let stopped = false;
  let pending = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  const publish = (state: InboxState) => {
    subscription.state = state;
    for (const listener of subscription.listeners) listener();
  };
  const subscription: Subscription = {
    state: EMPTY,
    listeners: new Set(),
    refresh() {
      if (stopped || document.visibilityState === 'hidden') return;
      if (pending) {
        queued = true;
        return;
      }
      clearTimeout(timer);
      pending = true;
      request = new AbortController();
      void invokePortableCommand('adr', 'summary-json', {
        sessionId,
        queueIfDisconnected: false,
        signal: request.signal,
      })
        .then((result) => {
          if (stopped) return;
          if (result.error) throw new Error(result.error);
          const summary = JSON.parse(result.message ?? '') as InboxSummary;
          if (
            !summary.projectId ||
            !/^[a-f0-9]{64}$/.test(summary.version) ||
            !Number.isSafeInteger(summary.pending) ||
            !Number.isSafeInteger(summary.total) ||
            summary.pending < 0 ||
            summary.total < summary.pending
          )
            throw new Error('Invalid ADR summary.');
          if (
            subscription.state.unavailable ||
            subscription.state.summary?.version !== summary.version ||
            subscription.state.summary?.projectId !== summary.projectId
          )
            publish({ summary, unavailable: false });
        })
        .catch(() => {
          if (!stopped) publish({ summary: null, unavailable: true });
        })
        .finally(() => {
          pending = false;
          if (stopped) return;
          if (queued) {
            queued = false;
            subscription.refresh();
          } else if (document.visibilityState !== 'hidden')
            timer = setTimeout(subscription.refresh, POLL_MS);
        });
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', subscription.refresh);
      subscriptions.delete(key);
    },
  };
  const onVisibility = () => {
    clearTimeout(timer);
    if (document.visibilityState !== 'hidden') subscription.refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', subscription.refresh);
  return subscription;
}

/** One bounded, foreground-only query shared by the dock and panel for this session/project. */
export function useArchitectureDecisionInbox(sessionId: string | null, enabled = true) {
  const projectRoot = useSessionStore((state) => state.projectRoot);
  const key = enabled && sessionId ? JSON.stringify([projectRoot, sessionId]) : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key || !sessionId) return () => {};
      let subscription = subscriptions.get(key);
      if (!subscription) {
        subscription = start(key, sessionId);
        subscriptions.set(key, subscription);
      }
      subscription.listeners.add(listener);
      if (subscription.listeners.size === 1) subscription.refresh();
      return () => {
        subscription.listeners.delete(listener);
        if (!subscription.listeners.size) subscription.stop();
      };
    },
    [key, sessionId],
  );
  const snapshot = useCallback(
    () => (key ? (subscriptions.get(key)?.state ?? EMPTY) : EMPTY),
    [key],
  );
  const state = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const refresh = useCallback(() => {
    if (key) subscriptions.get(key)?.refresh();
  }, [key]);
  return { ...state, refresh };
}
