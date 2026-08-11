/**
 * HQ operator workbench — stable shell, lazy view router, and failure boundary.
 * Offline React app, no CDN. The WebSocket transport is wired in main.tsx.
 */

import type { HqSnapshot } from '@wrongstack/core/hq';
import {
  Activity,
  BellRing,
  BrainCircuit,
  ChartNoAxesCombined,
  CircleDollarSign,
  Columns3,
  Copy,
  GitBranch,
  Inbox,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  MessageSquareText,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  RadioTower,
  RotateCcw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  TriangleAlert,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  Component,
  type ComponentType,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { authorizedFetch, clearHqToken, resolveHqToken } from './lib/auth.js';
import { ToastOverlay } from './lib/toast-notification.js';
import { useToastStore } from './lib/toast-store.js';
import { fetchJson, type PeerEnvelope, useHqStore, type ViewId } from './store.js';
import { setHqAppearancePrefs, useHqLocalPrefs } from './stores/hq-local-prefs.js';
import { TokenGate } from './views/token-gate.js';
import './app.css';
import './syntax-highlight.css';

export type HqViewGroup = 'Operations' | 'Intelligence' | 'System';

export interface HqViewDefinition {
  id: ViewId;
  label: string;
  eyebrow: string;
  description: string;
  group: HqViewGroup;
  icon: LucideIcon;
  shortcut?: number | undefined;
}

interface HqUpdateStatus {
  current: string;
  latest: string;
  outdated: boolean;
  checkFailed: boolean;
  packageName: 'wrongstack' | '@wrongstack/cli';
  command: string;
}

interface HqAuthStatus {
  tokenMode: boolean;
  passwordMode: boolean;
  loggedIn: boolean;
}

const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

export const HQ_VIEW_DEFINITIONS: readonly HqViewDefinition[] = [
  {
    id: 'cockpit',
    label: 'Cockpit',
    eyebrow: 'Fleet overview',
    description: 'Health, active work, alerts, cost and command shortcuts.',
    group: 'Operations',
    icon: LayoutDashboard,
    shortcut: 1,
  },
  {
    id: 'fleet',
    label: 'Fleet Map',
    eyebrow: 'Topology',
    description: 'Machines, projects, terminals and agents in one live graph.',
    group: 'Operations',
    icon: Network,
    shortcut: 2,
  },
  {
    id: 'console',
    label: 'Live Console',
    eyebrow: 'Transcripts',
    description: 'Stream and inspect session or agent conversations.',
    group: 'Operations',
    icon: MessageSquareText,
    shortcut: 3,
  },
  {
    id: 'mailbox',
    label: 'Mailbox',
    eyebrow: 'Coordination',
    description: 'Cross-project messages, unread work and direct delivery.',
    group: 'Operations',
    icon: Inbox,
    shortcut: 4,
  },
  {
    id: 'kanban',
    label: 'Kanban',
    eyebrow: 'Project work',
    description: 'Read-only project boards synchronized across clones and machines.',
    group: 'Operations',
    icon: Columns3,
  },
  {
    id: 'alerts',
    label: 'Attention',
    eyebrow: 'Operator inbox',
    description: 'Alerts, waiting agents, governance warnings and failed commands.',
    group: 'Intelligence',
    icon: BellRing,
    shortcut: 5,
  },
  {
    id: 'cost',
    label: 'Cost',
    eyebrow: 'Economics',
    description: 'Project, provider and model spending distribution.',
    group: 'Intelligence',
    icon: CircleDollarSign,
    shortcut: 6,
  },
  {
    id: 'trends',
    label: 'Trends',
    eyebrow: 'Telemetry',
    description: 'Cost, token and tool activity over time.',
    group: 'Intelligence',
    icon: ChartNoAxesCombined,
    shortcut: 7,
  },
  {
    id: 'brain',
    label: 'Brain',
    eyebrow: 'Decisions',
    description: 'Autonomous decisions, escalations and interventions.',
    group: 'Intelligence',
    icon: BrainCircuit,
    shortcut: 8,
  },
  {
    id: 'worktree',
    label: 'Worktrees',
    eyebrow: 'Workspace',
    description: 'Distributed branches, worktrees and ownership state.',
    group: 'System',
    icon: GitBranch,
    shortcut: 9,
  },
  {
    id: 'control',
    label: 'Control',
    eyebrow: 'Command plane',
    description: 'Steer, queue, broadcast and audit remote commands.',
    group: 'System',
    icon: RadioTower,
    shortcut: 0,
  },
  {
    id: 'settings',
    label: 'Security',
    eyebrow: 'Access control',
    description: 'Manage the HQ browser password, authentication and active credentials.',
    group: 'System',
    icon: Settings2,
  },
];

const GROUPS: readonly HqViewGroup[] = ['Operations', 'Intelligence', 'System'];

const VIEW_COMPONENTS: Record<ViewId, LazyExoticComponent<ComponentType>> = {
  cockpit: lazy(() =>
    import('./views/cockpit.js').then((module) => ({ default: module.CockpitView })),
  ),
  fleet: lazy(() =>
    import('./views/fleet-map.js').then((module) => ({ default: module.FleetMapView })),
  ),
  console: lazy(() =>
    import('./views/live-console.js').then((module) => ({ default: module.LiveConsoleView })),
  ),
  mailbox: lazy(() =>
    import('./views/mailbox.js').then((module) => ({ default: module.MailboxView })),
  ),
  kanban: lazy(() =>
    import('./views/kanban.js').then((module) => ({ default: module.KanbanView })),
  ),
  cost: lazy(() => import('./views/cost.js').then((module) => ({ default: module.CostView }))),
  brain: lazy(() => import('./views/brain.js').then((module) => ({ default: module.BrainView }))),
  worktree: lazy(() =>
    import('./views/worktree.js').then((module) => ({ default: module.WorktreeView })),
  ),
  trends: lazy(() =>
    import('./views/trends.js').then((module) => ({ default: module.TrendsView })),
  ),
  alerts: lazy(() =>
    import('./views/alerts.js').then((module) => ({ default: module.AlertsView })),
  ),
  control: lazy(() =>
    import('./views/control.js').then((module) => ({ default: module.ControlView })),
  ),
  settings: lazy(() =>
    import('./views/settings.js').then((module) => ({ default: module.SettingsView })),
  ),
};

export function getHqViewDefinition(view: ViewId): HqViewDefinition {
  return (
    HQ_VIEW_DEFINITIONS.find((definition) => definition.id === view) ?? HQ_VIEW_DEFINITIONS[0]!
  );
}

interface ViewBoundaryProps {
  view: ViewId;
  children: ReactNode;
}

interface ViewBoundaryState {
  error: string | null;
}

class HqViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ViewBoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(previous: ViewBoundaryProps): void {
    if (previous.view !== this.props.view && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="hq-view-error" role="alert">
        <ShieldCheck size={22} />
        <div>
          <strong>This HQ surface stopped safely.</strong>
          <p>{this.state.error}</p>
        </div>
        <button
          type="button"
          className="hq-btn secondary"
          onClick={() => this.setState({ error: null })}
        >
          <RotateCcw size={13} />
          Retry view
        </button>
      </div>
    );
  }
}

export function HqApp(): React.ReactElement {
  const { snapshot, alerts, commandStatuses, activeView, authRequired, connected, peerRehydrate } =
    useHqStore(
      useShallow((state) => ({
        snapshot: state.snapshot,
        alerts: state.alerts,
        commandStatuses: state.commandStatuses,
        activeView: state.activeView,
        authRequired: state.authRequired,
        connected: state.connected,
        peerRehydrate: state.peerRehydrate,
      })),
    );
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1180,
  );
  const [updateStatus, setUpdateStatus] = useState<HqUpdateStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<HqAuthStatus | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [commandSelection, setCommandSelection] = useState(0);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const { theme } = useHqLocalPrefs().appearance;
  const wasConnectedRef = useRef(false);
  const hasConnectedOnceRef = useRef(false);

  // Toast on connection state transitions
  useEffect(() => {
    if (hasConnectedOnceRef.current && connected === false) {
      useToastStore
        .getState()
        .addToast('Connection lost — reconnecting with backoff…', 'warning', 4_000);
    } else if (
      hasConnectedOnceRef.current &&
      wasConnectedRef.current === false &&
      connected === true
    ) {
      useToastStore.getState().addToast('Reconnected to HQ server', 'success', 3_000);
    }
    if (connected) hasConnectedOnceRef.current = true;
    wasConnectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    document.documentElement.dataset.hqTheme = theme;
    return () => {
      delete document.documentElement.dataset.hqTheme;
    };
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<HqSnapshot>('/api/snapshot')
      .then((initialSnapshot) => {
        if (!cancelled) useHqStore.getState()._hydrateSnapshot(initialSnapshot);
      })
      .catch(() => {
        /* 401 already handled via markAuthRequired; the WS reconnect loop handles network recovery. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchJson<HqAuthStatus>('/api/auth/status')
      .then((status) => {
        if (!cancelled) setAuthStatus(status);
      })
      .catch(() => {
        // Snapshot/WS auth handling remains authoritative.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadUpdateStatus = (): void => {
      fetchJson<HqUpdateStatus>('/api/system/update')
        .then((status) => {
          if (!cancelled) setUpdateStatus(status);
        })
        .catch(() => {
          // Update checks are advisory and must never block the command center.
        });
    };
    loadUpdateStatus();
    const timer = window.setInterval(loadUpdateStatus, UPDATE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    commandInputRef.current?.focus();
  }, [commandPaletteOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        setCommandQuery('');
        setCommandSelection(0);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if (event.altKey && /^\d$/.test(event.key)) {
        const shortcut = Number(event.key);
        const definition = HQ_VIEW_DEFINITIONS.find((candidate) => candidate.shortcut === shortcut);
        if (definition) {
          event.preventDefault();
          useHqStore.getState().setActiveView(definition.id);
        }
        return;
      }
      if (event.key === 'Escape' && commandPaletteOpen) {
        event.preventDefault();
        setCommandPaletteOpen(false);
        return;
      }
      if (event.key === 'Escape' && sidebarOpen && window.innerWidth < 900) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandPaletteOpen, sidebarOpen]);

  const commandResults = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (query.length === 0) return HQ_VIEW_DEFINITIONS;
    return HQ_VIEW_DEFINITIONS.filter((definition) =>
      [definition.label, definition.eyebrow, definition.description, definition.group]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [commandQuery]);

  if (authRequired) {
    return <TokenGate hadToken={resolveHqToken() !== null} />;
  }

  const totals = snapshot?.totals;
  const unread = totals?.unreadMailboxMessages ?? 0;
  const activeAlerts = alerts.filter((alert) => alert.severity !== 'info').length;
  const attentionSignals =
    activeAlerts +
    (snapshot?.projects ?? []).filter(
      (project) =>
        project.governance?.signal.level === 'warning' ||
        project.governance?.signal.level === 'unavailable',
    ).length +
    (snapshot?.liveSessions ?? [])
      .flatMap((session) => session.agents ?? [])
      .filter((agent) => agent.status === 'waiting_user' || agent.status === 'error').length +
    (snapshot?.clients ?? []).filter((client) => !client.connected).length +
    commandStatuses.filter(
      (command) => command.ackStatus === 'failed' || command.ackStatus === 'rejected',
    ).length;
  const current = getHqViewDefinition(activeView);
  const CurrentIcon = current.icon;
  const ActiveView = VIEW_COMPONENTS[activeView];

  const activateView = (view: ViewId): void => {
    useHqStore.getState().setActiveView(view);
    setCommandPaletteOpen(false);
    setCommandQuery('');
    setCommandSelection(0);
    if (window.innerWidth < 900) setSidebarOpen(false);
  };

  const logout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await authorizedFetch('/api/logout', { method: 'POST' });
    } finally {
      clearHqToken();
      window.location.reload();
    }
  };

  return (
    <div className="hq-app" data-theme={theme} data-testid="hq-workbench">
      <button
        type="button"
        className="hq-sidebar-scrim"
        data-open={sidebarOpen}
        aria-label="Close HQ navigation"
        onClick={() => setSidebarOpen(false)}
      />

      <aside className="hq-secondary-nav" data-open={sidebarOpen} aria-label="HQ navigation">
        <div className="hq-secondary-header">
          <div className="hq-secondary-brand">
            <img src="/wrongstack.svg" alt="" aria-hidden="true" draggable={false} />
            <div className="hq-secondary-copy">
              <span className="hq-secondary-eyebrow">Command center</span>
              <strong>WrongStack HQ</strong>
            </div>
          </div>
          <button
            type="button"
            className="hq-icon-button hq-secondary-close"
            aria-label="Collapse HQ navigation"
            title="Collapse navigation (Ctrl+B)"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>

        <div className="hq-secondary-scroll">
          {GROUPS.map((group) => (
            <section key={group} className="hq-nav-group">
              <div className="hq-nav-group-label">{group}</div>
              {HQ_VIEW_DEFINITIONS.filter((definition) => definition.group === group).map(
                (definition) => {
                  const Icon = definition.icon;
                  const badge =
                    definition.id === 'mailbox'
                      ? unread
                      : definition.id === 'alerts'
                        ? attentionSignals
                        : 0;
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      className="hq-nav-item"
                      data-active={activeView === definition.id}
                      aria-current={activeView === definition.id ? 'page' : undefined}
                      onClick={() => activateView(definition.id)}
                    >
                      <Icon size={15} />
                      <span>{definition.label}</span>
                      {definition.shortcut !== undefined ? (
                        <kbd>Alt+{definition.shortcut}</kbd>
                      ) : null}
                      {badge > 0 ? <span className="hq-nav-badge">{badge}</span> : null}
                    </button>
                  );
                },
              )}
            </section>
          ))}
        </div>

        <div className="hq-secondary-footer">
          <div className="hq-link-state" data-live={connected}>
            <span className="hq-link-dot" />
            <div>
              <strong>{connected ? 'Connected' : 'Reconnecting'}</strong>
              <span>
                {totals?.activeMachines ?? 0} machines · {totals?.activeClients ?? 0} clients
              </span>
            </div>
          </div>
          <span className="hq-build-label">@wrongstack/webui-hq</span>
        </div>
      </aside>

      <section className="hq-workbench" data-update-available={updateStatus?.outdated === true}>
        <header className="hq-header">
          <button
            type="button"
            className="hq-icon-button hq-sidebar-toggle"
            aria-label={sidebarOpen ? 'Collapse HQ navigation' : 'Expand HQ navigation'}
            aria-expanded={sidebarOpen}
            title="Toggle navigation (Ctrl+B)"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
          <div className="hq-view-icon" aria-hidden="true">
            <CurrentIcon size={18} />
          </div>
          <div className="hq-view-identity">
            <span>{current.eyebrow}</span>
            <h1>{current.label}</h1>
            <p>{current.description}</p>
          </div>

          <div className="hq-top-metrics">
            <TopMetric icon={Server} label="Machines" value={totals?.activeMachines ?? 0} />
            <TopMetric icon={Users} label="Agents" value={totals?.activeAgents ?? 0} />
            <TopMetric icon={Activity} label="Sessions" value={totals?.activeSessions ?? 0} />
            <TopMetric
              icon={CircleDollarSign}
              label="Cost"
              value={`$${(totals?.totalCostUsd ?? 0).toFixed(2)}`}
              accent
            />
          </div>
          <button
            type="button"
            className="hq-command-trigger"
            aria-label="Open HQ command palette"
            aria-expanded={commandPaletteOpen}
            onClick={() => {
              setCommandPaletteOpen(true);
              setCommandQuery('');
              setCommandSelection(0);
            }}
          >
            <Search size={14} />
            <span>Jump to</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="hq-connection-pill" data-live={connected}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            {connected ? 'Live' : 'Reconnecting'}
          </div>
          <button
            type="button"
            className="hq-icon-button hq-theme-toggle"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setHqAppearancePrefs({ theme: theme === 'dark' ? 'light' : 'dark' })}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          {authStatus?.tokenMode || authStatus?.passwordMode ? (
            <button
              type="button"
              className="hq-icon-button"
              aria-label="Log out of HQ"
              title="Log out and clear this tab's HQ credentials"
              disabled={loggingOut}
              onClick={() => void logout()}
            >
              <LogOut size={16} />
            </button>
          ) : null}
        </header>

        {updateStatus?.outdated ? <UpdateNotice status={updateStatus} /> : null}
        {peerRehydrate ? <PeerRehydrateNotice envelope={peerRehydrate} /> : null}

        <main className="hq-main" id="hq-main" tabIndex={-1}>
          <HqViewBoundary view={activeView}>
            <Suspense fallback={<ViewLoading label={current.label} />}>
              <ActiveView />
            </Suspense>
          </HqViewBoundary>
        </main>
      </section>
      {commandPaletteOpen ? (
        <div className="hq-command-layer" role="presentation">
          <button
            type="button"
            className="hq-command-scrim"
            aria-label="Close HQ command palette"
            onClick={() => setCommandPaletteOpen(false)}
          />
          <dialog open className="hq-command-palette" aria-label="HQ command palette">
            <div className="hq-command-search">
              <Search size={17} aria-hidden="true" />
              <input
                ref={commandInputRef}
                type="search"
                value={commandQuery}
                aria-label="Search HQ views"
                placeholder="Search views, telemetry and controls…"
                onChange={(event) => {
                  setCommandQuery(event.target.value);
                  setCommandSelection(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setCommandSelection((selection) =>
                      commandResults.length === 0 ? 0 : (selection + 1) % commandResults.length,
                    );
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setCommandSelection((selection) =>
                      commandResults.length === 0
                        ? 0
                        : (selection - 1 + commandResults.length) % commandResults.length,
                    );
                  } else if (event.key === 'Enter' && commandResults[commandSelection]) {
                    event.preventDefault();
                    activateView(commandResults[commandSelection].id);
                  }
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="hq-command-results" role="listbox" aria-label="HQ destinations">
              {commandResults.length === 0 ? (
                <div className="hq-command-empty">No HQ surface matches “{commandQuery}”.</div>
              ) : (
                commandResults.map((definition, index) => {
                  const Icon = definition.icon;
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      className="hq-command-result"
                      role="option"
                      aria-selected={commandSelection === index}
                      data-current={activeView === definition.id}
                      onMouseEnter={() => setCommandSelection(index)}
                      onClick={() => activateView(definition.id)}
                    >
                      <span className="hq-command-result-icon">
                        <Icon size={16} />
                      </span>
                      <span className="hq-command-result-copy">
                        <strong>{definition.label}</strong>
                        <small>{definition.description}</small>
                      </span>
                      <span className="hq-command-result-group">{definition.group}</span>
                      {definition.shortcut !== undefined ? (
                        <kbd>Alt {definition.shortcut}</kbd>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
            <footer className="hq-command-footer">
              <span>
                <kbd>↑↓</kbd> select
              </span>
              <span>
                <kbd>Enter</kbd> open
              </span>
              <span>
                <kbd>Esc</kbd> close
              </span>
              <span>{commandResults.length} destinations</span>
            </footer>
          </dialog>
        </div>
      ) : null}
      <ToastOverlay />
    </div>
  );
}

function PeerRehydrateNotice({ envelope }: { envelope: PeerEnvelope }): React.ReactElement {
  const title =
    envelope.kind === 'peer.rehydrate'
      ? 'Leader session lost — survivor clients can rehydrate'
      : 'Leader session lost — no survivor clients reported';
  const detail =
    envelope.kind === 'peer.rehydrate' && envelope.payload.rehydrateHint
      ? envelope.payload.rehydrateHint
      : `${envelope.payload.previousLeaderHandle} on ${envelope.payload.machineId} ended (${envelope.payload.reason}).`;

  return (
    <aside className="hq-peer-rehydrate-notice" role="status" aria-live="polite">
      <TriangleAlert size={16} aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button
        type="button"
        onClick={() => useHqStore.getState()._dismissPeerRehydrate()}
        title="Dismiss peer lifecycle notice"
      >
        Dismiss
      </button>
    </aside>
  );
}

function UpdateNotice({ status }: { status: HqUpdateStatus }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copyCommand = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(status.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <aside className="hq-update-notice" role="status" aria-live="polite">
      <TriangleAlert size={16} aria-hidden="true" />
      <div>
        <strong>WrongStack update available</strong>
        <span>
          v{status.current} → v{status.latest}. Run <code>{status.command}</code> in your terminal,
          then restart HQ.
        </span>
      </div>
      <button type="button" onClick={() => void copyCommand()} title="Copy update command">
        <Copy size={13} aria-hidden="true" />
        {copied ? 'Copied' : 'Copy command'}
      </button>
    </aside>
  );
}

function TopMetric({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  accent?: boolean | undefined;
}): React.ReactElement {
  return (
    <div className="hq-top-metric" data-accent={accent}>
      <Icon size={12} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ViewLoading({ label }: { label: string }): React.ReactElement {
  return (
    <div className="hq-view-loading" role="status">
      <RadioTower size={18} />
      <span>Loading {label}…</span>
    </div>
  );
}
