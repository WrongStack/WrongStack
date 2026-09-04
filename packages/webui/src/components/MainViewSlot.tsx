/**
 * The render slot for one entry of `VIEW_REGISTRY`.
 *
 * Replaces what was the per-view body of `ViewRouter` — every conditional
 * branch (`currentView === 'X' && (...)`) now reaches here, which keeps the
 * structural guarantees identical:
 *
 *  - an `ErrorBoundary` named after the panel, so a crash inside the view
 *    surfaces under the panel name and not chat's;
 *  - a `<Suspense>` with the registry's chosen loading label, so the
 *    fallback is either named (a spinner + "Loading Settings") or bare
 *    depending on what the previous code did verbatim;
 *  - the wrapping `<div>` with the registry's class, omitted entirely when
 *    the view (like `ContextDashboard`) needs to land directly.
 *
 * Props come from the registry entry alone; the slot takes no prop bag from
 * its caller. The one runtime value a view can need — the "close me, show
 * chat" callback — cannot be written into a static table, so the registry
 * stores `PANEL_CLOSE_TO_CHAT_SENTINEL` in its place and the slot swaps every
 * occurrence for the `onCloseToChat` prop before rendering. That keeps one
 * closure shared across every view that needs one — see `view-registry.ts`.
 *
 * @module MainViewSlot
 */
import { Suspense } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { PanelSuspense } from './PanelSuspense';
import { showPanel } from './activity-bar/nav';
import { PANEL_CLOSE_TO_CHAT_SENTINEL, VIEW_REGISTRY, type ViewMeta } from './view-registry';
import { useAppTranslation } from '@/i18n';
import type { View } from '@/stores/ui-store';

interface MainViewSlotProps {
  view: View;
  onCloseToChat: () => void;
}

export function MainViewSlot({
  view,
  onCloseToChat,
}: MainViewSlotProps): React.ReactElement | null {
  const { t } = useAppTranslation();
  const meta = VIEW_REGISTRY[view];
  if (!meta) return null;

  const Component = meta.Component;
  const props: Record<string, unknown> = { ...(meta.props ?? {}) };

  for (const [k, v] of Object.entries(props)) {
    if (v === PANEL_CLOSE_TO_CHAT_SENTINEL) props[k] = onCloseToChat;
  }

  const content = meta.wrapperClassName ? (
    <div className={meta.wrapperClassName}>
      <Component {...props} />
    </div>
  ) : (
    <Component {...props} />
  );

  const suspenseFallback = meta.loadingLabelKey ? (
    // Reading the same key the boundary uses keeps the spinner label
    // identical with what the boundary reports on a crash.
    <PanelSuspense label={t('common:loadingNamed', { name: t(meta.loadingLabelKey) })} />
  ) : (
    <PanelSuspense />
  );

  return (
    <ErrorBoundary level="panel" name={t(meta.boundaryNameKey)}>
      <Suspense fallback={suspenseFallback}>{content}</Suspense>
    </ErrorBoundary>
  );
}

/**
 * Production `onClose` factory — identical to what the per-view `<button>`
 * buttons wired by hand in the legacy ViewRouter did: clear the sidebar,
 * surface chat. Exported so tests can import it without re-implementing the
 * contract.
 */
export function defaultOnCloseToChat(): void {
  showPanel('chat');
}

// Re-export for callers that want to inspect the registry shape (mainly tests).
export type { ViewMeta };
