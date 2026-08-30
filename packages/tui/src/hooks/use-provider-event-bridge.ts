import type { ContentBlock } from '@wrongstack/core/types';
import { tuiStreamFlushMs } from '@wrongstack/core/utils';
import { DEFAULT_MIN_IMPORTANCE, DEFAULT_MIN_SCORE, MIN_RELATION_STRENGTH } from '@wrongstack/sage';
import { isFinalTurnStopReason } from '@wrongstack/tools/next-steps';
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import {
  applyMemoryContextSnapshot,
  applyMemoryInjectorRun,
  emptyMemoryContextMonitor,
  type MemoryContextMonitorState,
  memoryEventMatchesSession,
} from '../memory-context-monitor.js';
import { memoryLifecycleEntry } from '../memory-lifecycle-entry.js';
import {
  MAX_ASSISTANT_STREAM_RETAINED_CHARS,
  MAX_TOOL_STREAM_RETAINED_CHARS,
  retainStreamTail,
} from '../reducers/helpers.js';
import { contentBlocksText } from '../rehydrate-history.js';
import { fmtRatioPct } from '../components/status-bar-format.js';
import {
  recordProviderResponse,
  recordProviderTextDelta,
  recordProviderThinkingDelta,
  recordStreamFlush,
  recordToolExecuted,
  recordToolProgress,
} from '../tui-memory-counters.js';
import { formatDelegateStartedText, formatDelegateSuccessText } from './subagent-history-format.js';

function canonicalStreamSegments(content: readonly ContentBlock[]): Array<{
  kind: 'assistant' | 'thinking';
  text: string;
}> {
  const segments: Array<{ kind: 'assistant' | 'thinking'; text: string }> = [];
  for (const block of content) {
    const kind =
      block.type === 'text' ? 'assistant' : block.type === 'thinking' ? 'thinking' : null;
    const text =
      block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '';
    if (!kind || !text.trim()) continue;
    const previous = segments.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else segments.push({ kind, text });
  }
  return segments;
}

/**
 * The one line of injector arithmetic worth carrying inline: what the block
 * cost, plus the context pressure when it was high enough to have shrunk the
 * budget (below that it is a constant nobody reads). Everything else — per
 * memory scores, gates, the searched query, reject buckets — lives in the
 * context panel, which keeps every run rather than only the injecting ones.
 */
function formatSageInjectionStats(run: { injectedChars: number; contextPressure: number }): string {
  const parts = [`+${run.injectedChars} chars`];
  if (run.contextPressure >= 0.65) {
    parts.push(`ctx ${fmtRatioPct(run.contextPressure)}`);
  }
  return parts.join(' · ');
}

interface ProviderEventBridgeOptions {
  events: AppProps['events'];
  agent: AppProps['agent'];
  dispatch: Dispatch<Action>;
  streamingTextRef: MutableRefObject<string>;
  streamSegmentsRef: MutableRefObject<Array<{ kind: 'assistant' | 'thinking'; text: string }>>;
  pendingDeltaRef: MutableRefObject<string>;
  flushTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  sessionGenerationRef: MutableRefObject<number>;
  activeRunGenerationRef: MutableRefObject<number>;
  assistantCommittedThisRunRef: MutableRefObject<boolean>;
  setMemoryContextMonitor: Dispatch<SetStateAction<MemoryContextMonitorState>>;
}

/** Bridges provider/tool/delegate/memory events into render-neutral TUI actions. */
export function useProviderEventBridge({
  events,
  agent,
  dispatch,
  streamingTextRef,
  streamSegmentsRef,
  pendingDeltaRef,
  flushTimerRef,
  sessionGenerationRef,
  activeRunGenerationRef,
  assistantCommittedThisRunRef,
  setMemoryContextMonitor,
}: ProviderEventBridgeOptions): void {
  // Subscribe to provider streaming events.
  useEffect(() => {
    // Throttle stream delta DISPATCHES — refs accumulate every token; React
    // state flushes on FLUSH_MS (balanced ~10fps, frugal ~6–7fps via profile).
    // Canonical output stays in provider.response / session log.
    const FLUSH_MS = tuiStreamFlushMs();
    let pendingToolStream: {
      toolUseId: string;
      name: string;
      text: string;
      startedAt: number;
    } | null = null;
    // Injector stats waiting for the tool entry they belong to. The injector
    // runs inside the tool-call pipeline, so `memory.injector_run` always
    // lands before the `tool.executed` that carries the injected block —
    // stash the numbers here and render them on the memory panel itself
    // instead of as a second, separate card saying the same thing.
    const pendingSageStats = new Map<string, string>();
    const appendStreamSegment = (kind: 'assistant' | 'thinking', text: string) => {
      const last = streamSegmentsRef.current.at(-1);
      if (last?.kind === kind) {
        last.text = retainStreamTail(last.text, text, MAX_ASSISTANT_STREAM_RETAINED_CHARS);
      } else {
        streamSegmentsRef.current.push({
          kind,
          text: retainStreamTail('', text, MAX_ASSISTANT_STREAM_RETAINED_CHARS),
        });
      }
      if (streamSegmentsRef.current.length > 8) {
        streamSegmentsRef.current.splice(0, streamSegmentsRef.current.length - 8);
      }
    };
    const flush = () => {
      if (activeRunGenerationRef.current !== sessionGenerationRef.current) {
        pendingToolStream = null;
        pendingDeltaRef.current = '';
        flushTimerRef.current = null;
        return;
      }
      if (pendingToolStream) {
        dispatch({ type: 'toolStreamAppend', ...pendingToolStream });
        pendingToolStream = null;
      }
      if (pendingDeltaRef.current) {
        dispatch({ type: 'streamDelta', delta: pendingDeltaRef.current });
        pendingDeltaRef.current = '';
      }
      recordStreamFlush();
      flushTimerRef.current = null;
    };
    const scheduleFlush = () => {
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    };
    const offDelta = events.on('provider.text_delta', (e) => {
      if (activeRunGenerationRef.current !== sessionGenerationRef.current) return;
      // Strip any bracketed-paste DCS sequences that some providers echo
      // into the stream. They are invisible in a real terminal but appear as
      // junk text if Ink's raw rendering catches them. The ESC byte is
      // matched optionally — a stripped/split ESC would otherwise leave a
      // bare `[200~` in the rendered text (same failure as the input path).
      const text = e.text.replace(/\x1b?\[200~|\x1b?\[201~/g, '');
      recordProviderTextDelta(text.length);
      streamingTextRef.current = retainStreamTail(
        streamingTextRef.current,
        text,
        MAX_ASSISTANT_STREAM_RETAINED_CHARS,
      );
      appendStreamSegment('assistant', text);
      pendingDeltaRef.current += text;
      scheduleFlush();
    });
    const offThinking = events.on('provider.thinking_delta', (e) => {
      if (activeRunGenerationRef.current !== sessionGenerationRef.current) return;
      // Reasoning/thinking deltas (Codex reasoning summaries, Anthropic
      // extended thinking, OpenAI-compatible <think> blocks). Buffered in
      // stream-order alongside assistant prose so the per-iteration flush
      // commits them as a THINKING entry BEFORE the next tool entry, and
      // the live tail mirrors whatever segment type is currently streaming.
      const text = e.text.replace(/\x1b?\[200~|\x1b?\[201~/g, '');
      recordProviderThinkingDelta(text.length);
      appendStreamSegment('thinking', text);
      pendingDeltaRef.current += text;
      scheduleFlush();
    });
    const offToolStart = events.on('tool.started', (e) => {
      dispatch({ type: 'toolStarted', id: e.id, name: e.name });
      dispatch({ type: 'leaderToolStart', name: e.name });
    });
    const offIterStart = events.on('iteration.started', () => {
      dispatch({ type: 'leaderIterStart' });
    });
    const offIterEnd = events.on('iteration.completed', () => {
      dispatch({ type: 'leaderIterEnd' });
    });
    const offToolProgress = events.on('tool.progress', (e) => {
      // Only `partial_output` becomes the live tail. Other event kinds
      // (`log`, `warning`, `metric`, `file_changed`) are deliberately not
      // rendered here — they pile up too fast and would steal screen real
      // estate from the assistant text. They still flow through EventBus
      // for observability/metrics consumers.
      if (e.event.type !== 'partial_output' || !e.event.text) return;
      recordToolProgress(e.event.text.length);
      // Coalesce tool stream paints with the same flush window as assistant
      // text — every partial_output used to force a full history re-render.
      const prev = pendingToolStream;
      if (prev && prev.toolUseId === e.id) {
        pendingToolStream = {
          ...prev,
          text: retainStreamTail(prev.text, e.event.text, MAX_TOOL_STREAM_RETAINED_CHARS),
          startedAt: prev.startedAt,
        };
      } else {
        // Different tool mid-flush: push previous immediately so order is preserved.
        if (prev) dispatch({ type: 'toolStreamAppend', ...prev });
        pendingToolStream = {
          toolUseId: e.id,
          name: e.name,
          text: e.event.text,
          startedAt: Date.now(),
        };
      }
      scheduleFlush();
    });
    const offTool = events.on('tool.executed', (e) => {
      recordToolExecuted(e.outputBytes);
      // Flush any coalesced tool stream before the completed entry lands.
      if (pendingToolStream) {
        dispatch({ type: 'toolStreamAppend', ...pendingToolStream });
        pendingToolStream = null;
      }
      // `delegate` renders its own readable start/finish lines via the
      // delegate.started / delegate.completed events below — skip the
      // generic tool entry so history doesn't also show the big JSON blob.
      if (e.name !== 'delegate') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'tool',
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: e.input,
            output: e.output,
            // SAGE-injected memory travels beside the output preview so it
            // always renders as a memory block, never as tool text.
            sageLines: e.sage,
            ...(pendingSageStats.has(e.name) ? { sageStats: pendingSageStats.get(e.name)! } : {}),
            // Real model-visible sizes — forwarded so the size chip beside
            // the tool header can show what the model paid for instead of
            // the misleading preview-byte count we used to surface.
            outputBytes: e.outputBytes,
            outputTokens: e.outputTokens,
            outputLines: e.outputLines,
          },
        });
      }
      pendingSageStats.delete(e.name);
      // Prefer the tool_use id (paired with `tool.started.id`) so parallel
      // same-name calls clear their own entry; the reducer still falls back
      // to the oldest matching name for legacy emit sites without an id.
      dispatch({ type: 'toolEnded', ...(e.id !== undefined ? { id: e.id } : {}), name: e.name });
      // Clear the live tail for this tool — the final entry is now in
      // retained history, so there is no need to keep mirroring it below.
      dispatch({ type: 'toolStreamClear', name: e.name });
      // Mirror into the leader-only counter so the AgentsMonitor's LEADER
      // row stays live even when no subagents exist.
      dispatch({ type: 'leaderToolEnd', name: e.name, ok: e.ok, durationMs: e.durationMs });
    });
    const offRetry = events.on('provider.retry', (e) => {
      const secs = (e.delayMs / 1000).toFixed(e.delayMs >= 1000 ? 1 : 2);
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `⟳ retry ${e.attempt} in ${secs}s — ${e.description}` },
      });
    });
    const offProvErr = events.on('provider.error', (e) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: e.description },
      });
    });
    // Fallback hop — the chain rotated to a working model after the primary's
    // retries were exhausted. Surface which model is now answering.
    const offFallback = events.on('provider.fallback', (e) => {
      const fallbackEvent = e as typeof e & {
        contextWindowWarning?:
          | { fromMaxContext: number; toMaxContext: number; currentTokens?: number | undefined }
          | undefined;
      };
      const contextWarning = fallbackEvent.contextWindowWarning
        ? `\n⚠ smaller context window: ${fallbackEvent.contextWindowWarning.fromMaxContext.toLocaleString('en-US')} → ${fallbackEvent.contextWindowWarning.toMaxContext.toLocaleString('en-US')} tokens${
            fallbackEvent.contextWindowWarning.currentTokens
              ? `; current request ≈ ${fallbackEvent.contextWindowWarning.currentTokens.toLocaleString('en-US')} tokens (${fmtRatioPct(fallbackEvent.contextWindowWarning.currentTokens / fallbackEvent.contextWindowWarning.toMaxContext)} of new window)`
              : ''
          }`
        : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text: `↻ rate-limited (${e.status}) — switched to ${e.to.providerId}/${e.to.model}${contextWarning}`,
        },
      });
    });
    // Explicit model switch (e.g. /model or settings)
    const offModelSwitched = events.on('provider.model_switched', (e) => {
      const from = e.from ? `${e.from.providerId}/${e.from.model}` : '';
      const to = `${e.to.providerId}/${e.to.model}`;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: from ? `🔄 Model changed: ${from} → ${to}` : `🔄 Model set to ${to}`,
        },
      });
    });
    // Fallback gate — BEFORE the chain iterates, the gate emits
    // provider.fallback_pending so the UI can show a modal with a
    // countdown and manual model selection. The overlay dispatches
    // fallbackOverlayOpen; when the user picks a model or the countdown
    // expires, app-view emits provider.fallback_choice on the EventBus
    // and the gate resolves.
    const offFallbackPending = events.on('provider.fallback_pending', (e) => {
      // Session guard — don't open the overlay for events from other sessions.
      const eventSessionId = (e as { sessionId?: unknown }).sessionId;
      if (typeof eventSessionId === 'string' && eventSessionId !== agent.ctx.session.id) return;
      const candidates = Array.isArray(e.candidates)
        ? e.candidates.map((c) => ({
            providerId: String(c.providerId ?? ''),
            model: String(c.model ?? ''),
          }))
        : [];
      dispatch({
        type: 'fallbackOverlayOpen',
        info: {
          requestId: String(e.requestId ?? ''),
          from: {
            providerId: String(e.from?.providerId ?? ''),
            model: String(e.from?.model ?? ''),
          },
          status: typeof e.status === 'number' ? e.status : 0,
          candidates,
          autoSwitchSeconds: typeof e.autoSwitchSeconds === 'number' ? e.autoSwitchSeconds : 7,
          selected: 0,
        },
      });
    });
    // Per-iteration text flush. Without this, the entire run buffers all text
    // deltas in the live tail box and dumps them into history as ONE assistant
    // entry only after `agent.run()` returns. Tool results, in contrast, land
    // in history immediately via `tool.executed` — so a multi-iteration turn
    // renders as "all tools, then a wall of text" instead of the natural
    // text → tool → text → tool interleaving that matches the actual stream.
    //
    // We hook `provider.response` (fires once per LLM call, both for
    // intermediate `tool_use` stops and the final `end_turn`), rebuild canonical
    // segments from `e.content`, and commit them in stream order. The refs are
    // display-only and may be truncated. `runBlocks` becomes purely the loop
    // driver — it no longer adds the assistant entry, since the per-iteration
    // flushes have already done so.
    const offProvResp = events.on('provider.response', (e) => {
      if (activeRunGenerationRef.current !== sessionGenerationRef.current) return;
      recordProviderResponse();
      const segments = canonicalStreamSegments(e.content ?? []);
      const fallbackText = contentBlocksText(e.content);
      streamingTextRef.current = '';
      streamSegmentsRef.current = [];
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });
      // Does this response end the turn? A `tool_use` stop means the agent
      // loop runs again, so everything committed here is mid-turn prose and
      // must not surface a `<nextsteps>` panel. The check lives at the
      // response level, not per segment: `canonicalStreamSegments` drops
      // tool_use blocks, so `text → tool_use → text` collapses into a single
      // assistant segment and the tool call is invisible downstream.
      const final = isFinalTurnStopReason(e.stopReason);
      // Commit buffered segments in stream order. Each contiguous run of the
      // same kind becomes one history entry, so a turn that streamed
      // thinking → text → tool lands as THINKING then ASSISTANT before the
      // tool entry — matching what the user saw live. When no thinking was
      // emitted the segments array is a single assistant entry, preserving
      // the original single-commit behavior.
      for (const seg of segments) {
        if (seg.text.trim()) {
          dispatch({
            type: 'addEntry',
            entry:
              seg.kind === 'assistant'
                ? { kind: 'assistant', text: seg.text, final }
                : { kind: 'thinking', text: seg.text },
          });
          // Only assistant prose counts as "the reply was shown" — a
          // thinking-only turn must not suppress the finalText recovery.
          if (seg.kind === 'assistant') assistantCommittedThisRunRef.current = true;
        }
      }
      // If streaming segments were unavailable, commit only canonical provider
      // content. Never promote the bounded display tail to retained history.
      if (segments.length === 0 && fallbackText.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text: fallbackText, final } });
        assistantCommittedThisRunRef.current = true;
      }
    });
    const offConfirmNeeded = events.on('tool.confirm_needed', (e) => {
      // Only show the ConfirmPrompt component — no duplicate history entry needed.
      // The full ConfirmPrompt with y/n/a/d keys is rendered below;
      // the history placeholder was redundant.
      dispatch({
        type: 'confirmOpen',
        info: {
          toolUseId: e.toolUseId,
          toolName: e.tool.name,
          input: e.input,
          suggestedPattern: e.suggestedPattern,
          resolve: e.resolve,
          destructive: e.riskTier === 'destructive' || e.decisionSource === 'yolo_destructive',
          boundaryReason: e.boundaryReason,
        },
      });
    });
    const offTrustPersisted = events.on('trust.persisted', (e) => {
      const icon = e.decision === 'always' ? '✓' : '✗';
      const label = e.decision === 'always' ? 'always allowed' : 'denied';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: `${icon} ${label}: ${e.tool}(${e.pattern})`,
        },
      });
    });
    // `delegate` lifecycle — a short "started" line so the wait doesn't look
    // idle, and a single success line on completion. Failures already land via
    // `subagent.task_completed` (use-subagent-events) with a compact human
    // status; printing e.summary here would double the death notice.
    const offDelegateStart = events.on('delegate.started', (e) => {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: 'magenta',
          icon: '▶',
          text: formatDelegateStartedText(e.task),
        },
      });
    });
    const offDelegateDone = events.on('delegate.completed', (e) => {
      if (!e.ok) return;
      const cost = e.costUsd && e.costUsd > 0 ? `$${e.costUsd.toFixed(4)}` : undefined;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: 'green',
          icon: '✓',
          text: formatDelegateSuccessText({
            summary: e.summary,
            iterations: e.iterations,
            toolCalls: e.toolCalls,
            durationMs: e.durationMs,
          }),
          detail: cost,
        },
      });
    });
    const offChimeraReport = events.onPattern('chimera.report_available', (_event, payload) => {
      const report = payload as {
        sessionId?: string | undefined;
        message?: string | undefined;
      };
      if (report.sessionId && report.sessionId !== agent.ctx.session.id) return;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text:
            report.message ??
            '🦂 Chimera report ready. No follow-up started; open the mailbox to inspect it.',
        },
      });
    });
    const offMemoryStale = events.on('memory.staled', (e) => {
      if (!memoryEventMatchesSession(e, agent.ctx.session.id)) return;
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `SAGE stale: ${e.memoryId} — ${e.reason}` },
      });
    });
    const offMemoryContradicted = events.on('memory.contradicted', (e) => {
      if (!memoryEventMatchesSession(e, agent.ctx.session.id)) return;
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `SAGE contradicted: ${e.memoryId}` },
      });
    });
    const offMemoryHygiene = events.on('memory.hygiene_completed', (e) => {
      if (!memoryEventMatchesSession(e, agent.ctx.session.id)) return;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: `SAGE hygiene: ${e.examined} examined, ${e.deduplicated} deduplicated, ${e.staled} stale, ${e.archived} archived.`,
        },
      });
    });
    // Use the pattern API at the workspace package boundary: the running core
    // already emits this named event, while TUI may typecheck against the last
    // built core declarations until the next full workspace build.
    const offMemoryInjector = events.onPattern('memory.injector_run', (_event, payload) => {
      const e = payload as {
        outcome: 'injected' | 'empty' | 'error';
        trigger: string;
        toolName: string;
        candidates: number;
        contextPressure: number;
        injectedChars: number;
        error?: string | undefined;
        rejected: Record<
          'duplicate' | 'belowScore' | 'alreadyVisible' | 'cooldown' | 'budget',
          number
        >;
        queryPreview?: string | undefined;
        thresholds?: { minScore: number; minImportance: number; relationFloor: number } | undefined;
        activated: Array<{
          id: string;
          kind: string;
          text: string;
          score: number;
          relationStrength: number;
          anchors: string[];
          tags: string[];
          activationReasons: string[];
          importance: number;
          confidence: number;
          freshness: number;
          persistence: string;
          metadataScore?: number | undefined;
          scoreTerms?: Array<{ label: string; value: number }> | undefined;
        }>;
        injected: Array<{ id: string }>;
        sessionId?: string | undefined;
      };
      if (!memoryEventMatchesSession(e, agent.ctx.session.id)) return;
      setMemoryContextMonitor((current) =>
        applyMemoryInjectorRun(current, e as unknown as Record<string, unknown>),
      );
      if (e.injected.length > 0) {
        pendingSageStats.set(e.toolName, formatSageInjectionStats(e));
      }
      // Only a run with an error becomes a transcript entry. A successful one
      // is already on screen as the SAGE panel under the tool result, and an
      // empty one is the healthy gates-did-their-job case; both belong in the
      // context panel, which `setMemoryContextMonitor` above keeps current.
      // Dispatching them anyway and collapsing the card to null would leave
      // an invisible entry per tool call in history — one the layout engine
      // still budgets rows for, and one retention would carry forever.
      if (!e.error) return;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'memory-activation',
          trigger: e.trigger,
          outcome: e.outcome,
          candidates: e.candidates,
          contextPressure: e.contextPressure,
          injectedChars: e.injectedChars,
          // The core event payload types declare these as REQUIRED, so the
          // `??` defaults are a stream-boundary fallback for legacy emitters
          // that omit them — not a current-build safety net.
          queryPreview: e.queryPreview ?? '',
          thresholds: e.thresholds ?? {
            minScore: DEFAULT_MIN_SCORE,
            minImportance: DEFAULT_MIN_IMPORTANCE,
            relationFloor: MIN_RELATION_STRENGTH,
          },
          activated: e.activated.map((item) => ({
            ...item,
            metadataScore: item.metadataScore ?? 0,
            scoreTerms: item.scoreTerms ?? [],
          })),
          injectedIds: e.injected.map((item) => item.id),
          rejected: e.rejected,
          ...(e.error ? { error: e.error } : {}),
        },
      });
    });
    const offMemoryContextSnapshot = events.onPattern(
      'memory.context_snapshot',
      (_event, payload) => {
        if (!memoryEventMatchesSession(payload, agent.ctx.session.id)) return;
        setMemoryContextMonitor((current) =>
          applyMemoryContextSnapshot(current, payload as Record<string, unknown>),
        );
      },
    );
    const offMemoryContextSession = events.on('session.started', (payload) => {
      // Require an explicit sessionId match — the widget-clear is destructive
      // and the permissive === undefined branch in memoryEventMatchesSession
      // would wipe the monitor for any legacy emitter that omits sessionId.
      const eventSessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof eventSessionId !== 'string' || eventSessionId !== agent.ctx.session.id) return;
      setMemoryContextMonitor(emptyMemoryContextMonitor());
      // Drop any stashed SAGE stats for tools that never reached
      // `tool.executed` (cancelled, mismatch) so they can't ride the next
      // same-name tool result with stale numbers from the prior session.
      pendingSageStats.clear();
    });
    const offMemoryLifecycle = events.onPattern('memory.*', (event, payload) => {
      if (!memoryEventMatchesSession(payload, agent.ctx.session.id)) return;
      const lifecycle = memoryLifecycleEntry(event, payload as Record<string, unknown>);
      if (!lifecycle) return;
      dispatch({ type: 'addEntry', entry: { kind: 'memory-lifecycle', ...lifecycle } });
    });
    return () => {
      // Drain coalesced paint so the last tokens aren't lost on unmount/remount.
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flush();
      offDelta();
      offThinking();
      offToolStart();
      offIterStart();
      offIterEnd();
      offToolProgress();
      offTool();
      offRetry();
      offProvErr();
      offFallback();
      offModelSwitched();
      offFallbackPending();
      offProvResp();
      offConfirmNeeded();
      offTrustPersisted();
      offDelegateStart();
      offDelegateDone();
      offChimeraReport();
      offMemoryStale();
      offMemoryContradicted();
      offMemoryHygiene();
      offMemoryInjector();
      offMemoryContextSnapshot();
      offMemoryContextSession();
      offMemoryLifecycle();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [events, agent.ctx.session.id]);
}
