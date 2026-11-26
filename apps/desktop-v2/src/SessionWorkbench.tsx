import { PanelBottom, Plus, Square } from 'lucide-react';
import { type KeyboardEvent, lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { ConversationReconnect } from './ConversationReconnect';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import { EngineWorkspace } from './EngineWorkspace';
import { isLive, sessionTitle } from './model';
import { request } from './platform';
import { SandboxChip } from './SandboxChip';
import { SessionTab } from './SessionTab';
import { nextSessionAfterDetach } from './session-layout';
import { nextRovingIndex } from './session-tab-navigation';
import { requestSettingsSection } from './settings-section-request';
import type { TerminalTabPlacement } from './WorkbenchTerminals';
import './draft-conflict.css';

const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane })),
);

import type { DesktopController } from './useDesktop';

export function SessionWorkbench({
  vm,
  terminal,
}: {
  vm: DesktopController;
  terminal?: TerminalTabPlacement | undefined;
}) {
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
  const stripId = useId();
  const panelId = `${stripId}-panel`;
  const tabListRef = useRef<HTMLDivElement>(null);
  // Roving keyboard focus for the strip (editor-style: arrows move focus, Enter opens).
  // Falls back to the active session so Tab lands on the visible tab when focus was
  // never moved here or its session closed from another surface.
  const [rovingId, setRovingId] = useState<string | null>(null);
  // One pending strip-initiated close: after the list re-renders, focus moves to the
  // tab taking the closed tab's place (or the new-session button when none remain).
  const [closeFocus, setCloseFocus] = useState<{
    closedId: string;
    order: string[];
  } | null>(null);
  // Consume one pending close-focus after the tab list re-rendered without that tab.
  // The tab taking the closed tab's place wins the focus — the app activates the same
  // neighbour through nextSessionAfterDetach. When the last open tab closes, the
  // workbench unmounts back to the fleet view: the list ref is gone, the effect no-ops,
  // and focus rests wherever the browser puts it after the removal.
  useEffect(() => {
    if (!closeFocus) return;
    setCloseFocus(null);
    const list = tabListRef.current;
    if (!list) return;
    const next = nextSessionAfterDetach(closeFocus.order, closeFocus.closedId, closeFocus.closedId);
    if (next) {
      setRovingId(next);
      focusTabLabel(list, next);
      return;
    }
    list.querySelector<HTMLElement>('.new-session-tab')?.focus();
  }, [closeFocus]);
  if (!session) return null;
  const openTabs = openSessionIds
    .map((id) => snapshot.sessions.find((s) => s.id === id))
    .filter((s) => s !== undefined);
  const roving = rovingId && openTabs.some((s) => s.id === rovingId) ? rovingId : session.id;
  const closeTab = (id: string) => {
    // Move DOM focus only when the close started inside the strip: a detach from the
    // sidebar or another surface must never steal focus from wherever the user works.
    const list = tabListRef.current;
    if (list?.contains(document.activeElement))
      setCloseFocus({ closedId: id, order: [...openSessionIds] });
    closeSessionTab(id);
  };
  const onTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = tabListRef.current;
    if (!list) return;
    // The rename input owns its keys (caret movement, Enter, Escape).
    if (event.target instanceof Element && event.target.closest('.session-tab-editing')) return;
    // Modified combos stay with the window shortcut handler (Alt+digit tab switching,
    // Ctrl/Meta+K palette, Ctrl/Meta+N session); only unmodified keys drive the strip.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const roots = Array.from(list.querySelectorAll<Element>('[data-session-id]'));
    const activeRoot = document.activeElement?.closest('[data-session-id]');
    if (!activeRoot) return;
    const index = roots.indexOf(activeRoot);
    if (index === -1) return;
    const id = openTabs[index]?.id;
    if (!id) return;
    if (event.key === 'Delete') {
      event.preventDefault();
      closeTab(id);
      return;
    }
    const next = nextRovingIndex(event.key, index, openTabs.length);
    const target = next === -1 ? undefined : openTabs[next];
    if (target === undefined) return;
    event.preventDefault();
    setRovingId(target.id);
    focusTabLabel(list, target.id);
  };
  return (
    <section className="session-workbench" aria-label={t('workbench.label')}>
      <nav className="session-tabs" aria-label={t('workbench.tabs')}>
        <div
          className="session-tab-list"
          role="tablist"
          aria-orientation="horizontal"
          aria-label={t('workbench.tabs')}
          ref={tabListRef}
          onKeyDown={onTabListKeyDown}
        >
          {openTabs.map((s) => (
            <SessionTab
              key={s.id}
              session={s}
              active={s.id === session.id}
              focusable={s.id === roving}
              tabId={`${stripId}-tab-${s.id}`}
              panelId={panelId}
              // Only a session from another project names its project.
              projectName={
                s.projectId !== session.projectId
                  ? snapshot.projects.find((p) => p.id === s.projectId)?.name
                  : undefined
              }
              onOpen={() => {
                setRovingId(s.id);
                jumpToSession(s);
              }}
              onClose={() => closeTab(s.id)}
              onRename={(title) => void run(() => request('session.rename', { id: s.id, title }))}
            />
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
        {session.kind === 'terminal' && terminal?.dock && (
          <button
            type="button"
            className="icon-button"
            aria-label="Dock terminal"
            title="Dock terminal"
            ref={terminal.dockButtonRef}
            onClick={terminal.dock}
          >
            <PanelBottom size={16} aria-hidden="true" />
          </button>
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
      <section
        className="session-workspace focused-session"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${stripId}-tab-${session.id}`}
      >
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
            sessionStatus={session.status}
            sessionTitle={sessionTitle(session, t('workbench.untitled'))}
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
        ) : terminal ? (
          terminal.docked ? (
            <div className="terminal-docked-note">
              <button
                type="button"
                className="button secondary small"
                onClick={() => vm.openProjectPage(session.projectId, 'files')}
              >
                {t('pages.files')}
              </button>
            </div>
          ) : (
            <div className="terminal-tab-slot" ref={terminal.setSlot} />
          )
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

/** Attribute selector for one session tab root; ids are engine-generated, escape quotes anyway. */
function tabSelector(id: string, suffix: string) {
  return `[data-session-id="${id.replace(/[\\"]/g, '\\$&')}"]${suffix}`;
}

function focusTabLabel(list: HTMLElement, id: string) {
  list.querySelector<HTMLElement>(tabSelector(id, ' .session-tab-label'))?.focus();
}
