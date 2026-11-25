/**
 * The model picker an ACP editor shows for a WrongStack session.
 *
 * ACP has no model-selection method any more (`session/set_model` left the
 * spec); a client finds the picker as a session config option with
 * `category: "model"`. Its values are the same models the `/model` switch
 * offers (`buildPickableProviders`: providers with a usable credential, their
 * models from the catalog), grouped by provider, minus what the user switched
 * off. A value is `<provider>/<model>`, split at the first slash like every
 * other model reference, so model ids that contain slashes survive.
 */

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@wrongstack/acp/agent';
import type { Config, ModelsRegistry } from '@wrongstack/contracts/types';
import { parseModelRef } from '@wrongstack/core/agent';
import { WRONGFORGE_REASONING } from '@wrongstack/fleet';
import { catalogProviderIdFor } from '@wrongstack/providers';
import { EFFORT_KEEP, startupEffortOptions } from './picker-effort.js';
import { buildPickableProviders } from './provider-helpers.js';

export const ACP_MODEL_OPTION_ID = 'model';
export const ACP_EFFORT_OPTION_ID = 'thought_level';

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  default: 'Default',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/** The option value naming a provider's model. */
export function acpModelValue(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Provider and model named by an option value, or null when it names neither. */
export function parseAcpModelValue(value: string): { providerId: string; modelId: string } | null {
  const ref = parseModelRef(value);
  return ref.provider && ref.model ? { providerId: ref.provider, modelId: ref.model } : null;
}

/** The model selection among a session's config options, if any. */
export function selectedAcpModel(
  configOptions: readonly SessionConfigOption[],
): { providerId: string; modelId: string } | null {
  const option = configOptions.find((o) => o.id === ACP_MODEL_OPTION_ID && o.category === 'model');
  return option && typeof option.currentValue === 'string'
    ? parseAcpModelValue(option.currentValue)
    : null;
}

function switchedOff(config: Config): {
  provider(id: string): boolean;
  model(ref: string): boolean;
} {
  const lower = (s: string): string => s.trim().toLowerCase();
  const providers = new Set(
    (Array.isArray(config.disabledProviders) ? config.disabledProviders : [])
      .filter((id): id is string => typeof id === 'string')
      .map(lower),
  );
  const models = new Set<string>();
  for (const ref of Array.isArray(config.disabledModels) ? config.disabledModels : []) {
    if (typeof ref !== 'string') continue;
    const parsed = parseModelRef(ref);
    if (parsed.model) models.add(lower(`${parsed.provider ?? config.provider}/${parsed.model}`));
  }
  return {
    provider: (id) => providers.has(lower(id)),
    model: (ref) => models.has(lower(ref)),
  };
}

/**
 * Build the session's model option, or undefined when there is nothing to
 * choose between (no provider configured).
 */
export async function buildAcpModelOption(args: {
  config: Config;
  modelsRegistry: ModelsRegistry;
  /** Test seam; defaults to the `/model` switch's provider list. */
  loadProviders?: typeof buildPickableProviders | undefined;
}): Promise<SessionConfigOption | undefined> {
  const { config, modelsRegistry } = args;
  if (!config.provider || !config.model) return undefined;
  const current = acpModelValue(config.provider, config.model);
  const providers = await (args.loadProviders ?? buildPickableProviders)(
    modelsRegistry,
    config,
  ).catch(() => []);
  const off = switchedOff(config);

  const groups: SessionConfigSelectGroup[] = [];
  for (const provider of providers) {
    if (off.provider(provider.id)) continue;
    const options: SessionConfigSelectOption[] = [];
    for (const model of new Set(provider.models)) {
      const value = acpModelValue(provider.id, model);
      if (value !== current && off.model(value)) continue;
      const name = provider.modelDetails?.[model]?.name;
      options.push({ value, name: name && name !== model ? `${name} (${model})` : model });
    }
    if (options.length > 0) groups.push({ group: provider.id, name: provider.id, options });
  }

  // The running model is always offered, even when the catalog no longer
  // lists it, so the picker can show what the session is actually using.
  let home = groups.find((g) => g.group === config.provider);
  if (!home) {
    home = { group: config.provider, name: config.provider, options: [] };
    groups.push(home);
  }
  if (!home.options.some((o) => o.value === current)) {
    home.options.unshift({ value: current, name: config.model });
  }
  // The running provider first: it is where most switches happen.
  groups.sort((a, b) => Number(b === home) - Number(a === home));

  return {
    id: ACP_MODEL_OPTION_ID,
    name: 'Model',
    description: 'Provider and model this session runs on.',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: groups,
  };
}

/** The reasoning-effort selection among a session's config options, or undefined for default. */
export function selectedAcpEffort(
  configOptions: readonly SessionConfigOption[],
): string | undefined {
  const option = configOptions.find((o) => o.category === 'thought_level');
  if (!option || typeof option.currentValue !== 'string') {
    return undefined;
  }
  const value = option.currentValue.trim();
  if (!value || value === EFFORT_KEEP) return undefined;
  return value;
}

/**
 * Build the session's `thought_level` (reasoning effort) config option for the
 * given (or configured) model, or undefined when the model does not support
 * effort control.
 */
export async function buildAcpEffortOption(args: {
  config: Config;
  modelsRegistry: ModelsRegistry;
  providerId?: string | undefined;
  modelId?: string | undefined;
}): Promise<SessionConfigOption | undefined> {
  const { config, modelsRegistry } = args;
  const providerId = args.providerId ?? config.provider;
  const modelId = args.modelId ?? config.model;
  if (!providerId || !modelId) return undefined;

  const catalogId = catalogProviderIdFor(providerId, config.providers?.[providerId]?.type);
  let reasoningMeta:
    | {
        reasoning?: boolean | undefined;
        reasoningConfig?: import('@wrongstack/contracts/types').ReasoningConfig | undefined;
      }
    | undefined;

  if (catalogId === 'wrongforge') {
    reasoningMeta = { reasoning: true, reasoningConfig: WRONGFORGE_REASONING };
  } else {
    try {
      const resolved = await modelsRegistry?.getModel?.(catalogId, modelId);
      if (resolved) {
        reasoningMeta = {
          reasoning: resolved.capabilities.reasoning,
          reasoningConfig: resolved.capabilities.reasoningConfig,
        };
      }
    } catch {
      reasoningMeta = undefined;
    }
  }

  const choices = startupEffortOptions(reasoningMeta);
  if (choices.length === 0) return undefined;

  const configuredEffort = config.modelRuntime?.reasoning?.effort;
  const currentValue =
    typeof configuredEffort === 'string' && choices.includes(configuredEffort as never)
      ? configuredEffort
      : EFFORT_KEEP;

  return {
    id: ACP_EFFORT_OPTION_ID,
    name: 'Reasoning Effort',
    description: 'Reasoning effort level for the selected model.',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: choices.map((value) => ({
      value,
      name: EFFORT_LABELS[value] ?? value,
    })),
  };
}
