/**
 * Fallback reference helpers for the WebUI.
 *
 * Mirrors `refInactiveReason` / `refInvalidReason` from
 * `packages/cli/src/slash-commands/fallback.ts` so the WebUI's
 * settings panel, the TUI's settings picker, and the CLI's
 * `/fallback` command agree on what "active" means for a model ref.
 *
 * Active means:
 *  - The reference parses to a non-empty model name (`parseModelRef`
 *    from `@wrongstack/core/agent`), AND
 *  - The reference's `provider/model` is in the set of currently
 *    known valid models (`knownModels`). The set is sourced from
 *    `useProviderModels()` in the WebUI and `useConfigStore().providers`
 *    on the slash-command side — same shape, different transport.
 *
 * An empty/missing `knownModels` set means the WebUI hasn't loaded
 * provider catalogues yet; the helper returns `undefined` so the UI
 * doesn't flag rows as inactive while still loading.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** A reference that has been classified as healthy or inactive. */
export interface RefActiveState {
  /** True when the ref parses and points at a known model. */
  active: boolean;
  /** Short, view-safe reason the ref is inactive, when `active === false`. */
  reason?: string | undefined;
}

// ── Parser passthrough ──────────────────────────────────────────────────────
//
// We re-export `parseModelRef` from the canonical core location so the
// helper stays in sync with the slash command / LLM tools. New code MUST
// import `parseModelRef` directly from `@wrongstack/core/agent`.

export { formatModelRef, normalizeModelRef, parseModelRef } from '@wrongstack/core/agent';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Split a `provider/model` ref into `{ providerId, model }`. Returns
 * `{ providerId: '', model: '' }` when the ref is empty / whitespace-only.
 * The slash command uses the same shape — mirrored here so the
 * `FallbackEditor` inactive badge stays consistent with `/fallback`.
 */
export function splitProviderModel(ref: string): { providerId: string; model: string } {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return {
      providerId: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1).trim(),
    };
  }
  // Bare model (no provider): the runtime routes it through the
  // leader provider at resolve time, so we can't decide inactivity
  // for certain against a single-provider allow-list. Treat as
  // provider-relative and surface it as "no provider" so the inactive
  // badge can render a clear message instead of guessing.
  if (slash === 0) return { providerId: '', model: trimmed.slice(1).trim() };
  return { providerId: '', model: trimmed };
}

/**
 * Whether a model reference will be silently dropped at runtime
 * because it doesn't match any provider's currently known model list.
 *
 * Returns `undefined` (active) when:
 *  - the ref parses to a non-empty model, AND
 *  - the resolved (provider, model) tuple is in `knownModels`.
 *
 * Returns a short, view-safe reason string when inactive. The string
 * mirrors the slash command's wording so the WebUI and CLI render
 * consistent messages.
 *
 * Known-models set semantics:
 *  - `undefined` or empty → unknown. Helper returns `undefined` so the
 *    UI does not flash inactive badges during load.
 *  - Non-empty → only refs whose (provider, model) is in the set are
 *    active. Provider-less refs (bare model name) are treated as
 *    "inactive — no provider" because the editor doesn't know which
 *    provider the runtime will pick.
 */
export function refInactiveReason(
  ref: string,
  knownModels: ReadonlySet<string> | undefined,
): string | undefined {
  const { providerId, model } = splitProviderModel(ref);
  if (!model) return '"' + ref + '" has no model';
  if (!providerId) return 'no provider in reference';
  if (!knownModels || knownModels.size === 0) return undefined;
  const key = `${providerId}/${model}`;
  if (knownModels.has(key)) return undefined;
  return `"${model}" not in ${providerId} model list`;
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
  return reason === undefined ? { active: true } : { active: false, reason };
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
    if (!c.provider || !c.model) continue;
    out.add(`${c.provider}/${c.model}`);
  }
  return out;
}
