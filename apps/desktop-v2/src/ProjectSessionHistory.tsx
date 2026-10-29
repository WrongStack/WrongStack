import { ArrowRight, Copy, History, Pencil, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
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
}: {
  projectId: string;
  carrierId: string;
  command: EngineCommand;
  sessions: Session[];
  onOpen: (session: Session) => void;
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string) => void;
}) {
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
        throw Error('The runtime returned an invalid history identity.');
      if (anchorId && !history.some((row) => row['id'] === anchorId))
        throw Error('The runtime did not return the selected recorded conversation.');
      return {
        history,
        page: readHistoryPage(
          reply['catalogPage'],
          anchorId ? null : offset,
          limit,
          history.length,
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
            setNotice(
              'The remembered conversation is no longer in this catalog. Showing the first page.',
            );
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
    void load(0, undefined, saved.selectedId || saved.anchorId || undefined, true);
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
        historyTitle(row, links[String(row['id'])]),
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
        title: Array.from(`${restore.mode === 'fork' ? 'Fork: ' : ''}${restore.title}`)
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
        throw Error('This session name changed elsewhere. Cancel and refresh before renaming.');
      await command('session.rename', { id: reviewed['id'], name: name.trim() }, [
        'key.operation_result',
      ]);
      let after = await requestPage();
      if (page.offset > 0) after = await requestPage(page.offset, after.page.revision);
      const saved = after.history.find((item) => item['id'] === reviewed['id']);
      if (!saved || String(saved['name'] ?? '') !== name.trim())
        throw Error('The saved session name could not be verified. Refresh before retrying.');
      if (!mounted.current) return;
      setRename(null);
      setNotice('Recorded session name saved and verified.');
      await load(after.page.offset, after.page.revision);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setSaving(false);
    }
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
    <section className="project-history" aria-label="Project session history">
      <header className="history-heading">
        <div>
          <span className="eyebrow">PROJECT CONVERSATION LIBRARY</span>
          <h1>
            Session history<span className="heading-dot">.</span>
          </h1>
          <p>
            Find earlier work, read the recorded conversation and return to an open desktop session.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          Refresh session history
        </button>
      </header>
      <ProjectUsageSummary command={command} />
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
      {!viewState.ready && <p role="status">Restoring project history view…</p>}
      {viewState.error && (
        <div className="session-error" role="alert">
          {viewState.error}{' '}
          <button
            type="button"
            className="button secondary"
            disabled={viewState.saving}
            onClick={() => {
              void viewStore.retry();
            }}
          >
            Retry history view storage
          </button>
        </div>
      )}
      <p className="field-help">
        Summary filters, page size and the last viewed page are remembered for this project.
      </p>
      <div className="history-filters">
        <label>
          <Search size={14} />
          <input
            aria-label="Search project session summaries"
            value={query}
            maxLength={500}
            disabled={!viewState.ready}
            onChange={(event) => viewStore.change({ query: event.target.value })}
            placeholder="Find a title, model or last prompt…"
          />
        </label>
        <select
          aria-label="History provider"
          value={provider}
          disabled={!viewState.ready}
          onChange={(event) => viewStore.change({ provider: event.target.value })}
        >
          <option value="">All providers</option>
          {[...new Set([provider, ...rows.map((item) => String(item['provider'] ?? ''))])]
            .filter(Boolean)
            .sort()
            .map((provider) => (
              <option key={provider} value={provider}>
                {provider}
                {rows.some((row) => row['provider'] === provider) ? '' : ' (not on this page)'}
              </option>
            ))}
        </select>
        <select
          aria-label="History outcome"
          value={outcome}
          disabled={!viewState.ready}
          onChange={(event) => viewStore.change({ outcome: event.target.value })}
        >
          <option value="">All outcomes</option>
          <option value="open">Open in desktop</option>
          <option value="completed">Completed</option>
          <option value="error">Error recorded</option>
          <option value="aborted">Interrupted</option>
        </select>
        <select
          aria-label="History page size"
          value={limit}
          disabled={!viewState.ready || busy || saving}
          onChange={(event) => viewStore.change({ pageSize: Number(event.target.value) })}
        >
          {[50, 100, 200].map((value) => (
            <option key={value} value={value}>
              {value} per page
            </option>
          ))}
        </select>
      </div>
      <div className="history-catalog-status">
        <span>
          {visible.length} matching summaries on this page · {rows.length ? page.offset + 1 : 0}–
          {page.offset + rows.length} of {page.total} records. Summary filters apply to this page.
        </span>
        <label>
          <input
            type="checkbox"
            checked={includeEmpty}
            disabled={!viewState.ready}
            onChange={(event) => viewStore.change({ includeEmpty: event.target.checked })}
          />
          Include empty journals
        </label>
      </div>
      {busy && <p role="status">Reading project session history…</p>}
      <nav className="history-page-controls" aria-label="History catalog pages">
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving || !page.offset}
          onClick={() => void load(Math.max(0, page.offset - limit), page.revision)}
        >
          Previous history page
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={!viewState.ready || busy || saving || page.nextOffset === null}
          onClick={() => {
            if (page.nextOffset !== null) void load(page.nextOffset, page.revision);
          }}
        >
          Next history page
        </button>
        {page.truncated && (
          <p>
            Legacy scan limit reached. More records may exist; use the current project catalog
            service for deeper history.
          </p>
        )}
      </nav>
      <details className="history-search-disclosure">
        <summary>
          <Search size={14} />
          Search across conversations
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
        <nav className="history-catalog" aria-label="Recorded project sessions">
          {visible.map((item) => {
            const id = String(item['id']),
              live = links[id];
            return (
              <button
                type="button"
                key={id}
                aria-label={`Open history ${id}`}
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
                  <strong>{historyTitle(item, live)}</strong>
                </span>
                <small>{recoveryDate(item['lastActivityAt'] || item['startedAt'])}</small>
                <span>
                  {String(item['provider'])} / {String(item['model'])}
                </span>
                <p>{String(item['lastUserMessage'] || 'No prompt preview recorded.')}</p>
                <span className="history-row-status">
                  {live
                    ? 'Open in desktop'
                    : item['outcome']
                      ? String(item['outcome'])
                      : 'Recorded'}
                </span>
              </button>
            );
          })}
          {viewState.ready && !busy && !visible.length && (
            <p className="quiet-state">No recorded sessions match this view.</p>
          )}
        </nav>
        <div className="history-reader">
          {row ? (
            <>
              <header className="history-selection">
                <span className="eyebrow">RECORDED CONVERSATION</span>
                <h2>{historyTitle(row, owner)}</h2>
                <p>
                  {String(row['provider'])} / {String(row['model'])} · Started{' '}
                  {recoveryDate(row['startedAt'])}
                </p>
                <div>
                  <CopyButton text={selected} label="Copy recorded session ID" />
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || saving}
                    onClick={() => {
                      setName(String(row['name'] ?? ''));
                      setRename(row);
                      setError('');
                    }}
                  >
                    <Pencil size={13} />
                    Rename recorded session
                  </button>
                  {owner && (
                    <button
                      type="button"
                      className="button primary small"
                      onClick={() => onOpen(owner)}
                    >
                      Open desktop conversation
                      <ArrowRight size={13} />
                    </button>
                  )}
                  {!owner && (
                    <button
                      type="button"
                      className="button primary small"
                      onClick={() => {
                        setError('');
                        setRestore({ id: selected, title: historyTitle(row), mode: 'resume' });
                      }}
                    >
                      Resume recorded conversation
                    </button>
                  )}
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      setError('');
                      setRestore({ id: selected, title: historyTitle(row, owner), mode: 'fork' });
                    }}
                  >
                    Continue a copy
                  </button>
                </div>
                <p className="field-help">
                  {owner
                    ? 'Return to the open desktop conversation without starting another session.'
                    : 'Read-only history. Reading does not resume or run the agent.'}{' '}
                  File links open the current project file.
                </p>
              </header>
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
              <h2>Return to the work.</h2>
              <p>
                Select a recorded conversation to read it. Project history is available before
                opening a new session.
              </p>
              <button type="button" className="button secondary" onClick={onNewSession}>
                New conversation
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
            <h2 id="dialog-title">Name this recorded conversation</h2>
            <p>
              This changes the engine’s recorded name. The desktop session tab keeps its own title.
            </p>
            <label className="modal-field">
              Recorded session name
              <input
                aria-label="Recorded session name"
                maxLength={200}
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="field-help">Leave empty to use the automatically recorded title.</p>
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
                Keep recorded name
              </button>
              <button type="submit" className="button primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save recorded name'}
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
          <h2 id="dialog-title">Reuse this recorded text</h2>
          <p>
            The visible text will be appended to the chosen conversation’s existing draft. Review it
            before sending.
          </p>
          <pre className="history-reuse-preview">{reuse}</pre>
          <label className="modal-field">
            Destination conversation
            <select
              aria-label="History draft destination"
              value={target}
              disabled={saving}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">Choose an open conversation</option>
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
              Keep reading
            </button>
            <button
              type="button"
              className="button primary"
              disabled={saving || !target}
              onClick={() => void prepare()}
            >
              <Copy size={13} />
              {saving ? 'Preparing…' : 'Append recorded text to draft'}
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
            {restore.mode === 'fork' ? 'Continue a separate copy' : 'Resume this conversation'}
          </h2>
          <p>
            <strong>{restore.title}</strong>
          </p>
          <p>
            {restore.mode === 'fork'
              ? 'Create a new conversation with the recorded history. The original journal stays unchanged.'
              : 'Reopen the original journal in a new desktop tab. Another process holding this conversation must release it first.'}
          </p>
          <p className="field-help">
            Both use the project’s current files. Historical files are not restored. No prompt is
            sent automatically.
          </p>
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
              Keep reading
            </button>
            <button
              type="button"
              className="button primary"
              disabled={saving}
              onClick={() => void restoreSession()}
            >
              {saving
                ? 'Opening conversation…'
                : restore.mode === 'fork'
                  ? 'Open separate copy'
                  : 'Open original conversation'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
