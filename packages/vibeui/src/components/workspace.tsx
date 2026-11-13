'use client';

import { ArrowDown, BookOpen, Brain, Compass, Folder, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAppearance } from '../lib/use-appearance';
import { useModelChoice } from '../lib/use-model-choice';
import { useSession } from '../lib/use-session';
import { useStickyScroll } from '../lib/use-sticky-scroll';
import { useWorkspaceLayout } from '../lib/use-workspace-layout';
import { buildWorkspaceCommands, type WorkspacePanelTab } from '../lib/workspace-commands';
import {
  canStopWork,
  latestAssistantId as findLatestAssistantId,
  liveAgents as findLiveAgents,
  workspaceLocked,
} from '../lib/workspace-derived';
import { useWorkspaceShortcuts } from '../lib/workspace-shortcuts';
import { ArtifactNavigation } from './artifact-navigation';
import { Composer } from './composer';
import { Modal } from './dialogs';
import { FileBrowser } from './file-browser';
import { DetailSwitch, usePresentation } from './presentation-mode';
import type { ResourceTab } from './resource-hub';
import { SessionToolbar } from './session-toolbar';
import { SessionWorkStatus } from './session-work-status';
import { StartSpace } from './start-space';
import { StreamMeter } from './stream-meter';
import { Transcript } from './transcript';
import { WorkspaceDialogs } from './workspace-dialogs';
import { WorkspaceHeader } from './workspace-header';
import { WorkspacePanel } from './workspace-panel';
import { useWorkspacePreferences } from './workspace-preferences';
import { WorkspaceSidebar } from './workspace-sidebar';

export function Workspace() {
  const { mode: presentation } = usePresentation();
  const { preferences, update: updatePreferences } = useWorkspacePreferences();
  const controller = useSession();
  const { state, connection, ready, modelPending, switchSession, switchModel, notice, send } =
    controller;
  const {
    sidebar,
    setSidebar,
    panel,
    setPanel,
    panelRequest,
    agentReveal,
    openPanel,
    revealAgents,
    showActivity,
    closePanels,
  } = useWorkspaceLayout(preferences.view);
  const { theme, palette, setPalette, toggleTheme } = useAppearance();
  const conversation = useStickyScroll<HTMLElement>(
    [state.messages, state.running, state.tools, state.agents, state.runOutcome],
    state.id,
  );
  const { smallerModel, chooseModel, refreshModels, confirmPending, cancelPending } =
    useModelChoice({
      provider: state.provider,
      model: state.model,
      maxContext: state.maxContext,
      switchModel,
      send,
    });
  const [inspectedToolId, setInspectedToolId] = useState('');
  const [settings, setSettings] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [resources, setResources] = useState<ResourceTab | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [conversationSearch, setConversationSearch] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState('');
  const [hasDraft, setHasDraft] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    setInspectedToolId('');
  }, [state.id]);
  useWorkspaceShortcuts({
    commands: () => setCommandOpen(true),
    search: () => setConversationSearch(true),
    settings: () => setSettings((open) => !open),
    'close-panels': closePanels,
  });
  const locked = workspaceLocked({
    ready,
    connection,
    running: state.running,
    agents: state.agents,
    modelPending,
    compactPending: controller.compactPending,
  });
  const latestAssistantId = findLatestAssistantId(state.messages);
  const liveAgents = findLiveAgents(state.agents);
  const activeSession = state.sessions.find((s) => s.id === state.id);
  const inspectedTool = state.tools.find((tool) => tool.id === inspectedToolId);
  const canStop = canStopWork({ hasActiveWork: controller.hasActiveWork, ready, connection });
  const requestStop = () => {
    if (!canStop) return;
    setStopConfirm(true);
  };
  const commands = buildWorkspaceCommands({
    locked,
    canStop,
    activeSessionId: state.id,
    sessions: state.sessions,
    actions: {
      openGuide: () => setGuideOpen(true),
      focusMessage: () =>
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus(),
      newSession: () => switchSession(),
      openHistory: () => setSessionsOpen(true),
      searchConversation: () => setConversationSearch(true),
      openFiles: () => setFilesOpen(true),
      openPanel: (tab: WorkspacePanelTab) => openPanel(tab),
      openResources: setResources,
      openProviders: () => setProvidersOpen(true),
      openContext: () => setContextOpen(true),
      openInstructions: () => setInstructionsOpen(true),
      openSettings: () => setSettings(true),
      toggleTheme,
      requestStop,
      switchSession: (id) => switchSession(id),
    },
  });
  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 1800);
    } catch {
      notice('Clipboard is unavailable in this browser. Select the text to copy it.');
    }
  };
  const jumpToMessage = (id: string) => {
    conversation.release();
    requestAnimationFrame(() => {
      const target = document.getElementById(`chat-${id}`);
      let ancestor = target?.parentElement;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      target?.scrollIntoView({ block: 'center' });
      target?.focus({ preventScroll: true });
    });
  };
  return (
    <ArtifactNavigation.Provider
      value={(path) => {
        controller.openArtifact({
          id: `file:${path}`,
          sessionId: state.id,
          path,
          title: path.split('/').at(-1) || path,
          kind: /\.(png|jpe?g|webp|gif)$/i.test(path) ? 'image' : 'text',
        });
        setFilesOpen(true);
      }}
    >
      <div
        data-view={preferences.view}
        className={`vibe-shell ${sidebar ? 'sidebar-open' : ''} ${panel ? 'panel-open' : ''}`}
      >
        {sidebar && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close sessions"
            onClick={() => setSidebar(false)}
          />
        )}
        <WorkspaceSidebar
          state={state}
          controller={controller}
          locked={locked}
          liveAgents={liveAgents}
          theme={theme}
          filesOpen={filesOpen}
          providersOpen={providersOpen}
          resources={resources}
          switchSession={switchSession}
          toggleTheme={toggleTheme}
          setSidebar={setSidebar}
          setCommandOpen={setCommandOpen}
          setFilesOpen={setFilesOpen}
          setProvidersOpen={setProvidersOpen}
          setResources={setResources}
          setSessionsOpen={setSessionsOpen}
          setSettings={setSettings}
          setGuideOpen={setGuideOpen}
          openPanel={openPanel}
          revealAgents={revealAgents}
        />

        <div className="main-workspace">
          <WorkspaceHeader
            view={preferences.view}
            controller={controller}
            connection={connection}
            state={state}
            sessionTitle={activeSession?.title || 'New session'}
            locked={locked}
            panel={panel}
            setSidebar={setSidebar}
            setPanel={setPanel}
            setFilesOpen={setFilesOpen}
            setResources={setResources}
            switchSession={switchSession}
          />
          {preferences.view === 'studio' && (
            <div className="experience-bar">
              <span>
                <Sparkles size={13} /> Your creative workspace
              </span>
              <div>
                <DetailSwitch />
                <button
                  type="button"
                  className="experience-guide"
                  onClick={() => setGuideOpen(true)}
                >
                  <Compass size={14} />
                  <span>Quick tour</span>
                </button>
              </div>
            </div>
          )}
          {preferences.view === 'cozy' && preferences.shortcuts && (
            <nav className="cozy-shortcuts" aria-label="Handy shortcuts">
              <span>A little help?</span>
              <button type="button" onClick={() => setFilesOpen(true)}>
                <Folder size={14} /> My files
              </button>
              <button type="button" onClick={() => setResources('prompts')}>
                <BookOpen size={14} /> Ideas & skills
              </button>
              <button type="button" onClick={() => setResources('memory')}>
                <Brain size={14} /> Memory
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Hide quick shortcuts"
                title="Tuck these away"
                onClick={() => updatePreferences({ shortcuts: false })}
              >
                <X size={13} />
              </button>
            </nav>
          )}
          {controller.sessionTransition && (
            <div className="notice" role="status">
              Switching session: {controller.sessionTransition}. Input stays locked until the new
              session is loaded.
            </div>
          )}
          {state.notice && (
            <div className="notice" role="status">
              <span>{state.notice}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss notice"
                onClick={() => notice('')}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <main className="conversation" ref={conversation.ref} onScroll={conversation.onScroll}>
            {!state.messages.length ? (
              <StartSpace
                key={state.id || 'connecting'}
                project={state.project}
                canPrepare={
                  ready &&
                  Boolean(state.id) &&
                  connection === 'open' &&
                  !controller.sessionTransition
                }
                needsProvider={ready && !state.model}
                onPrepare={controller.prepareDraft}
                onConnect={() => setProvidersOpen(true)}
              />
            ) : (
              <Transcript
                state={state}
                controller={controller}
                connection={connection}
                ready={ready}
                locked={locked}
                presentation={presentation}
                compact={preferences.view !== 'studio'}
                latestAssistantId={latestAssistantId}
                hasDraft={hasDraft}
                copied={copied}
                copy={copy}
                setInspectedToolId={setInspectedToolId}
                showActivity={showActivity}
              />
            )}
            <SessionWorkStatus
              state={state}
              connected={connection === 'open'}
              canStop={ready && !controller.sessionTransition}
              onStop={requestStop}
              onWatch={revealAgents}
            />
          </main>
          {conversation.showLatest && state.messages.length > 0 && (
            <button type="button" className="jump-latest" onClick={conversation.jumpToLatest}>
              <ArrowDown size={13} />
              Latest
            </button>
          )}
          <StreamMeter activity={state.streamActivity} running={state.running} />
          <SessionToolbar
            state={state}
            controller={controller}
            locked={locked}
            modelPending={modelPending}
            chooseModel={chooseModel}
            refreshModels={refreshModels}
            presentation={presentation}
            liveAgents={liveAgents}
            revealAgents={revealAgents}
            setProvidersOpen={setProvidersOpen}
            setSettings={setSettings}
            setContextOpen={setContextOpen}
          />
          <Composer
            key={`${state.id || 'connecting'}-${controller.clearGeneration}`}
            controller={controller}
            onDraftChange={setHasDraft}
            onStopRequest={requestStop}
          />
        </div>
        {panel && (
          <>
            {preferences.view !== 'studio' && (
              <button
                type="button"
                className="workspace-backdrop"
                aria-label="Close workspace panel"
                onClick={() => setPanel(false)}
              />
            )}
            <WorkspacePanel
              controller={controller}
              revealAgents={agentReveal}
              requestedView={panelRequest}
              onClose={() => setPanel(false)}
            />
          </>
        )}
        <WorkspaceDialogs
          controller={controller}
          state={state}
          locked={locked}
          switchSession={switchSession}
          theme={theme}
          palette={palette}
          setPalette={setPalette}
          toggleTheme={toggleTheme}
          settings={settings}
          setSettings={setSettings}
          guideOpen={guideOpen}
          setGuideOpen={setGuideOpen}
          stopConfirm={stopConfirm}
          setStopConfirm={setStopConfirm}
          contextOpen={contextOpen}
          setContextOpen={setContextOpen}
          sessionsOpen={sessionsOpen}
          setSessionsOpen={setSessionsOpen}
          providersOpen={providersOpen}
          setProvidersOpen={setProvidersOpen}
          resources={resources}
          setResources={setResources}
          instructionsOpen={instructionsOpen}
          setInstructionsOpen={setInstructionsOpen}
          conversationSearch={conversationSearch}
          setConversationSearch={setConversationSearch}
          commandOpen={commandOpen}
          setCommandOpen={setCommandOpen}
          commands={commands}
          search={search}
          setSearch={setSearch}
          inspectedTool={inspectedTool}
          setInspectedToolId={setInspectedToolId}
          smallerModel={smallerModel}
          cancelPending={cancelPending}
          confirmPending={confirmPending}
          openPanel={openPanel}
          liveAgents={liveAgents}
          onJump={jumpToMessage}
        >
          <Modal
            open={filesOpen}
            onOpenChange={setFilesOpen}
            title="Files"
            detailToggle
            icon={<Folder size={20} />}
            description="Read a file or add it to your next message."
            wide
          >
            {filesOpen && (
              <FileBrowser
                key={state.id}
                controller={controller}
                onReference={() => setFilesOpen(false)}
              />
            )}
          </Modal>
        </WorkspaceDialogs>
      </div>
    </ArtifactNavigation.Provider>
  );
}
