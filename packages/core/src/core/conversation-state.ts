import type { Message } from '../types/messages.js';
import { computeMessageTokens } from '../utils/token-estimate.js';
import type { Context, TodoItem } from './context.js';

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
export type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  | { kind: 'todos_replaced'; todos: readonly TodoItem[] }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };

export type StateChangeHandler = (change: StateChange, state: ConversationState) => void;

export interface ReadonlyConversationState {
  readonly messages: readonly Message[];
  readonly todos: readonly TodoItem[];
  readonly meta: Readonly<Record<string, unknown>>;
}

export class ConversationState {
  private readonly ctx: Context;
  private readonly listeners = new Set<StateChangeHandler>();

  constructor(ctx: Context) {
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
    this.emit({ kind: 'message_appended', message });
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
      if (!hasToolBlock && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use' || b.type === 'tool_result') {
            hasToolBlock = true;
            break;
          }
        }
      }
    }
    // In-place replacement without array spread to avoid a temporary
    // allocation of 200+ elements on large compaction rewrites.
    // When messages.length > arr.length, JavaScript auto-extends the array
    // on indexed assignment (arr[i] = val where i >= arr.length sets
    // arr.length = i + 1 per ECMAScript §9.4.2.1).
    const arr = this.ctx.messages;
    if (messages.length < arr.length) {
      arr.length = messages.length;
    }
    for (let i = 0; i < messages.length; i++) {
      arr[i] = messages[i]!;
    }

    // Mark adjacency dirty when the replacement contains tool-use
    // blocks — the next request pipeline must re-check adjacency.
    // Without this, replaceMessages() can silently skip repair when
    // it introduces or modifies tool_use/tool_result pairs (e.g. test
    // setup, agent-loop content rewrite).
    if (hasToolBlock) {
      this.ctx.toolAdjacencyDirty = true;
    }

    this.emit({ kind: 'messages_replaced', messages: [...messages] });
  }

  replaceTodos(todos: TodoItem[]): void {
    // Auto-clear: when every item is completed and the list is non-empty,
    // the board has served its purpose. Treat it as a clear signal so the
    // user doesn't have to manually `/todos clear` after each task.
    const allDone = todos.length > 0 && todos.every((t) => t.status === 'completed');
    const effective = allDone ? [] : todos;

    this.ctx.todos.length = 0;
    this.ctx.todos.splice(0, 0, ...effective);
    this.emit({ kind: 'todos_replaced', todos: [...effective] });
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

  private emit(change: StateChange): void {
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
export function wrapAsState(ctx: Context): ConversationState {
  return new ConversationState(ctx);
}
