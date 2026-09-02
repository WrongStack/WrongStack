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

/**
 * Normalize a "list of model refs" config field to `readonly string[] | undefined`.
 *
 * The credential/routing hot-reload watcher clears absent fields by writing
 * `null` (`provider-runtime-setup.ts`: `mergedPatch[key] = merged[key] ?? null`),
 * and `patchConfig` is a plain spread — so `config.fallbackModels` can be `null`
 * at runtime even though the declared type is `string[] | undefined`. A bare
 * `!== undefined` check then walks straight into `null.length`, which threw
 * INSIDE the fallback chain resolver: the TypeError replaced the 429 that
 * triggered the hop and no fallback was ever attempted.
 *
 * Every entry point that reads such a field goes through here, so a null (or
 * any non-array) simply means "not configured".
 */
function asRefList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? (value as readonly string[]) : undefined;
}

/** Same normalization for the single-profile-name fields. */
function asProfileName(value: unknown): string | undefined {
  return hasText(value) ? value : undefined;
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
  return Array.isArray(entry?.models) ? [...entry.models] : providerModels;
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

  /**
   * The profile the session has selected (`config.fallbackProfile`, set by
   * `/fallback profile use <name>`), or undefined when none is selected or the
   * name no longer resolves to a defined profile.
   *
   * Consulted by every resolution entry point when the caller does not name a
   * profile itself. Without this the leader — which passes no profile — could
   * never use a named profile at all: `config.fallbackProfiles` was reachable
   * only by copying a chain into `fallbackModels`.
   */
  activeProfileName(): string | undefined {
    const name = asProfileName(this.config.fallbackProfile);
    return name && this.profiles.has(name) ? name : undefined;
  }

  // ── Resolution ─────────────────────────────────────────────────────────

  /**
   * Resolve a named fallback profile to a validated, provider-filtered chain.
   *
   * Returns an empty chain when the profile doesn't exist, or when every entry
   * is excluded, quarantined, or blacked out.
   *
   * Filtering is intentionally identical to {@link resolveRefs} (the explicit
   * `fallbackModels` path): the self-exclusion, the runtime status tracker,
   * and the availability calendar — nothing else. Anything a named profile
   * drops, an explicit chain drops too, and vice versa. Profiles used to apply
   * two extra filters (provider "usability" and the `providers[].models`
   * snapshot) that the explicit path did not, which silently rerouted roles
   * pinned to a profile onto a different model than the one configured.
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

      // NOTE: `checkProvider().usable` is deliberately NOT applied here.
      // It reports whether the CONFIG carries a key or endpoint for the
      // provider, which is a false negative whenever the credential reaches
      // the provider by some other route. The explicit-refs path
      // (`resolveRefs`) never applied it, so the same ref survived in
      // `fallbackModels` while vanishing from every named profile. An entry
      // that genuinely cannot be constructed throws in `buildProvider`, and
      // the chain runner already logs it and moves to the next candidate —
      // one local construction attempt, no network call.

      // Skip entries that are blocked by the runtime status tracker
      if (this.statusTracker && !this.statusTracker.isAvailable(providerId, parsed.model)) continue;
      if (
        !evaluateModelCalendar(this.config.modelAvailabilitySchedule, providerId, parsed.model)
          .allowed
      )
        continue;

      // NOTE: `config.providers[id].models` is deliberately NOT used to drop
      // entries here. It is an unrefreshed snapshot (re-auth and provider
      // edits rewrite it), so filtering on it silently deleted profile entries
      // that were valid when the profile was written — and because
      // `resolveRefs` never applied the same filter, the identical ref stayed
      // alive in `fallbackModels` while vanishing from every named profile.
      // A model the provider no longer serves answers 404 → `invalid_request`,
      // which the chain runner already treats as "try the next candidate"
      // (see the per-entry failure note in `fallback-model.ts`). Losing one
      // doomed request beats silently rerouting a role to a different model.

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
    const explicitRefs = asRefList(opts.fallbackModels);
    // A caller that passes no profile inherits the session-selected one
    // (`/fallback profile use <name>`), mirroring how `fallbackModels` already
    // falls back to config in `resolveCandidates`.
    const profileName = asProfileName(opts.fallbackProfile) ?? this.activeProfileName();

    // 1. Explicit fallbackModels (already resolved refs)
    //    Only return if non-empty; empty chain falls through to next source.
    if (explicitRefs && explicitRefs.length > 0) {
      const resolved = this.resolveRefs(explicitRefs, opts.exclude);
      if (resolved.length > 0) selected = resolved;
    }

    // 2. Named profile — only return if non-empty
    if (selected.length === 0 && profileName) {
      const resolved = this.resolve(profileName, { exclude: opts.exclude });
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
   * Resolve every usable configured target as a bounded last-resort chain.
   * Normal smart defaults stay bounded; callers append this only after the
   * preferred chain and only when automatic fallback is enabled. The cap
   * ({@link MAX_LAST_RESORT_CANDIDATES}) prevents a config with many providers
   * from producing a degenerate chain of doomed requests during a systemic
   * outage — by this point the smart default, bridge, and default profile
   * have already failed.
   */
  resolveAllConfigured(exclude?: { providerId: string; model: string }): FallbackChain {
    return this.smartDefault(exclude, this.lastResortCap());
  }

  /**
   * Effective cap for the last-resort append. Reads the user-configurable
   * {@link Config.fallbackMaxLastResortCandidates} when set and valid;
   * otherwise falls back to the compiled-in default
   * {@link MAX_LAST_RESORT_CANDIDATES}.
   */
  private lastResortCap(): number {
    const configured = this.config.fallbackMaxLastResortCandidates;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
      return Math.floor(configured);
    }
    return MAX_LAST_RESORT_CANDIDATES;
  }

  /**
   * Build the complete fallback candidate chain shared by the agent-loop
   * extension and the one-shot orchestrator. Centralizes the bridge → primary →
   * selected → default-profile → all-configured ladder and the fromExplicitSource
   * gate so both consumers produce identical ordering and depth semantics.
   *
   * Layering (each step deduped against all prior):
   *  1. Bridge (emergency continuity route).
   *  2. Configured primary, when the live context drifted from it.
   *  3. The selected chain (explicit refs → named profile → smart default),
   *     via {@link resolveEffective}.
   *  4. The "default" profile — extra depth, ONLY when the chain was auto-derived.
   *  5. Every other configured provider — last resort, ONLY when the chain was
   *     auto-derived AND `effectiveFallbackAuto` is true.
   *
   * Returns the empty chain when `closedWorld` is true and no explicit
   * refs/profile resolved — a model allowlist never leaks to unlisted models.
   *
   * @internal caller-aware options (primary, closedWorld) are accepted because
   *   the agent loop has context the manager does not own; the resolution
   *   pipeline itself is identical for both callers.
   */
  resolveCandidates(
    current: { providerId: string; model: string },
    opts: {
      fallbackModels?: readonly string[] | undefined;
      fallbackProfile?: string | undefined;
      fallbackAuto?: boolean | undefined;
      primary?: { providerId: string; model: string } | undefined;
      closedWorld?: boolean | undefined;
    } = {},
  ): FallbackChain {
    const configuredPrimary = opts.primary ?? {
      providerId: this.config.provider,
      model: this.config.model,
    };

    // Outside a closed-world allowlist, honour fallbackAuto explicitly and use
    // auto discovery by default when the setting is absent.
    const configFallbackAuto = this.config.fallbackAuto;
    const effectiveFallbackAuto =
      configFallbackAuto !== undefined && configFallbackAuto !== null
        ? configFallbackAuto
        : !opts.closedWorld;

    // `asRefList` — NOT `?? `. The routing hot-reload watcher writes `null`
    // for a field no config layer defines, and `null ?? x` keeps the null.
    const explicitRefs = asRefList(opts.fallbackModels) ?? asRefList(this.config.fallbackModels);
    // The session-selected profile (`/fallback profile use <name>`) applies to
    // any caller that does not name one itself — this is what makes named
    // profiles reachable from the leader, which passes no explicit profile.
    const profileName = asProfileName(opts.fallbackProfile) ?? this.activeProfileName();

    // Whether the selected chain comes from an explicit source the user
    // configured themselves. When true, the chain is authoritative — we must
    // NOT pollute it with auto-discovered models, favorites, the "default"
    // profile, or every configured provider. The flag is set only when the
    // explicit inputs actually RESOLVED to usable models — not merely when
    // the inputs exist. A dead explicit chain falls through to auto-derivation.
    const explicitUsable =
      explicitRefs !== undefined &&
      explicitRefs.length > 0 &&
      this.resolveRefs(explicitRefs, current).length > 0;
    const profileUsable =
      profileName !== undefined &&
      this.hasProfile(profileName) &&
      this.resolve(profileName, { exclude: current }).length > 0;
    const fromExplicitSource = explicitUsable || profileUsable;

    const selectedChain: FallbackChain = opts.closedWorld
      ? explicitRefs && explicitRefs.length > 0
        ? this.resolveRefs(explicitRefs, current)
        : profileName
          ? this.resolve(profileName, { exclude: current })
          : FREEZER_EMPTY
      : this.resolveEffective({
          fallbackModels: explicitRefs,
          fallbackProfile: profileName,
          fallbackAuto: effectiveFallbackAuto,
          exclude: current,
        });

    const candidates: FallbackChainEntry[] = [];

    // A model allowlist is a permission boundary. Never append the session
    // model, bridge, default profile, or auto-discovered providers outside it.
    if (opts.closedWorld) {
      candidates.push(...selectedChain);
    } else {
      // Bridge (provider-independent escape hatch). resolveEffective() already
      // carries it for one-shot/profile consumers; the dedup filter keeps one.
      candidates.push(...this.resolveBridge(current));

      // Configured primary — try it before any fallback entries when the
      // active context is still on an older model.
      if (
        !(
          configuredPrimary.providerId === current.providerId &&
          configuredPrimary.model === current.model
        )
      ) {
        candidates.push({
          providerId: configuredPrimary.providerId,
          model: configuredPrimary.model,
          providerSwitched: configuredPrimary.providerId !== current.providerId,
        });
      }

      // Preserve the exact order of the user's explicit / role-selected chain.
      candidates.push(...selectedChain);

      // The default profile is additional fallback depth (unless we already
      // resolved it as the selected chain above). Only for the auto-derivation
      // path — an explicit user-chosen chain is authoritative, and the user
      // turning off fallbackAuto means "no auto-appended depth at all".
      if (!fromExplicitSource && effectiveFallbackAuto && profileName !== 'default') {
        candidates.push(...this.resolve('default', { exclude: current }));
      }

      // Every other configured provider as a last resort — but only
      // when fallbackAuto is actually enabled, and only when the chain
      // was auto-derived (not explicitly chosen by the user).
      if (!fromExplicitSource && effectiveFallbackAuto) {
        const cap = this.lastResortCap();
        if (cap > 0) {
          // Request the full inventory so the cap counts only entries NOT
          // already in the chain (bridge, primary, smart default, default
          // profile). Without this, the cap would silently consume slots
          // on models already in the chain, producing zero new depth.
          const usedKeys = new Set(candidates.map((c) => `${c.providerId}/${c.model}`));
          const lastResort = this.smartDefault(current, Number.POSITIVE_INFINITY)
            .filter((c) => !usedKeys.has(`${c.providerId}/${c.model}`))
            .slice(0, cap);
          candidates.push(...lastResort);
        }
      }
    }

    return dedupeChain(candidates, current);
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
      (asRefList(this.config.favoriteModels) ?? []).map((ref) => {
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

/**
 * Maximum number of candidates the last-resort append ({@link FallbackProfileManager.resolveAllConfigured})
 * may produce. By the time this append fires, the smart default, the bridge, and the
 * default profile have all failed — in a systemic outage every additional entry is a
 * doomed request. The cap bounds the blast radius without starving legitimate diversity
 * (3× the smart-default depth of 4). Exposed for tests and for callers that want to
 * surface it in config tooling.
 */
export const MAX_LAST_RESORT_CANDIDATES = 12;

const FREEZER_EMPTY: FallbackChain = Object.freeze([]);

/**
 * Deduplicate fallback chain entries by `providerId/model`, dropping the
 * current (already-active) model and any repeat. Preserves first-occurrence
 * order so the layering produced by {@link FallbackProfileManager.resolveCandidates}
 * determines which entry wins when the same model appears at multiple depths.
 *
 * Shared by both the agent-loop and one-shot paths so dedup semantics can never
 * drift between them.
 */
export function dedupeChain(
  entries: readonly FallbackChainEntry[],
  current: { providerId: string; model: string },
): FallbackChain {
  const seen = new Set<string>();
  const currentKey = `${current.providerId}/${current.model}`;
  return Object.freeze(
    entries.filter((entry) => {
      const key = `${entry.providerId}/${entry.model}`;
      if (key === currentKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
