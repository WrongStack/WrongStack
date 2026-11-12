import { Plus, Square, Terminal, Workflow, X } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { ConversationReconnect } from './ConversationReconnect';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import { EngineWorkspace } from './EngineWorkspace';
import { isLive } from './model';
import { request } from './platform';
import { SandboxChip } from './SandboxChip';
import { requestSettingsSection } from './settings-section-request';
import './draft-conflict.css';

const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane })),
);

import type { DesktopController } from './useDesktop';

export function SessionWorkbench({ vm }: { vm: DesktopController }) {
  const { t } = useDesktopText();
  // Where an agent conversation puts its view tabs (Chat, Files, Changes, Tools): on the
  // session tab strip, so the conversation starts one bar lower instead of under two.
  const [viewTabsSlot, setViewTabsSlot] = useState<HTMLDivElement | null>(null);
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
    <section className="session-workbench" aria-label={t('workbench.label')}>
      <nav className="session-tabs" aria-label={t('workbench.tabs')}>
        <div className="session-tab-list">
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
                  title={t('workbench.detach', { title: s.title })}
                  aria-label={t('workbench.detach', { title: s.title })}
                  onClick={() => closeSessionTab(s.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          <button
            type="button"
            className="icon-button new-session-tab"
            aria-label={t('workbench.new')}
            onClick={() => vm.newSession(session.projectId)}
          >
            <Plus size={15} />
          </button>
        </div>
        {session.kind === 'agent' && <div className="session-view-slot" ref={setViewTabsSlot} />}
        {session.kind === 'agent' && isLive(session) && (
          <SandboxChip key={session.id} sessionId={session.id} />
        )}
        {isLive(session) && (
          <button
            type="button"
            className="session-stop"
            title={t('workbench.stopTitle')}
            onClick={() => void run(() => request('session.kill', { id: session.id }))}
          >
            <Square size={10} />
            {t('workbench.stop')}
          </button>
        )}
      </nav>
      <section className="session-workspace focused-session">
        {session.error && <div className="session-error">{session.error}</div>}
        <ConversationReconnect session={session} />
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
                  {t('workbench.draftError', { error: vm.draftErrors[session.id] })}
                </p>
                <button type="button" className="button secondary" onClick={vm.retryDraft}>
                  {t('workbench.retry')}
                </button>
              </>
            ) : (
              <p>{t('workbench.restoring')}</p>
            )}
          </div>
        ) : session.kind === 'agent' ? (
          <EngineWorkspace
            appearance={vm.appearance}
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
            viewTabsSlot={viewTabsSlot}
            onSettings={() => vm.openWrongStackSettings(session.id)}
            onOpen={(target) => {
              if ('page' in target)
                vm.openProjectPage(session.projectId, target.page, target.reportId);
              else if ('start' in target) vm.newSession(session.projectId, target.start);
              else {
                requestSettingsSection(target.settings);
                vm.openWrongStackSettings(session.id);
              }
            }}
          />
        ) : (
          <Suspense
            fallback={<div className="runtime-state">{t('workbench.openingTerminal')}</div>}
          >
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
  const { t } = useDesktopText();
  const [confirm, setConfirm] = useState<'local' | 'saved' | null>(null);
  const none = t('draftConflict.none');
  return (
    <div className="draft-conflict" role="alert">
      <strong>{t('draftConflict.title')}</strong>
      <p>{t('draftConflict.body')}</p>
      <CopyButton text={text} label={t('draftConflict.copy')} />{' '}
      <button
        type="button"
        onClick={() => {
          setConfirm(null);
          onReview();
        }}
        disabled={loading}
      >
        {loading
          ? t('draftConflict.loading')
          : saved
            ? t('draftConflict.refresh')
            : t('draftConflict.compare')}
      </button>
      {error && <p role="alert">{error}</p>}
      {saved && (
        <div className="draft-comparison">
          {[
            { title: t('draftConflict.thisWindow'), text, ...local },
            { title: t('draftConflict.saved'), ...saved },
          ].map((item) => (
            <section key={item.title}>
              <h3>{item.title}</h3>
              <pre>{item.text || t('draftConflict.noText')}</pre>
              <p>
                {t('draftConflict.details', {
                  mode: item.mode,
                  files: item.references.map((ref) => ref.path).join(', ') || none,
                  attachments:
                    item.attachments.map((attachment) => attachment.name).join(', ') || none,
                })}
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
                ? t('draftConflict.replaceSaved')
                : t('draftConflict.replaceLocal')}
            </span>{' '}
            <button type="button" onClick={() => onResolve(confirm)}>
              {confirm === 'local'
                ? t('draftConflict.confirmLocal')
                : t('draftConflict.confirmSaved')}
            </button>{' '}
            <button type="button" onClick={() => setConfirm(null)}>
              {t('draftConflict.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={() => setConfirm('local')}>
              {t('draftConflict.keepMine')}
            </button>{' '}
            <button type="button" onClick={() => setConfirm('saved')}>
              {t('draftConflict.useSaved')}
            </button>
          </>
        ))}
    </div>
  );
}
