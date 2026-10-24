import {
  type Capabilities,
  ConfigError,
  type Provider,
  type ProviderConfig,
  type Request,
  type Response,
  type StreamEvent,
} from '@wrongstack/contracts/types';
import type { ProviderFactory } from '@wrongstack/core/registry';
import {
  createGateway,
  type LanguageModel,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from 'ai';
import { aggregateStream } from './aggregate.js';
import {
  type AiSdkStreamTextInput,
  convertAiSdkStreamPart,
  convertMessages,
  convertProviderOptions,
  convertReasoning,
  convertResponseFormat,
  convertSystem,
  convertToolChoice,
  convertTools,
  createStreamState,
  DEFAULT_GATEWAY_ID,
  toProviderError,
} from './ai-gateway-wire.js';
import { warmConnection } from './connection-warmup.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { resolveMaxOutputTokens } from './model-output-limits.js';

export type { AiSdkStreamState } from './ai-gateway-wire.js';
export {
  convertAiSdkStreamPart,
  convertMessages,
  convertProviderOptions,
  convertResponseFormat,
  convertTools,
  convertUsage,
  createStreamState,
  toProviderError,
} from './ai-gateway-wire.js';

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
  /** Endpoint `warm()` opens; unknown when the host supplies its own model resolver. */
  private readonly warmUrl: string | undefined;

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
      this.warmUrl = undefined;
    } else {
      const wireBaseUrl = resolveGatewayWireBaseUrl(options.baseUrl);
      this.warmUrl = wireBaseUrl ?? `https://${VERCEL_GATEWAY_HOST}`;
      const gateway = createGateway({
        apiKey: options.apiKey,
        ...(wireBaseUrl ? { baseURL: wireBaseUrl } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
      });
      this.resolveModel = (modelId) => gateway(modelId as never);
    }

    this.streamTextImpl = options.streamTextImpl ?? (streamText as unknown as AiSdkStreamText);
  }

  async warm(_model: string): Promise<void> {
    if (this.warmUrl) await warmConnection(this.warmUrl);
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
        messages: convertMessages(req.messages, {
          allowImages: this.capabilities.vision !== false,
          allowDocuments: this.capabilities.pdf !== false,
        }),
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

function resolveActiveApiKey(cfg: ProviderConfig, defaultEnvVars: string[] = []): string {
  if (cfg.apiKeys?.length) {
    const selected = cfg.activeKey
      ? cfg.apiKeys.find((entry) => entry.label === cfg.activeKey)
      : undefined;
    const fallback = selected ?? cfg.apiKeys[0];
    if (fallback?.apiKey?.trim()) return fallback.apiKey;
  }
  if (cfg.apiKey?.trim()) return cfg.apiKey;
  // VULN-006 sentinel: a present-but-empty `envVars` array is written by
  // provider_manage's endpointChanged — "endpoint changed; do NOT silently
  // re-arm the credential from the catalog preset". Mirrors makeProvider's
  // resolver (index.ts): only an absent/undefined envVars falls back to the
  // gateway's canonical default (AI_GATEWAY_API_KEY).
  const envVars = Array.isArray(cfg.envVars) ? cfg.envVars : defaultEnvVars;
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (value) return value;
  }
  throw new ConfigError({
    message: `Provider "${cfg.type}" requires an API key. Set ${envVars.join(' or ') || 'apiKey in config'}.`,
    code: 'CONFIG_INVALID',
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
