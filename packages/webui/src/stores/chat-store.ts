/**
 * chat-store.ts — Foreground view over the lane registry.
 *
 * The chat surface's real state lives in `chat-lanes.ts`, one lane per session
 * tab. This module is the read/write facade the FOREGROUND components use: it
 * projects `lanes[activeSessionId]` behind the historical `useChatStore` API so
 * a component that renders the tab in front keeps working unchanged.
 *
 * Rules that keep the four tabs from bleeding into each other:
 *
 *  - WS handlers MUST NOT use this facade. They route by `payload.sessionId`
 *    through `chatFor(msg)` / `chatLane(sessionId)`. Writing through the facade
 *    from a handler is exactly the "wrote to whichever tab happened to be in
 *    front" bug; `tests/hooks/ws-handlers-lane-routing.test.ts` fails the build
 *    if a handler reaches for it.
 *  - The facade has no cross-lane reach. `useChatStore.getState()` can only see
 *    and touch the active lane; there is no path from here to lane 2.
 */

import { useStore } from 'zustand';
import {
  activeChatLane,
  activeLaneId,
  type ChatLaneData,
  chatLane,
  DEFAULT_LANE_ID,
  disposeLane,
  EMPTY_LANE,
  overrideLaneActions,
  setActiveLane,
  useChatLanes,
} from './chat-lanes';
import type { ChatState } from './chat-store-types';

export const MAX_CHAT_MESSAGES = 1000;
export const MAX_PERSISTED_MESSAGES = 200;

export {
  activeChatLane,
  activeLaneId,
  adoptDefaultLane,
  type ChatLaneActions,
  type ChatLaneData,
  chatLane,
  DEFAULT_LANE_ID,
  disposeLane,
  ensureLane,
  hasLane,
  laneIds,
  MAX_LANES,
  readLane,
  setActiveLane,
  useChatLanes,
} from './chat-lanes';
export { BTW_DISPATCH_GRACE_MS } from './chat-queue-helpers';
export {
  boundChatField,
  dedupeRepeatedBlocks,
  indexToolExecutions,
  indexToolMessages,
  MAX_CHAT_FIELD_CHARS,
  MAX_CHAT_RETAINED_BYTES,
  retainWebChatMessages,
} from './chat-retention';
export * from './chat-store-types';

// ---------------------------------------------------------------------------
// Active-lane projection
// ---------------------------------------------------------------------------

type LanesState = ReturnType<typeof useChatLanes.getState>;

/**
 * One view object per lanes-state identity. The cache matters: selectors like
 * `(s) => s.messages` must return the SAME array across unrelated store
 * updates or every lane touch re-renders the whole transcript.
 */
const viewCache = new WeakMap<LanesState, ChatState>();

function projectActiveLane(state: LanesState): ChatState {
  const cached = viewCache.get(state);
  if (cached) return cached;

  const sessionId = state.activeSessionId;
  const lane: ChatLaneData = state.lanes[sessionId] ?? EMPTY_LANE;
  // Action identities come from `chatLane`'s per-session cache, so they stay
  // referentially stable for the lifetime of the lane.
  const actions = chatLane(sessionId);

  const view: ChatState = {
    messages: lane.messages,
    currentAssistantMessageId: lane.currentAssistantMessageId,
    currentToolId: lane.currentToolId,
    isLoading: lane.isLoading,
    abortController: lane.abortController,
    executions: lane.executions,
    toolMessageIdsByUseId: lane.toolMessageIdsByUseId,
    queue: lane.queue,
    runStart: lane.runStart,
    refining: lane.refining,
    pendingRefinement: lane.pendingRefinement,
    thinkingBuffer: lane.thinkingBuffer,
    thinkingStartedAt: lane.thinkingStartedAt,
    thinkingLogBuffer: lane.thinkingLogBuffer,
    thinkingLogStartedAt: lane.thinkingLogStartedAt,
    boundSessionId: sessionId === DEFAULT_LANE_ID ? null : sessionId,

    addMessage: actions.addMessage,
    setMessages: actions.setMessages,
    updateMessage: actions.updateMessage,
    appendToMessage: actions.appendToMessage,
    finalizeMessage: actions.finalizeMessage,
    setToolResult: actions.setToolResult,
    appendToolProgress: actions.appendToolProgress,
    appendToolProgressLines: actions.appendToolProgressLines,
    getToolMessageId: actions.getToolMessageId,
    setToolResultByUseId: actions.setToolResultByUseId,
    appendToolProgressLinesByUseId: actions.appendToolProgressLinesByUseId,
    setLoading: actions.setLoading,
    setAbortController: actions.setAbortController,
    clearMessages: actions.clearMessages,
    setBoundSessionId: bindActiveLane,
    setCurrentAssistantMessage: actions.setCurrentAssistantMessage,
    setCurrentToolId: actions.setCurrentToolId,
    truncateAfter: actions.truncateAfter,
    addExecution: actions.addExecution,
    updateExecution: actions.updateExecution,
    enqueue: actions.enqueue,
    dequeue: actions.dequeue,
    dequeueDrainable: actions.dequeueDrainable,
    removeQueued: actions.removeQueued,
    clearQueue: actions.clearQueue,
    setRefining: actions.setRefining,
    setPendingRefinement: actions.setPendingRefinement,
    removeMessage: actions.removeMessage,
    updateLastUserMessage: actions.updateLastUserMessage,
    setRunStart: actions.setRunStart,
    appendThinking: actions.appendThinking,
    clearThinking: actions.clearThinking,
    flushThinkingLog: actions.flushThinkingLog,
    clearThinkingLog: actions.clearThinkingLog,
    switchSession: bindActiveLane,
  };

  viewCache.set(state, view);
  return view;
}

/**
 * Point the foreground at another lane.
 *
 * There is nothing to park and nothing to restore — every lane keeps its own
 * transcript, queue, thinking buffer and run flag at all times, whether or not
 * it is the one on screen. Switching tabs is a pointer move.
 */
function bindActiveLane(sessionId: string | null): void {
  setActiveLane(sessionId);
}

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

function getState(): ChatState {
  return projectActiveLane(useChatLanes.getState());
}

/**
 * Merge a patch into the ACTIVE lane. Kept for components and tests that drive
 * the store directly; `boundSessionId` is honoured as a lane switch.
 */
function setState(partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)): void {
  const patch = typeof partial === 'function' ? partial(getState()) : partial;
  if (!patch) return;
  const { boundSessionId, ...rest } = patch as Partial<ChatState> & {
    boundSessionId?: string | null;
  };
  if (boundSessionId !== undefined) bindActiveLane(boundSessionId);
  const laneFields: Partial<ChatLaneData> = {};
  const actionOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    // A function-valued key is an ACTION override, not data — the single-store
    // API allowed substituting one, and callers still rely on it.
    if (typeof value === 'function') actionOverrides[key] = value;
    else (laneFields as Record<string, unknown>)[key] = value;
  }
  if (Object.keys(laneFields).length > 0) activeChatLane().patch(laneFields);
  if (Object.keys(actionOverrides).length > 0) {
    overrideLaneActions(activeLaneId(), actionOverrides);
  }
}

function subscribe(listener: (state: ChatState, prev: ChatState) => void): () => void {
  return useChatLanes.subscribe((state, prev) =>
    listener(projectActiveLane(state), projectActiveLane(prev)),
  );
}

interface ChatStoreFacade {
  <T>(selector: (state: ChatState) => T): T;
  getState: typeof getState;
  getInitialState: typeof getState;
  setState: typeof setState;
  subscribe: typeof subscribe;
  /** The lane registry's own persist API (rehydrate/flush/clearStorage). */
  persist: (typeof useChatLanes)['persist'];
}

/**
 * Foreground chat state. Reads and writes the ACTIVE lane only.
 *
 * Not a real Zustand store — a projection over `useChatLanes`. Everything a
 * component needs (selector subscription, `getState`, `setState`, `subscribe`)
 * is here; what is deliberately absent is any way to name another session.
 */
export const useChatStore: ChatStoreFacade = Object.assign(
  function useChatStoreHook<T>(selector: (state: ChatState) => T): T {
    return useStore(useChatLanes, (state) => selector(projectActiveLane(state)));
  },
  { getState, getInitialState: getState, setState, subscribe, persist: useChatLanes.persist },
);

/**
 * Retire a lane whose tab was closed. Frees its transcript, queue and timers —
 * a closed tab must not keep accruing memory or fire deferred bubbles.
 */
function closeChatLane(sessionId: string): void {
  disposeLane(sessionId);
}
