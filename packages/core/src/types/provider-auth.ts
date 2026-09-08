import type { ProviderApiKey } from './config/providers.js';
import type { ModelsRegistry, WireFamily } from './models-registry.js';

/** UI-safe metadata for an interactive provider authentication strategy. */
export interface ProviderAuthStrategyMetadata {
  /** Stable strategy id used by CLI/TUI/WebUI messages (for example `chatgpt`). */
  id: string;
  /** Default provider config id that receives the resulting credential. */
  providerId: string;
  /** Human-readable name shown in authentication pickers. */
  label: string;
  /** Optional short explanation shown below the label. */
  description?: string | undefined;
  /** Alternate CLI spellings accepted by the registry. */
  aliases?: readonly string[] | undefined;
  /** Interaction shapes this strategy may present. */
  interactionTypes: readonly ProviderAuthInteractionType[];
}

export type ProviderAuthInteractionType = 'browser' | 'device_code';

export type ProviderAuthInteraction =
  | {
      type: 'browser';
      authorizeUrl: string;
      /** False means the caller must offer a redirect URL / code paste fallback. */
      bound: boolean;
    }
  | {
      type: 'device_code';
      verificationUri: string;
      userCode: string;
    };

/** Persistence-agnostic result returned by a successful interactive login. */
export interface ProviderAuthOutcome {
  providerId: string;
  family: WireFamily;
  baseUrl?: string | undefined;
  /** Empty means live discovery was unavailable and must not clear a saved allowlist. */
  models: string[];
  credential: ProviderApiKey;
}

/** Live browser/device-code session owned by one authentication strategy. */
export interface ProviderAuthSession {
  strategyId: string;
  providerId: string;
  interaction: ProviderAuthInteraction;
  waitForCompletion(signal?: AbortSignal): Promise<ProviderAuthOutcome | null>;
  completeWithCode(input: string, signal?: AbortSignal): Promise<ProviderAuthOutcome>;
  close(): void;
}

/** Host services intentionally exposed to authentication strategies. */
export interface ProviderAuthBeginDeps {
  modelsRegistry?: ModelsRegistry | undefined;
}

/** Executable login strategy. Credential persistence remains a host responsibility. */
export interface ProviderAuthStrategy extends ProviderAuthStrategyMetadata {
  begin(deps?: ProviderAuthBeginDeps, signal?: AbortSignal): Promise<ProviderAuthSession>;
}
