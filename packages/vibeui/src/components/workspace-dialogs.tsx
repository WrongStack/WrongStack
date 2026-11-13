'use client';

import { MessageSquare, Search } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { AgentEntry, SessionState, ToolEntry } from '../lib/session';
import type { ModelTarget } from '../lib/use-model-choice';
import type { SessionController } from '../lib/use-session';
import type { WorkspaceCommand, WorkspacePanelTab } from '../lib/workspace-commands';
import { CommandPalette } from './command-palette';
import { ContextDialog } from './context-dialog';
import { ConversationSearch } from './conversation-search';
import { Modal, PendingInteractions, Settings } from './dialogs';
import { GettingStarted } from './getting-started';
import { InstructionsEditor } from './instructions-editor';
import { ProviderManager } from './provider-manager';
import type { ResourceTab } from './resource-hub';
import { ResourceHub } from './resource-hub';
import { StopAllDialog } from './stop-all-dialog';
import { ToolInspector } from './tool-inspector';

/**
 * Every modal and dialog mounted at the bottom of the workspace shell. All
 * state stays owned by `Workspace`; open flags and setters arrive as typed
 * props. The Files dialog is passed as `children` so the `FileBrowser` element
 * (and its key) stays colocated with `Workspace`.
 */
export function WorkspaceDialogs({
  controller,
  state,
  locked,
  switchSession,
  theme,
  palette,
  setPalette,
  toggleTheme,
  settings,
  setSettings,
  guideOpen,
  setGuideOpen,
  stopConfirm,
  setStopConfirm,
  contextOpen,
  setContextOpen,
  sessionsOpen,
  setSessionsOpen,
  providersOpen,
  setProvidersOpen,
  resources,
  setResources,
  instructionsOpen,
  setInstructionsOpen,
  conversationSearch,
  setConversationSearch,
  commandOpen,
  setCommandOpen,
  commands,
  search,
  setSearch,
  inspectedTool,
  setInspectedToolId,
  smallerModel,
  cancelPending,
  confirmPending,
  openPanel,
  liveAgents,
  onJump,
  children,
}: {
  controller: SessionController;
  state: Pick<SessionState, 'messages' | 'sessions' | 'id' | 'running'>;
  locked: boolean;
  switchSession: SessionController['switchSession'];
  theme: string;
  palette: string;
  setPalette: (value: string) => void;
  toggleTheme: () => void;
  settings: boolean;
  setSettings: Dispatch<SetStateAction<boolean>>;
  guideOpen: boolean;
  setGuideOpen: Dispatch<SetStateAction<boolean>>;
  stopConfirm: boolean;
  setStopConfirm: Dispatch<SetStateAction<boolean>>;
  contextOpen: boolean;
  setContextOpen: Dispatch<SetStateAction<boolean>>;
  sessionsOpen: boolean;
  setSessionsOpen: Dispatch<SetStateAction<boolean>>;
  providersOpen: boolean;
  setProvidersOpen: Dispatch<SetStateAction<boolean>>;
  resources: ResourceTab | null;
  setResources: Dispatch<SetStateAction<ResourceTab | null>>;
  instructionsOpen: boolean;
  setInstructionsOpen: Dispatch<SetStateAction<boolean>>;
  conversationSearch: boolean;
  setConversationSearch: Dispatch<SetStateAction<boolean>>;
  commandOpen: boolean;
  setCommandOpen: Dispatch<SetStateAction<boolean>>;
  commands: WorkspaceCommand[];
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  inspectedTool: ToolEntry | undefined;
  setInspectedToolId: Dispatch<SetStateAction<string>>;
  smallerModel: ModelTarget | null;
  cancelPending: () => void;
  confirmPending: () => void;
  openPanel: (tab: WorkspacePanelTab) => void;
  liveAgents: AgentEntry[];
  onJump: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <>
      {inspectedTool && (
        <ToolInspector
          key={inspectedTool.id}
          tool={inspectedTool}
          onClose={() => setInspectedToolId('')}
        />
      )}
      <Settings
        controller={controller}
        open={settings}
        onClose={() => setSettings(false)}
        theme={theme}
        palette={palette}
        setPalette={setPalette}
        toggleTheme={toggleTheme}
        onProviders={() => {
          setSettings(false);
          setProvidersOpen(true);
        }}
        onInstructions={() => {
          setSettings(false);
          setInstructionsOpen(true);
        }}
      />
      <GettingStarted
        open={guideOpen}
        onOpenChange={setGuideOpen}
        onFocus={() => {
          setGuideOpen(false);
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
          );
        }}
        onChanges={() => {
          setGuideOpen(false);
          openPanel('changes');
        }}
        onSettings={() => {
          setGuideOpen(false);
          setSettings(true);
        }}
      />
      <StopAllDialog
        open={stopConfirm}
        leaderRunning={state.running}
        agentNames={liveAgents.map((agent) => agent.name || agent.id)}
        onCancel={() => setStopConfirm(false)}
        onConfirm={() => {
          if (controller.stopAll()) setStopConfirm(false);
        }}
      />
      <ContextDialog controller={controller} open={contextOpen} onOpenChange={setContextOpen} />
      {children}
      {providersOpen && (
        <ProviderManager controller={controller} onClose={() => setProvidersOpen(false)} />
      )}
      {resources && (
        <ResourceHub
          key={`${state.id}-${resources}`}
          controller={controller}
          initialTab={resources}
          onClose={() => setResources(null)}
        />
      )}
      {instructionsOpen && (
        <InstructionsEditor
          key={state.id}
          controller={controller}
          onClose={() => setInstructionsOpen(false)}
        />
      )}
      {conversationSearch && (
        <ConversationSearch
          messages={state.messages}
          onClose={() => setConversationSearch(false)}
          onJump={onJump}
        />
      )}
      {commandOpen && <CommandPalette commands={commands} onClose={() => setCommandOpen(false)} />}
      <Modal
        open={sessionsOpen}
        onOpenChange={setSessionsOpen}
        title="Sessions"
        icon={<MessageSquare size={20} />}
        description="Search and resume conversations in this project."
      >
        <label className="session-search">
          <Search size={14} />
          <input
            aria-label="Search sessions"
            placeholder="Find a session…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav className="all-sessions" aria-label="All sessions">
          {state.sessions
            .filter((session) => session.title.toLowerCase().includes(search.toLowerCase()))
            .map((session) => (
              <button
                type="button"
                key={session.id}
                className={`session-row ${session.id === state.id ? 'active' : ''}`}
                disabled={locked}
                onClick={() => {
                  if (session.id !== state.id) switchSession(session.id);
                  setSessionsOpen(false);
                }}
              >
                <MessageSquare size={14} />
                <span>{session.title}</span>
              </button>
            ))}
        </nav>
      </Modal>
      <PendingInteractions controller={controller} />
      <Modal
        open={Boolean(smallerModel)}
        onOpenChange={(open) => {
          if (!open) cancelPending();
        }}
        title="A smaller context window"
        description={`This model supports ${smallerModel?.context.toLocaleString() ?? ''} tokens. Switching may compact the conversation.`}
      >
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={cancelPending}>
            Keep current model
          </button>
          <button type="button" className="primary-button" onClick={confirmPending}>
            Switch model
          </button>
        </div>
      </Modal>
    </>
  );
}
