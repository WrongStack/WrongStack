import { Command, FolderCode, Mail, Moon, Settings, Sun, Wifi, WifiOff } from 'lucide-react';
import type { PendingModelSwitch } from './hooks/use-model-catalog.js';
import type { Theme } from './hooks/use-theme.js';
import { compactTokens } from './lib/session-helpers.js';
import { ModelSwitcher } from './model-switcher.js';
import { SessionSwitcher } from './session-switcher.js';
import type {
  ConnectionState,
  ContextInfo,
  ModelDescriptor,
  SessionInfo,
  SimpleSessionSummary,
} from './types.js';

/**
 * The subset of the model catalog the top bar renders and drives. Deliberately
 * narrower than `UseModelCatalogResult`: the chrome only reads the catalog and
 * forwards user selections, so it must not receive the catalog's setters or
 * provider-model fetcher.
 */
export interface SessionTopbarModelCatalog {
  selectedModel: string;
  groupedModels: [string, ModelDescriptor[]][];
  providerLabels: Record<string, string>;
  pendingModelSwitch: PendingModelSwitch | null;
  selectModel: (provider: string, model: string) => void;
  confirmModelSwitch: () => void;
  cancelModelSwitch: () => void;
}

export interface SessionTopbarProps {
  session: SessionInfo | null;
  sessions: SimpleSessionSummary[];
  running: boolean;
  models: SessionTopbarModelCatalog;
  contextTokens: number;
  contextMaxContext: number;
  load: number;
  /**
   * Live prompt-cache snapshot for the topbar badge. Mirrors the
   * `cache` field on `ContextInfo`. `null` until the first `stats.get`
   * reply lands — shown as "—" in the badge so users learn the metric
   * exists instead of wondering where it went.
   */
  cache: ContextInfo['cache'];
  connection: ConnectionState;
  theme: Theme;
  commandPaletteOpen: boolean;
  mailboxOpen: boolean;
  mailboxUnreadCount: number;
  settingsOpen: boolean;
  appVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  onCreateSession: () => void;
  onResumeSession: (id: string) => void;
  onRefreshSessions: () => void;
  onOpenContextBreakdown: () => void;
  onOpenCommandPalette: () => void;
  onToggleTheme: () => void;
  onToggleMailbox: () => void;
  onOpenSettings: () => void;
}

/**
 * SimpleUI top bar chrome: project/session switcher, model switcher, context
 * meter, and the command-palette / theme / email / settings / connection
 * cluster. Extracted from `simple-ui-session.tsx` (plan B1); purely
 * presentational — all behaviour is supplied via callback props.
 */
export function SessionTopbar(props: SessionTopbarProps) {
  const {
    session,
    sessions,
    running,
    models,
    contextTokens,
    contextMaxContext,
    load,
    cache,
    connection,
    theme,
    commandPaletteOpen,
    mailboxOpen,
    mailboxUnreadCount,
    settingsOpen,
    appVersion,
    latestVersion,
    hasUpdate,
    onCreateSession,
    onResumeSession,
    onRefreshSessions,
    onOpenContextBreakdown,
    onOpenCommandPalette,
    onToggleTheme,
    onToggleMailbox,
    onOpenSettings,
  } = props;
  const {
    selectedModel,
    groupedModels,
    providerLabels,
    pendingModelSwitch,
    selectModel,
    confirmModelSwitch,
    cancelModelSwitch,
  } = models;

  return (
    <header className="topbar">
      <div className="project-block">
        <div className="brand-mark">
          <img src="/wrongstack.svg" alt="WrongStack" draggable={false} />
        </div>
        <div className="project-icon">
          <FolderCode size={17} />
        </div>
        <div className="project-copy" title={session?.cwd}>
          <strong>{session?.projectName ?? 'WrongStack'}</strong>
          <SessionSwitcher
            session={session}
            sessions={sessions}
            running={running}
            onRefreshSessions={onRefreshSessions}
            onCreateSession={onCreateSession}
            onResumeSession={onResumeSession}
          />
        </div>
      </div>

      <ModelSwitcher
        selectedModel={selectedModel}
        groupedModels={groupedModels}
        providerLabels={providerLabels}
        disabled={!session || groupedModels.length === 0 || running}
        pendingModelSwitch={pendingModelSwitch}
        onSelectModel={selectModel}
        onConfirmSwitch={confirmModelSwitch}
        onCancelSwitch={cancelModelSwitch}
      />

      <div className="topbar-right">
        <button
          type="button"
          className="context-meter"
          title={`${contextTokens} / ${contextMaxContext} tokens — Click for token breakdown`}
          disabled={!session}
          onClick={onOpenContextBreakdown}
        >
          <div className="context-copy">
            <span>CONTEXT</span>
            <strong>{Math.round(load * 100)}%</strong>
          </div>
          <div className="context-track">
            <span
              style={{
                width: `${load * 100}%`,
                background:
                  load > 0.9 ? 'var(--danger)' : load > 0.7 ? 'var(--warning)' : 'var(--accent)',
              }}
            />
          </div>
          <small>
            {compactTokens(contextTokens)} / {compactTokens(contextMaxContext)}
          </small>
          {cache && cache.readTokens + cache.writeTokens > 0 ? (
            <small className="context-cache">
              cache-hit {(cache.hitRatio * 100).toFixed(1)}%
              {cache.coverageTokens > 0 ? ` · covers ${compactTokens(cache.coverageTokens)}` : ''}
            </small>
          ) : null}
          <span className="context-details-hint">DETAILS</span>
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          aria-expanded={commandPaletteOpen}
          title="Command palette (Ctrl+K)"
        >
          <Command size={15} />
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          onClick={onToggleTheme}
          aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          onClick={onToggleMailbox}
          aria-label="Open email panel"
          aria-expanded={mailboxOpen}
          title="Email"
        >
          <Mail size={15} />
          {mailboxUnreadCount > 0 ? (
            <span
              className="mail-notification-dot"
              role="status"
              aria-label={`${mailboxUnreadCount} unread email messages`}
            >
              {mailboxUnreadCount > 9 ? '9+' : mailboxUnreadCount}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="topbar-icon-btn"
          onClick={onOpenSettings}
          aria-label="Open settings"
          aria-expanded={settingsOpen}
          title="Settings"
        >
          <Settings size={15} />
        </button>
        {/* Persistent version chip — mirrors the WebUI WorkbenchTopbar
            placement. The full-width update banner above already shows the
            upgrade prompt when an update is available; this chip keeps the
            version visible at all times so users see *something* even when
            they've dismissed the banner or are on the latest release. The
            `latestVersion !== appVersion` guard prevents a stale
            `updateAvailable: true` from flagging a bogus upgrade. */}
        {appVersion ? (
          <span
            className={`version-chip ${hasUpdate ? 'outdated' : ''}`}
            title={
              hasUpdate
                ? `Update available: v${appVersion} → v${latestVersion} — run wstack update`
                : `WrongStack v${appVersion}`
            }
          >
            v{appVersion}
            {hasUpdate ? <span className="version-chip-update">→ v{latestVersion}</span> : null}
          </span>
        ) : null}
        <div className={`connection ${connection}`} title={`WebSocket: ${connection}`}>
          <span
            className={`connection-ping-dot ${connection === 'open' ? 'good' : connection === 'connecting' ? 'poor' : 'bad'}`}
          />
          {connection === 'open' ? <Wifi size={15} /> : <WifiOff size={15} />}
          <span>{connection === 'open' ? 'LIVE' : connection === 'connecting' ? '…' : 'OFF'}</span>
        </div>
      </div>
    </header>
  );
}
