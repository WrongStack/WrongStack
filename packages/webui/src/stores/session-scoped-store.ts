/**
 * A store whose ENTIRE state belongs to one conversation.
 *
 * The WebUI runs up to four conversations side by side. Most stores describe
 * one of them — the memory injector's traces, the Brain council's panels, the
 * side effects a run recorded — and holding them in a single global object
 * meant the four tabs shared one copy. Two failure modes, and the codebase has
 * had both:
 *
 *   - the handler wrote whatever arrived, so a background tab's records landed
 *     on the screen the user was looking at; or
 *   - the handler defended itself with `isActiveSessionMessage` and DROPPED
 *     the background tab's records entirely, so switching to that tab showed
 *     an empty panel for work that had definitely happened.
 *
 * Neither is "separate". This factory gives every conversation its own store
 * instance, with the reducer written exactly as it would be for a single
 * session — no `bySession` threading through the reducer bodies, no chance of
 * a new action forgetting the key.
 *
 * Shape, deliberately mirroring the chat/session lane facades:
 *   - calling it as a hook, or reaching for `getState()`, addresses the tab
 *     that is IN FRONT — the right default for components and for a user
 *     action, which by definition happens in the visible tab;
 *   - `for(sessionId)` addresses one named conversation, which is what a WS
 *     handler must use: the frame names its session and the write has to land
 *     there whether or not that tab is on screen.
 *
 * Bounds: one instance per live conversation, dropped when the tab closes
 * (`onLaneDisposed`). The cap is a backstop for ids that never see a lane
 * teardown — losing a diagnostic buffer for a conversation nobody is showing
 * costs nothing, and the next event rebuilds it.
 *
 * @module session-scoped-store
 */

import { useStore } from 'zustand';
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla';
import { activeLaneId, DEFAULT_LANE_ID, onLaneDisposed, useChatLanes } from './chat-lanes';

/** Live instances kept at once. Four tabs, plus slack for handover churn. */
const DEFAULT_MAX_SESSIONS = 8;

export interface SessionScopedStore<S> {
  /** Hook form: the state of the tab in front. */
  <T>(selector: (state: S) => T): T;
  /** Snapshot of the tab in front. */
  getState(): S;
  /** Patch the tab in front. */
  setState(partial: Partial<S> | ((state: S) => Partial<S>)): void;
  /** Subscribe to the tab in front. Resolved once, at call time. */
  subscribe(listener: (state: S, previous: S) => void): () => void;
  /** The store of ONE named conversation — the handler entry point. */
  for(sessionId: string | null | undefined): StoreApi<S>;
  /** Forget a conversation's copy. Called on lane teardown. */
  dropSession(sessionId: string): void;
  /** Conversations holding an instance, oldest first. */
  sessionIds(): string[];
}

export function createSessionScopedStore<S>(
  initializer: StateCreator<S, [], []>,
  options: { max?: number } = {},
): SessionScopedStore<S> {
  const max = Math.max(1, options.max ?? DEFAULT_MAX_SESSIONS);
  const instances = new Map<string, StoreApi<S>>();

  const key = (sessionId: string | null | undefined): string =>
    sessionId && sessionId.length > 0 ? sessionId : DEFAULT_LANE_ID;

  const apiFor = (sessionId: string | null | undefined): StoreApi<S> => {
    const id = key(sessionId);
    const existing = instances.get(id);
    if (existing) return existing;
    // Insertion order is age; the unbound pre-session instance is never the
    // victim because a fresh tab adopts it before it can go stale.
    while (instances.size >= max) {
      const oldest = [...instances.keys()].find((candidate) => candidate !== id);
      if (oldest === undefined) break;
      instances.delete(oldest);
    }
    const created = createStore<S>(initializer);
    instances.set(id, created);
    return created;
  };

  const scoped = (<T>(selector: (state: S) => T): T => {
    // Subscribing to the pointer is what makes a tab switch re-render with the
    // incoming tab's data instead of leaving the outgoing tab's on screen.
    const sessionId = useStore(useChatLanes, (s) => s.activeSessionId);
    return useStore(apiFor(sessionId), selector);
  }) as SessionScopedStore<S>;

  scoped.getState = () => apiFor(activeLaneId()).getState();
  scoped.setState = (partial) =>
    apiFor(activeLaneId()).setState(partial as Parameters<StoreApi<S>['setState']>[0]);
  scoped.subscribe = (listener) => apiFor(activeLaneId()).subscribe(listener);
  scoped.for = apiFor;
  scoped.dropSession = (sessionId) => {
    instances.delete(key(sessionId));
  };
  scoped.sessionIds = () => [...instances.keys()];

  onLaneDisposed((sessionId) => scoped.dropSession(sessionId));

  return scoped;
}
