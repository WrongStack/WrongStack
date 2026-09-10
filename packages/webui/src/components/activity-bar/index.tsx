import {
  Bot,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  Check,
  ClipboardList,
  Columns3,
  Command,
  FolderOpen,
  GitCompare,
  GitFork,
  Keyboard,
  Layers,
  LayoutGrid,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Network,
  Palette,
  Pencil,
  Rocket,
  RotateCcw,
  ScrollText,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import type { MainView } from '@/lib/view-navigation';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

// ── Activity definitions ───────────────────────────────────────────────
//
// Two icon groups with two distinct behaviours:
//  - TOP icons each own one side-panel (open / switch / close-on-reclick)
//    and always steer the matching main surface.
//  - BOTTOM icons toggle a standalone main view (Phases, Flow, Settings)
//    and collapse the side-panel so stale secondary content does not linger.

interface PanelDef {
  id: Activity;
  icon: ReactElement;
  label: string;
}

interface ViewDef {
  id: MainView;
  icon: ReactElement;
  label: string;
}

const PANELS: PanelDef[] = [
  { id: 'chat', icon: <MessageSquare size={16} />, label: 'Session' },
  { id: 'files', icon: <FolderOpen size={16} />, label: 'Files' },
  { id: 'changes', icon: <GitCompare size={16} />, label: 'Changes' },
  { id: 'mailbox', icon: <Mail size={16} />, label: 'Mailbox' },
  { id: 'skills', icon: <Sparkles size={16} />, label: 'Skills' },
  { id: 'design', icon: <Palette size={16} />, label: 'Design Studio' },
];

// Worktree lanes and the Fleet/Office Map moved out of the bar: worktrees is
// a tab inside the Changes panel (Ctrl+Shift+W still lands there), the map is
// the 'officemap' tab of the Agent Roster view (F11). Settings lives in the
// "…" utilities menu (Ctrl+9 / palette unchanged) — its standalone icon was
// redundant with that menu's full Settings section.
// Views follow the delivery pipeline, top to bottom:
//   define (Requirements → SDD spec → Goal → Kanban) → execute (Agent Roster)
//   → inspect (CodeMap → TechStack → Repository History) → review (Chronicle
//   → Prompt Journal → Chimera) → retain (Memory).
// Order also decides what stays visible on short viewports — the first N
// views keep their slot, the rest fall into the "…" overflow menu.
const VIEWS: ViewDef[] = [
  { id: 'intake', icon: <ClipboardList size={16} />, label: 'Requirements' },
  { id: 'sddhub', icon: <Wand2 size={16} />, label: 'SDD' },
  { id: 'goal', icon: <Rocket size={16} />, label: 'Goal' },
  { id: 'kanban', icon: <Columns3 size={16} />, label: 'Kanban' },
  // Agent Roster is a primary surface — it must stay visible on typical
  // viewports instead of silently falling into the "…" overflow menu.
  { id: 'roster', icon: <Bot size={16} />, label: 'Agent Roster' },
  { id: 'codemap', icon: <Network size={16} />, label: 'CodeMap' },
  { id: 'techstack', icon: <Boxes size={16} />, label: 'TechStack' },
  { id: 'history', icon: <GitFork size={16} />, label: 'Repository History' },
  { id: 'chronicle', icon: <ChartNoAxesCombined size={16} />, label: 'Chronicle' },
  { id: 'prompts', icon: <ScrollText size={16} />, label: 'Prompt Journal' },
  { id: 'chimera', icon: <ShieldAlert size={16} />, label: 'Chimera Reviews' },
  { id: 'memory', icon: <BrainCircuit size={16} />, label: 'Memory' },
];

const DESKTOP_CORE_PANEL_IDS: readonly Activity[] = ['chat', 'files', 'changes', 'mailbox'];
// Convenience set for O(1) `isLocked` checks during drag/drop.
const DESKTOP_CORE_PANEL_IDS_SET: ReadonlySet<string> = new Set(DESKTOP_CORE_PANEL_IDS);

const DESKTOP_PANEL_PRIORITY: readonly Activity[] = [...DESKTOP_CORE_PANEL_IDS, 'skills', 'design'];

// Compact (desktop shell): h-9 icons, no project name text.
// Full   (browser WebUI): h-11 icons, taller brand area with project name.
const COMPACT_RESERVED_PX = 132;
const COMPACT_SLOT_PX = 38;
const FULL_RESERVED_PX = 165;
const FULL_SLOT_PX = 46;

export function calculateDesktopActivityCapacity(
  viewportHeight: number,
  isDesktopShell: boolean,
): number {
  const max = PANELS.length + VIEWS.length;
  const height = Number.isFinite(viewportHeight) ? viewportHeight : 720;
  const reserved = isDesktopShell ? COMPACT_RESERVED_PX : FULL_RESERVED_PX;
  const slot = isDesktopShell ? COMPACT_SLOT_PX : FULL_SLOT_PX;
  const slots = Math.floor((height - reserved) / slot);
  return Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, slots));
}

export function splitDesktopActivityBarItems(
  capacity: number,
  orderedPanels: readonly PanelDef[] = PANELS,
  orderedViews: readonly ViewDef[] = VIEWS,
): {
  visiblePanelIds: Activity[];
  overflowPanelIds: Activity[];
  visibleViewIds: MainView[];
  overflowViewIds: MainView[];
} {
  const max = orderedPanels.length + orderedViews.length;
  const slots = Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, Math.floor(capacity)));
  const visiblePanelCount = Math.min(orderedPanels.length, slots);
  // Visibility membership is *priority-based* (core panels always visible on
  // short viewports) so locked anchors cannot be displaced; only the *order*
  // of the returned ids follows the effective list passed in.
  const visiblePanelSet = new Set(DESKTOP_PANEL_PRIORITY.slice(0, visiblePanelCount));
  const visiblePanelIds = orderedPanels
    .map((def) => def.id)
    .filter((id) => visiblePanelSet.has(id));
  const overflowPanelIds = orderedPanels
    .map((def) => def.id)
    .filter((id) => !visiblePanelSet.has(id));
  const visibleViewCount = Math.max(0, slots - visiblePanelIds.length);
  // Views: first N of the effective (possibly user-customized) order — so a
  // user-prioritized view stays visible on short viewports.
  const visibleViewIds = orderedViews.slice(0, visibleViewCount).map((def) => def.id);
  const visibleViewSet = new Set(visibleViewIds);
  const overflowViewIds = orderedViews
    .map((def) => def.id)
    .filter((id) => !visibleViewSet.has(id));
  return { visiblePanelIds, overflowPanelIds, visibleViewIds, overflowViewIds };
}

export const PANEL_ORDER: readonly Activity[] = PANELS.map((p) => p.id);

// ── User-customized order (drag & drop) ────────────────────────────────
//
// Only a few icons stay fixed ("yerleri sabitlemesek bir kaçı hariç"): the
// core workflow panels that the responsive split guarantees visible on
// short viewports and that have keyboard shortcuts 1-4. Everything else
// (skills/design + all main views) is reorderable via the edit-mode drag.
//
// Locked items are anchors: they keep their default indices, and the
// reorderable items fill the remaining slots in the user's order. Drop
// targets on locked items are ignored.

/** Reorder `defaults` to follow `custom` (ids), dropping unknown entries and
 *  appending anything from `defaults` that `custom` omitted. New icons
 *  added to `defaults` after the user saved their order automatically
 *  appear at the end. */
export function resolveActivityOrder<T extends { id: string }>(
  defaults: readonly T[],
  custom: readonly string[] | null | undefined,
): T[] {
  if (!custom || custom.length === 0) return defaults as T[];
  const byId = new Map(defaults.map((def) => [def.id, def] as const));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of custom) {
    const def = byId.get(id);
    if (def && !seen.has(id)) {
      out.push(def);
      seen.add(id);
    }
  }
  for (const def of defaults) {
    if (!seen.has(def.id)) out.push(def);
  }
  return out;
}

/** Render `defaults` with the items listed in `locked` occupying their
 *  original indices, and the rest of the items filled in the custom order
 *  (filtering out unknown ids, deduping). Locked anchors cannot move. */
export function applyLockedAnchors<T extends { id: string }>(
  defaults: readonly T[],
  custom: readonly string[] | null | undefined,
  locked: ReadonlySet<string>,
): T[] {
  const movable = resolveActivityOrder(
    defaults.filter((def) => !locked.has(def.id)),
    custom ? custom.filter((id) => !locked.has(id)) : undefined,
  );
  const out: T[] = [];
  let mi = 0;
  for (const def of defaults) {
    if (locked.has(def.id)) {
      out.push(def);
    } else if (mi < movable.length) {
      out.push(movable[mi++]!);
    }
  }
  return out;
}

/** Move `fromId` to the position currently held by `toId`. Returns the
 *  original ids when either id is missing. */
export function moveItemId<T extends string>(ids: readonly T[], fromId: string, toId: string): T[] {
  if (fromId === toId) return ids as T[];
  const from = (ids as readonly string[]).indexOf(fromId);
  const to = (ids as readonly string[]).indexOf(toId);
  if (from === -1 || to === -1) return ids as T[];
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// ── Component ──────────────────────────────────────────────────────────

function readViewportHeight(): number {
  if (typeof window === 'undefined') return 720;
  return window.visualViewport?.height ?? window.innerHeight;
}

function useDesktopActivityCapacity(isDesktopShell: boolean): number {
  const [height, setHeight] = useState(readViewportHeight);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setHeight(readViewportHeight());
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);
  return calculateDesktopActivityCapacity(height, isDesktopShell);
}

export function ActivityBar({ desktopShell = false }: { desktopShell?: boolean | undefined }) {
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
  // ── User-customized icon order (drag/drop) ──
  // Local-only reorder UI mode; the actual order itself lives in the
  // persisted store so it survives F5 + reload.
  const customOrder = useUIStore((s) => s.activityBarOrder);
  const setCustomOrder = useUIStore((s) => s.setActivityBarOrder);
  const [reorderMode, setReorderMode] = useState(false);
  // ── Effective ordering ──
  // Panels: locked anchors (chat/files/changes/mailbox) stay at top in
  // default relative order; the rest fill the remaining slots in
  // `customOrder.panels` (filtered/deduped). Views: full reorder (no
  // locked items below the panels).
  const orderedPanels = useMemo(
    () => applyLockedAnchors(PANELS, customOrder?.panels, DESKTOP_CORE_PANEL_IDS_SET),
    [customOrder?.panels],
  );
  const orderedViews = useMemo(
    () => resolveActivityOrder(VIEWS, customOrder?.views),
    [customOrder?.views],
  );
  // Always calculate capacity — when icons don't fit the viewport they
  // overflow into the "…" menu instead of scrolling.
  const desktopCapacity = useDesktopActivityCapacity(desktopShell);
  const desktopSplit = useMemo(
    () => splitDesktopActivityBarItems(desktopCapacity, orderedPanels, orderedViews),
    [desktopCapacity, orderedPanels, orderedViews],
  );
  const visiblePanelIdSet = useMemo(
    () => new Set(desktopSplit.visiblePanelIds),
    [desktopSplit.visiblePanelIds],
  );
  const overflowPanelIdSet = useMemo(
    () => new Set(desktopSplit.overflowPanelIds),
    [desktopSplit.overflowPanelIds],
  );
  const visibleViewIdSet = useMemo(
    () => new Set(desktopSplit.visibleViewIds),
    [desktopSplit.visibleViewIds],
  );
  const overflowViewIdSet = useMemo(
    () => new Set(desktopSplit.overflowViewIds),
    [desktopSplit.overflowViewIds],
  );
  const visiblePanels = orderedPanels.filter((def) => visiblePanelIdSet.has(def.id));
  const overflowPanels = orderedPanels.filter((def) => overflowPanelIdSet.has(def.id));
  const visibleViews = orderedViews.filter((def) => visibleViewIdSet.has(def.id));
  const overflowViews = orderedViews.filter((def) => overflowViewIdSet.has(def.id));

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'mailbox') return unreadMail || undefined;
    if (id === 'chat') return openTabCount > 0 ? openTabCount : undefined;
    return undefined;
  };

  // Drag state (transient; lives only while `reorderMode` is on).
  // HTML5 DnD handles only same-group drops; locked items are never
  // valid drop targets (anchors).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const isLockedId = (id: string) => DESKTOP_CORE_PANEL_IDS_SET.has(id);
  const closeReorder = () => {
    setReorderMode(false);
    setDragId(null);
    setDragOverId(null);
  };
  const resetCustomOrder = () => {
    setCustomOrder(null);
    closeReorder();
  };
  // ── Drag handlers ──
  const onDragStart = (group: 'panel' | 'view', id: string) => (e: React.DragEvent) => {
    if (!reorderMode) return;
    if (group === 'panel' && isLockedId(id)) {
      e.preventDefault();
      return;
    }
    setDragId(id);
    setDragOverId(null);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (group: 'panel' | 'view', id: string) => (e: React.DragEvent) => {
    if (!reorderMode || dragId == null || dragId === id) return;
    if (isLockedId(id)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverId !== id) setDragOverId(id);
  };
  const onDragLeave = (id: string) => (e: React.DragEvent) => {
    if (dragOverId === id) setDragOverId(null);
    e.preventDefault();
  };
  const onDrop = (group: 'panel' | 'view', id: string) => (e: React.DragEvent) => {
    if (!reorderMode || dragId == null || dragId === id) return;
    if (isLockedId(id)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (group === 'panel') {
      const current = orderedPanels.map((p) => p.id);
      const next = moveItemId(current, dragId, id);
      setCustomOrder({ panels: next, views: orderedViews.map((v) => v.id) });
    } else {
      const current = orderedViews.map((v) => v.id);
      const next = moveItemId(current, dragId, id);
      setCustomOrder({ panels: orderedPanels.map((p) => p.id), views: next });
    }
    setDragId(null);
    setDragOverId(null);
  };
  const onDragEnd = () => {
    setDragId(null);
    setDragOverId(null);
  };

  return (
    <div
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col border-r border-border/70 bg-card/75 backdrop-blur-xl',
        desktopShell ? 'w-10' : 'w-12',
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
            'relative flex items-center justify-center overflow-hidden bg-foreground transition-shadow hover:shadow-[0_3px_12px_-2px_hsl(var(--primary)/0.5)]',
            desktopShell ? 'w-full h-8' : 'w-full h-11',
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
        {visiblePanels.map((def) => {
          const locked = isLockedId(def.id);
          return (
            <ActivityIcon
              key={def.id}
              compact={desktopShell}
              icon={def.icon}
              label={`${navLabel(def.id, def.label)} (${shortcutLabelForActivity(def.id)})`}
              active={sidebarOpen && activeActivity === def.id}
              badge={badgeFor(def.id)}
              onClick={() => openPanel(def.id)}
              reorderMode={reorderMode}
              draggable={reorderMode && !locked}
              locked={locked}
              isDragOver={reorderMode && dragOverId === def.id}
              isDragging={reorderMode && dragId === def.id}
              onDragStart={onDragStart('panel', def.id)}
              onDragOver={onDragOver('panel', def.id)}
              onDragLeave={onDragLeave(def.id)}
              onDrop={onDrop('panel', def.id)}
              onDragEnd={onDragEnd}
            />
          );
        })}

        {/* Divider between panels and main-view switchers */}
        {visibleViews.length > 0 && <div className="my-1.5 h-px w-6 shrink-0 bg-border/70" />}

        {/* Main-view icons */}
        {visibleViews.map((def) => (
          <ActivityIcon
            key={def.id}
            compact={desktopShell}
            icon={def.icon}
            label={navLabel(def.id, def.label)}
            active={currentView === def.id}
            onClick={() => openMainView(def.id)}
            reorderMode={reorderMode}
            draggable={reorderMode}
            isDragOver={reorderMode && dragOverId === def.id}
            isDragging={reorderMode && dragId === def.id}
            onDragStart={onDragStart('view', def.id)}
            onDragOver={onDragOver('view', def.id)}
            onDragLeave={onDragLeave(def.id)}
            onDrop={onDrop('view', def.id)}
            onDragEnd={onDragEnd}
          />
        ))}
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
        {/* ── Edit / done / reset toggles (drag/drop edit mode) ──
              Lives in the same bottom sticky column as the utilities
              "…" so it stays discoverable without crowding the icon
              column. Click-cycle: pencil → done. Reset is a one-tap
              escape back to the default delivery-pipeline order. */}
        {reorderMode ? (
          <>
            <button
              type="button"
              data-testid="activity-bar-reorder-done"
              onClick={closeReorder}
              aria-label={t('activity:reorder.done', 'Done')}
              title={t('activity:reorder.done', 'Done')}
              className={cn(
                'ws-nav-button relative flex shrink-0 items-center justify-center rounded-md transition-colors',
                desktopShell ? 'h-9 w-9' : 'h-11 w-11',
                'text-primary bg-primary/10 ring-1 ring-primary/30 hover:bg-primary/15',
              )}
            >
              <span className="h-5 w-5 shrink-0">
                <Check size={16} />
              </span>
            </button>
            <button
              type="button"
              data-testid="activity-bar-reorder-reset"
              onClick={resetCustomOrder}
              aria-label={t('activity:reorder.reset', 'Reset to default')}
              title={t('activity:reorder.reset', 'Reset to default')}
              className={cn(
                'ws-nav-button relative flex shrink-0 items-center justify-center rounded-md transition-colors',
                desktopShell ? 'h-9 w-9' : 'h-11 w-11',
                'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
              )}
            >
              <span className="h-5 w-5 shrink-0">
                <RotateCcw size={16} />
              </span>
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="activity-bar-reorder-edit"
            onClick={() => setReorderMode(true)}
            aria-label={t('activity:reorder.edit', 'Edit order')}
            title={t('activity:reorder.edit', 'Edit order')}
            className={cn(
              'ws-nav-button relative flex shrink-0 items-center justify-center rounded-md transition-colors',
              desktopShell ? 'h-9 w-9' : 'h-11 w-11',
              'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
            )}
          >
            <span className="h-5 w-5 shrink-0">
              <Pencil size={16} />
            </span>
          </button>
        )}
        <UtilitiesMenu
          compact={desktopShell}
          monitorOpen={inspectorOpen}
          overflowPanels={overflowPanels}
          overflowViews={overflowViews}
        />
      </div>
    </div>
  );
}

/**
 * Bottom "More" popover collecting the app-wide utilities that used to sit as
 * loose icons in the ActivityBar: command palette, theme, keyboard shortcuts,
 * and the Fleet / Agents monitors. Keeping them behind one trigger frees four
 * vertical slots so the bar fits comfortably on short viewports.
 */
function UtilitiesMenu({
  compact = false,
  monitorOpen,
  overflowPanels,
  overflowViews,
}: {
  compact?: boolean | undefined;
  monitorOpen: boolean;
  overflowPanels: PanelDef[];
  overflowViews: ViewDef[];
}) {
  const { t } = useAppTranslation();
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const hiddenItemCount = overflowPanels.length + overflowViews.length;
  const hiddenPanelActive = overflowPanels.some((def) => sidebarOpen && activeActivity === def.id);
  const hiddenViewActive = overflowViews.some((def) => currentView === def.id);
  const hiddenActive = hiddenPanelActive || hiddenViewActive;

  const toggleInspectorTab = (tab: 'fleet' | 'sideEffects') => {
    const ui = useUIStore.getState();
    if (ui.inspectorOpen && ui.inspectorTab === tab) {
      ui.setInspectorOpen(false);
    } else {
      ui.setInspectorTab(tab);
      ui.setInspectorOpen(true);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={
            hiddenItemCount > 0
              ? t('activity:menu.moreWithHidden', { count: hiddenItemCount })
              : t('activity:menu.moreOptions')
          }
          title={
            compact && hiddenItemCount > 0
              ? t('activity:menu.moreCompactHidden', { count: hiddenItemCount })
              : compact
                ? t('activity:menu.moreCompact')
                : t('activity:menu.moreFull')
          }
          className={cn(
            'ws-nav-button relative flex items-center justify-center rounded-md transition-colors',
            compact ? 'h-9 w-9' : 'h-11 w-11',
            'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
            'data-[state=open]:text-primary data-[state=open]:bg-primary/10 data-[state=open]:border-primary/30',
            (monitorOpen || hiddenActive) && 'text-primary',
          )}
        >
          <span className="h-5 w-5 flex items-center justify-center">
            <MoreHorizontal size={16} />
          </span>
          {hiddenItemCount > 0 && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded px-1 text-[8px] font-bold leading-none tabular',
                hiddenActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted-foreground text-background',
              )}
            >
              {hiddenItemCount > 9 ? '9+' : hiddenItemCount}
            </span>
          )}
          {/* Dot indicating a monitor is currently open behind the menu */}
          {monitorOpen && hiddenItemCount === 0 && (
            <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
        <DropdownMenuItem onSelect={() => useUIStore.getState().setPaletteOpen(true)}>
          <Command size={16} />
          <span>{t('activity:menu.commandPalette')}</span>
          <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useUIStore.getState().setShortcutsOpen(true)}>
          <Keyboard size={16} />
          <span>{t('activity:menu.keyboardShortcuts')}</span>
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>

        {overflowPanels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
              {t('activity:menu.panels')}
            </DropdownMenuLabel>
            {overflowPanels.map((def) => (
              <DropdownMenuItem key={def.id} onSelect={() => showPanel(def.id)}>
                {def.icon}
                <span>{t(`activity:nav.${def.id}`, def.label)}</span>
                {sidebarOpen && activeActivity === def.id ? (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                ) : (
                  <DropdownMenuShortcut>{shortcutLabelForActivity(def.id)}</DropdownMenuShortcut>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        {overflowViews.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
              {t('activity:menu.views')}
            </DropdownMenuLabel>
            {overflowViews.map((def) => (
              <DropdownMenuItem key={def.id} onSelect={() => openMainView(def.id)}>
                {def.icon}
                <span>{t(`activity:nav.${def.id}`, def.label)}</span>
                {currentView === def.id && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
          {t('activity:nav.settings', 'Settings')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => openMainView('settings')}>
          <SettingsIcon size={16} />
          <span>{t('activity:nav.settings', 'Settings')}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t('settings:tabs.general', 'overview')}
          </span>
        </DropdownMenuItem>
        {[
          { icon: <Palette size={14} />, label: 'General', tab: 'general' },
          { icon: <Network size={14} />, label: 'Provider', tab: 'provider' },
          { icon: <Bot size={14} />, label: 'Agent', tab: 'agent' },
          { icon: <Zap size={14} />, label: 'Execution', tab: 'execution' },
          { icon: <Layers size={14} />, label: 'Fallbacks', tab: 'fallbacks' },
        ].map(({ icon, label, tab }) => (
          <DropdownMenuItem
            key={tab}
            onSelect={() => {
              useUIStore.getState().setSettingsActiveTab(tab);
              openMainView('settings');
            }}
          >
            {icon}
            <span>{t(`settings:tabs.${tab}`, label)}</span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">
          {t('activity:menu.monitors')}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('fleet')}>
          <LayoutGrid size={16} />
          <span>{t('activity:menu.fleetMonitor')}</span>
          {inspectorOpen && inspectorTab === 'fleet' ? (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <DropdownMenuShortcut>⇧⌘M</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('sideEffects')}>
          <Zap size={16} />
          <span>{t('activity:inspector.tabAudit')}</span>
          {inspectorOpen && inspectorTab === 'sideEffects' ? (
            <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
          ) : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActivityIcon({
  compact = false,
  icon,
  label,
  active,
  badge,
  onClick,
  reorderMode = false,
  draggable = false,
  locked = false,
  isDragOver = false,
  isDragging = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: {
  compact?: boolean | undefined;
  icon: ReactElement;
  label: string;
  active: boolean;
  badge?: number | undefined;
  onClick: () => void;
  reorderMode?: boolean | undefined;
  draggable?: boolean | undefined;
  locked?: boolean | undefined;
  isDragOver?: boolean | undefined;
  isDragging?: boolean | undefined;
  onDragStart?: ((e: React.DragEvent) => void) | undefined;
  onDragOver?: ((e: React.DragEvent) => void) | undefined;
  onDragLeave?: ((e: React.DragEvent) => void) | undefined;
  onDrop?: ((e: React.DragEvent) => void) | undefined;
  onDragEnd?: ((e: React.DragEvent) => void) | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={locked && reorderMode ? `${label} — ${'Sabit'}` : label}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      data-reorder-mode={reorderMode ? 'on' : 'off'}
      data-locked={locked ? '1' : '0'}
      data-drag-over={isDragOver ? '1' : '0'}
      data-dragging={isDragging ? '1' : '0'}
      className={cn(
        'ws-nav-button relative flex shrink-0 items-center justify-center rounded-md transition-colors',
        compact ? 'h-9 w-9' : 'h-11 w-11',
        'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
        active && 'ws-nav-button-active',
        reorderMode && !locked && 'cursor-grab active:cursor-grabbing ring-1 ring-primary/40',
        reorderMode && locked && 'opacity-70 cursor-not-allowed',
        isDragOver && 'ring-2 ring-primary bg-primary/15 text-foreground',
      )}
    >
      {/* Active indicator — left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-primary" />
      )}
      <span className="h-5 w-5 shrink-0">{icon}</span>
      {/* Lock badge — pinned icons in edit mode */}
      {locked && reorderMode && (
        <span
          aria-label="locked"
          className="absolute -top-1 -left-1 h-3.5 w-3.5 flex items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border"
        >
          <Lock size={9} />
        </span>
      )}
      {/* Badge count — top-right pill */}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded bg-primary text-[8px] font-bold text-primary-foreground leading-none px-1 tabular">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
