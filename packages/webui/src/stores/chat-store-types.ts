import type { ChatMessage } from './types.js';

export type QueueMode = 'btw' | 'steer' | 'queue';

export interface QueuedItem {
  text: string;
  mode: QueueMode;
  addedAt: number;
  itemId: number;
  alreadyDispatched?: boolean | undefined;
  bubbleAdded?: boolean | undefined;
  images?:
    | Array<{
        id: string;
        dataUrl: string;
        mediaType: string;
        bytes: number;
        name?: string | undefined;
      }>
    | undefined;
}

export interface ToolExecution {
  id: string;
  name: string;
  input?: unknown | undefined;
  output?: string | undefined;
  durationMs?: number | undefined;
  ok: boolean;
  startedAt: number;
  completedAt?: number | undefined;
}

export interface ChatRetentionBudget {
  maxMessages?: number;
  maxBytes?: number;
  maxFieldChars?: number;
}

export interface ChatState {
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
    mode: QueueMode;
  } | null;
  thinkingBuffer: string;
  thinkingStartedAt: number | null;
  thinkingLogBuffer: string;
  thinkingLogStartedAt: number | null;
  boundSessionId: string | null;

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
  setBoundSessionId: (id: string | null) => void;
  setCurrentAssistantMessage: (id: string | null) => void;
  setCurrentToolId: (id: string | null) => void;
  truncateAfter: (id: string) => void;
  addExecution: (exec: ToolExecution) => void;
  updateExecution: (id: string, updates: Partial<ToolExecution>) => void;
  enqueue: (
    text: string,
    mode?: QueueMode,
    images?: QueuedItem['images'],
    alreadyDispatched?: boolean,
  ) => void;
  dequeue: () => QueuedItem | null;
  dequeueDrainable: () => QueuedItem | null;
  removeQueued: (idx: number) => void;
  clearQueue: () => void;
  setRefining: (v: boolean) => void;
  setPendingRefinement: (
    text: string | null,
    images?: Array<{ data: string; mime: string }>,
    mode?: QueueMode,
  ) => void;
  removeMessage: (id: string) => void;
  updateLastUserMessage: (text: string) => void;
  setRunStart: (s: { at: number; cost: number } | null) => void;
  appendThinking: (text: string) => void;
  clearThinking: () => void;
  flushThinkingLog: (iteration: number) => void;
  clearThinkingLog: () => void;
  switchSession: (newSessionId: string) => void;
}
