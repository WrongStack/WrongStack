export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' | undefined };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Provider-specific opaque metadata captured from the wire response.
   * Echoed back verbatim in the next request so providers that bind
   * extra state to function calls keep working. Example: Gemini's
   * `thoughtSignature` — required for tool-use turns with thinking
   * models, otherwise the next request fails with 400 "Function call
   * is missing a thought_signature in functionCall parts".
   *
   * Keys are namespaced by intent so multiple wires can coexist:
   *   - `google.thoughtSignature` — Gemini signed-thought blob
   * Other providers can add their own keys without colliding.
   */
  providerMeta?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  /**
   * The original tool name. Useful for providers like Google Gemini that
   * need the tool name in `functionResponse.name` — the tool_use_id is
   * only a session-local identifier and is not stable across replays.
   * Always set by ToolExecutor; may be absent on manually-constructed blocks.
   */
  name?: string | undefined;
  content: string;
  is_error?: boolean | undefined;
  /**
   * Provider cache boundary. Set at request-composition time on a CLONE of the
   * trailing durable block (never on the stored message) so the conversation
   * prefix becomes an incrementally extendable cache entry. Wires that use
   * explicit markers (Anthropic) emit it; every other wire rebuilds
   * tool_result content explicitly and drops it.
   */
  cache_control?: { type: 'ephemeral' | undefined };
  /**
   * Structured tool error information. Present on error results produced
   * by the unified tool error taxonomy (tool-error-taxonomy.ts). Consumed
   * by retry logic, audit log, and observability. Stripped before sending
   * to the provider (it's an internal extension, not part of the wire format).
   */
  _toolErrorInfo?: import('./tool.js').ToolErrorInfo | undefined;
  /**
   * Structured Kanban denial details for runtime callers and observability.
   * Provider adapters deliberately serialize only the human-facing `content`.
   */
  _kanbanBoundary?:
    | (import('@wrongstack/kanban').KanbanBoundaryEvaluation & {
        boardId?: string | undefined;
        taskId?: string | undefined;
        readinessIssues?: import('@wrongstack/kanban').KanbanContractReadinessIssue[] | undefined;
      })
    | undefined;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string | undefined;
    data?: string | undefined;
    url?: string | undefined;
  };
}

/**
 * Chain-of-thought / extended-thinking content emitted by the model.
 *
 * Both Anthropic extended thinking (`{type:'thinking', thinking, signature}`)
 * and DeepSeek reasoning mode (top-level `reasoning_content` on the assistant
 * message) require this content to be echoed back verbatim on the next
 * request, otherwise the provider returns 400:
 *   - Anthropic: "The `content[].thinking` in the thinking mode must be passed back"
 *   - DeepSeek:  "The `reasoning_content` in the thinking mode must be passed back"
 *
 * `signature` is Anthropic-specific (an opaque integrity blob). DeepSeek
 * doesn't issue a signature — the field is absent for that provider.
 *
 * Per Anthropic, thinking blocks MUST appear before any text/tool_use blocks
 * in an assistant message. Stream builders preserve that order.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string | undefined;
  providerMeta?: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;

export function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === 'text';
}
export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === 'tool_use';
}
export function isToolResultBlock(b: ContentBlock): b is ToolResultBlock {
  return b.type === 'tool_result';
}
export function isImageBlock(b: ContentBlock): b is ImageBlock {
  return b.type === 'image';
}
