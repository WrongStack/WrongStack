import type { ProviderFactory } from '@wrongstack/core/registry';
import {
  type Capabilities,
  ConfigError,
  type ContentBlock,
  type Message,
  type Provider,
  type ProviderConfig,
  ProviderError,
  type Request,
  type Response,
  type StopReason,
  type StreamEvent,
  type Usage,
  type Tool as WrongStackTool,
} from '@wrongstack/core/types';
import {
  APICallError,
  createGateway,
  type FinishReason,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  Output,
  type ProviderMetadata,
  streamText,
  type TextStreamPart,
  type ToolSet,
  tool,
} from 'ai';
import { aggregateStream } from './aggregate.js';
import { splitGatewayModelId } from './capabilities.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { resolveMaxOutputTokens } from './model-output-limits.js';

const DEFAULT_GATEWAY_ID = 'ai-gateway';

/** Host of the Vercel-operated Gateway, whose URLs the AI SDK owns outright. */
const VERCEL_GATEWAY_HOST = 'ai-gateway.vercel.sh';

/**
 * Decide whether a configured `baseUrl` may be used as the Gateway WIRE base.
 *
 * The Gateway speaks two protocols on two paths: an OpenAI-shaped model list at
 * `/v1`, and its own wire protocol at `/v4/ai`, to which the AI SDK appends
 * `/language-model`. Only the former is in `PROVIDER_DEFINITIONS` (auto-discovery
 * needs it), and the catalog add-flow used to persist it as `providers.<id>.baseUrl`
 * — which then overrode the SDK's wire default and made every request 404 on
 * `/v1/language-model`.
 *
 * So for the Vercel-hosted Gateway we forward nothing and let the SDK supply its
 * own wire URL. That heals configs already carrying the discovery base, and keeps
 * us correct when the SDK bumps `/v4` to a later version. A base URL on any other
 * host is a self-hosted or proxied gateway and is passed through untouched.
 */
export function resolveGatewayWireBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // Unparseable input would only produce a broken request URL; the SDK
    // default is strictly better than a guess.
    return undefined;
  }
  return host === VERCEL_GATEWAY_HOST ? undefined : baseUrl;
}

export interface AiGatewayProviderOptions {
  apiKey: string;
  id?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  capabilities?: Capabilities | undefined;
  /** Test seam and an escape hatch for callers that already own an AI SDK model. */
  resolveModel?: ((modelId: string) => LanguageModel) | undefined;
  /** Test seam; production callers should use AI SDK's streamText implementation. */
  streamTextImpl?: AiSdkStreamText | undefined;
}

interface AiSdkStreamResult {
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
}

interface AiSdkStreamTextInput {
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

type AiSdkStreamText = (input: AiSdkStreamTextInput) => AiSdkStreamResult;

/**
 * Vercel AI Gateway transport for WrongStack.
 *
 * This adapter deliberately performs one model step only. Tools are declared
 * without execute functions, so permission checks and execution remain owned by
 * WrongStack's ToolExecutor. AI SDK retries are also disabled because the core
 * provider runner owns retry and cross-provider fallback policy.
 */
export class AiGatewayProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  private readonly resolveModel: (modelId: string) => LanguageModel;
  private readonly streamTextImpl: AiSdkStreamText;

  constructor(options: AiGatewayProviderOptions) {
    this.id = options.id ?? DEFAULT_GATEWAY_ID;
    this.capabilities =
      options.capabilities ??
      capabilitiesForFamily('openai-compatible', {
        tools: true,
        parallelTools: true,
        vision: true,
        streaming: true,
        reasoning: true,
        structuredOutput: true,
        jsonMode: true,
        // The Gateway exposes automatic caching as a request flag rather than
        // the explicit cache_control markers the Anthropic wire uses.
        promptCache: true,
        cacheControl: 'auto',
        // Sampling knobs go through AI SDK's unified call settings, so they
        // reach every upstream that accepts them.
        topK: true,
        frequencyPenalty: true,
        presencePenalty: true,
        seed: true,
        // No unified AI SDK setting exists for these; they would need
        // per-upstream providerOptions the adapter cannot verify.
        logprobs: false,
        multipleCompletions: false,
      });

    if (options.resolveModel) {
      this.resolveModel = options.resolveModel;
    } else {
      const wireBaseUrl = resolveGatewayWireBaseUrl(options.baseUrl);
      const gateway = createGateway({
        apiKey: options.apiKey,
        ...(wireBaseUrl ? { baseURL: wireBaseUrl } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
      this.resolveModel = (modelId) => gateway(modelId as never);
    }

    this.streamTextImpl = options.streamTextImpl ?? (streamText as unknown as AiSdkStreamText);
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    try {
      // Resolve through the catalog rather than reading `req.maxTokens` alone:
      // an unset cap would otherwise fall to the upstream provider's own
      // conservative default (Anthropic answers 4096) instead of the model's
      // real ceiling. Still omitted entirely when nothing knows the number.
      const maxOutput = resolveMaxOutputTokens(req, {
        capabilities: this.capabilities,
        providerId: this.id,
      });
      const result = this.streamTextImpl({
        model: this.resolveModel(req.model),
        messages: convertMessages(req.messages),
        ...(convertSystem(req) ? { system: convertSystem(req) } : {}),
        ...(req.tools?.length ? { tools: convertTools(req.tools) } : {}),
        ...(req.toolChoice ? { toolChoice: convertToolChoice(req.toolChoice) } : {}),
        ...(maxOutput !== undefined ? { maxOutputTokens: maxOutput } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.topP !== undefined ? { topP: req.topP } : {}),
        ...(req.topK !== undefined ? { topK: req.topK } : {}),
        ...(req.frequencyPenalty !== undefined ? { frequencyPenalty: req.frequencyPenalty } : {}),
        ...(req.presencePenalty !== undefined ? { presencePenalty: req.presencePenalty } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(convertReasoning(req.reasoning) ? { reasoning: convertReasoning(req.reasoning) } : {}),
        ...(req.stopSequences ? { stopSequences: req.stopSequences } : {}),
        ...(convertResponseFormat(req.responseFormat)
          ? { output: convertResponseFormat(req.responseFormat) }
          : {}),
        ...(Object.keys(convertProviderOptions(req)).length > 0
          ? { providerOptions: convertProviderOptions(req) }
          : {}),
        abortSignal: opts.signal,
        maxRetries: 0,
      });

      yield { type: 'message_start', model: req.model };

      const state = createStreamState();
      for await (const part of result.stream) {
        yield* convertAiSdkStreamPart(part, this.id, state);
      }
    } catch (error) {
      if (opts.signal.aborted || isAbortError(error)) throw error;
      throw toProviderError(error, this.id);
    }
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    return aggregateStream(this.stream(req, opts));
  }
}

export interface AiGatewayFactoryOptions {
  type?: string | undefined;
  capabilities?: Capabilities | undefined;
}

/** Registerable factory for config entries with `type: "ai-gateway"`. */
export function createAiGatewayProviderFactory(
  options: AiGatewayFactoryOptions = {},
): ProviderFactory {
  const type = options.type ?? DEFAULT_GATEWAY_ID;
  return {
    type,
    // Core currently has no cross-family gateway discriminator. This value is
    // registry routing metadata only; AiGatewayProvider performs the real wire conversion.
    family: 'openai-compatible',
    create: (cfg: ProviderConfig) =>
      new AiGatewayProvider({
        // `type` is the registry lookup key; cfg.type is the user-visible
        // provider id and must survive aliases, model switches, and fallback hops.
        id: cfg.type,
        apiKey: resolveActiveApiKey(cfg, ['AI_GATEWAY_API_KEY']),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        ...(cfg.headers ? { headers: cfg.headers } : {}),
        ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      }),
  };
}

export function convertMessages(messages: Message[]): ModelMessage[] {
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
      converted.push({ role: message.role, content: message.content });
      continue;
    }

    const toolResults = message.content.filter((block) => block.type === 'tool_result');
    const regular = message.content.filter((block) => block.type !== 'tool_result');

    const pushRegular = () => {
      if (regular.length === 0) return;
      if (message.role === 'assistant') {
        converted.push({ role: 'assistant', content: regular.map(convertAssistantBlock) });
      } else {
        converted.push({ role: 'user', content: regular.map(convertUserBlock) });
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

export function convertUsage(usage: LanguageModelUsage): Usage {
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

function convertSystem(req: Request): string | undefined {
  const text = req.system
    ?.map((block) => block.text)
    .filter(Boolean)
    .join('\n\n');
  return text || undefined;
}

function convertToolChoice(
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

function convertReasoning(reasoning: Request['reasoning']): AiSdkStreamTextInput['reasoning'] {
  if (!reasoning) return undefined;
  if (reasoning.enabled === false || reasoning.effort === 'none') return 'none';
  if (reasoning.effort === 'max') return 'xhigh';
  return reasoning.effort ?? (reasoning.enabled ? 'provider-default' : undefined);
}

function convertAssistantBlock(block: Exclude<ContentBlock, { type: 'tool_result' }>) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'thinking': {
      // `ThinkingBlock.signature` is the Anthropic integrity blob (see
      // blocks.ts). AI SDK carries it back under the anthropic namespace;
      // an explicit providerMeta from the wire always wins.
      const providerOptions =
        block.providerMeta ??
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
        ...(block.providerMeta ? { providerOptions: block.providerMeta as never } : {}),
      };
    case 'image':
      return {
        type: 'file' as const,
        mediaType: block.source.media_type ?? 'image/png',
        data: imageData(block),
      };
  }
}

function convertUserBlock(block: Exclude<ContentBlock, { type: 'tool_result' }>) {
  switch (block.type) {
    case 'text':
      return { type: 'text' as const, text: block.text };
    case 'image':
      return {
        type: 'image' as const,
        image:
          block.source.type === 'url' ? new URL(block.source.url ?? '') : (block.source.data ?? ''),
        ...(block.source.media_type ? { mediaType: block.source.media_type } : {}),
      };
    case 'thinking':
      return { type: 'text' as const, text: block.thinking };
    case 'tool_use':
      return { type: 'text' as const, text: `[tool:${block.name}] ${JSON.stringify(block.input)}` };
  }
}

function imageData(block: Extract<ContentBlock, { type: 'image' }>) {
  return block.source.type === 'url'
    ? new URL(block.source.url ?? '')
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
  }
}

function convertFinishReason(reason: FinishReason): StopReason {
  switch (reason) {
    case 'tool-calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content-filter':
    case 'error':
      return 'refusal';
    case 'stop':
    case 'other':
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

function resolveActiveApiKey(cfg: ProviderConfig, defaultEnvVars: string[] = []): string {
  if (cfg.apiKeys?.length) {
    const selected = cfg.activeKey
      ? cfg.apiKeys.find((entry) => entry.label === cfg.activeKey)
      : undefined;
    const fallback = selected ?? cfg.apiKeys[0];
    if (fallback?.apiKey) return fallback.apiKey;
  }
  if (cfg.apiKey) return cfg.apiKey;
  for (const envVar of cfg.envVars?.length ? cfg.envVars : defaultEnvVars) {
    const value = process.env[envVar];
    if (value) return value;
  }
  const probed = cfg.envVars?.length ? cfg.envVars : defaultEnvVars;
  throw new ConfigError({
    message: `Provider "${cfg.type}" requires an API key. Set ${probed.join(' or ') || 'apiKey in config'}.`,
    code: 'CONFIG_INVALID',
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
