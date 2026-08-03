/**
 * Per-task model matrix resolution.
 *
 * The matrix (Config.modelMatrix) maps a catalog **role**, a **phase** name, or
 * the `*` default to a {@link ModelMatrixEntry} (model + optional provider).
 * At subagent spawn time we resolve the most specific match so different task
 * types can run on different models — e.g. `security-scanner` on one model,
 * `documentation` on another — while the leader keeps its own model.
 *
 * Resolution precedence (most → least specific):
 *   1. exact role          (matrix["security-scanner"])
 *   2. the role's phase     (matrix["review"])
 *   3. the `*` default      (matrix["*"])
 *   4. undefined            (caller falls back to the leader model)
 *
 * Set via the `/setmodel` slash command; this module is the single source of
 * truth both that command and the spawn path use to validate + resolve keys.
 */

import { fallbackProfileChain, parseModelRef } from '../core/fallback-model.js';
import type { Config, ModelMatrixEntry, ProviderConfig } from '../types/config.js';
import { AGENT_CATALOG, AGENTS_BY_PHASE } from './agents/index.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';

/** Either a static matrix or a live getter (re-read on every spawn). */
export type ModelMatrixSource =
  | Record<string, ModelMatrixEntry>
  | (() => Record<string, ModelMatrixEntry> | undefined);

/** All valid phase keys, in catalog order. */
export const MATRIX_PHASE_KEYS: readonly string[] = Object.keys(AGENTS_BY_PHASE);

/** Role → phase lookup, built once from the catalog. */
const ROLE_TO_PHASE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [phase, defs] of Object.entries(AGENTS_BY_PHASE)) {
    for (const def of defs) {
      const role = def.config.role;
      if (role) map[role] = phase;
    }
  }
  return map;
})();

/** The phase a catalog role belongs to, or undefined for unknown roles. */
export function phaseForRole(role: string | undefined): string | undefined {
  return role ? ROLE_TO_PHASE[role] : undefined;
}

export type ModelMatrixResolutionSource = 'role' | 'phase' | 'default';

export interface ModelMatrixResolution {
  entry: ModelMatrixEntry;
  source: ModelMatrixResolutionSource;
  key: string;
}

/**
 * Resolve the matrix entry plus the key tier it came from. Use this when the
 * caller needs to distinguish an explicit role/phase pin from the global `*`
 * default.
 */
export function resolveModelMatrixResolution(
  matrix: Record<string, ModelMatrixEntry> | undefined,
  role: string | undefined,
): ModelMatrixResolution | undefined {
  if (!matrix) return undefined;
  if (role && matrix[role]) return { entry: matrix[role], source: 'role', key: role };
  const phase = phaseForRole(role);
  if (phase && matrix[phase]) return { entry: matrix[phase], source: 'phase', key: phase };
  if (matrix['*']) return { entry: matrix['*'], source: 'default', key: '*' };
  return undefined;
}

/**
 * Resolve the matrix entry for a subagent role. Returns the most specific
 * match (role → phase → `*`), or undefined when nothing matches.
 */
export function resolveModelMatrix(
  matrix: Record<string, ModelMatrixEntry> | undefined,
  role: string | undefined,
): ModelMatrixEntry | undefined {
  return resolveModelMatrixResolution(matrix, role)?.entry;
}

export interface ResolvedModelTarget {
  provider?: string | undefined;
  model?: string | undefined;
  modelRuntime?: Config['modelRuntime'] | undefined;
  fallbackModels?: string[] | undefined;
  fallbackProfile?: string | undefined;
}

export interface ResolvedSubagentModelTarget extends ResolvedModelTarget {
  /** Where the concrete provider/model came from. */
  source: 'matrix' | 'diversity' | 'none';
  /** Matrix tier used before any reviewer diversity adjustment. */
  matrixSource?: ModelMatrixResolutionSource | undefined;
  /** True when a reviewer model was shifted away from the implementation model. */
  diversified?: boolean | undefined;
}

/**
 * Expand a matrix entry into a concrete primary model plus optional fallback
 * chain. A profile-only matrix entry treats the first profile model as primary
 * and the remaining profile entries as that subagent's fallback chain.
 */
export function resolveModelTargetFromEntry(
  config: Config,
  entry: ModelMatrixEntry | undefined,
): ResolvedModelTarget | undefined {
  if (!entry) return undefined;
  if (entry.model) {
    return {
      provider: entry.provider,
      model: entry.model,
      modelRuntime: entry.modelRuntime,
      fallbackProfile: entry.fallbackProfile,
      fallbackModels: fallbackProfileChain(config, entry.fallbackProfile),
    };
  }
  const chain = fallbackProfileChain(config, entry.fallbackProfile);
  const first = chain[0];
  if (!first) {
    return entry.modelRuntime ? { modelRuntime: entry.modelRuntime } : undefined;
  }
  const parsed = parseModelRef(first);
  return {
    provider: parsed.provider,
    model: parsed.model,
    modelRuntime: entry.modelRuntime,
    fallbackProfile: entry.fallbackProfile,
    fallbackModels: chain.slice(1),
  };
}

export interface ModelReference {
  provider?: string | undefined;
  model?: string | undefined;
}

interface ConcreteModelReference {
  provider: string;
  model: string;
}

/**
 * Roles whose output is meant to challenge an implementer. When these roles
 * would otherwise use the same provider/model as the implementation path,
 * WrongStack tries to pick a different available model to reduce correlated
 * model-family mistakes. Exact role/phase `/setmodel` entries still win.
 */
export function roleNeedsIndependentReviewModel(role: string | undefined): boolean {
  if (!role) return false;
  return role === 'reviewer' || phaseForRole(role) === 'review';
}

/**
 * Resolve a subagent's matrix target with the reviewer diversity rule applied.
 *
 * Precedence:
 *   1. Exact role or phase matrix entry.
 *   2. Global `*` matrix entry when it is already different from the
 *      implementation model.
 *   3. A different configured provider/model for review roles.
 *   4. The matrix/leader fallback.
 *
 * When a {@link ProviderModelStatusTracker} is supplied, resolved candidates
 * currently in the waiting room (`state: 'blocked'`) are dropped so the
 * subagent never spawns on a model the leader just 429-stricken. The
 * fallback extension inside the subagent will also re-check `isAvailable`
 * before invoking the provider, but filtering here saves the spawn
 * round-trip on doomed picks.
 *
 * The tracker check uses the EFFECTIVE (provider, model) pair — i.e. the
 * pair that {@link materializeTarget} would render — not the raw
 * `matrixTarget.provider` field. A model-only matrix entry falls back to
 * `config.provider` for the wire call, so the waiting-room entry sits on
 * the same effective identity. Checking the raw field would silently
 * bypass the quarantine and respawn on a 429-stricken model.
 */
export function resolveSubagentModelTarget(
  config: Config,
  role: string | undefined,
  opts: {
    implementationTarget?: ModelReference | undefined;
    statusTracker?: ProviderModelStatusTracker | undefined;
  } = {},
): ResolvedSubagentModelTarget | undefined {
  const resolution = resolveModelMatrixResolution(config.modelMatrix, role);
  const matrixTarget = resolveModelTargetFromEntry(config, resolution?.entry);
  const implementationTarget =
    opts.implementationTarget ?? resolveImplementationModelTarget(config);

  const isAvailable = (providerId: string | undefined, model: string | undefined): boolean => {
    if (!opts.statusTracker) return true;
    if (!providerId || !model) return true;
    return opts.statusTracker.isAvailable(providerId, model);
  };

  // Tracker check on the EFFECTIVE (provider, model) pair, not the raw
  // matrix entry. A model-only matrix entry has `provider` undefined at
  // this layer but wires as `(config.provider, model)` (see
  // materializeTarget). Checking the raw field would let a blocked
  // model-only entry slip past the quarantine.
  const matrixEffective = materializeTarget(config, matrixTarget);
  const matrixIsAvailable =
    !matrixEffective || isAvailable(matrixEffective.provider, matrixEffective.model);

  if (!roleNeedsIndependentReviewModel(role)) {
    if (!matrixTarget) return undefined;
    if (!matrixIsAvailable) return undefined;
    return {
      ...matrixTarget,
      source: 'matrix',
      matrixSource: resolution?.source,
    };
  }

  const matrixRef = materializeTarget(config, matrixTarget);

  if (resolution?.source === 'role' || resolution?.source === 'phase') {
    if (!matrixTarget) return undefined;
    if (!matrixIsAvailable) return undefined;
    return {
      ...matrixTarget,
      source: 'matrix',
      matrixSource: resolution.source,
    };
  }

  if (matrixRef && !sameModelReference(matrixRef, implementationTarget)) {
    if (!matrixIsAvailable) return undefined;
    return {
      ...(matrixTarget ?? {}),
      source: 'matrix',
      matrixSource: resolution?.source,
    };
  }

  // Diversity path: filter the ranked candidate list through the tracker
  // BEFORE picking the top scoring one. Choosing the highest-ranked candidate
  // and then dropping it on a tracker block would defeat independent-review
  // routing whenever the highest-ranked diverse model is in the waiting room,
  // even when another ranked candidate is healthy.
  const diverse = chooseDiverseModelTargetWithTracker(
    config,
    implementationTarget,
    opts.statusTracker,
  );
  if (diverse) {
    return {
      provider: diverse.provider,
      model: diverse.model,
      modelRuntime: matrixTarget?.modelRuntime,
      fallbackModels: matrixTarget?.fallbackModels,
      fallbackProfile: matrixTarget?.fallbackProfile,
      source: 'diversity',
      matrixSource: resolution?.source,
      diversified: true,
    };
  }

  if (!matrixTarget) return undefined;
  if (!matrixIsAvailable) return undefined;
  return {
    ...matrixTarget,
    source: 'matrix',
    matrixSource: resolution?.source,
  };
}

/**
 * Resolve the default implementation lane. The generic Executor is the closest
 * stable proxy for "the implementer" when a reviewer is spawned without a
 * concrete sibling id.
 */
export function resolveImplementationModelTarget(config: Config): ModelReference {
  const target = resolveModelTargetFromEntry(
    config,
    resolveModelMatrix(config.modelMatrix, 'executor'),
  );
  return (
    materializeTarget(config, target) ?? {
      provider: config.provider,
      model: config.model,
    }
  );
}

export function sameModelReference(
  a: ModelReference | undefined,
  b: ModelReference | undefined,
): boolean {
  if (!a?.model || !b?.model) return false;
  const providerA = a.provider ?? '';
  const providerB = b.provider ?? '';
  return providerA === providerB && a.model === b.model;
}

function materializeTarget(
  config: Config,
  target: ResolvedModelTarget | undefined,
): ModelReference | undefined {
  if (!target?.model) return undefined;
  return {
    provider: target.provider ?? config.provider,
    model: target.model,
  };
}

function chooseDiverseModelTarget(
  config: Config,
  avoid: ModelReference,
): ConcreteModelReference | undefined {
  const candidates = collectConfiguredModelTargets(config).filter(
    (candidate) => !sameModelReference(candidate, avoid),
  );
  candidates.sort((a, b) => modelDiversityScore(b, avoid) - modelDiversityScore(a, avoid));
  return candidates[0];
}

/**
 * Diversity-pick variant that filters tracker-blocked candidates out of the
 * ranked list before picking the top scorer. Used by
 * {@link resolveSubagentModelTarget} so a 429-stricken highest-ranked model
 * cannot starve the diversity path when another ranked candidate is healthy.
 * When the tracker is undefined, fall through to the rank-only picker to
 * preserve the legacy contract.
 */
function chooseDiverseModelTargetWithTracker(
  config: Config,
  avoid: ModelReference,
  tracker: ProviderModelStatusTracker | undefined,
): ConcreteModelReference | undefined {
  if (!tracker) return chooseDiverseModelTarget(config, avoid);
  const ranked = collectConfiguredModelTargets(config)
    .filter((candidate) => !sameModelReference(candidate, avoid))
    .sort((a, b) => modelDiversityScore(b, avoid) - modelDiversityScore(a, avoid));
  for (const candidate of ranked) {
    if (tracker.isAvailable(candidate.provider, candidate.model)) return candidate;
  }
  return undefined;
}

function collectConfiguredModelTargets(config: Config): ConcreteModelReference[] {
  const seen = new Set<string>();
  const out: ConcreteModelReference[] = [];
  const add = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ provider, model });
  };

  add(config.provider, config.model);
  for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
    if (!isProviderAvailable(providerId, provider, config.provider)) continue;
    for (const model of provider.models ?? []) add(providerId, model);
    for (const model of Object.keys(provider.customModels ?? {})) add(providerId, model);
  }
  for (const model of Object.keys(config.models ?? {})) add(config.provider, model);
  return out;
}

function isProviderAvailable(
  providerId: string,
  provider: ProviderConfig,
  leaderProvider: string,
): boolean {
  if (providerId === leaderProvider) return true;
  if (typeof provider.apiKey === 'string' && provider.apiKey.length > 0) return true;
  if (Array.isArray(provider.apiKeys) && provider.apiKeys.some((key) => key?.apiKey)) return true;
  if (typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0) return true;
  return false;
}

function modelDiversityScore(candidate: ConcreteModelReference, avoid: ModelReference): number {
  let score = 0;
  if (candidate.provider !== avoid.provider) score += 100;
  if (candidate.model !== avoid.model) score += 20;
  if (/opus|gpt-5|o3|o4|gemini.*pro|deepseek-r1/i.test(candidate.model)) score += 10;
  if (/mini|haiku|flash/i.test(candidate.model)) score -= 5;
  return score;
}

export type MatrixKeyKind = 'role' | 'phase' | 'default' | 'unknown';

/** Classify a matrix key so `/setmodel` can reject typos before persisting. */
export function matrixKeyKind(key: string): MatrixKeyKind {
  if (key === '*') return 'default';
  if (key in AGENT_CATALOG) return 'role';
  if (MATRIX_PHASE_KEYS.includes(key)) return 'phase';
  return 'unknown';
}

/** True when `key` is a usable matrix key (role, phase, or `*`). */
export function isValidMatrixKey(key: string): boolean {
  return matrixKeyKind(key) !== 'unknown';
}
