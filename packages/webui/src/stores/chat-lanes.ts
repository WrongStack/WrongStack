/**
 * chat-lanes.ts — The chat surface's per-session source of truth.
 *
 * ONE LANE PER TAB. Four tabs, four lanes, no shared mutable chat state
 * between them. Think of them as four side-by-side layouts that happen to be
 * stacked: nothing in lane 2 can be observed or written by lane 1, background
 * included.
 *
 * Why this exists (the bug it replaces): the chat surface used to be a single
 * live store plus a `memorySessionCaches` map of parked snapshots. Every WS
 * writer therefore had to ask "is this event for the tab in front?" and drop it
 * otherwise. That is a NEGATIVE routing rule, and it fails two ways:
 *
 *   1. One writer that forgets the guard appends another session's tokens to
 *      whatever transcript happens to be in front. That is the bleed.
 *   2. Even when every guard is right, a background tab's own output is
 *      DROPPED — it was never written anywhere — so switching back showed a
 *      transcript frozen at the moment you left.
 *
 * Lanes make routing POSITIVE: an event names its session, the router hands
 * back that session's lane, and the write lands there. A message that names no
 * session, or names a session with no lane, is dropped by the router — never
 * mis-delivered. There is no "current lane" a writer can accidentally reach.
 *
 * `chat-store.ts` is a thin read/write facade over `lanes[activeSessionId]` so
 * the foreground components keep their existing API.
 */

import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { safeId } from '@/lib/utils';
import {
  BTW_DISPATCH_GRACE_MS,
  cancelDispatchedGraceTimer,
  dispatchedGraceTimers,
  nextQueueItemId,
  normalizeQueuedItem,
  setEnqueueSequence,
} from './chat-queue-helpers';
import {
  boundChatField,
  dedupeRepeatedBlocks,
  indexToolMessages,
  MAX_PERSISTED_MESSAGES,
  retainWebChatMessages,
} from './chat-retention';
import type { QueuedItem, ToolExecution } from './chat-store-types';
import type { ChatMessage } from './types.js';

/** Hard ceiling on concurrent lanes. Four tabs, four lanes, no exceptions. */
export const MAX_LANES = 4;

/**
 * Lane used before any session exists (boot, setup screen, tests that never
 * start a session). `adoptDefaultLane` hands its contents to the first real
 * session so a message typed before `session.start` lands is not lost.
 */
export const DEFAULT_LANE_ID = '__unbound__';

/** Everything the chat surface owns for ONE session. Plain data only. */
export interface ChatLaneData {
  messages: ChatMessage[];
  currentAssistantMessageId: string | null;
  currentToolId: string | null;
  isLoading: boolean;
  abortController: AbortController | null;
  executions: Map<string, ToolExecution>;
  toolMessageIdsByUseId: Map<string, string>;
  queue: QueuedItem[];
  runStart: { at: number; cost: number } | null;
  refining: boolean;
  pendingRefinement: {
    text: string;
    images: Array<{ data: string; mime: string }>;
    mode: QueuedItem['mode'];
  } | null;
  thinkingBuffer: string;
  thinkingStartedAt: number | null;
  thinkingLogBuffer: string;
  thinkingLogStartedAt: number | null;
  /**
   * An approval prompt raised while this tab was in the BACKGROUND.
   *
   * A modal is the loudest possible cross-tab bleed, so a background tab's
   * prompt is never opened over the tab in front. It is parked here instead
   * and opened when the user switches to the tab that raised it — without
   * this the prompt was simply discarded and the run sat blocked behind an
   * attention dot with no way to answer it.
   */
  pendingConfirm: PendingConfirm | null;
  /**
   * A provider-fallback prompt raised while this tab was in the BACKGROUND.
   *
   * Same reasoning as `pendingConfirm`: the fallback dialog is one global
   * surface, so a background tab's prompt must not open over the tab in front.
   * It used to be DROPPED instead — the run then sat behind a question nobody
   * could answer until the server's countdown auto-switched the model on its
   * own, which is a route change the user never chose.
   */
  pendingFallback: LaneFallbackPrompt | null;
}

/** The provider-fallback prompt payload, as the dialog needs it. */
export interface LaneFallbackPrompt {
  requestId: string;
  from: { providerId: string; model: string };
  status: number;
  candidates: Array<{ providerId: string; model: string }>;
  autoSwitchSeconds: number;
  timestamp: number;
}

/** The tool-approval prompt payload, as the dialog needs it. */
export interface PendingConfirm {
  id: string;
  toolName: string;
  input: unknown;
  suggestedPattern: string;
  decisionSource?: string | undefined;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
  boundaryReason?: string | undefined;
}

export function createLaneData(): ChatLaneData {
  return {
    messages: [],
    currentAssistantMessageId: null,
    currentToolId: null,
    isLoading: false,
    abortController: null,
    executions: new Map(),
    toolMessageIdsByUseId: new Map(),
    queue: [],
    runStart: null,
    refining: false,
    pendingRefinement: null,
    thinkingBuffer: '',
    thinkingStartedAt: null,
    thinkingLogBuffer: '',
    thinkingLogStartedAt: null,
    pendingConfirm: null,
    pendingFallback: null,
  };
}

/**
 * Stable empty lane handed to selectors that ask for a lane which does not
 * exist. Must be a singleton: returning a fresh object would make every
 * `useChatStore((s) => s.messages)` re-render on every store touch.
 */
export const EMPTY_LANE: ChatLaneData = createLaneData();

export interface ChatLanesState {
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
      version: 1,
      partialize: (s) => ({
        activeSessionId: s.activeSessionId,
        lanes: Object.fromEntries(
          Object.entries(s.lanes)
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
          activeSessionId:
            typeof p.activeSessionId === 'string' && p.activeSessionId
              ? p.activeSessionId
              : DEFAULT_LANE_ID,
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
  return useChatLanes.getState().lanes[sessionId] ?? EMPTY_LANE;
}

export function hasLane(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return sessionId in useChatLanes.getState().lanes;
}

export function laneIds(): string[] {
  return Object.keys(useChatLanes.getState().lanes);
}

/** Create the lane if missing. Returns the sessionId for chaining. */
export function ensureLane(sessionId: string): string {
  if (!sessionId) return DEFAULT_LANE_ID;
  if (useChatLanes.getState().lanes[sessionId]) return sessionId;
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
  if (!lane) return;
  for (const item of lane.queue) {
    if (item.itemId !== undefined) cancelDispatchedGraceTimer(item.itemId);
  }
  actionCache.delete(sessionId);
  useChatLanes.setState((s) => {
    const next = { ...s.lanes };
    delete next[sessionId];
    return { lanes: next };
  });
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
}

// ---------------------------------------------------------------------------
// Lane mutation core
// ---------------------------------------------------------------------------

/**
 * Apply `updater` to ONE lane. Creates the lane when missing so a run that
 * outruns its `session.start` still lands somewhere addressable rather than on
 * the foreground.
 */
function mutate(sessionId: string, updater: (lane: ChatLaneData) => Partial<ChatLaneData> | void) {
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

// ---------------------------------------------------------------------------
// Lane-scoped actions
// ---------------------------------------------------------------------------

export interface ChatLaneActions {
  readonly sessionId: string;
  readonly messages: ChatMessage[];
  readonly currentAssistantMessageId: string | null;
  readonly currentToolId: string | null;
  readonly isLoading: boolean;
  readonly abortController: AbortController | null;
  readonly executions: Map<string, ToolExecution>;
  readonly toolMessageIdsByUseId: Map<string, string>;
  readonly queue: QueuedItem[];
  readonly runStart: { at: number; cost: number } | null;
  readonly refining: boolean;
  readonly pendingRefinement: ChatLaneData['pendingRefinement'];
  readonly thinkingBuffer: string;
  readonly thinkingStartedAt: number | null;
  readonly thinkingLogBuffer: string;
  readonly thinkingLogStartedAt: number | null;
  readonly pendingConfirm: PendingConfirm | null;

  addMessage: (
    msg: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string; timestamp?: number },
  ) => string;
  setMessages: (messages: ChatMessage[]) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (id: string, text: string) => void;
  finalizeMessage: (id: string, opts?: { final?: boolean }) => void;
  setToolResult: (id: string, result: string, ok: boolean) => void;
  appendToolProgress: (id: string, line: string) => void;
  appendToolProgressLines: (id: string, lines: string[]) => void;
  getToolMessageId: (toolUseId: string) => string | undefined;
  setToolResultByUseId: (toolUseId: string, result: string, ok: boolean) => void;
  appendToolProgressLinesByUseId: (toolUseId: string, lines: string[]) => void;
  setLoading: (loading: boolean) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  clearMessages: () => void;
  setCurrentAssistantMessage: (id: string | null) => void;
  setCurrentToolId: (id: string | null) => void;
  truncateAfter: (id: string) => void;
  addExecution: (exec: ToolExecution) => void;
  updateExecution: (id: string, updates: Partial<ToolExecution>) => void;
  enqueue: (
    text: string,
    mode?: QueuedItem['mode'],
    images?: QueuedItem['images'],
    alreadyDispatched?: boolean,
  ) => void;
  dequeue: () => QueuedItem | null;
  dequeueDrainable: () => QueuedItem | null;
  removeQueued: (idx: number) => void;
  clearQueue: () => void;
  setRefining: (v: boolean) => void;
  /** Park (or clear) this tab's unanswered approval prompt. */
  setPendingConfirm: (confirm: PendingConfirm | null) => void;
  setPendingFallback: (prompt: LaneFallbackPrompt | null) => void;
  setPendingRefinement: (
    text: string | null,
    images?: Array<{ data: string; mime: string }>,
    mode?: QueuedItem['mode'],
  ) => void;
  removeMessage: (id: string) => void;
  updateLastUserMessage: (text: string) => void;
  setRunStart: (s: { at: number; cost: number } | null) => void;
  appendThinking: (text: string) => void;
  clearThinking: () => void;
  flushThinkingLog: (iteration: number) => void;
  clearThinkingLog: () => void;
  /** Bulk patch — used by the facade's `setState` and by replay hydration. */
  patch: (updates: Partial<ChatLaneData>) => void;
}

const actionCache = new Map<string, ChatLaneActions>();

/**
 * The one way to write chat state. `sessionId` is mandatory: there is no
 * "current" lane an action can fall back to, which is what makes cross-tab
 * bleed unrepresentable rather than merely guarded against.
 */
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

export function chatLane(sessionId: string): ChatLaneActions {
  const sid = sessionId || DEFAULT_LANE_ID;
  const cached = actionCache.get(sid);
  if (cached) return cached;

  const read = (): ChatLaneData => useChatLanes.getState().lanes[sid] ?? EMPTY_LANE;

  const actions: ChatLaneActions = {
    sessionId: sid,
    get messages() {
      return read().messages;
    },
    get currentAssistantMessageId() {
      return read().currentAssistantMessageId;
    },
    get currentToolId() {
      return read().currentToolId;
    },
    get isLoading() {
      return read().isLoading;
    },
    get abortController() {
      return read().abortController;
    },
    get executions() {
      return read().executions;
    },
    get toolMessageIdsByUseId() {
      return read().toolMessageIdsByUseId;
    },
    get queue() {
      return read().queue;
    },
    get runStart() {
      return read().runStart;
    },
    get refining() {
      return read().refining;
    },
    get pendingRefinement() {
      return read().pendingRefinement;
    },
    get thinkingBuffer() {
      return read().thinkingBuffer;
    },
    get thinkingStartedAt() {
      return read().thinkingStartedAt;
    },
    get thinkingLogBuffer() {
      return read().thinkingLogBuffer;
    },
    get thinkingLogStartedAt() {
      return read().thinkingLogStartedAt;
    },
    get pendingConfirm() {
      return read().pendingConfirm;
    },

    patch: (updates) => mutate(sid, () => updates),

    addMessage: (msg) => {
      const id = msg.id ?? `msg_${Date.now()}_${safeId().slice(0, 8)}`;
      const fullMsg: ChatMessage = { ...msg, id, timestamp: msg.timestamp ?? Date.now() };
      mutate(sid, (lane) => {
        const messages = retainWebChatMessages([...lane.messages, fullMsg]);
        let toolMessageIdsByUseId = indexToolMessages(messages);
        let executions = lane.executions;
        if (executions.size > 0) {
          const nextExecutions = new Map<string, ToolExecution>();
          let execChanged = false;
          for (const [execId, exec] of executions) {
            if (toolMessageIdsByUseId.has(execId)) nextExecutions.set(execId, exec);
            else execChanged = true;
          }
          if (execChanged) executions = nextExecutions;
        }
        if (fullMsg.role === 'tool' && fullMsg.toolUseId) {
          const nextIndex = new Map(toolMessageIdsByUseId);
          nextIndex.set(fullMsg.toolUseId, id);
          toolMessageIdsByUseId = nextIndex;
        }
        return {
          messages,
          toolMessageIdsByUseId,
          ...(executions !== lane.executions ? { executions } : {}),
          currentAssistantMessageId: msg.role === 'assistant' ? id : lane.currentAssistantMessageId,
        };
      });
      return id;
    },

    setMessages: (messages) => {
      const retained = retainWebChatMessages(messages);
      mutate(sid, () => ({
        messages: retained,
        currentAssistantMessageId: null,
        currentToolId: null,
        executions: new Map(),
        toolMessageIdsByUseId: indexToolMessages(retained),
        thinkingBuffer: '',
        thinkingStartedAt: null,
        thinkingLogBuffer: '',
        thinkingLogStartedAt: null,
      }));
    },

    updateMessage: (id, updates) =>
      mutate(sid, (lane) => ({
        messages: lane.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
      })),

    appendToMessage: (id, text) =>
      mutate(sid, (lane) => ({
        messages: lane.messages.map((m) =>
          m.id === id ? { ...m, content: boundChatField(m.content + text) } : m,
        ),
      })),

    finalizeMessage: (id, opts) => {
      const final = opts?.final !== false;
      mutate(sid, (lane) => ({
        messages: lane.messages.map((m) => {
          if (m.id !== id) return m;
          if (m.role !== 'assistant') {
            return { ...m, content: dedupeRepeatedBlocks(m.content), streaming: false };
          }
          const parsed = parseNextSteps(m.content);
          const nextSteps = final && parsed.steps.length > 0 ? { steps: parsed.steps } : undefined;
          return {
            ...m,
            content: dedupeRepeatedBlocks(parsed.stripped),
            streaming: false,
            ...(nextSteps ? { nextSteps } : {}),
          };
        }),
      }));
    },

    setToolResult: (id, result, ok) =>
      mutate(sid, (lane) => ({
        messages: lane.messages.map((m) =>
          m.id === id
            ? { ...m, toolResult: boundChatField(result), isError: !ok, progressLines: undefined }
            : m,
        ),
      })),

    appendToolProgress: (id, line) => {
      actions.appendToolProgressLines(id, [line]);
    },

    appendToolProgressLines: (id, lines) => {
      if (lines.length === 0) return;
      mutate(sid, (lane) => ({
        messages: lane.messages.map((m) => {
          if (m.id !== id) return m;
          const prev = m.progressLines ?? [];
          prev.push(...lines);
          if (prev.length > 30) prev.splice(0, prev.length - 30);
          return { ...m, progressLines: prev };
        }),
      }));
    },

    getToolMessageId: (toolUseId) => read().toolMessageIdsByUseId.get(toolUseId),

    setToolResultByUseId: (toolUseId, result, ok) => {
      const id = read().toolMessageIdsByUseId.get(toolUseId);
      if (id) actions.setToolResult(id, result, ok);
    },

    appendToolProgressLinesByUseId: (toolUseId, lines) => {
      const id = read().toolMessageIdsByUseId.get(toolUseId);
      if (id) actions.appendToolProgressLines(id, lines);
    },

    setLoading: (loading) => mutate(sid, () => ({ isLoading: loading })),
    setAbortController: (ctrl) => mutate(sid, () => ({ abortController: ctrl })),

    clearMessages: () =>
      mutate(sid, () => ({
        messages: [],
        currentAssistantMessageId: null,
        currentToolId: null,
        executions: new Map(),
        toolMessageIdsByUseId: new Map(),
        thinkingBuffer: '',
        thinkingStartedAt: null,
        thinkingLogBuffer: '',
        thinkingLogStartedAt: null,
        // An unanswered prompt belongs to the conversation being wiped.
        pendingConfirm: null,
      })),

    setCurrentAssistantMessage: (id) => mutate(sid, () => ({ currentAssistantMessageId: id })),
    setCurrentToolId: (id) => mutate(sid, () => ({ currentToolId: id })),

    truncateAfter: (id) =>
      mutate(sid, (lane) => {
        const idx = lane.messages.findIndex((m) => m.id === id);
        if (idx === -1) return;
        const messages = lane.messages.slice(0, idx + 1);
        return {
          messages,
          currentAssistantMessageId: null,
          currentToolId: null,
          toolMessageIdsByUseId: indexToolMessages(messages),
        };
      }),

    addExecution: (exec) =>
      mutate(sid, (lane) => {
        const next = new Map(lane.executions);
        next.set(exec.id, exec);
        return { executions: next };
      }),

    updateExecution: (id, updates) =>
      mutate(sid, (lane) => {
        const next = new Map(lane.executions);
        const existing = next.get(id);
        if (!existing) return;
        next.set(id, { ...existing, ...updates });
        return { executions: next };
      }),

    setRefining: (v) => mutate(sid, () => ({ refining: v })),
    setPendingConfirm: (confirm) => mutate(sid, () => ({ pendingConfirm: confirm })),

    setPendingFallback: (prompt) => mutate(sid, () => ({ pendingFallback: prompt })),

    setPendingRefinement: (text, images, mode = 'queue') =>
      mutate(sid, () => ({
        pendingRefinement: text !== null ? { text, images: images ?? [], mode } : null,
      })),

    enqueue: (text, mode = 'queue', images, alreadyDispatched) => {
      const addedAt = Date.now();
      const itemId = nextQueueItemId();
      mutate(sid, (lane) => ({
        queue: [
          ...lane.queue,
          {
            text,
            mode,
            addedAt,
            itemId,
            ...(images?.length ? { images } : {}),
            ...(alreadyDispatched ? { alreadyDispatched: true } : {}),
          },
        ],
      }));
      if (!alreadyDispatched) return;
      const handle = setTimeout(() => {
        dispatchedGraceTimers.delete(itemId);
        let bubblePayload: Parameters<ChatLaneActions['addMessage']>[0] | null = null;
        mutate(sid, (lane) => {
          const target = lane.queue.find(
            (q) => q.itemId === itemId && q.alreadyDispatched === true,
          );
          if (target && target.bubbleAdded !== true) {
            const imgs = target.images ?? [];
            bubblePayload = {
              role: 'user',
              content: target.text,
              ...(imgs.length > 0
                ? {
                    attachments: imgs.map((img) => ({
                      id: img.id,
                      kind: 'image' as const,
                      dataUrl: img.dataUrl,
                      mediaType: img.mediaType,
                      bytes: img.bytes,
                      name: img.name,
                    })),
                  }
                : {}),
            };
          }
          return {
            queue: lane.queue.filter((q) => !(q.itemId === itemId && q.alreadyDispatched === true)),
          };
        });
        if (bubblePayload) actions.addMessage(bubblePayload);
      }, BTW_DISPATCH_GRACE_MS);
      dispatchedGraceTimers.set(itemId, handle);
    },

    dequeue: () => {
      const queue = read().queue;
      if (queue.length === 0) return null;
      const [next, ...rest] = queue;
      if (next?.itemId !== undefined) cancelDispatchedGraceTimer(next.itemId);
      mutate(sid, () => ({ queue: rest }));
      return expectDefined(next);
    },

    dequeueDrainable: () => {
      const leadingBubbles: Array<Parameters<ChatLaneActions['addMessage']>[0]> = [];
      const outcome: { popped: QueuedItem | null } = { popped: null };
      const toBubble = (q: QueuedItem) => {
        const imgs = q.images ?? [];
        leadingBubbles.push({
          role: 'user',
          content: q.text,
          ...(imgs.length > 0
            ? {
                attachments: imgs.map((img) => ({
                  id: img.id,
                  kind: 'image' as const,
                  dataUrl: img.dataUrl,
                  mediaType: img.mediaType,
                  bytes: img.bytes,
                  name: img.name,
                })),
              }
            : {}),
        });
      };
      mutate(sid, (lane) => {
        const idx = lane.queue.findIndex((q) => q.alreadyDispatched !== true);
        if (idx === -1) {
          for (const q of lane.queue) {
            if (q.alreadyDispatched === true && q.bubbleAdded !== true) toBubble(q);
          }
          if (leadingBubbles.length === 0) return;
          return {
            queue: lane.queue.filter(
              (q) => !(q.alreadyDispatched === true && q.bubbleAdded !== true),
            ),
          };
        }
        for (let i = 0; i < idx; i += 1) {
          const q = lane.queue[i]!;
          if (q.bubbleAdded === true) continue;
          toBubble(q);
        }
        outcome.popped = lane.queue[idx]!;
        const stamped = lane.queue.map((q, i) =>
          i < idx && q.bubbleAdded !== true && q.alreadyDispatched === true
            ? { ...q, bubbleAdded: true }
            : q,
        );
        return { queue: [...stamped.slice(0, idx), ...stamped.slice(idx + 1)] };
      });
      for (const payload of leadingBubbles) actions.addMessage(payload);
      const poppedItem: QueuedItem | null = outcome.popped;
      if (poppedItem?.itemId !== undefined) cancelDispatchedGraceTimer(poppedItem.itemId);
      return poppedItem;
    },

    removeQueued: (idx) =>
      mutate(sid, (lane) => {
        const removed = lane.queue[idx];
        if (removed?.itemId !== undefined) cancelDispatchedGraceTimer(removed.itemId);
        return { queue: lane.queue.filter((_, i) => i !== idx) };
      }),

    clearQueue: () =>
      mutate(sid, (lane) => {
        for (const q of lane.queue) {
          if (q.itemId !== undefined) cancelDispatchedGraceTimer(q.itemId);
        }
        return { queue: [] };
      }),

    removeMessage: (id) =>
      mutate(sid, (lane) => {
        const messages = lane.messages.filter((m) => m.id !== id);
        return { messages, toolMessageIdsByUseId: indexToolMessages(messages) };
      }),

    updateLastUserMessage: (text) =>
      mutate(sid, (lane) => {
        for (let i = lane.messages.length - 1; i >= 0; i--) {
          if (lane.messages[i]!.role === 'user') {
            const next = [...lane.messages];
            next[i] = { ...next[i]!, content: text };
            return { messages: next };
          }
        }
        return;
      }),

    setRunStart: (s) => mutate(sid, () => ({ runStart: s })),

    appendThinking: (text) =>
      mutate(sid, (lane) => ({
        thinkingBuffer: boundChatField(lane.thinkingBuffer + text),
        thinkingStartedAt: lane.thinkingStartedAt ?? Date.now(),
        thinkingLogBuffer: boundChatField(lane.thinkingLogBuffer + text),
        thinkingLogStartedAt: lane.thinkingLogStartedAt ?? Date.now(),
      })),

    clearThinking: () => mutate(sid, () => ({ thinkingBuffer: '', thinkingStartedAt: null })),

    flushThinkingLog: (iteration) => {
      const lane = read();
      const text = lane.thinkingLogBuffer.trim();
      if (!text) return;
      const startedAt = lane.thinkingLogStartedAt ?? Date.now();
      actions.addMessage({
        role: 'system',
        content: '',
        thinkingLog: {
          iteration,
          text,
          startedAt,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      });
      actions.clearThinkingLog();
    },

    clearThinkingLog: () =>
      mutate(sid, () => ({ thinkingLogBuffer: '', thinkingLogStartedAt: null })),
  };

  actionCache.set(sid, actions);
  return actions;
}

/**
 * Replace one or more of a lane's actions in place.
 *
 * The action object is a per-session singleton, so this is how a caller
 * substitutes behaviour for a specific tab — and how tests keep the
 * `useChatStore.setState({ clearMessages: fn })` idiom the single store
 * supported. Overrides live until the lane is disposed.
 */
export function overrideLaneActions(
  sessionId: string,
  patch: Partial<Record<keyof ChatLaneActions, unknown>>,
): void {
  const target = chatLane(sessionId) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value !== 'function') continue;
    target[key] = value;
  }
}

/** Actions bound to the lane currently in front. Foreground UI only. */
export function activeChatLane(): ChatLaneActions {
  return chatLane(useChatLanes.getState().activeSessionId);
}
