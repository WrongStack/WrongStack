/**
 * Pure decision helper for the "Undo" toast's send path.
 *
 * The toast's onClick can go one of three places:
 *   1. **Custom callback** (the parent supplied `onUndoClear`)
 *   2. **Default: dedicated `provider.undo_clear` message** (sugar
 *      over `provider.update` with `models: previousModels` — the
 *      audit log captures it as a distinct category)
 *   3. **Skip** — no `previousModels` to restore
 *
 * This helper centralizes the branch logic so the test suite can
 * pin the contract: "when no callback is supplied, the panel
 * always uses `ws.undoProviderClear` (not `ws.updateProvider`),
 * so the audit log is uniform".
 */
type UndoSendDecision =
  | { kind: 'skip' }
  | { kind: 'callback'; providerId: string; previousModels: string[] }
  | { kind: 'ws-default'; providerId: string; previousModels: string[] };

/**
 * Decide where the toast's "Undo" click should route to. Returns
 * a discriminated union — the caller pattern-matches on `kind`.
 *
 * The `previousModels.length === 0` short-circuit mirrors the
 * `shouldFireUndoToast(previousModels)` guard at the call site.
 * Keeping both checks ensures the "should I even fire the
 * toast?" and "where should the toast route to?" decisions are
 * both pinned down by tests.
 */
export function resolveUndoSend(opts: {
  providerId: string;
  previousModels: string[];
  onUndoClear: ((providerId: string, previousModels: string[]) => void) | undefined;
}): UndoSendDecision {
  if (opts.previousModels.length === 0) return { kind: 'skip' };
  if (opts.onUndoClear) {
    return {
      kind: 'callback',
      providerId: opts.providerId,
      previousModels: opts.previousModels,
    };
  }
  return {
    kind: 'ws-default',
    providerId: opts.providerId,
    previousModels: opts.previousModels,
  };
}
