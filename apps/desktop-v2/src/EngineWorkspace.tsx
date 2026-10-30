import { stripNextStepsBlock } from '@wrongstack/webui-protocol';
import {
  ChevronDown,
  FolderCode,
  GitCompareArrows,
  LoaderCircle,
  MessageSquare,
  PanelsTopLeft,
  RefreshCw,
  Settings2,
  Square,
  Workflow,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentPreview } from './ComposerAttachments';
import { CopyButton } from './CopyButton';
import type { ComposerAttachment } from './composer-attachments';
import type { SubmitMode } from './composer-model';
import {
  type ComposerFileReference,
  referenceKey,
  referenceLabel,
  splitReferenceMessage,
  withReference,
} from './composer-resources-model';
import { EngineDataView } from './EngineDataView';
import { type EngineState, record } from './engine-state';
import { workspaceFilePath } from './file-model';
import { InputRequestCard } from './InputRequestCard';
import type { InputDraft } from './input-form-model';
import { MarkdownContent } from './MarkdownContent';
import { markdownTarget } from './markdown-target';
import { ProjectSessionTools } from './ProjectSessionTools';
import { openExternal, sessionObjectDraftStorage } from './platform';
import { SessionActivity } from './SessionActivity';
import { SessionComposer } from './SessionComposer';
import { SessionRecovery } from './SessionRecovery';
import { SessionTodos } from './SessionTodos';
import { inlineUsageEstimate } from './session-usage-model';
import { ToolApprovalCard } from './ToolApprovalCard';
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
const SessionUsage = lazy(() =>
  import('./SessionUsage').then((module) => ({ default: module.SessionUsage })),
);
export type EngineTab =
  | 'chat'
  | 'activity'
  | 'history'
  | 'mcp-tasks'
  | 'processes'
  | 'side-effects'
  | 'usage'
  | 'files'
  | 'changes'
  | 'skills'
  | 'mailbox'
  | 'kanban';
export type { EngineSend } from './engine-operations';
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
  const planDraftStorage = useMemo(() => sessionObjectDraftStorage(id, 'plan'), [id]);
  const refineDraftStorage = useMemo(() => sessionObjectDraftStorage(id, 'refine'), [id]);
  useEffect(() => {
    if (tab !== 'files' && tab !== 'changes') setFileTarget('');
  }, [tab]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const chatPane = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
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
    if (!state.inputs.length && following.current)
      end.current?.scrollIntoView({ block: 'nearest' });
  }, [state.messages, state.inputs, state.approvals]);
  const resolved = state.results['user.input_resolved']?.['requestId'];
  useEffect(() => {
    if (typeof resolved === 'string') onInputDraftChange(`${id}:${resolved}`, null);
  }, [resolved, id, onInputDraftChange]);
  const perform = (type: string, payload?: Record<string, unknown>) => {
    void send(type, payload).catch(onError);
  };
  const recentEvents = state.activity.slice(
    state.activity.findLastIndex((event) => event.type === 'run.result') + 1,
  );
  const liveTools = new Set(
    recentEvents
      .filter((event) => event.type === 'tool.started' || event.type === 'tool.executed')
      .map((event) => event.payload['id'])
      .filter((id) => typeof id === 'string'),
  ).size;
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
            { name: 'changes', label: 'Diff / review', Icon: GitCompareArrows },
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
          onHistory={() => {
            setTab('history');
            setToolsOpen(false);
          }}
          onSkills={() => {
            setTab('skills');
            setToolsOpen(false);
          }}
          onMcpTasks={() => {
            setTab('mcp-tasks');
            setToolsOpen(false);
          }}
          onProcesses={() => {
            setTab('processes');
            setToolsOpen(false);
          }}
          onSideEffects={() => {
            setTab('side-effects');
            setToolsOpen(false);
          }}
          onUsage={() => {
            setTab('usage');
            setToolsOpen(false);
          }}
          onProject={() => {
            setToolsOpen(false);
            onProject();
          }}
          onSettings={() => {
            setToolsOpen(false);
            onSettings();
          }}
          onActivity={() => {
            setTab('activity');
            setToolsOpen(false);
          }}
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
            {!state.messages.length && !state.inputs.length && (
              <div className="native-chat-welcome">
                <Workflow size={30} />
                <span className="eyebrow">YOUR AGENT, IN YOUR WORKSPACE</span>
                <h2>What are we building?</h2>
                <p>
                  Brief WrongStack. Watch the work here, review its tools, and approve requests
                  without leaving this session.
                </p>
                {!state.connected && <LoaderCircle size={18} className="spin" />}
              </div>
            )}
            {(!state.inputs.length || showConversation) &&
              state.messages.map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <header className={message.role === 'user' ? 'user-chat-label' : undefined}>
                    <span>{message.role === 'user' ? 'YOU' : 'WRONGSTACK'}</span>
                    <CopyButton text={message.text} label="Copy message" />
                  </header>
                  <div className={message.role === 'user' ? 'user-chat-body' : undefined}>
                    {message.role === 'assistant' ? (
                      <MarkdownContent text={stripNextStepsBlock(message.text)} onLink={openLink} />
                    ) : (
                      <UserComposerMessage text={message.text} />
                    )}
                    {!!message.attachments?.length && (
                      <AttachmentPreview items={message.attachments} />
                    )}
                  </div>
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
            {state.running &&
              !state.inputs.length &&
              recentEvents.some(
                (event) =>
                  ['tool.started', 'tool.progress', 'tool.executed'].includes(event.type) ||
                  event.type === 'provider.thinking_delta' ||
                  event.type === 'provider.retry',
              ) && (
                <details className="chat-run-activity">
                  <summary>
                    Run activity
                    {liveTools
                      ? ` · ${liveTools} ${liveTools === 1 ? 'tool call' : 'tool calls'}`
                      : ''}
                  </summary>
                  <SessionActivity
                    compact
                    events={recentEvents}
                    onOpenFile={(path) => {
                      setFileTarget(path);
                      setTab('files');
                    }}
                  />
                </details>
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
          <SessionTodos state={state} command={command} />
          {state.inputs.length > 0 ? (
            <div className="input-waiting-controls">
              <span>Answer the form to continue.</span>
              <button type="button" className="button secondary" onClick={() => perform('abort')}>
                <Square size={13} />
                Stop run
              </button>
            </div>
          ) : (
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
          )}
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
      ) : tab === 'usage' ? (
        <Suspense fallback={<p role="status">Opening conversation usage…</p>}>
          <SessionUsage
            key={state.sessionId}
            sessionId={state.sessionId}
            sessionTitle={sessionTitle}
            connected={state.connected}
            command={command}
            onBack={() => setTab('chat')}
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
      <EngineUsage state={state} refresh={() => perform('stats.get')} />
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
function EngineUsage({ state, refresh }: { state: EngineState; refresh: () => void }) {
  const stats = state.results['stats.get'];
  const usage = record(stats?.['usage']);
  const estimate = inlineUsageEstimate(stats);
  return (
    <div className="native-usage">
      <span>{state.running ? 'RUNNING' : state.connected ? 'READY' : 'CONNECTING'}</span>
      <span>
        {typeof usage['input'] === 'number'
          ? `${usage['input'].toLocaleString()} in`
          : 'Usage not reported'}
      </span>
      {typeof usage['output'] === 'number' && <span>{usage['output'].toLocaleString()} out</span>}
      {typeof estimate === 'number' && <span>Estimated ${estimate.toFixed(4)}</span>}
      <button
        type="button"
        title="Refresh engine usage"
        onClick={refresh}
        disabled={!state.connected}
      >
        <RefreshCw size={12} />
      </button>
    </div>
  );
}
