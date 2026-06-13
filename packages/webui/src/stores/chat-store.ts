import { expectDefined } from '@wrongstack/core';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ChatMessage } from './types.js';
/**
 * Strip immediately-repeated paragraphs/lines from an assistant reply.
 * MiniMax-M2.7 (and other smaller open models) sometimes emit the same
 * paragraph twice in one stream — we don't want that to land in the chat.
 * We only collapse *consecutive* duplicates so legitimate repetition
 * elsewhere in the message is preserved.
 */
function dedupeRepeatedBlocks(text: string): string {
  if (!text) return text;
  const paraSplit = text.split(/\n{2,}/);
  const paras: string[] = [];
  for (const p of paraSplit) {
    if (paras.length > 0 && paras[paras.length - 1]?.trim() === p.trim()) continue;
    paras.push(p);
  }
  const cleaned = paras.map((p) => {
    const lines = p.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      if (out.length > 0 && line.trim().length > 0 && out[out.length - 1]?.trim() === line.trim()) {
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  });
  return cleaned.join('\n\n');
}

// ============================================
// Chat Store
// ============================================

interface ChatState {
  messages: ChatMessage[];
  currentAssistantMessageId: string | null;
  currentToolId: string | null;
  isLoading: boolean;
  abortController: AbortController | null;
  executions: Map<string, ToolExecution>;
  /** Messages typed while the agent was running. Drained one-at-a-time
   *  after run.result lands so the user can stack up follow-ups without
   *  waiting for each turn to finish. */
  queue: string[];
  /** Snapshot taken at the start of the current run (first iteration.started
   *  after idle). Used by run.result to compute the per-turn summary —
   *  duration is now-at minus this `at`, cost delta is the difference
   *  between the session's current cost and the cost captured here. Null
   *  while idle. */
  runStart: { at: number; cost: number } | null;
  /** Transient extended-thinking buffer. Populated by provider.thinking_delta
   *  events and shown as a soft, ephemeral bubble below the chat tail while
   *  the model is reasoning. Cleared the moment the model produces user-
   *  facing output (text_delta) or starts a tool — and at provider.response /
   *  run.result. Never persisted into `messages`, so refresh wipes it. */
  thinkingBuffer: string;
  /** Wall-clock ms when the current thinking burst started, for the chip's
   *  elapsed timer. Reset alongside `thinkingBuffer`. */
  thinkingStartedAt: number | null;

  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'> & { timestamp?: number }) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (id: string, text: string) => void;
  finalizeMessage: (id: string) => void;
  setToolResult: (id: string, result: string, ok: boolean) => void;
  appendToolProgress: (id: string, line: string) => void;
  appendToolProgressLines: (id: string, lines: string[]) => void;
  setLoading: (loading: boolean) => void;
  setAbortController: (ctrl: AbortController | null) => void;
  clearMessages: () => void;
  setCurrentAssistantMessage: (id: string | null) => void;
  setCurrentToolId: (id: string | null) => void;
  truncateAfter: (id: string) => void;
  addExecution: (exec: ToolExecution) => void;
  updateExecution: (id: string, updates: Partial<ToolExecution>) => void;
  enqueue: (text: string) => void;
  dequeue: () => string | null;
  removeQueued: (idx: number) => void;
  clearQueue: () => void;
  setRunStart: (s: { at: number; cost: number } | null) => void;
  appendThinking: (text: string) => void;
  clearThinking: () => void;
}

interface ToolExecution {
  id: string;
  name: string;
  input?: unknown | undefined;
  output?: string | undefined;
  durationMs?: number | undefined;
  ok: boolean;
  startedAt: number;
  completedAt?: number | undefined;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      currentAssistantMessageId: null,
      currentToolId: null,
      isLoading: false,
      abortController: null,
      executions: new Map(),
      queue: [],
      runStart: null,
      thinkingBuffer: '',
      thinkingStartedAt: null,

      addMessage: (msg) => {
        const id = `msg_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
        const fullMsg: ChatMessage = { ...msg, id, timestamp: msg.timestamp ?? Date.now() };
        set((state) => ({
          messages: [...state.messages, fullMsg],
          currentAssistantMessageId:
            msg.role === 'assistant' ? id : state.currentAssistantMessageId,
        }));
        return id;
      },

      updateMessage: (id, updates) => {
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
        }));
      },

      appendToMessage: (id, text) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: m.content + text } : m,
          ),
        }));
      },

      finalizeMessage: (id) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: dedupeRepeatedBlocks(m.content), streaming: false } : m,
          ),
        }));
      },

      setToolResult: (id, result, ok) => {
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, toolResult: result, isError: !ok, progressLines: undefined } : m,
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
            const next = [...prev, ...lines];
            const trimmed = next.length > 30 ? next.slice(next.length - 30) : next;
            return { ...m, progressLines: trimmed };
          }),
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),
      setAbortController: (ctrl) => set({ abortController: ctrl }),

      clearMessages: () =>
        set({
          messages: [],
          currentAssistantMessageId: null,
          currentToolId: null,
          executions: new Map(),
        }),

      setCurrentAssistantMessage: (id) => set({ currentAssistantMessageId: id }),
      setCurrentToolId: (id) => set({ currentToolId: id }),

      truncateAfter: (id) =>
        set((state) => {
          const idx = state.messages.findIndex((m) => m.id === id);
          if (idx === -1) return state;
          return {
            messages: state.messages.slice(0, idx),
            currentAssistantMessageId: null,
            currentToolId: null,
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

      enqueue: (text) => set((state) => ({ queue: [...state.queue, text] })),
      dequeue: () => {
        const { queue } = get();
        if (queue.length === 0) return null;
        const [next, ...rest] = queue;
        set({ queue: rest });
        return expectDefined(next);
      },
      removeQueued: (idx) => set((state) => ({ queue: state.queue.filter((_, i) => i !== idx) })),
      clearQueue: () => set({ queue: [] }),
      setRunStart: (s) => set({ runStart: s }),
      appendThinking: (text) =>
        set((state) => ({
          thinkingBuffer: state.thinkingBuffer + text,
          thinkingStartedAt: state.thinkingStartedAt ?? Date.now(),
        })),
      clearThinking: () => set({ thinkingBuffer: '', thinkingStartedAt: null }),
    }),
    {
      name: 'wrongstack-chat',
      partialize: () => ({}),
    },
  ),
);
