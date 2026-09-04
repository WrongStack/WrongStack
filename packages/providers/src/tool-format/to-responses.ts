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
 * `thinking` blocks are intentionally dropped from the input: replaying them
 * would require the opaque `reasoning.encrypted_content` blob (which we don't
 * persist), and omitting them — plus omitting function-call item ids — sidesteps
 * the Responses reasoning/tool-call pairing validation entirely.
 */

import type {
  ContentBlock,
  ImageBlock,
  Message,
  TextBlock,
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
  const sorted =
    tools.length > 1 ? [...tools].sort((a, b) => a.name.localeCompare(b.name)) : tools;
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
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function imageUrl(b: ImageBlock): string {
  return b.source.type === 'url'
    ? (b.source.url ?? '')
    : `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data ?? ''}`;
}

export function messagesToResponsesInput(messages: Message[]): Record<string, unknown>[] {
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
              return { type: 'input_image', detail: 'auto', image_url: imageUrl(b) };
            }
            return null;
          })
          .filter((c): c is Record<string, unknown> => c !== null);
        if (content.length > 0) out.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      for (const block of blocks) {
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
