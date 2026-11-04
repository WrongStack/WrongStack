import type { SideEffect } from '@wrongstack/contracts/types';
import { ArrowLeft, Copy, Download, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import {
  type EffectsSnapshot,
  effectKinds,
  effectLabels,
  effectSummary,
  effectsCsv,
  effectsSnapshot,
  journalEffectsSnapshot,
  withOlderPage,
} from './side-effects-model';
import { surfaceI18n } from './surface-i18n';
import { StructuredToolValue } from './ToolApprovalCard';
import './session-side-effects.css';

export function SessionSideEffects({
  sessionId,
  connected,
  command,
  onBack,
}: {
  sessionId: string;
  connected: boolean;
  command: EngineCommand;
  onBack: () => void;
}) {
  const { t } = useDesktopText();
  const kindLabel = (risk: string) =>
    t(`effectsView.kind.${risk}`, { defaultValue: effectLabels[risk] ?? risk });
  const strong = { strong: <strong /> };
  const [snapshot, setSnapshot] = useState<EffectsSnapshot | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [exportError, setExportError] = useState(''),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [order, setOrder] = useState('newest'),
    [selected, setSelected] = useState<SideEffect | null>(null),
    // Older pages joined to the loaded window; live refresh pauses while they are shown.
    [paged, setPaged] = useState<{ entries: SideEffect[]; start: number } | null>(null),
    [pagingError, setPagingError] = useState(''),
    [paging, setPaging] = useState(false),
    // `runtime` polls the live window; `journal` reads the durable session journal on request.
    [source, setSource] = useState<'runtime' | 'journal'>('runtime');
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const alive = useRef(true),
    pending = useRef(false),
    sequence = useRef(0);
  const fetchPage = useCallback(
    async (window: { before?: number; limit?: number }) =>
      source === 'journal'
        ? journalEffectsSnapshot(
            await command(
              'session.inspect',
              { id: sessionId, journalSideEffects: window },
              ['session.inspect'],
              { timeoutMs: 90000 },
            ),
            sessionId,
          )
        : effectsSnapshot(
            await command('side_effects.list', { sessionId, ...window }, ['side_effects']),
            sessionId,
          ),
    [source, sessionId, command],
  );
  const load = useCallback(async () => {
    if (!connected || !sessionId || pending.current) return;
    pending.current = true;
    setBusy(true);
    const current = ++sequence.current;
    try {
      const value = await fetchPage({});
      if (alive.current && current === sequence.current) {
        setSnapshot(value);
        setError('');
      }
    } catch (error) {
      if (alive.current && current === sequence.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (alive.current && current === sequence.current) setBusy(false);
    }
  }, [sessionId, connected, fetchPage]);
  useEffect(() => {
    alive.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!pagedRef.current) await load();
      if (!stopped && source === 'runtime') timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      alive.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [load, source]);
  const loaded = useMemo(() => paged?.entries ?? snapshot?.entries ?? [], [paged, snapshot]);
  const loadedStart = paged ? paged.start : (snapshot?.start ?? null);
  const loadOlder = async () => {
    if (!snapshot || loadedStart === null || loadedStart <= 0) return;
    setPaging(true);
    setPagingError('');
    try {
      // One record of overlap proves the older page joins the loaded window.
      const page = await fetchPage({ before: loadedStart + 1, limit: 101 });
      if (page.start === null) throw Error(t('effectsView.noPaging'));
      const entries = withOlderPage(loaded, page);
      if (alive.current) setPaged({ entries, start: page.start });
    } catch (failure) {
      if (alive.current)
        setPagingError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) setPaging(false);
    }
  };
  const visible = useMemo(
    () =>
      loaded
        .filter(
          (entry) =>
            (kind === 'all' ||
              (kind === 'other'
                ? !effectKinds.includes(entry.risk as (typeof effectKinds)[number])
                : entry.risk === kind)) &&
            `${entry.toolName} ${entry.toolUseId} ${effectSummary(entry)} ${entry.outcome ?? ''}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          order === 'tool'
            ? a.toolName.localeCompare(b.toolName)
            : order === 'kind'
              ? a.risk.localeCompare(b.risk)
              : (Date.parse(a.ts) - Date.parse(b.ts)) * (order === 'oldest' ? 1 : -1),
        ),
    [loaded, query, kind, order],
  );
  const copy = async () => {
    setExportError('');
    try {
      await navigator.clipboard.writeText(effectsCsv(visible));
      setNotice(t('effectsView.copied', { count: visible.length }));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  };
  const download = () => {
    setExportError('');
    try {
      const url = URL.createObjectURL(
        new Blob([effectsCsv(visible)], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `wrongstack-side-effects-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(t('effectsView.downloaded'));
    } catch (error) {
      setExportError(error instanceof Error ? error.message : String(error));
    }
  };
  const selectedCurrent =
    selected &&
    snapshot?.entries.some(
      (entry) => entry.toolUseId === selected.toolUseId && entry.ts === selected.ts,
    );
  return (
    <section className="session-side-effects" aria-label={t('effectsView.label')}>
      <header>
        <div>
          <span className="eyebrow">{t('effectsView.eyebrow')}</span>
          <h2>{t('effectsView.title')}</h2>
          <p>{t('effectsView.body')}</p>
        </div>
        <div className="feature-actions">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            {t('effectsView.back')}
          </button>
          <select
            aria-label={t('effectsView.sourceLabel')}
            value={source}
            onChange={(event) => {
              sequence.current++;
              pending.current = false;
              setBusy(false);
              setSnapshot(null);
              setPaged(null);
              setPagingError('');
              setError('');
              setSelected(null);
              setSource(event.target.value === 'journal' ? 'journal' : 'runtime');
            }}
          >
            <option value="runtime">{t('effectsView.source.runtime')}</option>
            <option value="journal">{t('effectsView.source.journal')}</option>
          </select>
          <button
            type="button"
            className="button secondary"
            disabled={!connected || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            {t('effectsView.refresh')}
          </button>
        </div>
      </header>
      <div className="effects-summary">
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="effectsView.loaded"
            values={{ count: snapshot ? loaded.length : '—' }}
            components={strong}
          />
        </span>
        <span>
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey={source === 'journal' ? 'effectsView.inJournal' : 'effectsView.inRuntime'}
            values={{ count: snapshot?.total ?? '—' }}
            components={strong}
          />
        </span>
        <small>
          {!connected
            ? t('effectsView.status.disconnected')
            : error
              ? t('effectsView.status.failed')
              : source === 'journal'
                ? t('effectsView.status.journal')
                : t('effectsView.status.runtime')}
        </small>
      </div>
      {(snapshot?.truncated || snapshot?.total === null) && (
        <p className="effects-window-note">
          {loadedStart === null
            ? t('effectsView.latest50')
            : t(
                source === 'journal' ? 'effectsView.window.journal' : 'effectsView.window.runtime',
                {
                  from: loadedStart + 1,
                  to: loadedStart + loaded.length,
                  total: snapshot?.total ?? '—',
                },
              )}{' '}
          {t('effectsView.loadedOnly')}
          {loadedStart !== null && loadedStart > 0 && (
            <button
              type="button"
              className="button secondary small"
              disabled={paging || !connected}
              onClick={() => void loadOlder()}
            >
              {paging ? t('effectsView.loading') : t('effectsView.older')}
            </button>
          )}
        </p>
      )}
      {paged && (
        <p className="effects-window-note" role="status">
          {source === 'runtime' ? t('effectsView.paused.runtime') : t('effectsView.paused.journal')}{' '}
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setPaged(null);
              setPagingError('');
              void load();
            }}
          >
            {t('effectsView.latest')}
          </button>
        </p>
      )}
      {pagingError && (
        <p role="alert" className="session-error">
          {pagingError}
        </p>
      )}
      {exportError && (
        <p role="alert" className="session-error">
          {exportError}
        </p>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="feature-notice">
          {notice}
        </p>
      )}
      <div className="effects-filters">
        <label>
          <Search size={14} />
          <input
            aria-label={t('effectsView.search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('effectsView.placeholder')}
          />
        </label>
        <select
          aria-label={t('effectsView.kindLabel')}
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="all">{t('effectsView.filter.all')}</option>
          {effectKinds.map((value) => (
            <option key={value} value={value}>
              {kindLabel(value)}
            </option>
          ))}
          <option value="other">{t('effectsView.filter.other')}</option>
        </select>
        <select
          aria-label={t('effectsView.sortLabel')}
          value={order}
          onChange={(event) => setOrder(event.target.value)}
        >
          <option value="newest">{t('effectsView.sort.newest')}</option>
          <option value="oldest">{t('effectsView.sort.oldest')}</option>
          <option value="tool">{t('effectsView.sort.tool')}</option>
          <option value="kind">{t('effectsView.sort.kind')}</option>
        </select>
      </div>
      <div className="effects-export feature-actions">
        <span>{t('effectsView.visible', { count: visible.length })}</span>
        <button
          type="button"
          className="button secondary small"
          disabled={!visible.length}
          onClick={() => void copy()}
        >
          <Copy size={13} />
          {t('effectsView.copy')}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={!visible.length}
          onClick={download}
        >
          <Download size={13} />
          {t('effectsView.download')}
        </button>
      </div>
      {!connected ? (
        <p className="quiet-state">{t('effectsView.reconnect')}</p>
      ) : !snapshot ? (
        <p role="status">{error ? t('effectsView.unavailable') : t('effectsView.reading')}</p>
      ) : !visible.length ? (
        <div className="effects-empty">
          <ShieldCheck size={30} />
          <h3>{snapshot.entries.length ? t('effectsView.noMatch') : t('effectsView.none')}</h3>
          <p>{t('effectsView.safe')}</p>
        </div>
      ) : (
        <div className="effects-records">
          {visible.map((entry, index) => (
            <button
              type="button"
              key={`${entry.toolUseId}:${entry.ts}:${index}`}
              data-effect-id={entry.toolUseId}
              onClick={() => setSelected(entry)}
            >
              <span className="effect-kind">{kindLabel(entry.risk)}</span>
              <strong>{entry.toolName}</strong>
              <time>{new Date(entry.ts).toLocaleString()}</time>
              <p>{effectSummary(entry)}</p>
              <small>{entry.outcome || t('effectsView.noOutcome')}</small>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <aside className="effect-inspector" aria-label={t('effectsView.detail')}>
          <header>
            <div>
              <span className="eyebrow">{t('effectsView.detailEyebrow')}</span>
              <h3>{selected.toolName}</h3>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t('effectsView.close')}
              onClick={() => setSelected(null)}
            >
              <X size={16} />
            </button>
          </header>
          {!selectedCurrent && <p className="effects-window-note">{t('effectsView.stale')}</p>}
          <dl>
            <dt>{t('effectsView.field.toolCall')}</dt>
            <dd>{selected.toolUseId}</dd>
            <dt>{t('effectsView.field.recordedAt')}</dt>
            <dd>{new Date(selected.ts).toLocaleString()}</dd>
            <dt>{t('effectsView.field.kind')}</dt>
            <dd>{kindLabel(selected.risk)}</dd>
            <dt>{t('effectsView.field.outcome')}</dt>
            <dd>{selected.outcome || t('effectsView.notReported')}</dd>
          </dl>
          <h4>{t('effectsView.input')}</h4>
          <div className="effect-input">
            <StructuredToolValue value={selected.input} />
          </div>
          <p>{t('effectsView.outputNote')}</p>
        </aside>
      )}
    </section>
  );
}
