import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useIsFullChrome } from '@/hooks/useChromeLevel';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  openMainView,
  openPanel,
  shortcutLabelForActivity,
  showPanel,
} from '@/lib/view-navigation';
import {
  type Activity,
  selectUnreadCount,
  useConfigStore,
  useMailboxStore,
  useSessionStore,
  useSessionTabStore,
  useUIStore,
} from '@/stores';
import { ActivityBarCustomizeModal } from './activity-bar-customize-modal.js';
import {
  applyLockedAnchors,
  DESKTOP_CORE_PANEL_IDS,
  PANELS,
  resolveActivityOrder,
  splitDesktopActivityBarItems,
  useDesktopActivityCapacity,
  VIEWS,
} from './activity-bar-items.js';
import { ACTIVITY_BAR_MAX_ICONS, defaultPinnedIds } from './activity-bar-pins.js';
import { ActivityIcon, UtilitiesMenu } from './activity-bar-utilities.js';
import { MobileActivityBar } from './mobile-activity-bar';
import { ToolsLauncher } from './tools-launcher';

export {
  applyLockedAnchors,
  calculateDesktopActivityCapacity,
  moveItemId,
  resolveActivityOrder,
  splitDesktopActivityBarItems,
} from './activity-bar-items.js';

// Convenience set for O(1) `isLocked` checks.
const DESKTOP_CORE_PANEL_IDS_SET: ReadonlySet<string> = new Set(DESKTOP_CORE_PANEL_IDS);

export const PANEL_ORDER: readonly Activity[] = PANELS.map((p) => p.id);

export function ActivityBar() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const projectName = useSessionStore((s) => s.projectName);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { t } = useAppTranslation();
  // Translate nav labels at render time (arrays are module-level constants;
  // `def.label` is kept as the English fallback for any missing key).
  const navLabel = (id: string, fallback: string) => t(`activity:nav.${id}`, fallback);
  const unreadMail = useMailboxStore(selectUnreadCount);
  // Active session-tab count — rendered as the chat icon's badge.
  const openTabCount = useSessionTabStore((s) => s.openTabIds.length);
  // Subscribe (not getState()) so the utility trigger updates its active
  // highlight when the inspector opens or closes.
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  // ── User-customized icon order + pin selection ──
  // The order and the pinned selection live in the persisted store so they
  // survive F5 + reload; the customize dialog edits them and the rail
  // re-renders from the store the moment they are saved.
  const customOrder = useUIStore((s) => s.activityBarOrder);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const fullChrome = useIsFullChrome();
  const chromeLevel = fullChrome ? 'full' : 'calm';

  // ── Effective ordering ──
  // Panels: locked anchors (chat/files/changes/mailbox) stay at top in
  // default relative order; the rest follow the stored order. Views follow
  // the stored order as well. Only pinned ids reach the rail — everything
  // else moves into the "…" menu (and the Tools launcher).
  const seed = useMemo(
    () => customOrder?.pinned ?? defaultPinnedIds(chromeLevel),
    [customOrder?.pinned, chromeLevel],
  );
  const pinnedPanelIds = useMemo(() => new Set(seed.panels), [seed]);
  const pinnedViewIds = useMemo(() => new Set(seed.views), [seed]);
  // Full order (pinned + unpinned) — the unpinned tail feeds the "…" menu.
  const fullPanels = useMemo(
    () => applyLockedAnchors(PANELS, customOrder?.panels, DESKTOP_CORE_PANEL_IDS_SET),
    [customOrder?.panels],
  );
  const fullViews = useMemo(
    () => resolveActivityOrder(VIEWS, customOrder?.views),
    [customOrder?.views],
  );
  const orderedPanels = useMemo(
    () => fullPanels.filter((def) => pinnedPanelIds.has(def.id)),
    [fullPanels, pinnedPanelIds],
  );
  const orderedViews = useMemo(
    () => fullViews.filter((def) => pinnedViewIds.has(def.id)),
    [fullViews, pinnedViewIds],
  );
  // Calm chrome (compact workbench): the bar carries the pinned icons plus
  // the ToolsLauncher, which maps every tool.
  const calmBar = !fullChrome;
  // Always calculate capacity — when icons don't fit the viewport they
  // overflow into the "…" menu instead of scrolling. The launcher takes a
  // slot; the icon budget (`ACTIVITY_BAR_MAX_ICONS`) is the hard ceiling.
  const desktopCapacity = useDesktopActivityCapacity();
  const contentCapacity = Math.min(
    calmBar ? desktopCapacity - 1 : desktopCapacity,
    ACTIVITY_BAR_MAX_ICONS,
  );
  const desktopSplit = useMemo(
    () => splitDesktopActivityBarItems(contentCapacity, orderedPanels, orderedViews),
    [contentCapacity, orderedPanels, orderedViews],
  );
  const visiblePanelIdSet = useMemo(
    () => new Set(desktopSplit.visiblePanelIds),
    [desktopSplit.visiblePanelIds],
  );
  const visibleViewIdSet = useMemo(
    () => new Set(desktopSplit.visibleViewIds),
    [desktopSplit.visibleViewIds],
  );
  const visiblePanels = orderedPanels.filter((def) => visiblePanelIdSet.has(def.id));
  const visibleViews = orderedViews.filter((def) => visibleViewIdSet.has(def.id));

  // ── Hidden items ──
  // Everything the user did not pin, plus the pinned icons that did not fit
  // the viewport. Calm chrome hides the views in the "…" menu because the
  // Tools launcher already lists every tool; full chrome has no launcher,
  // so unpinned views must stay reachable there.
  const hiddenPanelIds = useMemo(() => {
    const ids = new Set<string>(desktopSplit.overflowPanelIds);
    for (const def of fullPanels) {
      if (!pinnedPanelIds.has(def.id)) ids.add(def.id);
    }
    return ids;
  }, [desktopSplit.overflowPanelIds, fullPanels, pinnedPanelIds]);
  const hiddenViewIds = useMemo(() => {
    const ids = new Set<string>(desktopSplit.overflowViewIds);
    for (const def of fullViews) {
      if (!pinnedViewIds.has(def.id)) ids.add(def.id);
    }
    return ids;
  }, [desktopSplit.overflowViewIds, fullViews, pinnedViewIds]);
  const hiddenPanels = fullPanels.filter((def) => hiddenPanelIds.has(def.id));
  const hiddenViews = calmBar ? [] : fullViews.filter((def) => hiddenViewIds.has(def.id));

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'mailbox') return unreadMail || undefined;
    if (id === 'chat') return openTabCount > 0 ? openTabCount : undefined;
    return undefined;
  };

  return (
    <>
      <div
        className={cn(
          'ws-activity-rail hidden h-full w-12 min-h-0 shrink-0 flex-col border-r border-border/70 backdrop-blur-xl md:flex',
        )}
      >
        {/* ── Branding — edge-to-edge logo (pinned top) ── */}
        <div className="flex flex-col items-center shrink-0 border-b border-border/60">
          <button
            type="button"
            onClick={() => {
              // "Home" — open the Session panel, back to chat.
              showPanel('chat');
            }}
            title={
              projectName
                ? t('activity:brand.returnToChat', { name: projectName })
                : t('activity:brand.returnToChatDefault')
            }
            className={cn(
              'relative flex h-11 w-full items-center justify-center overflow-hidden bg-foreground transition-shadow hover:shadow-[0_3px_12px_-2px_hsl(var(--primary)/0.5)]',
            )}
          >
            <img
              src="/wrongstack.svg"
              alt=""
              aria-hidden="true"
              draggable={false}
              className="ws-brand-logo h-full w-full"
            />
          </button>
        </div>

        {/* ── Icon column ──
            Panels + main-view icons. When the viewport is too short to fit
            all icons, overflow items are moved into the "…" menu instead of
            scrolling. Note: `overflow-hidden` means browser WebUI (full) mode
            also loses scroll fallback — ensure enough slots for core icons. */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col items-center pt-2 pb-1">
          {/* Panel icons */}
          {visiblePanels.map((def) => (
            <ActivityIcon
              key={def.id}
              icon={def.icon}
              label={`${navLabel(def.id, def.label)} (${shortcutLabelForActivity(def.id)})`}
              active={sidebarOpen && activeActivity === def.id}
              badge={badgeFor(def.id)}
              onClick={() => openPanel(def.id)}
            />
          ))}

          {/* Divider between panels and main-view switchers */}
          {visibleViews.length > 0 && <div className="my-1.5 h-px w-6 shrink-0 bg-border/70" />}

          {/* Main-view icons */}
          {visibleViews.map((def) => (
            <ActivityIcon
              key={def.id}
              icon={def.icon}
              label={navLabel(def.id, def.label)}
              active={currentView === def.id}
              onClick={() => openMainView(def.id)}
            />
          ))}

          {calmBar && <ToolsLauncher onCustomize={() => setCustomizeOpen(true)} />}
        </div>

        {/* ── Connection indicator — compact dot between icon column and utilities ── */}
        <div
          role="status"
          aria-label={
            wsConnected
              ? t('activity:connection.connected', 'Connected')
              : t('activity:connection.disconnected', 'Disconnected')
          }
          className="flex items-center justify-center py-1"
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              wsConnected ? 'bg-success' : 'bg-muted-foreground/40',
            )}
            title={
              wsConnected
                ? t('activity:connection.connected', 'Connected')
                : t('activity:connection.disconnected', 'Disconnected')
            }
          />
        </div>

        {/* ── Utilities overflow menu — pinned bottom ──
            App-wide controls (palette, command, shortcuts, monitors,
            Settings) collapsed into one popover. Items that don't fit
            the visible icon slots also land here. */}
        <div className="flex flex-col items-center shrink-0 pt-1 pb-2 border-t border-border/60">
          {/* ── Customize the bar ──
              Opens the one-screen editor: the icons pinned to the bar on the
              left, everything else on the right. Saving writes the
              selection to the store, so the rail refreshes immediately. */}
          <button
            type="button"
            data-testid="activity-bar-reorder-edit"
            onClick={() => setCustomizeOpen(true)}
            aria-label={t('activity:reorder.edit', { max: ACTIVITY_BAR_MAX_ICONS })}
            title={t('activity:reorder.edit', { max: ACTIVITY_BAR_MAX_ICONS })}
            className={cn(
              'ws-nav-button relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors',
              'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
            )}
          >
            <span className="h-5 w-5 shrink-0">
              <Pencil size={16} />
            </span>
          </button>
          <UtilitiesMenu
            monitorOpen={inspectorOpen}
            hiddenPanels={hiddenPanels}
            hiddenViews={hiddenViews}
          />
        </div>
      </div>
      <MobileActivityBar onCustomize={() => setCustomizeOpen(true)} />
      <ActivityBarCustomizeModal open={customizeOpen} onOpenChange={setCustomizeOpen} />
    </>
  );
}
