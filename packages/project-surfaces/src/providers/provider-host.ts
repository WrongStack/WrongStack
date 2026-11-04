import type { ModelInUse } from './quota-model';

/** A server frame as the provider surfaces receive it; each reads its own reply fields. */
export interface ProviderMessage {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: each surface reads its own reply fields.
  payload: any;
}

/** The engine connection the provider surfaces talk over. */
export interface ProviderClient {
  send(message: { type: string; payload?: Record<string, unknown> | undefined }): void;
  on(type: string, handler: (message: ProviderMessage) => void): () => void;
}

/** The model preferences the provider test reads and edits (the engine's shared prefs). */
export interface ModelPrefs {
  favoriteModels: readonly string[];
  disabledModels: readonly string[];
  disabledProviders: readonly string[];
  fallbackModels: readonly string[];
  fallbackProfiles: Readonly<Record<string, readonly string[]>>;
}
export interface ModelPrefsPatch {
  favoriteModels?: string[] | undefined;
  disabledModels?: string[] | undefined;
  disabledProviders?: string[] | undefined;
  fallbackModels?: string[] | undefined;
  fallbackProfiles?: Record<string, string[]> | undefined;
}

/**
 * What the provider test and plan-quota surfaces read from their application. Members named
 * `use…` are React hooks.
 */
export interface ProviderHost {
  /** The connection, once there is one. */
  useClient(): ProviderClient | null;
  useConnected(): boolean;
  /** The provider and model the next turn runs on (bare model references resolve to it). */
  useActiveModel(): { provider: string; model: string };
  /** The model preferences, and a writer that saves a patch of them. */
  useModelPrefs(): ModelPrefs & { update(patch: ModelPrefsPatch): void };
  /** What the open conversations and running sub-agents use now (marked on the quota page). */
  useModelsInUse(): ModelInUse[];
  /** Leaves the page for the conversation. */
  back?: (() => void) | undefined;
  /** Opens the provider settings. */
  openSettings?: (() => void) | undefined;
}
