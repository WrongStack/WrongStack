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
  MAX_CHAT_FIELD_CHARS,
  MAX_CHAT_RETAINED_BYTES,
  retainWebChatMessages,
} from './chat-retention';
import type { ChatState, QueuedItem, ToolExecution } from './chat-store-types';
import type { ChatMessage } from './types.js';

export const MAX_CHAT_MESSAGES = 1000;
export const MAX_PERSISTED_MESSAGES = 200;

export * from './chat-store-types';
export {
  boundChatField,
  dedupeRepeatedBlocks,
  indexToolMessages,
  MAX_CHAT_FIELD_CHARS,
  MAX_CHAT_RETAINED_BYTES,
  retainWebChatMessages,
} from './chat-retention';
export { BTW_DISPATCH_GRACE_MS } from './chat-queue-helpers';

interface SessionMemoryCache {
  messages: ChatMessage[];
  currentAssistantMessageId: string | null;
  currentToolId: string | null;
  isLoading: boolean;
  executions: Map<string, ToolExecution>;
  toolMessageIdsByUseId: Map<string, string>;
  thinkingBuffer: string;
  thinkingStartedAt: number | null;
  thinkingLogBuffer: string;
  thinkingLogStartedAt: number | null;
  runStart: { at: number; cost: number } | null;
}

export const memorySessionCaches = new Map<string, SessionMemoryCache>();

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
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
      boundSessionId: null as string | null,

      addMessage: (msg) => {
        const id = msg.id ?? `msg_${Date.now()}_${safeId().slice(0, 8)}`;
        const fullMsg: ChatMessage = { ...msg, id, timestamp: msg.timestamp ?? Date.now() };
        set((state) => {
          const messages = retainWebChatMessages([...state.messages, fullMsg]);
          const toolMessageIdsByUseId = indexToolMessages(messages);
          let executions: Map<string, ToolExecution> = state.executions;
          if (executions.size > 0) {
            const nextExecutions = new Map<string, ToolExecution>();
            let execChanged = false;
            for (const [execId, exec] of executions) {
              if (toolMessageIdsByUseId.has(execId)) {
                nextExecutions.set(execId, exec);
              } else {
                execChanged = true;
              }
            }
            if (execChanged) executions = nextExecutions;
          }
          const next: Partial<ChatState> = {
            messages,
            currentAssistantMessageId:
              msg.role === 'assistant' ? id : state.currentAssistantMessageId,
            toolMessageIdsByUseId,
          };
          if (fullMsg.role === 'tool' && fullMsg.toolUseId) {
            const nextIndex = new Map(toolMessageIdsByUseId);
            nextIndex.set(fullMsg.toolUseId, id);
            next.toolMessageIdsByUseId = nextIndex;
          }
          if (executions !== state.executions) {
            next.executions = executions;
          }
          return next;
        });
        return id;
      },

      setMessages: (messages) => {
        const retainedMessages = retainWebChatMessages(messages);
        set({
          messages: retainedMessages,
          currentAssistantMessageId: null,
          currentToolId: null,
          executions: new Map(),
          toolMessageIdsByUseId: indexToolMessages(retainedMessages),
          thinkingBuffer: '',
          thinkingStartedAt: null,
          thinkingLogBuffer: '',
          thinkingLogStartedAt: null,
        });
      },

      updateMessage: (id, updates) => {
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        }));
      },

      appendToMessage: (id, text) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: boundChatField(m.content + text) } : m,
          ),
        }));
      },

      finalizeMessage: (id, opts) => {
        const final = opts?.final !== false;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== id) return m;
            if (m.role !== 'assistant') {
              return { ...m, content: dedupeRepeatedBlocks(m.content), streaming: false };
            }
            const parsed = parseNextSteps(m.content);
            const nextSteps =
              final && parsed.steps.length > 0 ? { steps: parsed.steps } : undefined;
            return {
              ...m,
              content: dedupeRepeatedBlocks(parsed.stripped),
              streaming: false,
              ...(nextSteps ? { nextSteps } : {}),
            };
          }),
        }));
      },

      setToolResult: (id, result, ok) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id
              ? {
                  ...m,
                  toolResult: boundChatField(result),
                  isError: !ok,
                  progressLines: undefined,
                }
              : m,
          ),
        }));
      },

      appendToolProgress: (id, line) => {
        get().appendToolProgressLines(id, [line]);
      },

      appendToolProgressLines: (id, lines) => {
        if (lines.length === 0) return;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== id) return m;
            const prev = m.progressLines ?? [];
            prev.push(...lines);
            if (prev.length > 30) prev.splice(0, prev.length - 30);
            return { ...m, progressLines: prev };
          }),
        }));
      },

      getToolMessageId: (toolUseId) => get().toolMessageIdsByUseId.get(toolUseId),

      setToolResultByUseId: (toolUseId, result, ok) => {
        const id = get().toolMessageIdsByUseId.get(toolUseId);
        if (id) get().setToolResult(id, result, ok);
      },

      appendToolProgressLinesByUseId: (toolUseId, lines) => {
        const id = get().toolMessageIdsByUseId.get(toolUseId);
        if (id) get().appendToolProgressLines(id, lines);
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setAbortController: (ctrl) => set({ abortController: ctrl }),

      clearMessages: () =>
        set({
          messages: [],
          currentAssistantMessageId: null,
          currentToolId: null,
          executions: new Map(),
          toolMessageIdsByUseId: new Map(),
          thinkingBuffer: '',
          thinkingStartedAt: null,
          thinkingLogBuffer: '',
          thinkingLogStartedAt: null,
          boundSessionId: null,
        }),

      setBoundSessionId: (id) => set({ boundSessionId: id }),

      setCurrentAssistantMessage: (id) => set({ currentAssistantMessageId: id }),
      setCurrentToolId: (id) => set({ currentToolId: id }),

      truncateAfter: (id) =>
        set((state) => {
          const idx = state.messages.findIndex((m) => m.id === id);
          if (idx === -1) return state;
          const messages = state.messages.slice(0, idx + 1);
          return {
            messages,
            currentAssistantMessageId: null,
            currentToolId: null,
            toolMessageIdsByUseId: indexToolMessages(messages),
          };
        }),

      addExecution: (exec) => {
        set((state) => {
          const newExecutions = new Map(state.executions);
          newExecutions.set(exec.id, exec);
          return { executions: newExecutions };
        });
      },

      updateExecution: (id, updates) => {
        set((state) => {
          const newExecutions = new Map(state.executions);
          const existing = newExecutions.get(id);
          if (existing) {
            newExecutions.set(id, { ...existing, ...updates });
          }
          return { executions: newExecutions };
        });
      },

      setRefining: (v) => set({ refining: v }),
      setPendingRefinement: (text, images, mode = 'queue') =>
        set({
          pendingRefinement: text !== null ? { text, images: images ?? [], mode } : null,
        }),
      enqueue: (text, mode = 'queue', images, alreadyDispatched) => {
        const addedAt = Date.now();
        const itemId = nextQueueItemId();
        set((state) => ({
          queue: [
            ...state.queue,
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
        if (alreadyDispatched) {
          const handle = setTimeout(() => {
            dispatchedGraceTimers.delete(itemId);
            let bubblePayload: {
              role: 'user';
              content: string;
              attachments?: Array<{
                id: string;
                kind: 'image';
                dataUrl: string;
                mediaType: string;
                bytes: number;
                name?: string | undefined;
              }>;
            } | null = null;
            useChatStore.setState((state) => {
              const target = state.queue.find(
                (q) => q.itemId === itemId && q.alreadyDispatched === true,
              );
              if (target && target.bubbleAdded !== true) {
                const images = target.images ?? [];
                bubblePayload = {
                  role: 'user',
                  content: target.text,
                  ...(images.length > 0
                    ? {
                        attachments: images.map((img) => ({
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
                queue: state.queue.filter(
                  (q) => !(q.itemId === itemId && q.alreadyDispatched === true),
                ),
              };
            });
            if (bubblePayload) {
              useChatStore.getState().addMessage(bubblePayload);
            }
          }, BTW_DISPATCH_GRACE_MS);
          dispatchedGraceTimers.set(itemId, handle);
        }
      },
      dequeue: () => {
        const { queue } = get();
        if (queue.length === 0) return null;
        const [next, ...rest] = queue;
        if (next?.itemId !== undefined) cancelDispatchedGraceTimer(next.itemId);
        set({ queue: rest });
        return expectDefined(next);
      },
      dequeueDrainable: () => {
        const wrapper: {
          popped: QueuedItem | null;
          leadingBubbles: Array<Parameters<ChatState['addMessage']>[0]>;
        } = { popped: null, leadingBubbles: [] };
        set((state) => {
          const idx = state.queue.findIndex((q) => q.alreadyDispatched !== true);
          if (idx === -1) {
            for (const q of state.queue) {
              if (q.alreadyDispatched === true && q.bubbleAdded !== true) {
                const images = q.images ?? [];
                wrapper.leadingBubbles.push({
                  role: 'user',
                  content: q.text,
                  ...(images.length > 0
                    ? {
                        attachments: images.map((img) => ({
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
              }
            }
            if (wrapper.leadingBubbles.length === 0) return {};
            return {
              queue: state.queue.filter(
                (q) => !(q.alreadyDispatched === true && q.bubbleAdded !== true),
              ),
            };
          }
          for (let i = 0; i < idx; i += 1) {
            const q = state.queue[i]!;
            if (q.bubbleAdded === true) continue;
            const images = q.images ?? [];
            wrapper.leadingBubbles.push({
              role: 'user',
              content: q.text,
              ...(images.length > 0
                ? {
                    attachments: images.map((img) => ({
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
          }
          const next = state.queue[idx]!;
          const stampedRest = state.queue
            .map((q, i) =>
              i < idx && q.bubbleAdded !== true && q.alreadyDispatched === true
                ? { ...q, bubbleAdded: true }
                : q,
            )
            .slice(0, idx)
            .concat(
              state.queue
                .map((q, i) =>
                  i < idx && q.bubbleAdded !== true && q.alreadyDispatched === true
                    ? { ...q, bubbleAdded: true }
                    : q,
                )
                .slice(idx + 1),
            );
          wrapper.popped = next;
          return { queue: stampedRest };
        });
        for (const payload of wrapper.leadingBubbles) {
          useChatStore.getState().addMessage(payload);
        }
        const poppedItem: QueuedItem | null = wrapper.popped;
        if (poppedItem?.itemId !== undefined) {
          cancelDispatchedGraceTimer(poppedItem.itemId);
        }
        return poppedItem;
      },
      removeQueued: (idx) =>
        set((state) => {
          const removed = state.queue[idx];
          if (removed?.itemId !== undefined) cancelDispatchedGraceTimer(removed.itemId);
          return { queue: state.queue.filter((_, i) => i !== idx) };
        }),
      clearQueue: () => {
        const handles = Array.from(dispatchedGraceTimers.values());
        dispatchedGraceTimers.clear();
        for (const handle of handles) clearTimeout(handle);
        set({ queue: [] });
      },
      removeMessage: (id) =>
        set((state) => {
          const messages = state.messages.filter((m) => m.id !== id);
          return { messages, toolMessageIdsByUseId: indexToolMessages(messages) };
        }),
      updateLastUserMessage: (text) =>
        set((state) => {
          const messages = state.messages;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
              const updated = { ...messages[i], content: text };
              const newMessages = [...messages];
              newMessages[i] = updated;
              return { messages: newMessages };
            }
          }
          return state;
        }),
      setRunStart: (s) => set({ runStart: s }),
      appendThinking: (text) =>
        set((state) => ({
          thinkingBuffer: boundChatField(state.thinkingBuffer + text),
          thinkingStartedAt: state.thinkingStartedAt ?? Date.now(),
          thinkingLogBuffer: boundChatField(state.thinkingLogBuffer + text),
          thinkingLogStartedAt: state.thinkingLogStartedAt ?? Date.now(),
        })),
      clearThinking: () => set({ thinkingBuffer: '', thinkingStartedAt: null }),
      flushThinkingLog: (iteration) => {
        const { thinkingLogBuffer, thinkingLogStartedAt } = get();
        const text = thinkingLogBuffer.trim();
        if (!text) return;
        const startedAt = thinkingLogStartedAt ?? Date.now();
        get().addMessage({
          role: 'system',
          content: '',
          thinkingLog: {
            iteration,
            text,
            startedAt,
            durationMs: Math.max(0, Date.now() - startedAt),
          },
        });
        get().clearThinkingLog();
      },
      clearThinkingLog: () => set({ thinkingLogBuffer: '', thinkingLogStartedAt: null }),
      switchSession: (newSessionId) => {
        const state = get();
        if (state.boundSessionId === newSessionId) return;

        // 1. Snapshot current active session into memorySessionCaches
        if (state.boundSessionId) {
          memorySessionCaches.set(state.boundSessionId, {
            messages: state.messages,
            currentAssistantMessageId: state.currentAssistantMessageId,
            currentToolId: state.currentToolId,
            isLoading: state.isLoading,
            executions: new Map(state.executions),
            toolMessageIdsByUseId: new Map(state.toolMessageIdsByUseId),
            thinkingBuffer: state.thinkingBuffer,
            thinkingStartedAt: state.thinkingStartedAt,
            thinkingLogBuffer: state.thinkingLogBuffer,
            thinkingLogStartedAt: state.thinkingLogStartedAt,
            runStart: state.runStart,
          });
        }

        // 2. Restore cached session if available, else clean slate for new session
        const cached = memorySessionCaches.get(newSessionId);
        if (cached) {
          set({
            boundSessionId: newSessionId,
            messages: cached.messages,
            currentAssistantMessageId: cached.currentAssistantMessageId,
            currentToolId: cached.currentToolId,
            isLoading: cached.isLoading,
            executions: cached.executions,
            toolMessageIdsByUseId: cached.toolMessageIdsByUseId,
            thinkingBuffer: cached.thinkingBuffer,
            thinkingStartedAt: cached.thinkingStartedAt,
            thinkingLogBuffer: cached.thinkingLogBuffer,
            thinkingLogStartedAt: cached.thinkingLogStartedAt,
            runStart: cached.runStart,
          });
        } else {
          set({
            boundSessionId: newSessionId,
            messages: [],
            currentAssistantMessageId: null,
            currentToolId: null,
            isLoading: false,
            executions: new Map(),
            toolMessageIdsByUseId: new Map(),
            thinkingBuffer: '',
            thinkingStartedAt: null,
            thinkingLogBuffer: '',
            thinkingLogStartedAt: null,
            runStart: null,
          });
        }
      },
    }),
    {
      name: 'wrongstack-chat',
      version: 3,
      partialize: (s) => ({
        messages: s.messages
          .slice(-MAX_PERSISTED_MESSAGES)
          .map((m) =>
            m.attachments?.some((a) => a.dataUrl)
              ? { ...m, attachments: m.attachments.map((a) => ({ ...a, dataUrl: undefined })) }
              : m,
          ),
        queue: s.queue
          .filter((q) => q.alreadyDispatched !== true)
          .map((q) => (q.images ? { ...q, images: undefined } : q)),
        boundSessionId: s.boundSessionId,
        thinkingLogBuffer: s.thinkingLogBuffer,
      }),
      migrate: (persisted, version) => {
        if (version > 3) {
          return null as never as {
            messages: ChatState['messages'];
            queue: ChatState['queue'];
            boundSessionId: string | null;
            thinkingLogBuffer: string;
          };
        }
        const p = (persisted ?? {}) as Partial<ChatState> & {
          messages?: unknown;
          queue?: unknown;
        };
        const safeMessages = Array.isArray(p.messages) ? p.messages : [];
        let safeQueue = Array.isArray(p.queue) ? p.queue : [];
        if (version < 3) {
          safeQueue = safeQueue.filter(
            (item): item is QueuedItem =>
              typeof item === 'object' &&
              item !== null &&
              (item as QueuedItem).alreadyDispatched !== true,
          );
        }
        const stampedQueue: ChatState['queue'] = safeQueue.flatMap((raw): ChatState['queue'] => {
          const normalized = normalizeQueuedItem(raw);
          if (normalized) {
            setEnqueueSequence(Math.max(normalized.itemId, 0));
            return [normalized];
          }
          return [];
        });
        return {
          messages: retainWebChatMessages(safeMessages as ChatState['messages']),
          queue: stampedQueue,
          boundSessionId: typeof p.boundSessionId === 'string' ? p.boundSessionId : null,
          thinkingLogBuffer: typeof p.thinkingLogBuffer === 'string' ? p.thinkingLogBuffer : '',
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
