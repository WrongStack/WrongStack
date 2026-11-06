import { ChevronDown, Download, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime, displayLocale } from './display-dates';
import type { EngineCommand } from './engine-operations';
import { record } from './engine-values';
import { journalFileName, journalJsonl, journalMarkdown } from './journal-export';
import { type JournalCursors, mergeJournalPages } from './journal-paging';
import { MarkdownContent } from './MarkdownContent';

const PAGE = 100;

export function PromptJournal({
  command,
  sessionId,
  onInsert,
}: {
  command: EngineCommand;
  sessionId: string;
  onInsert?: ((text: string) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]),
    [scope, setScope] = useState(sessionId ? 'session' : 'project'),
    [category, setCategory] = useState(''),
    [date, setDate] = useState(''),
    [month, setMonth] = useState(''),
    [cursors, setCursors] = useState<JournalCursors>({}),
    [notice, setNotice] = useState(''),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [enabled, setEnabled] = useState(true),
    [error, setError] = useState('');
  const generation = useRef(0);
  const truncated = Object.keys(cursors).length > 0;
  /** One page per category; `until` maps a category to its inclusive older bound. */
  const read = useCallback(
    (kinds: string[], until: JournalCursors = {}) =>
      Promise.all(
        kinds.map(async (kind) => ({
          kind,
          result: await command(
            'prompts.journal',
            {
              filter: {
                limit: PAGE,
                category: kind,
                ...(scope === 'session' && sessionId ? { sessionId } : {}),
                ...(date ? { date } : {}),
                ...(month ? { month } : {}),
                ...(until[kind] ? { until: until[kind] } : {}),
              },
            },
            ['prompts.journal'],
          ),
        })),
      ),
    [command, sessionId, scope, date, month],
  );
  const load = useCallback(async () => {
    const own = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const pages = await read(category ? [category] : ['raw_user', 'refined_user']);
      if (own !== generation.current) return;
      // The engine returns the newest PAGE entries per category; a full page leaves a cursor.
      const merged = mergeJournalPages(pages, new Set(), PAGE);
      setRows(merged.added);
      setCursors(merged.cursors);
      setEnabled(pages.some((page) => page.result['enabled'] !== false));
    } catch (e) {
      if (own === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === generation.current) setLoading(false);
    }
  }, [read, category]);
  /** The next older page of every category that still has one. */
  const loadOlder = async () => {
    const own = generation.current;
    const kinds = Object.keys(cursors);
    if (!kinds.length) return;
    setLoading(true);
    setError('');
    try {
      const pages = await read(kinds, cursors);
      if (own !== generation.current) return;
      const { added, cursors: next } = mergeJournalPages(
        pages,
        new Set(rows.map((row) => String(row['id']))),
        PAGE,
      );
      setRows((current) =>
        [...current, ...added].sort((a, b) =>
          String(b['timestamp']).localeCompare(String(a['timestamp'])),
        ),
      );
      setCursors(next);
      setNotice(
        added.length === 1
          ? t('promptJournal.olderOne')
          : added.length
            ? t('promptJournal.olderMany', { number: added.length })
            : t('promptJournal.noOlder'),
      );
    } catch (e) {
      if (own === generation.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const filtered = rows.filter((row) =>
    `${row['content']} ${row['rawContent'] ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const exportRows = (format: 'md' | 'jsonl') => {
    const exportedAt = new Date().toISOString();
    const filters = [
      scope === 'session' ? 'this session' : 'all project sessions',
      category === 'raw_user'
        ? 'original input'
        : category === 'refined_user'
          ? 'refined prompts'
          : 'original and refined',
      month && `month ${month}`,
      date && `date ${date}`,
      query && `search “${query}”`,
      truncated && 'older entries not loaded',
    ]
      .filter(Boolean)
      .join(' · ');
    const content =
      format === 'md'
        ? journalMarkdown(filtered, { title: 'WrongStack prompt journal', filters, exportedAt })
        : journalJsonl(filtered);
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/x-ndjson',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = journalFileName(scope, exportedAt, format);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      filtered.length === 1
        ? t('promptJournal.exportOne')
        : t('promptJournal.exportMany', { number: filtered.length }),
    );
  };
  return (
    <>
      <p>{t('promptJournal.intro')}</p>
      <div className="resource-toolbar">
        <label>
          <Search size={14} />
          <input
            aria-label={t('promptJournal.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('promptJournal.placeholder')}
          />
        </label>
        <select
          aria-label={t('promptJournal.scope')}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          {sessionId && <option value="session">{t('promptJournal.thisSession')}</option>}
          <option value="project">{t('promptJournal.allSessions')}</option>
        </select>
        <select
          aria-label={t('promptJournal.category')}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t('promptJournal.both')}</option>
          <option value="raw_user">{t('promptJournal.original')}</option>
          <option value="refined_user">{t('promptJournal.refined')}</option>
        </select>
        <label className="journal-date-filter">
          <span>{t('promptJournal.monthField')}</span>
          <input
            type="month"
            aria-label={t('promptJournal.month')}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <label className="journal-date-filter">
          <span>{t('promptJournal.dayField')}</span>
          <input
            type="date"
            aria-label={t('promptJournal.date')}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          aria-label={t('promptJournal.refresh')}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <p role="alert" className="composer-error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{t('promptJournal.reading')}</p>
      ) : !enabled || !filtered.length ? (
        <div className="resource-empty">
          <h3>{t('promptJournal.emptyTitle')}</h3>
          <p>{t('promptJournal.emptyBody')}</p>
        </div>
      ) : (
        <section className="prompt-journal-list" aria-label={t('promptJournal.list')}>
          {filtered.map((row) => {
            const meta = record(row['metadata']);
            return (
              <details key={String(row['id'])}>
                <summary>
                  <div>
                    <strong>
                      {String(row['content'])
                        .split('\n')
                        .find((line) => line.trim())
                        ?.slice(0, 160) || t('promptJournal.untitled')}
                    </strong>
                    <small>
                      {String(row['category']) === 'raw_user'
                        ? t('promptJournal.original')
                        : t('promptJournal.refined')}{' '}
                      · {displayDateTime(String(row['timestamp']))} ·{' '}
                      {String(meta['provider'] ?? '')} {String(meta['model'] ?? '')}
                    </small>
                  </div>
                  <ChevronDown size={15} />
                </summary>
                <div className="journal-entry-body">
                  <small>{t('promptJournal.session', { id: String(row['sessionId']) })}</small>
                  {typeof row['rawContent'] === 'string' && (
                    <section>
                      <h4>{t('promptJournal.originalText')}</h4>
                      <MarkdownContent text={row['rawContent']} />
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!onInsert}
                        onClick={() => onInsert?.(String(row['rawContent']))}
                      >
                        {t('promptJournal.reuseOriginal')}
                      </button>
                    </section>
                  )}
                  <section>
                    <h4>
                      {row['category'] === 'raw_user'
                        ? t('promptJournal.submittedText')
                        : t('promptJournal.refinedText')}
                    </h4>
                    <MarkdownContent text={String(row['content'])} />
                  </section>
                  <footer>
                    <span>
                      {typeof meta['tokenEstimate'] === 'number'
                        ? t('promptJournal.tokens', {
                            tokens: meta['tokenEstimate'].toLocaleString(displayLocale()),
                          })
                        : ''}
                    </span>
                    <button
                      type="button"
                      className="button primary"
                      disabled={!onInsert}
                      onClick={() => onInsert?.(String(row['content']))}
                    >
                      {t('promptJournal.reuse')}
                    </button>
                  </footer>
                </div>
              </details>
            );
          })}
        </section>
      )}
      {notice && (
        <p role="status" className="composer-notice">
          {notice}
        </p>
      )}
      <footer className="journal-limit">
        <small>
          {t('promptJournal.visible', { number: filtered.length })}
          {truncated && t('promptJournal.olderExist')}
        </small>
        <button
          type="button"
          className="button secondary"
          disabled={loading || !truncated || !rows.length}
          onClick={() => void loadOlder()}
        >
          {t('promptJournal.loadOlder')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={loading || !filtered.length}
          onClick={() => exportRows('md')}
        >
          <Download size={14} />
          {t('promptJournal.exportMarkdown')}
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={loading || !filtered.length}
          onClick={() => exportRows('jsonl')}
        >
          <Download size={14} />
          {t('promptJournal.exportJsonl')}
        </button>
      </footer>
    </>
  );
}
