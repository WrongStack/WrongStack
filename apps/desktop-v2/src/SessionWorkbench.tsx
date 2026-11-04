import { Plus, Square, Terminal, Workflow, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { CopyButton } from './CopyButton';
import { EngineWorkspace } from './EngineWorkspace';
import { isLive } from './model';
import { request } from './platform';
import { requestSettingsSection } from './settings-section-request';
import './draft-conflict.css';

const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane })),
);

import type { DesktopController } from './useDesktop';

export function SessionWorkbench({ vm }: { vm: DesktopController }) {
  const {
    snapshot,
    currentSession: session,
    openSessionIds,
    jumpToSession,
    closeSessionTab,
    reportError,
    run,
    getDraft,
    setDraft,
  } = vm;
  if (!session) return null;
  return (
    <section className="session-workbench" aria-label="Session workbench">
      <nav className="session-tabs" aria-label="Open sessions">
        {openSessionIds
          .map((id) => snapshot.sessions.find((s) => s.id === id))
          .filter((s) => s !== undefined)
          .map((s) => (
            <div
              className={`session-tab ${s.id === session.id ? 'active-session-tab' : ''}`}
              key={s.id}
            >
              <button
                type="button"
                className="session-tab-label"
                aria-current={s.id === session.id ? 'page' : undefined}
                onClick={() => jumpToSession(s)}
              >
                {s.kind === 'terminal' ? <Terminal size={13} /> : <Workflow size={13} />}
                <span>
                  {/* Only a session from another project names its project. */}
                  {s.projectId !== session.projectId && (
                    <small>{snapshot.projects.find((p) => p.id === s.projectId)?.name}</small>
                  )}
                  {s.title}
                </span>
              </button>
              <button
                type="button"
                className="session-tab-close"
                title={`Detach ${s.title}`}
                aria-label={`Detach ${s.title}`}
                onClick={() => closeSessionTab(s.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        <button
          type="button"
          className="icon-button new-session-tab"
          aria-label="New session in this project"
          onClick={() => vm.newSession(session.projectId)}
        >
          <Plus size={15} />
        </button>
        {isLive(session) && (
          <button
            type="button"
            className="session-stop"
            title="Stop this session"
            onClick={() => void run(() => request('session.kill', { id: session.id }))}
          >
            <Square size={10} />
            Stop session
          </button>
        )}
      </nav>
      <section className="session-workspace focused-session">
        {session.error && <div className="session-error">{session.error}</div>}
        {session.kind === 'agent' &&
          vm.draftConflicts[session.id] &&
          !vm.draftRecovering[session.id] && (
            <DraftConflictNotice
              key={`draft-conflict:${session.id}`}
              text={getDraft(session.id)}
              local={{
                references: vm.composerReferences[session.id] ?? [],
                attachments: vm.composerAttachments[session.id] ?? [],
                mode: vm.draftModes[session.id] ?? 'btw',
              }}
              saved={vm.draftReviews[session.id]}
              error={vm.draftReviewErrors[session.id] ?? ''}
              loading={vm.draftReviewLoading[session.id] === true}
              onReview={() => void vm.prepareDraftReview(session.id)}
              onResolve={(choice) => void vm.resolveDraftConflict(session.id, choice)}
            />
          )}
        {session.kind === 'agent' &&
        (!Object.hasOwn(vm.drafts, session.id) || vm.draftRecovering[session.id]) ? (
          <div className="runtime-state">
            {vm.draftErrors[session.id] ? (
              <>
                <p role="alert">
                  Could not restore this session draft: {vm.draftErrors[session.id]}
                </p>
                <button type="button" className="button secondary" onClick={vm.retryDraft}>
                  Retry
                </button>
              </>
            ) : (
              <p>Restoring session draft…</p>
            )}
          </div>
        ) : session.kind === 'agent' ? (
          <EngineWorkspace
            key={session.id}
            id={session.id}
            sessionTitle={session.title}
            scopeKey={session.workdir}
            projectId={session.projectId}
            projectRoot={
              vm.snapshot.projects.find((project) => project.id === session.projectId)?.root ??
              session.workdir
            }
            draft={getDraft(session.id)}
            mode={vm.draftModes[session.id] ?? 'btw'}
            draftConflict={vm.draftConflicts[session.id] === true}
            validateDraft={() => vm.validateDraft(session.id)}
            onModeChange={(mode) => vm.setDraftMode(session.id, mode)}
            onDraftChange={(text) => setDraft(session.id, text)}
            references={vm.composerReferences[session.id] ?? []}
            attachments={vm.composerAttachments[session.id] ?? []}
            onAttachmentsChange={(items) => vm.setAttachments(session.id, items)}
            onReferencesChange={(refs) => vm.setComposerRefs(session.id, refs)}
            onError={reportError}
            inputDrafts={vm.inputDrafts}
            onInputDraftChange={vm.setInputDraft}
            onSettings={() => vm.openWrongStackSettings(session.id)}
            onOpen={(target) => {
              if ('page' in target) vm.openProjectPage(session.projectId, target.page);
              else if ('start' in target) vm.newSession(session.projectId, target.start);
              else {
                requestSettingsSection(target.settings);
                vm.openWrongStackSettings(session.id);
              }
            }}
          />
        ) : (
          <Suspense fallback={<div className="runtime-state">Opening terminal…</div>}>
            <TerminalPane
              key={session.id}
              id={session.id}
              writable={isLive(session)}
              onError={reportError}
            />
          </Suspense>
        )}
      </section>
    </section>
  );
}

function DraftConflictNotice({
  text,
  local,
  saved,
  error,
  loading,
  onReview,
  onResolve,
}: {
  text: string;
  local: { references: { path: string }[]; attachments: { name: string }[]; mode: string };
  saved:
    | {
        text: string;
        references: { path: string }[];
        attachments: { name: string }[];
        mode: string;
      }
    | undefined;
  error: string;
  loading: boolean;
  onReview: () => void;
  onResolve: (choice: 'local' | 'saved') => void;
}) {
  const [confirm, setConfirm] = useState<'local' | 'saved' | null>(null);
  return (
    <div className="draft-conflict" role="alert">
      <strong>This draft changed in another window.</strong>
      <p>
        Your local edits are still visible here but are not saved. Sending is paused to avoid mixing
        versions.
      </p>
      <CopyButton text={text} label="Copy my local draft" />{' '}
      <button
        type="button"
        onClick={() => {
          setConfirm(null);
          onReview();
        }}
        disabled={loading}
      >
        {loading ? 'Loading…' : saved ? 'Refresh saved version' : 'Compare versions'}
      </button>
      {error && <p role="alert">{error}</p>}
      {saved && (
        <div className="draft-comparison">
          {[
            { title: 'This window', text, ...local },
            { title: 'Saved version', ...saved },
          ].map((item) => (
            <section key={item.title}>
              <h3>{item.title}</h3>
              <pre>{item.text || '(No text)'}</pre>
              <p>
                Delivery: {item.mode} · Files:{' '}
                {item.references.map((ref) => ref.path).join(', ') || 'None'} · Attachments:{' '}
                {item.attachments.map((attachment) => attachment.name).join(', ') || 'None'}
              </p>
            </section>
          ))}
        </div>
      )}
      {saved &&
        (confirm ? (
          <>
            <span>
              {confirm === 'local'
                ? 'This replaces the saved draft with this window’s version.'
                : 'This replaces this window’s draft with the saved version.'}
            </span>{' '}
            <button type="button" onClick={() => onResolve(confirm)}>
              {confirm === 'local' ? 'Confirm use my version' : 'Confirm use saved version'}
            </button>{' '}
            <button type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirm('local')}>
              Keep my version
            </button>{' '}
            <button type="button" onClick={() => setConfirm('saved')}>
              Use saved version
            </button>
          </>
        ))}
    </div>
  );
}
