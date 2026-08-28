import type {
  Config,
  ModelsDevModel,
  ModelsRegistry,
  Provider,
  ProviderConfig,
  ProviderErrorKind,
  Response,
} from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';

interface ModelSmokeTarget {
  providerId: string;
  modelId: string;
}

interface ModelSmokeOptions {
  allModels: boolean;
  planOnly: boolean;
  json: boolean;
  timeoutMs: number;
  maxTokens: number;
  providerFilter?: string[] | undefined;
  modelFilter?: string[] | undefined;
}

export type ModelSmokeResult =
  | {
      providerId: string;
      modelId: string;
      status: 'passed';
      latencyMs: number;
      stopReason: Response['stopReason'];
      usage: Response['usage'];
    }
  | {
      providerId: string;
      modelId: string;
      status: 'failed';
      latencyMs: number;
      error: string;
      errorKind: ProviderErrorKind | 'unknown';
      httpStatus?: number | undefined;
    };

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_TOKENS = 32;

function csv(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const values = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function positiveInteger(
  value: string | boolean | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

/**
 * Subcommand flags are normally removed from positional args by the top-level
 * parser. Accept both sources so direct handler tests and programmatic callers
 * behave the same as `wstack modeldiag test ...`.
 */
export function parseModelSmokeOptions(
  args: string[],
  flags: Record<string, string | boolean> = {},
): ModelSmokeOptions {
  const local = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      local.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      local.set(name, next);
      i++;
    } else {
      local.set(name, true);
    }
  }
  const get = (name: string): string | boolean | undefined => local.get(name) ?? flags[name];
  const providerFilter = csv(get('providers') ?? get('provider'));
  const modelFilter = csv(get('models') ?? get('model'));

  return {
    allModels: get('all-models') === true || get('all-models') === 'true',
    planOnly: get('plan') === true || get('plan') === 'true',
    json: get('json') === true || get('json') === 'true',
    timeoutMs: positiveInteger(get('timeout'), DEFAULT_TIMEOUT_MS, '--timeout'),
    maxTokens: positiveInteger(get('max-tokens'), DEFAULT_MAX_TOKENS, '--max-tokens'),
    ...(providerFilter ? { providerFilter } : {}),
    ...(modelFilter ? { modelFilter } : {}),
  };
}

function pushUnique(target: string[], values: Iterable<string | undefined>): void {
  const seen = new Set(target);
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    target.push(normalized);
  }
}

async function catalogModelsFor(
  providerId: string,
  providerConfig: ProviderConfig | undefined,
  registry: ModelsRegistry,
): Promise<ModelsDevModel[]> {
  const direct = await registry.getProvider(providerId).catch(() => undefined);
  const inherited =
    direct ??
    (providerConfig?.type && providerConfig.type !== providerId
      ? await registry.getProvider(providerConfig.type).catch(() => undefined)
      : undefined);
  return inherited?.models ?? [];
}

function supportsTextCompletion(model: ModelsDevModel | undefined): boolean {
  const outputs = model?.modalities?.output;
  return !outputs?.length || outputs.includes('text');
}

/**
 * Build a deterministic provider-major target list from the already-decrypted
 * active config. The normal mode probes one representative model per provider;
 * `--all-models` expands to every catalog-visible plus explicitly configured
 * model.
 */
export async function buildModelSmokeTargets(
  config: Config,
  registry: ModelsRegistry,
  options: Pick<ModelSmokeOptions, 'allModels' | 'providerFilter' | 'modelFilter'>,
): Promise<ModelSmokeTarget[]> {
  const providerIds = Object.keys(config.providers ?? {});
  if (config.provider && !providerIds.includes(config.provider)) providerIds.push(config.provider);
  const providerFilter = options.providerFilter
    ? new Set(options.providerFilter.map((id) => id.toLowerCase()))
    : undefined;
  const modelFilter = options.modelFilter ? new Set(options.modelFilter) : undefined;
  const targets: ModelSmokeTarget[] = [];

  for (const providerId of providerIds) {
    if (providerFilter && !providerFilter.has(providerId.toLowerCase())) continue;
    const saved = config.providers?.[providerId];
    const catalogModels = await catalogModelsFor(providerId, saved, registry);
    const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
    const textCatalogModels = catalogModels.filter(supportsTextCompletion);
    const candidates: string[] = [];

    if (options.allModels) {
      pushUnique(candidates, saved?.models ?? []);
      pushUnique(candidates, Object.keys(saved?.customModels ?? {}));
      pushUnique(
        candidates,
        textCatalogModels.map((model) => model.id),
      );
      if (providerId === config.provider) pushUnique(candidates, [config.model]);
      pushUnique(candidates, [saved?.model]);
    } else {
      const representative =
        (providerId === config.provider ? config.model : undefined) ??
        saved?.model ??
        saved?.models?.find(Boolean) ??
        Object.keys(saved?.customModels ?? {})[0] ??
        (await registry.suggestModel(providerId).catch(() => undefined)) ??
        textCatalogModels[0]?.id;
      pushUnique(candidates, [representative]);
    }

    for (const modelId of candidates) {
      if (modelFilter && !modelFilter.has(modelId)) continue;
      if (!supportsTextCompletion(catalogById.get(modelId))) continue;
      targets.push({ providerId, modelId });
    }
  }

  return targets;
}

function classifyFailure(
  err: unknown,
): Pick<Extract<ModelSmokeResult, { status: 'failed' }>, 'error' | 'errorKind' | 'httpStatus'> {
  if (err instanceof ProviderError || ProviderError.isProviderError(err)) {
    const providerError = err as ProviderError;
    return {
      error: providerError.describe(),
      errorKind: providerError.kind,
      httpStatus: providerError.status,
    };
  }
  const isTimeout =
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
    /timed?\s*out/i.test(toErrorMessage(err));
  return {
    error: toErrorMessage(err),
    errorKind: isTimeout ? 'timeout' : 'unknown',
  };
}

export async function runModelSmokeTests(params: {
  targets: ModelSmokeTarget[];
  options: Pick<ModelSmokeOptions, 'timeoutMs' | 'maxTokens'>;
  createProvider: (providerId: string) => Promise<Provider> | Provider;
  onTargetStart?: ((target: ModelSmokeTarget, index: number, total: number) => void) | undefined;
  onTargetComplete?: ((result: ModelSmokeResult, index: number, total: number) => void) | undefined;
}): Promise<ModelSmokeResult[]> {
  const results: ModelSmokeResult[] = [];
  let providerId: string | undefined;
  let provider: Provider | undefined;
  let providerError: unknown;

  for (let index = 0; index < params.targets.length; index++) {
    const target = params.targets[index]!;
    params.onTargetStart?.(target, index, params.targets.length);
    const started = Date.now();

    if (target.providerId !== providerId) {
      providerId = target.providerId;
      provider = undefined;
      providerError = undefined;
      try {
        provider = await params.createProvider(target.providerId);
      } catch (err) {
        providerError = err;
      }
    }

    if (!provider) {
      const failure = classifyFailure(providerError ?? new Error('Provider could not be created.'));
      const result: ModelSmokeResult = {
        providerId: target.providerId,
        modelId: target.modelId,
        status: 'failed',
        latencyMs: Date.now() - started,
        ...failure,
      };
      results.push(result);
      params.onTargetComplete?.(result, index, params.targets.length);
      continue;
    }

    try {
      const response = await provider.complete(
        {
          model: target.modelId,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Reply with exactly: OK' }],
            },
          ],
          maxTokens: params.options.maxTokens,
        },
        { signal: AbortSignal.timeout(params.options.timeoutMs) },
      );
      const result: ModelSmokeResult = {
        providerId: target.providerId,
        modelId: target.modelId,
        status: 'passed',
        latencyMs: Date.now() - started,
        stopReason: response.stopReason,
        usage: response.usage,
      };
      results.push(result);
      params.onTargetComplete?.(result, index, params.targets.length);
    } catch (err) {
      const result: ModelSmokeResult = {
        providerId: target.providerId,
        modelId: target.modelId,
        status: 'failed',
        latencyMs: Date.now() - started,
        ...classifyFailure(err),
      };
      results.push(result);
      params.onTargetComplete?.(result, index, params.targets.length);
    }
  }

  return results;
}
