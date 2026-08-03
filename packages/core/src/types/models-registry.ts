/**
 * Mirror of the models.dev/api.json schema. Top-level is keyed by provider id.
 * We keep `unknown` for fields we don't read so the cached payload stays faithful.
 */

import type { ReasoningConfig, ReasoningEffort } from './provider.js';

export type ModelsDevReasoningOption =
  | { type: 'toggle' }
  | { type: 'effort'; values?: ReasoningEffort[] | undefined }
  | { type: 'budget_tokens'; min?: number | undefined; max?: number | undefined };

export interface ModelsDevModel {
  id: string;
  name: string;
  family?: string | undefined;
  /**
   * One-line capability blurb. Not part of the upstream models.dev schema —
   * carried by our curated overlay (`packages/cli/data/providers.json`, synced
   * from raw GitHub) for subscription models like openai-codex.
   */
  description?: string | undefined;
  attachment?: boolean | undefined;
  reasoning?: boolean | undefined;
  /** Native models.dev reasoning controls; normalized to reasoningConfig by the registry. */
  reasoning_options?: ModelsDevReasoningOption | ModelsDevReasoningOption[] | undefined;
  /** Provider field that must be replayed for interleaved reasoning/tool turns. */
  interleaved?: { field?: string | undefined } | boolean | undefined;
  reasoningConfig?: ReasoningConfig | undefined;
  tool_call?: boolean | undefined;
  temperature?: boolean | undefined;
  knowledge?: string | undefined;
  release_date?: string | undefined;
  last_updated?: string | undefined;
  open_weights?: boolean | undefined;
  modalities?:
    | {
        input?: string[] | undefined;
        output?: string[] | undefined;
      }
    | undefined;
  cost?:
    | {
        input?: number | undefined;
        output?: number | undefined;
        cache_read?: number | undefined;
        cache_write?: number | undefined;
        cache_write_5m?: number | undefined;
        cache_write_1h?: number | undefined;
        /**
         * Unknown cost keys: upstream is NOT number-only (e.g. `tiers` is an
         * array of tier objects on ~300 models, census 2026-08-03). Keep this
         * index `unknown` — named keys above stay typed for consumers.
         */
        [k: string]: unknown;
      }
    | undefined;
  limit?:
    | {
        context?: number | undefined;
        output?: number | undefined;
      }
    | undefined;
  [k: string]: unknown;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  /** Env vars that hold the API key, in priority order. */
  env?: string[] | undefined;
  /** Identifies the wire format family (e.g. @ai-sdk/anthropic). */
  npm?: string | undefined;
  /** Default base URL when not provided by SDK defaults. */
  api?: string | undefined;
  /** Documentation URL. */
  doc?: string | undefined;
  models: Record<string, ModelsDevModel>;
}

export type ModelsDevPayload = Record<string, ModelsDevProvider>;

/**
 * Canonical wire-format families WrongStack knows how to speak natively.
 * Used by the provider registry to pick a transport.
 */
export type WireFamily =
  | 'anthropic'
  | 'anthropic-oauth'
  | 'openai'
  | 'openai-compatible'
  | 'openai-codex'
  | 'github-copilot'
  | 'google'
  | 'unsupported';

export interface ResolvedProvider {
  id: string;
  name: string;
  family: WireFamily;
  apiBase?: string | undefined;
  envVars: string[];
  doc?: string | undefined;
  models: ModelsDevModel[];
  npm?: string | undefined;
}

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    reasoning: boolean;
    maxContext: number;
    maxOutput?: number | undefined;
    knowledge?: string | undefined;
    reasoningConfig?: ReasoningConfig | undefined;
  };
  cost?: ModelsDevModel['cost'] | undefined;
}

export interface ModelsRegistry {
  /** Load (from cache or network). Idempotent; second call returns cached value. */
  load(opts?: { force?: boolean | undefined }): Promise<ModelsDevPayload>;
  /** Force-refresh from network and overwrite cache. */
  refresh(): Promise<ModelsDevPayload>;
  /** All providers, classified by wire family. */
  listProviders(): Promise<ResolvedProvider[]>;
  /** A single provider by id, or undefined. */
  getProvider(id: string): Promise<ResolvedProvider | undefined>;
  /** A model lookup with capabilities + cost. */
  getModel(providerId: string, modelId: string): Promise<ResolvedModel | undefined>;
  /** Suggest a default model for the given provider (latest by release_date). */
  suggestModel(providerId: string): Promise<string | undefined>;
  /** Cache freshness in seconds since last successful network fetch (Infinity if never). */
  ageSeconds(): Promise<number>;
}
