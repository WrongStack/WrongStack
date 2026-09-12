import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type {
  ModelsDevModel,
  Provider,
  ProviderConfig,
  ProviderErrorKind,
  Response,
} from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  buildProviderFactoriesFromRegistry,
  makeProviderFromConfig,
  openCodeGoWireForModel,
} from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { resolveProviderCatalogForModels, SIBLING_CATALOG } from '../model-catalog.js';
import type { ProviderServiceContext } from './mutations.js';

export type ProviderModelTestDiagnosis =
  | 'ok'
  | 'authentication'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'model_unavailable'
  | 'context_limit'
  | 'token_limit'
  | 'timeout'
  | 'network'
  | 'overloaded'
  | 'server_error'
  | 'invalid_request'
  | 'cancelled'
  | 'unknown';

export interface ProviderModelTestResult {
  requestId: string;
  providerId: string;
  modelId: string;
  status: 'passed' | 'failed' | 'cancelled';
  diagnosis: ProviderModelTestDiagnosis;
  latencyMs: number;
  stopReason?: Response['stopReason'] | undefined;
  usage?: Response['usage'] | undefined;
  error?: string | undefined;
  errorKind?: ProviderErrorKind | 'unknown' | undefined;
  httpStatus?: number | undefined;
  family?: string | undefined;
  wire?: string | undefined;
  maxContext?: number | undefined;
  maxOutput?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities?: string[] | undefined;
}

const scrubber = new DefaultSecretScrubber();
const MODEL_UNAVAILABLE_RE = /model.{0,24}(?:unavailable|not supported|not found|does not exist)/i;
const TOKEN_LIMIT_RE =
  /max(?:imum)?[_\s-]*(?:output[_\s-]*)?tokens?.{0,48}(?:minimum|at least|>=|below)/i;

export function diagnoseProviderModelTestFailure(
  kind: ProviderErrorKind | 'unknown',
  status: number | undefined,
  message: string,
): ProviderModelTestDiagnosis {
  if (MODEL_UNAVAILABLE_RE.test(message)) return 'model_unavailable';
  if (TOKEN_LIMIT_RE.test(message)) return 'token_limit';
  if (kind === 'quota_exhausted' || status === 402) return 'quota_exhausted';
  if (kind === 'auth') return 'authentication';
  if (kind === 'rate_limit' || status === 429) return 'rate_limited';
  if (kind === 'context_overflow') return 'context_limit';
  if (kind === 'timeout') return 'timeout';
  if (kind === 'network') return 'network';
  if (kind === 'overloaded') return 'overloaded';
  if (kind === 'server') return 'server_error';
  if (kind === 'invalid_request') return 'invalid_request';
  return 'unknown';
}

function failureDetails(error: unknown): {
  diagnosis: ProviderModelTestDiagnosis;
  error: string;
  errorKind: ProviderErrorKind | 'unknown';
  httpStatus?: number | undefined;
} {
  if (ProviderError.isProviderError(error)) {
    const message = scrubber.scrub(error.describe()).slice(0, 800);
    return {
      diagnosis: diagnoseProviderModelTestFailure(error.kind, error.status, message),
      error: message,
      errorKind: error.kind,
      httpStatus: error.status,
    };
  }
  const message = scrubber.scrub(toErrorMessage(error)).slice(0, 800);
  const timeout = /timed?\s*out|aborterror|timeouterror/i.test(message);
  return {
    diagnosis: timeout ? 'timeout' : 'unknown',
    error: message,
    errorKind: timeout ? 'timeout' : 'unknown',
  };
}

function capabilitiesFor(model: ModelsDevModel | undefined): string[] {
  if (!model) return [];
  return [
    ...(model.tool_call ? ['tools'] : []),
    ...(model.reasoning ? ['reasoning'] : []),
    ...(model.modalities?.input?.includes('image') ? ['vision'] : []),
    ...(model.structured_output ? ['structured-output'] : []),
  ];
}

async function metadataFor(
  ctx: ProviderServiceContext,
  providerId: string,
  config: ProviderConfig,
  modelId: string,
): Promise<
  Omit<
    ProviderModelTestResult,
    'requestId' | 'providerId' | 'modelId' | 'status' | 'diagnosis' | 'latencyMs'
  >
> {
  const registry = ctx.deps.modelsRegistry;
  if (!registry) return {};
  const catalog = await resolveProviderCatalogForModels(registry, providerId, config).catch(
    () => undefined,
  );
  const siblingId = SIBLING_CATALOG[config.family ?? config.type ?? providerId];
  const sibling = siblingId
    ? await registry.getProvider(siblingId).catch(() => undefined)
    : undefined;
  const raw =
    catalog?.models.find((model) => model.id === modelId) ??
    sibling?.models.find((model) => model.id === modelId);
  const resolved =
    (await registry.getModel(providerId, modelId).catch(() => undefined)) ??
    (config.type && config.type !== providerId
      ? await registry.getModel(config.type, modelId).catch(() => undefined)
      : undefined) ??
    (siblingId ? await registry.getModel(siblingId, modelId).catch(() => undefined) : undefined);
  const canonicalType = config.type ?? providerId;
  const wire =
    canonicalType === 'opencode-go'
      ? openCodeGoWireForModel(modelId, raw?.provider?.npm)
      : (raw?.provider?.npm ?? catalog?.npm ?? config.family ?? config.type);
  return {
    family: raw?.family,
    wire,
    maxContext: resolved?.capabilities.maxContext || raw?.limit?.context,
    maxOutput: resolved?.capabilities.maxOutput ?? raw?.limit?.output,
    inputCost: resolved?.cost?.input ?? raw?.cost?.input,
    outputCost: resolved?.cost?.output ?? raw?.cost?.output,
    capabilities: capabilitiesFor(raw),
  };
}

async function buildProvider(
  ctx: ProviderServiceContext,
  providerId: string,
  config: ProviderConfig,
): Promise<Provider> {
  const factoryType = config.type ?? providerId;
  if (ctx.deps.modelsRegistry) {
    const factories = await buildProviderFactoriesFromRegistry({
      registry: ctx.deps.modelsRegistry,
    }).catch(() => []);
    const factory = factories.find((candidate) => candidate.type === factoryType);
    if (factory) return factory.create({ ...config, type: providerId });
  }
  // Offline/config-only fallback still resolves through the canonical type.
  // Result events retain `providerId`, so this must prioritize the correct
  // transport (notably OpenCode Go's session-aware adapter) over the internal
  // Provider instance label.
  return makeProviderFromConfig(factoryType, { ...config, type: factoryType });
}

export async function runProviderModelTests(params: {
  requestId: string;
  providerId: string;
  modelIds: readonly string[];
  provider: Provider;
  timeoutMs: number;
  maxTokens: number;
  signal: AbortSignal;
  metadata: (modelId: string) => Promise<Partial<ProviderModelTestResult>>;
  onResult: (result: ProviderModelTestResult) => void;
}): Promise<{ passed: number; failed: number; cancelled: number }> {
  let passed = 0;
  let failed = 0;
  let cancelled = 0;
  for (const modelId of params.modelIds) {
    const started = Date.now();
    const metadata = await params.metadata(modelId);
    if (params.signal.aborted) {
      cancelled++;
      params.onResult({
        requestId: params.requestId,
        providerId: params.providerId,
        modelId,
        status: 'cancelled',
        diagnosis: 'cancelled',
        latencyMs: 0,
        ...metadata,
      });
      continue;
    }
    try {
      const response = await params.provider.complete(
        {
          model: modelId,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
          maxTokens: params.maxTokens,
        },
        { signal: AbortSignal.any([params.signal, AbortSignal.timeout(params.timeoutMs)]) },
      );
      passed++;
      params.onResult({
        requestId: params.requestId,
        providerId: params.providerId,
        modelId,
        status: 'passed',
        diagnosis: 'ok',
        latencyMs: Date.now() - started,
        stopReason: response.stopReason,
        usage: response.usage,
        ...metadata,
      });
    } catch (error) {
      if (params.signal.aborted) {
        cancelled++;
        params.onResult({
          requestId: params.requestId,
          providerId: params.providerId,
          modelId,
          status: 'cancelled',
          diagnosis: 'cancelled',
          latencyMs: Date.now() - started,
          ...metadata,
        });
      } else {
        failed++;
        params.onResult({
          requestId: params.requestId,
          providerId: params.providerId,
          modelId,
          status: 'failed',
          latencyMs: Date.now() - started,
          ...failureDetails(error),
          ...metadata,
        });
      }
    }
  }
  return { passed, failed, cancelled };
}

export function createProviderModelTestHandlers(ctx: ProviderServiceContext) {
  const active = new Map<string, AbortController>();

  function handleProviderModelTestCancel(requestId: string): void {
    active.get(requestId)?.abort();
  }

  async function handleProviderModelTestRun(
    ws: WebSocket,
    input: {
      requestId: string;
      providerId: string;
      modelIds: string[];
      timeoutMs: number;
      maxTokens: number;
    },
  ): Promise<void> {
    const controller = new AbortController();
    active.get(input.requestId)?.abort();
    active.set(input.requestId, controller);
    ctx.sendMessage(ws, {
      type: 'provider.test.started',
      payload: { ...input, total: input.modelIds.length },
    });
    try {
      const providers = await ctx.loadConfigProviders();
      const config = providers[input.providerId];
      if (!config) throw new Error(`Saved provider "${input.providerId}" was not found.`);
      const provider = await buildProvider(ctx, input.providerId, config);
      const summary = await runProviderModelTests({
        ...input,
        provider,
        signal: controller.signal,
        metadata: (modelId) => metadataFor(ctx, input.providerId, config, modelId),
        onResult: (result) =>
          ctx.sendMessage(ws, { type: 'provider.test.result', payload: result }),
      });
      ctx.sendMessage(ws, {
        type: 'provider.test.complete',
        payload: { requestId: input.requestId, providerId: input.providerId, ...summary },
      });
    } catch (error) {
      const failure = failureDetails(error);
      for (const modelId of input.modelIds) {
        ctx.sendMessage(ws, {
          type: 'provider.test.result',
          payload: {
            requestId: input.requestId,
            providerId: input.providerId,
            modelId,
            status: 'failed',
            latencyMs: 0,
            ...failure,
          },
        });
      }
      ctx.sendMessage(ws, {
        type: 'provider.test.complete',
        payload: {
          requestId: input.requestId,
          providerId: input.providerId,
          passed: 0,
          failed: input.modelIds.length,
          cancelled: 0,
          error: failure.error,
        },
      });
    } finally {
      if (active.get(input.requestId) === controller) active.delete(input.requestId);
    }
  }

  return { handleProviderModelTestRun, handleProviderModelTestCancel };
}
