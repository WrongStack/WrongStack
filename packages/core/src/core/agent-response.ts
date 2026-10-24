/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */

import {
  type ContentBlock,
  isTextBlock,
  isVolatileSystemBlock,
  type TextBlock,
} from '@wrongstack/contracts/types/blocks';
import { LIVE_CONTEXT_MARKER } from '@wrongstack/contracts/types/live-context';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider, Request, Response } from '@wrongstack/contracts/types/provider';
import { deriveCachePrefixKey } from '../utils/cache-key.js';
import {
  buildCompletedWorkLedgerBlock,
  buildConversationContinuityBlock,
  buildMissionAnchorBlock,
  markAssistantReferencedEvidence,
} from '../utils/context-evidence.js';
import {
  bindRequestHistoryVersion,
  contextHistoryVersion,
} from '../utils/context-history-version.js';
import { toErrorMessage } from '../utils/error.js';
import { hasMeaningfulContent, repairToolUseAdjacency } from '../utils/message-invariants.js';
import type { AgentInternals } from './agent-internals.js';
import { recordAgentContext } from './agent-owned-context.js';
import { refreshAgentToolSurface } from './agent-tool-surface.js';
import { type RunOptions, resolveEventSessionId } from './context.js';
import { bindRequestPromptBasis, captureRequestPromptBasis } from './context-usage-anchor.js';
import { type ContinueDirective, parseContinueDirective } from './continue-to-next-iteration.js';
import { buildLiveNextStepsGateBlock, hasLeaderNextStepsPolicy } from './next-steps-gate.js';
import { maybeRequireNextSteps, readNextStepsMode } from './next-steps-required.js';
import { maybeAppendPendingNextSteps } from './next-steps-slot.js';
import { RequestContextReplay } from './request-context-replay.js';
import { bindRequestConversation } from './request-conversation-binding.js';
import {
  buildMemoryEvidenceBlocks,
  captureRequestLayout,
  liveTailEntriesOf,
} from './request-layout-capture.js';
import { bindRequestProvider } from './request-provider-binding.js';
import { requestScopedEntries } from './request-scoped-context.js';
import { SYSTEM_BLOCK_SOURCE } from './system-prompt-blocks.js';

export { buildLiveNextStepsGateBlock } from './next-steps-gate.js';

interface ProcessResponseResult {
  finalText: string;
  aborted: boolean;
  done: boolean;
  directive?: ContinueDirective | undefined;
}

export interface AgentResponseHandler {
  buildAndRunRequestPipeline(opts: RunOptions): Promise<{ request: Request; provider: Provider }>;
  processResponse(
    raw: Response,
    req: Request,
    requestProvider?: Provider,
  ): Promise<ProcessResponseResult>;
}

/** `ctx.meta` latch: the last model reroute surfaced for this context. */
const MODEL_REROUTE_META_KEY = 'lastModelReroute';

/**
 * Provenance tags whose content legitimately changes between system-prompt
 * rebuilds (plan progress, plugin contributors, glossary refresh). On the wire
 * every system block precedes the conversation, so churn in any of them
 * invalidates the provider's cached message prefix. These blocks are therefore
 * lifted out of the wire `system` and re-sent in the live-context tail after
 * the deep cache boundary instead (see `composeRequestMessages`).
 */
const EPOCH_VOLATILE_SOURCES: ReadonlySet<string> = new Set([
  'plan',
  'contributor',
  'glossary',
  'peers',
]);

interface PromptEpochPartition {
  /** Byte-stable prefix blocks that stay in the wire `system`. */
  stable: TextBlock[];
  /** Marker-free copies of the epoch-volatile blocks, re-homed to the tail. */
  tail: TextBlock[];
  /** Provenance of each `tail` block, index-aligned (the copies carry no tag). */
  tailSources: string[];
  /** Stable interpretation for automatic-cache providers retaining old live snapshots. */
  automatic: TextBlock[];
}

/**
 * Split one frozen prompt epoch into its cache-stable prefix and its
 * epoch-volatile tail. Cached by epoch array identity so the split (and the
 * sha-256 in `deriveCachePrefixKey` keyed off `stable`) runs once per epoch,
 * not once per request. Untagged blocks (embedder-supplied prompts) are
 * treated as stable — that preserves their current wire position.
 */
const promptEpochPartitions = new WeakMap<readonly TextBlock[], PromptEpochPartition>();

function partitionPromptEpoch(prompt: readonly TextBlock[]): PromptEpochPartition {
  const cached = promptEpochPartitions.get(prompt);
  if (cached) return cached;
  const stable: TextBlock[] = [];
  const tail: TextBlock[] = [];
  const tailSources: string[] = [];
  for (const block of prompt) {
    const source = SYSTEM_BLOCK_SOURCE.get(block);
    if (source && EPOCH_VOLATILE_SOURCES.has(source)) {
      // Fresh, marker-free copy: a cache_control marker on a churning tail
      // block would become the request's deepest breakpoint and re-create
      // exactly the per-request cache-write churn this split removes.
      tail.push({ type: 'text', text: block.text });
      tailSources.push(source);
    } else {
      stable.push(block);
    }
  }
  // The interpretation rules never change; send them in the cached prefix
  // once, keeping only the marker and live values at the per-request tail.
  stable.push(LIVE_CONTEXT_INSTRUCTIONS);
  const automatic = [...stable, LIVE_CONTEXT_REPLAY_RULE];
  const partition = { stable, tail, tailSources, automatic };
  promptEpochPartitions.set(prompt, partition);
  return partition;
}

/**
 * The marker stays beside live values. Its fixed interpretation lives in the
 * stable system prefix so it need not be repeated after every tool result.
 */
const LIVE_CONTEXT_HEADER: TextBlock = {
  type: 'text',
  text: LIVE_CONTEXT_MARKER,
};
const LIVE_CONTEXT_INSTRUCTIONS: TextBlock = {
  type: 'text',
  text: 'After [live_context], the blocks contain live session state: active plan, glossary, completed-work ledger, leader mission anchor, conversation continuity, response gates and memory evidence. They are steering context, not a new user message. Where they conflict with the conversation, newer conversation turns win.',
};
const LIVE_CONTEXT_REPLAY_RULE: TextBlock = {
  type: 'text',
  text: 'Only the latest [live_context] snapshot describes current live state; it replaces older snapshots.',
};

/**
 * `<nextsteps>` blocks in past assistant turns are a client affordance: the
 * surface parses and renders them the moment the turn ends, and a chosen
 * suggestion comes back as a fresh user message (the continue-intent resolver
 * keeps its own parsed store for bare "continue"). Re-sending the raw block to
 * the provider on every later request is pure token weight, and stale
 * suggestions can read as still-pending work. Strip them from the REQUEST copy
 * of the history only — the durable log keeps them for resume and rendering.
 *
 * Cached per message object, so each message is scanned once per session and
 * every request reuses the identical stripped clone (stable bytes AND stable
 * identities keep provider prefix caches and token-estimate caches warm).
 */
// The completion marker alternative comes first and the block's opening tag
// refuses it: `<nextsteps\b` alone matches `<nextsteps-complete/>` and would
// swallow everything up to a later block's close tag.
const NEXT_STEPS_BLOCK_RE =
  /<nextsteps-complete\s*\/>[ \t]*\n?|<nextsteps\b(?!-complete)[^>]*>[\s\S]*?<\/nextsteps>[ \t]*\n?/gi;
const NEXT_STEPS_STRIPPED_PLACEHOLDER = '[nextsteps suggestions were delivered to the user]';
const strippedNextStepsCache = new WeakMap<Message, Message>();

function stripDeliveredNextSteps(history: readonly Message[]): readonly Message[] {
  let out: Message[] | null = null;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i] as Message;
    const replaced = stripNextStepsFromMessage(msg);
    if (out === null && replaced !== msg) out = history.slice(0, i);
    if (out !== null) out.push(replaced);
  }
  return out ?? history;
}

function stripNextStepsFromMessage(msg: Message): Message {
  if (msg.role !== 'assistant') return msg;
  const cached = strippedNextStepsCache.get(msg);
  if (cached) return cached;
  const hasTag =
    typeof msg.content === 'string'
      ? msg.content.includes('<nextsteps')
      : msg.content.some((b) => b.type === 'text' && b.text.includes('<nextsteps'));
  if (!hasTag) {
    strippedNextStepsCache.set(msg, msg);
    return msg;
  }
  let clone: Message;
  if (typeof msg.content === 'string') {
    const text = msg.content.replace(NEXT_STEPS_BLOCK_RE, '').trimEnd();
    clone = { ...msg, content: text.length > 0 ? text : NEXT_STEPS_STRIPPED_PLACEHOLDER };
  } else {
    const blocks = msg.content
      .map((b) =>
        b.type === 'text' && b.text.includes('<nextsteps')
          ? { ...b, text: b.text.replace(NEXT_STEPS_BLOCK_RE, '').trimEnd() }
          : b,
      )
      // A block that was ONLY the nextsteps tag becomes empty — drop it;
      // Anthropic rejects empty text blocks on the wire.
      .filter((b) => b.type !== 'text' || b.text.trim().length > 0);
    clone = {
      ...msg,
      content:
        blocks.length > 0 ? blocks : [{ type: 'text', text: NEXT_STEPS_STRIPPED_PLACEHOLDER }],
    };
  }
  strippedNextStepsCache.set(msg, clone);
  return clone;
}

/**
 * The message position that closed the previous request's cached prefix. Held
 * by identity AND index so a compaction (which rewrites history and voids the
 * cache anyway) is detected and the stale mark simply skipped.
 */
interface CacheBoundaryRef {
  message: Message;
  index: number;
}

/**
 * Re-mark an already-transmitted message as a cache boundary.
 *
 * Returns undefined when the message cannot carry one, leaving it untouched:
 * - string content is passed through verbatim by wires that accept it
 *   (`presets/anthropic.ts` returns `m.content` as-is), so promoting it to a
 *   block array here would change the very prefix bytes this marker exists to
 *   preserve, and
 * - only text and tool_result blocks may carry `cache_control`; any other tail
 *   (image/tool_use/thinking) goes unmarked, with the stable system markers
 *   still anchoring the prompt prefix.
 */
function markCacheBoundary(msg: Message): Message | undefined {
  if (typeof msg.content === 'string') {
    return {
      ...msg,
      content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }],
    };
  }
  const blocks: ContentBlock[] = msg.content.slice();
  const boundary = blocks[blocks.length - 1];
  if (!boundary || (boundary.type !== 'text' && boundary.type !== 'tool_result')) return undefined;
  blocks[blocks.length - 1] = { ...boundary, cache_control: { type: 'ephemeral' } };
  return { ...msg, content: blocks };
}

/**
 * Compose the request's message array without mutating the durable history:
 *
 * - pins the provider cache boundary (`cache_control`) on the last durable
 *   content block, so the whole conversation becomes an incrementally
 *   extendable cached prefix,
 * - re-marks the position that closed the PREVIOUS request, so the provider
 *   looks that cache entry up explicitly instead of relying on its bounded
 *   automatic look-back (Anthropic scans only ~20 blocks back from a
 *   breakpoint; a turn with many parallel tool calls can exceed that and miss
 *   the entry entirely), and
 * - appends the live-context tail AFTER the deepest boundary, so per-request
 *   churn (todos, ledger, retrieved memory, plan progress) can never
 *   invalidate it.
 *
 * Returns null when there is no history to attach to — the caller then falls
 * back to carrying the tail in `system` (degenerate embedder flows).
 */
function composeRequestMessages(
  history: readonly Message[],
  tail: TextBlock[],
  previous: CacheBoundaryRef | undefined,
): { messages: Message[]; boundary: CacheBoundaryRef | undefined } | null {
  if (history.length === 0) return null;
  const out = history.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx] as Message;

  if (previous && previous.index < lastIdx && history[previous.index] === previous.message) {
    const marked = markCacheBoundary(previous.message);
    if (marked) out[previous.index] = marked;
  }

  const blocks: ContentBlock[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content.slice();
  const tailBlock = blocks[blocks.length - 1];
  const marked = tailBlock && (tailBlock.type === 'text' || tailBlock.type === 'tool_result');
  if (marked) {
    blocks[blocks.length - 1] = { ...tailBlock, cache_control: { type: 'ephemeral' } };
  }
  // Only hand back a boundary the wire can actually mark; an unmarkable tail
  // would otherwise be re-offered (and re-rejected) on every later request.
  const boundary = marked ? { message: last, index: lastIdx } : undefined;

  if (tail.length === 0 || last.role !== 'user') {
    out[lastIdx] = { ...last, content: blocks };
    if (tail.length > 0) out.push({ role: 'user', content: [LIVE_CONTEXT_HEADER, ...tail] });
    return { messages: out, boundary };
  }
  // Ride the trailing user message itself — mirrors the existing "/btw note
  // appended onto the trailing tool-result message" shape every wire already
  // handles, and avoids consecutive-user-turn quirks on strict backends.
  out[lastIdx] = { ...last, content: [...blocks, LIVE_CONTEXT_HEADER, ...tail] };
  return { messages: out, boundary };
}

/**
 * Append blocks to the live-context tail of an already composed request.
 *
 * The tail rides the trailing user message after the cache boundary
 * ({@link composeRequestMessages}); when it has no header yet (no tail blocks
 * this request) one is added. Blocks are copied marker-free: a `cache_control`
 * on a churning tail block would become the request's deepest breakpoint and
 * recreate exactly the per-request cache-write churn this avoids.
 */
function appendLiveContextTail(
  messages: readonly Message[],
  blocks: readonly TextBlock[],
): Message[] {
  const fresh = blocks.map((block): TextBlock => ({ type: 'text', text: block.text }));
  const out = messages.slice();
  const last = out[out.length - 1];
  if (last?.role !== 'user') {
    out.push({ role: 'user', content: [LIVE_CONTEXT_HEADER, ...fresh] });
    return out;
  }
  const content: ContentBlock[] =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content.slice();
  const hasHeader = content.some(
    (block) => block.type === 'text' && block.text === LIVE_CONTEXT_HEADER.text,
  );
  out[out.length - 1] = {
    ...last,
    content: hasHeader ? [...content, ...fresh] : [...content, LIVE_CONTEXT_HEADER, ...fresh],
  };
  return out;
}

export function createAgentResponseHandler(
  a: AgentInternals,
  refreshSystemPrompt = false,
): AgentResponseHandler {
  // Each assigned prompt array is one explicit cache epoch. Freeze it at the
  // first request boundary so turn-time code cannot silently invalidate the
  // provider prefix by pushing/replacing blocks in place. Lifecycle actions
  // such as a mode switch may assign a new array, which becomes a new epoch.
  const stabilizedPromptEpochs = new WeakSet<TextBlock[]>();

  /** Where the previous request closed its cached prefix; see `composeRequestMessages`. */
  let previousBoundary: CacheBoundaryRef | undefined;
  const contextReplay = new RequestContextReplay();

  function stabilizePromptEpoch(): void {
    const prompt = a.ctx.systemPrompt;
    if (stabilizedPromptEpochs.has(prompt)) return;
    for (const block of prompt) {
      if (block.cache_control) Object.freeze(block.cache_control);
      Object.freeze(block);
    }
    Object.freeze(prompt);
    stabilizedPromptEpochs.add(prompt);
  }

  async function buildAndRunRequestPipeline(
    opts: RunOptions,
  ): Promise<{ request: Request; provider: Provider }> {
    await a.ctx.waitForModelTransition();
    const provider = a.ctx.provider;
    const model = opts.model ?? a.ctx.model;
    // Resolve provider caps before rendering prompt tool conditions. Rebuild
    // only when the direct surface changed (MCP, policy or provider switch).
    await refreshAgentToolSurface(a, provider, model, refreshSystemPrompt);
    // Only scan for tool-use adjacency issues when tool content has been
    // added since the last scan. Pure text responses and iterations without
    // tool calls don't introduce new adjacency problems — skipping the O(n)
    // message-array walk saves ~1-3ms per iteration on large contexts.
    if (a.ctx.toolAdjacencyDirty) {
      const repaired = repairToolUseAdjacency(a.ctx.messages);
      a.ctx.toolAdjacencyDirty = false;
      if (repaired.report.changed) {
        a.ctx.state.replaceMessages(repaired.messages);
        a.events.emit('context.repaired', {
          sessionId: resolveEventSessionId(a.ctx),
          ctx: a.ctx,
          ...repaired.report,
        });
        a.logger.warn(
          `Repaired context tool adjacency: removed ${repaired.report.removedToolUses.length} tool_use block(s), ` +
            `${repaired.report.removedToolResults.length} tool_result block(s), ` +
            `${repaired.report.removedMessages} empty message(s)` +
            formatAdjacencyRepairIds(
              repaired.report.removedToolUses,
              repaired.report.removedToolResults,
            ),
        );
      }
    }
    const historyVersion = contextHistoryVersion(a.ctx);
    const promptBasis = captureRequestPromptBasis(a.ctx);
    stabilizePromptEpoch();
    // Cache-stable wire `system` vs the live-context tail. The tail (epoch
    // plan/contributor/glossary blocks + the per-request ledger, continuity,
    // next-steps gate, and memory evidence) changes between requests, so it
    // rides AFTER the conversation and its deep cache boundary — never in
    // `system`, where every byte precedes the messages and any churn would
    // invalidate the provider's cached conversation prefix.
    const appendOnlyContext = provider.capabilities.cacheControl === 'auto';
    const partition = partitionPromptEpoch(a.ctx.systemPrompt);
    const stableSystem = appendOnlyContext ? partition.automatic : partition.stable;
    const epochTail = partition.tail;
    const volatileLedger = buildCompletedWorkLedgerBlock(a.ctx);
    const missionAnchor = buildMissionAnchorBlock(a.ctx);
    const continuity = buildConversationContinuityBlock(a.ctx);
    const liveNextStepsGate = buildLiveNextStepsGateBlock(
      a.ctx,
      readNextStepsMode(a),
      hasLeaderNextStepsPolicy(a.ctx.systemPrompt),
    );
    const liveTailEntries = liveTailEntriesOf({
      epochTail,
      epochSources: partition.tailSources,
      ledger: volatileLedger,
      missionAnchor,
      continuity,
      nextsteps: liveNextStepsGate,
      memoryEvidence: buildMemoryEvidenceBlocks(a.ctx),
    });
    const liveContextTail = liveTailEntries.map((entry) => entry.block);
    // Request-scoped blocks (raw mail) ride behind every cache boundary and are
    // never replayed: sent once, then gone without rewriting anything.
    const scopedEntries = requestScopedEntries(a.ctx);
    const scopedBlocks = scopedEntries.map((entry) => entry.block);
    const explicitTail = [...liveContextTail, ...scopedBlocks];
    const requestHistory = stripDeliveredNextSteps(a.ctx.messages);
    const composed = appendOnlyContext
      ? { messages: requestHistory.slice(), boundary: undefined }
      : composeRequestMessages(requestHistory, explicitTail, previousBoundary);
    if (composed) previousBoundary = composed.boundary;
    const composedMessages = composed?.messages ?? null;
    // No history to attach to → legacy placement (tail appended to system).
    const system = composedMessages
      ? stableSystem
      : explicitTail.length > 0
        ? [...stableSystem, ...explicitTail]
        : stableSystem;
    const conversationThreadId = a.ctx.activeRunSessionId ?? a.ctx.session?.id;
    const owningSessionId = a.ctx.meta?.['sessionId'];
    const conversationSessionId =
      typeof owningSessionId === 'string' && owningSessionId.length > 0
        ? owningSessionId
        : conversationThreadId;
    // The conversation's direct surface — Scout narrows it — resolved live so a
    // tool registered mid-run (an MCP server connecting) is offered at once.
    const providerTools = a.ctx.tools;
    const baseReq: Request = {
      model,
      system,
      messages: composedMessages ?? (requestHistory as Message[]),
      tools: providerTools,
      // `maxTokens` is deliberately NOT set here. The provider adapter
      // resolves the ceiling from the catalog entry for the model in
      // `req.model`, which is the only source that stays correct across a
      // `/model` switch, a fallback hop, or a subagent on a model-matrix
      // entry — `provider.capabilities` is resolved once, for the model the
      // session booted on, and pinning it here would override the accurate
      // per-request value with a stale one. Callers that genuinely want a
      // smaller response (one-shot LLM helpers, compaction, the brain) still
      // set `maxTokens` on their own Request and keep priority over the
      // catalog.
      // Provider-agnostic cache-partition key from the STABLE part of the
      // prompt epoch. Wires that support prompt caching (OpenAI
      // `prompt_cache_key`) read it; the config `ttl` is merged over this by
      // the ModelRuntime middleware. Keyed off the stable partition, not the
      // full epoch — a glossary/plan refresh must not re-route the cache
      // partition when the actual prefix bytes did not change.
      cache: {
        key: deriveCachePrefixKey(stableSystem, providerTools),
        sessionId: conversationSessionId,
        threadId: conversationThreadId,
      },
    };
    // Bind BEFORE the pipeline runs: the request pipeline is shared by every
    // conversation in the process, and its payload carries no session, so a
    // middleware asking "what did THIS conversation configure" has nowhere
    // else to look. Both bindings are re-applied to the pipeline's result
    // because middleware conventionally returns a copy.
    // Request construction is also used by lightweight embedders and focused
    // tests before a transcript writer exists. Unlike event emission, that
    // must remain best-effort: OpenCode Go falls back to its provider-local
    // affinity id when there is no active conversation yet.
    bindRequestConversation(baseReq, {
      meta: a.ctx.meta,
      sessionId: conversationSessionId,
    });
    bindRequestProvider(baseReq, provider);
    let request = await a.pipelines.request.run(baseReq);
    const volatile = request.system?.filter(isVolatileSystemBlock) ?? [];
    if (!appendOnlyContext && composedMessages && volatile.length > 0) {
      // Explicit-breakpoint wires cache tools → system → messages, so a block a
      // middleware appended to `system` (it arrives after the base request was
      // composed) would sit before the whole conversation and invalidate it on
      // every change. Re-home it behind the deepest boundary with the rest of
      // the live-context tail instead; it still reaches the model.
      request = {
        ...request,
        system: request.system?.filter((block) => !isVolatileSystemBlock(block)),
        messages: appendLiveContextTail(request.messages, volatile),
      };
    }
    let replayed: Message[] | undefined;
    if (appendOnlyContext) {
      // Include middleware's volatile system blocks in the same replay. They
      // arrive after base request composition, so adapter-only relocation
      // would still remove the previous request's final cache endpoint.
      replayed = contextReplay.compose(
        request.messages,
        [...liveContextTail, ...volatile],
        provider,
        JSON.stringify([
          request.cache?.sessionId ?? conversationSessionId,
          request.cache?.threadId ?? conversationThreadId,
          request.model,
        ]),
      );
      request = {
        ...request,
        system: request.system?.filter((block) => !isVolatileSystemBlock(block)),
        // Appended after the replay, never into it: the next request's prefix
        // still matches up to here and the raw mail is not kept.
        messages:
          scopedBlocks.length > 0 ? appendLiveContextTail(replayed, scopedBlocks) : replayed,
      };
    }
    bindRequestConversation(request, {
      meta: a.ctx.meta,
      sessionId: conversationSessionId,
    });
    bindRequestProvider(request, provider);
    bindRequestHistoryVersion(request, historyVersion);
    bindRequestPromptBasis(request, promptBasis);
    captureRequestLayout(request, provider, liveTailEntries, volatile, requestHistory, {
      durableMessages: a.ctx.messages,
      ephemeral: scopedEntries,
      replayed,
    });
    return { request, provider };
  }

  async function processResponse(
    raw: Response,
    req: Request,
    requestProvider: Provider = a.ctx.provider,
  ): Promise<ProcessResponseResult> {
    const sessionWriter = a.ctx.activeRunSessionWriter ?? a.ctx.session;
    let res = raw;
    res = await a.pipelines.response.run(res);
    // Fold in any `<nextsteps>` block parked by the `nextsteps` tool before the
    // response is observed by anyone. This single point feeds the event, the
    // session journal, the conversation history, and `finalText` at once, so
    // tool-produced suggestions travel the same path as model-typed ones.
    res = maybeAppendPendingNextSteps(a.ctx, res);
    // `autonomy.nextSteps: 'required'`: a finished turn with neither a block
    // nor the completion marker is asked once more, before anyone observes it.
    res = await maybeRequireNextSteps(a, res, req, requestProvider);
    a.events.emit('provider.response', {
      sessionId: resolveEventSessionId(a.ctx),
      ctx: a.ctx,
      model: req.model,
      content: res.content,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    // Once per change, not per request: every request of a rerouted account
    // is rerouted, and a notice each time would bury the conversation. A
    // response from the requested model clears the latch.
    // Ancillary: a context without `meta` (embedders, partial test contexts)
    // must still process the response, just without the latch.
    const rerouteMeta = a.ctx.meta as Record<string, unknown> | undefined;
    const rerouteKey = res.rerouted ? `${res.rerouted.requested}\u0000${res.rerouted.served}` : '';
    if (rerouteKey !== (rerouteMeta?.[MODEL_REROUTE_META_KEY] ?? '')) {
      if (rerouteMeta) rerouteMeta[MODEL_REROUTE_META_KEY] = rerouteKey;
      if (res.rerouted) {
        a.events.emit('provider.model_rerouted', {
          sessionId: resolveEventSessionId(a.ctx),
          providerId: requestProvider.id,
          ...res.rerouted,
          timestamp: Date.now(),
        });
      }
    }
    a.ctx.tokenCounter.account(res.usage, req.model, requestProvider.id);
    if (res.agentContext) recordAgentContext(a.ctx, res.agentContext);

    // Issue #271: never append or persist a semantically empty assistant
    // response (e.g. a stream interrupted before the first meaningful delta,
    // which the response builders represent as a single empty text block).
    // Strict providers reject empty assistant turns on the next request, and
    // once journaled, the malformed turn survived every repair path. Partial
    // text, tool calls, and thinking content remain meaningful and are kept.
    if (hasMeaningfulContent(res.content)) {
      // Persist the semantic provider response before its exact-state
      // projection. The conversation journal drains independently, so state
      // mutation first can race `message_appended` ahead of `llm_response`.
      await sessionWriter.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: res.content,
        stopReason: res.stopReason,
        usage: res.usage,
        // Stamp the routed identity alongside the usage it produced. Both are
        // already resolved here (they are what tokenCounter.account was just
        // handed), and without them the journal's only token record is
        // unattributable — see the `model`/`provider` docs on SessionEvent.
        model: req.model,
        provider: requestProvider.id,
      });
      a.ctx.state.appendMessage({ role: 'assistant', content: res.content });
      // If the assistant emitted tool_use blocks, mark the message adjacency
      // as potentially needing repair before the next provider request.
      if (!a.ctx.toolAdjacencyDirty) {
        for (const block of res.content) {
          if (block.type === 'tool_use') {
            a.ctx.toolAdjacencyDirty = true;
            break;
          }
        }
      }
      // Tool execution is a side-effect boundary: ensure the response containing
      // its tool_use blocks has reached the session writer before any tool runs.
      // FileSessionWriter keeps failed batches queued for retry; alternate
      // writers may reject, which is logged without masking the provider result.
      try {
        await a.ctx.flushConversationJournal();
        await sessionWriter.flush();
      } catch (err) {
        (a.logger.debug ?? a.logger.warn)?.(`LLM response flush failed: ${toErrorMessage(err)}`);
      }
    } else {
      a.logger.warn('Empty assistant response — not appended to context or session', {
        model: req.model,
        stopReason: res.stopReason,
        aborted: a.ctx.signal.aborted,
      });
    }

    if (a.ctx.signal.aborted) {
      // M3: collect into an array and join at the end. `finalText += block.text`
      // is O(n²) on V8 for many concatenations because each `+=` may allocate
      // a new backing string. For a typical 4-block response this is moot,
      // but the streaming-text path concatenates the *full* response in chunks
      // — and long autonomous loops with verbose reasoning can hit dozens of
      // chunks, making the cost visible. `Array.push` + single `join('')` is
      // amortized O(n).
      const parts: string[] = [];
      for (const block of res.content) {
        if (isTextBlock(block)) parts.push(block.text);
      }
      return { finalText: parts.join(''), aborted: true, done: false };
    }

    const parts: string[] = [];
    const streamed = requestProvider.capabilities.streaming;
    for (const block of res.content) {
      if (isTextBlock(block)) {
        const rendered = await a.pipelines.assistantOutput.run(block);
        parts.push(rendered.text);
        if (!streamed) a.renderer?.write(rendered);
      }
    }
    const finalText = parts.join('');
    markAssistantReferencedEvidence(a.ctx, finalText);

    let directive: ContinueDirective = 'none';
    if (finalText) {
      directive = parseContinueDirective(finalText);
    }

    return { finalText, aborted: false, done: false, directive };
  }

  return { buildAndRunRequestPipeline, processResponse };
}

/** Keep repair telemetry actionable without turning a damaged large context into a log flood. */
function formatAdjacencyRepairIds(toolUses: string[], toolResults: string[]): string {
  const ids = [...new Set([...toolUses, ...toolResults])].slice(0, 8);
  return ids.length > 0
    ? `; affected tool ids: ${ids.join(', ')}${toolUses.length + toolResults.length > ids.length ? ', …' : ''}`
    : '';
}
