import { cn } from '@/lib/utils';
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
  GitCompare,
  FolderOpen,
  Folders,
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
import type { ReactElement } from 'react';
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

// ── Activity definitions ───────────────────────────────────────────────
//
// Two icon groups with two distinct behaviours:
//  - TOP icons each own one side-panel (open / switch / close-on-reclick).
//  - BOTTOM icons toggle a full main view (Phases, Flow, Settings).
// 'chat' and 'files' additionally steer the main view, since their panels
// pair with a main surface (chat stream / code editor).

interface PanelDef {
  id: Activity;
  icon: ReactElement;
  label: string;
  shortcut: string;
  /** Main view this panel pairs with, if any. */
  pairedView?: 'chat' | 'files' | 'skill' | 'officemap' | 'changes' | 'mailbox';
}

/**
 * Main views that are "owned" by a side panel (their content only makes sense
 * while that panel is the active activity). Switching to a panel without its
 * own paired view falls these back to chat, so e.g. clicking Agents while the
 * Skill detail is open returns the main area to the chat stream rather than
 * stranding a now-orphaned detail view.
 */
const PANEL_OWNED_VIEWS = ['chat', 'files', 'skill', 'officemap', 'changes', 'mailbox'] as const;

type MainView = 'autophase' | 'specs' | 'sddboard' | 'sddwizard' | 'settings';

interface ViewDef {
  id: MainView;
  icon: ReactElement;
  label: string;
}

const PANELS: PanelDef[] = [
  { id: 'chat', icon: <MessageSquare size={16} />, label: 'Session', shortcut: 'Ctrl+1', pairedView: 'chat' },
  { id: 'agents', icon: <Bot size={16} />, label: 'Agents', shortcut: 'Ctrl+2' },
  { id: 'history', icon: <Clock size={16} />, label: 'History', shortcut: 'Ctrl+3' },
  { id: 'files', icon: <FolderOpen size={16} />, label: 'Files', shortcut: 'Ctrl+4', pairedView: 'files' },
  { id: 'changes', icon: <GitCompare size={16} />, label: 'Changes', shortcut: 'Ctrl+5', pairedView: 'changes' },
  { id: 'projects', icon: <Folders size={16} />, label: 'Projects', shortcut: 'Ctrl+6' },
  { id: 'mailbox', icon: <Mail size={16} />, label: 'Mailbox', shortcut: 'Ctrl+7', pairedView: 'mailbox' },
  { id: 'skills', icon: <Sparkles size={16} />, label: 'Skills', shortcut: 'Ctrl+8', pairedView: 'skill' },
  { id: 'design', icon: <Palette size={16} />, label: 'Design Studio', shortcut: 'Ctrl+0' },
  { id: 'officemap', icon: <Building2 size={16} />, label: 'Office Map', shortcut: 'Ctrl+9', pairedView: 'officemap' },
];

const VIEWS: ViewDef[] = [
  { id: 'sddwizard', icon: <Wand2 size={16} />, label: 'New SDD Project' },
  { id: 'specs', icon: <FileText size={16} />, label: 'Specs' },
  { id: 'sddboard', icon: <ActivityIconSvg size={16} />, label: 'Live Board' },
  { id: 'autophase', icon: <Rocket size={16} />, label: 'Phases' },
  { id: 'settings', icon: <SettingsIcon size={16} />, label: 'Settings' },
];

/**
 * Open/switch/close the side panel for an activity. Exported so keyboard
 * shortcuts (Ctrl+1..7) drive the exact same logic as a mouse click.
 */
export function openPanel(activity: Activity): void {
  const ui = useUIStore.getState();
  if (!ui.sidebarOpen) {
    ui.setSidebarOpen(true);
    ui.selectActivity(activity);
  } else if (ui.activeActivity === activity) {
    ui.setSidebarOpen(false);
    return;
  } else {
    ui.selectActivity(activity);
  }
  // Panels that pair with a main surface steer the main view too. Panels
  // without one (agents/history/projects/mailbox) fall a panel-owned view
  // back to chat so a detached detail/map view doesn't linger in the main
  // area; standalone views (settings/phases/flow) are left untouched.
  const paired = PANELS.find((p) => p.id === activity)?.pairedView;
  if (paired) {
    if (ui.currentView !== paired) ui.setCurrentView(paired);
  } else if ((PANEL_OWNED_VIEWS as readonly string[]).includes(ui.currentView)) {
    if (ui.currentView !== 'chat') ui.setCurrentView('chat');
  }
}

export const PANEL_ORDER: readonly Activity[] = PANELS.map((p) => p.id);

// ── Component ──────────────────────────────────────────────────────────

export function ActivityBar() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const currentView = useUIStore((s) => s.currentView);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const projectName = useSessionStore((s) => s.projectName);
  const cwd = useSessionStore((s) => s.cwd);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const runningAgents = useFleetStore(
    (s) => Array.from(s.agents.values()).filter((a) => a.status === 'running').length,
  );
  const unreadMail = useMailboxStore(selectUnreadCount);
  // Subscribe (not getState()) so the Fleet/Agents monitor icons re-render and
  // update their active highlight when the inspector opens/closes or switches tab.
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'agents') return runningAgents || undefined;
    if (id === 'mailbox') return unreadMail || undefined;
    return undefined;
  };

  return (
    <div className="flex flex-col h-full w-12 shrink-0 border-r bg-card/60">
      {/* ── Branding — logo + project name (pinned top) ── */}
      <div className="flex flex-col items-center pt-2.5 pb-2 border-b border-border/50 shrink-0">
        <button
          type="button"
          onClick={() => {
            // "Home" — open the Session panel, back to chat.
            useUIStore.getState().setSidebarOpen(true);
            useUIStore.getState().selectActivity('chat');
            setCurrentView('chat');
          }}
          title={projectName ? `${projectName} — return to chat` : 'WrongStack — return to chat'}
          className="relative w-8 h-8 rounded-md bg-primary flex items-center justify-center shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_2px_8px_-2px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_3px_12px_-2px_hsl(var(--primary)/0.6)] transition-shadow"
        >
          <Zap className="h-4 w-4 text-primary-foreground" strokeWidth={2.4} />
        </button>
        {/* Project name — truncated to fit the 48px bar */}
        <span
          className="mt-1.5 text-[8px] font-semibold tracking-tight text-muted-foreground text-center leading-tight w-10 truncate"
          title={cwd || projectName || 'WrongStack'}
        >
          {projectName || 'WS'}
        </span>
        {/* Connection status dot */}
        <span
          className={cn(
            'mt-1 inline-block w-1.5 h-1.5 rounded-full',
            wsConnected ? 'bg-[hsl(var(--success))] shadow-[0_0_4px_hsl(var(--success)/0.6)]' : 'bg-[hsl(var(--warning))]',
          )}
          title={wsConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      {/* ── Scrollable icon column ──
            Panels + main-view icons share one scroll region so a short
            viewport scrolls them instead of pushing the bottom "More" menu
            off-screen. The scrollbar is hidden (the bar is too thin to show
            a 9px track). */}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col items-center pt-2 pb-1">
        {/* Panel icons */}
        {PANELS.map((def) => (
          <ActivityIcon
            key={def.id}
            icon={def.icon}
            label={`${def.label} (${def.shortcut})`}
            active={sidebarOpen && activeActivity === def.id}
            badge={badgeFor(def.id)}
            onClick={() => openPanel(def.id)}
          />
        ))}

        {/* Divider between panels and main-view switchers */}
        <div className="my-1.5 h-px w-6 bg-border/60 shrink-0" />

        {/* Main-view icons */}
        {VIEWS.map((def) => (
          <ActivityIcon
            key={def.id}
            icon={def.icon}
            label={def.label}
            active={currentView === def.id}
            onClick={() => setCurrentView(currentView === def.id ? 'chat' : def.id)}
          />
        ))}
      </div>

      {/* ── Utilities overflow menu — pinned bottom ──
            App-wide controls (palette, theme, shortcuts, Fleet/Agents
            monitors) collapsed into one popover so they never crowd the bar
            or overflow on short screens. */}
      <div className="flex flex-col items-center shrink-0 pt-1 pb-2 border-t border-border/50">
        <UtilitiesMenu
          monitorOpen={inspectorOpen && (inspectorTab === 'fleet' || inspectorTab === 'agents')}
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
function UtilitiesMenu({ monitorOpen }: { monitorOpen: boolean }) {
  const { theme, setTheme } = useTheme();
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const inspectorTab = useUIStore((s) => s.inspectorTab);

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
          title="More — palette, theme, shortcuts, monitors"
          className={cn(
            'relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors',
            'text-muted-foreground hover:text-foreground hover:bg-muted/70',
            'data-[state=open]:text-primary data-[state=open]:bg-primary/10',
            monitorOpen && 'text-primary',
          )}
        >
          <span className="h-5 w-5 flex items-center justify-center">
            <MoreHorizontal size={16} />
          </span>
          {/* Dot indicating a monitor is currently open behind the menu */}
          {monitorOpen && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-56">
        <DropdownMenuItem onSelect={() => useUIStore.getState().setPaletteOpen(true)}>
          <Command size={16} />
          <span>Command Palette</span>
          <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => useUIStore.getState().setShortcutsOpen(true)}>
          <Keyboard size={16} />
          <span>Keyboard Shortcuts</span>
          <DropdownMenuShortcut>?</DropdownMenuShortcut>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
          <DropdownMenuRadioItem value="light">
            <Sun size={16} className="mr-2" />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon size={16} className="mr-2" />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <Monitor size={16} className="mr-2" />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Monitors
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('fleet')}>
          <LayoutGrid size={16} />
          <span>Fleet Monitor</span>
          {inspectorOpen && inspectorTab === 'fleet' ? (
            <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
          ) : (
            <DropdownMenuShortcut>⇧⌘M</DropdownMenuShortcut>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => toggleInspectorTab('agents')}>
          <ActivityIconSvg size={16} />
          <span>Agents Monitor</span>
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
  icon,
  label,
  active,
  badge,
  onClick,
}: {
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
        'relative flex items-center justify-center w-10 h-10 rounded-lg transition-colors',
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
