/**
 * WebSocket message handler for SimpleUI.
 *
 * Extracted from app.tsx into a testable factory function.
 * The factory returns a stable handler reference so the
 * SimpleSocket effect never reconnects on a re-render.
 *
 * Usage in app.tsx:
 *   const handleServerMessage = useMemo(
 *     () => createMessageHandler({ ... }),
 *     [dispatchUserMessage, requestProviderModels, worklists],
 *   );
 */

import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import {
  projectChatMessage,
  projectFleetMessage,
  projectSessionMessage,
  projectToolMessage,
} from '@wrongstack/webui-server/protocol';
import type {
  AgentMode,
  AgentTranscriptEntry,
  ChatMessage,
  ContextInfo,
  FileEditMeta,
  ModelDescriptor,
  PendingConfirm,
  ServerMessage,
  SessionInfo,
  SimpleSessionSummary,
  SimpleSubagent,
  ToolCallInfo,
} from '../types.js';
import {
  appendAgentTranscriptEntry,
  LEADER_AGENT_ID,
  mergeSubagentSnapshot,
  parseAgentSessionReplays,
  projectAgentTimelineEntry,
  projectCompletedAgentText,
  stampAgentUpdates,
} from './agent-model.js';
import {
  boundSimpleChatText,
  contentToText,
  replayToMessages,
  retainSimpleChatMessages,
  updateSubagents,
} from './chat-model.js';
import type { FileMention } from './file-mention.js';
import { projectFallbackPending } from '../fallback-modal.js';
import {
  parseCatalogProviders,
  parseSavedProviderIds,
  providersNeedingModels,
} from './model-switch.js';
import type { SimplePrefs } from './prefs-model.js';
import { parsePrefs } from './prefs-model.js';
import type { QueuedItem } from './queue-model.js';
import { dequeueItem } from './queue-model.js';
import type { RefineResultPayload, RefineState } from './refine-model.js';
import { projectRefineResult } from './refine-model.js';
import { parseSessionSummaries } from './session-model.js';
import type { StatusNoticeProjection } from './status-notice.js';
import { projectStatusNotice } from './status-notice.js';
import type { WorklistStore } from './worklist-store.js';

// ── Helpers ─────────────────────────────────────────────────────────

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize a `ctx.pct` `load` into a 0-1 context-fill fraction.
 *
 * The wire unit is a fraction of the context budget, NOT a percentage:
 * core computes `rawLoad = tokens / maxContext` and emits it as
 * `load = Math.max(0, Math.min(1, rawLoad))` — already clamped to [0, 1]
 * (see `emitContextPct` in core `agent-loop.ts`; the un-clamped value is
 * carried separately as `rawLoad`). So `load: 0.68` means 68% full and a
 * full budget is exactly `1`. The previous `load > 1 ? load / 100`
 * heuristic silently corrupted any value it mistook for a percentage and
 * could never distinguish "1% as a percent" from "100% as a fraction".
 *
 * Deterministic rule: trust the fraction and pass it through. The only
 * adjustment is a defensive clamp of non-finite/negative inputs to 0 (the
 * producer already clamps, so this is just belt-and-suspenders against a
 * malformed frame — we do NOT divide or magnitude-sniff).
 */
export function normalizeContextLoad(value: unknown): number {
  const load = finiteNumber(value);
  return load > 0 ? load : 0;
}

function messageId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

// ── Dependency types ────────────────────────────────────────────────

export interface MessageHandlerDeps {
  // Refs — used for reading current state without re-render dependencies
  prefsRef: { current: SimplePrefs };
  draftRef: { current: string };
  fileRefsRef: { current: string[] };
  queueRef: { current: QueuedItem[] };
  sessionIdRef: { current: string | null };
  messagesRef: { current: ChatMessage[] };
  activeModelRef: { current: { provider: string; model: string } | null };
  runningRef: { current: boolean };
  refineStateRef: { current: RefineState | null };
  refineEpochRef: { current: number };
  requestedModelsRef: { current: Set<string> };
  socketRef: {
    current: { send: (type: string, payload?: Record<string, unknown>) => void } | null;
  };
  stickToBottomRef: { current: boolean };

  // State setters
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setActivity: React.Dispatch<React.SetStateAction<string>>;
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallInfo[]>>;
  setSubagents: React.Dispatch<React.SetStateAction<SimpleSubagent[]>>;
  setAgentTranscripts: React.Dispatch<React.SetStateAction<Record<string, AgentTranscriptEntry[]>>>;
  setSession: React.Dispatch<React.SetStateAction<SessionInfo | null>>;
  setSessionMenuOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  setSessions: React.Dispatch<React.SetStateAction<SimpleSessionSummary[]>>;
  setContext: React.Dispatch<React.SetStateAction<ContextInfo>>;
  setModels: React.Dispatch<React.SetStateAction<Record<string, ModelDescriptor[]>>>;
  setModes: React.Dispatch<React.SetStateAction<AgentMode[]>>;
  setActiveModeId: React.Dispatch<React.SetStateAction<string>>;
  setPrefs: React.Dispatch<React.SetStateAction<SimplePrefs>>;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setFileRefs: React.Dispatch<React.SetStateAction<string[]>>;
  setFileMention: React.Dispatch<React.SetStateAction<FileMention | null>>;
  setNotice: React.Dispatch<React.SetStateAction<(StatusNoticeProjection & { id: string }) | null>>;
  /** Show/dismiss the fallback model modal. */
  setFallbackPending?: React.Dispatch<
    React.SetStateAction<
      | {
          requestId: string;
          from: { providerId: string; model: string };
          status: number;
          candidates: Array<{ providerId: string; model: string }>;
          autoSwitchSeconds: number;
        }
      | null
    >
  >;
  setQueue: React.Dispatch<React.SetStateAction<QueuedItem[]>>;
  setRefineState: React.Dispatch<React.SetStateAction<RefineState | null>>;
  setPendingConfirm: React.Dispatch<React.SetStateAction<PendingConfirm | null>>;
  setSelectedAgentId: React.Dispatch<React.SetStateAction<string>>;
  setSessionStart: React.Dispatch<React.SetStateAction<number | null>>;
  setShowJumpToLatest: React.Dispatch<React.SetStateAction<boolean>>;
  setFileMatches: React.Dispatch<React.SetStateAction<string[]>>;
  setFilePickerIndex: React.Dispatch<React.SetStateAction<number>>;
  setFileSearching: React.Dispatch<React.SetStateAction<boolean>>;
  setAttachedImages: React.Dispatch<
    React.SetStateAction<Array<{ id: string; data: string; mime: string; name: string }>>
  >;
  setCopiedMessageId: React.Dispatch<React.SetStateAction<string | null>>;
  setProviderLabels: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setDiffFiles: React.Dispatch<React.SetStateAction<FileEditMeta[] | null>>;
  resetAgentNameCache: () => void;
  /** Called when a run completes and the user has chime enabled. */
  onChime?: (() => void) | undefined;
  /** Called when session.start contains version/update info. */
  onUpdateInfo?:
    | ((info: { appVersion: string; latestVersion: string; updateAvailable: boolean }) => void)
    | undefined;

  // Stable callbacks provided by app.tsx
  /** Returns `true` when the message was dispatched, `false` when dropped
   *  (no session / empty content / no socket). Queue-drain callers gate on
   *  this so a dropped drain does not silently consume the queued item. */
  dispatchUserMessage: (
    content: string,
    images?: { data: string; mime: string; mediaType?: string }[],
  ) => boolean;
  requestProviderModels: (providerId: string) => void;
  writeComposerDraft: (sessionId: string, draft: { text: string; fileRefs: string[] }) => void;
  clearComposerDraft: (sessionId: string) => void;
  readComposerDraft: (sessionId: string) => { text: string; fileRefs: string[] };

  // External store
  worklists: WorklistStore;
}

// ── Factory ─────────────────────────────────────────────────────────

export interface ServerMessageHandler {
  (message: ServerMessage): void;
  /**
   * Apply any buffered streaming text immediately.
   *
   * Deltas are coalesced onto an animation frame, so a caller that needs the
   * transcript to be current right now — a test asserting on state, or teardown
   * that would otherwise drop the last partial token — must drain the buffer
   * itself. Handling any non-delta message flushes implicitly.
   */
  flush(): void;
}

export function createMessageHandler(deps: MessageHandlerDeps): ServerMessageHandler {
  const {
    prefsRef,
    draftRef,
    fileRefsRef,
    queueRef,
    sessionIdRef,
    activeModelRef,
    refineStateRef,
    refineEpochRef,
    socketRef,
    requestedModelsRef,
    setMessages,
    setRunning,
    setActivity,
    setToolCalls,
    setSubagents,
    setAgentTranscripts,
    setSession,
    setSessionMenuOpen,
    setSessions,
    setContext,
    setModels,
    setModes,
    setActiveModeId,
    setPrefs,
    setDraft,
    setFileRefs,
    setFileMention,
    setNotice,
    setQueue,
    setRefineState,
    setPendingConfirm,
    setSelectedAgentId,
    setSessionStart,
    setShowJumpToLatest,
    setFileMatches,
    setFilePickerIndex,
    setFileSearching,
    setAttachedImages,
    setProviderLabels,
    resetAgentNameCache,
    onChime,
    dispatchUserMessage,
    requestProviderModels,
    writeComposerDraft,
    clearComposerDraft,
    readComposerDraft,
    worklists,
    stickToBottomRef,
  } = deps;

  /**
   * Drain the next queued message at a turn boundary (`run.result` / `error`).
   *
   * The queue head is only consumed if `dispatchUserMessage` actually sends
   * it. Previously the drain advanced the queue (`queueRef.current = rest;
   * setQueue(rest)`) BEFORE dispatching, so if dispatch was dropped — e.g. the
   * session was cleared between enqueue and drain — the held message was
   * removed from the queue but never sent: silent user-input loss. Gating on
   * the dispatch result keeps the item queued for the next successful drain.
   */
  function drainQueue(): void {
    const { item, rest } = dequeueItem(queueRef.current);
    if (!item) return;
    if (!dispatchUserMessage(item.text)) return; // dropped — keep the item queued
    queueRef.current = rest;
    setQueue(rest);
  }

  /**
   * Streaming text arrives one `provider.text_delta` frame per token. Applying
   * each one directly meant a `setMessages` — and therefore a React render of
   * the whole transcript — per token, with two full copies of the message array
   * allocated inside the updater. Deltas are instead accumulated here and
   * applied once per animation frame, matching the coalescing the WebUI chat
   * already does.
   *
   * Ordering is the constraint that makes this safe: every other message type
   * flushes the buffer before it is handled, so a tool call or run result can
   * never overtake text that arrived before it.
   */
  let pendingDelta = '';
  let frameHandle: ReturnType<typeof setTimeout> | number | null = null;

  const scheduleFlush =
    typeof requestAnimationFrame === 'function'
      ? (callback: () => void) => requestAnimationFrame(callback)
      : (callback: () => void) => setTimeout(callback, 16);
  const cancelFlush =
    typeof cancelAnimationFrame === 'function'
      ? (handle: ReturnType<typeof setTimeout> | number) => cancelAnimationFrame(handle as number)
      : (handle: ReturnType<typeof setTimeout> | number) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>);

  function flushPendingDelta(): void {
    if (frameHandle !== null) {
      cancelFlush(frameHandle);
      frameHandle = null;
    }
    if (!pendingDelta) return;
    const text = pendingDelta;
    pendingDelta = '';
    setMessages((current) => {
      const last = current.at(-1);
      if (last?.role === 'assistant' && last.streaming) {
        // Only the tail changes, so copy the array once and replace one entry
        // instead of mapping the whole transcript twice.
        const next = current.slice();
        next[next.length - 1] = { ...last, text: boundSimpleChatText(last.text + text) };
        return next;
      }
      // A thinking block is frozen the moment assistant text starts.
      const normalized = current.map((item) =>
        item.streaming && item.role === 'thinking' ? { ...item, streaming: false } : item,
      );
      normalized.push({
        id: messageId('assistant'),
        role: 'assistant',
        text: boundSimpleChatText(text),
        streaming: true,
      });
      return retainSimpleChatMessages(normalized);
    });
  }

  const handleServerMessage = function handleServerMessage(message: ServerMessage): void {
    // Anything that is not more streaming text must observe the text that
    // preceded it, so drain the buffer before doing any other work.
    if (message.type !== 'provider.text_delta') flushPendingDelta();
    const payload = message.payload ?? {};
    worklists.applyMessage(message);
    const projectedNotice = projectStatusNotice(message);
    if (projectedNotice) {
      setNotice({ ...projectedNotice, id: messageId('notice') });
    }
    switch (message.type) {
      case 'session.start': {
        const sessionProjection = projectSessionMessage(message);
        if (!sessionProjection) break;
        const {
          id,
          provider,
          model,
          maxContext,
          projectName,
          cwd,
          replayMessages,
          replayMarkers,
          replayUsage,
        } = sessionProjection;
        const previousId = sessionIdRef.current;
        const switchedSession = Boolean(previousId && id && previousId !== id);
        const resetSessionState = switchedSession || sessionProjection.reset;
        if (switchedSession && previousId) {
          writeComposerDraft(previousId, {
            text: draftRef.current,
            fileRefs: fileRefsRef.current,
          });
        }
        if (!previousId || resetSessionState) {
          stickToBottomRef.current = true;
          setShowJumpToLatest(false);
        }
        sessionIdRef.current = id || null;
        if (!previousId || resetSessionState) worklists.reset(id || null);
        activeModelRef.current = provider && model ? { provider, model } : null;
        setSession({
          id,
          provider,
          model,
          projectName,
          cwd,
          maxContext,
        });
        setModels((current) => ({
          ...current,
          [provider]: current[provider]?.some((item) => item.id === model)
            ? current[provider]
            : [{ id: model, name: model }, ...(current[provider] ?? [])].filter((item) => item.id),
        }));
        if (replayMessages) {
          setMessages(replayToMessages(replayMessages, replayMarkers));
        } else if (resetSessionState) {
          setMessages([]);
        }
        if (payload['appVersion'] || payload['latestVersion']) {
          deps.onUpdateInfo?.({
            appVersion: String(payload['appVersion'] ?? ''),
            latestVersion: String(payload['latestVersion'] ?? ''),
            updateAvailable: Boolean(payload['updateAvailable']),
          });
        }

        if (!previousId || resetSessionState) {
          const agentSessions = parseAgentSessionReplays(payload['agentSessions']);
          setSubagents(
            agentSessions.map(({ subagentId, agentName, status, task }) => ({
              id: subagentId,
              name: agentName,
              status,
              task,
            })),
          );
          setAgentTranscripts(
            Object.fromEntries(
              agentSessions.map(({ subagentId, transcript }) => [subagentId, transcript]),
            ),
          );
        }
        if (!previousId || switchedSession) {
          const savedDraft = readComposerDraft(id);
          draftRef.current = savedDraft.text;
          fileRefsRef.current = savedDraft.fileRefs;
          setDraft(savedDraft.text);
          setFileRefs(savedDraft.fileRefs);
          setFileMention(null);
        } else if (sessionProjection.reset) {
          clearComposerDraft(id);
          draftRef.current = '';
          fileRefsRef.current = [];
          setDraft('');
          setFileRefs([]);
          setFileMention(null);
        }
        if (resetSessionState) {
          setPendingConfirm(null);
          setRunning(false);
          setActivity('');
          setToolCalls([]);
          setSelectedAgentId(LEADER_AGENT_ID);
          resetAgentNameCache();
          setSessionStart(Date.now());
          setAttachedImages([]);
        }
        setSessionMenuOpen?.(false);
        const replayInput = replayUsage ? finiteNumber(replayUsage['input']) : 0;
        setContext((current) => ({
          load: resetSessionState
            ? maxContext > 0
              ? replayInput / maxContext
              : 0
            : current.maxContext > 0
              ? current.load
              : maxContext > 0
                ? replayInput / maxContext
                : 0,
          tokens: resetSessionState ? replayInput : current.tokens || replayInput,
          maxContext: maxContext || current.maxContext,
        }));
        if (provider) requestProviderModels(provider);
        socketRef.current?.send('sessions.list', { sessionId: id, limit: 12 });
        break;
      }
      case 'sessions.list': {
        if (typeof payload['error'] !== 'string') {
          setSessions(parseSessionSummaries(payload['sessions']));
        }
        break;
      }
      case 'provider.catalog': {
        const entries = parseCatalogProviders(payload);
        const labels: Record<string, string> = {};
        for (const entry of entries) {
          labels[entry.id] = entry.label;
        }
        setProviderLabels(labels);
        for (const id of providersNeedingModels({
          catalog: entries,
          currentProvider: activeModelRef.current?.provider,
          alreadyRequested: requestedModelsRef.current,
        })) {
          requestProviderModels(id);
        }
        break;
      }
      case 'providers.saved': {
        for (const id of providersNeedingModels({
          savedIds: parseSavedProviderIds(payload),
          currentProvider: activeModelRef.current?.provider,
          alreadyRequested: requestedModelsRef.current,
        })) {
          requestProviderModels(id);
        }
        break;
      }
      case 'provider.models': {
        const provider = typeof payload['provider'] === 'string' ? payload['provider'] : '';
        const list = Array.isArray(payload['models'])
          ? payload['models'].flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const item = entry as Record<string, unknown>;
              if (typeof item['id'] !== 'string') return [];
              return [
                {
                  id: item['id'],
                  name: typeof item['name'] === 'string' ? item['name'] : item['id'],
                  contextWindow: finiteNumber(item['contextWindow']) || undefined,
                } satisfies ModelDescriptor,
              ];
            })
          : [];
        if (provider) {
          const active = activeModelRef.current;
          const nextList =
            active?.provider === provider && !list.some((item) => item.id === active.model)
              ? [{ id: active.model, name: active.model }, ...list]
              : list;
          setModels((current) => ({ ...current, [provider]: nextList }));
        }
        break;
      }
      case 'files.list': {
        const files = Array.isArray(payload['files'])
          ? payload['files'].filter((file): file is string => typeof file === 'string')
          : [];
        setFileMatches(files);
        setFilePickerIndex(0);
        setFileSearching(false);
        break;
      }
      case 'provider.thinking_delta': {
        const projection = projectChatMessage(message);
        if (projection?.kind !== 'thinking-delta') break;
        const { text } = projection;
        setRunning(true);
        setActivity('Thinking');
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'thinking' && last.streaming) {
            return current.map((item, index) =>
              index === current.length - 1
                ? { ...item, text: boundSimpleChatText(item.text + text) }
                : item,
            );
          }
          return retainSimpleChatMessages([
            ...current.map((item) =>
              item.streaming && item.role === 'thinking' ? { ...item, streaming: false } : item,
            ),
            {
              id: messageId('thinking'),
              role: 'thinking',
              text: boundSimpleChatText(text),
              streaming: true,
            },
          ]);
        });
        break;
      }
      case 'provider.text_delta': {
        const projection = projectChatMessage(message);
        if (projection?.kind !== 'text-delta') break;
        const { text } = projection;
        setRunning(true);
        setActivity('Responding');
        pendingDelta += text;
        if (frameHandle === null) {
          frameHandle = scheduleFlush(() => {
            frameHandle = null;
            flushPendingDelta();
          });
        }
        break;
      }
      case 'provider.response': {
        const projection = projectChatMessage(message);
        if (projection?.kind !== 'response') break;
        const responseText = contentToText(projection.content).trim();
        // A `tool_use` stop means the agent loop runs again, so this text is
        // prose the model wrote on its way to a tool call — not its answer.
        // Only a turn-ending response may offer <nextsteps> suggestions.
        const final = isFinalTurnStopReason(projection.stopReason);
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'assistant' && last.streaming) {
            return current.map((item, index) =>
              index === current.length - 1 ? { ...item, streaming: false, final } : item,
            );
          }
          return responseText
            ? retainSimpleChatMessages([
                ...current,
                {
                  id: messageId('assistant'),
                  role: 'assistant',
                  text: boundSimpleChatText(responseText),
                  final,
                },
              ])
            : current;
        });
        setActivity('Working');
        break;
      }
      case 'provider.retry':
        setRunning(true);
        setActivity(
          `Retrying ${typeof payload['providerId'] === 'string' ? payload['providerId'] : 'provider'}`,
        );
        break;
      case 'provider.fallback': {
        // The server broadcasts fallback events to every connected client.
        // Only react to the session this tab is viewing — otherwise one
        // session's resolution would clear another tab's pending modal.
        if (
          typeof payload['sessionId'] === 'string' &&
          payload['sessionId'] !== sessionIdRef.current
        ) {
          break;
        }
        const target =
          payload['to'] && typeof payload['to'] === 'object'
            ? (payload['to'] as Record<string, unknown>)
            : undefined;
        const fallbackModel = typeof target?.['model'] === 'string' ? target['model'] : '';
        setRunning(true);
        setActivity(fallbackModel ? `Fallback · ${fallbackModel}` : 'Switching fallback model');
        // Clear any pending fallback modal — the switch happened.
        deps.setFallbackPending?.(null);
        break;
      }
      case 'provider.fallback_pending': {
        // Server broadcasts reach every tab; only show the modal for the
        // session this tab is viewing.
        if (
          typeof payload['sessionId'] === 'string' &&
          payload['sessionId'] !== sessionIdRef.current
        ) {
          break;
        }
        // Show the fallback modal with countdown + manual pick.
        const projected = projectFallbackPending(message);
        if (projected) {
          deps.setFallbackPending?.(projected);
        }
        break;
      }
      case 'context.compacted':
        setActivity('Context compacted');
        break;
      case 'tool.loop_detected':
        setActivity('Stopping repeated tool loop');
        break;
      case 'iteration.started':
        setRunning(true);
        setActivity('Thinking');
        break;
      case 'tool.started': {
        const projection = projectToolMessage(message);
        if (projection?.kind !== 'started') break;
        const { name, id } = projection;
        setRunning(true);
        setActivity(`Running ${name}`);
        setToolCalls((current) => [
          ...current,
          { id, name, input: projection.input, status: 'running', ts: new Date().toISOString() },
        ]);
        break;
      }
      case 'tool.progress': {
        const projection = projectToolMessage(message);
        if (projection?.kind === 'progress' && projection.text)
          setActivity(projection.text.split('\n')[0] ?? 'Working');
        break;
      }
      case 'tool.executed': {
        const projection = projectToolMessage(message);
        if (projection?.kind !== 'executed') break;
        const execId = projection.id;
        const execName = projection.name;
        setActivity('Thinking');
        if (execId || execName) {
          setToolCalls((current) => {
            // Find the single call to close. With an id it's an exact match.
            // Without an id, pair by name against the LAST still-running call
            // of that name — mirroring agentTranscriptToToolCalls in
            // tool-model.ts. A plain `.map` here closed *every* running call
            // with that name, so two concurrent same-tool calls collapsed
            // into one (both marked done with the same output).
            // Only ever close a still-running call. Requiring `running` on
            // BOTH the id and the name branch makes a duplicate/late
            // `tool.executed` (same id arriving twice) a safe no-op instead of
            // re-closing an already-done call and overwriting its output.
            let matchIndex = -1;
            for (let index = current.length - 1; index >= 0; index--) {
              const tc = current[index];
              if (tc?.status !== 'running') continue;
              if (execId ? tc.id === execId : tc.name === execName) {
                matchIndex = index;
                break;
              }
            }
            if (matchIndex < 0) return current;
            const target = current[matchIndex];
            if (!target) return current;
            const next = current.slice();
            next[matchIndex] = {
              ...target,
              status: projection.ok ? 'done' : 'error',
              output: projection.output,
              durationMs: projection.durationMs,
              ok: projection.ok,
              ...(projection.sage ? { sage: projection.sage } : {}),
            };
            return next;
          });
        }
        break;
      }
      case 'run.result': {
        setRunning(false);
        setActivity('');
        if (prefsRef.current.chime) onChime?.();
        // The run is over. Anything still streaming is the turn's final
        // answer — provider.response normally marks it, but a run that ended
        // without one (abort, error, missing event) would otherwise leave the
        // last message unmarked and silently lose its suggestions.
        setMessages((current) =>
          current.map((item) =>
            item.streaming
              ? { ...item, streaming: false, ...(item.role === 'assistant' ? { final: true } : {}) }
              : item,
          ),
        );
        drainQueue();
        break;
      }
      case 'prefs.updated':
        setPrefs((current) => parsePrefs(payload, current));
        break;
      case 'modes.list': {
        const list = Array.isArray(payload['modes'])
          ? payload['modes'].flatMap((entry) => {
              if (!entry || typeof entry !== 'object') return [];
              const item = entry as Record<string, unknown>;
              if (typeof item['id'] !== 'string') return [];
              return [
                {
                  id: item['id'],
                  name: typeof item['name'] === 'string' ? item['name'] : item['id'],
                  description:
                    typeof item['description'] === 'string' ? item['description'] : undefined,
                } satisfies AgentMode,
              ];
            })
          : [];
        setModes(list);
        if (typeof payload['activeId'] === 'string') setActiveModeId(payload['activeId']);
        break;
      }
      case 'model.refine_result': {
        const current = refineStateRef.current;
        if (!current) break;
        // No request is in flight during the countdown phase — drop any
        // result that arrives now. A countdown state has no `epoch` stamped
        // yet (the epoch is only attached when the request leaves in
        // `refineStartNow`), so an epoch-based guard alone would silently
        // accept orphans for any state whose epoch field is undefined.
        // This status check is the most direct guard and must come first.
        if (current.status === 'countdown') break;
        // Stale-result guard: if the user flushed the panel mid-flight
        // (startSend → setRefineState(null) → new countdown), the epoch
        // on the incoming state will differ from the epoch we last attached
        // to a `model.refine` request.  Drop the orphan — the state it
        // refers to has been superseded.
        if (current.epoch !== undefined && current.epoch !== refineEpochRef.current) break;
        const action = projectRefineResult(payload as RefineResultPayload, current);
        if (action.kind === 'retry') {
          refineEpochRef.current++;
          setRefineState({ ...action.state, epoch: refineEpochRef.current });
          socketRef.current?.send('model.refine', {
            text: action.state.original,
            timeoutMs: action.timeoutMs,
          });
          break;
        }
        if (action.kind === 'send') {
          setRefineState(null);
          dispatchUserMessage(action.text);
          break;
        }
        setRefineState(action.state);
        break;
      }
      case 'error': {
        const phase = typeof payload['phase'] === 'string' ? payload['phase'] : '';
        if (phase === 'rate_limit') {
          // Rate-limit frames are transient throttles, not run failures.
          // Show as a dismissible notice (not a permanent chat message) and
          // do NOT drain the queue — dispatching now would just feed more
          // messages into the throttled connection, re-triggering the
          // limiter and flooding the chat with "SYSTEM Too many messages."
          //
          // Clear the running spinner: the server dropped the frame that
          // triggered the limiter, so no run.result/error will ever arrive
          // to clear it. Without this the UI stays stuck on "Thinking".
          setRunning(false);
          setActivity('');
          setNotice({
            id: messageId('rate-limit'),
            text:
              typeof payload['message'] === 'string'
                ? payload['message']
                : 'Too many messages. Please wait.',
            tone: 'warning',
          });
          break;
        }
        const text = typeof payload['message'] === 'string' ? payload['message'] : 'Run failed';
        setRunning(false);
        setActivity('');
        setMessages((current) =>
          retainSimpleChatMessages([
            ...current,
            { id: messageId('error'), role: 'system', text: boundSimpleChatText(text) },
          ]),
        );
        drainQueue();
        break;
      }
      case 'ctx.pct': {
        setContext({
          // `load` is emitted as a 0-1 fraction of the context budget
          // (e.g. 0.68 = 68%); values > 1 mean the budget is overflowed
          // (e.g. 1.35 = 135%). See core `ctx.pct` emit + agent-status
          // tracker. Never magnitude-sniff/divide — that corrupted genuine
          // overflow values (1.35 -> 0.0135). Just clamp negatives to 0.
          load: normalizeContextLoad(payload['load']),
          tokens: finiteNumber(payload['tokens']),
          maxContext: finiteNumber(payload['maxContext']),
        });
        break;
      }
      case 'ctx.max_context': {
        const maxContext = finiteNumber(payload['maxContext']);
        setContext((current) => ({ ...current, maxContext }));
        setSession((current) => (current ? { ...current, maxContext } : current));
        break;
      }
      case 'tool.confirm_needed':
        if (typeof payload['id'] === 'string') {
          setPendingConfirm({
            id: payload['id'],
            toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : 'tool',
            input: payload['input'],
            riskTier: typeof payload['riskTier'] === 'string' ? payload['riskTier'] : undefined,
          });
        }
        break;
      case 'coordinator.stats': {
        const fleet = projectFleetMessage(message);
        const statuses = fleet?.kind === 'coordinator' ? fleet.agents : [];
        const snapshot = statuses.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const item = entry as Record<string, unknown>;
          const id = typeof item['id'] === 'string' ? item['id'] : '';
          if (!id || id === LEADER_AGENT_ID) return [];
          return [
            {
              id,
              name: typeof item['name'] === 'string' ? item['name'] : id,
              status: typeof item['status'] === 'string' ? item['status'] : 'idle',
              task: typeof item['currentTask'] === 'string' ? item['currentTask'] : undefined,
            } satisfies SimpleSubagent,
          ];
        });
        setSubagents((current) =>
          stampAgentUpdates(current, mergeSubagentSnapshot(current, snapshot)),
        );
        break;
      }
      case 'subagent.event': {
        const id = typeof payload['subagentId'] === 'string' ? payload['subagentId'] : '';
        setSubagents((current) =>
          stampAgentUpdates(
            current,
            payload['kind'] === 'removed'
              ? current.map((agent) =>
                  agent.id === id ? { ...agent, status: 'stopped', task: undefined } : agent,
                )
              : updateSubagents(current, payload),
          ),
        );
        if (payload['kind'] === 'task_completed' && id) {
          const entry = projectCompletedAgentText(
            payload,
            messageId(`agent-${id}`),
            typeof payload['name'] === 'string' ? payload['name'] : id,
          );
          if (entry) {
            setAgentTranscripts((current) => ({
              ...current,
              [id]: appendAgentTranscriptEntry(current[id] ?? [], entry),
            }));
          }
        }
        break;
      }
      case 'agent.timeline.message': {
        const entry = projectAgentTimelineEntry(payload, messageId('agent-event'));
        if (!entry) break;
        setSubagents((current) => {
          if (current.some((agent) => agent.id === entry.subagentId)) return current;
          return [
            ...current,
            {
              id: entry.subagentId,
              name: entry.agentName,
              status: 'running',
            },
          ];
        });
        setAgentTranscripts((current) => ({
          ...current,
          [entry.subagentId]: appendAgentTranscriptEntry(current[entry.subagentId] ?? [], entry),
        }));
        break;
      }
      case 'agent.status_changed': {
        const id = typeof payload['subagentId'] === 'string' ? payload['subagentId'] : '';
        if (!id || id === LEADER_AGENT_ID) break;
        const agentName = typeof payload['agentName'] === 'string' ? payload['agentName'] : id;
        setSubagents((current) => {
          const exists = current.some((agent) => agent.id === id);
          const patch = {
            id,
            name: agentName,
            status: typeof payload['status'] === 'string' ? payload['status'] : 'idle',
            task: typeof payload['task'] === 'string' ? payload['task'] : undefined,
          } satisfies SimpleSubagent;
          return exists
            ? current.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent))
            : [...current, patch];
        });
        break;
      }
    }
  } as ServerMessageHandler;

  handleServerMessage.flush = flushPendingDelta;
  return handleServerMessage;
}
