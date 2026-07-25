import type { ResolvedProvider } from '@wrongstack/core/types';
import { LOCAL_LLM_PRESETS } from '../auth-menu/local-presets.js';

export function appendLocalPresetProviders(merged: ResolvedProvider[]): ResolvedProvider[] {
  const existing = new Set(merged.map((p) => p.id));
  for (const preset of LOCAL_LLM_PRESETS) {
    if (existing.has(preset.id)) continue;
    merged.push({
      id: preset.id,
      name: preset.label,
      family: 'openai-compatible',
      apiBase: preset.defaultBaseUrl,
      envVars: [],
      models: [],
    });
  }
  return merged;
}
