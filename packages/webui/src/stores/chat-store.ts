import { expectDefined } from '@wrongstack/core/utils/expect-defined';
import { parseNextSteps } from '@wrongstack/tools/next-steps';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { safeId } from '@/lib/utils';
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

/**
 * Cap on the live chat transcript retained in this store. Older entries are
 * dropped on the next addMessage when over this count; the full transcript is
 * still available via session-resume from the server. Without this cap, a
 * long-running WebUI session can accumulate hundreds of MB of transcript +
 * tool execution data (each ChatMessage carries full content blocks; tool
 * messages can be tens of KB each).
 */
const MAX_CHAT_MESSAGES = 1000;

/**
 * How many messages reach `localStorage` (WS-062).
 *
 * Deliberately much smaller than {@link MAX_CHAT_MESSAGES}. That cap protects
 * the tab's HEAP and is sized for it — up to 48 MB of retained transcript. The
 * `localStorage` origin quota is ~5 MB, and a tool-heavy message can be tens of
 * KB, so the in-memory budget is roughly an order of magnitude past what
 * storage can hold. Persisting the full in-memory window therefore trends
 * toward a quota exception, at which point `persist` silently stops writing
 * ANYTHING — including the typed-but-unsubmitted queue it exists to protect.
 *
 * 200 is sized for the stated purpose: recreating the VISIBLE transcript after
 * F5. Older messages live on the server, which is the authority, and a resume
 * re-fetches them.
 */
const MAX_PERSISTED_MESSAGES = 200;

export const MAX_CHAT_RETAINED_BYTES = 48 * 1024 * 1024;
const dispatchedGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();

function cancelDispatchedGraceTimer(itemId: number): void {
  const handle = dispatchedGraceTimers.get(itemId);
  if (handle === undefined) return;
  clearTimeout(handle);
  dispatchedGraceTimers.delete(itemId);
}

/**
 * Monotonic per-store counter threaded through every queued item so the
 * grace-timer map and the queue filter never collide on `Date.now()`
 * resolution. Two enqueues sharing the same millisecond (a pending note
 * followed by a dispatched BTW, or two BTWs back-to-back) used to cross-
 * cancel each other's timers when the map keyed on `addedAt`. The counter
 * is bumped in `enqueue` and stamped on the item as `itemId`; all
 * timer/cancel/filter operations key on it.
 */
let enqueueSequence = 0;

function nextQueueItemId(): number {
  enqueueSequence += 1;
  return enqueueSequence;
}

function normalizeQueuedItem(value: unknown): QueuedItem | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Partial<QueuedItem>;
  if (
    typeof item.text !== 'string' ||
    (item.mode !== 'btw' && item.mode !== 'steer' && item.mode !== 'queue') ||
    typeof item.addedAt !== 'number' ||
    !Number.isFinite(item.addedAt)
  ) {
    return null;
  }
  const itemId =
    typeof item.itemId === 'number' && Number.isSafeInteger(item.itemId) && item.itemId > 0
      ? item.itemId
      : nextQueueItemId();
  enqueueSequence = Math.max(enqueueSequence, itemId);
  return {
    text: item.text,
    mode: item.mode,
    addedAt: item.addedAt,
    itemId,
    ...(item.images ? { images: item.images } : {}),
  };
}

/**
 * How long a `btw` chip stays visible after entering the "SENT" state
 * (i.e. after the wire-send succeeded at submit time). The chip is removed
 * from the queue automatically after this delay so the user sees the
 * queue → SENT → leave-screen transition instead of the chip getting
 * stuck until the next `run.result` lands. UX spec (2026-08): "shortly
 * after it is processed, the message should leave my screen".
 */
export const BTW_DISPATCH_GRACE_MS = 1_800;

export const MAX_CHAT_FIELD_CHARS = 2 * 1024 * 1024;

interface ChatRetentionBudget {
  maxMessages?: number;
  maxBytes?: number;
  maxFieldChars?: number;
}

export function boundChatField(text: string, maxChars = MAX_CHAT_FIELD_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = '\n\n… [older streamed text omitted to protect memory] …\n\n';
  if (maxChars <= marker.length) {
    const head = Math.ceil(maxChars / 2);
    return text.slice(0, head) + text.slice(text.length - (maxChars - head));
  }
  const available = maxChars - marker.length;
  const head = Math.ceil(available / 2);
  return text.slice(0, head) + marker + text.slice(text.length - (available - head));
}

/**
 * Serialized-size estimate for a structured value, memoized on the value.
 *
 * `retainWebChatMessages` runs on EVERY `addMessage` and walks up to
 * `MAX_CHAT_MESSAGES` (1000) retained messages, calling this on each one's
 * `toolInput`. In a long session carrying a few hundred `Write`/`Edit` tool
 * messages that is megabytes of `JSON.stringify` per store write — per tool
 * bubble, per thinking-log flush, per system notice. It never shows up in a
 * render profile because it happens in the store, not in React.
 *
 * `toolInput` is immutable once a message is committed, so a WeakMap keyed on
 * it is exact and holds nothing alive on its own.
 */
const unknownBytesCache = new WeakMap<object, number>();

function estimateUnknownBytes(value: unknown): number {
  if (value === undefined) return 0;
  const cacheable = typeof value === 'object' && value !== null;
  if (cacheable) {
    const cached = unknownBytesCache.get(value as object);
    if (cached !== undefined) return cached;
  }
  let bytes: number;
  try {
    bytes = JSON.stringify(value).length * 2;
  } catch {
    bytes = MAX_CHAT_FIELD_CHARS * 2;
  }
  if (cacheable) unknownBytesCache.set(value as object, bytes);
  return bytes;
}

function normalizeRetainedMessage(message: ChatMessage, maxFieldChars: number): ChatMessage {
  const content = boundChatField(message.content, maxFieldChars);
  const toolResult =
    message.toolResult === undefined
      ? undefined
      : boundChatField(message.toolResult, maxFieldChars);
  const thinkingLog = message.thinkingLog
    ? { ...message.thinkingLog, text: boundChatField(message.thinkingLog.text, maxFieldChars) }
    : undefined;
  const toolInput =
    estimateUnknownBytes(message.toolInput) > maxFieldChars * 2
      ? '[tool input omitted from live transcript to protect memory]'
      : message.toolInput;
  if (
    content === message.content &&
    toolResult === message.toolResult &&
    thinkingLog?.text === message.thinkingLog?.text &&
    toolInput === message.toolInput
  ) {
    return message;
  }
  return {
    ...message,
    content,
    ...(toolResult !== undefined ? { toolResult } : {}),
    ...(thinkingLog ? { thinkingLog } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
  };
}

function retainedChatMessageBytes(message: ChatMessage): number {
  let bytes =
    384 +
    message.content.length * 2 +
    (message.toolResult?.length ?? 0) * 2 +
    (message.thinkingLog?.text.length ?? 0) * 2 +
    estimateUnknownBytes(message.toolInput);
  for (const attachment of message.attachments ?? []) {
    bytes += (attachment.dataUrl?.length ?? 0) * 2 + 192;
  }
  for (const line of message.sageLines ?? []) bytes += line.length * 2;
  for (const line of message.progressLines ?? []) bytes += line.length * 2;
  return bytes;
}

/** Count limits alone do not protect against giant tool/replay/vision rows. */
export function retainWebChatMessages(
  messages: readonly ChatMessage[],
  budget: ChatRetentionBudget = {},
): ChatMessage[] {
  const maxMessages = Math.max(1, Math.floor(budget.maxMessages ?? MAX_CHAT_MESSAGES));
  const maxBytes = Math.max(1, Math.floor(budget.maxBytes ?? MAX_CHAT_RETAINED_BYTES));
  const maxFieldChars = Math.max(1, Math.floor(budget.maxFieldChars ?? MAX_CHAT_FIELD_CHARS));
  const retained: ChatMessage[] = [];
  let bytes = 0;

  for (let index = messages.length - 1; index >= 0 && retained.length < maxMessages; index -= 1) {
    let message = normalizeRetainedMessage(messages[index]!, maxFieldChars);
    let messageBytes = retainedChatMessageBytes(message);
    if (messageBytes > maxBytes && message.attachments?.some((item) => item.dataUrl)) {
      message = {
        ...message,
        attachments: message.attachments.map((item) => ({ ...item, dataUrl: undefined })),
      };
      messageBytes = retainedChatMessageBytes(message);
    }
    if (retained.length > 0 && bytes + messageBytes > maxBytes) break;
    retained.push(message);
    bytes += messageBytes;
  }

  retained.reverse();
  return retained;
}

function indexToolMessages(messages: readonly ChatMessage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolUseId) index.set(m.toolUseId, m.id);
  }
  return index;
}

/** Submit mode for a queued/typed message. Drives whether the message
 *  interrupts the running agent (`steer`), rides alongside without
 *  interrupting (`btw`), or is held for after the run completes (`queue`). */
export type QueueMode = 'btw' | 'steer' | 'queue';

/** One entry in the message queue — the text plus how it was added.
 *  `addedAt` powers the optional sort-by-newest toggle.
 *  `itemId` is a monotonic per-store counter stamped by `enqueue`;
 *  the dispatched-chip grace-timer map and queue-filter operations
 *  key on it instead of `addedAt` so two enqueues sharing the same
 *  millisecond cannot cross-cancel each other. */
export interface QueuedItem {
  text: string;
  mode: QueueMode;
  addedAt: number;
  itemId: number;
  /** True once a `btw` item has already been wire-sent via the mailbox
   *  (immediate mid-run dispatch). The run.result drain must skip re-sending
   *  these — they remain in the queue only as a visible "dispatched" chip. */
  alreadyDispatched?: boolean | undefined;
  /** Idempotency latch for the drain path. Set by
   *  `addBubbleFor` in chat-handlers.handleRunResult (drain emits
   *  a bubble for the popped front chip) and by `dequeueDrainable`
   *  (drain emits bubbles for every leading dispatched chip it skips
   *  past). The grace timer callback in `enqueue` *reads* this flag
   *  to gate bubble emission (`target.bubbleAdded !== true`) — without
   *  this gate, a second `run.result` landing inside the grace window
   *  would call `addBubbleFor(front)` a second time and emit a duplicate
   *  user bubble for the same chip. Reset implicitly on a fresh
   * `enqueue` (the chip is constructed with `bubbleAdded` undefined).
   * The flag is the idempotency latch for the drain path; the timer
   * path reads it but does not write it. */
  bubbleAdded?: boolean | undefined;
  /** Image attachments riding with the queued message. Kept as full data
   *  URLs so the drain path can rebuild the wire payload + local bubble. */
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

interface ChatState {
  messages: ChatMessage[];
  currentAssistantMessageId: string | null;
  currentToolId: string | null;
  isLoading: boolean;
  abortController: AbortController | null;
  executions: Map<string, ToolExecution>;
  toolMessageIdsByUseId: Map<string, string>;
  /** Messages typed while the agent was running. Drained one-at-a-time
   *  after run.result lands so the user can stack up follow-ups without
   *  waiting for each turn to finish. Each item carries the submit mode
   *  so the queue panel can render the appropriate label. */
  queue: QueuedItem[];
  /** Snapshot taken at the start of the current run (first iteration.started
   *  after idle). Used by run.result to compute the per-turn summary —
   *  duration is now-at minus this `at`, cost delta is the difference
   *  between the session's current cost and the cost captured here. Null
   *  while idle. */
  runStart: { at: number; cost: number } | null;
  /** True while a queued message is being refined (goal-refiner running).
   *  The UI shows a "Refining..." indicator instead of "loading". */
  refining: boolean;
  /** Text and images of a message being refined before entering the queue.
   *  Set by ChatInput.sendMsg before calling model.refine; consumed by
   *  handleModelRefineResult to open the RefinePanel for user approval.
   *  Null when idle or refinement completed. */
  pendingRefinement: {
    text: string;
    images: Array<{ data: string; mime: string }>;
    mode: QueueMode;
  } | null;
  /** Transient extended-thinking buffer. Populated by provider.thinking_delta
   *  events and shown as a soft, ephemeral bubble below the chat tail while
   *  the model is reasoning. Cleared the moment the model produces user-
   *  facing output (text_delta) or starts a tool — and at provider.response /
   *  run.result. The archive buffer below is what eventually lands in
   *  `messages`; this live buffer is only for the temporary bubble. */
  thinkingBuffer: string;
  /** Wall-clock ms when the current thinking burst started, for the chip's
   *  elapsed timer. Reset alongside `thinkingBuffer`. */
  thinkingStartedAt: number | null;
  /** Full thinking text accumulated for the current iteration. Unlike the
   *  live chip buffer, this survives text/tool events until iteration end. */
  thinkingLogBuffer: string;
  /** Wall-clock ms when the archived thinking text for this iteration began. */
  thinkingLogStartedAt: number | null;
  /** Id of the session whose transcript is currently in `messages`. The
   *  verifier view compares this to the server-reported active session id
   *  on every `session.start` — a mismatch means the user switched sessions
   *  without an explicit clear, and we drop the local transcript rather
   *  than render it. Persisted alongside `messages` so the cross-session
   *  bleed check survives F5. */
  boundSessionId: string | null;

  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'> & { timestamp?: number }) => string;
  setMessages: (messages: ChatMessage[]) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  appendToMessage: (id: string, text: string) => void;
  /** `opts.final` — whether this finalize ends the turn. Pass `false` when the
   *  message is being closed because a tool call follows: the `<nextsteps>`
   *  block is still stripped from the body, but the parsed steps are not
   *  persisted, so no suggestion bar appears mid-turn. Defaults to `true`. */
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
  /** Bind the current transcript to a session id. See boundSessionId above
   *  for why this is a separate action. */
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
      toolMessageIdsByUseId: new Map(),
      queue: [],
      runStart: null,
      refining: false,
      pendingRefinement: null,
      thinkingBuffer: '',
      thinkingStartedAt: null,
      thinkingLogBuffer: '',
      thinkingLogStartedAt: null,
      /** Id of the session this transcript belongs to. The verifier view uses
       *  this to detect cross-session bleed: after F5, if the persisted
       *  sessionId doesn't match the server-reported active session, we drop
       *  the local transcript rather than render stale messages. */
      boundSessionId: null as string | null,

      addMessage: (msg) => {
        const id = `msg_${Date.now()}_${safeId().slice(0, 8)}`;
        const fullMsg: ChatMessage = { ...msg, id, timestamp: msg.timestamp ?? Date.now() };
        set((state) => {
          // Cap the live chat transcript at MAX_CHAT_MESSAGES so a long-running
          // session cannot accumulate hundreds of MB of transcript + tool
          // execution data. Drop the oldest entries (full conversation is still
          // available via session-resume from the server). The corresponding
          // `toolMessageIdsByUseId` and `executions` entries are pruned below
          // so the secondary indexes cannot outlive the messages they point at.
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
          // boundSessionId is the caller's responsibility to set when the
          // caller knows which session owns these messages (e.g. the
          // session.start handler passes the sessionId). When this store
          // is hit via /resume or hydrateReplayMessages, the caller must
          // also call setBoundSessionId; bare setMessages() leaves the
          // prior binding intact so background rehydrate from localStorage
          // can detect a sessionId mismatch.
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
        // Mid-turn finalize (a tool call follows): strip the block, but do not
        // persist the steps. Suggestions belong to the turn's final answer —
        // surfacing them between tool calls would let the bar and auto-submit
        // pivot away from work that is still in flight.
        const final = opts?.final !== false;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== id) return m;
            // Parse the canonical <nextsteps> block once, at the streaming
            // → final transition. The block is stripped from `content` so the
            // raw XML tags never surface in the rendered body — the previous
            // MessageBubble-only parse gated stripping on isLatestAssistant,
            // which flipped to false the moment the user selected a suggestion
            // (setLoading(true)), causing the un-stripped content to render
            // verbatim. Persisting the steps on the message lets the bar and
            // /next read them without re-parsing.
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
            // Mutate in-place to avoid repeated array allocations.
            // This is safe because set() gives us a new state object.
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
          // Clearing the binding too — when the user hits /clear or Ctrl+L,
          // any rehydrated transcript from localStorage has to be re-bound
          // to the active session before the next message lands.
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
        const itemId = ++enqueueSequence;
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
        // Schedule the auto-remove for dispatched chips. The grace timer
        // is the only owner of the chip's visible lifecycle once the
        // wire-send succeeded at submit time — re-sending on the next
        // `run.result` would fold the same note into the agent's
        // context a second time. Keyed by `itemId` (a monotonic
        // counter) so two enqueues sharing the same millisecond cannot
        // cross-cancel each other.
        if (alreadyDispatched) {
          const handle = setTimeout(() => {
            dispatchedGraceTimers.delete(itemId);
            // Emit the bubble (if not already emitted by the drain path)
            // and remove the chip atomically. The bubble emission is the
            // *only* way a BTW note sent mid-run (where the run outlasts
            // the 1.8s grace window) can land in the transcript — if the
            // run takes longer than `BTW_DISPATCH_GRACE_MS`, `run.result`
            // arrives after the timer fires, so this callback is the
            // sole owner of the user bubble for that case. The
            // `bubbleAdded` gate keeps this idempotent against the drain
            // path: when `run.result` lands first, the drain stamps the
            // flag and the timer reads it and skips the second emit.
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
        // Cancel any pending grace timer for the popped item — the drain
        // path is taking ownership of its lifecycle. `itemId` is the
        // monotonic timer key; every queued item carries one now.
        if (next?.itemId !== undefined) cancelDispatchedGraceTimer(next.itemId);
        set({ queue: rest });
        return expectDefined(next);
      },
      /**
       * Drain the front non-dispatched item AND emit bubbles for every
       * leading dispatched chip that hasn't been emitted yet. Used by
       * `handleRunResult` so the drain can skip past BTW chips that
       * are mid-way through their SENT-grace window (whose visible
       * lifecycle is owned by the auto-remove timer) and pick the
       * first truly-pending item.
       *
       * Side effects (in order):
       *  1. Emit a user bubble for every leading dispatched chip whose
       *     `bubbleAdded` flag is still false. These chips are emitted
       *     by the dispatcher on the front one when the chat sees
       *     `run.result` arrive inside the grace window; chips behind
       *     the front skip the dispatcher's path, so we emit them here
       *     to keep the transcript complete. The `bubbleAdded` flag is
       *     the idempotency gate — a chip that was already emitted by
       *     the dispatcher or by a previous drain's grace timer is
       *     skipped.
       *  2. Pop the first non-dispatched item (or return null if every
       *     remaining item is dispatched).
       *  3. Cancel the popped item's grace timer — the drain is now
       *     taking ownership of its lifecycle.
       *
       * Implementation note: this MUST be one atomic `set` updater.
       * Reading the queue from `get()` and then splicing `state.queue`
       * at the same index inside `set` is a stale-snapshot splice —
       * another `run.result`, `removeQueued`, or `clearQueue` between
       * the two can mutate the queue, and the splice then operates on
       * the wrong slot. The fix derives `idx` and `next` inside the
       * updater and captures the popped item via a wrapper object.
       */
      dequeueDrainable: () => {
        const wrapper: {
          popped: QueuedItem | null;
          leadingBubbles: Array<Parameters<ChatState['addMessage']>[0]>;
        } = { popped: null, leadingBubbles: [] };
        set((state) => {
          const idx = state.queue.findIndex((q) => q.alreadyDispatched !== true);
          // No drainable item is found. If the queue contains only
          // dispatched chips whose bubbles haven't been emitted yet,
          // surface them now — `addBubbleFor` in the handler only fires
          // for the *front* chip, so chips behind it would otherwise stay
          // invisible in the transcript.
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
            // Always remove the stamped dispatched chips — leaving
            // them in the queue after stamping creates a permanent
            // zombie "SENT" chip with no removal affordance (the queue
            // panel hides remove/clear buttons when every item is
            // dispatched). The bubbles were captured in
            // `wrapper.leadingBubbles`; the stamp isn't useful once
            // the chip is gone, so a filter is sufficient.
            return {
              queue: state.queue.filter(
                (q) => !(q.alreadyDispatched === true && q.bubbleAdded !== true),
              ),
            };
          }
          // Emit bubbles for leading dispatched chips in front of `idx`
          // and stamp their `bubbleAdded` flag inside the same atomic
          // update so a concurrent `run.result` cannot double-emit.
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
          // Stamp `bubbleAdded: true` on every leading dispatched chip so
          // (a) the timer path's idempotency gate skips re-emitting and
          // (b) a second `run.result` landing inside the grace window
          // doesn't double-stamp. Then slice the pending item out. The
          // stamped rest always has the same length as the unstamped
          // rest (`state.queue.length - 1`), so no length guard is
          // needed here.
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
        // Emit the captured leading-chip bubbles now that the queue
        // mutation has settled. Each call is its own `set` updater, which
        // is exactly how `addBubbleFor` does it in chat-handlers.ts —
        // doing this outside the inner updater avoids re-entrant set
        // calls that would race against the queue mutation.
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
          // Cancel any pending grace timer for this item. `itemId` is the
          // monotonic timer key, so two enqueues in the same millisecond
          // can no longer cross-cancel each other's grace windows.
          if (removed?.itemId !== undefined) cancelDispatchedGraceTimer(removed.itemId);
          return { queue: state.queue.filter((_, i) => i !== idx) };
        }),
      clearQueue: () => {
        // Snapshot the values BEFORE canceling — `cancelDispatchedGraceTimer`
        // mutates the map, and iterating `keys()` while we mutate it is
        // undefined behavior. Snapshot, then clear, then cancel.
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
    }),
    {
      name: 'wrongstack-chat',
      version: 3,
      // Persist enough to recreate the visible transcript after F5.
      //
      //   messages         — the full user/assistant/tool/transcript.
      //   queue            — typed-but-unsubmitted entries (so a refresh
      //                      doesn't make the user retype them).
      //   boundSessionId   — paired with messages so the verifier view can
      //                      detect cross-session bleed.
      //
      // We deliberately do NOT persist: isLoading, abortController, runStart,
      // executions, currentAssistantMessageId, currentToolId, refining, the live
      // thinking buffers, or toolMessageIdsByUseId. These are either non-
      // serializable (AbortController, Map), pure runtime state (isLoading,
      // runStart, currentAssistantMessageId is reset on every replay), or
      // toolMessageIdsByUseId which is rebuildable from messages via
      // indexToolMessages(). Re-fetching them from the server on resume is
      // cheaper and more correct than resurrecting them from localStorage.
      // Attachment data-URLs are stripped before hitting localStorage — a
      // handful of images would blow the ~5MB origin quota and kill persist
      // for the whole transcript. Metadata (name/size/type) survives so the
      // bubble can render a placeholder chip after refresh. Queued items
      // lose their images entirely on refresh for the same reason.
      // WS-062: the persisted slice is now bounded separately from the
      // in-memory one. It was not literally unbounded — `MAX_CHAT_MESSAGES`
      // already caps the array at 1000 — but that cap is sized for the HEAP
      // (up to 48 MB retained), and `localStorage` holds ~5 MB. Writing the
      // full in-memory window at a realistic tool-message size trends toward a
      // quota exception, and when `persist` throws it silently stops writing
      // ANYTHING, including the typed-but-unsubmitted queue this block exists
      // to protect. The attachment stripping below already acknowledged the
      // quota; the message count was the other half of the same problem.
      //
      // It also bounds how much conversation stays readable on the machine.
      // `script-src` is strict again as of WS-061, so the script-injection
      // surface is much smaller than the finding assumed — but that is a
      // reason to keep the copy small, not a reason to keep it whole.
      //
      // Known tradeoff, accepted: truncating can orphan a tool_result whose
      // tool_use fell outside the window. That renders as a result card with no
      // call above it, which is cosmetic. Persist dying for the whole store is
      // not.
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
          // Future shape; drop and start clean.
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
        // Defensive: messages and queue must be arrays. Anything else means
        // the persisted blob is from a build that emitted a different
        // shape — wipe and start from defaults.
        const safeMessages = Array.isArray(p.messages) ? p.messages : [];
        let safeQueue = Array.isArray(p.queue) ? p.queue : [];
        if (version < 3) {
          // v2 persisted already-dispatched chips without live grace timers;
          // discard them rather than rehydrate unremovable zombie chips.
          safeQueue = safeQueue.filter(
            (item): item is QueuedItem =>
              typeof item === 'object' &&
              item !== null &&
              (item as QueuedItem).alreadyDispatched !== true,
          );
        }
        // Seed `enqueueSequence` from the highest persisted `itemId` so a
        // fresh session's first `enqueue` cannot reuse a rehydrated chip's
        // id — `dispatchedGraceTimers` keys on `itemId` and `removeQueued`
        // cancels by `itemId`, so an id collision would let a persisted
        // chip's pop/remove cancel the fresh chip's grace timer (zombie
        // SENT chip + missing user bubble). `normalizeQueuedItem` does the
        // same seeding for any item that flows through it; the rehydrate
        // path skipped that helper, which is why this `for` loop is
        // here instead.
        //
        // v2 items may lack `itemId` entirely (the field was added in v3);
        // stamp one on every legacy item so the queue honors the now-required
        // `QueuedItem.itemId` contract after rehydrate. Without this, a
        // rehydrated pending item could pass `removeQueued`/`dequeue` with
        // `itemId === undefined` and bypass the `cancelDispatchedGraceTimer`
        // guard (which already null-checks), but still violate the declared
        // `QueuedItem` shape every downstream consumer reads.
        const stampedQueue: ChatState['queue'] = safeQueue.flatMap((raw): ChatState['queue'] => {
          // Route every rehydrated item through `normalizeQueuedItem` so
          // (a) the shape is validated, (b) `itemId` is always a positive
          // safe integer, and (c) `enqueueSequence` is seeded from the max
          // persisted value so a fresh session's first enqueue cannot reuse
          // a rehydrated chip's id. Without this, a reload with a queued
          // pending item + a subsequent dispatched BTW would collide on
          // `itemId`, and `cancelDispatchedGraceTimer` would kill the
          // fresh BTW's grace timer — leaving a zombie SENT chip + a
          // missing user bubble. Drop entries that fail validation (no
          // `flatMap`-side exception).
          const normalized = normalizeQueuedItem(raw);
          if (normalized) return [normalized];
          return [];
        });
        return {
          messages: retainWebChatMessages(safeMessages as ChatState['messages']),
          queue: stampedQueue,
          boundSessionId: typeof p.boundSessionId === 'string' ? p.boundSessionId : null,
          thinkingLogBuffer: typeof p.thinkingLogBuffer === 'string' ? p.thinkingLogBuffer : '',
        };
      },
      // `_state` is unused by design — we only care that the rehydrate
      // completed without error, which is the verifier view's signal
      // that the local transcript is now safe to render.
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
