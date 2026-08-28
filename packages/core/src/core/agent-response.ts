/**
 * Response processing handler — extracted from Agent class.
 * Handles provider response pipeline, event emission, session
 * persistence, text rendering, and autonomous continuation parsing.
 */

import { type ContentBlock, isTextBlock, type TextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request, Response } from '../types/provider.js';
import { deriveCachePrefixKey } from '../utils/cache-key.js';
import {
  buildCompletedWorkLedgerBlock,
  buildConversationContinuityBlock,
  markAssistantReferencedEvidence,
} from '../utils/context-evidence.js';
import { toErrorMessage } from '../utils/error.js';
import { formatMemoryEvidenceBlock } from '../utils/memory-evidence-fence.js';
import { hasMeaningfulContent, repairToolUseAdjacency } from '../utils/message-invariants.js';
import { formatTodoForModel, hasKanbanBoundTodos } from '../utils/todos-format.js';
import type { AgentInternals } from './agent-internals.js';
import { type Context, type RunOptions, resolveEventSessionId } from './context.js';
import { type ContinueDirective, parseContinueDirective } from './continue-to-next-iteration.js';
import { maybeAppendPendingNextSteps } from './next-steps-slot.js';
import { bindRequestConversation } from './request-conversation-binding.js';
import { bindRequestProvider } from './request-provider-binding.js';
import { SYSTEM_BLOCK_SOURCE } from './system-prompt-blocks.js';

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

const MAX_TODO_SNAPSHOT_ITEMS = 10;
const MAX_TODO_SNAPSHOT_CONTENT = 180;

/**
 * Build the leader-only, per-request decision gate for `<nextsteps>`.
 *
 * The base system prompt is intentionally frozen for provider caching, while
 * todos change during tool execution. Keeping this block volatile makes the
 * final-response contract follow the live todo state on every iteration.
 */
export function buildLiveNextStepsGateBlock(
  ctx: Pick<Context, 'agentId' | 'todos'> & { tools?: readonly { name: string }[] | undefined },
): TextBlock | undefined {
  if (ctx.agentId !== 'leader') return undefined;

  const openTodos = ctx.todos.filter(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );

  if (openTodos.length === 0) {
    // The opt-in `nextsteps` tool is a second way to satisfy branch 1. Mention
    // it only when it is actually registered, so a request without the tool
    // never carries a line pointing at something the model cannot call.
    const toolRoute = ctx.tools?.some((t) => t.name === 'nextsteps')
      ? [
          'Calling the `nextsteps` tool with the same items satisfies branch 1 as well; if you both call it and write the block, the block wins.',
        ]
      : [];
    return {
      type: 'text',
      text: [
        '[nextsteps_gate]',
        'Authoritative live state for this request: open todos = 0.',
        'On the final response, you MUST take exactly one branch:',
        '1. If at least one genuinely useful follow-on action exists, include a balanced <nextsteps> block containing 1-4 exact prompt messages that can be submitted back to you through the current TUI or WebUI input.',
        'Every item must ask the agent to perform work. Never put a human-only chore or an instruction addressed to the user inside <nextsteps>; natural-language agent-directed imperatives are valid and need not be shell commands.',
        ...toolRoute,
        '2. If no useful follow-on action truly exists, omit <nextsteps> and explicitly tell the user in normal prose that no further steps are needed for this task.',
        'Silently omitting both is invalid. Do not decide by chance, tone, or response length, and do not invent filler suggestions.',
        '[/nextsteps_gate]',
      ].join('\n'),
    };
  }

  const todoSnapshot = openTodos.slice(0, MAX_TODO_SNAPSHOT_ITEMS).map((todo) => {
    const normalized = todo.content.replace(/\s+/g, ' ').trim();
    const content =
      normalized.length > MAX_TODO_SNAPSHOT_CONTENT
        ? `${normalized.slice(0, MAX_TODO_SNAPSHOT_CONTENT - 1)}…`
        : normalized;
    // Carry the Kanban binding: this snapshot is the model's live view of the
    // list, and a row stripped of its ids cannot be echoed back intact.
    return formatTodoForModel({ ...todo, content });
  });
  const omitted = openTodos.length - todoSnapshot.length;
  if (omitted > 0) todoSnapshot.push(`- …and ${omitted} more open todo(s)`);
  const todoReconciliation = ctx.tools?.some((tool) => tool.name === 'todo')
    ? [
        'Before ending the turn, you MUST call the `todo` tool with the complete current list to reconcile actual progress: finished items completed, exactly one actively worked item in_progress, and untouched items pending. A prose claim that work is done does not update the Todo/Kanban state.',
        ...(hasKanbanBoundTodos(openTodos)
          ? [
              'Rows below carry a <kanban board/task> binding. Pass those exact ids back as `kanbanBoardId`/`kanbanTaskId` on every row you resend; a row that arrives without its binding is not applied to its card.',
            ]
          : []),
      ]
    : [];

  return {
    type: 'text',
    text: [
      '[nextsteps_gate]',
      `Authoritative live state for this request: open todos = ${openTodos.length}.`,
      'You MUST omit <nextsteps> entirely while these todos remain open. Continue or finish the tracked work; do not propose unrelated follow-on work.',
      ...todoReconciliation,
      'Open todo snapshot:',
      ...todoSnapshot,
      '[/nextsteps_gate]',
    ].join('\n'),
  };
}

const MAX_MEMORY_EVIDENCE_CHARS = 12_000;

/**
 * Render memory retrieval as volatile provider evidence, not conversation
 * history. Keeping it after the stable base prompt preserves cache reuse while
 * making the provenance boundary explicit to the model.
 */
function buildMemoryEvidenceBlocks(ctx: Pick<Context, 'memoryEvidence'>): TextBlock[] {
  const blocks: TextBlock[] = [];
  let remaining = MAX_MEMORY_EVIDENCE_CHARS;
  for (const entry of ctx.memoryEvidence) {
    if (remaining <= 0) break;
    const text = entry.text.trim();
    if (!text) continue;
    const bounded = text.slice(0, remaining);
    remaining -= bounded.length;
    // `formatMemoryEvidenceBlock` owns the fence and neutralizes the delimiter
    // inside the body — memory text is attacker-influenceable, and a literal
    // `[/memory_evidence]` in it would otherwise close the block early and
    // leave the rest as unfenced live-context text.
    blocks.push({ type: 'text', text: formatMemoryEvidenceBlock(entry.source, bounded) });
  }
  return blocks;
}

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
  for (const block of prompt) {
    const source = SYSTEM_BLOCK_SOURCE.get(block);
    if (source && EPOCH_VOLATILE_SOURCES.has(source)) {
      // Fresh, marker-free copy: a cache_control marker on a churning tail
      // block would become the request's deepest breakpoint and re-create
      // exactly the per-request cache-write churn this split removes.
      tail.push({ type: 'text', text: block.text });
    } else {
      stable.push(block);
    }
  }
  const partition = { stable, tail };
  promptEpochPartitions.set(prompt, partition);
  return partition;
}

/**
 * Constant preamble for the live-context tail. Must stay byte-identical across
 * requests: it sits immediately after the deep cache boundary, so any
 * variation would be re-tokenized (though never cached) on every request.
 */
const LIVE_CONTEXT_HEADER: TextBlock = {
  type: 'text',
  text:
    '[live_context]\n' +
    'The blocks below are live session state (active plan, glossary, completed-work ledger, conversation continuity, response gates, memory evidence) re-sent with every request. They are steering context, not a new user message. Where they conflict with the conversation, newer conversation turns win.',
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
const NEXT_STEPS_BLOCK_RE = /<nextsteps\b[^>]*>[\s\S]*?<\/nextsteps>[ \t]*\n?/gi;
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
  if (typeof msg.content === 'string') return undefined;
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

export function createAgentResponseHandler(a: AgentInternals): AgentResponseHandler {
  // Each assigned prompt array is one explicit cache epoch. Freeze it at the
  // first request boundary so turn-time code cannot silently invalidate the
  // provider prefix by pushing/replacing blocks in place. Lifecycle actions
  // such as a mode switch may assign a new array, which becomes a new epoch.
  const stabilizedPromptEpochs = new WeakSet<TextBlock[]>();

  /** Where the previous request closed its cached prefix; see `composeRequestMessages`. */
  let previousBoundary: CacheBoundaryRef | undefined;

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
    stabilizePromptEpoch();
    // Cache-stable wire `system` vs the live-context tail. The tail (epoch
    // plan/contributor/glossary blocks + the per-request ledger, continuity,
    // next-steps gate, and memory evidence) changes between requests, so it
    // rides AFTER the conversation and its deep cache boundary — never in
    // `system`, where every byte precedes the messages and any churn would
    // invalidate the provider's cached conversation prefix.
    const { stable: stableSystem, tail: epochTail } = partitionPromptEpoch(a.ctx.systemPrompt);
    const volatileLedger = buildCompletedWorkLedgerBlock(a.ctx);
    const continuity = buildConversationContinuityBlock(a.ctx);
    const liveNextStepsGate = buildLiveNextStepsGateBlock(a.ctx);
    const memoryEvidence = buildMemoryEvidenceBlocks(a.ctx);
    const liveContextTail = [
      ...epochTail,
      volatileLedger,
      continuity,
      liveNextStepsGate,
      ...memoryEvidence,
    ].filter((block): block is TextBlock => block !== undefined);
    const requestHistory = stripDeliveredNextSteps(a.ctx.messages);
    const composed = composeRequestMessages(requestHistory, liveContextTail, previousBoundary);
    if (composed) previousBoundary = composed.boundary;
    const composedMessages = composed?.messages ?? null;
    // No history to attach to → legacy placement (tail appended to system).
    const system = composedMessages
      ? stableSystem
      : liveContextTail.length > 0
        ? [...stableSystem, ...liveContextTail]
        : stableSystem;
    // A picker/WebUI switch can still be building a provider while
    // auto-continue prepares the next iteration. Wait immediately before
    // capturing the request identity so that iteration cannot retain the old
    // model by racing the switch.
    await a.ctx.waitForModelTransition();
    // Capture provider and model as one request identity. A live /model switch
    // may replace ctx.provider while the async request pipeline or provider
    // call is pending; this request must still finish under the identity it
    // started with.
    const provider = a.ctx.provider;
    const baseReq: Request = {
      model: opts.model ?? a.ctx.model,
      system,
      messages: composedMessages ?? (requestHistory as Message[]),
      tools: a.tools.listForProvider(),
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
      cache: { key: deriveCachePrefixKey(stableSystem) },
    };
    // Bind BEFORE the pipeline runs: the request pipeline is shared by every
    // conversation in the process, and its payload carries no session, so a
    // middleware asking "what did THIS conversation configure" has nowhere
    // else to look. Both bindings are re-applied to the pipeline's result
    // because middleware conventionally returns a copy.
    bindRequestConversation(baseReq, a.ctx);
    bindRequestProvider(baseReq, provider);
    const request = await a.pipelines.request.run(baseReq);
    bindRequestConversation(request, a.ctx);
    bindRequestProvider(request, provider);
    return { request, provider };
  }

  async function processResponse(
    raw: Response,
    req: Request,
    requestProvider: Provider = a.ctx.provider,
  ): Promise<ProcessResponseResult> {
    let res = raw;
    res = await a.pipelines.response.run(res);
    // Fold in any `<nextsteps>` block parked by the `nextsteps` tool before the
    // response is observed by anyone. This single point feeds the event, the
    // session journal, the conversation history, and `finalText` at once, so
    // tool-produced suggestions travel the same path as model-typed ones.
    res = maybeAppendPendingNextSteps(a.ctx, res);
    a.events.emit('provider.response', {
      sessionId: resolveEventSessionId(a.ctx),
      ctx: a.ctx,
      model: req.model,
      content: res.content,
      usage: res.usage,
      stopReason: res.stopReason,
    });
    a.ctx.tokenCounter.account(res.usage, req.model, requestProvider.id);

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
      await a.ctx.session.append({
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
        await a.ctx.session.flush();
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
