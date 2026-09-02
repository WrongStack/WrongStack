import type { CustomModelDefinition } from '../../types/config.js';
import type { Capabilities } from '../../types/provider.js';
import type { ModelsDevModel } from '../../types/models-registry.js';
import { FORBIDDEN_PROTO_KEYS } from '../../utils/deep-merge.js';

export type InlineProviderModelWarning = (
  message: string,
  context?: Record<string, unknown>,
) => void;

const BOOLEAN_CAPABILITIES = [
  'tools',
  'parallelTools',
  'vision',
  'streaming',
  'promptCache',
  'systemPrompt',
  'jsonMode',
  'reasoning',
  'topK',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'structuredOutput',
  'logprobs',
  'audio',
  'multipleCompletions',
] as const satisfies readonly (keyof Capabilities)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readCapabilities(model: Record<string, unknown>): Partial<Capabilities> | undefined {
  const raw = isRecord(model['capabilities']) ? model['capabilities'] : undefined;
  const capabilities: Partial<Capabilities> = {};

  if (raw) {
    for (const key of BOOLEAN_CAPABILITIES) {
      const value = raw[key];
      if (typeof value === 'boolean') capabilities[key] = value;
    }
    const cacheControl = raw['cacheControl'];
    if (cacheControl === 'native' || cacheControl === 'auto' || cacheControl === 'none') {
      capabilities.cacheControl = cacheControl;
    }
  }

  const limit = isRecord(model['limit']) ? model['limit'] : undefined;
  const maxContext =
    positiveNumber(raw?.['maxContext']) ??
    positiveNumber(model['maxContext']) ??
    positiveNumber(model['contextWindow']) ??
    positiveNumber(limit?.['context']);
  if (maxContext !== undefined) capabilities.maxContext = maxContext;

  const capabilityMaxOutput = positiveNumber(raw?.['maxOutput']);
  if (capabilityMaxOutput !== undefined) capabilities.maxOutput = capabilityMaxOutput;

  if (typeof model['tool_call'] === 'boolean' && capabilities.tools === undefined) {
    capabilities.tools = model['tool_call'];
  }
  if (typeof model['reasoning'] === 'boolean' && capabilities.reasoning === undefined) {
    capabilities.reasoning = model['reasoning'];
  }

  const modalities = isRecord(model['modalities']) ? model['modalities'] : undefined;
  const inputModalities = modalities?.['input'];
  if (Array.isArray(inputModalities) && capabilities.vision === undefined) {
    capabilities.vision = inputModalities.includes('image');
  }

  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function inlineDefinition(model: Record<string, unknown>): CustomModelDefinition {
  const definition: CustomModelDefinition = {};
  const name = model['name'];
  if (typeof name === 'string' && name.trim().length > 0) definition.name = name;

  const provider = model['provider'];
  if (typeof provider === 'string' && provider.trim().length > 0) {
    definition.provider = provider;
  }

  const limit = isRecord(model['limit']) ? model['limit'] : undefined;
  const maxOutput =
    positiveNumber(model['maxOutput']) ??
    positiveNumber(limit?.['output']) ??
    positiveNumber(
      isRecord(model['capabilities']) ? model['capabilities']['maxOutput'] : undefined,
    );
  if (maxOutput !== undefined) definition.maxOutput = maxOutput;

  const capabilities = readCapabilities(model);
  if (capabilities) definition.capabilities = capabilities;

  // ME-2: store the full model object (minus id) so all models.dev schema
  // fields round-trip — cost, modalities.output, knowledge, dates, etc.
  // For catalog-model overrides this is a delta (only fields the user set);
  // for custom (non-catalog) models it's the full object.
  const { id: _id, ...rest } = model;
  if (Object.keys(rest).length > 0) {
    definition.modelsDev = rest as Omit<ModelsDevModel, 'id'>;
  }

  return definition;
}

function mergeDefinitions(
  base: CustomModelDefinition | undefined,
  patch: CustomModelDefinition,
): CustomModelDefinition {
  // ME-2: deep-merge modelsDev payloads so inline objects + explicit
  // customModels entries compose field-by-field (same overlay philosophy
  // as mergeModelsPayload). Explicit customModels still wins per-field.
  // One level deeper for nested objects (limit/cost/modalities) so a
  // partial override doesn't blow away the base's other sub-fields.
  const mergedModelsDev = (() => {
    if (!base?.modelsDev && !patch.modelsDev) return undefined;
    const baseMd = base?.modelsDev ?? {};
    const patchMd = patch.modelsDev ?? {};
    const result: Record<string, unknown> = { ...baseMd, ...patchMd };
    for (const nestedKey of ['limit', 'cost', 'modalities']) {
      const bn = (baseMd as Record<string, unknown>)?.[nestedKey];
      const pn = (patchMd as Record<string, unknown>)?.[nestedKey];
      if (bn || pn) {
        result[nestedKey] = {
          ...((bn as Record<string, unknown>) ?? {}),
          ...((pn as Record<string, unknown>) ?? {}),
        };
      }
    }
    return result as Omit<ModelsDevModel, 'id'>;
  })();

  return {
    ...base,
    ...patch,
    ...(base?.capabilities || patch.capabilities
      ? { capabilities: { ...base?.capabilities, ...patch.capabilities } }
      : {}),
    ...(mergedModelsDev ? { modelsDev: mergedModelsDev } : {}),
  };
}

/**
 * Normalize model.dev-style objects accepted in `providers.<id>.models` into
 * the canonical runtime representation: a string model allowlist plus the
 * provider-local `customModels` metadata map.
 *
 * The function mutates only the provider entries it normalizes. Explicit
 * `customModels` values win field-by-field over metadata derived from inline
 * objects, preserving the existing configuration override contract.
 */
export function normalizeInlineProviderModels(
  config: Record<string, unknown>,
  warn?: InlineProviderModelWarning,
): void {
  const providers = config['providers'];
  if (!isRecord(providers)) return;

  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider) || !Array.isArray(rawProvider['models'])) continue;

    const ids: string[] = [];
    const seen = new Set<string>();
    const derived = new Map<string, CustomModelDefinition>();

    for (const [index, entry] of rawProvider['models'].entries()) {
      let id: string | undefined;
      let definition: CustomModelDefinition | undefined;

      if (typeof entry === 'string' && entry.length > 0) {
        id = entry;
      } else if (isRecord(entry)) {
        const rawId = entry['id'];
        if (typeof rawId === 'string' && rawId.trim().length > 0) {
          id = rawId.trim();
          if (!FORBIDDEN_PROTO_KEYS.has(id)) definition = inlineDefinition(entry);
        }
      }

      if (!id || FORBIDDEN_PROTO_KEYS.has(id)) {
        warn?.('Ignoring invalid inline provider model entry', {
          event: 'config.invalid_inline_provider_model',
          provider: providerId,
          index,
        });
        continue;
      }

      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
      if (definition) derived.set(id, mergeDefinitions(derived.get(id), definition));
    }

    rawProvider['models'] = ids;
    if (derived.size === 0) continue;

    const explicit = isRecord(rawProvider['customModels'])
      ? rawProvider['customModels']
      : undefined;
    const normalized: Record<string, CustomModelDefinition> = Object.create(null) as Record<
      string,
      CustomModelDefinition
    >;
    for (const [id, definition] of derived) normalized[id] = definition;
    if (explicit) {
      for (const [id, value] of Object.entries(explicit)) {
        if (FORBIDDEN_PROTO_KEYS.has(id) || !isRecord(value)) continue;
        normalized[id] = mergeDefinitions(normalized[id], value as CustomModelDefinition);
      }
    }
    rawProvider['customModels'] = normalized;
  }
}
