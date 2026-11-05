import { LoaderCircle, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { Modal } from './Modal';
import './file-content-search.css';

const REASONS = new Set(['time', 'files', 'entries', 'bytes', 'matches']);
export function FileContentSearch({
  command,
  folder,
  includeIgnored: initialIgnored,
  onClose,
  onOpen,
}: {
  command: EngineCommand;
  folder: string;
  includeIgnored: boolean;
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  const { t } = useDesktopText();
  const [query, setQuery] = useState(''),
    [scope, setScope] = useState(folder);
  const [matchCase, setMatchCase] = useState(false),
    [includeIgnored, setIncludeIgnored] = useState(initialIgnored);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const search = async () => {
    const version = ++sequence.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await command(
        'files.search',
        { query, path: scope || '.', matchCase, includeIgnored, limit: 200 },
        ['files.search'],
      );
      if (sequence.current === version) setResult(response);
    } catch (error) {
      if (sequence.current === version)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (sequence.current === version) setBusy(false);
    }
  };
  const hits = entries(result?.['hits']);
  const skipped = record(result?.['skipped']);
  const omitted = Object.values(skipped).reduce<number>(
    (sum, value) => sum + Number(value || 0),
    0,
  );
  return (
    <Modal onClose={onClose}>
      <div className="file-content-search-dialog">
        <header>
          <div>
            <span className="eyebrow">{t('contentSearch.eyebrow')}</span>
            <h2 id="dialog-title">{t('contentSearch.title')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('contentSearch.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <p>{t('contentSearch.help')}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && query) void search();
          }}
        >
          <label>
            {t('contentSearch.findText')}
            <input
              aria-label={t('contentSearch.findLabel')}
              required
              maxLength={200}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('contentSearch.placeholder')}
            />
          </label>
          <label>
            {t('contentSearch.folder')}
            <input
              aria-label={t('contentSearch.folderLabel')}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              placeholder={t('contentSearch.folderPlaceholder')}
            />
          </label>
          <div className="file-content-search-options">
            <label>
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(event) => setMatchCase(event.target.checked)}
              />
              {t('find.matchCase')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeIgnored}
                onChange={(event) => setIncludeIgnored(event.target.checked)}
              />
              {t('contentSearch.ignored')}
            </label>
            <button type="submit" className="button primary" disabled={busy || !query}>
              {busy ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}
              {t('fileView.searchContents')}
            </button>
          </div>
        </form>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {busy && <p role="status">{t('contentSearch.searching')}</p>}
        {result && (
          <>
            <p role="status">
              <strong>{t('contentSearch.lines', { count: hits.length })}</strong> ·{' '}
              {t('contentSearch.filesRead', {
                count: Number(result['scannedFiles'] ?? 0),
              })}
              {result['partial'] === true
                ? ` · ${t('contentSearch.partial')}`
                : ` · ${t('contentSearch.finished')}`}
            </p>
            <p className="file-search-caveat">
              {t('contentSearch.for', {
                query: String(result['query']),
                scope:
                  result['scope'] === '.' || !result['scope']
                    ? t('contentSearch.wholeProject')
                    : String(result['scope']),
              })}
            </p>
            {Array.isArray(result['reasons']) && result['reasons'].length > 0 && (
              <p className="file-search-caveat">
                {t('contentSearch.reached', {
                  reasons: result['reasons']
                    .map((value) =>
                      REASONS.has(String(value))
                        ? t(`contentSearch.reason.${String(value)}`)
                        : String(value),
                    )
                    .join(', '),
                })}
              </p>
            )}
            {omitted > 0 && (
              <p className="file-search-caveat">
                {t('contentSearch.omitted', {
                  binary: Number(skipped['binary'] ?? 0),
                  oversized: Number(skipped['oversized'] ?? 0),
                  unreadable: Number(skipped['unreadable'] ?? 0),
                  links: Number(skipped['links'] ?? 0),
                  depth: Number(skipped['depth'] ?? 0),
                })}
              </p>
            )}
            <section
              className="file-content-search-results"
              aria-label={t('contentSearch.results')}
            >
              {hits.length ? (
                hits.map((hit) => (
                  <button
                    type="button"
                    key={`${hit['path']}:${hit['line']}`}
                    aria-label={t('contentSearch.openHit', {
                      path: hit['path'],
                      line: hit['line'],
                    })}
                    onClick={() => onOpen(String(hit['path']), Number(hit['line']))}
                  >
                    <strong>
                      {String(hit['path'])}
                      <span>
                        :{String(hit['line'])}:{String(hit['column'])}
                      </span>
                    </strong>
                    <code>{String(hit['preview'])}</code>
                  </button>
                ))
              ) : (
                <p>{t('contentSearch.none')}</p>
              )}
            </section>
          </>
        )}
        <small>{t('contentSearch.limits')}</small>
      </div>
    </Modal>
  );
}
