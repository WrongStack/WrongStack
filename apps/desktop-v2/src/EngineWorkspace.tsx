import { stripNextStepsBlock } from '@wrongstack/webui-protocol';
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
import { AttachmentPreview } from './ComposerAttachments';
import { ConversationNotices } from './ConversationNotices';
import { CopyButton } from './CopyButton';
import type { ComposerAttachment } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  appendToDraft,
  type ComposerFileReference,
  referenceKey,
  referenceLabel,
  splitReferenceMessage,
  withReference,
} from './composer-resources-model';
import { EngineDataView } from './EngineDataView';
import { FallbackPicker } from './FallbackPicker';
import { workspaceFilePath } from './file-model';
import { InputRequestCard } from './InputRequestCard';
import type { InputDraft } from './input-form-model';
import { MarkdownContent } from './MarkdownContent';
import { markdownTarget } from './markdown-target';
import { ProjectSessionTools } from './ProjectSessionTools';
import { openExternal, projectFormDraftStorage, sessionObjectDraftStorage } from './platform';
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
import { LiveRunActivity, TurnTools } from './TurnTools';
import type { ProjectPage } from './useDesktop';
import { useEngine } from './useEngine';
import { WorkspaceTools } from './WorkspaceTools';

const CouncilCard = lazy(() => import('./CouncilCard'));
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

import { hiddenMessageCount, TRANSCRIPT_WINDOW } from './transcript-window';

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
  return (
    <div className="engine-workspace" data-engine-session={state.sessionId}>
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
      {state.error && (
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
          <div
            ref={chatPane}
            className="native-chat-messages"
            aria-live="polite"
            onScroll={(event) => {
              const pane = event.currentTarget;
              const near = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
              if (following.current !== near) {
                following.current = near;
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
              state.messages.slice(hiddenMessages).map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <header className={message.role === 'user' ? 'user-chat-label' : undefined}>
                    <span>{message.role === 'user' ? 'You' : 'WrongStack'}</span>
                    <CopyButton text={message.text} label="Copy message" />
                  </header>
                  <div className={message.role === 'user' ? 'user-chat-body' : undefined}>
                    {message.council ? (
                      <Suspense
                        fallback={<MarkdownContent text={message.text} onLink={openLink} />}
                      >
                        <CouncilCard decision={message.council} />
                      </Suspense>
                    ) : message.role === 'assistant' ? (
                      <MarkdownContent text={stripNextStepsBlock(message.text)} onLink={openLink} />
                    ) : (
                      <UserComposerMessage text={message.text} />
                    )}
                    {!!message.attachments?.length && (
                      <AttachmentPreview items={message.attachments} />
                    )}
                  </div>
                  {(state.turnActivity[message.id] || state.turnStats[message.id]) && (
                    <TurnTools
                      events={state.turnActivity[message.id] ?? []}
                      stats={state.turnStats[message.id]}
                      onOpenFile={(path) => {
                        setFileTarget(path);
                        setTab('files');
                      }}
                    />
                  )}
                </article>
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
              <LiveRunActivity
                events={state.runTimeline}
                onOpenFile={(path) => {
                  setFileTarget(path);
                  setTab('files');
                }}
              />
            )}
            {state.running && (
              <div className="agent-working">
                <LoaderCircle size={13} className="spin" />
                {state.inputs.length ? 'Waiting for your answers…' : 'WrongStack is working…'}
              </div>
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
              onNavigate={(target) => {
                if (target === 'files' || target === 'changes' || target === 'skills')
                  setTab(target);
                else onProject(target);
              }}
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
            const capabilities = state.results['session.start']?.['protocolCapabilities'];
            if (!Array.isArray(capabilities) || !capabilities.includes('session.user-ack'))
              throw Error('this engine cannot confirm that it accepted the prompt');
            await command(
              'user_message',
              { id: crypto.randomUUID(), content: text, timestamp: Date.now() },
              ['key.operation_result'],
            );
            setTab('chat');
          }}
        />
      ) : tab === 'activity' ? (
        <SessionActivity
          events={state.activity}
          onOpenFile={(path) => {
            setFileTarget(path);
            setTab('files');
          }}
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
function UserComposerMessage({ text }: { text: string }) {
  const view = splitReferenceMessage(text);
  return (
    <>
      {view.text}
      {view.paths.length > 0 && (
        <section className="chat-file-references" aria-label="Referenced project files">
          {view.references.map((ref) => (
            <code key={referenceKey(ref)}>{referenceLabel(ref)}</code>
          ))}
        </section>
      )}
    </>
  );
}
