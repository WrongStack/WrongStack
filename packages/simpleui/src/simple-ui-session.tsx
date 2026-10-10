import { useMemo } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { AgentChatPane } from './agent-chat-pane.js';
import { ChatMessageList } from './chat-message-list.js';
import { Composer } from './composer.js';
import { ErrorBoundary } from './error-boundary.js';
import { dispatchSimplePanel } from './lib/panel-events.js';
import {
  compactTokens,
  isIncomingMailboxPayload,
  messageId,
  payloadSucceeded,
  payloadText,
} from './lib/session-helpers.js';
import { SessionAgentStrip } from './session-agent-strip.js';
import { SessionMailboxDrawer } from './session-mailbox-drawer.js';
import { SessionModals } from './session-modals.js';
import { SessionTopbar } from './session-topbar.js';
import { ToolSidebar } from './tool-sidebar.js';
import { UpdateBanner } from './update-banner.js';
import { useSimpleUiSession } from './use-simple-ui-session.js';
import { UserInputModal } from './user-input-modal.js';

export { compactTokens, isIncomingMailboxPayload, messageId, payloadSucceeded, payloadText };

export function SimpleUiSession() {
  const {
    composer,
    agentView,
    panelState,
    models,
    connection: conn,
    mailbox,
    preferences,
    workspace,
    session,
    sessions,
    running,
    context,
    load,
    theme,
    resolvedTheme,
    toggleTheme,
    updateInfo,
    hasUpdate,
    setUpdateInfo,
    createSession,
    resumeSession,
    sessionIdRef,
    socketRef,
    scrollRef,
    onScrollSticky,
    toolCalls,
    activity,
    resumeProgress,
    copyAssistantMessage,
    selectNextStep,
    messages,
    sessionStart,
    setActivity,
    fallbackPending,
    setFallbackPending,
    runCommandPaletteAction,
    notice,
    userInputRequests,
    showJumpToLatest,
    jumpToLatest,
  } = useSimpleUiSession();

  // Stable per-agent identities: AgentChatPane is memoized on its props, so
  // a fresh { id, name } literal per render would defeat the memo on every
  // parent render. Cached per agentTabs identity.
  const agentIdentities = useMemo(
    () =>
      new Map(agentView.agentTabs.map((agent) => [agent.id, { id: agent.id, name: agent.name }])),
    [agentView.agentTabs],
  );

  return (
    <div className="app-shell">
      <ErrorBoundary section="topbar">
        <SessionTopbar
          sessionView={{ session, sessions, running }}
          models={models}
          contextBar={{
            tokens: context.tokens,
            maxContext: context.maxContext,
            load,
            cache: context.cache,
          }}
          status={{
            connection: conn.state,
            theme,
            commandPaletteOpen: panelState.commandPaletteOpen,
            mailboxOpen: mailbox.open,
            mailboxUnreadCount: mailbox.unreadCount,
            settingsOpen: preferences.settingsOpen,
            appVersion: updateInfo.appVersion,
            latestVersion: updateInfo.latestVersion,
            hasUpdate,
          }}
          onCreateSession={createSession}
          onResumeSession={resumeSession}
          onRefreshSessions={() => {
            if (sessionIdRef.current) {
              socketRef.current?.send('sessions.list', {
                sessionId: sessionIdRef.current,
                limit: 12,
              });
            }
          }}
          onOpenContextBreakdown={() => {
            dispatchSimplePanel('open-context-breakdown');
            panelState.setContextBreakdownOpen(true);
          }}
          onOpenCommandPalette={() => panelState.setCommandPaletteOpen(true)}
          onToggleTheme={toggleTheme}
          onToggleMailbox={() => {
            if (!mailbox.open) {
              dispatchSimplePanel('open-mailbox');
              mailbox.refresh();
            }
            mailbox.setOpen(!mailbox.open);
          }}
          onOpenSettings={() => {
            dispatchSimplePanel('open-settings');
            preferences.setSettingsOpen(true);
          }}
        />
      </ErrorBoundary>

      <UpdateBanner
        appVersion={updateInfo.appVersion}
        latestVersion={updateInfo.latestVersion}
        show={hasUpdate}
        onDismiss={() =>
          // Dismiss the *update banner* only — preserve `appVersion` so
          // the persistent topbar version chip stays visible (functional
          // form avoids a stale-closure race if a newer `session.start`
          // lands between render and click). Clearing `appVersion` here
          // would unmount the chip the moment the user dismisses the
          // upgrade call-to-action, contradicting its "visible at all
          // times" contract and diverging from the WebUI sibling
          // (UpdateBanner.tsx keeps appVersion after dismissal).
          setUpdateInfo((prev) => ({
            ...prev,
            latestVersion: '',
            updateAvailable: false,
          }))
        }
      />

      <SessionAgentStrip
        activeAgentId={agentView.activeAgentId}
        finishedAgentTabs={agentView.finishedAgentTabs}
        liveAgentTabs={agentView.liveAgentTabs}
        onSelectAgent={agentView.setSelectedAgentId}
      />

      <ErrorBoundary>
        <main
          id="agent-panel-leader"
          className="chat-scroll"
          role="tabpanel"
          aria-labelledby="agent-tab-leader"
          hidden={!agentView.leaderSelected}
          ref={scrollRef}
          onScroll={onScrollSticky}
        >
          <ChatMessageList
            transcript={{
              messages: agentView.displayMessages,
              toolCalls: agentView.leaderSelected ? toolCalls : undefined,
              fileEdits: agentView.leaderSelected ? agentView.fileEdits : undefined,
              copiedMessageId: panelState.copiedMessageId,
              running,
              activity,
              resumeProgress,
            }}
            display={{ theme: resolvedTheme, showTimestamps: preferences.prefs.showTimestamps }}
            onOpenDiff={(meta) => panelState.setDiffFiles([meta])}
            emptyState={
              <div className="empty-state">
                <Sparkles size={25} strokeWidth={1.5} />
                <span>READY IN</span>
                <h1>{session?.projectName ?? 'your project'}</h1>
                <p>Describe the job. WrongStack will handle the rest.</p>
              </div>
            }
            onCopyMessage={copyAssistantMessage}
            onSelectNextStep={selectNextStep}
            consumedNextSteps={panelState.consumedNextSteps}
          />
        </main>
        {agentView.agentTabs
          .filter((agent) => !agent.isLeader)
          .map((agent) => (
            <AgentChatPane
              key={agent.id}
              agent={agentIdentities.get(agent.id) ?? { id: agent.id, name: agent.name }}
              entries={agentView.agentTranscripts[agent.id] ?? []}
              running={agent.status === 'running' || agent.status === 'busy'}
              hidden={agentView.activeAgentId !== agent.id}
              theme={resolvedTheme}
            />
          ))}
      </ErrorBoundary>

      <ErrorBoundary section="workspace">
        <ToolSidebar
          agent={{
            id: agentView.activeAgentId,
            name: agentView.activeAgent?.name ?? agentView.activeAgentId,
          }}
          calls={agentView.selectedToolCalls}
          workspace={{
            worklists: workspace.worklists,
            requestWorklist: workspace.requestWorklist,
            onTodoStatusChange: workspace.updateTodoStatus,
            onTaskStatusChange: workspace.updateTaskStatus,
            onPlanStatusChange: workspace.updatePlanStatus,
          }}
        />
      </ErrorBoundary>

      <ErrorBoundary section="mailbox">
        <SessionMailboxDrawer
          open={mailbox.open}
          onClose={() => mailbox.setOpen(false)}
          store={mailbox.store}
          onRefresh={mailbox.refresh}
          onSend={mailbox.send}
          onAction={mailbox.handleAction}
        />
      </ErrorBoundary>

      <SessionModals
        socketRef={socketRef}
        session={session}
        running={running}
        leaderSelected={agentView.leaderSelected}
        commandPaletteOpen={panelState.commandPaletteOpen}
        onCloseCommandPalette={() => panelState.setCommandPaletteOpen(false)}
        onRunCommandPaletteAction={runCommandPaletteAction}
        onRecallPrompt={(text) => {
          composer.setDraft(text);
          composer.textareaRef.current?.focus();
        }}
        context={context}
        messages={messages}
        sessionStart={sessionStart}
        contextBreakdownOpen={panelState.contextBreakdownOpen}
        onCloseContextBreakdown={() => panelState.setContextBreakdownOpen(false)}
        onOpenContextBreakdown={() => {
          dispatchSimplePanel('open-context-breakdown');
          panelState.setContextBreakdownOpen(true);
        }}
        onCompactContext={() => {
          if (sessionIdRef.current) {
            socketRef.current?.send('context.compact', {
              sessionId: sessionIdRef.current,
              aggressive: false,
            });
            setActivity('Compacting context');
          }
          panelState.setContextBreakdownOpen(false);
        }}
        fallbackPending={fallbackPending}
        onCloseFallbackModal={() => setFallbackPending(null)}
        settingsOpen={preferences.settingsOpen}
        onCloseSettings={() => preferences.setSettingsOpen(false)}
        prefs={preferences.prefs}
        modes={preferences.modes}
        activeModeId={preferences.activeModeId}
        palette={preferences.palette}
        connection={conn.state}
        onAutonomyChange={preferences.switchAutonomy}
        onModeChange={preferences.switchMode}
        onPaletteChange={preferences.setPalette}
        onPrefChange={preferences.updatePrefs}
        onResetPrefs={preferences.resetPrefs}
        isAtDefaults={preferences.isAtDefaults}
        modelOptions={agentView.subagentModelOptions}
        fileChangeCount={agentView.fileEditSummary.fileCount}
        onOpenFileChanges={() => {
          dispatchSimplePanel('open-file-diff');
          panelState.setDiffFiles(agentView.fileEditSummary.files);
        }}
        diffFiles={panelState.diffFiles}
        onCloseDiffFiles={() => panelState.setDiffFiles(null)}
        outageDismissed={conn.outageDismissed}
        outage={conn.outage}
        onDismissOutage={conn.dismissOutage}
        sessionId={sessionIdRef.current}
      />
      <UserInputModal
        input={{ pending: userInputRequests[0] ?? null, queuedCount: userInputRequests.length }}
        send={(type, payload) => socketRef.current?.send(type, payload)}
      />

      {agentView.leaderSelected && showJumpToLatest && (
        <button type="button" className="jump-to-latest" onClick={jumpToLatest}>
          <ArrowDown size={13} aria-hidden="true" />
          LATEST
        </button>
      )}

      {agentView.leaderSelected && (
        <ErrorBoundary>
          <footer className="composer-wrap">
            <Composer
              composer={composer}
              skillSocket={socketRef.current}
              session={session}
              running={running}
              connection={conn.state}
              notice={notice}
              preRefineSeconds={preferences.prefsRef.current.preRefineSeconds}
            />
          </footer>
        </ErrorBoundary>
      )}
    </div>
  );
}
