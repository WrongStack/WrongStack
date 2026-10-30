import { type EngineState, entries } from './engine-state';

export interface ProviderChoice {
  id: string;
  name: string;
  family: string;
  saved: boolean;
  keys: Array<{
    label: string;
    maskedKey: string;
    active: boolean;
    authMethod?: string | undefined;
    expiresAt?: string | undefined;
  }>;
  /** Saved model allowlist; null when every catalog model is offered. */
  models?: string[] | null;
  /** Saved endpoint override; empty when the provider's own endpoint is used. */
  baseUrl?: string;
}
export function providerChoices(state: EngineState): ProviderChoice[] {
  const choices = new Map<string, ProviderChoice>();
  for (const row of entries(state.results['provider.catalog']?.['providers'])) {
    if (typeof row['id'] === 'string')
      choices.set(row['id'], {
        id: row['id'],
        name: String(row['name'] ?? row['id']),
        family: String(row['family'] ?? ''),
        saved: false,
        keys: [],
      });
  }
  for (const row of entries(state.results['providers.saved']?.['providers'])) {
    if (typeof row['id'] !== 'string') continue;
    const known = choices.get(row['id']);
    choices.set(row['id'], {
      id: row['id'],
      name: known?.name ?? row['id'],
      family: String(row['family'] ?? known?.family ?? ''),
      saved: true,
      models: Array.isArray(row['models'])
        ? row['models'].filter((model): model is string => typeof model === 'string')
        : null,
      baseUrl: typeof row['baseUrl'] === 'string' ? row['baseUrl'] : '',
      keys: entries(row['apiKeys']).map((key) => ({
        label: String(key['label']),
        maskedKey: String(key['maskedKey'] ?? '••••'),
        active: key['isActive'] === true,
        ...(typeof key['authMethod'] === 'string' ? { authMethod: key['authMethod'] } : {}),
        ...(typeof key['expiresAt'] === 'string' ? { expiresAt: key['expiresAt'] } : {}),
      })),
    });
  }
  return [...choices.values()].sort(
    (a, b) => Number(b.saved) - Number(a.saved) || a.name.localeCompare(b.name),
  );
}
export function providerModels(
  state: EngineState,
  id: string,
): Array<{ id: string; name: string }> {
  const result = state.results['provider.models'];
  if (result?.['provider'] !== id) return [];
  return entries(result['models'])
    .filter((model) => typeof model['id'] === 'string')
    .map((model) => ({ id: String(model['id']), name: String(model['name'] ?? model['id']) }));
}
export interface ProviderDraft {
  mode: 'preset' | 'custom';
  id: string;
  apiKey: string;
  label: string;
  baseUrl: string;
  model: string;
  supportsTools: boolean;
  supportsVision?: boolean;
}
export function buildProviderSave(draft: ProviderDraft): {
  type: string;
  payload: Record<string, unknown>;
} {
  const id = draft.id.trim();
  if (
    !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(id) ||
    ['constructor', 'prototype', '__proto__'].includes(id.toLowerCase())
  )
    throw new Error('Use a provider ID containing letters, numbers, hyphens, or underscores.');
  const apiKey = draft.apiKey.trim();
  const label = draft.label.trim();
  if (draft.mode === 'preset') {
    if (!apiKey || !label) throw new Error('Enter an API key and a key label.');
    return { type: 'key.add', payload: { providerId: id, label, apiKey } };
  }
  let url: URL;
  try {
    url = new URL(draft.baseUrl.trim());
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS base URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) =>
      /^(api[-_]?key|token|password|authorization)$/i.test(key),
    )
  )
    throw new Error(
      'Use an HTTP(S) base URL without credentials; enter credentials in the API key field.',
    );
  const model = draft.model.trim();
  if (!model) throw new Error('Enter the model ID supported by your endpoint.');
  return {
    type: 'provider.add',
    payload: {
      id,
      type: 'openai-compatible',
      family: 'openai-compatible',
      baseUrl: url.toString().replace(/\/$/, ''),
      ...(apiKey ? { apiKey } : {}),
      models: [model],
      customModels: {
        [model]: {
          name: model,
          capabilities: {
            streaming: true,
            tools: draft.supportsTools,
            ...(draft.supportsVision !== undefined ? { vision: draft.supportsVision } : {}),
          },
        },
      },
    },
  };
}
