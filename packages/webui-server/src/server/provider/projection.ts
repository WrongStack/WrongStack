import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { ProviderConfig } from '@wrongstack/core/types';
import { probeLocalLlm } from '@wrongstack/runtime/probe';
import { maskedKey, normalizeKeys } from './keys-records.js';

/**
 * Wire shape of one saved provider as broadcast over `providers.saved`.
 * The WebUI's `<ProviderModelsPanel>` consumes this — when
 * `pickedModelId` / `models` is missing, the panel renders the empty
 * state.
 */
export interface SavedProviderView {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  /** Saved model allowlist, verbatim (undefined / [] both possible). */
  models?: string[] | undefined;
  /** Per-model metadata (display name, output limits, capability overrides). */
  customModels?: ProviderConfig['customModels'] | undefined;
  /** First entry of `models`, or undefined when the list is empty/unset. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

/**
 * Canonical projection from in-memory `ProviderConfig` to the
 * `providers.saved` wire shape. Pure (no I/O) so it's unit-tested in
 * isolation — see `tests/server/provider-handlers-projection.test.ts`.
 *
 * Secrets never leave: every key is run through `maskedKey` before it
 * reaches the wire.
 */
export function projectSavedProviders(
  providers: Record<string, ProviderConfig>,
): SavedProviderView[] {
  return Object.entries(providers).map(([id, cfg]) => {
    const keys = normalizeKeys(cfg);
    const models = cfg.models;
    const view: SavedProviderView = {
      id,
      family: cfg.family ?? id,
      baseUrl: cfg.baseUrl,
      models,
      customModels: cfg.customModels,
      apiKeys: keys.map((k) => ({
        label: k.label,
        maskedKey: maskedKey(k.apiKey),
        isActive: k.label === cfg.activeKey,
        createdAt: k.createdAt,
      })),
    };
    const picked = models && models.length > 0 ? models[0] : undefined;
    if (picked !== undefined) view.pickedModelId = picked;
    return view;
  });
}

/** Shared scrubber for probe error/body redaction. */
export const probeScrubber = new DefaultSecretScrubber();

/**
 * Probe a saved provider's OpenAI-compatible `/v1/models` and map the
 * discovered ids into the minimal model-descriptor shape the WebUI dropdown
 * needs. Used as a fallback when a config-only custom provider (no saved
 * `models` allowlist, absent from models.dev) would otherwise resolve to an
 * empty list. Returns `[]` on any failure — the caller treats that as "no
 * models" (unchanged behaviour).
 */
export async function probeModelDescriptors(
  cfg: ProviderConfig,
): Promise<Array<{ id: string; name: string; capabilities: [] }>> {
  if (!cfg.baseUrl) return [];
  try {
    const keys = normalizeKeys(cfg);
    const active = keys.find((k) => k.label === cfg.activeKey) ?? keys[0];
    const result = await probeLocalLlm({
      baseUrl: cfg.baseUrl,
      apiKey: active?.apiKey,
      noAuth: false,
      scrubber: probeScrubber,
    });
    if (!result.ok || !result.modelIds) return [];
    return result.modelIds.map((id) => ({ id, name: id, capabilities: [] as [] }));
  } catch {
    return [];
  }
}
