import type { WrongStackWebSocketClient } from '@/lib/ws-client';

// ── Types (shared with index) ──

export interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

export interface SavedProvider {
  id: string;
  /** Served by the host itself (the ACP leader): no saved record, keys or connection to remove. */
  hostServed?: boolean | undefined;
  type?: string | undefined;
  family?: string | undefined;
  baseUrl?: string | undefined;
  cloud?: import('@wrongstack/core/cloud-provider').NativeCloudSettings | undefined;
  /** Saved model allowlist, in the order the user pinned them. */
  models?: string[] | undefined;
  /** Per-model metadata (display name, output limits, capability overrides). */
  customModels?:
    | Record<
        string,
        {
          name?: string | undefined;
          maxOutput?: number | undefined;
          capabilities?:
            | {
                maxContext?: number | undefined;
                tools?: boolean | undefined;
                vision?: boolean | undefined;
                reasoning?: boolean | undefined;
                streaming?: boolean | undefined;
                jsonMode?: boolean | undefined;
              }
            | undefined;
        }
      >
    | undefined;
  /** First entry of `models`, surfaced for the panel's "Using" line. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

export type ProviderTab = 'catalog' | 'saved';

// ── Props ──

export interface ProviderSectionProps {
  /** Currently selected provider id. */
  activeProvider: string;
  /** Catalog providers list. */
  catalogProviders: CatalogProvider[];
  /** Loading flag. */
  isLoadingCatalog: boolean;
  /** Saved providers list. */
  savedProviders: SavedProvider[];
  /** Loading flag. */
  isLoadingSaved: boolean;
  /** Which sub-tab is active. */
  providerTab: ProviderTab;
  setProviderTab: (v: ProviderTab) => void;
  /** Called when a catalog provider is selected. */
  onSelectProvider: (id: string) => void;
  /** Called to add an API key. */
  onAddKey: (providerId: string, label: string, value: string) => Promise<boolean> | void;
  /** Called to delete an API key. */
  onDeleteKey: (providerId: string, label: string) => Promise<boolean> | void;
  /** Called to set a key as active. */
  onSetActiveKey: (providerId: string, label: string) => Promise<boolean> | void;
  /** Called to add a custom provider. */
  onAddProvider: (
    id: string,
    family: string,
    baseUrl?: string | undefined,
    apiKey?: string,
    models?: string[] | undefined,
    customModels?:
      | Record<
          string,
          {
            name?: string | undefined;
            maxOutput?: number | undefined;
            capabilities?: Record<string, unknown> | undefined;
          }
        >
      | undefined,
    providerType?: string | undefined,
  ) => Promise<boolean> | void;
  /** Called to remove a saved provider. */
  onRemoveProvider: (providerId: string) => Promise<boolean> | void;
  /** Called when a saved provider model is picked. */
  onPickProviderModel: (providerId: string, modelId: string) => void;
  /**
   * Provider ids switched off entirely (`Config.disabledProviders`). Every
   * model of a listed provider is skipped in fallback routing and pickers.
   */
  disabledProviders: string[];
  /** Flip one provider's disabled state (persisted through `updatePrefs`). */
  onToggleProviderDisabled: (providerId: string) => void;
  /** WebSocket client used for saved-provider model probing/clearing. */
  ws: WrongStackWebSocketClient;
  /** Search filter text. */
  catalogQuery: string;
  setCatalogQuery: (v: string) => void;
}
