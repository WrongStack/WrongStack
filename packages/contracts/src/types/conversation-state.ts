/**
 * Conversation-state type leaf (Roadmap 10A).
 *
 * Dependency-leaf module: imports ONLY from sibling `types/*` modules. The
 * concrete `ConversationState` class stays in `core/conversation-state.ts`
 * (it has a runtime dep on `utils/token-estimate.js`); this leaf carries its
 * TYPE surface so `AgentContext` (types/context.ts) can declare
 * `state: ConversationStateApi` without importing the class module — the
 * remaining CYCLE-12 back-edge (`types/tool.ts` et al. → `core/context.ts`)
 * needs exactly this to flip.
 *
 * The class satisfies `ConversationStateApi` structurally; tsc enforces the
 * compatibility on every build of core (the class re-exports these types for
 * existing import paths).
 */
import type { ContentBlock } from './blocks.js';
import type { TodoItem } from './context.js';
import type { Message } from './messages.js';

export type StateChange =
  | { kind: 'message_appended'; message: Message }
  | { kind: 'messages_replaced'; messages: readonly Message[] }
  /** The oldest `count` messages were evicted; see the `messages_dropped` SessionEvent. */
  | { kind: 'messages_dropped'; count: number }
  | { kind: 'message_updated'; index: number; message: Message }
  | {
      kind: 'todos_replaced';
      todos: readonly TodoItem[];
      /**
       * Final all-completed snapshot when the tactical list auto-clears.
       * Observational mirrors use this to move cards to Done instead of
       * interpreting the empty active list as "the work vanished".
       */
      completedSnapshot?: readonly TodoItem[] | undefined;
    }
  | { kind: 'meta_set'; key: string; value: unknown }
  | { kind: 'meta_deleted'; key: string }
  | { kind: 'meta_cleared' };

export interface ReadonlyConversationState {
  readonly messages: readonly Message[];
  readonly todos: readonly TodoItem[];
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Structural API of the ConversationState wrapper — the COMPLETE instance
 * surface of the concrete class in `core/conversation-state.ts` (Roadmap
 * 10A). The class satisfies this interface structurally (it holds no
 * private instance members), which makes `AgentContext.state` assignable
 * both to the API and from the class — the property that lets the
 * CYCLE-12 back-edges flip without importing the class module.
 */
export interface ConversationStateApi {
  readonly messages: readonly Message[];
  readonly todos: readonly TodoItem[];
  readonly meta: Readonly<Record<string, unknown>>;
  /** Monotonic mutation counter for consumers that need to detect rewrites. */
  readonly revision: number;
  /** Cheap O(1)-freeze immutable snapshot (see class JSDoc for semantics). */
  snapshot(): ReadonlyConversationState;
  appendMessage(message: Message): void;
  /**
   * Append a content block to the trailing user message's content array.
   * Returns false when there is no trailing user message to fold into.
   */
  appendBlockToLastUserMessage(block: ContentBlock): boolean;
  replaceMessages(messages: Message[]): void;
  replaceTodos(todos: TodoItem[]): void;
  setMeta(key: string, value: unknown): void;
  deleteMeta(key: string): void;
  clearMeta(): void;
  /**
   * Subscribe to mutations that go through this wrapper. Direct mutations of
   * the compatibility arrays are intentionally not observed. Returns an
   * unsubscribe function.
   */
  onChange(listener: (change: StateChange, state: ConversationStateApi) => void): () => void;
  // ── Full-surface members (Roadmap 10A close-out) ────────────────────────
  // The class previously kept these private, sealing it nominally. They are
  // public on the class now; mirrored here so the API covers the complete
  // instance surface required for class→API structural assignability.
  /** Owning context the wrapper reads/mutates. */
  readonly ctx: import('./context.js').AgentContext;
  /**
   * Registered change subscribers. The concrete class and this leaf both
   * type the handler parameter identically (`state: ConversationStateApi`),
   * so the class's Set is assignable in both directions without the class
   * importing anything from this leaf — and without variance escapes.
   */
  listeners: Set<(change: StateChange, state: ConversationStateApi) => void>;
  /** Backing mutation counter behind the `revision` getter. */
  _revision: number;
  /** Retention-cap overflow computation (see class JSDoc). */
  overflowCount(arr: readonly Message[]): number;
  /** Protocol-safe front-eviction boundary (see class JSDoc). */
  protocolSafeDropCount(arr: readonly Message[], drop: number): number;
  /** Notify subscribers of a mutation and bump the revision. */
  emit(change: StateChange): void;
}
