import {
  Bot,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  ClipboardList,
  Columns3,
  Command,
  FolderOpen,
  GitCompare,
  Keyboard,
  Layers,
  LayoutGrid,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Network,
  Palette,
  Rocket,
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
const VIEWS: ViewDef[] = [
  // Agent Roster is a primary surface — it must stay visible on typical
  // viewports instead of silently falling into the "…" overflow menu.
  { id: 'roster', icon: <Bot size={16} />, label: 'Agent Roster' },
  { id: 'sddhub', icon: <Wand2 size={16} />, label: 'SDD' },
  { id: 'kanban', icon: <Columns3 size={16} />, label: 'Kanban' },
  { id: 'goal', icon: <Rocket size={16} />, label: 'Goal' },
  { id: 'codemap', icon: <Network size={16} />, label: 'CodeMap' },
  { id: 'techstack', icon: <Boxes size={16} />, label: 'TechStack' },
  { id: 'chronicle', icon: <ChartNoAxesCombined size={16} />, label: 'Chronicle' },
  { id: 'prompts', icon: <ScrollText size={16} />, label: 'Prompt Journal' },
  { id: 'chimera', icon: <ShieldAlert size={16} />, label: 'Chimera Reviews' },
  { id: 'intake', icon: <ClipboardList size={16} />, label: 'Requirements' },
  { id: 'memory', icon: <BrainCircuit size={16} />, label: 'Memory' },
];

const DESKTOP_CORE_PANEL_IDS: readonly Activity[] = ['chat', 'files', 'changes', 'mailbox'];

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

export function splitDesktopActivityBarItems(capacity: number): {
  visiblePanelIds: Activity[];
  overflowPanelIds: Activity[];
  visibleViewIds: MainView[];
  overflowViewIds: MainView[];
} {
  const max = PANELS.length + VIEWS.length;
  const slots = Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, Math.floor(capacity)));
  const visiblePanelCount = Math.min(PANELS.length, slots);
  const visiblePanelSet = new Set(DESKTOP_PANEL_PRIORITY.slice(0, visiblePanelCount));
  const visiblePanelIds = PANELS.map((def) => def.id).filter((id) => visiblePanelSet.has(id));
  const overflowPanelIds = PANELS.map((def) => def.id).filter((id) => !visiblePanelSet.has(id));
  const visibleViewCount = Math.max(0, slots - visiblePanelIds.length);
  const visibleViewIds = VIEWS.slice(0, visibleViewCount).map((def) => def.id);
  const visibleViewSet = new Set(visibleViewIds);
  const overflowViewIds = VIEWS.map((def) => def.id).filter((id) => !visibleViewSet.has(id));
  return { visiblePanelIds, overflowPanelIds, visibleViewIds, overflowViewIds };
}

export const PANEL_ORDER: readonly Activity[] = PANELS.map((p) => p.id);

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
  // Always calculate capacity — when icons don't fit the viewport they
  // overflow into the "…" menu instead of scrolling.
  const desktopCapacity = useDesktopActivityCapacity(desktopShell);
  const desktopSplit = useMemo(
    () => splitDesktopActivityBarItems(desktopCapacity),
    [desktopCapacity],
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
  const visiblePanels = PANELS.filter((def) => visiblePanelIdSet.has(def.id));
  const overflowPanels = PANELS.filter((def) => overflowPanelIdSet.has(def.id));
  const visibleViews = VIEWS.filter((def) => visibleViewIdSet.has(def.id));
  const overflowViews = VIEWS.filter((def) => overflowViewIdSet.has(def.id));

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'mailbox') return unreadMail || undefined;
    if (id === 'chat') return openTabCount > 0 ? openTabCount : undefined;
    return undefined;
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
        {visiblePanels.map((def) => (
          <ActivityIcon
            key={def.id}
            compact={desktopShell}
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
            compact={desktopShell}
            icon={def.icon}
            label={navLabel(def.id, def.label)}
            active={currentView === def.id}
            onClick={() => openMainView(def.id)}
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
}: {
  compact?: boolean | undefined;
  icon: ReactElement;
  label: string;
  active: boolean;
  badge?: number | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'ws-nav-button relative flex shrink-0 items-center justify-center rounded-md transition-colors',
        compact ? 'h-9 w-9' : 'h-11 w-11',
        'text-muted-foreground hover:border-border/70 hover:text-foreground hover:bg-muted/60',
        active && 'ws-nav-button-active',
      )}
    >
      {/* Active indicator — left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-primary" />
      )}
      <span className="h-5 w-5 shrink-0">{icon}</span>
      {/* Badge count — top-right pill */}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded bg-primary text-[8px] font-bold text-primary-foreground leading-none px-1 tabular">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
