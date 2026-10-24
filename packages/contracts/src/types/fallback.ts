/** Fallback-chain contracts shared by the provider runner, one-shot LLM and kernel token. */

import type { Config } from './config.js';
import type { ProviderStatusTrackerPort } from './provider-status.js';

export interface FallbackChainEntry {
  /** Resolved provider id. */
  readonly providerId: string;
  /** Resolved model id. */
  readonly model: string;
  /** Whether this entry uses a different provider than the primary. */
  readonly providerSwitched: boolean;
}

/** Immutable fallback chain returned by the manager. */
export type FallbackChain = readonly FallbackChainEntry[];

/**
 * Configuration-level provider health used while resolving fallback chains.
 *
 * This deliberately answers whether the runtime has enough configuration to
 * construct the provider; it does not perform a network probe. Keyless
 * self-hosted endpoints are usable when they declare a `baseUrl`.
 */
export interface ProviderHealth {
  readonly providerId: string;
  readonly hasKey: boolean;
  readonly hasEndpoint: boolean;
  readonly hasModels: boolean;
  readonly usable: boolean;
}

type PairRef = { providerId: string; model: string };

/**
 * Structural contract of the fallback-chain resolver. Implementation:
 * `core/fallback-profile-manager.ts`.
 */
export interface FallbackProfileManagerPort {
  setStatusTracker(tracker: ProviderStatusTrackerPort | undefined): void;
  hasProfile(name: string): boolean;
  listProfiles(): readonly string[];
  activeProfileName(): string | undefined;
  resolve(
    name: string,
    opts?: {
      defaultProvider?: string | undefined;
      exclude?: PairRef | undefined;
    },
  ): FallbackChain;
  resolveEffective(opts?: {
    fallbackModels?: readonly string[] | undefined;
    fallbackProfile?: string | undefined;
    fallbackAuto?: boolean | undefined;
    exclude?: PairRef | undefined;
  }): FallbackChain;
  resolveBridge(exclude?: PairRef): FallbackChain;
  resolveAllConfigured(exclude?: PairRef): FallbackChain;
  resolveCandidates(
    current: PairRef,
    opts?: {
      fallbackModels?: readonly string[] | undefined;
      fallbackProfile?: string | undefined;
      fallbackAuto?: boolean | undefined;
      primary?: PairRef | undefined;
      closedWorld?: boolean | undefined;
    },
  ): FallbackChain;
  checkProvider(providerId: string): ProviderHealth;
  reload(newConfig: Config): void;
  /** Resolve explicit model ref strings (`fallbackModels` config) into a chain. */
  resolveRefs(refs: readonly string[], exclude?: PairRef): FallbackChain;
}
