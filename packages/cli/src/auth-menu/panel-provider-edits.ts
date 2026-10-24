import type { ProviderConfig } from '@wrongstack/contracts/types';
import { authProfileAliasError } from '@wrongstack/providers';
import type { AuthModelEdit, AuthProviderEdit, AuthProviderSetup } from '@wrongstack/tui';
import { normalizeKeys, nowIso, writeKeysBack } from '../provider-config-utils.js';
import type { AuthPanelServiceDeps } from './panel-flow-bridge.js';
import { hasEditableModel } from './panel-flow-bridge.js';
import { validateFamily } from './shared.js';

interface CreateProviderEditsInput {
  deps: AuthPanelServiceDeps;
  mutate: (
    mutator: (
      providers: Record<string, import('@wrongstack/contracts/types').ProviderConfig>,
      config: Record<string, unknown>,
    ) => string | null,
  ) => Promise<string | null>;
  loadProviders: () => Promise<
    Record<string, import('@wrongstack/contracts/types').ProviderConfig>
  >;
}

export function createProviderEdits({ deps, mutate, loadProviders }: CreateProviderEditsInput) {
  return {
    async saveProviderSetup(setup: AuthProviderSetup): Promise<string | null> {
      const type = setup.type.trim();
      const alias = setup.alias.trim();
      const keyLabel = setup.keyLabel.trim();
      const apiKey = setup.apiKey.trim();
      const family = validateFamily(setup.family);
      if (!type) return 'Provider id is required.';
      if (!alias) return 'Alias is required.';
      const aliasError = authProfileAliasError(alias);
      if (aliasError) return aliasError;
      if (!family) return 'Choose a supported protocol family.';
      if (!keyLabel) return 'Key alias is required.';
      if (!apiKey) return 'API key is required.';

      const split = (value: string): string[] =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      const baseUrl = setup.baseUrl.trim();
      const models = split(setup.models);
      const envVars = split(setup.envVars);
      // Resolve this before entering the synchronous config mutation so the
      // default selection, provider entry, and subsequent live reload are one
      // atomic state transition.
      let catalogDefaultModel: string | undefined;
      try {
        catalogDefaultModel = (await deps.modelsRegistry.getProvider(type))?.models?.[0]?.id;
      } catch {
        // A missing catalog model merely means the user picks a model later.
      }

      const result = await mutate((all, config) => {
        const existing = all[alias];
        if (existing) {
          const existingFamily = existing.family ?? family;
          const existingBaseUrl = existing.baseUrl ?? '';
          if (existingFamily !== family || existingBaseUrl !== baseUrl) {
            return `Alias "${alias}" already uses ${existingFamily} / ${existingBaseUrl || 'default endpoint'}. Choose a different alias.`;
          }
          if (existing.type && existing.type !== type) {
            return `Alias "${alias}" already belongs to provider type "${existing.type}".`;
          }
          return `Auth profile "${alias}" already exists. Choose another alias or manage its keys explicitly.`;
        }

        const provider: ProviderConfig = existing ?? { type, family };
        provider.type = type;
        provider.family = family;
        if (baseUrl) provider.baseUrl = baseUrl;
        else delete provider.baseUrl;
        if (models.length > 0) provider.models = models;
        else if (setup.source === 'custom') delete provider.models;
        if (envVars.length > 0) provider.envVars = envVars;
        else if (setup.source === 'custom') delete provider.envVars;

        const keys = normalizeKeys(provider);
        if (keys.some((key) => key.label === keyLabel)) {
          return `Key alias "${keyLabel}" already exists for "${alias}". Pick another key alias or update that key.`;
        }
        keys.push({ label: keyLabel, apiKey, createdAt: nowIso() });
        writeKeysBack(provider, keys);
        if (!provider.activeKey) provider.activeKey = keyLabel;
        all[alias] = provider;
        if ((!config['provider'] || !config['model']) && catalogDefaultModel) {
          config['provider'] = alias;
          config['model'] = catalogDefaultModel;
        }
        return null;
      });
      return result;
    },

    async saveProviderEdit(edit: AuthProviderEdit): Promise<string | null> {
      const providerId = edit.providerId.trim();
      const family = validateFamily(edit.family);
      if (!providerId) return 'Provider id is required.';
      if (!family) return 'Choose a supported protocol family.';
      const list = (value: string): string[] =>
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      const baseUrl = edit.baseUrl.trim();
      const models = list(edit.models);
      const envVars = list(edit.envVars);
      return mutate((all) => {
        const provider = all[providerId];
        if (!provider) return `Provider "${providerId}" no longer in config.`;
        provider.family = family;
        if (baseUrl) provider.baseUrl = baseUrl;
        else delete provider.baseUrl;
        if (models.length > 0) provider.models = models;
        else delete provider.models;
        if (envVars.length > 0) provider.envVars = envVars;
        else delete provider.envVars;
        return null;
      });
    },

    async getModelEdit(providerId: string, modelId: string): Promise<AuthModelEdit | null> {
      const provider = (await loadProviders())[providerId];
      if (!provider || !hasEditableModel(provider, modelId)) return null;
      const details = provider.customModels?.[modelId];
      const modelsDev = details?.modelsDev ?? {};
      const limit = modelsDev['limit'] as Record<string, unknown> | undefined;
      const cost = modelsDev['cost'] as Record<string, unknown> | undefined;
      return {
        providerId,
        modelId,
        name: typeof modelsDev['name'] === 'string' ? modelsDev['name'] : '',
        contextWindow: limit?.['context'] === undefined ? '' : String(limit['context']),
        maxOutput:
          details?.maxOutput === undefined
            ? limit?.['output'] === undefined
              ? ''
              : String(limit['output'])
            : String(details.maxOutput),
        costInput: cost?.['input'] === undefined ? '' : String(cost['input']),
        costOutput: cost?.['output'] === undefined ? '' : String(cost['output']),
      };
    },

    async saveModelEdit(edit: AuthModelEdit): Promise<string | null> {
      const parse = (value: string, label: string): number | string | undefined => {
        if (!value.trim()) return undefined;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0
          ? number
          : `${label} must be a non-negative number.`;
      };
      const context = parse(edit.contextWindow, 'Context window');
      const output = parse(edit.maxOutput, 'Max output');
      const inputCost = parse(edit.costInput, 'Input cost');
      const outputCost = parse(edit.costOutput, 'Output cost');
      for (const value of [context, output, inputCost, outputCost])
        if (typeof value === 'string') return value;
      return mutate((all) => {
        const provider = all[edit.providerId];
        if (!provider || !hasEditableModel(provider, edit.modelId))
          return `Model "${edit.modelId}" no longer exists.`;
        const existing = provider.customModels?.[edit.modelId] ?? {};
        const modelsDev = { ...(existing.modelsDev ?? {}) } as Record<string, unknown>;
        if (edit.name.trim()) modelsDev['name'] = edit.name.trim();
        else delete modelsDev['name'];
        const limit = { ...((modelsDev['limit'] as Record<string, unknown>) ?? {}) };
        if (context === undefined) delete limit['context'];
        else limit['context'] = context;
        // Max output lives in `maxOutput`, the key the output-limit resolver
        // reads; `modelsDev.limit.output` is catalog metadata it ignores.
        delete limit['output'];
        if (Object.keys(limit).length) modelsDev['limit'] = limit;
        else delete modelsDev['limit'];
        const cost = { ...((modelsDev['cost'] as Record<string, unknown>) ?? {}) };
        if (inputCost === undefined) delete cost['input'];
        else cost['input'] = inputCost;
        if (outputCost === undefined) delete cost['output'];
        else cost['output'] = outputCost;
        if (Object.keys(cost).length) modelsDev['cost'] = cost;
        else delete modelsDev['cost'];
        if (!provider.customModels) provider.customModels = {};
        const { modelsDev: _previousModelsDev, maxOutput: _previousMaxOutput, ...kept } = existing;
        provider.customModels[edit.modelId] = {
          ...kept,
          ...(typeof output === 'number' ? { maxOutput: output } : {}),
          ...(Object.keys(modelsDev).length ? { modelsDev } : {}),
        };
        return null;
      });
    },
  };
}
