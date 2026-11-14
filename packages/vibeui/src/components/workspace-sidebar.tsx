'use client';

import {
  BookOpen,
  Command,
  Compass,
  FileDiff,
  Folder,
  KeyRound,
  ListChecks,
  MessageSquare,
  Moon,
  Plug,
  Plus,
  Settings2,
  Sun,
  Users,
} from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { uiVersion } from '../lib/build-info';
import type { AgentEntry, SessionState } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import type { WorkspacePanelTab } from '../lib/workspace-commands';
import { ProviderQuotas } from './provider-quotas';
import type { ResourceTab } from './resource-hub';
import { VibeMark } from './vibe-visuals';

/**
 * Left rail of the workspace shell: brand, new session, navigation shortcuts,
 * recent sessions, provider quotas and footer actions. Pure projection — all
 * state stays owned by `Workspace` and arrives as typed props.
 */
export function WorkspaceSidebar({
  state,
  controller,
  locked,
  liveAgents,
  theme,
  filesOpen,
  providersOpen,
  resources,
  switchSession,
  toggleTheme,
  setSidebar,
  setCommandOpen,
  setFilesOpen,
  setProvidersOpen,
  setResources,
  setSessionsOpen,
  setSettings,
  setGuideOpen,
  openPanel,
  revealAgents,
}: {
  state: Pick<
    SessionState,
    'sessions' | 'id' | 'running' | 'files' | 'project' | 'cwd' | 'appVersion' | 'updateAvailable'
  >;
  controller: SessionController;
  locked: boolean;
  liveAgents: AgentEntry[];
  theme: string;
  filesOpen: boolean;
  providersOpen: boolean;
  resources: ResourceTab | null;
  switchSession: SessionController['switchSession'];
  toggleTheme: () => void;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  setCommandOpen: Dispatch<SetStateAction<boolean>>;
  setFilesOpen: Dispatch<SetStateAction<boolean>>;
  setProvidersOpen: Dispatch<SetStateAction<boolean>>;
  setResources: Dispatch<SetStateAction<ResourceTab | null>>;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  setSettings: Dispatch<SetStateAction<boolean>>;
  setGuideOpen: Dispatch<SetStateAction<boolean>>;
  openPanel: (tab: WorkspacePanelTab) => void;
  revealAgents: () => void;
}) {
  return (
    <aside className="session-sidebar" aria-label="Workspace navigation">
      <a className="brand" href="/" aria-label="VibeUI home">
        <span className="brand-mark">
          <VibeMark />
        </span>
        <strong>
          vibe<span>ui</span>
        </strong>
        <span className="brand-tag">by WrongStack</span>
      </a>
      <button
        type="button"
        className="new-session"
        disabled={locked}
        onClick={() => {
          switchSession();
          setSidebar(false);
        }}
      >
        <Plus size={17} />
        New session<span>↗</span>
      </button>
      <nav className="workspace-navigation" aria-label="Workspace shortcuts">
        <button
          type="button"
          className="quick-actions"
          onClick={() => {
            setSidebar(false);
            setCommandOpen(true);
          }}
        >
          <Command size={13} />
          Quick actions<kbd>Ctrl P</kbd>
        </button>
        <span className="nav-section-label">Workspace</span>
        <button
          type="button"
          aria-current="page"
          onClick={() => {
            setSidebar(false);
            document.querySelector('textarea[aria-label="Message"]')?.scrollIntoView();
          }}
        >
          <MessageSquare size={16} />
          Chat
        </button>
        <button
          type="button"
          aria-expanded={filesOpen}
          onClick={() => {
            setSidebar(false);
            setFilesOpen(true);
          }}
        >
          <Folder size={16} />
          Files
        </button>
        <button
          type="button"
          onClick={() => {
            setSidebar(false);
            openPanel('changes');
          }}
        >
          <FileDiff size={16} />
          Changes {state.files.length > 0 && <small>{state.files.length}</small>}
        </button>
        <button
          type="button"
          onClick={() => {
            setSidebar(false);
            openPanel('tasks');
          }}
        >
          <ListChecks size={16} />
          Tasks
        </button>
        <button
          type="button"
          onClick={() => {
            setSidebar(false);
            revealAgents();
          }}
        >
          <Users size={16} />
          Agents <small>{liveAgents.length || ''}</small>
        </button>
        <span className="nav-section-label">Resources</span>
        <button
          type="button"
          aria-expanded={providersOpen}
          onClick={() => {
            setSidebar(false);
            setProvidersOpen(true);
          }}
        >
          <KeyRound size={16} />
          Providers
        </button>
        <button
          type="button"
          aria-expanded={
            resources === 'prompts' || resources === 'skills' || resources === 'memory'
          }
          onClick={() => {
            setSidebar(false);
            setResources('prompts');
          }}
        >
          <BookOpen size={16} />
          Library
        </button>
        <button
          type="button"
          aria-expanded={resources === 'tools' || resources === 'mcp'}
          onClick={() => {
            setSidebar(false);
            setResources('tools');
          }}
        >
          <Plug size={16} />
          Tools & MCP
        </button>
      </nav>
      <div className="sidebar-section-title">
        RECENT SESSIONS
        <button
          type="button"
          onClick={() => {
            setSidebar(false);
            setSessionsOpen(true);
          }}
        >
          View all
        </button>
      </div>
      <nav className="session-list" aria-label="Recent sessions">
        {!state.sessions.length && (
          <p className="session-placeholder">Your conversations will find a home here.</p>
        )}
        {state.sessions.slice(0, 5).map((session) => (
          <button
            type="button"
            className={`session-row ${session.id === state.id ? 'active' : ''}`}
            key={session.id}
            disabled={locked}
            onClick={() => {
              if (session.id !== state.id) switchSession(session.id);
              setSidebar(false);
            }}
          >
            <MessageSquare size={14} />
            <span>{session.title}</span>
            {session.id === state.id && (
              <span className={`status-dot ${state.running ? 'busy' : ''}`} />
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <ProviderQuotas controller={controller} />
        <div className="project-card">
          <span className="project-icon">
            <Folder size={16} />
          </span>
          <span>
            <strong title={state.project || 'Your workspace'}>
              {state.project || 'Your workspace'}
            </strong>
            <small title={state.cwd}>{state.cwd || 'Connecting to WrongStack'}</small>
          </span>
        </div>
        <div className="sidebar-footer">
          <button
            type="button"
            onClick={() => {
              setSidebar(false);
              setSettings(true);
            }}
          >
            <Settings2 size={15} />
            Settings
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Getting started"
            title="Getting started"
            onClick={() => {
              setSidebar(false);
              setGuideOpen(true);
            }}
          >
            <Compass size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`Use ${theme === 'dark' ? 'light' : 'dark'} theme`}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
        <button
          type="button"
          className="version-info"
          onClick={() => {
            setSidebar(false);
            setSettings(true);
          }}
        >
          VibeUI v{uiVersion}
          {state.appVersion && <span> · WrongStack v{state.appVersion}</span>}
          {state.updateAvailable && <span> · Update available</span>}
        </button>
      </div>
    </aside>
  );
}
