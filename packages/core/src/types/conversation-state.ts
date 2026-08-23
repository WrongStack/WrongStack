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
 * Structural API of the ConversationState wrapper. The concrete class in
 * `core/conversation-state.ts` satisfies this interface; consumers that only
 * read/mutate through the wrapper can depend on this type instead of the
 * class module. `state` is passed to handlers as the API type — the class
 * instance is structurally assignable.
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
}
