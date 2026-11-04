import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import './project-history-search.css';

export interface HistorySearchSelection {
  id: string;
  query: string;
  role: string;
  revision: string;
  messageIndex: number;
}
type Row = Record<string, unknown>;
export function ProjectHistorySearch({
  command,
  onSelect,
}: {
  command: EngineCommand;
  onSelect: (selection: HistorySearchSelection, summary: Row) => void;
}) {
  const { t } = useDesktopText();
  const [query, setQuery] = useState(''),
    [role, setRole] = useState('');
  const [results, setResults] = useState<Row[]>([]),
    [errors, setErrors] = useState<Row[]>([]);
  // A status code, worded at render time so it follows the display language.
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [error, setError] = useState('');
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [applied, setApplied] = useState({ query: '', role: '' });
  const generation = useRef(0),
    pending = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const search = async () => {
    if (pending.current) return;
    const text = query.trim();
    if (text.length < 2) {
      setError(t('historyView.contentSearch.tooShort'));
      return;
    }
    const version = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError('');
    setResults([]);
    setErrors([]);
    setProgress({ scanned: 0, total: 0 });
    setApplied({ query: text, role });
    setStatus('reading');
    let cursor = 0,
      revision: string | undefined,
      catalogRevision: string | undefined;
    const found: Row[] = [],
      failed: Row[] = [];
    try {
      while (mounted.current && generation.current === version) {
        const reply = await command(
          'sessions.list',
          {
            contentSearch: {
              query: text,
              role,
              window: 'catalog',
              cursor,
              ...(revision ? { expectedRevision: revision } : {}),
              ...(catalogRevision ? { catalogRevision } : {}),
            },
          },
          ['sessions.list'],
          { timeoutMs: 90000 },
        );
        if (!mounted.current || generation.current !== version) return;
        const page = record(reply['contentSearch']);
        if (
          typeof page['revision'] !== 'string' ||
          typeof page['scanned'] !== 'number' ||
          typeof page['total'] !== 'number'
        )
          throw Error(t('historyView.contentSearch.unsupported'));
        revision = page['revision'];
        if (typeof page['catalogRevision'] !== 'string')
          throw Error(t('historyView.contentSearch.unpaged'));
        catalogRevision = page['catalogRevision'];
        found.push(...entries(page['results']));
        failed.push(...entries(page['errors']));
        setResults([...found]);
        setErrors([...failed]);
        setProgress({ scanned: page['scanned'], total: page['total'] });
        if (page['nextCursor'] === null) {
          setStatus(page['truncated'] === true ? 'truncated' : 'complete');
          break;
        }
        if (typeof page['nextCursor'] !== 'number' || page['nextCursor'] <= cursor)
          throw Error(t('historyView.contentSearch.badCursor'));
        cursor = page['nextCursor'];
        setStatus('searching');
      }
    } catch (error) {
      if (mounted.current && generation.current === version) {
        setError(error instanceof Error ? error.message : String(error));
        setStatus('incomplete');
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="project-history-search" aria-label={t('historyView.contentSearch.label')}>
      <form
        className="history-transcript-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          <Search size={14} />
          <input
            aria-label={t('historyView.contentSearch.field')}
            value={query}
            maxLength={500}
            disabled={busy}
            placeholder={t('historyView.contentSearch.placeholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label={t('historyView.contentSearch.roleLabel')}
          value={role}
          disabled={busy}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="">{t('historyView.contentSearch.allRoles')}</option>
          {['user', 'assistant', 'system'].map((value) => (
            <option key={value} value={value}>
              {t(`historyView.contentSearch.role.${value}`)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="button secondary"
          disabled={busy || query.trim().length < 2}
        >
          {t('historyView.contentSearch.submit')}
        </button>
        {busy && (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              generation.current++;
              setStatus('stopped');
            }}
          >
            {t('historyView.contentSearch.stop')}
          </button>
        )}
      </form>
      <p className="field-help">{t('historyView.contentSearch.help')}</p>
      {status && (
        <p role="status">
          {t('historyView.contentSearch.progress', {
            status: t(`historyView.contentSearch.status.${status}`),
            scanned: progress.scanned,
            total: progress.total,
            n: results.length,
          })}
        </p>
      )}
      {busy && (
        <progress
          aria-label={t('historyView.contentSearch.progressLabel')}
          value={progress.scanned}
          max={Math.max(1, progress.total)}
        />
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {!!errors.length && (
        <details>
          <summary>{t('historyView.contentSearch.unreadable', { n: errors.length })}</summary>
          {errors.map((item) => (
            <p className="field-help" key={String(item['id'])}>
              {String(item['id'])}: {String(item['message'])}
            </p>
          ))}
        </details>
      )}
      <div className="history-search-results">
        {results.map((result) => (
          <article key={String(result['id'])}>
            <header>
              <strong>{String(result['title'])}</strong>
              <span>
                {t('historyView.contentSearch.matching', {
                  n: String(result['matching']),
                  provider: String(result['provider']),
                  model: String(result['model']),
                })}
              </span>
            </header>
            {entries(result['hits']).map((hit) => (
              <button
                type="button"
                key={String(hit['messageIndex'])}
                aria-label={t('historyView.contentSearch.readMatch', {
                  id: String(result['id']),
                  n: Number(hit['messageIndex']) + 1,
                })}
                onClick={() =>
                  onSelect(
                    {
                      id: String(result['id']),
                      ...applied,
                      revision: String(result['revision']),
                      messageIndex: Number(hit['messageIndex']),
                    },
                    result,
                  )
                }
              >
                <small>
                  {t(`historyView.contentSearch.roleCaps.${String(hit['role'])}`, {
                    defaultValue: String(hit['role']).toUpperCase(),
                  })}{' '}
                  · {t('historyView.contentSearch.message', { n: Number(hit['messageIndex']) + 1 })}
                </small>
                <p>{String(hit['excerpt'])}</p>
                <span>{t('historyView.contentSearch.readMessage')}</span>
              </button>
            ))}
            {Number(result['matching']) > 3 && (
              <p className="field-help">{t('historyView.contentSearch.firstThree')}</p>
            )}
          </article>
        ))}
      </div>
      {status === 'complete' && !results.length && !errors.length && (
        <p className="quiet-state">{t('historyView.contentSearch.noMatches')}</p>
      )}
    </section>
  );
}
