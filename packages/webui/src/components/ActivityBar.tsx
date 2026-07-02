import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  openMainView,
  openPanel,
  shortcutLabelForActivity,
  showPanel,
} from '@/lib/view-navigation';
import type { MainView } from '@/lib/view-navigation';
import {
  type Activity,
  selectUnreadCount,
  useConfigStore,
  useFleetStore,
  useMailboxStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import {
  Bot,
  Clock,
  Command,
  FileText,
  GitBranch,
  GitCompare,
  FolderOpen,
  Keyboard,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  Rocket,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Zap,
  LayoutGrid,
  Activity as ActivityIconSvg,
  Building2,
  Wand2,
  Palette,
} from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useTheme } from './ThemeProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

export {
  ACTIVITY_SHORTCUT_BY_KEY,
  ACTIVITY_SHORTCUT_LABEL_BY_ACTIVITY,
  navigateToView,
  openMainView,
  openPanel,
  pairedViewForActivity,
  shortcutLabelForActivity,
  showPanel,
} from '@/lib/view-navigation';
export type { MainView, PanelMainView } from '@/lib/view-navigation';

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
  { id: 'agents', icon: <Bot size={16} />, label: 'Agents' },
  { id: 'history', icon: <Clock size={16} />, label: 'History' },
  { id: 'files', icon: <FolderOpen size={16} />, label: 'Files' },
  { id: 'changes', icon: <GitCompare size={16} />, label: 'Changes' },
  { id: 'mailbox', icon: <Mail size={16} />, label: 'Mailbox' },
  { id: 'skills', icon: <Sparkles size={16} />, label: 'Skills' },
  { id: 'worktrees', icon: <GitBranch size={16} />, label: 'Worktrees' },
  { id: 'design', icon: <Palette size={16} />, label: 'Design Studio' },
  { id: 'officemap', icon: <Building2 size={16} />, label: 'Office Map' },
];

const VIEWS: ViewDef[] = [
  { id: 'sddwizard', icon: <Wand2 size={16} />, label: 'New SDD Project' },
  { id: 'specs', icon: <FileText size={16} />, label: 'Specs' },
  { id: 'sddboard', icon: <ActivityIconSvg size={16} />, label: 'Live Board' },
  { id: 'autophase', icon: <Rocket size={16} />, label: 'Phases' },
  { id: 'settings', icon: <SettingsIcon size={16} />, label: 'Settings' },
];

const DESKTOP_CORE_PANEL_IDS: readonly Activity[] = [
  'chat',
  'agents',
  'files',
  'changes',
  'mailbox',
];

const DESKTOP_PANEL_PRIORITY: readonly Activity[] = [
  ...DESKTOP_CORE_PANEL_IDS,
  'history',
  'skills',
  'worktrees',
  'officemap',
  'design',
];

const DESKTOP_ACTIVITY_RESERVED_PX = 132;
const DESKTOP_ACTIVITY_SLOT_PX = 38;

export function calculateDesktopActivityCapacity(viewportHeight: number): number {
  const max = PANELS.length + VIEWS.length;
  const height = Number.isFinite(viewportHeight) ? viewportHeight : 720;
  const slots = Math.floor((height - DESKTOP_ACTIVITY_RESERVED_PX) / DESKTOP_ACTIVITY_SLOT_PX);
  return Math.max(DESKTOP_CORE_PANEL_IDS.length, Math.min(max, slots));
}

export function splitDesktopActivityBarItems(capacity: number): {
  visiblePanelIds: Activity[];
  overflowPanelIds: Activity[];
  visibleViewIds: MainView[];
  overflowViewIds: MainView[];
} {
  const max = PANELS.length + VIEWS.length;
  const slots = Math.max(
    DESKTOP_CORE_PANEL_IDS.length,
    Math.min(max, Math.floor(capacity)),
  );
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

function useDesktopActivityCapacity(enabled: boolean): number {
  const [height, setHeight] = useState(readViewportHeight);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const update = () => setHeight(readViewportHeight());
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [enabled]);
  return enabled ? calculateDesktopActivityCapacity(height) : PANELS.length + VIEWS.length;
}

export function ActivityBar({ desktopShell = false }: { desktopShell?: boolean | undefined }) {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const projectName = useSessionStore((s) => s.projectName);
  const cwd = useSessionStore((s) => s.cwd);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { t } = useAppTranslation();
  // Translate nav labels at render time (arrays are module-level constants;
  // `def.label` is kept as the English fallback for any missing key).
  const navLabel = (id: string, fallback: string) => t(`activity:nav.${id}`, fallback);
  const runningAgents = useFleetStore(
    (s) => Array.from(s.agents.values()).filter((a) => a.status === 'running').length,
  );
  const unreadMail = useMailboxStore(selectUnreadCount);
  // Subscribe (not getState()) so the Fleet/Agents monitor icons re-render and
  // update their active highlight when the inspector opens/closes or switches tab.
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
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
  const visiblePanels = desktopShell ? PANELS.filter((def) => visiblePanelIdSet.has(def.id)) : PANELS;
  const overflowPanels = desktopShell ? PANELS.filter((def) => overflowPanelIdSet.has(def.id)) : [];
  const visibleViews = desktopShell ? VIEWS.filter((def) => visibleViewIdSet.has(def.id)) : VIEWS;
  const overflowViews = desktopShell ? VIEWS.filter((def) => overflowViewIdSet.has(def.id)) : [];

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'agents') return runningAgents || undefined;
    if (id === 'mailbox') return unreadMail || undefined;
    return undefined;
  };

  return (
    <div
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col border-r bg-card/60',
        desktopShell ? 'w-10' : 'w-12',
      )}
    >
      {/* ── Branding — logo + project name (pinned top) ── */}
      <div
        className={cn(
          'flex flex-col items-center border-b border-border/50 shrink-0',
          desktopShell ? 'pt-2 pb-1.5' : 'pt-2.5 pb-2',
        )}
      >
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
            'relative rounded-md bg-primary flex items-center justify-center shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_2px_8px_-2px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_3px_12px_-2px_hsl(var(--primary)/0.6)] transition-shadow',
            desktopShell ? 'w-7 h-7' : 'w-8 h-8',
          )}
        >
          <Zap
            className={cn('text-primary-foreground', desktopShell ? 'h-3.5 w-3.5' : 'h-4 w-4')}
            strokeWidth={2.4}
          />
        </button>
        {/* Project name — truncated to fit the 48px bar */}
        {!desktopShell && (
          <span
            className="mt-1.5 text-[8px] font-semibold tracking-tight text-muted-foreground text-center leading-tight w-10 truncate"
            title={cwd || projectName || 'WrongStack'}
          >
            {projectName || 'WS'}
          </span>
        )}
        {/* Connection status dot */}
        <span
          className={cn(
            'inline-block w-1.5 h-1.5 rounded-full',
            desktopShell ? 'mt-1.5' : 'mt-1',
            wsConnected ? 'bg-[hsl(var(--success))] shadow-[0_0_4px_hsl(var(--success)/0.6)]' : 'bg-[hsl(var(--warning))]',
          )}
          title={wsConnected ? t('activity:status.connected') : t('activity:status.disconnected')}
        />
      </div>

      {/* ── Scrollable icon column ──
            Panels + main-view icons share one scroll region so a short
            viewport scrolls them instead of pushing the bottom "More" menu
            off-screen. The scrollbar is hidden (the bar is too thin to show
            a 9px track). */}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col items-center pt-2 pb-1">
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
        {visibleViews.length > 0 && <div className="my-1.5 h-px w-6 bg-border/60 shrink-0" />}

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

      {/* ── Utilities overflow menu — pinned bottom ──
            App-wide controls (palette, theme, shortcuts, Fleet/Agents
            monitors) collapsed into one popover so they never crowd the bar
            or overflow on short screens. */}
      <div className="flex flex-col items-center shrink-0 pt-1 pb-2 border-t border-border/50">
        <UtilitiesMenu
          compact={desktopShell}
          monitorOpen={inspectorOpen && (inspectorTab === 'fleet' || inspectorTab === 'agents')}
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
  const { theme, setTheme } = useTheme();
  const { t } = useAppTranslation();
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);
  const hiddenItemCount = overflowPanels.length + overflowViews.length;
  const hiddenPanelActive = overflowPanels.some(
    (def) => sidebarOpen && activeActivity === def.id,
  );
  const hiddenViewActive = overflowViews.some((def) => currentView === def.id);
  const hiddenActive = hiddenPanelActive || hiddenViewActive;

  const toggleInspectorTab = (tab: 'fleet' | 'agents') => {
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
            'relative flex items-center justify-center rounded-lg transition-colors',
            compact ? 'w-9 h-9' : 'w-10 h-10',
            'text-muted-foreground hover:text-foreground hover:bg-muted/70',
            'data-[state=open]:text-primary data-[state=open]:bg-primary/10',
            (monitorOpen || hiddenActive) && 'text-primary',
          )}
        >
          <span className="h-5 w-5 flex items-center justify-center">
            <MoreHorizontal size={16} />
          </span>
          {hiddenItemCount > 0 && (
            <span
              className={cn(
                'absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded-full px-1 text-[8px] font-bold leading-none tabular',
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
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
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
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
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
            <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {t('activity:menu.views')}
            </DropdownMenuLabel>
            {overflowViews.map((def) => (
              <DropdownMenuItem
                key={def.id}
                onSelect={() => openMainView(def.id)}
              >
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
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t('activity:menu.theme')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
          <DropdownMenuRadioItem value="light">
            <Sun size={16} className="mr-2" />
            {t('settings:appearance.themeLight')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon size={16} className="mr-2" />
            {t('settings:appearance.themeDark')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor size={16} className="mr-2" />
            {t('settings:appearance.themeSystem')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
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
        <DropdownMenuItem onSelect={() => toggleInspectorTab('agents')}>
          <ActivityIconSvg size={16} />
          <span>{t('activity:menu.agentsMonitor')}</span>
          {inspectorOpen && inspectorTab === 'agents' ? (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <DropdownMenuShortcut>⇧⌘A</DropdownMenuShortcut>
          )}
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
      title={label}
      className={cn(
        'relative flex items-center justify-center rounded-lg transition-colors',
        compact ? 'w-9 h-9' : 'w-10 h-10',
        'text-muted-foreground hover:text-foreground hover:bg-muted/70',
        active && 'text-primary bg-primary/10',
      )}
    >
      {/* Active indicator — left accent bar */}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-primary" />
      )}
      <span className="h-5 w-5">{icon}</span>
      {/* Badge count — top-right pill */}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] flex items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground leading-none px-1 tabular">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
