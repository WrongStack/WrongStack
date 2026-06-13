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
  FolderOpen,
  Folders,
  GitBranch,
  Keyboard,
  Mail,
  MessageSquare,
  Monitor,
  Moon,
  Rocket,
  Settings as SettingsIcon,
  Sun,
  Zap,
  LayoutGrid,
  Activity as ActivityIconSvg,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { useTheme } from './ThemeProvider';

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
  pairedView?: 'chat' | 'files';
}

type MainView = 'autophase' | 'agentflow' | 'fleet' | 'settings';

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
  { id: 'projects', icon: <Folders size={16} />, label: 'Projects', shortcut: 'Ctrl+5' },
  { id: 'mailbox', icon: <Mail size={16} />, label: 'Mailbox', shortcut: 'Ctrl+6' },
];

const VIEWS: ViewDef[] = [
  { id: 'autophase', icon: <Rocket size={16} />, label: 'Phases' },
  { id: 'agentflow', icon: <GitBranch size={16} />, label: 'Flow' },
  { id: 'fleet', icon: <Monitor size={16} />, label: 'Fleet' },
  { id: 'settings', icon: <SettingsIcon size={16} />, label: 'Settings' },
];

/**
 * Open/switch/close the side panel for an activity. Exported so keyboard
 * shortcuts (Ctrl+1..6) drive the exact same logic as a mouse click.
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
  // Panels that pair with a main surface steer the main view too.
  const paired = PANELS.find((p) => p.id === activity)?.pairedView;
  if (paired && ui.currentView !== paired) {
    ui.setCurrentView(paired);
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

  const badgeFor = (id: Activity): number | undefined => {
    if (id === 'agents') return runningAgents || undefined;
    if (id === 'mailbox') return unreadMail || undefined;
    return undefined;
  };

  return (
    <div className="flex flex-col h-full w-12 shrink-0 border-r bg-card/60">
      {/* ── Branding — logo + project name ── */}
      <div className="flex flex-col items-center pt-2.5 pb-2 border-b border-border/50">
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

      {/* ── Panel icons ── */}
      <div className="flex flex-col items-center gap-0.5 pt-2">
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
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Global utilities — app-wide controls that used to crowd the
            chat header (palette, theme, shortcuts, fleet monitors) ── */}
      <div className="flex flex-col items-center gap-0.5 pb-2 border-b border-border/50 mb-2">
        <ActivityIcon
          icon={<Command size={16} />}
          label="Command palette (Ctrl+K)"
          active={false}
          onClick={() => useUIStore.getState().setPaletteOpen(true)}
        />
        <ThemeCycleIcon />
        <ActivityIcon
          icon={<Keyboard size={16} />}
          label="Keyboard shortcuts (?)"
          active={false}
          onClick={() => useUIStore.getState().setShortcutsOpen(true)}
        />
        <ActivityIcon
          icon={<LayoutGrid size={16} />}
          label="Fleet Monitor (Ctrl+Shift+M)"
          active={useUIStore.getState().fleetMonitorOpen}
          onClick={() => useUIStore.getState().setFleetMonitorOpen(!useUIStore.getState().fleetMonitorOpen)}
        />
        <ActivityIcon
          icon={<ActivityIconSvg size={16} />}
          label="Agents Monitor (Ctrl+Shift+A)"
          active={useUIStore.getState().agentsMonitorOpen}
          onClick={() => useUIStore.getState().setAgentsMonitorOpen(!useUIStore.getState().agentsMonitorOpen)}
        />
      </div>

      {/* ── Main-view icons ── */}
      <div className="flex flex-col items-center gap-0.5 pb-2">
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
    </div>
  );
}

/** Single-icon theme control: cycles light → dark → system. */
function ThemeCycleIcon() {
  const { theme, setTheme } = useTheme();
  const next = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  const icon =
    theme === 'light' ? <Sun size={16} /> : theme === 'dark' ? <Moon size={16} /> : <Monitor size={16} />;
  return (
    <ActivityIcon
      icon={icon}
      label={`Theme: ${theme} — click for ${next}`}
      active={false}
      onClick={() => setTheme(next)}
    />
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
