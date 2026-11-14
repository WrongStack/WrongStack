import type { ChatLaneActions, ChatLaneData } from './chat-lane-data.js';

export type { ChatLaneActions, ChatLaneData, PendingConfirm } from './chat-lane-data.js';

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

import { safeId } from '@/lib/utils';
import {
  actionCache,
  DEFAULT_LANE_ID,
  EMPTY_LANE,
  mutate,
  useChatLanes,
} from './chat-lanes-registry.js';
import {
  BTW_DISPATCH_GRACE_MS,
  cancelDispatchedGraceTimer,
  dispatchedGraceTimers,
  getRemotePromptQueue,
  nextQueueItemId,
} from './chat-queue-helpers';
import {
  boundChatField,
  dedupeRepeatedBlocks,
  indexToolExecutions,
  indexToolMessages,
  retainWebChatMessages,
} from './chat-retention';
import type { QueuedItem, ToolExecution } from './chat-store-types';
import type { ChatMessage } from './types.js';

export {
  activeLaneId,
  adoptDefaultLane,
  DEFAULT_LANE_ID,
  disposeLane,
  EMPTY_LANE,
  ensureLane,
  hasLane,
  laneIds,
  MAX_LANES,
  onLaneDisposed,
  readLane,
  resolvePendingConfirm,
  resolvePendingFallback,
  setActiveLane,
  useChatLanes,
} from './chat-lanes-registry.js';

/**
 * The one way to write chat state. `sessionId` is mandatory: there is no
 * "current" lane an action can fall back to, which is what makes cross-tab
 * bleed unrepresentable rather than merely guarded against.
 */
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
    get serverQueue() {
      return read().serverQueue;
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

    setMessages: (messages, options) => {
      const retained = retainWebChatMessages(messages);
      mutate(sid, () =>
        options?.preserveLiveStream
          ? {
              messages: retained,
              executions: indexToolExecutions(retained),
              toolMessageIdsByUseId: indexToolMessages(retained),
            }
          : {
              messages: retained,
              currentAssistantMessageId: null,
              currentToolId: null,
              executions: indexToolExecutions(retained),
              toolMessageIdsByUseId: indexToolMessages(retained),
              thinkingBuffer: '',
              thinkingStartedAt: null,
              thinkingLogBuffer: '',
              thinkingLogStartedAt: null,
            },
      );
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
          const next = [...(m.progressLines ?? []), ...lines].slice(-30);
          return { ...m, progressLines: next };
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
        const toolMessageIdsByUseId = indexToolMessages(messages);
        // Prune toolMessageIdsByUseId and executions in lockstep with the
        // messages slice, so neither Map grows unbounded across turn-undo cycles.
        const ids = new Set(messages.map((m) => m.id));
        const prunedExecutions = new Map(
          [...lane.executions].filter(
            ([execId, exec]) => toolMessageIdsByUseId.has(execId) || ids.has(exec.id),
          ),
        );
        return {
          messages,
          currentAssistantMessageId: null,
          currentToolId: null,
          toolMessageIdsByUseId,
          executions: prunedExecutions,
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
      // A server with a session queue owns `queue` prompts: it runs them when
      // the turn ends even if this page is closed, and every page sees them.
      if (mode === 'queue' && !alreadyDispatched && sid !== DEFAULT_LANE_ID) {
        if (getRemotePromptQueue()?.(sid, text, images)) return;
      }
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
          let hasDispatched = false;
          for (const q of lane.queue) {
            if (q.alreadyDispatched === true) {
              hasDispatched = true;
              if (q.itemId !== undefined) cancelDispatchedGraceTimer(q.itemId);
              if (q.bubbleAdded !== true) toBubble(q);
            }
          }
          if (!hasDispatched) return;
          return {
            queue: lane.queue.filter((q) => q.alreadyDispatched !== true),
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
