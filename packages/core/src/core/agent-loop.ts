/**
 * Agent loop handler — extracted from Agent class.
 * Contains runInner (the main iteration loop), checkIterationLimit,
 * compactContextIfNeeded, emitContextPct, and injectPendingBtwNotes.
 */
import type { Request, Response } from '../types/provider.js';
import type { ContentBlock, TextBlock } from '../types/blocks.js';
import { isTextBlock, isToolUseBlock } from '../types/blocks.js';
import { toWrongStackError } from '../types/errors.js';
import { estimateMessageTokens, estimateRequestTokens, getCalibrationState, recordActualUsage, type RequestTokenBreakdown } from '../utils/token-estimate.js';
import { recordUserIntentEvidence } from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { consumeAutonomousContinue } from './continue-to-next-iteration.js';
import { buildBtwBlock, consumeBtwNotes } from './btw.js';
import { buildQueuedMessagesBlock, consumeQueuedMessagesUpdate } from './queued-messages.js';
import { attachMailboxChecker } from '../mailbox-attach.js';
import { injectPendingMailboxMessages } from './mailbox-loop.js';
import { runProviderWithRetry } from './provider-runner.js';
import { requestLimitExtension } from './iteration-limit.js';
import { TOKENS } from '../kernel/tokens.js';
import type { RunController } from '../kernel/run-controller.js';
import type { RunOptions } from './context.js';
import type { RunResult, UserInputPayload } from './agent-types.js';
import type { AgentInternals } from './agent-internals.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { AgentResponseHandler } from './agent-response.js';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Extract a human-readable reason from an AbortSignal. */
export function signalAbortReason(signal: AbortSignal): string {
  const r = signal.reason;
  if (r instanceof Error) return r.message || r.name;
  if (typeof r === 'string' && r.length > 0) return r;
  return 'aborted';
}

interface LoopHandlers {
  tools: AgentToolHandler;
  response: AgentResponseHandler;
}

export interface AgentLoopHandler {
  runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult>;
}

export function createAgentLoopHandler(
  a: AgentInternals,
  handlers: LoopHandlers,
): AgentLoopHandler {
  // Mailbox checker — created once, reused every iteration. Derives
  // mailbox path from the session transcript directory. Ephemeral
  // sessions (no transcriptPath) get a no-op that returns [].
  const checkMailbox = attachMailboxChecker(a);

  /**
   * Run context window pipeline — but skip the pipeline call entirely
   * when we already know context is comfortably below the warn threshold
   * and nothing has changed since the last run. The middleware inside
   * the pipeline already short-circuits below the warn threshold with
   * a cached token count, but the *pipeline materialization* itself
   * (middleware chain walk, await plumbing, EventBus subscription setup)
   * is not free. Skipping the whole call is free.
   *
   * Safety: we only skip when the message count is unchanged AND the
   * last run was a no-op. If context grew (new messages, tool results
   * appended, tool definitions changed) the next call must re-evaluate.
   * If the last run actually fired a compaction, we must also re-run so
   * the noop-retry logic gets its delta check.
   */
  async function compactContextIfNeeded(): Promise<boolean> {
    const msgCount = a.ctx.messages.length;
    const maxContext = currentMaxContext();
    if (
      _lastCompactionMsgCount === msgCount &&
      _lastCompactionWasNoop &&
      _lastCompactionMaxContext === maxContext &&
      maxContext > 0
    ) {
      return false;
    }
    const beforeMessages = a.ctx.messages;
    const beforeMsgCount = a.ctx.messages.length;
    await a.pipelines.contextWindow.run(a.ctx);
    _lastCompactionMsgCount = a.ctx.messages.length;
    _lastCompactionMaxContext = maxContext;
    const changed =
      a.ctx.messages !== beforeMessages || a.ctx.messages.length !== beforeMsgCount;
    // Mark as noop when the cached token count is below the warn fraction.
    // The middleware's own noop-retry check (lastNoopAttempt) tracks a more
    // nuanced "tried but couldn't reduce" state — this flag is coarser: it
    // answers "should we even bother running the pipeline next time?"
    const tokens = refreshContextRequestTokenStash({ force: changed });
    const load = maxContext > 0 ? tokens / maxContext : 0;
    // 0.5 is the soft default warn threshold used by `defaultConfig`; we
    // hard-code it here to avoid a context.options lookup. The middleware
    // is the authority on the actual policy threshold — this is just a
    // fast-path heuristic for "definitely below warn" to skip the pipeline.
    _lastCompactionWasNoop = tokens > 0 && load < 0.5;
    if (changed) {
      _lastEmittedMsgCount = -1;
      _lastEmittedToolCount = -1;
      _lastEmittedMaxContext = -1;
    }
    return changed;
  }

  /** Per-(provider,model) calibration bucket so a model-switching or fleet
   *  process doesn't collapse every tokenizer onto one shared ratio. */
  const calibrationKey = (model: string = a.ctx.model): string =>
    `${a.ctx.provider?.id ?? 'unknown'}/${model}`;

  // ── System+tools overhead cache ──────────────────────────────────────────
  // The system prompt and tool definitions change rarely (only on /model,
  // mode switch, MCP connect/disconnect). Caching their combined token
  // count by reference identity avoids re-walking them on every token
  // estimation call — turning estimateRequestTokens from O(msgs+sys+tools)
  // into O(msgs) when the references are stable.
  let _cachedSysRef: unknown = null;
  let _cachedToolsRef: readonly unknown[] | null = null;
  let _cachedOverheadTokens = 0;

  function systemAndToolsOverhead(): number {
    const sysRef = a.ctx.systemPrompt;
    const toolsRef = a.ctx.tools;
    if (
      sysRef === _cachedSysRef &&
      toolsRef === _cachedToolsRef &&
      _cachedOverheadTokens > 0
    ) {
      return _cachedOverheadTokens;
    }
    const breakdown = estimateRequestTokens([], sysRef, toolsRef ?? [], calibrationKey());
    _cachedSysRef = sysRef;
    _cachedToolsRef = toolsRef;
    _cachedOverheadTokens = breakdown.systemPrompt + breakdown.tools;
    return _cachedOverheadTokens;
  }

  function stashRequestTokens(req: Request): RequestTokenBreakdown {
    const preFlight = estimateRequestTokens(
      req.messages,
      req.system,
      req.tools ?? [],
      calibrationKey(req.model),
    );

    // Stash the uncalibrated total on ctx so the middleware and the
    // context bar (emitContextPct) can read it without re-walking the
    // messages. The middleware applies its own per-(provider,model)
    // calibration ratio on read so the value it sees matches the
    // calibrated figure the compaction decision was made on.
    a.ctx.lastRequestTokens = preFlight.total;
    _lastPreFlightMsgCount = req.messages.length;
    // Track message-only tokens and populate the overhead cache so
    // subsequent incremental estimates (emitContextPct,
    // refreshContextRequestTokenStash) can skip the full walk.
    _cachedSysRef = req.system;
    _cachedToolsRef = req.tools ?? [];
    _cachedOverheadTokens = preFlight.systemPrompt + preFlight.tools;
    // Companion meta entry: the (msg, tool) count snapshot the stash
    // was computed at, so the middleware can detect when tool results
    // were appended between pre-flight and compaction and refuse the
    // stale value. See AutoCompactionMiddleware.tryStashedTokens.
    a.ctx.meta['lastRequestTokensAt'] = {
      msgCount: req.messages.length,
      toolCount: (req.tools ?? []).length,
    };

    return preFlight;
  }

  function refreshContextRequestTokenStash(opts: { force?: boolean | undefined } = {}): number {
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const stashed = a.ctx.lastRequestTokens;
    const stashedAt = a.ctx.meta?.['lastRequestTokensAt'];
    if (
      !opts.force &&
      typeof stashed === 'number' &&
      stashed > 0 &&
      typeof stashedAt === 'object' &&
      stashedAt !== null
    ) {
      const meta = stashedAt as { msgCount?: unknown; toolCount?: unknown };
      if (
        meta.msgCount === msgCount &&
        (typeof meta.toolCount !== 'number' || meta.toolCount === toolCount)
      ) {
        return stashed;
      }
    }

    const refreshed = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
    a.ctx.lastRequestTokens = refreshed;
    _lastPreFlightMsgCount = msgCount;
    a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount };
    return refreshed;
  }

  async function buildRequestWithPreflightCompaction(opts: RunOptions): Promise<{
    req: Request;
    preFlight: RequestTokenBreakdown;
  }> {
    let req = await handlers.response.buildAndRunRequestPipeline(opts);
    let preFlight = stashRequestTokens(req);

    // The new user turn may be what crosses the context threshold. Run the
    // context-window pipeline before the provider call and rebuild the request
    // if compaction rewrote ctx.messages, otherwise the oversized stale request
    // would still be sent.
    if (await compactContextIfNeeded()) {
      req = await handlers.response.buildAndRunRequestPipeline(opts);
      preFlight = stashRequestTokens(req);
    }

    return { req, preFlight };
  }

  /** Emit ctx.pct event for live context-fill bar in UIs. */
  function emitContextPct(): void {
    // In autonomous idle loops the conversation doesn't grow between
    // iterations — skip the expensive token estimation and event emission
    // when nothing has changed since the last emit.
    const msgCount = a.ctx.messages.length;
    const toolCount = (a.ctx.tools ?? []).length;
    const maxContext = currentMaxContext();
    if (
      msgCount === _lastEmittedMsgCount &&
      toolCount === _lastEmittedToolCount &&
      maxContext === _lastEmittedMaxContext &&
      maxContext > 0
    ) {
      return;
    }
    _lastEmittedMsgCount = msgCount;
    _lastEmittedToolCount = toolCount;
    _lastEmittedMaxContext = maxContext;

    // H1: the pre-flight stash is stale if tool results have been appended
    // since. Instead of re-walking the entire message array + system prompt
    // + tool defs, compute only the delta: the tokens of the newly appended
    // messages. This turns an O(n) full re-walk into O(new_messages) —
    // typically O(1-3) for tool result appends.
    if (msgCount !== _lastPreFlightMsgCount) {
      const stashed = a.ctx.lastRequestTokens;
      if (
        typeof stashed === 'number' &&
        stashed > 0 &&
        _lastPreFlightMsgCount >= 0 &&
        _lastPreFlightMsgCount < msgCount
      ) {
        // Incremental: tool results were appended, existing messages unchanged.
        const delta = estimateMessageTokens(a.ctx.messages.slice(_lastPreFlightMsgCount));
        a.ctx.lastRequestTokens = stashed + delta;
      } else {
        // Fallback: cold start or messages were replaced (compaction).
        a.ctx.lastRequestTokens =
          estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
      }
      _lastPreFlightMsgCount = msgCount;
      a.ctx.meta['lastRequestTokensAt'] = { msgCount, toolCount };
    }

    // H1: prefer the pre-flight stash so the bar and the middleware see
    // the same number. Fall back to a fresh compute only on cold start
    // (no pre-flight yet) — emitContextPct is called at the end of an
    // iteration, after the pre-flight has always run.
    let total: number;
    const stashed = a.ctx.lastRequestTokens;
    if (typeof stashed === 'number' && stashed > 0) {
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated
        ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : stashed;
    } else {
      // Cold-start fallback: compute once, then stash so the next call
      // takes the fast path above.
      const raw = estimateMessageTokens(a.ctx.messages) + systemAndToolsOverhead();
      a.ctx.lastRequestTokens = raw;
      _lastPreFlightMsgCount = msgCount;
      const cal = getCalibrationState(calibrationKey());
      total = cal.calibrated
        ? Math.round(raw * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : raw;
    }
    const rawLoad = maxContext > 0 ? total / maxContext : 0;
    const load = Math.max(0, Math.min(1, rawLoad));
    a.events.emit('ctx.pct', { sessionId: a.ctx.session.id, load, rawLoad, tokens: total, maxContext });
  }

  function currentMaxContext(): number {
    // Mirror the denominator AutoCompactionMiddleware uses: an explicit
    // effectiveMaxContext override (ctx.meta) wins, then the provider window,
    // then a safe default. This must be read live: /model, fallback, and
    // /context limit can all change it after the session starts.
    const metaLimit = a.ctx.meta?.['effectiveMaxContext'];
    const providerMax = a.ctx.provider.capabilities.maxContext;
    return typeof metaLimit === 'number' && metaLimit > 0
      ? metaLimit
      : typeof providerMax === 'number' && providerMax > 0
        ? providerMax
        : 200_000;
  }

  let _lastEmittedMsgCount = -1;
  let _lastEmittedToolCount = -1;
  let _lastEmittedMaxContext = -1;
  // H1: tracks the message count at the most recent pre-flight. emitContextPct
  // uses it to detect when tool results have been appended since the
  // pre-flight and the stash needs a restash. -1 = no pre-flight yet.
  let _lastPreFlightMsgCount = -1;
  // H3: fast-path for the context-window pipeline. When the message count
  // is unchanged since the last run AND the last run was a noop (load
  // below warn), we can skip the entire pipeline call. The middleware
  // inside the pipeline still has its own per-call caches, but the
  // pipeline materialization itself (chain walk, await plumbing) is
  // pure overhead in this case.
  let _lastCompactionMsgCount = -1;
  let _lastCompactionMaxContext = -1;
  let _lastCompactionWasNoop = false;

  /**
   * Append an informational block to the conversation, merging into the
   * trailing user message when there is one (keeps user/assistant
   * alternation intact between tool batches).
   */
  function foldBlockIntoConversation(block: TextBlock): void {
    if (!a.ctx.state.appendBlockToLastUserMessage(block)) {
      a.ctx.state.appendMessage({ role: 'user', content: [block] });
    }
  }

  /**
   * Build a canonical per-iteration fingerprint so we can detect when the
   * model repeats the same response shape iteration after iteration. The
   * fingerprint covers THREE signals, not just tool calls:
   *
   *   1. The SORTED SET of tool names (deduped) the iteration is calling.
   *      Using a set means rotating-but-similar tool names ("read" vs
   *      "read_file") still match — a k2p7 stuck on "I should re-read the
   *      file" picks different concrete names each turn but the *idea* is
   *      the same and the loop is real.
   *   2. A representative input hash from the FIRST tool call. We don't
   *      hash every call's input (k2p7 varies paths/offsets trivially to
   *      dodge a strict signature) — the first call's input is enough to
   *      tell "same idea" from "actually different".
   *   3. The concatenated text-block content, truncated to 512 chars.
   *      This catches the "assistant message repeats" variant where k2p7
   *      echoes the same prose turn after turn in autonomous-continue
   *      mode with no tool calls at all. Thinking-block text is INTENTIONALLY
   *      excluded — chain-of-thought legitimately varies per iteration,
   *      including it would defeat the detector on every legitimate run.
   *
   * Returns `'__empty__'` when the response has no text AND no tool calls
   * (e.g. a pure thinking response). The empty marker is unique enough to
   * never collide with a real fingerprint and is excluded from the loop
   * check at the call site so legitimate end-of-turn responses don't
   * false-positive.
   */
  function iterationFingerprint(blocks: ContentBlock[]): string {
    const toolUses = blocks.filter(isToolUseBlock);
    const texts = blocks.filter(isTextBlock);

    const toolNameSet = Array.from(new Set(toolUses.map((u) => u.name))).sort();
    const firstInputHash = toolUses[0]
      ? hashSmall(JSON.stringify(toolUses[0].input ?? {}))
      : '';
    const textBlob = texts
      .map((t) => t.text)
      .join('')
      .slice(0, 512);

    const hasContent = toolNameSet.length > 0 || textBlob.length > 0;
    if (!hasContent) return '__empty__';

    return [
      `tools=${toolNameSet.join('+') || '-'}`,
      `in0=${firstInputHash}`,
      `txt=${textBlob}`,
    ].join('\n');
  }

  /**
   * Tiny stable hash for short strings (the representative input + the
   * already-truncated text). 32-bit FNV-1a — collision rate is irrelevant
   * here because we only ever compare against the immediately previous
   * iteration's fingerprint, not a global set. Avoids pulling a real
   * hash function for what is effectively an equality check.
   */
  function hashSmall(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /** Fold pending /btw notes into conversation before each iteration. */
  function injectPendingBtwNotes(): void {
    const notes = consumeBtwNotes(a.ctx);
    if (notes.length === 0) return;
    foldBlockIntoConversation({ type: 'text', text: buildBtwBlock(notes) });
  }

  /**
   * Surface the host's pending-message queue (messages typed while this run
   * was busy) when it changed since the model last saw it. Informational
   * only — the queued messages still arrive later as their own user turns;
   * this just lets the model factor the backlog into in-flight decisions.
   * See {@link ./queued-messages.ts}.
   */
  function injectQueueAwareness(): void {
    const items = consumeQueuedMessagesUpdate(a.ctx);
    if (!items) return;
    foldBlockIntoConversation({ type: 'text', text: buildQueuedMessagesBlock(items) });
  }

  /**
   * Check if iteration limit reached and request extension if needed.
   */
  async function checkIterationLimit(
    iterationIndex: number,
    limit: number,
    hasHardLimit: boolean,
    currentIterations: number,
    delegateSummaries: Array<{ summary: string; ok: boolean }>,
  ): Promise<{ limit: number; exit?: RunResult | undefined }> {
    if (hasHardLimit && iterationIndex >= limit) {
      const extendBy = await requestLimitExtension({
        events: a.events,
        sessionId: a.ctx.session.id,
        currentIterations,
        currentLimit: limit,
        autoExtend: a.autoExtendLimit,
      });
      if (extendBy > 0) {
        const newLimit = limit + extendBy;
        a.logger.info(`Iteration limit extended by ${extendBy} (new limit: ${newLimit})`);
        return { limit: newLimit };
      }
      return { limit, exit: { status: 'max_iterations', iterations: currentIterations, delegateSummaries } };
    }
    return { limit };
  }

  async function runInner(
    inputPayload: UserInputPayload,
    opts: RunOptions,
    controller: RunController,
    autonomousContinue: boolean,
  ): Promise<RunResult> {
    await a.pipelines.userInput.run(inputPayload);
    recordUserIntentEvidence(a.ctx, inputPayload.text);
    a.ctx.state.appendMessage({ role: 'user', content: inputPayload.content });
    await a.ctx.session.append({
      type: 'user_input',
      ts: new Date().toISOString(),
      content: inputPayload.content,
    });
    // Drain the user_input to disk before the LLM call. Fire-and-forget
    // (matching the llm_response path in agent-response.ts) — the write
    // starts immediately so the durability window is only the disk round-
    // trip (~1-5ms), not the full tool-execution phase. The writeCheckpoint
    // below adds a second event to the buffer and schedules a 500ms deferred
    // flush, which acts as a backup if the async flush is interrupted.
    // Synchronous durability is still guaranteed at close()/checkpoint
    // boundaries for the SIGKILL-mid-tool case.
    void a.ctx.session.flush().catch(() => {
      /* best-effort — buffered write is retried at the next boundary flush */
    });

    const promptIndex = a.ctx.messages.filter((m) => m.role === 'user').length - 1;
    const preview = inputPayload.text.slice(0, 80) + (inputPayload.text.length > 80 ? '…' : '');
    await a.ctx.session.writeCheckpoint(promptIndex, preview);

    let finalText = '';
    let iterations = 0;
    const delegateSummaries: Array<{ summary: string; ok: boolean }> = [];
    let effectiveLimit = opts.maxIterations ?? a.maxIterations;
    const hasHardLimit = effectiveLimit > 0 && Number.isFinite(effectiveLimit);
    let recoveryRetries = 0;

    // ── Loop detection state ──────────────────────────────────────
    // One counter, one fingerprint. Tracks the previous iteration's
    // fingerprint (tool-name set + first tool input + text blob) and how
    // many times in a row it has matched. When the same fingerprint
    // repeats LOOP_THRESHOLD times consecutively the loop is broken with
    // a `tool.loop_detected` event and a clear finalText.
    //
    // The fingerprint covers THREE signals so the same safety valve catches
    // both k2p7 failure modes:
    //   (a) identical tool calls with identical inputs (the original
    //       tool-loop case),
    //   (b) text-only assistant-message repeats (the "echoing the same
    //       prose" case in autonomous-continue mode).
    //
    // Empty responses (pure thinking blocks, end-of-turn silence) reset
    // the streak so a real loop after a silence is still caught from
    // iteration 1. Threshold of 3 keeps the safety net tight: legitimate
    // "I'm reasoning about the same file twice" runs hit 2 at most, but
    // a stuck k2p7 hits 3 within a few seconds.
    const LOOP_THRESHOLD = 3;
    let lastToolSignature = '';
    let toolLoopCount = 0;

    const onSubagentDone = ({ summary, ok }: { summary: string; ok: boolean }) => {
      delegateSummaries.push({ summary, ok });
    };
    const offSubagentDone = a.events.on('subagent.done', onSubagentDone);

    // Build the base provider runner
    const diRunner = a.container.has(TOKENS.ProviderRunner)
      ? a.container.resolve(TOKENS.ProviderRunner)
      : null;

    const baseRunner = diRunner
      ? (ctx: typeof a.ctx, req: Request) =>
          diRunner.run({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          })
      : async (ctx: typeof a.ctx, req: Request) =>
          runProviderWithRetry({
            provider: ctx.provider, request: req, signal: controller.signal,
            ctx, events: a.events, retry: a.retry, logger: a.logger, tracer: a.tracer,
          });

    const customRunner = a.extensions.wrapProviderRunner(baseRunner);

    try {
      for (let i = 0; ; i++) {
        iterations = i + 1;
        if (controller.signal.aborted) {
          return { status: 'aborted', iterations, abortReason: signalAbortReason(controller.signal) };
        }

        // Fire-and-forget: the in-flight marker is best-effort crash-
        // recovery metadata. Don't block the iteration loop on a disk
        // write — the .catch already swallows errors, and the marker
        // just needs to land at some point during the iteration for
        // SessionRecovery.detectStale to detect a crash.
        a.ctx.session
          .writeInFlightMarker(`iteration ${i} / max ${a.maxIterations}`)
          .catch((err) => {
            (a.logger.debug ?? a.logger.warn)?.(
              `in-flight marker write failed: ${toErrorMessage(err)}`,
            );
          });

        if (autonomousContinue) {
          consumeAutonomousContinue(a.ctx);
        }

        const limitCheck = await checkIterationLimit(
          i, effectiveLimit, hasHardLimit, iterations, delegateSummaries,
        );
        effectiveLimit = limitCheck.limit;
        if (limitCheck.exit) {
          return { ...limitCheck.exit, finalText };
        }

        await a.extensions.runBeforeIteration(a.ctx, i);
        a.events.emit('iteration.started', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });

        injectPendingBtwNotes();
        injectQueueAwareness();

        // Check inter-agent mailbox for steer/btw messages from other agents.
        // Non-blocking best-effort — a broken mailbox must not stop the agent.
        const mailboxResult = await injectPendingMailboxMessages(
          checkMailbox,
          foldBlockIntoConversation,
          {
            events: {
              emit: (type, payload) => {
                a.events.emit(type as never, payload as never);
              },
            },
            logger: a.logger as never as { debug?: (...args: unknown[]) => void },
          },
        );
        // Cooperative interrupt: an operator (e.g. Fleet HQ) dropped a
        // `control:interrupt` message in our mailbox. Stop gracefully at this
        // iteration boundary — before the next LLM call — rather than killing
        // the process. Mirrors the abort-signal exit shape.
        if (mailboxResult.interrupt) {
          const reason = `interrupted: ${mailboxResult.interruptReason ?? 'operator request'}`;
          return { status: 'aborted', iterations, abortReason: reason, finalText };
        }

        // H1: compute once, share with the middleware + context bar.
        // The helper also gives auto-compaction one pre-send chance to shrink
        // a newly over-budget turn and rebuilds the request when it does.
        const { req, preFlight } = await buildRequestWithPreflightCompaction(opts);

        await a.ctx.session.append({
          type: 'llm_request',
          ts: new Date().toISOString(),
          model: req.model,
          messageCount: req.messages.length,
          estimatedInputTokens: preFlight.total,
          toolCount: (req.tools ?? []).length,
        }).catch(() => { /* best-effort */ });

        let res: Response;
        try {
          res = await customRunner(a.ctx, req);
          // Derive the calibrated estimate from the pre-flight result instead
          // of calling estimateRequestTokensCalibrated() which would re-walk
          // the same messages/system/tools arrays. The calibration ratio is
          // the same per-(provider,model) bucket — applying it to the raw
          // total is equivalent to the per-component rounding in the full
          // calibrated function.
          const key = calibrationKey(req.model);
          const cal = getCalibrationState(key);
          const calibratedTotal = cal.calibrated
            ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
            : preFlight.total;
          recordActualUsage(res.usage.input, calibratedTotal, key);
          recoveryRetries = 0;
        } catch (err) {
          if (controller.signal.aborted) {
            a.events.emit('error', { sessionId: a.ctx.session.id, err: toError(err), phase: 'provider' });
            return { status: 'aborted', iterations, error: toWrongStackError(err, 'AGENT_ABORTED'), abortReason: signalAbortReason(controller.signal) };
          }

          const extDecision = await a.extensions.runOnError(a.ctx, err, 'provider', i);
          if (extDecision) {
            if (extDecision.action === 'fail') {
              a.events.emit('error', { sessionId: a.ctx.session.id, err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
            }
            if (extDecision.action === 'continue') {
              await a.extensions.runAfterIteration(a.ctx, i);
              continue;
            }
            if (extDecision.action === 'retry') {
              recoveryRetries++;
              if (recoveryRetries > 2) {
                a.events.emit('error', { sessionId: a.ctx.session.id, err: toError(err), phase: 'provider' });
                return { status: 'failed', iterations, error: toWrongStackError(err), delegateSummaries };
              }
              if (extDecision.model) a.ctx.model = extDecision.model;
              a.logger.info('Extension requested retry; retrying turn');
              continue;
            }
          }

          const recovered = await a.errorHandler.recover(err, a.ctx);
          if (!recovered || recovered.action === 'fail') {
            a.events.emit('error', { sessionId: a.ctx.session.id, err: toError(err), phase: 'provider' });
            return {
              status: 'failed', iterations,
              error: toWrongStackError(recovered?.error ?? err),
              delegateSummaries,
            };
          }
          if (recovered.action === 'retry') {
            recoveryRetries++;
            if (recoveryRetries > 2) {
              a.events.emit('error', { sessionId: a.ctx.session.id, err: toError(err), phase: 'provider' });
              return { status: 'failed', iterations, error: toWrongStackError(err) };
            }
            if (recovered.model) a.ctx.model = recovered.model;
            a.logger.info(`Recovered provider error via ${recovered.reason}; retrying turn`);
            continue;
          }
          recoveryRetries = 0;
          res = recovered.response;
        }

        const responseResult = await handlers.response.processResponse(res, req);
        if (responseResult.aborted) {
          return { status: 'aborted', iterations, finalText: responseResult.finalText, delegateSummaries, abortReason: signalAbortReason(controller.signal) };
        }
        if (responseResult.done) {
          return { status: 'done', iterations, finalText: responseResult.finalText, delegateSummaries };
        }

        finalText = responseResult.finalText;

        const toolUses = res.content.filter(isToolUseBlock);

        // ── Loop detection (runs UNCONDITIONALLY — not just when tool calls are present) ──
        // Models with weak instruction-following (k2p7, etc.) can enter tight
        // loops in two ways, and the same fingerprint covers both:
        //   (a) tool loop: the same tool gets called with the same input
        //       over and over (the original failure mode the strict
        //       fingerprint was built for);
        //   (b) message loop: the assistant echoes the same prose turn
        //       after turn with no tool calls at all — most often seen in
        //       autonomous-continue mode where the run keeps looping on a
        //       stuck directive.
        // The fingerprint also catches mixed-shape repeats (same tool + same
        // text). The check is *above* the no-tool-uses early-return so
        // message loops get caught too. Empty responses (pure thinking
        // blocks, end-of-turn silence) reset the streak so a real loop
        // after a silence is still caught from iteration 1.
        const sig = iterationFingerprint(res.content);
        if (sig !== '__empty__') {
          if (sig === lastToolSignature) {
            toolLoopCount++;
          } else {
            lastToolSignature = sig;
            toolLoopCount = 1;
          }
          if (toolLoopCount >= LOOP_THRESHOLD) {
            const names = toolUses.map((t) => t.name).join(', ');
            const hasText = res.content.some(isTextBlock);
            const kind: 'tool' | 'message' | 'mixed' =
              toolUses.length > 0 && hasText
                ? 'mixed'
                : toolUses.length > 0
                  ? 'tool'
                  : 'message';
            const detail =
              kind === 'tool'
                ? `"${names}" called with effectively identical inputs ${toolLoopCount} times in a row`
                : kind === 'mixed'
                  ? `"${names}" + same text repeated ${toolLoopCount} times in a row`
                  : `same assistant text repeated ${toolLoopCount} times in a row`;
            a.logger.warn(
              `Loop detected: ${detail} — stopping to prevent infinite loop.`,
            );
            a.events.emit('tool.loop_detected', {
              sessionId: a.ctx.session.id,
              ctx: a.ctx,
              tools: names,
              repeatCount: toolLoopCount,
              iteration: i,
              kind,
            });
            const summary =
              kind === 'message'
                ? `[Loop detected: same assistant message repeated ${toolLoopCount}× — stopping to prevent infinite repetition.]`
                : `[Loop detected: ${detail} — stopping to prevent infinite repetition.]`;
            return {
              status: 'max_iterations',
              iterations,
              finalText: finalText || summary,
              delegateSummaries,
            };
          }
        } else {
          // Empty iteration: reset the streak so a real-loop after a silence
          // is still caught from iteration 1.
          lastToolSignature = '';
          toolLoopCount = 0;
        }

        if (toolUses.length === 0) {
          await compactContextIfNeeded();
          emitContextPct();
          a.events.emit('iteration.completed', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });
          if (autonomousContinue && responseResult.directive === 'continue') {
            await a.extensions.runAfterIteration(a.ctx, i);
            continue;
          }
          if (autonomousContinue && responseResult.directive === 'stop') {
            return { status: 'done', iterations, finalText, delegateSummaries };
          }
          return { status: 'done', iterations, finalText, delegateSummaries };
        }

        // Wrap tool execution so an abort mid-tool surfaces as 'aborted'
        // rather than AGENT_RUN_FAILED in the outer agent.run() catch block.
        try {
          await handlers.tools.executeTools(toolUses);
        } catch (toolErr) {
          if (controller.signal.aborted) {
            return { status: 'aborted', iterations, finalText, delegateSummaries, abortReason: signalAbortReason(controller.signal) };
          }
          throw toolErr;
        }

        if (autonomousContinue && consumeAutonomousContinue(a.ctx)) {
          await compactContextIfNeeded();
          emitContextPct();
          a.events.emit('iteration.completed', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });
          await a.extensions.runAfterIteration(a.ctx, i);
          continue;
        }

        await compactContextIfNeeded();
        emitContextPct();
        a.events.emit('iteration.completed', { sessionId: a.ctx.session.id, ctx: a.ctx, index: i });
        await a.extensions.runAfterIteration(a.ctx, i);

        if (autonomousContinue && responseResult.directive === 'continue') {
          continue;
        }
        if (autonomousContinue && responseResult.directive === 'stop') {
          return { status: 'done', iterations, finalText, delegateSummaries };
        }
      }
    } finally {
      offSubagentDone();
      const reason: 'clean' | 'aborted' = controller.signal.aborted ? 'aborted' : 'clean';
      await a.ctx.session
        .clearInFlightMarker(reason)
        .catch((err) => {
          (a.logger.debug ?? a.logger.warn)?.(
            `in-flight marker clear failed: ${toErrorMessage(err)}`,
          );
        });
    }
  }

  return { runInner };
}
