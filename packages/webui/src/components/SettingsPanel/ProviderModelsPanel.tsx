/**
 * `<ProviderModelsPanel>` — provider-row expansion that surfaces the
 * picked model id, a "Refresh from server" button that re-runs the
 * health probe, and the ME-4 row-based `<ModelListEditor>` (allowlist
 * table with add-from-catalog / add-custom / edit / remove / pick).
 *
 * Reachable from `<ProviderSection>` when a saved provider is
 * selected. The panel owns its own refresh state — multiple panels
 * can coexist in the page (one per provider) and refresh
 * independently.
 *
 */
import { ListChecks, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import type { WrongStackWebSocketClient } from '../../lib/ws-client';
import type { WSServerMessage } from '../../types';
import { toast } from '../Toaster';
import { Button } from '../ui/button';
import { ClearAllowlistDialog } from './ClearAllowlistDialog';
import { ModelListEditor } from './ModelListEditor';
import {
  formatClearAllowlistToast,
  formatProbeResult,
  initialRefreshState,
  projectProbe,
  type RefreshState,
  shouldFireUndoToast,
  shouldOfferClear,
} from './ProviderModelsPanel.filter';
import { resolveUndoSend } from './undo-send-decision';

interface ProviderModelsPanelProps {
  /** The saved provider id — used for the WS request and panel keying. */
  providerId: string;
  /**
   * The model id currently pinned for this provider, derived from
   * `cfg.models[0]` (and surfaced in `providers.saved`).
   */
  savedPickedModelId?: string | undefined;
  /**
   * The full saved allowlist (the same data the model picker uses).
   */
  savedModels?: string[] | undefined;
  /** Per-model metadata from customModels (display name, context, output, capabilities, modelsDev). */
  savedCustomModels?:
    | Record<
        string,
        {
          name?: string | undefined;
          maxOutput?: number | undefined;
          capabilities?:
            | {
                maxContext?: number | undefined;
                tools?: boolean | undefined;
                vision?: boolean | undefined;
                reasoning?: boolean | undefined;
                streaming?: boolean | undefined;
                jsonMode?: boolean | undefined;
              }
            | undefined;
          modelsDev?: Record<string, unknown> | undefined;
        }
      >
    | undefined;
  /** WebSocket client used to send `provider.probe` and listen for the reply. */
  ws: WrongStackWebSocketClient;
  /**
   * Optional callback fired when the user clicks "Use" on a probed
   * model id. The page can persist the choice by sending a follow-up
   * `provider.add` (overwriting the allowlist) or by routing the user
   * to the CLI (`wstack auth local --model <id>`).
   */
  onPickModel?: ((providerId: string, modelId: string) => void) | undefined;
  /**
   * Optional callback fired when the user clicks "Clear allowlist"
   * AND confirms in the confirmation dialog. The default behavior
   * (when omitted) is to call `ws.clearProviderModels(providerId)`
   * directly. Pages that need to centralize the WS traffic (e.g. for
   * batched optimistic updates, analytics, or the undo toast) can
   * override this.
   */
  onClearModels?: ((providerId: string) => void) | undefined;
  /**
   * Optional callback fired when the user clicks the "Undo" button
   * on the toast that appears after clearing. The panel captures
   * the previous `savedModels` at confirm time and passes it here
   * so the parent can reapply it. The default behavior (when
   * omitted) is to call `ws.undoProviderClear(providerId, previousModels)`
   * — the dedicated `provider.undo_clear` message type that pairs
   * with `provider.clear_models` in the WS protocol. Pages that
   * need a custom undo (e.g. routing through a different store)
   * can override this.
   */
  onUndoClear?: ((providerId: string, previousModels: string[]) => void) | undefined;
}

const PROBE_TIMEOUT_MS = 3_000;

export function ProviderModelsPanel({
  providerId,
  savedPickedModelId,
  savedModels,
  savedCustomModels,
  ws,
  onPickModel,
  onClearModels,
  onUndoClear,
}: ProviderModelsPanelProps) {
  const [state, setState] = useState<RefreshState>(() => initialRefreshState());
  const { t } = useAppTranslation();
  // Confirmation dialog state. Lives in the panel (not the parent) so
  // a single provider's accidental click doesn't open N modals across
  // the page. The dialog is mounted only when needed (after the user
  // clicks the "Clear allowlist" ghost button) and unmounts on close.
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Listen for `provider.probe` messages addressed to this provider.
  // The WS client is a global singleton — the same message may also
  // be handled by other panels, but each only acts on its own
  // providerId.
  useEffect(() => {
    const off = ws.on('provider.probe', (msg: WSServerMessage) => {
      if (msg.type !== 'provider.probe') return;
      if (msg.payload.providerId !== providerId) return;
      setState((prev) => ({
        ...prev,
        inFlight: false,
        last: projectProbe(msg.payload),
      }));
    });
    return off;
  }, [ws, providerId]);

  const onRefresh = useCallback(() => {
    setState((prev) => ({ ...prev, inFlight: true }));
    ws.probeProvider(providerId, PROBE_TIMEOUT_MS);
  }, [ws, providerId]);

  /**
   * Pick/pin handler passed to the model editor. Optimistically marks
   * the local probe's `picked` state (like the legacy chip did) then
   * forwards to the parent's persistence callback.
   */
  const handlePickModel = useCallback(
    (providerId: string, modelId: string) => {
      setState((prev) => ({ ...prev, picked: modelId }));
      onPickModel?.(providerId, modelId);
    },
    [onPickModel],
  );

  /**
   * First click on "Clear allowlist" — open the confirmation dialog.
   * The actual clear + undo-toast flow runs from `confirmClear`.
   */
  const requestClear = useCallback(() => {
    setConfirmOpen(true);
  }, []);

  const cancelClear = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  /**
   * Clear the saved `models` allowlist so the picker falls back to
   * the models.dev catalog. Optimistic: we drop the local probe's
   * `picked` state too — the user is intentionally reverting to
   * "no opinion". The `savedModels` prop is owned by the parent
   * (it'll update when the server's `providers.saved` broadcast
   * comes back) so we don't touch it here.
   *
   * Captures the previous list at confirm time so the undo toast
   * can reapply it — if we read `savedModels` lazily from the
   * closure at toast-click time, the prop will already be empty
   * (the parent's optimistic state has cleared it) and undo
   * would be a no-op.
   */
  const confirmClear = useCallback(() => {
    setConfirmOpen(false);
    const previousModels = savedModels ? [...savedModels] : [];
    setState((prev) => ({ ...prev, picked: null, last: null }));
    if (onClearModels) {
      onClearModels(providerId);
    } else {
      ws.clearProviderModels(providerId);
    }
    if (!shouldFireUndoToast(previousModels)) return;
    const undo = () => {
      // Route through the decision helper so the "skip / callback /
      // ws-default" branch is testable in isolation. The ws-default
      // path uses the dedicated `provider.undo_clear` message type
      // (not a generic `provider.update`) so the audit log
      // surfaces "user undid a clear" as a distinct event
      // category.
      const decision = resolveUndoSend({ providerId, previousModels, onUndoClear });
      switch (decision.kind) {
        case 'skip':
          return;
        case 'callback':
          onUndoClear?.(decision.providerId, decision.previousModels);
          return;
        case 'ws-default':
          ws.undoProviderClear(decision.providerId, decision.previousModels);
          return;
      }
    };
    toast.undoable(formatClearAllowlistToast(providerId, previousModels.length), undo);
  }, [onClearModels, onUndoClear, ws, providerId, savedModels]);

  // Header "Using" selection: user click (state.picked) > saved picked >
  // first saved model. Deliberately does NOT use selectPickedModelId's
  // probe-promotion branch (rule 2) — the editor below only renders
  // savedModels, so a probe-only id would be highlighted with no row.
  const pickedId = useMemo(
    () => state.picked ?? savedPickedModelId ?? savedModels?.[0] ?? '',
    [state.picked, savedPickedModelId, savedModels],
  );
  const formatted = useMemo(() => formatProbeResult(state), [state]);
  const offerClear = useMemo(() => shouldOfferClear(savedModels), [savedModels]);

  return (
    <div
      className="rounded-lg border border-border/70 bg-background/75 p-3 shadow-sm shadow-black/[0.02]"
      data-provider-models-panel={providerId}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5" />
              {t('activity:providerModels.allowlistTitle')}
            </span>
            {savedModels && savedModels.length > 0 && (
              <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                {t('activity:providerModels.modelCount', { count: savedModels.length })}
              </span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t('activity:providerModels.using')}
            </span>
            {pickedId ? (
              <span className="max-w-full truncate rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs text-primary">
                {pickedId}
              </span>
            ) : (
              <span className="text-xs italic text-muted-foreground">
                {t('activity:providerModels.noModelPicked')}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={state.inFlight}
            aria-label={t('activity:providerModels.refreshAria', { provider: providerId })}
            className="h-8 px-2 text-xs"
          >
            {state.inFlight ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {state.inFlight
              ? t('activity:providerModels.probing')
              : t('activity:providerModels.refresh')}
          </Button>
          {offerClear && (
            <Button
              variant="ghost"
              size="sm"
              onClick={requestClear}
              aria-label={t('activity:providerModels.clearAllowlistAria', { provider: providerId })}
              data-action="clear-models"
              className="h-8 px-2 text-xs"
            >
              {t('activity:providerModels.clearAllowlist')}
            </Button>
          )}
        </div>
      </div>

      <ProbeResultLine formatted={formatted} />

      <div className="mt-3">
        <ModelListEditor
          providerId={providerId}
          models={savedModels ?? []}
          customModels={savedCustomModels}
          ws={ws}
          pickedModelId={pickedId ?? undefined}
          onPickModel={handlePickModel}
        />
      </div>

      <ClearAllowlistDialog
        open={confirmOpen}
        providerId={providerId}
        modelCount={savedModels?.length ?? 0}
        onConfirm={confirmClear}
        onCancel={cancelClear}
      />
    </div>
  );
}

function ProbeResultLine({
  formatted,
}: {
  formatted: { text: string; tone: 'success' | 'warning' | 'error' | 'muted' };
}) {
  const toneClass =
    formatted.tone === 'success'
      ? 'text-success'
      : formatted.tone === 'warning'
        ? 'text-warning'
        : formatted.tone === 'error'
          ? 'text-destructive'
          : 'text-muted-foreground';
  const dotClass =
    formatted.tone === 'success'
      ? 'bg-success'
      : formatted.tone === 'warning'
        ? 'bg-warning'
        : formatted.tone === 'error'
          ? 'bg-destructive'
          : 'bg-muted-foreground/60';
  return (
    <p
      className={`mt-2 flex items-center gap-1.5 text-xs ${toneClass}`}
      data-probe-tone={formatted.tone}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      <span className="min-w-0 truncate">{formatted.text}</span>
    </p>
  );
}
