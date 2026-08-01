/**
 * FallbackProfileManager — centralized, decoupled fallback profile resolution.
 *
 * Every consumer (fallback-model, council orchestrator, one-shot LLM, plugins)
 * resolves its fallback chain through this single manager instead of parsing
 * config.fallbackProfiles independently. This guarantees consistent resolution,
 * provider-health filtering, and a single reload point on config changes.
 *
 * Design:
 * - Stable service identity: `reload()` atomically replaces the manager's
 *   immutable config/profile snapshot so injected consumers stay live.
 * - Immutable outputs: every resolved chain is frozen.
 * - Provider-aware: each profile entry is checked against live provider config
 *   (has API key?) before inclusion.
 * - Zero coupling: consumers only see `readonly FallbackChainEntry[]` —
 *   no awareness of profile names, config shape, or provider internals.
 */

import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import type { Config, ProviderConfig } from '../types/config.js';
import { evaluateModelCalendar } from './model-availability-calendar.js';
import { parseModelRef } from './model-ref.js';

// ── Public types ────────────────────────────────────────────────────────────

/** One resolved entry in a fallback chain. */
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (hasText(entry.apiKey)) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => hasText(k?.apiKey))) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => hasText(process.env[v])))
    return true;
  return false;
}

function visibleProviderModels(
  config: Config,
  providerId: string,
  providerModels: string[],
): string[] {
  const entry = config.providers?.[providerId];
  return entry?.models !== undefined ? [...entry.models] : providerModels;
}

function buildProfiles(config: Config): ReadonlyMap<string, readonly string[]> {
  const entries = new Map<string, readonly string[]>();
  for (const [name, chain] of Object.entries(config.fallbackProfiles ?? {})) {
    if (Array.isArray(chain) && chain.length > 0) {
      entries.set(name, Object.freeze([...chain]));
    }
  }
  return entries;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class FallbackProfileManager {
  /** Immutable snapshot of config.fallbackProfiles for the active config. */
  private profiles: ReadonlyMap<string, readonly string[]>;
  /** Active frozen config snapshot for provider lookups. */
  private config: Config;
  /** Optional shared runtime status tracker. */
  private statusTracker: ProviderModelStatusTracker | undefined;

  constructor(config: Config, opts?: { statusTracker?: ProviderModelStatusTracker | undefined }) {
    this.config = config;
    this.profiles = buildProfiles(config);
    this.statusTracker = opts?.statusTracker;
  }

  /**
   * Bind (or replace) the shared runtime status tracker.
   * Called by the boot path after the tracker is created.
   */
  setStatusTracker(tracker: ProviderModelStatusTracker | undefined): void {
    this.statusTracker = tracker;
  }

  // ── Profile existence ──────────────────────────────────────────────────

  hasProfile(name: string): boolean {
    return this.profiles.has(name);
  }

  listProfiles(): readonly string[] {
    return Object.freeze([...this.profiles.keys()]);
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve a named fallback profile to a validated, provider-filtered chain.
   *
   * Returns an empty chain when:
   * - The profile doesn't exist.
   * - Every entry's provider is missing, has no key, or has no matching model.
   *
   * @param name - Profile name from config.fallbackProfiles.
   * @param defaultProvider - Used when an entry has no explicit provider.
   * @param exclude - Optional { providerId, model } to skip (avoid self-fallback).
   */
  resolve(
    name: string,
    opts: {
      defaultProvider?: string | undefined;
      exclude?: { providerId: string; model: string } | undefined;
    } = {},
  ): FallbackChain {
    const defaultProvider = opts.defaultProvider ?? this.config.provider;
    const chain = this.profiles.get(name);
    if (!chain) return FREEZER_EMPTY;

    const excludeKey = opts.exclude
      ? `${opts.exclude.providerId}/${opts.exclude.model}`
      : undefined;

    const resolved: FallbackChainEntry[] = [];
    const seen = new Set<string>();

    for (const ref of chain) {
      const parsed = parseModelRef(ref);
      if (!parsed.model) continue;

      const providerId = parsed.provider ?? defaultProvider;
      const key = `${providerId}/${parsed.model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip self-reference
      if (excludeKey && key === excludeKey) continue;

      const health = this.checkProvider(providerId);
      if (!health.usable) continue;

      // Skip entries that are blocked by the runtime status tracker
      if (this.statusTracker && !this.statusTracker.isAvailable(providerId, parsed.model)) continue;
      if (
        !evaluateModelCalendar(this.config.modelAvailabilitySchedule, providerId, parsed.model)
          .allowed
      )
        continue;

      // Skip entries whose provider has no matching model in its allow-list
      // (provider may restrict which models are available).
      const allowedModels = this.config.providers?.[providerId]?.models;
      if (allowedModels && !allowedModels.includes(parsed.model)) continue;

      resolved.push({
        providerId,
        model: parsed.model,
        providerSwitched: providerId !== (opts.exclude?.providerId ?? this.config.provider),
      });
    }

    return Object.freeze(resolved);
  }

  /**
   * Resolve the effective fallback chain for a session: explicit fallbackModels
   * first, then named profile, then smart default (unless disabled).
   *
   * Mirrors the previous `effectiveFallbackChain()` logic but centralized.
   */
  resolveEffective(
    opts: {
      fallbackModels?: readonly string[] | undefined;
      fallbackProfile?: string | undefined;
      fallbackAuto?: boolean | undefined;
      exclude?: { providerId: string; model: string } | undefined;
    } = {},
  ): FallbackChain {
    const bridge = this.resolveBridge(opts.exclude);
    let selected: FallbackChain = FREEZER_EMPTY;

    // 1. Explicit fallbackModels (already resolved refs)
    //    Only return if non-empty; empty chain falls through to next source.
    if (opts.fallbackModels && opts.fallbackModels.length > 0) {
      const resolved = this.resolveRefs(opts.fallbackModels, opts.exclude);
      if (resolved.length > 0) selected = resolved;
    }

    // 2. Named profile — only return if non-empty
    if (selected.length === 0 && opts.fallbackProfile) {
      const resolved = this.resolve(opts.fallbackProfile, { exclude: opts.exclude });
      if (resolved.length > 0) selected = resolved;
    }

    // 3. Smart default
    if (selected.length === 0 && opts.fallbackAuto !== false) {
      selected = this.smartDefault(opts.exclude);
    }

    if (bridge.length === 0) return selected;
    if (selected.length === 0) return bridge;
    const seen = new Set(bridge.map((entry) => `${entry.providerId}/${entry.model}`));
    return Object.freeze([
      ...bridge,
      ...selected.filter((entry) => !seen.has(`${entry.providerId}/${entry.model}`)),
    ]);
  }

  /** Resolve the optional, fully-qualified emergency continuity route. */
  resolveBridge(exclude?: { providerId: string; model: string }): FallbackChain {
    const ref = this.config.fallbackBridge?.trim();
    if (!ref) return FREEZER_EMPTY;
    const parsed = parseModelRef(ref);
    if (!parsed.provider || !parsed.model) return FREEZER_EMPTY;
    return this.resolveRefs([ref], exclude);
  }

  /**
   * Resolve every usable configured target as an uncapped last-resort chain.
   * Normal smart defaults stay bounded; callers append this only after the
   * preferred chain and only when automatic fallback is enabled.
   */
  resolveAllConfigured(exclude?: { providerId: string; model: string }): FallbackChain {
    return this.smartDefault(exclude, Number.POSITIVE_INFINITY);
  }

  // ── Provider availability (read-only) ──────────────────────────────────

  checkProvider(providerId: string): ProviderHealth {
    const entry = this.config.providers?.[providerId];
    const isPrimary = providerId === this.config.provider;
    const hasKey = providerHasKey(entry) || (isPrimary && hasText(this.config.apiKey));
    const hasEndpoint = hasText(entry?.baseUrl) || (isPrimary && hasText(this.config.baseUrl));
    const hasModels =
      (Array.isArray(entry?.models) && entry.models.length > 0) ||
      (isPrimary && hasText(this.config.model));
    return Object.freeze({
      providerId,
      hasKey,
      hasEndpoint,
      hasModels,
      usable: hasKey || hasEndpoint,
    });
  }

  // ── Rebuild on config change ───────────────────────────────────────────

  /**
   * Atomically replace the active immutable snapshot while preserving this
   * service identity for every injected consumer.
   */
  reload(newConfig: Config): void {
    this.config = newConfig;
    this.profiles = buildProfiles(newConfig);
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /**
   * Resolve an array of model ref strings (from explicit fallbackModels config).
   * Public so consumers like one-shot-llm can use it directly.
   */
  resolveRefs(
    refs: readonly string[],
    exclude?: { providerId: string; model: string },
  ): FallbackChain {
    const excludeKey = exclude ? `${exclude.providerId}/${exclude.model}` : undefined;
    const resolved: FallbackChainEntry[] = [];
    const seen = new Set<string>();

    for (const ref of refs) {
      const parsed = parseModelRef(ref);
      if (!parsed.model) continue;

      const providerId = parsed.provider ?? this.config.provider;
      const key = `${providerId}/${parsed.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (excludeKey && key === excludeKey) continue;

      // Skip entries blocked by the runtime status tracker
      if (this.statusTracker && !this.statusTracker.isAvailable(providerId, parsed.model)) continue;
      if (
        !evaluateModelCalendar(this.config.modelAvailabilitySchedule, providerId, parsed.model)
          .allowed
      )
        continue;

      resolved.push({
        providerId,
        model: parsed.model,
        providerSwitched: providerId !== (exclude?.providerId ?? this.config.provider),
      });
    }

    return Object.freeze(resolved);
  }

  /**
   * Derive a smart default chain from configured providers when nothing
   * explicit is set. Same-provider alternatives first, then cross-provider.
   * Limited to 4 entries to avoid burning through models on a transient blip.
   */
  private smartDefault(
    exclude?: { providerId: string; model: string },
    maxCandidates = 4,
  ): FallbackChain {
    const leaderProvider = this.config.provider;
    const leaderModel = this.config.model;
    const providers = this.config.providers ?? {};
    const favoriteSet = new Set(
      (this.config.favoriteModels ?? []).map((ref) => {
        const p = parseModelRef(ref);
        return `${p.provider ?? leaderProvider}/${p.model}`;
      }),
    );
    const hasFavorites = favoriteSet.size > 0;
    const favoritesOnly = this.config.favoriteModelsOnly === true;
    const seen = new Set<string>();
    const favorites: string[] = [];
    const sameProvider: string[] = [];
    const crossProvider: string[] = [];

    const excludeKey = exclude ? `${exclude.providerId}/${exclude.model}` : undefined;

    const ids = Object.keys(providers).sort((a, b) =>
      a === leaderProvider ? -1 : b === leaderProvider ? 1 : a.localeCompare(b),
    );

    for (const id of ids) {
      const entry = providers[id];
      if (!this.checkProvider(id).usable) continue;
      // Skip the entire provider if it's blocked at the provider level
      // (all its models would be blocked too, but we check per-model below)
      const models = visibleProviderModels(this.config, id, entry?.models ?? []);
      for (const model of models) {
        if (id === leaderProvider && model === leaderModel) continue;
        const ref = `${id}/${model}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (excludeKey && ref === excludeKey) continue;
        // Skip models blocked by the runtime status tracker
        if (this.statusTracker && !this.statusTracker.isAvailable(id, model)) continue;
        if (!evaluateModelCalendar(this.config.modelAvailabilitySchedule, id, model).allowed)
          continue;
        if (favoriteSet.has(ref)) {
          favorites.push(ref);
          continue;
        }
        if (favoritesOnly && hasFavorites) continue;
        (id === leaderProvider ? sameProvider : crossProvider).push(ref);
      }
    }

    const ordered = [...favorites, ...sameProvider, ...crossProvider];
    const all = Number.isFinite(maxCandidates)
      ? ordered.slice(0, Math.max(0, maxCandidates))
      : [...ordered];
    // A provider-wide quota makes every sibling model useless. Keep one
    // cross-provider escape hatch in the bounded smart chain when available.
    const firstCrossProvider = ordered.find((ref) => {
      const parsed = parseModelRef(ref);
      return (parsed.provider ?? leaderProvider) !== leaderProvider;
    });
    if (
      all.length > 0 &&
      firstCrossProvider &&
      !all.some((ref) => {
        const parsed = parseModelRef(ref);
        return (parsed.provider ?? leaderProvider) !== leaderProvider;
      })
    ) {
      all[all.length - 1] = firstCrossProvider;
    }
    return Object.freeze(
      all.map((ref) => {
        const p = parseModelRef(ref);
        return {
          providerId: p.provider ?? leaderProvider,
          model: p.model,
          providerSwitched:
            (p.provider ?? leaderProvider) !== (exclude?.providerId ?? leaderProvider),
        } satisfies FallbackChainEntry;
      }),
    );
  }
}

const FREEZER_EMPTY: FallbackChain = Object.freeze([]);
