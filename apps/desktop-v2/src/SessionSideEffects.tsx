import type { SideEffect } from '@wrongstack/contracts/types';
import { ArrowLeft, Copy, Download, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import {
  type EffectsSnapshot,
  effectKinds,
  effectLabels,
  effectSummary,
  effectsCsv,
  effectsSnapshot,
  withOlderPage,
} from './side-effects-model';
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
    [paging, setPaging] = useState(false);
  const pagedRef = useRef(paged);
  pagedRef.current = paged;
  const alive = useRef(true),
    pending = useRef(false),
    sequence = useRef(0);
  const load = useCallback(async () => {
    if (!connected || !sessionId || pending.current) return;
    pending.current = true;
    setBusy(true);
    const current = ++sequence.current;
    try {
      const value = effectsSnapshot(
        await command('side_effects.list', { sessionId }, ['side_effects']),
        sessionId,
      );
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
  }, [sessionId, connected, command]);
  useEffect(() => {
    alive.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!pagedRef.current) await load();
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      stopped = true;
      alive.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [load]);
  const loaded = useMemo(() => paged?.entries ?? snapshot?.entries ?? [], [paged, snapshot]);
  const loadedStart = paged ? paged.start : (snapshot?.start ?? null);
  const loadOlder = async () => {
    if (!snapshot || loadedStart === null || loadedStart <= 0) return;
    setPaging(true);
    setPagingError('');
    try {
      // One record of overlap proves the older page joins the loaded window.
      const page = effectsSnapshot(
        await command('side_effects.list', { sessionId, before: loadedStart + 1, limit: 101 }, [
          'side_effects',
        ]),
        sessionId,
      );
      if (page.start === null) throw Error('This engine does not page side effects.');
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
      setNotice(`${visible.length} visible records copied as spreadsheet-safe CSV.`);
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
      setNotice('CSV download requested for the visible records.');
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
    <section className="session-side-effects" aria-label="Session side effects">
      <header>
        <div>
          <span className="eyebrow">THIS CONVERSATION</span>
          <h2>Side effects</h2>
          <p>
            Recorded operations that can affect files, commands, packages, network or configuration.
            An audit record is separate from permission approval.
          </p>
        </div>
        <div className="feature-actions">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to conversation
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!connected || busy}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            Refresh side effects
          </button>
        </div>
      </header>
      <div className="effects-summary">
        <span>
          <strong>{snapshot ? loaded.length : '—'}</strong> loaded
        </span>
        <span>
          <strong>{snapshot?.total ?? '—'}</strong> retained by runtime
        </span>
        <small>
          {!connected
            ? 'Disconnected'
            : error
              ? 'Refresh failed; prior snapshot retained'
              : 'Audit metadata refreshes every 3 seconds'}
        </small>
      </div>
      {(snapshot?.truncated || snapshot?.total === null) && (
        <p className="effects-window-note">
          {loadedStart === null
            ? 'The engine returns the latest 50 records from its retained runtime history.'
            : `Showing records ${loadedStart + 1}–${loadedStart + loaded.length} of ${snapshot?.total ?? '—'} retained by the runtime.`}{' '}
          Search and export apply only to the loaded records.
          {loadedStart !== null && loadedStart > 0 && (
            <button
              type="button"
              className="button secondary small"
              disabled={paging || !connected}
              onClick={() => void loadOlder()}
            >
              {paging ? 'Loading…' : 'Load older records'}
            </button>
          )}
        </p>
      )}
      {paged && (
        <p className="effects-window-note" role="status">
          Live refresh is paused while older records are shown.{' '}
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setPaged(null);
              setPagingError('');
              void load();
            }}
          >
            Return to latest
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
            aria-label="Search side effects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Command, package, URL, tool or outcome…"
          />
        </label>
        <select
          aria-label="Side-effect kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="all">All operation kinds</option>
          {effectKinds.map((value) => (
            <option key={value} value={value}>
              {effectLabels[value]}
            </option>
          ))}
          <option value="other">Other recorded kinds</option>
        </select>
        <select
          aria-label="Side-effect sort"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="tool">Tool name</option>
          <option value="kind">Operation kind</option>
        </select>
      </div>
      <div className="effects-export feature-actions">
        <span>{visible.length} visible records</span>
        <button
          type="button"
          className="button secondary small"
          disabled={!visible.length}
          onClick={() => void copy()}
        >
          <Copy size={13} />
          Copy visible CSV
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={!visible.length}
          onClick={download}
        >
          <Download size={13} />
          Download visible CSV
        </button>
      </div>
      {!connected ? (
        <p className="quiet-state">Reconnect this conversation to read its recorded operations.</p>
      ) : !snapshot ? (
        <p role="status">
          {error
            ? 'Audit records are unavailable. Refresh to retry.'
            : 'Reading side-effect history…'}
        </p>
      ) : !visible.length ? (
        <div className="effects-empty">
          <ShieldCheck size={30} />
          <h3>
            {snapshot.entries.length ? 'No matching side effects.' : 'No recorded side effects.'}
          </h3>
          <p>Opening this view does not execute a tool or grant permission.</p>
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
              <span className="effect-kind">{effectLabels[entry.risk] ?? entry.risk}</span>
              <strong>{entry.toolName}</strong>
              <time>{new Date(entry.ts).toLocaleString()}</time>
              <p>{effectSummary(entry)}</p>
              <small>{entry.outcome || 'Outcome not reported'}</small>
            </button>
          ))}
        </div>
      )}
      {selected && (
        <aside className="effect-inspector" aria-label="Side-effect detail">
          <header>
            <div>
              <span className="eyebrow">RECORDED OPERATION</span>
              <h3>{selected.toolName}</h3>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close side-effect detail"
              onClick={() => setSelected(null)}
            >
              <X size={16} />
            </button>
          </header>
          {!selectedCurrent && (
            <p className="effects-window-note">
              This selected record is no longer in the latest loaded window.
            </p>
          )}
          <dl>
            <dt>Tool call</dt>
            <dd>{selected.toolUseId}</dd>
            <dt>Recorded at</dt>
            <dd>{new Date(selected.ts).toLocaleString()}</dd>
            <dt>Operation kind</dt>
            <dd>{effectLabels[selected.risk] ?? selected.risk}</dd>
            <dt>Outcome</dt>
            <dd>{selected.outcome || 'Not reported'}</dd>
          </dl>
          <h4>Recorded input</h4>
          <div className="effect-input">
            <StructuredToolValue value={selected.input} />
          </div>
          <p>
            Only the recorded outcome summary is shown here. Full output is available in the
            conversation's run activity when retained.
          </p>
        </aside>
      )}
    </section>
  );
}
