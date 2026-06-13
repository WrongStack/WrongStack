import type {
  ContentBlock,
  Message,
  TextBlock,
  ThinkingBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from '@wrongstack/core';

export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toolsToOpenAI(tools: Tool[]): OpenAIToolSchema[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
    },
  }));
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAIContent[] | undefined;
  tool_calls?: OpenAIToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
  /**
   * DeepSeek (and other OpenAI-compatible thinking-mode models) require the
   * previous assistant's chain-of-thought to be echoed back on the next
   * request as a top-level `reasoning_content` field on the assistant
   * message — NOT inside individual tool_calls. Without it DeepSeek
   * returns 400 "reasoning_content in the thinking mode must be passed
   * back to the API". Vanilla OpenAI ignores this field, so emitting it
   * unconditionally is safe.
   */
  reasoning_content?: string | undefined;
}

export interface OpenAIContent {
  type: 'text' | 'image_url';
  text?: string | undefined;
  image_url?: { url: string | undefined };
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ConvertOptions {
  flattenContentToString?: boolean | undefined;
  stripCacheControl?: boolean | undefined;
  systemAsMessage?: boolean | undefined;
  emptyToolCallContent?: 'null' | 'empty_string' | undefined;
}

export function messagesToOpenAI(
  system: TextBlock[] | undefined,
  messages: Message[],
  opts: ConvertOptions = {},
): OpenAIMessage[] {
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
          tool_call_id: r.tool_use_id,
          content,
        });
      }
      if (others.length > 0) {
        out.push({
          role: 'user',
          content: opts.flattenContentToString
            ? blocksToString(others)
            : blocksToContentArray(others),
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
        id: u.id,
        type: 'function',
        function: { name: u.name, arguments: JSON.stringify(u.input) },
      }));

      const message: OpenAIMessage = { role: 'assistant' };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
        if (text) {
          message.content = text;
        } else {
          // OpenAI 2024-2025 wire spec requires every assistant message
          // to have a `content` field. K2P7's Moonshot gateway, OpenRouter
          // in strict mode, and modern Mistral 400 on a tool_calls message
          // that omits content. Default to `''` (matches OpenAI SDK
          // behaviour today). Permissive proxies (vLLM, llama.cpp) that
          // reject `''` can opt out with `emptyToolCallContent: 'null'`.
          const emptyContentMode = opts.emptyToolCallContent ?? 'empty_string';
          message.content = emptyContentMode === 'null' ? null : '';
        }
      } else {
        message.content = text;
      }
      // DeepSeek thinking mode requires the prior assistant's reasoning
      // blob to round-trip on the next request. Vanilla OpenAI silently
      // accepts and ignores the field, so emitting it unconditionally is
      // safe across the OpenAI-compatible ecosystem.
      if (reasoning.length > 0) {
        message.reasoning_content = reasoning;
      }
      out.push(message);
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
      return '';
    })
    .join('');
}

function blocksToContentArray(blocks: ContentBlock[]): OpenAIContent[] | string {
  const hasImage = blocks.some((b) => b.type === 'image');
  if (!hasImage) {
    return blocks
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
  return blocks
    .map((b): OpenAIContent | null => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image') {
        const url =
          b.source.type === 'url'
            ? (b.source.url ?? '')
            : `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data ?? ''}`;
        return { type: 'image_url', image_url: { url } };
      }
      return null;
    })
    .filter((c): c is OpenAIContent => c !== null);
}
