'use client';

import { Folder, Menu, PanelRight } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { SessionState } from '../lib/session';
import type { SessionController } from '../lib/use-session';
import { agentsNeedAttention } from '../lib/workspace-derived';
import type { WorkspaceView } from '../lib/workspace-preferences';
import type { ResourceTab } from './resource-hub';
import { RoamingMascot } from './roaming-mascot';
import { SessionActions } from './session-actions';
import { VibeBuddy } from './vibe-visuals';
import { WorkspaceViewMenu } from './workspace-preferences';

/**
 * Top bar of the main workspace: mobile menu toggle, mascot/breadcrumb with the
 * active session title, and the header actions (view menu, files, session
 * actions, connection chip, workspace panel toggle). Pure projection — all
 * state stays owned by `Workspace`.
 */
export function WorkspaceHeader({
  view,
  controller,
  connection,
  state,
  sessionTitle,
  locked,
  panel,
  setSidebar,
  setPanel,
  setFilesOpen,
  setResources,
  switchSession,
}: {
  view: WorkspaceView;
  controller: SessionController;
  connection: SessionController['connection'];
  state: Pick<SessionState, 'runOutcome' | 'agents' | 'project'>;
  sessionTitle: string;
  locked: boolean;
  panel: boolean;
  setSidebar: Dispatch<SetStateAction<boolean>>;
  setPanel: Dispatch<SetStateAction<boolean>>;
  setFilesOpen: Dispatch<SetStateAction<boolean>>;
  setResources: Dispatch<SetStateAction<ResourceTab | null>>;
  switchSession: SessionController['switchSession'];
}) {
  return (
    <header className="workspace-header">
      <div className="header-project">
        <button
          type="button"
          className="icon-button mobile-menu"
          aria-label="Open sessions"
          onClick={() => setSidebar((open) => !open)}
        >
          <Menu size={18} />
        </button>
        {view === 'cozy' ? (
          <RoamingMascot
            working={controller.hasActiveWork}
            connected={connection === 'open'}
            outcome={state.runOutcome}
            attention={agentsNeedAttention(state.agents)}
            onFiles={() => setFilesOpen(true)}
            onIdeas={() => setResources('prompts')}
            onMemory={() => setResources('memory')}
            onNewChat={() => switchSession()}
            newChatLocked={locked}
          />
        ) : (
          view === 'focus' && (
            <span className="cozy-brand">
              <VibeBuddy small />
            </span>
          )
        )}
        <Folder size={15} />
        <span>{state.project || 'Workspace'}</span>
        <span className="breadcrumb">/</span>
        <strong>{sessionTitle}</strong>
      </div>
      <div className="header-actions">
        <WorkspaceViewMenu
          onChoose={() => {
            setSidebar(false);
            setPanel(false);
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Files"
          title="Files"
          onClick={() => setFilesOpen(true)}
        >
          <Folder size={17} />
        </button>
        <SessionActions controller={controller} title={sessionTitle} />
        <span className="connection-chip">
          <span
            className={`status-dot ${connection !== 'open' ? 'error' : controller.hasActiveWork ? 'busy' : ''}`}
          />
          {connection !== 'open' ? 'Reconnecting' : controller.hasActiveWork ? 'Working' : 'Ready'}
        </span>
        <button
          type="button"
          className={`icon-button ${panel ? 'is-active' : ''}`}
          aria-label="Toggle workspace"
          aria-expanded={panel}
          onClick={() => setPanel((open) => !open)}
        >
          <PanelRight size={18} />
        </button>
      </div>
    </header>
  );
}
