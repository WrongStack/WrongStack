/**
 * Fallback reference helpers for the WebUI.
 *
 * Mirrors `refInvalidReason` / `refStaleModelListWarning` from
 * `packages/cli/src/slash-commands/fallback-ref-validation.ts` so the WebUI's
 * settings panel and the CLI's `/fallback` command agree on what "active"
 * means for a model ref.
 *
 * Active means the runtime can use the ref: it parses to a non-empty model
 * name. A model missing from the provider's saved list (`knownModels`, built
 * from `useProviderModels()`) or a bare model without a provider is still
 * tried at runtime, so it carries an advisory, never the inactive badge.
 *
 * An empty/missing `knownModels` set means the WebUI hasn't loaded
 * provider catalogues yet; no advisory is shown while still loading.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A reference that has been classified as healthy or inactive. */
export interface RefActiveState {
  /** False only when the runtime cannot use the ref at all (no model). */
  active: boolean;
  /** Short, view-safe reason the ref is inactive, when `active === false`. */
  reason?: string | undefined;
  /** A "check this" note on an active ref the runtime will still try. */
  advisory?: string | undefined;
}

// ── Parser passthrough ──────────────────────────────────────────────────────
//
// We re-export `parseModelRef` from the canonical core location so the
// helper stays in sync with the slash command / LLM tools. New code MUST
// import `parseModelRef` directly from `@wrongstack/core/core/model-ref`.
//
// Browser code takes the narrow `core/model-ref` subpath rather than the
// `agent` barrel (`dist/core/index.js`): the barrel drags Node built-ins into
// the Vite graph, which is what `core-browser-shim.ts` exists to avoid for the
// bare `@wrongstack/core` specifier. The subpath deliberately mirrors the
// source layout (`src/core/model-ref.ts`) so the prefix aliases that point
// `@wrongstack/core` at `packages/core/src` in the Vitest configs resolve it
// without needing a per-config entry — the way `./utils/expect-defined` and
// `./types/session-markers` already do.

import { formatModelRef, normalizeModelRef, parseModelRef } from '@wrongstack/core/core/model-ref';

export { formatModelRef, normalizeModelRef, parseModelRef };

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Split a `provider/model` ref into `{ providerId, model }`. Returns
 * `{ providerId: '', model: '' }` when the ref is empty / whitespace-only.
 * Delegates to canonical `parseModelRef` so the spaced `provider model`
 * form — including model ids that contain their own slash — is classified
 * exactly as by the `/fallback` command. A ref with no provider stays
 * provider-relative (`providerId: ''`) and gets an advisory, not a badge.
 */
export function splitProviderModel(ref: string): { providerId: string; model: string } {
  const parsed = parseModelRef(ref);
  return { providerId: parsed.provider ?? '', model: parsed.model };
}

/**
 * Why a model reference cannot be used at all (it names no model), or
 * `undefined`. As the CLI's `refInvalidReason`: a model missing from the saved
 * list and a bare model are still tried by the runtime
 * (core fallback-profile-manager.ts never drops them), so they are reported by
 * {@link refAdvisory} instead of being badged inactive. `knownModels` is kept
 * in the signature for callers; it no longer decides activity.
 */
export function refInactiveReason(
  ref: string,
  knownModels: ReadonlySet<string> | undefined,
): string | undefined {
  void knownModels;
  const { model } = splitProviderModel(ref);
  if (!model) return '"' + ref + '" has no model';
  return undefined;
}

/**
 * Advisory for a usable ref, mirroring the CLI's `refStaleModelListWarning`:
 * the saved model list is an unrefreshed snapshot, so a model missing from it
 * is still tried, and a bare model resolves through the active provider.
 * `undefined` while the catalogue is unknown (no flash during load).
 */
export function refAdvisory(
  ref: string,
  knownModels: ReadonlySet<string> | undefined,
): string | undefined {
  const { providerId, model } = splitProviderModel(ref);
  if (!model || !knownModels || knownModels.size === 0) return undefined;
  if (!providerId) return 'no provider in reference — uses the active provider';
  if (knownModels.has(`${providerId}/${model}`)) return undefined;
  return `not in ${providerId} saved model list — will still be tried`;
}

/**
 * Structured variant of `refInactiveReason`. Useful when a component
 * wants to render different visual styles per reason (e.g. red for
 * "no model", amber for "not in allow-list").
 */
export function classifyRef(
  ref: string,
  knownModels: ReadonlySet<string> | undefined,
): RefActiveState {
  const reason = refInactiveReason(ref, knownModels);
  if (reason !== undefined) return { active: false, reason };
  const advisory = refAdvisory(ref, knownModels);
  return advisory === undefined ? { active: true } : { active: true, advisory };
}

/**
 * Build the `Set<provider/model>` view consumed by `refInactiveReason`.
 * The WebUI's `useProviderModels` returns `Array<ModelCandidate>` —
 * this helper flattens that into the keyed set the inactive check needs.
 */
export function buildKnownModelSet<T extends { provider: string; model: string }>(
  candidates: readonly T[],
): Set<string> {
  const out = new Set<string>();
  for (const c of candidates) {
    const provider = c.provider?.trim();
    const model = c.model?.trim();
    if (!provider || !model) continue;
    out.add(`${provider}/${model}`);
  }
  return out;
}
