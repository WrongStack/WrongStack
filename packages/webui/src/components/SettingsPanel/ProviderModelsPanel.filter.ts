/**
 * Pure data-shaping helpers for the `<ProviderModelsPanel>` component.
 *
 * Keeping these in a `.filter.ts` companion file (rather than
 * colocated with the JSX) lets the test suite exercise the logic
 * without rendering React, and matches the convention used elsewhere
 * in this directory (e.g. `QuickModelSwitcher.filter.ts`).
 *
 * The panel renders a saved provider's picked model id, the full
 * model list, and a "Refresh from server" button that triggers the
 * probe. These helpers reduce a `WSProviderProbe` payload to the
 * shape the panel needs to display the result.
 */

export type ProbeStatus =
  | 'ok'
  | 'unreachable'
  | 'timeout'
  | 'http_error'
  | 'invalid_response'
  | 'no_provider'
  | 'no_base_url';

export interface ProbeView {
  providerId: string;
  ok: boolean;
  status: ProbeStatus;
  httpStatus?: number | undefined;
  elapsedMs?: number | undefined;
  modelCount?: number | undefined;
  modelIds?: string[] | undefined;
  detail?: string | undefined;
}

export interface RefreshState {
  /** Is the refresh currently in flight? */
  inFlight: boolean;
  /** Last result, or null if no refresh has run yet. */
  last: ProbeView | null;
  /** True when the user clicked "Use" on a probed model id. */
  picked: string | null;
}

/** Initial state for a panel that's never been refreshed. */
export function initialRefreshState(): RefreshState {
  return { inFlight: false, last: null, picked: null };
}

/** Build a `ProbeView` from a `WSProviderProbe` payload. */
export function projectProbe(payload: {
  providerId: string;
  ok: boolean;
  status: string;
  httpStatus?: number | undefined;
  elapsedMs?: number | undefined;
  modelCount?: number | undefined;
  modelIds?: string[] | undefined;
  detail?: string | undefined;
}): ProbeView {
  return {
    providerId: payload.providerId,
    ok: payload.ok,
    status: payload.status as ProbeStatus,
    ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
    ...(payload.elapsedMs !== undefined ? { elapsedMs: payload.elapsedMs } : {}),
    ...(payload.modelCount !== undefined ? { modelCount: payload.modelCount } : {}),
    ...(payload.modelIds !== undefined ? { modelIds: payload.modelIds } : {}),
    ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
  };
}

/**
 * Return the model id that should be highlighted as the "current" id
 * for the picker. The order of precedence:
 *   1. The user just clicked "Use" on a probed id → that one
 *   2. The probe's first model id (when the refresh was just successful)
 *   3. The saved `pickedModelId` from the config
 *   4. The first model in the saved list
 *   5. Empty string (no id)
 */
export function selectPickedModelId(
  state: RefreshState,
  savedPicked: string | undefined,
  savedModels: string[] | undefined,
): string {
  if (state.picked) return state.picked;
  if (
    state.last?.ok &&
    state.last.modelIds &&
    state.last.modelIds.length > 0 &&
    state.last.modelIds[0]
  ) {
    return state.last.modelIds[0];
  }
  if (savedPicked) return savedPicked;
  if (savedModels && savedModels.length > 0 && savedModels[0]) {
    return savedModels[0];
  }
  return '';
}

/** Human-friendly text describing the last probe outcome. */
export function formatProbeResult(state: RefreshState): {
  text: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
} {
  if (state.inFlight) {
    return { text: 'Checking model endpoint...', tone: 'muted' };
  }
  const last = state.last;
  if (!last) {
    return {
      text: 'Saved model list shown',
      tone: 'muted',
    };
  }
  const elapsed =
    last.elapsedMs !== undefined ? ` (${last.elapsedMs}ms)` : '';
  switch (last.status) {
    case 'ok': {
      const count = last.modelCount ?? last.modelIds?.length ?? 0;
      return {
        text: `Server returned ${count} model${count === 1 ? '' : 's'}${elapsed}`,
        tone: 'success',
      };
    }
    case 'unreachable':
      return {
        text: `server unreachable${last.detail ? ` — ${last.detail}` : ''}`,
        tone: 'error',
      };
    case 'timeout':
      return {
        text: `timed out${last.detail ? ` — ${last.detail}` : ''}`,
        tone: 'error',
      };
    case 'http_error': {
      const status = last.httpStatus !== undefined ? ` HTTP ${last.httpStatus}` : '';
      return {
        text: `got${status}${last.detail ? ` — ${last.detail}` : ''}`,
        tone: 'warning',
      };
    }
    case 'invalid_response':
      return {
        text: last.detail
          ? `unexpected response — ${last.detail}`
          : 'unexpected response shape',
        tone: 'warning',
      };
    case 'no_provider':
      return {
        text: 'Provider is no longer saved',
        tone: 'error',
      };
    case 'no_base_url':
      return { text: 'No model endpoint configured', tone: 'warning' };
  }
}

/**
 * Compute the list of model ids to render in the pickable list.
 * Precedence:
 *   1. The probe's modelIds (most-recent, when ok)
 *   2. The saved `models` allowlist
 *   3. Empty array
 */
export function selectModelList(
  state: RefreshState,
  savedModels: string[] | undefined,
): string[] {
  if (
    state.last?.ok &&
    state.last.modelIds &&
    state.last.modelIds.length > 0
  ) {
    return state.last.modelIds;
  }
  return savedModels ?? [];
}

/**
 * Whether the panel should render the "Save these models" CTA. It
 * shows when the latest probe succeeded with at least one id AND
 * the probed list differs from the saved list.
 */
export function shouldOfferSave(
  state: RefreshState,
  savedModels: string[] | undefined,
): boolean {
  if (!state.last?.ok) return false;
  const probed = state.last.modelIds;
  if (!probed || probed.length === 0) return false;
  const saved = savedModels ?? [];
  if (saved.length !== probed.length) return true;
  for (let i = 0; i < probed.length; i++) {
    if (saved[i] !== probed[i]) return true;
  }
  return false;
}

/**
 * Whether the panel should render the "Clear allowlist" CTA.
 *
 * The button is visible exactly when the user has actually pinned a
 * list — i.e. `savedModels` is non-empty. When the saved list is
 * empty/undefined the picker is already using the models.dev
 * catalog, so a "Clear" button would be a no-op (and is therefore
 * hidden to keep the chrome uncluttered).
 *
 * The local `state` is intentionally NOT consulted here — the
 * button reflects the *on-disk* state, not the in-flight probe.
 * If the user has a probe result and a saved list at the same
 * time, both buttons ("Clear" and the implicit "use the probed
 * list" affordance) can coexist.
 */
export function shouldOfferClear(savedModels: string[] | undefined): boolean {
  return (savedModels?.length ?? 0) > 0;
}

/**
 * Build the text of the "Allowlist cleared" undo toast. Pluralizes
 * "model"/"models" by `count`, and includes the `providerId` so the
 * toast is unambiguous in a multi-provider page.
 */
export function formatClearAllowlistToast(providerId: string, count: number): string {
  return `Allowlist cleared for ${providerId} — ${count} model${count === 1 ? '' : 's'} removed`;
}

/**
 * Build the body text of the `<ClearAllowlistDialog>`. Plurals "model"
 * vs. "models" by `count`. The providerId is always shown in mono
 * (caller wraps it in a `<span class="font-mono">`).
 */
export function formatClearAllowlistDialogBody(
  providerId: string,
  count: number,
): string {
  return `This will remove the ${count} pinned model${count === 1 ? '' : 's'} for ${providerId}. The model picker will fall back to the models.dev catalog.`;
}

/**
 * Whether the panel should fire an undo toast after the user
 * confirms a clear. The toast is only useful when there's
 * something to undo — i.e. the captured `previousModels` list is
 * non-empty.
 */
export function shouldFireUndoToast(previousModels: string[]): boolean {
  return previousModels.length > 0;
}
