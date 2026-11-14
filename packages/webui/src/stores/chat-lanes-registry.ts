import { MAX_OPEN_SESSIONS_PER_CONNECTION } from '@wrongstack/webui-protocol';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { type ChatLaneActions, type ChatLaneData, createLaneData } from './chat-lane-data.js';
import {
  cancelDispatchedGraceTimer,
  normalizeQueuedItem,
  setEnqueueSequence,
} from './chat-queue-helpers';
import {
  indexToolExecutions,
  indexToolMessages,
  MAX_PERSISTED_MESSAGES,
  retainWebChatMessages,
} from './chat-retention';
import type { QueuedItem } from './chat-store-types';
import type { ChatMessage } from './types.js';

/**
 * Hard ceiling on concurrent lanes. Four tabs, four lanes, no exceptions —
 * and the server accepts exactly this many declared sessions per connection,
 * hence the shared constant rather than a second 4 that could drift from it.
 */
export const MAX_LANES = MAX_OPEN_SESSIONS_PER_CONNECTION;

/**
 * Lane used before any session exists (boot, setup screen, tests that never
 * start a session). `adoptDefaultLane` hands its contents to the first real
 * session so a message typed before `session.start` lands is not lost.
 */
export const DEFAULT_LANE_ID = '__unbound__';

/**
 * Stable empty lane handed to selectors that ask for a lane which does not
 * exist. Must be a singleton: returning a fresh object would make every
 * `useChatStore((s) => s.messages)` re-render on every store touch.
 */
export const EMPTY_LANE: ChatLaneData = createLaneData();

interface ChatLanesState {
  lanes: Record<string, ChatLaneData>;
  /** Which lane the chat surface renders. Owned by the tab registry. */
  activeSessionId: string;
}

export const useChatLanes = create<ChatLanesState>()(
  persist(
    (): ChatLanesState => ({
      lanes: {},
      activeSessionId: DEFAULT_LANE_ID,
    }),
    {
      name: 'wrongstack-chat-lanes',
      version: 2,
      partialize: (s) => ({
        lanes: Object.fromEntries(
          Object.entries(s.lanes)
            .filter(([sid]) => sid !== DEFAULT_LANE_ID)
            .slice(0, MAX_LANES)
            .map(([sid, lane]) => [
              sid,
              {
                messages: lane.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) =>
                  m.attachments?.some((a) => a.dataUrl)
                    ? {
                        ...m,
                        attachments: m.attachments.map((a) => ({ ...a, dataUrl: undefined })),
                      }
                    : m,
                ),
                queue: lane.queue
                  .filter((q) => q.alreadyDispatched !== true)
                  .map((q) => (q.images ? { ...q, images: undefined } : q)),
                thinkingLogBuffer: lane.thinkingLogBuffer,
              },
            ]),
        ),
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as {
          lanes?: Record<string, Partial<ChatLaneData>>;
          activeSessionId?: string;
        };
        const lanes: Record<string, ChatLaneData> = {};
        for (const [sid, raw] of Object.entries(p.lanes ?? {}).slice(0, MAX_LANES)) {
          const lane = createLaneData();
          const messages = Array.isArray(raw.messages) ? raw.messages : [];
          lane.messages = retainWebChatMessages(messages as ChatMessage[]);
          lane.executions = indexToolExecutions(lane.messages);
          lane.toolMessageIdsByUseId = indexToolMessages(lane.messages);
          lane.queue = (Array.isArray(raw.queue) ? raw.queue : []).flatMap((item): QueuedItem[] => {
            const normalized = normalizeQueuedItem(item);
            if (!normalized) return [];
            setEnqueueSequence(Math.max(normalized.itemId, 0));
            return [normalized];
          });
          lane.thinkingLogBuffer =
            typeof raw.thinkingLogBuffer === 'string' ? raw.thinkingLogBuffer : '';
          lanes[sid] = lane;
        }
        return {
          ...current,
          lanes,
          activeSessionId: DEFAULT_LANE_ID,
        };
      },
      onRehydrateStorage: () => (_state, error) => {
        if (error) return;
        if (typeof window !== 'undefined') {
          (
            window as unknown as { __wrongstackChatRehydrated?: boolean }
          ).__wrongstackChatRehydrated = true;
        }
      },
    },
  ),
);

// ---------------------------------------------------------------------------
// Lane lifecycle
// ---------------------------------------------------------------------------

/** Read a lane's data, or the shared empty lane when it does not exist. */
export function readLane(sessionId: string | null | undefined): ChatLaneData {
  if (!sessionId) return EMPTY_LANE;
  const lanes = useChatLanes.getState().lanes;
  return Object.hasOwn(lanes, sessionId) ? lanes[sessionId] : EMPTY_LANE;
}

export function hasLane(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return Object.hasOwn(useChatLanes.getState().lanes, sessionId);
}

export function laneIds(): string[] {
  return Object.keys(useChatLanes.getState().lanes);
}

/** Create the lane if missing. Returns the sessionId for chaining. */
export function ensureLane(sessionId: string): string {
  if (!sessionId) return DEFAULT_LANE_ID;
  if (Object.hasOwn(useChatLanes.getState().lanes, sessionId)) return sessionId;
  useChatLanes.setState((s) => ({ lanes: { ...s.lanes, [sessionId]: createLaneData() } }));
  return sessionId;
}

/** Drop a lane entirely — the tab closed. Cancels its queued grace timers. */
/**
 * Run bookkeeping that lives OUTSIDE the lane record and must die with it.
 *
 * The WS handlers keep per-session maps of their own (pending next-steps, the
 * thinking coalescer's buffer). They cannot be cleaned up from
 * `session-tab-store` directly — the handlers import the stores, so the store
 * importing the handlers back would close a cycle. Registering here inverts
 * it: the handler module subscribes at load, and `disposeLane` is the single
 * place a retired tab is torn down.
 */
const laneDisposers = new Set<(sessionId: string) => void>();

/** Subscribe to lane disposal. Returns an unsubscribe. */
export function onLaneDisposed(fn: (sessionId: string) => void): () => void {
  laneDisposers.add(fn);
  return () => {
    laneDisposers.delete(fn);
  };
}

export function disposeLane(sessionId: string): void {
  const lane = useChatLanes.getState().lanes[sessionId];
  if (lane) {
    for (const item of lane.queue) {
      if (item.itemId !== undefined) cancelDispatchedGraceTimer(item.itemId);
    }
    useChatLanes.setState((s) => {
      const next = { ...s.lanes };
      delete next[sessionId];
      return { lanes: next };
    });
  }
  actionCache.delete(sessionId);
  for (const dispose of laneDisposers) {
    try {
      dispose(sessionId);
    } catch {
      // A subscriber must never block the teardown of the rest.
    }
  }
}

/**
 * Hand the pre-session (`__unbound__`) lane's contents to a real session.
 * Only ever moves the default lane, and only into an empty target — a real
 * lane's transcript is never overwritten by this.
 */
export function adoptDefaultLane(sessionId: string): void {
  if (!sessionId || sessionId === DEFAULT_LANE_ID) return;
  const state = useChatLanes.getState();
  const orphan = state.lanes[DEFAULT_LANE_ID];
  if (!orphan) return;
  const target = state.lanes[sessionId];
  const targetEmpty = !target || (target.messages.length === 0 && target.queue.length === 0);
  const orphanEmpty = orphan.messages.length === 0 && orphan.queue.length === 0;
  actionCache.delete(DEFAULT_LANE_ID);
  useChatLanes.setState((s) => {
    const next = { ...s.lanes };
    delete next[DEFAULT_LANE_ID];
    if (targetEmpty && !orphanEmpty) next[sessionId] = orphan;
    else if (!next[sessionId]) next[sessionId] = createLaneData();
    return { lanes: next };
  });
}

/** Point the foreground at a lane, creating it if needed. */
export function setActiveLane(sessionId: string | null): void {
  const id = sessionId || DEFAULT_LANE_ID;
  const state = useChatLanes.getState();
  if (state.activeSessionId === id && state.lanes[id]) return;
  ensureLane(id);
  useChatLanes.setState({ activeSessionId: id });
}

export function activeLaneId(): string {
  return useChatLanes.getState().activeSessionId;
} // ---------------------------------------------------------------------------
// Lane mutation core
// ---------------------------------------------------------------------------

/**
 * Apply `updater` to ONE lane. Creates the lane when missing so a run that
 * outruns its `session.start` still lands somewhere addressable rather than on
 * the foreground.
 */
export function mutate(
  sessionId: string,
  updater: (lane: ChatLaneData) => Partial<ChatLaneData> | void,
) {
  useChatLanes.setState((s) => {
    const current = s.lanes[sessionId] ?? createLaneData();
    const patch = updater(current);
    if (!patch) {
      if (s.lanes[sessionId]) return {};
      return { lanes: { ...s.lanes, [sessionId]: current } };
    }
    return { lanes: { ...s.lanes, [sessionId]: { ...current, ...patch } } };
  });
}

export const actionCache = new Map<string, ChatLaneActions>();

/**
 * Retire an approval prompt once it has been answered, wherever it is parked.
 *
 * Keyed on the prompt id rather than the tab, because a prompt can be resolved
 * from outside the tab that raised it — turning YOLO on makes the server
 * auto-approve everything pending. A stale parked prompt would then re-open a
 * dead dialog the next time the user switched to that tab.
 */
export function resolvePendingConfirm(confirmId: string): void {
  const { lanes } = useChatLanes.getState();
  for (const [sessionId, lane] of Object.entries(lanes)) {
    if (lane.pendingConfirm?.id !== confirmId) continue;
    mutate(sessionId, () => ({ pendingConfirm: null }));
  }
}

/**
 * Retire a parked fallback prompt by request id, wherever it is parked.
 *
 * The answer (or the server's own countdown) settles the request for good, so
 * the copy must not survive to open a dead dialog on the next tab switch —
 * the same retirement `resolvePendingConfirm` performs for approvals.
 */
export function resolvePendingFallback(requestId: string): void {
  const { lanes } = useChatLanes.getState();
  for (const [sessionId, lane] of Object.entries(lanes)) {
    if (lane.pendingFallback?.requestId !== requestId) continue;
    mutate(sessionId, () => ({ pendingFallback: null }));
  }
}
