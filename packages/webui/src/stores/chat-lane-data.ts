import type { WSQueuedPromptView } from '@/types/prompt-queue';
import type { QueuedItem, ToolExecution } from './chat-store-types';

import type { ChatMessage } from './types.js';

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
  /** Prompts queued on the server for this session (it owns and drains them). */
  serverQueue: WSQueuedPromptView[];
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
  deadlineAt?: number | undefined;
  writeTargets?: string[] | undefined;
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
    serverQueue: [],
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
  readonly serverQueue: WSQueuedPromptView[];
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
  setMessages: (messages: ChatMessage[], options?: { preserveLiveStream?: boolean }) => void;
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
