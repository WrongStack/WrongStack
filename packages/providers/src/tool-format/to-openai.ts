import { createHash } from 'node:crypto';
import type {
  ContentBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/contracts/types';
import { documentAsText } from '@wrongstack/contracts/types';
import {
  compactToolDefinitionForWire,
  SCHEMA_DESCRIPTION_MAX_CHARS,
  TOOL_DESCRIPTION_MAX_CHARS,
} from '@wrongstack/core/utils';
import { documentInputFallback, imageInputFallback } from '../media-input-policy.js';
import type { ReasoningEchoField } from '../reasoning-echo-support.js';

export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * WeakMap cache keyed by the Tool[] array reference and a content fingerprint so
 * in-place tool array or schema mutations invalidate the cached wire declarations.
 */
const _cache = new WeakMap<Tool[], { fingerprint: string; result: OpenAIToolSchema[] }>();

/** OpenAI rejects `tool_calls[].id` / `tool_call_id` longer than this. */
const MAX_TOOL_CALL_ID_LENGTH = 40;

/**
 * Keep a tool-call id within the Chat Completions limit. Ids minted by other
 * wires can be longer (older Gemini sessions used `<tool name>_<hex>`), which
 * 400'd the whole request after a `/model` switch. The mapping is a pure
 * function of the id, so an assistant `tool_calls[].id` and its matching
 * `tool_call_id` always rewrite identically; ids already within the limit
 * pass through untouched.
 */
function wireToolCallId(id: string): string {
  if (id.length <= MAX_TOOL_CALL_ID_LENGTH) return id;
  return `call_${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

export function toolsToOpenAI(tools: Tool[]): OpenAIToolSchema[] {
  const fingerprint = JSON.stringify(
    tools.map((tool) => [tool.name, tool.description, tool.inputSchema]),
  );
  const hit = _cache.get(tools);
  if (hit?.fingerprint === fingerprint) return hit.result;
  const sorted = tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
  const result = sorted.map((t) => {
    const compact = compactToolDefinitionForWire(t, {
      descriptionMaxChars: TOOL_DESCRIPTION_MAX_CHARS,
      schemaDescriptionMaxChars: SCHEMA_DESCRIPTION_MAX_CHARS,
    });
    return {
      type: 'function' as const,
      function: {
        name: compact.name,
        description: compact.description,
        parameters: compact.inputSchema,
      },
    };
  });
  _cache.set(tools, { fingerprint, result });
  return result;
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContent[] | null | undefined;
  tool_calls?: OpenAIToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  /**
   * DeepSeek (and other OpenAI-compatible thinking-mode models) require the
   * previous assistant's chain-of-thought to be echoed back on the next
   * request as a top-level `reasoning_content` field on the assistant
   * message — NOT inside individual tool_calls. Without it DeepSeek
   * returns 400 "reasoning_content in the thinking mode must be passed
   * back to the API". Not universal: see `ConvertOptions.reasoningEchoField`.
   */
  reasoning_content?: string | undefined;
  /** Cerebras' name for the same echo (it rejects `reasoning_content`). */
  reasoning?: string | undefined;
}

export interface OpenAIContent {
  type: 'text' | 'image_url' | 'file';
  text?: string | undefined;
  image_url?: { url: string | undefined };
  /** A PDF: `file_data` is a `data:application/pdf;base64,` URL. */
  file?: { filename: string; file_data: string };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ConvertOptions {
  flattenContentToString?: boolean | undefined;
  /** Emit native image parts. False flattens images to a text marker. */
  allowImages?: boolean | undefined;
  /** Emit native PDF parts. False uses the document's extracted text. */
  allowDocuments?: boolean | undefined;
  /** Emit remote image URLs. Defaults to true. */
  allowImageUrls?: boolean | undefined;
  stripCacheControl?: boolean | undefined;
  systemAsMessage?: boolean | undefined;
  /**
   * What to write as the assistant message's `content` field when the
   * message has tool_calls but no prose. Two values:
   *
   *   - `'empty_string'` (default): writes `content: ''`. This is the
   *     OpenAI 2024-2025 wire-format contract. Vanilla OpenAI, K2P7,
   *     strict Mistral / OpenRouter / DeepSeek proxies all reject
   *     requests where `content` is missing or `null` on a tool_call
   *     assistant message.
   *
   *   - `'null'`: writes `content: null` explicitly. Some older or
   *     permissive proxies (e.g. certain vLLM builds, local llama.cpp
   *     servers) prefer this. Set this only if a specific provider
   *     rejects the empty-string form.
   *
   * The default is `'empty_string'` (NOT undefined) because omitting
   * `content` entirely (the pre-2024 behaviour) breaks too many
   * providers to be the safe default in 2025. Callers that need the
   * old behaviour can opt in with `emptyToolCallContent: 'null'`.
   */
  emptyToolCallContent?: 'null' | 'empty_string' | undefined;
  /**
   * The assistant-message field that echoes prior reasoning back. Defaults to
   * `reasoning_content` (DeepSeek/Kimi require it); Cerebras rejects that name
   * and takes `reasoning`; `omit` drops the echo for endpoints that take
   * neither. See `reasoning-echo-support.ts`.
   */
  reasoningEchoField?: ReasoningEchoField | undefined;
}

export function messagesToOpenAI(
  system: TextBlock[] | undefined,
  messages: Message[],
  opts: ConvertOptions = {},
): OpenAIMessage[] {
  // Default to `'empty_string'` for the assistant content field on
  // tool-call-only messages. See ConvertOptions.emptyToolCallContent
  // for the rationale. Callers can opt back into the pre-2024
  // behaviour with `emptyToolCallContent: 'null'`.
  const emptyContentMode: 'null' | 'empty_string' = opts.emptyToolCallContent ?? 'empty_string';
  const echoField: ReasoningEchoField = opts.reasoningEchoField ?? 'reasoning_content';
  const out: OpenAIMessage[] = [];

  if (system && system.length > 0) {
    const sysText = system.map((b) => b.text).join('\n\n');
    if (opts.systemAsMessage) {
      out.push({ role: 'user', content: sysText });
    } else {
      out.push({ role: 'system', content: sysText });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const blocks = normalizeContent(msg.content);
      const toolResults = blocks.filter((b): b is ToolResultBlock => b.type === 'tool_result');
      const others = blocks.filter((b) => b.type !== 'tool_result');

      // Emit the `role:"tool"` responses BEFORE any `role:"user"` content.
      // A single canonical user turn can hold both tool_result blocks and
      // text (e.g. a `/btw` note appended onto the trailing tool-result
      // message). OpenAI — and DeepSeek strictly — require every tool
      // message to immediately follow the assistant `tool_calls`; a user
      // message wedged in between triggers a 400 "assistant message with
      // 'tool_calls' must be followed by tool messages".
      for (const r of toolResults) {
        const content = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
        out.push({
          role: 'tool',
          tool_call_id: wireToolCallId(r.tool_use_id),
          content,
        });
      }
      if (others.length > 0) {
        out.push({
          role: 'user',
          content: opts.flattenContentToString
            ? blocksToString(others)
            : blocksToContentArray(others, opts),
        });
      }
    } else if (msg.role === 'assistant') {
      const blocks = normalizeContent(msg.content);
      const textBlocks = blocks.filter((b): b is TextBlock => b.type === 'text');
      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      const thinkingBlocks = blocks.filter((b): b is ThinkingBlock => b.type === 'thinking');
      const text = textBlocks.map((b) => b.text).join('');
      const reasoning = thinkingBlocks
        .map((b) => b.thinking)
        .filter((t) => t && t.length > 0)
        .join('');
      const toolCalls: OpenAIToolCall[] = toolUses.map((u) => ({
        id: wireToolCallId(u.id),
        type: 'function',
        function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
      }));

      const message: OpenAIMessage = { role: 'assistant' };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        if (text) {
          message.content = text;
        } else {
          // Tool-call-only assistant message: emit the empty `content`
          // field per `emptyContentMode` (computed once at the top of the
          // function; defaults to `''`, opt out with `'null'`).
          message.content = emptyContentMode === 'null' ? null : '';
        }
      } else {
        message.content = text;
      }
      // DeepSeek thinking mode requires the prior assistant's reasoning
      // blob to round-trip on the next request. Vanilla OpenAI silently
      // ignores the field, but strict endpoints (Cerebras) 400 on an
      // unknown property, so the field name is per endpoint.
      if (reasoning.length > 0) {
        if (echoField === 'reasoning') message.reasoning = reasoning;
        else if (echoField === 'reasoning_content') message.reasoning_content = reasoning;
      }
      out.push(message);
    } else if (msg.role === 'system') {
      // System-role messages carried INSIDE the conversation (compaction
      // digests, the evidence floor) must not be dropped. Fold them into a
      // user turn — mirrors the Anthropic and Gemini wires. Emitting a second
      // role:'system' would be unreliable (some OpenAI-compatible backends only
      // honour the first system message), whereas a user turn is universally
      // accepted; dropping it silently loses the collapsed history.
      const text = blocksToString(normalizeContent(msg.content));
      if (text.trim().length > 0) {
        out.push({ role: 'user', content: text });
      }
    }
  }
  return out;
}

function normalizeContent(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function blocksToString(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return '[image]';
      if (b.type === 'document') return documentAsText(b).text;
      return '';
    })
    .join('');
}

function blocksToContentArray(
  blocks: ContentBlock[],
  opts: ConvertOptions,
): OpenAIContent[] | string {
  const allowImages = opts.allowImages !== false;
  const allowDocuments = opts.allowDocuments !== false;
  const hasNativeMedia = blocks.some(
    (b) =>
      (b.type === 'image' &&
        imageInputFallback(b, {
          allowImages,
          allowImageUrls: opts.allowImageUrls,
        }) === undefined) ||
      (b.type === 'document' && documentInputFallback(b, allowDocuments) === undefined),
  );
  if (!hasNativeMedia) {
    return blocks
      .map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'image') {
          return (
            imageInputFallback(b, {
              allowImages,
              allowImageUrls: opts.allowImageUrls,
            }) ?? '[image]'
          );
        }
        if (b.type === 'document') {
          return documentInputFallback(b, allowDocuments) ?? documentAsText(b).text;
        }
        return '';
      })
      .join('');
  }
  return blocks
    .map((b): OpenAIContent | null => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image') {
        const fallback = imageInputFallback(b, {
          allowImages,
          allowImageUrls: opts.allowImageUrls,
        });
        if (fallback) return { type: 'text', text: fallback };
        const url =
          b.source.type === 'url'
            ? (b.source.url ?? '')
            : `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data ?? ''}`;
        return { type: 'image_url', image_url: { url } };
      }
      if (b.type === 'document') {
        const fallback = documentInputFallback(b, allowDocuments);
        if (fallback) return { type: 'text', text: fallback };
        return {
          type: 'file',
          file: {
            filename: b.name ?? 'document.pdf',
            file_data: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        };
      }
      return null;
    })
    .filter((c): c is OpenAIContent => c !== null);
}
