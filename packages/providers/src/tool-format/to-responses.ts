/**
 * Canonical WrongStack messages/tools → OpenAI **Responses** API wire shapes.
 *
 * Used by the `openai-codex` family (ChatGPT backend). The Responses API takes
 * a flat `input` array of typed items rather than chat/completions `messages`:
 *   - user text/image     → { role:'user', content:[{type:'input_text'|'input_image', ...}] }
 *   - assistant prose      → { type:'message', role:'assistant', content:[{type:'output_text', ...}] }
 *   - assistant tool call   → { type:'function_call', call_id, name, arguments }
 *   - tool result           → { type:'function_call_output', call_id, output }
 *
 * `thinking` blocks are dropped by default: replaying them requires the opaque
 * `reasoning.encrypted_content` blob, and omitting them — plus omitting
 * function-call item ids — sidesteps the Responses reasoning/tool-call pairing
 * validation entirely.
 *
 * The Codex (ChatGPT-login) transport opts back in via `includeReasoning`. It
 * asks for `include: ['reasoning.encrypted_content']` and stores what comes
 * back on the thinking block, so it CAN replay it — and must, for two reasons
 * that both cost the user quota when skipped:
 *
 *   1. `store: false` means the backend keeps no server-side state. A reasoning
 *      model that cannot see its own previous reasoning re-derives it every
 *      turn, and those are billed reasoning tokens against a 5h/weekly window.
 *   2. The cached prefix is the input array. Replaying the same reasoning items
 *      the backend produced keeps the prefix byte-identical to what it already
 *      has cached; synthesising a different history each turn does not.
 *
 * Only complete pairs are replayed (item id + encrypted content), and only when
 * the assistant turn also produced the item that followed the reasoning — the
 * Responses API rejects a reasoning item that is not followed by its output.
 */

import type {
  ContentBlock,
  ImageBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/core/types';
import { compactToolDefinitionForWire } from '@wrongstack/core/utils';

export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

const _toolCache = new WeakMap<Tool[], ResponsesTool[]>();
const _stringifiedToolInputs = new WeakMap<Record<string, unknown>, string>();

function stringifyToolInputOnce(input: Record<string, unknown>): string {
  const hit = _stringifiedToolInputs.get(input);
  if (hit) return hit;
  const json = JSON.stringify(input);
  _stringifiedToolInputs.set(input, json);
  return json;
}

export function toolsToResponses(tools: Tool[]): ResponsesTool[] {
  const hit = _toolCache.get(tools);
  if (hit) return hit;
  const sorted = tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
  const result = sorted.map((t): ResponsesTool => {
    const compact = compactToolDefinitionForWire(t);
    return {
      type: 'function',
      name: compact.name,
      description: compact.description,
      parameters: compact.inputSchema,
      strict: false,
    };
  });
  _toolCache.set(tools, result);
  return result;
}

function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function imageUrl(b: ImageBlock): string {
  return b.source.type === 'url'
    ? (b.source.url ?? '')
    : `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data ?? ''}`;
}

/**
 * Keys under which the Codex transport stashes what it needs to replay a
 * reasoning item: the server's item id and the encrypted payload.
 *
 * Deliberately `providerMeta` and not `signature`. `signature` is echoed
 * verbatim by the Anthropic wire, so parking an OpenAI blob there would poison
 * every history that later crosses to Claude via a `/model` switch or a
 * fallback hop. `providerMeta` is stripped at that boundary by design.
 */
export const CODEX_REASONING_ID_META = 'codexReasoningId';
export const CODEX_REASONING_ENCRYPTED_META = 'codexReasoningEncrypted';

export interface ResponsesInputOptions {
  /**
   * Replay assistant reasoning items that carry both a server item id and
   * encrypted content. Off by default — only the Codex transport requests the
   * encrypted payload, and replaying a half-formed reasoning item is a 400.
   */
  includeReasoning?: boolean | undefined;
  /**
   * Emit `input_image` parts. Defaults to true; the Codex transport sets it
   * from the live catalog's `input_modalities`, which is text-only on some
   * models (gpt-5.3-codex-spark). An image sent to one of those is a 400, so
   * the choice is between losing the picture and losing the turn.
   */
  allowImages?: boolean | undefined;
}

/** The reasoning item for a thinking block, or null when it cannot be replayed. */
function reasoningItem(block: ThinkingBlock): Record<string, unknown> | null {
  const id = block.providerMeta?.[CODEX_REASONING_ID_META];
  const encrypted = block.providerMeta?.[CODEX_REASONING_ENCRYPTED_META];
  if (typeof id !== 'string' || !id || typeof encrypted !== 'string' || !encrypted) return null;
  return { type: 'reasoning', id, encrypted_content: encrypted, summary: [] };
}

export function messagesToResponsesInput(
  messages: Message[],
  opts: ResponsesInputOptions = {},
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  for (const msg of messages) {
    const blocks = normalizeContent(msg.content);

    if (msg.role === 'user') {
      // Tool results ride inside user turns in the canonical format. Emit them
      // as standalone function_call_output items first (order-independent here).
      const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');
      for (const r of toolResults) {
        out.push({
          type: 'function_call_output',
          call_id: r.tool_use_id,
          output: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
        });
      }

      const others = blocks.filter((b) => b.type !== 'tool_result');
      if (others.length > 0) {
        const content = others
          .map((b): Record<string, unknown> | null => {
            if (b.type === 'text') return { type: 'input_text', text: b.text };
            if (b.type === 'image') {
              if (opts.allowImages === false) {
                // Leave a marker rather than dropping the block outright: the
                // model would otherwise answer a question about a picture it
                // was never told existed.
                return { type: 'input_text', text: '[image omitted: model accepts text only]' };
              }
              return { type: 'input_image', detail: 'auto', image_url: imageUrl(b) };
            }
            return null;
          })
          .filter((c): c is Record<string, unknown> => c !== null);
        if (content.length > 0) out.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      // A reasoning item must be followed, in the same turn, by the item it
      // produced. An assistant message that is nothing but thinking (an
      // interrupted turn, a truncated replay) has no such follower, so its
      // reasoning is dropped rather than sent and rejected.
      const hasFollower = blocks.some(
        (b) => (b.type === 'text' && b.text.length > 0) || b.type === 'tool_use',
      );
      for (const block of blocks) {
        if (block.type === 'thinking') {
          if (!opts.includeReasoning || !hasFollower) continue;
          const item = reasoningItem(block);
          if (item) out.push(item);
          continue;
        }
        if (block.type === 'text' && block.text.length > 0) {
          out.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
            status: 'completed',
          });
        }
        if (block.type !== 'tool_use') continue;
        const u = block as ToolUseBlock;
        out.push({
          type: 'function_call',
          call_id: u.id,
          name: u.name,
          arguments: stringifyToolInputOnce(u.input ?? {}),
        });
      }
    } else if (msg.role === 'system') {
      // In-conversation system messages (compaction digests, evidence floor)
      // must not be dropped — fold them into a user turn, matching the Chat
      // Completions / Anthropic / Gemini wires. Dropping them silently loses
      // the collapsed history on the Responses API (Codex).
      const text = blocks
        .filter((b): b is TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.trim().length > 0) {
        out.push({ role: 'user', content: [{ type: 'input_text', text }] });
      }
    }
  }

  return out;
}
