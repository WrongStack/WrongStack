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

import {
  isFinalTurnStopReason,
  type projectNextStepsToolInput,
} from '@wrongstack/tools/next-steps';
import { projectChatMessage, projectFleetMessage } from '@wrongstack/webui-protocol';
import type { MessageHandlerDeps } from './message-handler-deps.js';
import { handleSessionStartMessage } from './message-handler-session-start.js';
import {
  handleToolStarted,
  handleToolProgress,
  handleToolExecuted,
} from './message-handler-tool-events.js';
import type { FallbackPendingProjection } from '../fallback-modal.js';
import { projectFallbackPending } from '../fallback-modal.js';
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
  projectAgentTimelineEntry,
  projectCompletedAgentText,
  stampAgentUpdates,
} from './agent-model.js';
import {
  boundSimpleChatText,
  contentToText,
  retainSimpleChatMessages,
  updateSubagents,
} from './chat-model.js';
import type { FileMention } from './file-mention.js';
import { projectAssistantMessage } from './message-projection.js';
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

export type { MessageHandlerDeps } from './message-handler-deps.js';

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
  const nextStepsByToolId = new Map<string, ReturnType<typeof projectNextStepsToolInput>>();
  let completedToolNextSteps: ReturnType<typeof projectNextStepsToolInput> = [];
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
        handleSessionStartMessage({
          message,
          deps,
          nextStepsByToolId,
          resetCompletedToolNextSteps: () => {
            completedToolNextSteps = [];
          },
        });
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
            // The canonical response can legitimately extend what was streamed:
            // the runtime appends a tool-produced <nextsteps> block to the
            // turn-ending response, and that block never arrives as a delta.
            // Adopt the canonical text when it is a strict extension of the
            // streamed text — same rule the WebUI applies (protocol parity).
            const streamedText = last.text.trim();
            const extended =
              streamedText.length > 0 &&
              responseText.length > streamedText.length &&
              responseText.startsWith(streamedText);
            return current.map((item, index) =>
              index === current.length - 1
                ? {
                    ...item,
                    ...(extended ? { text: boundSimpleChatText(responseText) } : {}),
                    streaming: false,
                    final,
                  }
                : item,
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
      case 'stats.get': {
        // Server-side session stats carry both the cumulative prompt-cache
        // figures and the per-request `currentRequest.cacheRead` snapshot.
        // Coverage must come from the per-request figure — `usage.cacheRead`
        // is cumulative across the whole session and would mislead the
        // "cache covers the first N tokens of THIS prompt" indicator.
        // Defensive parse: the reply arrives as `Record<string, unknown>`,
        // so every field is coerced through a finite-number guard rather
        // than cast.
        const payload = message.payload;
        const usage = payload['usage'];
        const cache = payload['cache'];
        const currentRequest = payload['currentRequest'];
        if (usage && typeof usage === 'object' && cache && typeof cache === 'object') {
          const c = cache as Record<string, unknown>;
          const currentRequestCacheRead =
            currentRequest && typeof currentRequest === 'object'
              ? finiteNumber((currentRequest as Record<string, unknown>)['cacheRead'])
              : 0;
          const readTokens = finiteNumber(c['readTokens']);
          const writeTokens = finiteNumber(c['writeTokens']);
          const hitRatioRaw = c['hitRatio'];
          const hitRatio =
            typeof hitRatioRaw === 'number' && Number.isFinite(hitRatioRaw) ? hitRatioRaw : 0;
          setContext((current) => ({
            ...current,
            // Coverage is the per-request snapshot, capped at the live
            // request size so the figure never overshoots what is
            // actually being sent. Falls back to 0 when the server
            // omits `currentRequest` (older clients, or before the
            // server-side addition in `introspection-routes.ts`).
            cache: {
              readTokens,
              writeTokens,
              hitRatio,
              coverageTokens: Math.max(0, Math.min(current.tokens, currentRequestCacheRead)),
            },
          }));
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
        handleToolStarted(message, nextStepsByToolId, setRunning, setActivity, setToolCalls);
        break;
      }
      case 'tool.progress': {
        handleToolProgress(message, setActivity);
        break;
      }
      case 'tool.executed': {
        handleToolExecuted(
          message,
          nextStepsByToolId,
          (steps) => {
            completedToolNextSteps = steps;
          },
          setActivity,
          setToolCalls,
        );
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
        // The normal path carries the tool's steps in the final response as a
        // <nextsteps> block. If that response was absent, retain the exact
        // structured suggestions instead of silently losing the tool result.
        if (completedToolNextSteps.length > 0) {
          setMessages((current) => {
            const hasRenderedSuggestions = current.some(
              (item) =>
                item.role === 'assistant' &&
                item.final === true &&
                ((item.nextSteps?.length ?? 0) > 0 ||
                  projectAssistantMessage(item.text).nextSteps.length > 0),
            );
            return hasRenderedSuggestions
              ? current
              : retainSimpleChatMessages([
                  ...current,
                  {
                    id: messageId('nextsteps'),
                    role: 'assistant',
                    text: '',
                    final: true,
                    nextSteps: completedToolNextSteps,
                  },
                ]);
          });
          completedToolNextSteps = [];
        }
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
        setContext((prev) => ({
          // `load` is emitted as a 0-1 fraction of the context budget
          // (e.g. 0.68 = 68%); values > 1 mean the budget is overflowed
          // (e.g. 1.35 = 135%). See core `ctx.pct` emit + agent-status
          // tracker. Never magnitude-sniff/divide — that corrupted genuine
          // overflow values (1.35 -> 0.0135). Just clamp negatives to 0.
          load: normalizeContextLoad(payload['load']),
          tokens: finiteNumber(payload['tokens']),
          maxContext: finiteNumber(payload['maxContext']),
          // `ctx.pct` does not carry cache stats — keep whatever the
          // `stats.get` handler most recently wrote. Going `null` here
          // would erase a valid reading on every per-request tick.
          cache: prev.cache,
        }));
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
