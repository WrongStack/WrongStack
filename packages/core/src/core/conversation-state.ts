import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { AgentContext, TodoItem } from '../types/context.js';
import type {
  ConversationStateApi,
  ReadonlyConversationState,
  StateChange,
} from '../types/conversation-state.js';
import { computeMessageTokens } from '../utils/token-estimate.js';

// Roadmap 10A: the type surface lives in the types/conversation-state.ts leaf
// (dependency-safe for AgentContext); re-exported here for existing import paths.
export type { ConversationStateApi, ReadonlyConversationState, StateChange };

export type StateChangeHandler = (change: StateChange, state: ConversationStateApi) => void;

function hasToolResultBlock(message: Message | undefined): boolean {
  return (
    message !== undefined &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_result')
  );
}

function hasToolUseBlock(message: Message | undefined): boolean {
  return (
    message?.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_use')
  );
}

/**
 * Observable wrapper for mutable conversation state. Production code should
 * mutate messages, todos, and meta through this API so subscribers see a
 * deterministic change stream. The underlying Context arrays are still
 * exposed for read compatibility and legacy tests.
 *
 * L1-A invariant: direct mutations of `ctx.messages` / `ctx.todos` bypass
 * the observer layer. Prefer `ctx.state.appendMessage()` etc. to keep
 * subscribers in sync. The compatibility arrays exist so existing code
 * that reads `ctx.messages` directly still works — they are NOT safe for
 * external writes.
 */
export class ConversationState {
  /** Owning context; public for structural typing (Roadmap 10A). */
  readonly ctx: AgentContext;
  /** Subscribers; public for structural typing (Roadmap 10A). */
  readonly listeners = new Set<StateChangeHandler>();
  _revision = 0;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  get messages(): readonly Message[] {
    return this.ctx.messages;
  }

  get todos(): readonly TodoItem[] {
    return this.ctx.todos;
  }

  get meta(): Readonly<Record<string, unknown>> {
    return this.ctx.meta;
  }

  /** Monotonic mutation counter for consumers that need to detect rewrites. */
  get revision(): number {
    return this._revision;
  }

  /**
   * Cheap immutable snapshot. Useful for tests and for compaction passes
   * that need a stable view across an async boundary.
   *
   * Uses shallow-freeze instead of deep-freeze: only the wrapper object
   * and the three content arrays are frozen. Individual message/todo
   * objects are NOT recursively frozen — they are reconstructed via
   * spread copies and are immutable by convention. This cuts the freeze
   * count from O(n·m·d) (n=messages, m=content blocks, d=depth) to O(1).
   */
  snapshot(): ReadonlyConversationState {
    const snap = {
      messages: [...this.ctx.messages],
      todos: [...this.ctx.todos],
      meta: { ...this.ctx.meta },
    };
    Object.freeze(snap.messages);
    Object.freeze(snap.todos);
    Object.freeze(snap.meta);
    return Object.freeze(snap) as ReadonlyConversationState;
  }

  appendMessage(message: Message): void {
    // Pre-compute token estimate once at mutation time so every downstream
    // estimateMessageTokens / estimateRequestTokens call is an O(1) sum
    // instead of re-walking the content blocks on every invocation.
    if (message._estTokens === undefined) {
      message._estTokens = computeMessageTokens(message);
    }
    this.ctx.messages.splice(this.ctx.messages.length, 0, message);
    // Cap messages to prevent unbounded growth when compaction does not
    // run (provider error storms, rewinds, custom embedders). Oldest
    // messages are dropped first — the compaction digest lives at index 0
    // and is dropped with them.
    const overflow = this.overflowCount(this.ctx.messages);
    // The append is always journaled, including on the overflow path. The
    // snapshot this replaced carried the new message implicitly, inside the
    // full array it wrote; a delta does not, so omitting it here silently loses
    // exactly the messages that triggered an eviction.
    this.emit({ kind: 'message_appended', message });
    if (overflow > 0) {
      this.ctx.messages.splice(0, overflow);
      // Dropping messages may orphan a tool_use or tool_result, breaking
      // strict-provider adjacency rules. Force a repair scan on the next
      // request pipeline run.
      this.ctx.toolAdjacencyDirty = true;
      // Emit the eviction as a delta, not a snapshot. Replay splices the same
      // prefix off, so the reconstructed array still matches live state — but
      // the journal cost is the count instead of the entire surviving history.
      // That distinction is the whole ballgame: once a session reaches the cap,
      // this branch runs on *every* append, so a snapshot made the journal
      // quadratic in session length (measured: 2.1 GB of snapshots carrying
      // ~10 MB of conversation).
      this.emit({ kind: 'messages_dropped', count: overflow });
    }
  }

  /**
   * How many of the oldest messages must be dropped to satisfy both retention
   * caps — count and size (see {@link AgentContext.messageLimits}). Returns 0
   * when the history already fits, which is the overwhelmingly common case.
   *
   * The size pass reads the per-message `_estTokens` cache populated at
   * mutation time, so it is a sum over numbers rather than a re-walk of
   * content blocks.  It runs whenever the token cap is enabled; the count
   * cap determines the starting index for the sum but does not gate it.
   */
  overflowCount(arr: readonly Message[]): number {
    const { maxMessages, maxMessageTokens } = this.ctx.messageLimits;
    let drop = maxMessages > 0 ? Math.max(0, arr.length - maxMessages) : 0;
    if (maxMessageTokens <= 0) return this.protocolSafeDropCount(arr, drop);

    let total = 0;
    for (let i = drop; i < arr.length; i++) total += arr[i]?._estTokens ?? 0;
    if (total <= maxMessageTokens) return this.protocolSafeDropCount(arr, drop);
    // Walk forward dropping the oldest survivors until the remainder fits.
    // Always keep the newest message: dropping the one just appended would
    // silently discard the turn the caller is in the middle of.
    while (drop < arr.length - 1 && total > maxMessageTokens) {
      total -= arr[drop]?._estTokens ?? 0;
      drop++;
    }
    return this.protocolSafeDropCount(arr, drop);
  }

  /**
   * Front eviction must not retain a `tool_result` after evicting the
   * immediately preceding assistant `tool_use`. Long tool-heavy sessions sit
   * at the retention cap, so an unsafe boundary would create a fresh orphan on
   * nearly every append and make the request-time repair discard protocol
   * history continuously.
   *
   * Move the boundary backward to retain the complete exchange for one more
   * eviction cycle. Moving it forward would also drop non-protocol text/images
   * that may share either message. The temporary one-message cap overshoot is
   * the minimum lossless representation; once enough newer messages exist, the
   * next eviction boundary naturally moves past both halves together.
   */
  protocolSafeDropCount(arr: readonly Message[], drop: number): number {
    if (drop <= 0 || drop >= arr.length) return drop;
    return hasToolResultBlock(arr[drop]) && hasToolUseBlock(arr[drop - 1]) ? drop - 1 : drop;
  }

  /**
   * Append a content block to the trailing user message's content array.
   * Mutates only that one message (a single indexed assignment) — avoids
   * the O(n) array copy + token-cache re-walk that `replaceMessages()`
   * would do for a single-message edit. Used by the agent loop to fold
   * btw-notes / queued-mailbox blocks into the conversation.
   *
   * The block is folded only into a *user* message (preserves
   * user/assistant alternation between tool batches). Returns false when
   * there is no trailing user message to fold into — callers should
   * `appendMessage({ role: 'user', content: [block] })` instead.
   */
  appendBlockToLastUserMessage(block: ContentBlock): boolean {
    const arr = this.ctx.messages;
    const last = arr[arr.length - 1];
    if (last?.role !== 'user') return false;
    const content: ContentBlock[] =
      typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }, block]
        : [...last.content, block];
    // Replace only the trailing message object — O(1), no full-array copy.
    // Recompute the token estimate for the one changed message; everything
    // else in the array is untouched and its cache stays valid.
    const updated: Message = {
      ...last,
      content,
      _estTokens: computeMessageTokens({ ...last, content }),
    };
    arr[arr.length - 1] = updated;
    // Text/informational blocks never carry tool_use/tool_result, so
    // toolAdjacencyDirty is unaffected — no need to set it here.
    this.emit({ kind: 'message_updated', index: arr.length - 1, message: updated });
    return true;
  }

  replaceMessages(messages: Message[]): void {
    // M1 (combined with the existing _estTokens loop): single pass over the
    // replacement messages that handles per-message token estimation AND
    // tool-block detection for the adjacency-dirty flag. The previous
    // implementation did a separate `messages.some(m => m.content.some(...))`
    // walk — a second O(n·m) pass that the first loop can absorb with a
    // tiny amount of extra state. For 200 messages with a 5-block average
    // this halves the work done here.
    let hasToolBlock = false;
    for (const m of messages) {
      if (m._estTokens === undefined) {
        m._estTokens = computeMessageTokens(m);
      }
      // Cached messages still need the adjacency scan. Resume/rewind commonly
      // replaces state with messages carrying `_estTokens`; gating this scan
      // on cache misses silently skipped tool repair for exactly those paths.
      if (!hasToolBlock && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use' || b.type === 'tool_result') {
            hasToolBlock = true;
            break;
          }
        }
      }
    }

    // `replaceMessages()` is used by resume, rewind, WebUI context editing and
    // compaction. It must enforce the same safety boundary as appendMessage;
    // otherwise a large journal/context replacement bypasses retention in one
    // call and remains live until the process exits.
    const overflow = this.overflowCount(messages);
    const retained = overflow > 0 ? messages.slice(overflow) : messages;
    if (overflow > 0) this.ctx.toolAdjacencyDirty = true;

    // In-place replacement without array spread to avoid a temporary
    // allocation of 200+ elements on large compaction rewrites.
    // When messages.length > arr.length, JavaScript auto-extends the array
    // on indexed assignment (arr[i] = val where i >= arr.length sets
    // arr.length = i + 1 per ECMAScript §9.4.2.1).
    const arr = this.ctx.messages;
    if (retained.length < arr.length) {
      arr.length = retained.length;
    }
    for (let i = 0; i < retained.length; i++) {
      arr[i] = retained[i]!;
    }

    // Mark adjacency dirty when the replacement contains tool-use
    // blocks — the next request pipeline must re-check adjacency.
    // Without this, replaceMessages() can silently skip repair when
    // it introduces or modifies tool_use/tool_result pairs (e.g. test
    // setup, agent-loop content rewrite).
    if (hasToolBlock) {
      this.ctx.toolAdjacencyDirty = true;
    }

    this.emit({ kind: 'messages_replaced', messages: [...retained] });
  }

  replaceTodos(todos: TodoItem[]): void {
    // Auto-clear: when every item is completed and the list is non-empty,
    // the board has served its purpose. Treat it as a clear signal so the
    // user doesn't have to manually `/todos clear` after each task.
    const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed');
    const effective = allDone ? [] : todos;

    this.ctx.todos.length = 0;
    this.ctx.todos.splice(0, 0, ...effective);
    this.emit({
      kind: 'todos_replaced',
      todos: [...effective],
      ...(allDone ? { completedSnapshot: [...todos] } : {}),
    });
  }

  setMeta(key: string, value: unknown): void {
    this.ctx.meta[key] = value;
    this.emit({ kind: 'meta_set', key, value });
  }

  deleteMeta(key: string): void {
    if (!(key in this.ctx.meta)) return;
    delete this.ctx.meta[key];
    this.emit({ kind: 'meta_deleted', key });
  }

  clearMeta(): void {
    const keys = Object.keys(this.ctx.meta);
    if (keys.length === 0) return;
    for (const key of keys) delete this.ctx.meta[key];
    this.emit({ kind: 'meta_cleared' });
  }

  /**
   * Subscribe to mutations that go through this wrapper. Direct mutations of
   * the compatibility arrays are intentionally not observed.
   */
  onChange(listener: StateChangeHandler): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change: StateChange): void {
    this._revision++;
    for (const h of this.listeners) {
      try {
        h(change, this);
      } catch {
        // Listeners are observational only; one bad subscriber must not
        // prevent state mutation or block sibling listeners.
      }
    }
  }
}

/**
 * Convenience constructor. The wrapper holds a reference, not a copy.
 */
export function wrapAsState(ctx: AgentContext): ConversationState {
  return new ConversationState(ctx);
}
