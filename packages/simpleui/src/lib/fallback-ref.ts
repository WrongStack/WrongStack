/**
 * Fallback reference helpers for the SimpleUI surface.
 *
 * As of 2026-07-28 the SimpleUI has **no native fallback-chain/profile
 * settings picker** — it stores `fallbackProfiles` in `prefs-model.ts`
 * (used only to resolve the refiner's primary model) but does not render
 * or edit the fallback chain. The CLI slash command `/fallback` is the
 * single editor surface today, and the WebUI `FallbacksSection` is the
 * single GUI editor surface.
 *
 * When a SimpleUI fallback editor is added, mirror the WebUI's
 * `packages/webui/src/lib/fallback-ref.ts` pattern exactly so the three
 * surfaces (CLI slash, WebUI settings panel, SimpleUI settings panel)
 * render the same inactive warning wording and use the same
 * known-model-set semantics:
 *
 *   - `refInactiveReason(ref, knownModels)` returns `undefined` for an
 *     active ref, or a short reason string for an inactive one.
 *     Wording MUST match the slash command's `refInactiveReason` in
 *     `packages/cli/src/slash-commands/fallback.ts` so a user reading
 *     "⚠ `"claude-99" not in anthropic model list`" on one surface sees
 *     the identical text on every other surface.
 *
 *   - `classifyRef(ref, knownModels)` wraps `refInactiveReason` and
 *     returns `{ active: true }` or `{ active: false, reason }`.
 *     Use this for component-level rendering decisions.
 *
 *   - `buildKnownModelSet(candidates)` flattens a `ModelCandidate[]`
 *     into a `Set<string>` of `"provider/model"` keys. While the
 *     provider catalogue is still loading, pass `undefined` for
 *     `knownModels` so the helper returns `undefined` and the UI does
 *     not flash inactive badges on cold start.
 *
 * Why a stub and not a re-export today? SimpleUI currently has no
 * `@wrongstack/core` import. When the editor arrives, the maintainer
 * can either (a) duplicate the helper here with the wording pinned by
 * tests, or (b) add the cross-package import and re-export from the
 * WebUI's `fallback-ref.ts`. The wording-pinning tests must match
 * `packages/cli/tests/slash-fallback.test.ts` ("flags a profile entry
 * that is not in the provider model list") and
 * `packages/webui/tests/components/fallback-editor-inactive.test.tsx`
 * ("flags only the rows whose (provider, model) is missing from the
 * known set").
 *
 * When a fallback editor is added to SimpleUI, the maintainer MUST:
 *
 *   1. Re-export or duplicate `refInactiveReason`, `classifyRef`, and
 *      `buildKnownModelSet` here (or import from the WebUI helper).
 *   2. Render each row with `classifyRef` and surface an inactive badge
 *      when `active === false`. The badge wording must use the same
 *      `reason` string from the helper so all three surfaces agree.
 *   3. Add tests at `packages/simpleui/tests/lib/fallback-ref.test.ts`
 *      that pin the cross-surface wording contract, mirroring
 *      `packages/webui/tests/lib/fallback-ref.test.ts`.
 *   4. Update this file's docstring to point at the new component and
 *      remove the "future editor" caveat.
 */

export type RefActiveState = { active: boolean; reason?: string | undefined };

/**
 * Stub placeholder. When a SimpleUI fallback editor is added, replace
 * this with the real implementation (either duplicated locally or
 * imported from `packages/webui/src/lib/fallback-ref.ts`).
 *
 * Until then, returning `undefined` everywhere keeps any accidental
 * import side-effect-free: callers cannot get a real "inactive" verdict
 * from this stub, only "active".
 */
export function refInactiveReason(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ref: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _knownModels: ReadonlySet<string> | undefined,
): string | undefined {
  return undefined;
}

// Re-export so future SimpleUI consumers can import the same shape
// the WebUI helper exposes — change the return values once the stub is
// replaced with the real implementation.
export function classifyRef(
  ref: string,
  knownModels: ReadonlySet<string> | undefined,
): RefActiveState {
  const reason = refInactiveReason(ref, knownModels);
  return reason === undefined ? { active: true } : { active: false, reason };
}
