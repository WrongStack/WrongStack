import {
  type ContentBlock,
  documentAsText,
  type Message,
  ProviderError,
  type Request,
  type StopReason,
  type StreamEvent,
  type Usage,
  type Tool as WrongStackTool,
} from '@wrongstack/contracts/types';
import {
  APICallError,
  type FinishReason,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  type ProviderMetadata,
  type TextStreamPart,
  type ToolSet,
  tool,
} from 'ai';
import { splitGatewayModelId } from './capabilities.js';
import { documentInputFallback, imageInputFallback } from './media-input-policy.js';

export const DEFAULT_GATEWAY_ID = 'ai-gateway';

export interface AiSdkStreamTextInput {
  model: LanguageModel;
  system?: string | undefined;
  messages: ModelMessage[];
  tools?: ToolSet | undefined;
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; toolName: string } | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  frequencyPenalty?: number | undefined;
  presencePenalty?: number | undefined;
  seed?: number | undefined;
  reasoning?:
    | 'provider-default'
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | undefined;
  stopSequences?: string[] | undefined;
  providerOptions?: Record<string, Record<string, unknown>> | undefined;
  output?: Output.Output | undefined;
  abortSignal: AbortSignal;
  maxRetries: number;
}

export interface AiGatewayMessageOptions {
  allowImages?: boolean | undefined;
  allowImageUrls?: boolean | undefined;
  allowDocuments?: boolean | undefined;
}

export function convertMessages(
  messages: Message[],
  options: AiGatewayMessageOptions = {},
): ModelMessage[] {
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    // AI SDK 7 rejects system-role entries in `messages` by default. WrongStack
    // compaction deliberately emits such entries, so convert them to user
    // context markers while the canonical request.system remains top-level.
    if (message.role === 'system') {
      const content =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((block) => block.type !== 'tool_result')
              .map(blockText)
              .join('\n');
      if (content) converted.push({ role: 'user', content: `[system context]\n${content}` });
      continue;
    }

    if (typeof message.content === 'string') {
      if ((message.role as string) === 'tool') {
        const raw = message as unknown as Record<string, unknown>;
        converted.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId:
                (raw['tool_use_id'] as string | undefined) ??
                (raw['id'] as string | undefined) ??
                'tool_call',
              toolName: (raw['name'] as string | undefined) ?? 'tool',
              output: {
                type: 'text',
                value: message.content,
              },
            },
          ],
        });
      } else {
        converted.push({ role: message.role, content: message.content });
      }
      continue;
    }

    const toolResults = message.content.filter((block) => block.type === 'tool_result');
    const regular = message.content.filter((block) => block.type !== 'tool_result');

    const pushRegular = () => {
      if (regular.length === 0) return;
      if (message.role === 'assistant') {
        converted.push({
          role: 'assistant',
          content: regular.map((block) => convertAssistantBlock(block, options)),
        });
      } else {
        converted.push({
          role: 'user',
          content: regular.map((block) => convertUserBlock(block, options)),
        });
      }
    };
    const pushToolResults = () => {
      if (toolResults.length === 0) return;
      converted.push({
        role: 'tool',
        content: toolResults.map((block) => ({
          type: 'tool-result' as const,
          toolCallId: block.tool_use_id,
          toolName: block.name ?? 'unknown_tool',
          output: {
            type: block.is_error ? ('error-text' as const) : ('text' as const),
            value: block.content,
          },
        })),
      });
    };

    // A user turn carrying tool results may also carry plain text — WrongStack
    // merges PostToolUse `contextAs: 'separate'` output into the same message.
    // The tool message MUST still come first: Anthropic (and the gateway's
    // other upstreams) reject a conversation where anything is interposed
    // between an assistant tool call and its result.
    if (message.role === 'assistant') {
      pushRegular();
      pushToolResults();
    } else {
      pushToolResults();
      pushRegular();
    }
  }

  return converted;
}

export function convertTools(tools: WrongStackTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((entry) => [
      entry.name,
      tool({
        description: entry.description,
        inputSchema: jsonSchema(entry.inputSchema as never),
      }),
    ]),
  );
}

export function convertUsage(usage?: LanguageModelUsage | null): Usage {
  if (!usage || typeof usage !== 'object') {
    return { input: 0, output: 0 };
  }
  // `inputTokenDetails` is required by the AI SDK type but arrives from the
  // wire — a gateway response missing it must not crash the whole stream.
  const details = usage.inputTokenDetails ?? {};
  const cacheRead = nonNegative(details.cacheReadTokens);
  const cacheWrite = nonNegative(details.cacheWriteTokens);
  const reportedInput = nonNegative(usage.inputTokens);
  const separateCacheExceedsInput = cacheRead + cacheWrite > reportedInput;
  const input =
    optionalNonNegative(details.noCacheTokens) ??
    (separateCacheExceedsInput
      ? Math.max(0, reportedInput)
      : Math.max(0, reportedInput - cacheRead - cacheWrite));

  return {
    input,
    output: nonNegative(usage.outputTokens),
    ...(cacheRead > 0 ? { cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWrite } : {}),
  };
}

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Per-stream bookkeeping. `convertAiSdkStreamPart` is otherwise a pure
 * per-part mapping, but two WrongStack events are only correct in the context
 * of the parts that came before them.
 */
export interface AiSdkStreamState {
  /** Tool call ids already announced with `tool_use_start`. */
  startedToolIds: Set<string>;
  /** Monotonic index for `content_block_stop`. */
  blockIndex: number;
}

export function createStreamState(): AiSdkStreamState {
  return { startedToolIds: new Set(), blockIndex: 0 };
}

export function* convertAiSdkStreamPart(
  part: TextStreamPart<ToolSet>,
  providerId = DEFAULT_GATEWAY_ID,
  state: AiSdkStreamState = createStreamState(),
): Iterable<StreamEvent> {
  switch (part.type) {
    case 'text-start':
      yield { type: 'content_block_start', kind: 'text', id: part.id };
      break;
    case 'text-delta':
      yield { type: 'text_delta', text: part.text };
      break;
    case 'text-end':
      yield { type: 'content_block_stop', index: state.blockIndex++ };
      break;
    case 'reasoning-start':
      yield {
        type: 'thinking_start',
        ...(part.providerMetadata ? { providerMeta: metadataRecord(part.providerMetadata) } : {}),
      };
      break;
    case 'reasoning-delta':
      yield { type: 'thinking_delta', text: part.text };
      break;
    case 'reasoning-end': {
      // Anthropic issues the thinking-block integrity blob at the END of the
      // block, so `reasoning-start` metadata never carries it. Dropping it
      // makes the NEXT request 400 once the thinking block is echoed back.
      const signature = reasoningSignature(part.providerMetadata);
      if (signature) yield { type: 'thinking_signature', signature };
      yield { type: 'thinking_stop' };
      break;
    }
    case 'tool-input-start':
      state.startedToolIds.add(part.id);
      yield { type: 'tool_use_start', id: part.id, name: part.toolName };
      break;
    case 'tool-input-delta':
      yield { type: 'tool_use_input_delta', id: part.id, partial: part.delta };
      break;
    case 'tool-call':
      // AI SDK forwards `tool-call` verbatim and does NOT synthesise a
      // `tool-input-start` for upstreams that emit the call in one piece.
      // Both WrongStack aggregators key their tool buffer on the start event,
      // so without this the whole tool call is silently dropped.
      if (!state.startedToolIds.has(part.toolCallId)) {
        state.startedToolIds.add(part.toolCallId);
        yield { type: 'tool_use_start', id: part.toolCallId, name: part.toolName };
      }
      yield {
        type: 'tool_use_stop',
        id: part.toolCallId,
        input: part.input,
        ...(part.providerMetadata ? { providerMeta: metadataRecord(part.providerMetadata) } : {}),
      };
      break;
    case 'finish':
      yield {
        type: 'message_stop',
        stopReason: convertFinishReason(part.finishReason),
        usage: convertUsage(part.totalUsage),
      };
      break;
    case 'abort':
      throw new DOMException(part.reason ?? 'AI Gateway request aborted', 'AbortError');
    case 'error':
      throw toProviderError(part.error, providerId);
    default:
      break;
  }
}

export function toProviderError(error: unknown, providerId = DEFAULT_GATEWAY_ID): ProviderError {
  if (ProviderError.isProviderError(error)) return error;

  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    return new ProviderError(error.message, status, error.isRetryable, providerId, {
      cause: error,
      body: {
        message: error.message,
        ...(error.responseBody ? { raw: error.responseBody.slice(0, 2048) } : {}),
      },
    });
  }

  // The Gateway's own error class (`GatewayError` and its subclasses) is NOT an
  // `APICallError`, so it would otherwise fall through to the generic branch
  // below and be reported as `status 0` / retryable. That inverts the truth for
  // permanent failures — an account without a payment method answers 403 with
  // `isRetryable: false`, and retrying it just delays the actionable message.
  // Duck-typed rather than imported so `@ai-sdk/gateway` stays a transitive dep.
  const gateway = error as { statusCode?: unknown; isRetryable?: unknown; type?: unknown };
  if (
    error instanceof Error &&
    typeof gateway.statusCode === 'number' &&
    typeof gateway.isRetryable === 'boolean'
  ) {
    return new ProviderError(error.message, gateway.statusCode, gateway.isRetryable, providerId, {
      cause: error,
      body: {
        message: error.message,
        ...(typeof gateway.type === 'string' ? { type: gateway.type } : {}),
      },
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, 0, true, providerId, {
    cause: error,
    body: { message },
  });
}

export function convertSystem(req: Request): string | undefined {
  const text = req.system
    ?.map((block) => block.text)
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

export function convertToolChoice(
  choice: NonNullable<Request['toolChoice']>,
): AiSdkStreamTextInput['toolChoice'] {
  if (typeof choice === 'string') return choice;
  return { type: 'tool', toolName: choice.name };
}

/**
 * Map `Request.responseFormat` onto an AI SDK output spec. AI SDK resolves
 * these to the model's NATIVE `responseFormat` — no synthetic tool is
 * introduced — so the stream still arrives as text parts.
 */
export function convertResponseFormat(
  format: Request['responseFormat'],
): Output.Output | undefined {
  if (!format || format.type === 'text') return undefined;
  if (format.type === 'json_object') return Output.json();
  const spec = format.jsonSchema;
  return Output.object({
    schema: jsonSchema(spec.schema as never),
    ...(spec.name ? { name: spec.name } : {}),
    ...(spec.description ? { description: spec.description } : {}),
  });
}

/**
 * Provider-namespaced passthrough options.
 *
 * The `gateway` namespace is always safe — the Gateway owns it. Upstream
 * namespaces are only emitted when the model id actually routes there, so a
 * Google-only knob never rides along on an Anthropic request.
 */
export function convertProviderOptions(req: Request): Record<string, Record<string, unknown>> {
  const gateway: Record<string, unknown> = {};
  // Spend attribution / abuse monitoring — the gateway's equivalent of
  // Anthropic's `metadata.user_id` and OpenAI's `user`.
  if (req.user) gateway['user'] = req.user;
  // `req.cache` exists only when the caller wants prompt caching; the Gateway
  // exposes one unified switch rather than per-upstream cache markers.
  if (req.cache) gateway['caching'] = 'auto';

  const options: Record<string, Record<string, unknown>> = {};
  if (Object.keys(gateway).length > 0) options['gateway'] = gateway;

  const upstream = splitGatewayModelId(req.model)?.providerId;
  if (req.safetySettings?.length && upstream === 'google') {
    options['google'] = { safetySettings: req.safetySettings };
  }
  return options;
}

/**
 * Project canonical `providerMeta` onto AI SDK `providerOptions`, which the SDK
 * validates as `Record<namespace, Record<string, JSON>>`. Metadata this wire
 * produced is already namespaced, but a history built on another wire carries
 * FLAT keys (`google.thoughtSignature`, the Codex reasoning ids, Anthropic
 * redacted-thinking data) whose string values fail that schema — the whole
 * request was rejected as an invalid prompt after a `/model` switch or
 * fallback hop onto the gateway. Keep only namespaced entries.
 */
function toProviderOptions(
  meta: Record<string, unknown> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!meta) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value as Record<string, unknown>;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function convertReasoning(
  reasoning: Request['reasoning'],
): AiSdkStreamTextInput['reasoning'] {
  if (!reasoning) return undefined;
  if (reasoning.enabled === false || reasoning.effort === 'none') return 'none';
  if (reasoning.effort === 'max') return 'xhigh';
  return reasoning.effort ?? (reasoning.enabled ? 'provider-default' : undefined);
}

function convertAssistantBlock(
  block: Exclude<ContentBlock, { type: 'tool_result' }>,
  options: AiGatewayMessageOptions,
) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'thinking': {
      // `ThinkingBlock.signature` is the Anthropic integrity blob (see
      // blocks.ts). AI SDK carries it back under the anthropic namespace;
      // an explicit providerMeta from the wire always wins.
      const providerOptions =
        toProviderOptions(block.providerMeta) ??
        (block.signature ? { anthropic: { signature: block.signature } } : undefined);
      return {
        type: 'reasoning' as const,
        text: block.thinking,
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
      };
    }
    case 'tool_use':
      return {
        type: 'tool-call' as const,
        toolCallId: block.id,
        toolName: block.name,
        input: block.input,
        ...(toProviderOptions(block.providerMeta)
          ? { providerOptions: toProviderOptions(block.providerMeta) as never }
          : {}),
      };
    case 'image': {
      const fallback = imageInputFallback(block, options);
      if (fallback) return { type: 'text' as const, text: fallback };
      return {
        type: 'file' as const,
        mediaType: block.source.media_type ?? 'image/png',
        data: imageData(block),
      };
    }
    case 'document': {
      const fallback = documentInputFallback(block, options.allowDocuments !== false);
      return { type: 'text' as const, text: fallback ?? documentAsText(block).text };
    }
  }
}

function safeImageUrl(url: string | undefined): URL | string {
  if (!url) return '';
  try {
    return new URL(url);
  } catch {
    return url;
  }
}

function convertUserBlock(
  block: Exclude<ContentBlock, { type: 'tool_result' }>,
  options: AiGatewayMessageOptions,
) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'image': {
      const fallback = imageInputFallback(block, options);
      if (fallback) return { type: 'text' as const, text: fallback };
      return {
        type: 'image' as const,
        image:
          block.source.type === 'url' ? safeImageUrl(block.source.url) : (block.source.data ?? ''),
        ...(block.source.media_type ? { mediaType: block.source.media_type } : {}),
      };
    }
    case 'thinking':
      return { type: 'text' as const, text: block.thinking };
    case 'tool_use':
      return { type: 'text' as const, text: `[tool:${block.name}] ${JSON.stringify(block.input)}` };
    case 'document': {
      const fallback = documentInputFallback(block, options.allowDocuments !== false);
      if (fallback) return { type: 'text' as const, text: fallback };
      return {
        type: 'file' as const,
        mediaType: block.source.media_type,
        data: block.source.data,
        ...(block.name ? { filename: block.name } : {}),
      };
    }
  }
}

function imageData(block: Extract<ContentBlock, { type: 'image' }>) {
  return block.source.type === 'url'
    ? safeImageUrl(block.source.url)
    : `data:${block.source.media_type ?? 'image/png'};base64,${block.source.data ?? ''}`;
}

function blockText(block: Exclude<ContentBlock, { type: 'tool_result' }>): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'thinking':
      return block.thinking;
    case 'tool_use':
      return `[tool:${block.name}]`;
    case 'image':
      return '[image]';
    case 'document':
      return documentAsText(block).text;
  }
}

function convertFinishReason(reason: FinishReason | string | undefined): StopReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content-filter':
    case 'error':
      return 'refusal';
    default:
      // 'stop', 'other', 'unknown' and anything new
      return 'end_turn';
  }
}

function metadataRecord(metadata: ProviderMetadata): Record<string, unknown> {
  return metadata as Record<string, unknown>;
}

/**
 * Pull the thinking-block signature out of whichever namespace the upstream
 * used. Anthropic sends `{ anthropic: { signature } }`; Google's signed
 * thoughts arrive as `thoughtSignature`. Namespace-agnostic on purpose — the
 * gateway routes to providers this adapter does not enumerate.
 */
function reasoningSignature(metadata: ProviderMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  for (const namespace of Object.values(metadata)) {
    if (!namespace || typeof namespace !== 'object') continue;
    const scoped = namespace as Record<string, unknown>;
    const value = scoped['signature'] ?? scoped['thoughtSignature'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
