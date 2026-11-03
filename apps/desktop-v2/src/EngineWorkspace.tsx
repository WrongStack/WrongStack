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
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentTabs } from './AgentTranscripts';
import { ConversationNotices } from './ConversationNotices';
import { useConversationShortcuts } from './ConversationShortcuts';
import type { ComposerAttachment } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  appendToDraft,
  type ComposerFileReference,
  splitReferenceMessage,
  withReference,
} from './composer-resources-model';
import type { DesktopNavigation } from './desktop-commands';
import { EngineDataView } from './EngineDataView';
import { FallbackPicker } from './FallbackPicker';
import { failedRun } from './failed-run-model';
import { workspaceFilePath } from './file-model';
import { InputRequestCard } from './InputRequestCard';
import type { InputDraft } from './input-form-model';
import { markdownTarget } from './markdown-target';
import { ProjectSessionTools } from './ProjectSessionTools';
import { ProviderWaitingRoom } from './ProviderWaitingRoom';
import { openExternal, projectFormDraftStorage, sessionObjectDraftStorage } from './platform';
import { useRunSounds } from './RunSounds';
import { recoveryLog, recoveryLogKey, type SavedRecoveryLog } from './recovery-log';
import type { ProjectFormDraftStorage } from './requirement-draft';
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
import { AgentWorking, LiveRunActivity } from './TurnTools';
import type { ProjectPage } from './useDesktop';
import { useEngine } from './useEngine';
import { WorkspaceTools } from './WorkspaceTools';

const SessionMcpTasks = lazy(() =>
  import('./SessionMcpTasks').then((module) => ({ default: module.SessionMcpTasks })),
);
const SessionProcesses = lazy(() =>
  import('./SessionProcesses').then((module) => ({ default: module.SessionProcesses })),
);
const SessionSideEffects = lazy(() =>
  import('./SessionSideEffects').then((module) => ({ default: module.SessionSideEffects })),
);
const SessionPlanTemplates = lazy(() =>
  import('./SessionPlanTemplates').then((module) => ({ default: module.SessionPlanTemplates })),
);
const SessionUsage = lazy(() =>
  import('./SessionUsage').then((module) => ({ default: module.SessionUsage })),
);
const SessionStory = lazy(() =>
  import('./SessionStory').then((module) => ({ default: module.SessionStory })),
);
const SessionContextDashboard = lazy(() =>
  import('./SessionContextDashboard').then((module) => ({
    default: module.SessionContextDashboard,
  })),
);
export type EngineTab =
  | 'chat'
  | 'activity'
  | 'history'
  | 'mcp-tasks'
  | 'processes'
  | 'side-effects'
  | 'usage'
  | 'story'
  | 'context'
  | 'plan'
  | 'files'
  | 'changes'
  | 'skills'
  | 'mailbox'
  | 'kanban';
export type { EngineSend } from './engine-operations';

import {
  dayLabel,
  hiddenMessageCount,
  replayProgress,
  TRANSCRIPT_WINDOW,
} from './transcript-window';

export function EngineWorkspace({
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
  onProject,
  scopeKey,
  projectId,
  projectRoot,
}: {
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
  onProject: (page?: ProjectPage) => void;
  scopeKey: string;
  projectId: string;
  projectRoot: string;
}) {
  const { state, send, command } = useEngine(id, onError);
  const [fileTarget, setFileTarget] = useState('');
  const [tab, setTab] = useState<EngineTab>('chat');
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
  const openTool = (name: EngineTab) => () => {
    setTab(name);
    setToolsOpen(false);
  };
  const end = useRef<HTMLDivElement>(null);
  const chatPane = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  // Messages there were when the reader scrolled away from the end, to count what arrived since.
  const leftAt = useRef(0);
  const [showConversation, setShowConversation] = useState(false);
  // Long conversations render their newest messages; earlier ones load on request.
  const [shownMessages, setShownMessages] = useState(TRANSCRIPT_WINDOW);
  useEffect(() => setShownMessages(TRANSCRIPT_WINDOW), [id]);
  const hiddenMessages = hiddenMessageCount(state.messages.length, shownMessages);
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
    if (!state.inputs.length && following.current)
      end.current?.scrollIntoView({ block: 'nearest' });
  }, [state.messages, state.inputs, state.approvals]);
  // A panel opening under the conversation shrinks it, and a card can grow after it renders;
  // while following, keep the newest content in view through those changes too.
  useEffect(() => {
    const pane = chatPane.current;
    if (!pane || typeof ResizeObserver === 'undefined' || typeof MutationObserver === 'undefined')
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
  }, [tab]);
  const resolved = state.results['user.input_resolved']?.['requestId'];
  useEffect(() => {
    if (typeof resolved === 'string') onInputDraftChange(`${id}:${resolved}`, null);
  }, [resolved, id, onInputDraftChange]);
  const perform = (type: string, payload?: Record<string, unknown>) => {
    void send(type, payload).catch(onError);
  };
  const openFile = (path: string) => {
    setFileTarget(path);
    setTab('files');
  };
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
  const editAction = (message: { role: string; text: string }): MessageAction | undefined => {
    if (message.role !== 'user' || parseBugHuntMessage(message.text)) return undefined;
    if (draft.trim() || references.length)
      return { reason: 'Send or clear the composer draft first; editing would replace it' };
    const view = splitReferenceMessage(message.text);
    return {
      run: () => void onDraftChange(view.text).then(() => onReferencesChange(view.references)),
    };
  };
  const askAgainAction = (): MessageAction | undefined => {
    const prompt = state.messages.findLast((message) => message.role === 'user');
    if (!prompt) return undefined;
    if (state.running) return { reason: 'Wait for the running turn to finish' };
    if (!state.connected) return { reason: 'The engine is not connected' };
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
    'tab' in target ? setTab(target.tab) : onProject(target.page);
  const shortcuts = useConversationShortcuts(navigate);
  useRunSounds(state);
  const agentTabs = useAgentTabs(state.agents, openLink);
  const finder = useTranscriptFind({
    messages: state.messages,
    enabled: tab === 'chat' && !agentTabs.view,
    reveal: (index) => {
      following.current = false;
      if (index < hiddenMessages) setShownMessages(state.messages.length - index);
      const target = `[data-message-id="${CSS.escape(state.messages[index]?.id ?? '')}"]`;
      setTimeout(() => document.querySelector(target)?.scrollIntoView({ block: 'center' }), 50);
    },
  });
  return (
    <div className="engine-workspace" data-engine-session={state.sessionId}>
      {shortcuts}
      <nav className="workspace-tabs" aria-label="Agent workspace views">
        {(
          [
            { name: 'chat', label: 'Chat', Icon: MessageSquare },
            { name: 'files', label: 'Files', Icon: FolderCode },
            { name: 'changes', label: 'Changes', Icon: GitCompareArrows },
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
          Tools
          <ChevronDown size={11} />
        </button>
        <button
          type="button"
          className="icon-button project-tools-button"
          aria-label="Settings"
          title="Model & provider settings"
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
          onProject={() => {
            setToolsOpen(false);
            onProject();
          }}
          onSettings={() => {
            setToolsOpen(false);
            onSettings();
          }}
          onActivity={openTool('activity')}
        />
      )}
      {state.error && state.error !== failedRun(state)?.message && (
        <div className="session-error" role="alert">
          {state.error}
        </div>
      )}
      {tab === 'chat' ? (
        <>
          {state.connected && state.needsSetup && (
            <div className="provider-setup-banner">
              <span>Connect a provider to start working with WrongStack.</span>
              <button type="button" className="button primary" onClick={onSettings}>
                Configure provider
              </button>
            </div>
          )}
          {state.inputs.length > 0 && (
            <div className="input-context-toggle">
              <span>
                {state.inputs.length} pending {state.inputs.length === 1 ? 'request' : 'requests'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowConversation(!showConversation);
                  chatPane.current?.scrollTo({ top: 0 });
                }}
              >
                {showConversation ? 'Focus questions' : 'Review conversation'}
              </button>
            </div>
          )}
          {agentTabs.bar}
          {agentTabs.view}
          {finder.bar}
          <div
            ref={chatPane}
            hidden={agentTabs.view !== null}
            className="native-chat-messages"
            aria-live="polite"
            onScroll={(event) => {
              const pane = event.currentTarget;
              const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
              if (following.current !== near) {
                following.current = near;
                if (!near) leftAt.current = state.messages.length;
                setShowLatest(!near);
              }
            }}
          >
            {/* A conversation read for the first time appears once read to its end, not
                message by message from its first prompt as if it were starting over. */}
            {!state.synced && (
              <div className="native-chat-welcome" role="status">
                <LoaderCircle size={18} className="spin" />
                <p>Loading this conversation…</p>
                {state.replay && <small>{replayProgress(state.replay)}</small>}
              </div>
            )}
            {state.synced && !state.messages.length && !state.inputs.length && (
              <div className="native-chat-welcome">
                <h2>What should we work on?</h2>
                {!state.connected && <LoaderCircle size={18} className="spin" />}
              </div>
            )}
            {state.synced && (!state.inputs.length || showConversation) && hiddenMessages > 0 && (
              <button
                type="button"
                className="button secondary small chat-earlier"
                onClick={() => {
                  // Keep the reader's place: loading earlier messages must not jump to the end.
                  following.current = false;
                  setShownMessages((count) => count + TRANSCRIPT_WINDOW);
                }}
              >
                Show {Math.min(TRANSCRIPT_WINDOW, hiddenMessages)} earlier messages (
                {hiddenMessages} not shown)
              </button>
            )}
            {state.synced &&
              (!state.inputs.length || showConversation) &&
              state.messages
                .slice(hiddenMessages)
                .map((message, index, shown) => (
                  <TranscriptMessage
                    key={message.id}
                    message={message}
                    state={state}
                    onLink={openLink}
                    onOpenFile={openFile}
                    command={command}
                    edit={editAction(message)}
                    mark={finder.mark(message.id)}
                    day={dayLabel(message, index ? shown[index - 1] : undefined)}
                    askAgain={
                      index === shown.length - 1 && message.role === 'assistant'
                        ? askAgainAction()
                        : undefined
                    }
                  />
                ))}
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
            {state.running && !state.inputs.length && (
              <LiveRunActivity events={state.runTimeline} command={command} onOpenFile={openFile} />
            )}
            {state.running && (
              <AgentWorking waiting={state.inputs.length > 0} since={state.runStartAt} />
            )}
            <div ref={end} />
          </div>
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
                Jump to latest
                {state.messages.length > leftAt.current &&
                  ` · ${state.messages.length - leftAt.current} new`}
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
              <span>Answer the form to continue.</span>
              <button type="button" className="button secondary" onClick={() => perform('abort')}>
                <Square size={13} />
                Stop run
              </button>
            </div>
          )}
          {/* Hidden, not unmounted, while a form waits: an open refinement review or other
              composer state must survive the question. */}
          <div hidden={state.inputs.length > 0} className="composer-host">
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
      ) : tab === 'side-effects' ? (
        <Suspense fallback={<p role="status">Opening side-effect history…</p>}>
          <SessionSideEffects
            key={state.sessionId}
            sessionId={state.sessionId}
            connected={state.connected}
            command={command}
            onBack={() => setTab('chat')}
          />
        </Suspense>
      ) : tab === 'plan' ? (
        <Suspense fallback={<p role="status">Opening plan templates…</p>}>
          <SessionPlanTemplates
            key={state.sessionId}
            command={command}
            running={state.running}
            onBack={() => setTab('chat')}
          />
        </Suspense>
      ) : tab === 'usage' ? (
        <Suspense fallback={<p role="status">Opening conversation usage…</p>}>
          <SessionUsage
            key={state.sessionId}
            sessionId={state.sessionId}
            sessionTitle={sessionTitle}
            connected={state.connected}
            command={command}
            onBack={() => setTab('chat')}
            delegations={state.delegations}
          />
        </Suspense>
      ) : tab === 'story' ? (
        <Suspense fallback={<p role="status">Opening the session story…</p>}>
          <SessionStory
            key={state.sessionId}
            projectId={projectId}
            projectRoot={projectRoot}
            state={state}
            send={send}
            command={command}
            onBack={backToChat}
          />
        </Suspense>
      ) : tab === 'context' ? (
        <Suspense fallback={<p role="status">Opening the context dashboard…</p>}>
          <SessionContextDashboard
            key={state.sessionId}
            projectId={projectId}
            projectRoot={projectRoot}
            state={state}
            command={command}
            onBack={backToChat}
          />
        </Suspense>
      ) : tab === 'processes' ? (
        <Suspense fallback={<p role="status">Opening session processes…</p>}>
          <SessionProcesses
            key={state.sessionId}
            sessionId={state.sessionId}
            connected={state.connected}
            command={command}
            onBack={() => setTab('chat')}
          />
        </Suspense>
      ) : tab === 'mcp-tasks' ? (
        <Suspense fallback={<p role="status">Opening session MCP tasks…</p>}>
          <SessionMcpTasks
            key={state.sessionId}
            sessionId={state.sessionId}
            connected={state.connected}
            command={command}
            pendingReviews={state.approvals.length + state.inputs.length}
            onBack={() => setTab('chat')}
          />
        </Suspense>
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
        <SessionActivity events={state.activity} command={command} onOpenFile={openFile} />
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
