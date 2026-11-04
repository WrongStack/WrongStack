import { Copy, History, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { HistoryEmptyCleanup, HistorySelection } from './HistorySelection';
import { type HistoryCatalogPage, readHistoryPage } from './history-page-model';
import { Modal } from './Modal';
import { markdownTarget } from './markdown-target';
import { isLive, type Session } from './model';
import { type HistorySearchSelection, ProjectHistorySearch } from './ProjectHistorySearch';
import { ProjectUsageSummary } from './ProjectUsageSummary';
import { openExternal, request } from './platform';
import {
  historyHasContent,
  historyMatches,
  historyTitle,
  openHistoryLinks,
} from './project-history-model';
import { SessionTranscript } from './SessionTranscript';
import { recoveryDate } from './session-recovery-model';
import { useHistoryView } from './useHistoryView';
import './project-session-history.css';

type Row = Record<string, unknown>;
export function ProjectSessionHistory({
  projectId,
  carrierId,
  command,
  sessions,
  onOpen,
  onPrepare,
  onNewSession,
  onOpenFile,
  focusSessionId = '',
}: {
  projectId: string;
  carrierId: string;
  command: EngineCommand;
  sessions: Session[];
  onOpen: (session: Session) => void;
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string) => void;
  /** A core session to select when the page opens, e.g. from a Chronicle event. */
  focusSessionId?: string | undefined;
}) {
  const { t } = useDesktopText();
  // Read through a ref so a language change does not reload the catalog.
  const words = useRef(t);
  words.current = t;
  const untitled = t('historyView.untitled');
  const [rows, setRows] = useState<Row[]>([]);
  const { state: viewState, controller: viewStore } = useHistoryView(projectId);
  const {
    selectedId: selected,
    pageSize: limit,
    query,
    provider,
    outcome,
    includeEmpty,
  } = viewState.value;
  const [searchSummary, setSearchSummary] = useState<Row | null>(null);
  const [searchSelection, setSearchSelection] = useState<HistorySearchSelection | undefined>();
  const [readerVersion, setReaderVersion] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [page, setPage] = useState<HistoryCatalogPage>({
    offset: 0,
    limit: 100,
    total: 0,
    nextOffset: null,
    revision: '',
    truncated: false,
  });
  const [links, setLinks] = useState<Record<string, Session>>({});
  const [rename, setRename] = useState<Row | null>(null),
    [name, setName] = useState(''),
    [saving, setSaving] = useState(false);
  const [reuse, setReuse] = useState(''),
    [target, setTarget] = useState('');
  const [notice, setNotice] = useState(''),
    [reloadLinks, setReloadLinks] = useState(0);
  const [restore, setRestore] = useState<{
    id: string;
    title: string;
    mode: 'resume' | 'fork';
  } | null>(null);
  const generation = useRef(0),
    mounted = useRef(true),
    mutation = useRef(false);
  const ownerKey = sessions
    .map((session) => `${session.id}:${session.status}:${session.kind}`)
    .join('|');
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const requestPage = useCallback(
    async (offset = 0, expectedRevision?: string, anchorId?: string) => {
      const reply = await command(
        'sessions.list',
        {
          catalogPage: {
            limit,
            offset,
            ...(expectedRevision ? { expectedRevision } : {}),
            ...(anchorId ? { anchorId } : {}),
          },
          includeContentState: true,
        },
        ['sessions.list'],
        { timeoutMs: 60000 },
      );
      const history = entries(reply['sessions']);
      if (history.some((row) => typeof row['id'] !== 'string' || row['id'] === carrierId))
        throw Error(words.current('historyView.invalidIdentity'));
      if (anchorId && !history.some((row) => row['id'] === anchorId))
        throw Error(words.current('historyView.missingSelected'));
      return {
        history,
        page: readHistoryPage(
          reply['catalogPage'],
          anchorId ? null : offset,
          limit,
          history.length,
          {
            different: words.current('historyView.pageDifferent'),
            invalid: words.current('historyView.pageInvalid'),
          },
        ),
      };
    },
    [command, carrierId, limit],
  );
  const load = useCallback(
    async (offset = 0, expectedRevision?: string, anchorId?: string, restoring = false) => {
      const version = ++generation.current;
      setBusy(true);
      setError('');
      try {
        let result;
        try {
          result = await requestPage(offset, expectedRevision, anchorId);
        } catch (error) {
          if (
            !restoring ||
            !anchorId ||
            !String(error).includes('no longer in this project catalog')
          )
            throw error;
          result = await requestPage();
          if (mounted.current && generation.current === version)
            setNotice(words.current('historyView.rememberedGone'));
        }
        if (!mounted.current || generation.current !== version) return;
        const history = result.history;
        setRows(history);
        setPage(result.page);
        const previous = viewStore.snapshot().value.selectedId;
        viewStore.change({
          selectedId: history.some((row) => row['id'] === previous) ? previous : '',
          anchorId: String(history[0]?.['id'] ?? ''),
        });
        setReloadLinks((value) => value + 1);
      } catch (error) {
        if (mounted.current && generation.current === version)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted.current && generation.current === version) setBusy(false);
      }
    },
    [requestPage, viewStore],
  );
  useEffect(() => {
    if (!viewState.ready) return;
    const saved = viewStore.snapshot().value;
    if (focusSessionId)
      viewStore.change({ selectedId: focusSessionId, anchorId: focusSessionId, query: '' });
    void load(
      0,
      undefined,
      focusSessionId || saved.selectedId || saved.anchorId || undefined,
      true,
    );
  }, [load, viewState.ready, viewStore]);
  useEffect(() => {
    let active = true;
    void openHistoryLinks(projectId, sessionsRef.current, (id) =>
      request('engine.identity', { id }),
    ).then((result) => {
      if (active) setLinks(result);
    });
    return () => {
      active = false;
    };
  }, [projectId, ownerKey, reloadLinks]);
  const visible = rows.filter(
    (row) =>
      (includeEmpty || links[String(row['id'])] || historyHasContent(row)) &&
      historyMatches(
        row,
        query,
        provider,
        outcome,
        !!links[String(row['id'])],
        historyTitle(row, links[String(row['id'])], untitled),
      ),
  );
  const row =
      rows.find((item) => item['id'] === selected) ??
      (searchSummary?.['id'] === selected ? searchSummary : undefined),
    owner = links[selected];
  const restoreSession = async () => {
    if (!restore || mutation.current) return;
    mutation.current = true;
    setSaving(true);
    setError('');
    try {
      const opened = await request<Session>('session.restore', {
        projectId,
        history: { id: restore.id, mode: restore.mode },
        title: Array.from(
          restore.mode === 'fork'
            ? t('historyView.forkTitle', { title: restore.title })
            : restore.title,
        )
          .slice(0, 48)
          .join(''),
      });
      if (!mounted.current) return;
      setRestore(null);
      onOpen(opened);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const renameSession = async () => {
    if (!rename || mutation.current) return;
    const reviewed = rename;
    mutation.current = true;
    setSaving(true);
    setError('');
    try {
      const before = await requestPage(page.offset, page.revision);
      const current = before.history.find((item) => item['id'] === reviewed['id']);
      if (!current || String(current['name'] ?? '') !== String(reviewed['name'] ?? ''))
        throw Error(t('historyView.nameChanged'));
      await command('session.rename', { id: reviewed['id'], name: name.trim() }, [
        'key.operation_result',
      ]);
      let after = await requestPage();
      if (page.offset > 0) after = await requestPage(page.offset, after.page.revision);
      const saved = after.history.find((item) => item['id'] === reviewed['id']);
      if (!saved || String(saved['name'] ?? '') !== name.trim())
        throw Error(t('historyView.nameUnverified'));
      if (!mounted.current) return;
      setRename(null);
      setNotice(t('historyView.nameSaved'));
      await load(after.page.offset, after.page.revision);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  // Deletes recorded sessions one by one (the engine refuses one a client still shows or runs),
  // then reads the page again so what was removed, and what was refused, is visible.
  const deleteRecorded = async (ids: string[]) => {
    if (mutation.current || !ids.length) return;
    mutation.current = true;
    setSaving(true);
    setError('');
    let deleted = 0;
    try {
      for (const id of ids) {
        await command('session.delete', { id }, ['key.operation_result']);
        deleted++;
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
    if (!mounted.current || !deleted) return;
    setNotice(
      t(deleted === 1 ? 'historyView.deletedOne' : 'historyView.deletedMany', { n: deleted }),
    );
    await load(page.offset);
  };
  const prepare = async () => {
    if (!target || mutation.current) return;
    mutation.current = true;
    setSaving(true);
    setError('');
    try {
      await onPrepare(target, reuse);
      if (mounted.current) setReuse('');
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const link = (href: string) => {
    const target = markdownTarget(href);
    if (target?.kind === 'file') onOpenFile(target.value);
    if (target?.kind === 'external')
      void openExternal(target.value).catch((error) => setError(String(error)));
  };
  return (
    <section className="project-history" aria-label={t('historyView.label')}>
      <header className="history-heading">
        <div>
          <h1>{t('historyView.title')}</h1>
          <p>{t('historyView.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          {t('historyView.refresh')}
        </button>
      </header>
      <ProjectUsageSummary
        command={command}
        onOpenSession={(id) => viewStore.change({ selectedId: id })}
      />
      {error && !rename && !reuse && !restore && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="studio-notice">
          {notice}
        </p>
      )}
      {!viewState.ready && <p role="status">{t('historyView.restoringView')}</p>}
      {viewState.error && (
        <div className="session-error" role="alert">
          {t(`historyView.viewError.${viewState.errorKind || 'restore'}`, {
            defaultValue: viewState.error,
          })}{' '}
          <button
            type="button"
            className="button secondary"
            disabled={viewState.saving}
            onClick={() => {
              void viewStore.retry();
            }}
          >
            {t('historyView.retryView')}
          </button>
        </div>
      )}
      <p className="field-help">{t('historyView.remembered')}</p>
      <div className="history-filters">
        <label>
          <Search size={14} />
          <input
            aria-label={t('historyView.search')}
            value={query}
            maxLength={500}
            disabled={!viewState.ready}
            onChange={(event) => viewStore.change({ query: event.target.value })}
            placeholder={t('historyView.searchPlaceholder')}
          />
        </label>
        <select
          aria-label={t('historyView.provider')}
          value={provider}
          disabled={!viewState.ready}
          onChange={(event) => viewStore.change({ provider: event.target.value })}
        >
          <option value="">{t('historyView.allProviders')}</option>
          {[...new Set([provider, ...rows.map((item) => String(item['provider'] ?? ''))])]
            .filter(Boolean)
            .sort()
            .map((provider) => (
              <option key={provider} value={provider}>
                {provider}
                {rows.some((row) => row['provider'] === provider)
                  ? ''
                  : ` (${t('historyView.notOnPage')})`}
              </option>
            ))}
        </select>
        <select
          aria-label={t('historyView.outcome')}
          value={outcome}
          disabled={!viewState.ready}
          onChange={(event) => viewStore.change({ outcome: event.target.value })}
        >
          <option value="">{t('historyView.allOutcomes')}</option>
          {['open', 'completed', 'error', 'aborted'].map((value) => (
            <option key={value} value={value}>
              {t(`historyView.outcomeOption.${value}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('historyView.pageSize')}
          value={limit}
          disabled={!viewState.ready || busy || saving}
          onChange={(event) => viewStore.change({ pageSize: Number(event.target.value) })}
        >
          {[50, 100, 200].map((value) => (
            <option key={value} value={value}>
              {t('historyView.perPage', { n: value })}
            </option>
          ))}
        </select>
      </div>
      <div className="history-catalog-status">
        <span>
          {t('historyView.catalogStatus', {
            matching: visible.length,
            from: rows.length ? page.offset + 1 : 0,
            to: page.offset + rows.length,
            total: page.total,
          })}
        </span>
        <label>
          <input
            type="checkbox"
            checked={includeEmpty}
            disabled={!viewState.ready}
            onChange={(event) => viewStore.change({ includeEmpty: event.target.checked })}
          />
          {t('historyView.includeEmpty')}
        </label>
        <HistoryEmptyCleanup
          ids={rows
            .filter((item) => !links[String(item['id'])] && !historyHasContent(item))
            .map((item) => String(item['id']))}
          saving={saving}
          onDelete={deleteRecorded}
        />
      </div>
      {busy && <p role="status">{t('historyView.reading')}</p>}
      <nav className="history-page-controls" aria-label={t('historyView.pages')}>
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving || !page.offset}
          onClick={() => void load(Math.max(0, page.offset - limit), page.revision)}
        >
          {t('historyView.previous')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving || page.nextOffset === null}
          onClick={() => {
            if (page.nextOffset !== null) void load(page.nextOffset, page.revision);
          }}
        >
          {t('historyView.next')}
        </button>
        {page.truncated && <p>{t('historyView.truncated')}</p>}
      </nav>
      <details className="history-search-disclosure">
        <summary>
          <Search size={14} />
          {t('historyView.searchAcross')}
        </summary>
        {viewState.ready && (
          <ProjectHistorySearch
            key={projectId}
            command={command}
            onSelect={(selection, summary) => {
              setSearchSummary(summary);
              viewStore.change({ selectedId: selection.id });
              setSearchSelection(selection);
              setReaderVersion((value) => value + 1);
              setError('');
              void load(0, undefined, selection.id);
            }}
          />
        )}
      </details>
      <div className="history-workspace">
        <nav className="history-catalog" aria-label={t('historyView.catalog')}>
          {visible.map((item) => {
            const id = String(item['id']),
              live = links[id];
            return (
              <button
                type="button"
                key={id}
                aria-label={t('historyView.openHistory', { id })}
                aria-current={id === selected ? 'page' : undefined}
                onClick={() => {
                  viewStore.change({ selectedId: id });
                  setSearchSelection(undefined);
                  setError('');
                  setNotice('');
                }}
              >
                <span className="history-row-title">
                  <History size={14} />
                  <strong>{historyTitle(item, live, untitled)}</strong>
                </span>
                <small>
                  {recoveryDate(
                    item['lastActivityAt'] || item['startedAt'],
                    t('recovery.timeMissing'),
                  )}
                </small>
                <span>
                  {String(item['provider'])} / {String(item['model'])}
                </span>
                <p>{String(item['lastUserMessage'] || t('historyView.noPrompt'))}</p>
                <span className="history-row-status">
                  {live
                    ? t('historyView.openInDesktop')
                    : item['outcome']
                      ? t(`historyView.rowOutcome.${String(item['outcome'])}`, {
                          defaultValue: String(item['outcome']),
                        })
                      : t('historyView.recorded')}
                </span>
              </button>
            );
          })}
          {viewState.ready && !busy && !visible.length && (
            <p className="quiet-state">{t('historyView.noMatches')}</p>
          )}
        </nav>
        <div className="history-reader">
          {row ? (
            <>
              <HistorySelection
                row={row}
                selected={selected}
                owner={owner}
                busy={busy}
                saving={saving}
                onRename={(item) => {
                  setName(String(item['name'] ?? ''));
                  setRename(item);
                  setError('');
                }}
                onOpen={onOpen}
                onRestore={(next) => {
                  setError('');
                  setRestore(next);
                }}
                onDelete={deleteRecorded}
              />
              <SessionTranscript
                key={`${projectId}:${selected}:${searchSelection?.revision ?? ''}:${readerVersion}`}
                id={selected}
                initialSearch={searchSelection}
                command={command}
                onLink={link}
                onReuse={(text) => {
                  setTarget('');
                  setReuse(text);
                  setError('');
                }}
              />
            </>
          ) : (
            <div className="history-empty-reader">
              <History size={30} />
              <h2>{t('historyView.emptyTitle')}</h2>
              <p>{t('historyView.emptyBody')}</p>
              <button type="button" className="button secondary" onClick={onNewSession}>
                {t('historyView.newConversation')}
              </button>
            </div>
          )}
        </div>
      </div>
      {rename && (
        <Modal
          onClose={() => {
            if (!saving) setRename(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void renameSession();
            }}
          >
            <h2 id="dialog-title">{t('historyView.renameTitle')}</h2>
            <p>{t('historyView.renameBody')}</p>
            <label className="modal-field">
              {t('historyView.renameField')}
              <input
                aria-label={t('historyView.renameField')}
                maxLength={200}
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="field-help">{t('historyView.renameHelp')}</p>
            {error && (
              <p role="alert" className="session-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                disabled={saving}
                onClick={() => setRename(null)}
              >
                {t('historyView.keepName')}
              </button>
              <button type="submit" className="button primary" disabled={saving}>
                {saving ? t('historyView.saving') : t('historyView.saveName')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {reuse && (
        <Modal
          onClose={() => {
            if (!saving) setReuse('');
          }}
        >
          <h2 id="dialog-title">{t('historyView.reuseTitle')}</h2>
          <p>{t('historyView.reuseBody')}</p>
          <pre className="history-reuse-preview">{reuse}</pre>
          <label className="modal-field">
            {t('historyView.destination')}
            <select
              aria-label={t('historyView.destinationLabel')}
              value={target}
              disabled={saving}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">{t('historyView.chooseOpen')}</option>
              {sessions
                .filter(
                  (item) => item.projectId === projectId && item.kind === 'agent' && isLive(item),
                )
                .map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
            </select>
          </label>
          {error && (
            <p role="alert" className="session-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={saving}
              onClick={() => setReuse('')}
            >
              {t('historyView.keepReading')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={saving || !target}
              onClick={() => void prepare()}
            >
              <Copy size={13} />
              {saving ? t('historyView.preparing') : t('historyView.append')}
            </button>
          </div>
        </Modal>
      )}
      {restore && (
        <Modal
          onClose={() => {
            if (!saving) setRestore(null);
          }}
        >
          <h2 id="dialog-title">
            {restore.mode === 'fork'
              ? t('historyView.forkHeading')
              : t('historyView.resumeHeading')}
          </h2>
          <p>
            <strong>{restore.title}</strong>
          </p>
          <p>{restore.mode === 'fork' ? t('historyView.forkBody') : t('historyView.resumeBody')}</p>
          <p className="field-help">{t('historyView.restoreHelp')}</p>
          {error && (
            <p role="alert" className="session-error">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="button secondary"
              disabled={saving}
              onClick={() => setRestore(null)}
            >
              {t('historyView.keepReading')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={saving}
              onClick={() => void restoreSession()}
            >
              {saving
                ? t('historyView.opening')
                : restore.mode === 'fork'
                  ? t('historyView.openCopy')
                  : t('historyView.openOriginal')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
