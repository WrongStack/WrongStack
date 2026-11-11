import { parseBugHuntMessage } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import {
  ChevronDown,
  FolderCode,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  PanelsTopLeft,
  Settings2,
  Square,
  X,
} from 'lucide-react';
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentTabs } from './AgentTranscripts';
import { ComposerFoldControls } from './ComposerFoldControls';
import { ConversationNotices } from './ConversationNotices';
import { useConversationShortcuts } from './ConversationShortcuts';
import { ConversationWelcome } from './ConversationWelcome';
import { chimeraFollowup, chimeraFollowupState } from './chimera-followup';
import type { ComposerAttachment } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  appendToDraft,
  type ComposerFileReference,
  splitReferenceMessage,
  withReference,
} from './composer-resources-model';
import { type ConversationAppearance, conversationDisplay } from './conversation-appearance';
import { DesignExtractForm } from './DesignExtractForm';
import { designArtifactRoot, designSpecPath } from './design-extraction-result';
import { designReviewPath } from './design-review-result';
import type { AppNavigation, DesktopNavigation } from './desktop-commands';
import { useDesktopText } from './desktop-i18n';
import { EngineDataView } from './EngineDataView';
import { EngineSessionPanels, isEngineSessionPanel } from './EngineSessionPanels';
import type { EngineTab } from './engine-workspace-tabs';
import { FallbackPicker } from './FallbackPicker';
import { failedRun } from './failed-run-model';
import { workspaceFilePath } from './file-model';
import { InputRequestCard } from './InputRequestCard';
import type { InputDraft } from './input-form-model';
import { Modal } from './Modal';
import { markdownTarget } from './markdown-target';
import { useMessagePins } from './message-pins';
import { ProjectSessionTools } from './ProjectSessionTools';
import { ProviderWaitingRoom } from './ProviderWaitingRoom';
import { openExternal, projectFormDraftStorage, sessionObjectDraftStorage } from './platform';
import { useRunSounds } from './RunSounds';
import { recoveryLog, recoveryLogKey, type SavedRecoveryLog } from './recovery-log';
import type { ProjectFormDraftStorage } from './requirement-draft';
import { ScheduledJobs } from './ScheduledJobs';
import { SessionActivity } from './SessionActivity';
import { SessionBrowser } from './SessionBrowser';
import { SessionComposer } from './SessionComposer';
import { SessionRecovery } from './SessionRecovery';
import { SessionStatusBar } from './SessionStatusBar';
import { SessionTodos } from './SessionTodos';
import { SessionWorklist } from './SessionWorklist';
import { ToolApprovalCard } from './ToolApprovalCard';
import { useTranscriptFind } from './TranscriptFind';
import { type MessageAction, TranscriptMessage } from './TranscriptMessage';
import { type TranscriptHandle, TranscriptVirtualizer } from './TranscriptVirtualizer';
import { AgentWorking, LiveRunActivity } from './TurnTools';
import { useTranscriptFollowHandlers } from './transcript-follow';
import { useComposerCollapse } from './useComposerCollapse';
import { useDesignDraftPreparation } from './useDesignDraftPreparation';
import { useEngine } from './useEngine';
import { WorkspaceTools } from './WorkspaceTools';

const SessionCollab = lazy(() => import('./SessionCollab'));

export type { EngineSend } from './engine-operations';
export type { EngineTab } from './engine-workspace-tabs';

import { dayLabel, replayProgress } from './transcript-window';

export function EngineWorkspace({
  appearance,
  id,
  sessionTitle,
  onError,
  draft,
  mode,
  onModeChange,
  draftConflict,
  validateDraft,
  onDraftChange,
  references,
  attachments,
  onAttachmentsChange,
  onReferencesChange,
  inputDrafts,
  onInputDraftChange,
  onSettings,
  onOpen,
  scopeKey,
  projectId,
  projectRoot,
}: {
  appearance?: ConversationAppearance | undefined;
  id: string;
  sessionTitle: string;
  onError: (error: unknown) => void;
  draft: string;
  mode: SubmitMode;
  onModeChange: (mode: SubmitMode) => void;
  draftConflict: boolean;
  validateDraft: () => Promise<boolean>;
  onDraftChange: (text: string) => Promise<boolean>;
  references: ComposerFileReference[];
  attachments: ComposerAttachment[];
  onAttachmentsChange: (items: ComposerAttachment[]) => Promise<boolean>;
  onReferencesChange: (refs: ComposerFileReference[]) => Promise<boolean>;
  inputDrafts: Record<string, InputDraft>;
  onInputDraftChange: (key: string, draft: InputDraft | null) => void;
  onSettings: () => void;
  onOpen: (target: AppNavigation) => void;
  scopeKey: string;
  projectId: string;
  projectRoot: string;
}) {
  const { state, send, command } = useEngine(id, onError);
  const artifactRoot = designArtifactRoot(
    projectRoot,
    state.results['session.start']?.['projectRoot'],
  );
  const workspace = useRef<HTMLDivElement>(null);
  const display = conversationDisplay(appearance);
  const composerFold = useComposerCollapse({
    sessionId: id,
    hasMessages: state.messages.length > 0,
    enabled: display.autoCollapseInput,
    running: state.running,
    blocked: !!draft.trim() || attachments.length > 0 || references.length > 0 || draftConflict,
  });
  const focusComposer = () => {
    composerFold.expand();
    requestAnimationFrame(() =>
      workspace.current?.querySelector<HTMLTextAreaElement>('.composer-input textarea')?.focus(),
    );
  };
  const { t } = useDesktopText();
  const [fileTarget, setFileTarget] = useState('');
  const [tab, setTab] = useState<EngineTab>('chat');
  const chatActive = tab === 'chat';
  const backToChat = useCallback(() => setTab('chat'), []);
  const planDraftStorage = useMemo(() => sessionObjectDraftStorage(id, 'plan'), [id]);
  const refineDraftStorage = useMemo(() => sessionObjectDraftStorage(id, 'refine'), [id]);
  useEffect(() => {
    if (tab !== 'files' && tab !== 'changes') setFileTarget('');
  }, [tab]);
  // Recovery operations started here persist per project session so they survive a restart.
  useEffect(() => {
    if (!projectId || !state.sessionId) return;
    const sessionId = state.sessionId;
    void recoveryLogKey(projectId, sessionId).then((key) =>
      recoveryLog.attach(
        sessionId,
        projectFormDraftStorage(projectId, key) as ProjectFormDraftStorage<SavedRecoveryLog>,
      ),
    );
  }, [projectId, state.sessionId]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(false);
  const prepareDesignDraft = useDesignDraftPreparation({
    owner: designOpen ? `${id}:design-dialog` : id,
    draft,
    conflict: draftConflict,
    validate: validateDraft,
    save: onDraftChange,
    onPrepared: () => {
      setDesignOpen(false);
      setTab('chat');
      focusComposer();
    },
  });
  const openTool = (name: EngineTab) => () => {
    setTab(name);
    setToolsOpen(false);
  };
  const end = useRef<HTMLDivElement>(null);
  const chatPane = useRef<HTMLDivElement>(null);
  const transcript = useRef<TranscriptHandle>(null);
  const pins = useMessagePins(`${projectId}:${id}`, onError);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  // Messages there were when the reader scrolled away from the end, to count what arrived since.
  const leftAt = useRef(0);
  const pauseFollowing = () => {
    if (following.current) leftAt.current = state.messages.length;
    following.current = false;
    setShowLatest(true);
  };
  const followHandlers = useTranscriptFollowHandlers(following, pauseFollowing, () => {
    following.current = true;
    setShowLatest(false);
  });
  const [showConversation, setShowConversation] = useState(false);
  const hadQuestions = useRef(false);
  useEffect(() => {
    if (state.inputs.length) {
      following.current = false;
      setShowLatest(false);
      setShowConversation(false);
      chatPane.current?.scrollTo({ top: 0 });
    } else if (hadQuestions.current) {
      following.current = true;
      setShowLatest(false);
    }
    hadQuestions.current = state.inputs.length > 0;
  }, [state.inputs]);
  useEffect(() => {
    if (!chatActive || !state.inputs.length || showConversation) return;
    // A hidden transcript is measured again when Chat opens. Focus the question
    // after that layout, preserving the reader's separate conversation review mode.
    const frame = requestAnimationFrame(() => chatPane.current?.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(frame);
  }, [chatActive, state.inputs.length, showConversation]);
  useEffect(() => {
    if (chatActive && !state.inputs.length && following.current)
      end.current?.scrollIntoView({ block: 'nearest' });
  }, [chatActive, state.messages, state.inputs, state.approvals]);
  // A panel opening under the conversation shrinks it, and a card can grow after it renders;
  // while following, keep the newest content in view through those changes too.
  useEffect(() => {
    const pane = chatPane.current;
    if (
      !chatActive ||
      !pane ||
      typeof ResizeObserver === 'undefined' ||
      typeof MutationObserver === 'undefined'
    )
      return;
    const keep = () => {
      if (following.current) end.current?.scrollIntoView({ block: 'nearest' });
    };
    const resize = new ResizeObserver(keep);
    resize.observe(pane);
    const mutation = new MutationObserver(keep);
    mutation.observe(pane, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [chatActive]);
  const resolved = state.results['user.input_resolved']?.['requestId'];
  useEffect(() => {
    if (typeof resolved === 'string') onInputDraftChange(`${id}:${resolved}`, null);
  }, [resolved, id, onInputDraftChange]);
  const perform = (type: string, payload?: Record<string, unknown>) => {
    void send(type, payload).catch(onError);
  };
  const openFile = (path: string) => {
    // Design reference output is relative to the project, even in a nested work directory.
    const designArtifact = designSpecPath(path) ?? designReviewPath(path);
    setFileTarget(designArtifact && artifactRoot ? `${artifactRoot}/${designArtifact}` : path);
    setTab('files');
  };
  const openDesign = () => onOpen({ page: 'design' });
  const resendPrompt = async (text: string) => {
    const capabilities = state.results['session.start']?.['protocolCapabilities'];
    if (!Array.isArray(capabilities) || !capabilities.includes('session.user-ack'))
      throw Error('this engine cannot confirm that it accepted the prompt');
    await command(
      'user_message',
      { id: crypto.randomUUID(), content: text, timestamp: Date.now() },
      ['key.operation_result'],
    );
  };
  const chimeraAction = (reportId: string): MessageAction => {
    const blocked = draftConflict
      ? 'draft'
      : chimeraFollowupState(state, reportId, draft, references.length + attachments.length);
    if (blocked) return { reason: t(`chimeraMessage.${blocked}`) };
    return {
      run: async () => {
        try {
          await onDraftChange(chimeraFollowup(reportId));
        } catch (error) {
          onError(String(error));
        }
      },
    };
  };
  const editAction = (message: { role: string; text: string }): MessageAction | undefined => {
    if (message.role !== 'user' || parseBugHuntMessage(message.text)) return undefined;
    if (draft.trim() || references.length) return { reason: t('chatView.reason.editDraft') };
    const view = splitReferenceMessage(message.text);
    return {
      run: () => void onDraftChange(view.text).then(() => onReferencesChange(view.references)),
    };
  };
  const askAgainAction = (): MessageAction | undefined => {
    const prompt = state.messages.findLast((message) => message.role === 'user');
    if (!prompt) return undefined;
    if (state.running) return { reason: t('chatView.reason.running') };
    if (!state.connected) return { reason: t('chatView.reason.offline') };
    return { run: () => void resendPrompt(prompt.text).catch(onError) };
  };
  const openLink = useCallback(
    (url: string) => {
      const target = markdownTarget(url);
      if (target?.kind === 'external') void openExternal(target.value).catch(onError);
      if (target?.kind === 'file') {
        setFileTarget(target.value);
        setTab('files');
      }
    },
    [send, onError],
  );
  const navigate = (target: DesktopNavigation) =>
    'tab' in target ? setTab(target.tab) : onOpen(target);
  const shortcuts = useConversationShortcuts(navigate, display.keyboardShortcuts, focusComposer);
  useRunSounds(state);
  const agentTabs = useAgentTabs(state, openLink);
  const finder = useTranscriptFind({
    messages: state.messages,
    enabled: chatActive && !agentTabs.view,
    reveal: (index) => {
      pauseFollowing();
      transcript.current?.scrollToMessage(index);
    },
  });
  return (
    <div className="engine-workspace" data-engine-session={state.sessionId} ref={workspace}>
      {shortcuts}
      <nav className="workspace-tabs" aria-label={t('workspace.views')}>
        {(
          [
            { name: 'chat', label: t('workspace.chat'), Icon: MessageSquare },
            { name: 'files', label: t('workspace.files'), Icon: FolderCode },
            { name: 'changes', label: t('workspace.changes'), Icon: GitCompareArrows },
          ] as const
        ).map(({ name, label, Icon }) => (
          <button
            type="button"
            key={name}
            className={tab === name ? 'chosen-tab' : ''}
            aria-current={tab === name ? 'page' : undefined}
            onClick={() => setTab(name)}
          >
            <Icon size={14} />
            {label}
            {name === 'chat' && state.approvals.length + state.inputs.length > 0 && (
              <span>{state.approvals.length + state.inputs.length}</span>
            )}
          </button>
        ))}
        <button
          type="button"
          className={
            [
              'activity',
              'skills',
              'history',
              'mcp-tasks',
              'processes',
              'side-effects',
              'usage',
              'story',
              'context',
              'plan',
            ].includes(tab)
              ? 'chosen-tab project-tools-button'
              : 'project-tools-button'
          }
          onClick={() => setToolsOpen(true)}
        >
          <PanelsTopLeft size={14} />
          {t('workspace.tools')}
          <ChevronDown size={11} />
        </button>
        <button
          type="button"
          className="icon-button project-tools-button"
          aria-label={t('workspace.settings')}
          title={t('workspace.settingsTitle')}
          onClick={onSettings}
        >
          <Settings2 size={15} />
        </button>
      </nav>
      {toolsOpen && (
        <WorkspaceTools
          onClose={() => setToolsOpen(false)}
          onHistory={openTool('history')}
          onSkills={openTool('skills')}
          onMcpTasks={openTool('mcp-tasks')}
          onProcesses={openTool('processes')}
          onSideEffects={openTool('side-effects')}
          onUsage={openTool('usage')}
          onStory={openTool('story')}
          onContext={openTool('context')}
          onPlan={openTool('plan')}
          onDesign={() => {
            setToolsOpen(false);
            setDesignOpen(true);
          }}
          onProject={() => {
            setToolsOpen(false);
            onOpen({ page: 'overview' });
          }}
          onSettings={() => {
            setToolsOpen(false);
            onSettings();
          }}
          onActivity={openTool('activity')}
        />
      )}
      {designOpen && (
        <Modal title={t('chatView.designTitle')} onClose={() => setDesignOpen(false)}>
          <header>
            <strong>
              {t('projectKit.target')}: {sessionTitle}
            </strong>
            <button
              type="button"
              className="icon-button"
              aria-label={t('sessionTools.close')}
              onClick={() => setDesignOpen(false)}
            >
              <X size={17} />
            </button>
          </header>
          <DesignExtractForm
            onPrepare={prepareDesignDraft}
            disabled={draftConflict}
            target={draftConflict ? <p role="alert">{t('designFlow.draftRefused')}</p> : undefined}
          />
        </Modal>
      )}
      {state.error && state.error !== failedRun(state)?.message && (
        <div className="session-error" role="alert">
          {state.error}
        </div>
      )}
      {chatActive && (
        <>
          {state.connected && state.needsSetup && (
            <div className="provider-setup-banner">
              <span>{t('chatView.providerNeeded')}</span>
              <button type="button" className="button primary" onClick={onSettings}>
                {t('chatView.configureProvider')}
              </button>
            </div>
          )}
          {state.inputs.length > 0 && (
            <div className="input-context-toggle">
              <span>
                {t(state.inputs.length === 1 ? 'chatView.pendingOne' : 'chatView.pendingMany', {
                  count: state.inputs.length,
                })}
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowConversation(!showConversation);
                  chatPane.current?.scrollTo({ top: 0 });
                }}
              >
                {showConversation ? t('chatView.focusQuestions') : t('chatView.reviewConversation')}
              </button>
            </div>
          )}
          {agentTabs.bar}
          {agentTabs.view}
          {finder.bar}
          {pins.ids.length > 0 && (
            <details className="transcript-pins">
              <summary>{t('messagePins.list', { count: pins.ids.length })}</summary>
              {pins.ids.map((messageId) => {
                const index = state.messages.findIndex((message) => message.id === messageId);
                return (
                  <div key={messageId}>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={index < 0}
                      onClick={() => {
                        pauseFollowing();
                        transcript.current?.scrollToMessage(index);
                      }}
                    >
                      {index < 0
                        ? t('messagePins.unavailable')
                        : state.messages[index]!.text.slice(0, 120)}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => pins.toggle(messageId)}
                    >
                      {t('messagePins.unpin')}
                    </button>
                  </div>
                );
              })}
            </details>
          )}
        </>
      )}
      {/* The scroll element, measured rows and open disclosures belong to the conversation. */}
      <div
        ref={chatPane}
        hidden={!chatActive || agentTabs.view !== null}
        className="native-chat-messages"
        aria-live="polite"
        {...followHandlers}
      >
        <TranscriptVirtualizer
          ref={transcript}
          scrollRef={chatPane}
          following={chatActive ? following : undefined}
          messages={
            state.synced && (!state.inputs.length || showConversation) ? state.messages : []
          }
          header={
            <>
              {/* A conversation read for the first time appears once read to its end, not
                message by message from its first prompt as if it were starting over. */}
              {!state.synced && (
                <div className="native-chat-welcome" role="status">
                  <LoaderCircle size={18} className="spin" />
                  <p>{t('chatView.loading')}</p>
                  {state.replay && <small>{replayProgress(state.replay)}</small>}
                </div>
              )}
              {state.synced && !state.messages.length && !state.inputs.length && (
                <ConversationWelcome
                  projectRoot={projectRoot}
                  provider={state.provider}
                  model={state.model}
                  connected={state.connected}
                  onStart={(prompt) => void onDraftChange(prompt).then(focusComposer)}
                  onPrepareDesign={prepareDesignDraft}
                  designBlocked={draftConflict}
                />
              )}
              {state.synced && (!state.inputs.length || showConversation) && (
                <LiveRunActivity
                  display={display}
                  events={state.leadingActivity}
                  projectRoot={artifactRoot}
                  live={state.running && !state.messages.length}
                  command={command}
                  onOpenFile={openFile}
                  onOpenDesign={openDesign}
                />
              )}
            </>
          }
          footer={
            <>
              {state.inputs.map((request) => (
                <InputRequestCard
                  key={request.id}
                  request={request}
                  draft={inputDrafts[`${id}:${request.id}`]}
                  onChange={(value) => onInputDraftChange(`${id}:${request.id}`, value)}
                  send={send}
                  connected={state.connected}
                />
              ))}
              {state.approvals.map((approval) => (
                <ToolApprovalCard
                  key={String(approval['id'])}
                  approval={approval}
                  send={send}
                  connected={state.connected}
                />
              ))}
              {state.running && (
                <AgentWorking waiting={state.inputs.length > 0} since={state.runStartAt} />
              )}
              <div ref={end} />
            </>
          }
          renderMessage={(message, index) => (
            <TranscriptMessage
              key={message.id}
              message={message}
              display={display}
              state={state}
              projectRoot={artifactRoot}
              activityLive={state.running && index === state.messages.length - 1}
              onLink={openLink}
              onOpenFile={openFile}
              onOpenDesign={openDesign}
              command={command}
              edit={editAction(message)}
              pin={{
                active: pins.ids.includes(message.id),
                toggle: () => pins.toggle(message.id),
              }}
              chimeraAction={message.chimera ? chimeraAction(message.chimera.reportId) : undefined}
              onOpenChimera={
                message.chimera
                  ? () => onOpen({ page: 'reviews', reportId: message.chimera!.reportId })
                  : undefined
              }
              mark={finder.mark(message.id)}
              day={dayLabel(message, index ? state.messages[index - 1] : undefined)}
              askAgain={
                index === state.messages.length - 1 && message.role === 'assistant'
                  ? askAgainAction()
                  : undefined
              }
            />
          )}
        />
      </div>
      {chatActive ? (
        <>
          {showLatest && !state.inputs.length && (
            <div className="chat-follow-control">
              <button
                type="button"
                onClick={() => {
                  following.current = true;
                  setShowLatest(false);
                  end.current?.scrollIntoView({ block: 'nearest' });
                }}
              >
                {t('chatView.jumpToLatest')}
                {state.messages.length > leftAt.current &&
                  ` \u00b7 ${t('chatView.newMessages', { count: state.messages.length - leftAt.current })}`}
              </button>
            </div>
          )}
          <ConversationNotices
            key={state.sessionId}
            notices={state.notices}
            onAction={async (action) => {
              try {
                await command(action.type, action.payload, [`${action.type}_result`]);
              } catch (error) {
                onError(error);
                throw error;
              }
            }}
          />
          <FallbackPicker state={state} send={send} />
          <ProviderWaitingRoom state={state} command={command} />
          <SessionTodos state={state} command={command} />
          <ScheduledJobs state={state} />
          <SessionWorklist state={state} command={command} />
          <SessionBrowser
            id={id}
            state={state}
            send={send}
            command={command}
            onAddToPrompt={(text) => void onDraftChange(appendToDraft(draft, text))}
          />
          {state.inputs.length > 0 && (
            <div className="input-waiting-controls">
              <span>{t('chatView.answerForm')}</span>
              <button type="button" className="button secondary" onClick={() => perform('abort')}>
                <Square size={13} />
                {t('chatView.stopRun')}
              </button>
            </div>
          )}
          {state.messages.length > 0 && !state.inputs.length && (
            <ComposerFoldControls
              collapsed={composerFold.collapsed}
              running={state.running}
              draft={draft}
              onExpand={focusComposer}
              onCollapse={composerFold.collapse}
              onStop={() => perform('abort')}
            />
          )}
          {/* Hidden, not unmounted, while a form waits: an open refinement review or other
              composer state must survive the question. */}
          <div hidden={state.inputs.length > 0 || composerFold.collapsed} className="composer-host">
            <SessionComposer
              key={id}
              state={state}
              send={send}
              command={command}
              draft={draft}
              mode={mode}
              onModeChange={onModeChange}
              draftConflict={draftConflict}
              validateDraft={validateDraft}
              onDraftChange={onDraftChange}
              onSettings={onSettings}
              references={references}
              attachments={attachments}
              onAttachmentsChange={onAttachmentsChange}
              onReferencesChange={onReferencesChange}
              projectId={projectId}
              projectRoot={projectRoot}
              planDraftStorage={planDraftStorage}
              refineDraftStorage={refineDraftStorage}
              onNavigate={navigate}
            />
          </div>
        </>
      ) : isEngineSessionPanel(tab) ? (
        <EngineSessionPanels
          tab={tab}
          state={state}
          sessionTitle={sessionTitle}
          projectId={projectId}
          projectRoot={projectRoot}
          send={send}
          command={command}
          onBack={backToChat}
        />
      ) : tab === 'history' ? (
        <SessionRecovery
          key={state.sessionId}
          sessionTitle={sessionTitle}
          sessionId={state.sessionId}
          running={state.running}
          command={command}
          onBack={() => setTab('chat')}
          onOpenFile={(path) => {
            setFileTarget(path);
            setTab('files');
          }}
          draftEmpty={!draft.trim()}
          onEditPrompt={(text) => {
            void onDraftChange(text).then((saved) => {
              if (saved) setTab('chat');
            });
          }}
          onRetryPrompt={async (text) => {
            await resendPrompt(text);
            setTab('chat');
          }}
        />
      ) : tab === 'activity' ? (
        <SessionActivity
          events={state.activity}
          projectRoot={artifactRoot}
          command={command}
          onOpenFile={openFile}
          onOpenDesign={openDesign}
          collab={<SessionCollab id={id} state={state} />}
        />
      ) : tab === 'skills' || tab === 'files' || tab === 'changes' ? (
        <ProjectSessionTools
          projectId={projectId}
          projectRoot={projectRoot}
          view={tab}
          initialPath={workspaceFilePath(fileTarget, projectRoot, scopeKey)}
          onError={onError}
          onOpenFile={(path) => {
            setFileTarget(path);
            setTab('files');
          }}
          onReview={(text) => {
            onDraftChange(
              `Project root: ${projectRoot.replace(/^\\\\\?\\/, '').replaceAll('\\', '/')}\n\n${text}`,
            );
            setTab('chat');
          }}
          onReference={(ref) => {
            // A file may carry several ranges or quotes; an identical one is not added twice.
            void onReferencesChange(withReference(references, ref));
            setTab('chat');
          }}
        />
      ) : (
        <EngineDataView tab={tab} state={state} send={send} onError={onError} />
      )}
      <SessionStatusBar state={state} command={command} refresh={() => perform('stats.get')} />
    </div>
  );
}
