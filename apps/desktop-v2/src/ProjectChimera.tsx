import { FileCode2, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChimeraFinding, ReviewTimeline } from './ChimeraFinding';
import { CopyButton } from './CopyButton';
import {
  reviewFilteredReports,
  reviewFindingCounts,
  reviewFollowup,
  reviewLabel,
  reviewOutcomes,
  reviewReportTransitions,
} from './chimera-model';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';
import type { Session } from './model';
import { useReviewNote } from './useReviewNote';
import './project-chimera.css';

interface Decision {
  kind: 'report' | 'finding';
  id: string;
  from: string;
  to: string;
  outcome: string;
  reason: string;
}
export function ProjectChimera({
  command,
  projectId,
  events,
  sessions,
  onPrepare,
  onNewSession,
  onOpenFile,
}: {
  command: EngineCommand;
  projectId: string;
  events: Record<string, Record<string, unknown>>;
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  return (
    <ChimeraContent
      command={command}
      projectId={projectId}
      events={events}
      sessions={sessions}
      onPrepare={onPrepare}
      onNewSession={onNewSession}
      onOpenFile={onOpenFile}
    />
  );
}
function ChimeraContent({
  command,
  projectId,
  events,
  sessions,
  onPrepare,
  onNewSession,
  onOpenFile,
}: {
  command: EngineCommand;
  projectId: string;
  events: Record<string, Record<string, unknown>>;
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const [reports, setReports] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [query, setQuery] = useState('');
  const [sessionFilter, setSessionFilter] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [limit, setLimit] = useState('100');
  const [severity, setSeverity] = useState('');
  const [findingStatus, setFindingStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [targetSession, setTargetSession] = useState('');
  const listGeneration = useRef(0),
    detailGeneration = useRef(0),
    locked = useRef(false),
    selectedRef = useRef('');
  const refresh = useCallback(async () => {
    const own = ++listGeneration.current;
    setLoading(true);
    try {
      const response = await command(
        'chimera.reports.query',
        { all: true, projectWide: true, limit: Number(limit), ...(lifecycle ? { lifecycle } : {}) },
        ['chimera.reports'],
      );
      if (own === listGeneration.current) setReports(entries(response['reports']));
    } catch (e) {
      if (own === listGeneration.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === listGeneration.current) setLoading(false);
    }
  }, [command, lifecycle, limit]);
  const read = useCallback(
    async (id: string, clear = false) => {
      if (selectedRef.current !== id) return;
      const own = ++detailGeneration.current;
      setReading(true);
      if (clear) setDetail(null);
      try {
        const result = await command('chimera.report.get', { reportId: id }, [
          'chimera.report.detail',
        ]);
        if (own === detailGeneration.current && selectedRef.current === id) setDetail(result);
      } catch (e) {
        if (own === detailGeneration.current && selectedRef.current === id)
          setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (own === detailGeneration.current && selectedRef.current === id) setReading(false);
      }
    },
    [command],
  );
  useEffect(() => {
    void refresh();
    return () => {
      listGeneration.current++;
    };
  }, [refresh]);
  useEffect(
    () => () => {
      detailGeneration.current++;
    },
    [],
  );
  const changed = events['chimera.report_available'],
    changedReport = events['chimera.report.updated'],
    changedFinding = events['chimera.finding.updated'];
  useEffect(() => {
    if (!changed && !changedReport && !changedFinding) return;
    void refresh();
    if (selected) void read(selected);
  }, [changed, changedReport, changedFinding, refresh, read, selected]);
  const select = (id: string) => {
    selectedRef.current = id;
    setSelected(id);
    setError('');
    setNotice('');
    setSeverity('');
    setFindingStatus('');
    void read(id, true);
  };
  const report = record(detail?.['report']);
  const findings = entries(detail?.['findings']);
  const visibleFindings = findings.filter(
    (row) =>
      (!severity || record(row['finding'])['severity'] === severity) &&
      (!findingStatus || record(row['finding'])['status'] === findingStatus),
  );
  const counts = reviewFindingCounts(findings);
  const { state: note, controller: noteDraft } = useReviewNote(projectId, selected);
  const noteSubmit = async () => {
    const submitted = await noteDraft.begin();
    if (!submitted) return;
    const owner = selected;
    try {
      await command('chimera.report.add_note', { reportId: owner, note: submitted.text.trim() }, [
        'chimera.report.note_added',
      ]);
      await noteDraft.finish(submitted);
      setNotice('Review note recorded.');
      if (owner === selectedRef.current) await read(owner);
    } catch (e) {
      await noteDraft.finish(submitted, e instanceof Error ? e.message : String(e));
    }
  };
  const applyDecision = async () => {
    if (
      !decision ||
      locked.current ||
      (decision.to === 'resolved' && (!decision.outcome || !decision.reason.trim()))
    )
      return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const current = await command('chimera.report.get', { reportId: selected }, [
        'chimera.report.detail',
      ]);
      const actual =
        decision.kind === 'report'
          ? record(current['report'])['lifecycle']
          : record(
              entries(current['findings']).find(
                (row) => record(row['finding'])['id'] === decision.id,
              )?.['finding'],
            )['status'];
      if (actual !== decision.from) {
        setDetail(current);
        throw Error(
          'This review status changed. Close this decision and review the current state before continuing.',
        );
      }
      await command(
        decision.kind === 'report' ? 'chimera.report.transition' : 'chimera.finding.transition',
        {
          ...(decision.kind === 'report' ? { reportId: decision.id } : { findingId: decision.id }),
          to: decision.to,
          ...(decision.reason.trim() ? { reason: decision.reason.trim() } : {}),
          ...(decision.to === 'resolved' ? { outcome: decision.outcome } : {}),
        },
        [decision.kind === 'report' ? 'chimera.report.updated' : 'chimera.finding.updated'],
      );
      setDecision(null);
      setNotice('Review status recorded.');
      await Promise.all([refresh(), read(selected)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const visible = reviewFilteredReports(reports, query, sessionFilter);
  const agents = sessions.filter((item) => item.kind === 'agent');
  const openFile = onOpenFile;
  return (
    <section className="project-chimera" aria-label="Project Chimera reviews">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">FINDINGS, EVIDENCE AND FOLLOW-THROUGH</span>
          <h1>
            Chimera Reviews<span className="heading-dot">.</span>
          </h1>
          <p>
            Review the project’s reports across recorded sessions and track each finding to an
            explicit outcome.
          </p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={loading || busy}
          onClick={() => {
            setError('');
            void refresh();
            if (selected) void read(selected);
          }}
        >
          <RefreshCw size={14} />
          Refresh Chimera reports
        </button>
      </header>
      {error && !decision && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="review-filters">
        <label>
          <Search size={14} />
          <input
            aria-label="Search Chimera reports"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a review, model, agent or recorded session…"
          />
        </label>
        <select
          aria-label="Review report lifecycle"
          value={lifecycle}
          disabled={busy}
          onChange={(e) => setLifecycle(e.target.value)}
        >
          <option value="">All report statuses</option>
          {['open', 'actioned', 'completed', 'skipped'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <select
          aria-label="Review origin session"
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
        >
          <option value="">All recorded sessions</option>
          {[...new Set(reports.map((item) => String(item['sessionId'])))].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Recent Chimera report window"
          value={limit}
          disabled={busy}
          onChange={(e) => setLimit(e.target.value)}
        >
          {[50, 100, 200].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <p className="field-help">
        {visible.length} matching reports in the most recent {limit} records. Origin sessions are
        report metadata; this project workspace needs no open conversation.
      </p>
      <div className="review-workspace-layout">
        <aside className="review-report-list" aria-label="Chimera report catalog">
          {loading && <p role="status">Reading review reports…</p>}
          {visible.map((item) => (
            <button
              type="button"
              aria-pressed={selected === item['reportId']}
              aria-label={`Open review ${item['reportId']}`}
              key={String(item['reportId'])}
              disabled={busy}
              onClick={() => select(String(item['reportId']))}
            >
              <header>
                <strong>{String(item['reportId']).slice(0, 16)}</strong>
                <span>{reviewLabel(item['lifecycleStatus'])}</span>
              </header>
              <p>{String(item['reviewerModel'] ?? 'Reviewer model not reported')}</p>
              <small>{String(item['reviewedAt'])}</small>
              <div className="review-report-counts">
                <strong>{String(item['totalFindings'])} findings</strong>
                {['critical', 'high', 'medium', 'low']
                  .filter((key) => Number(record(item['counts'])[key]) > 0)
                  .map((key) => (
                    <span key={key}>
                      {String(record(item['counts'])[key])} {key}
                    </span>
                  ))}
              </div>
              <small>{String(item['sessionId'])}</small>
              {item['reviewStatus'] === 'failed' && (
                <strong className="review-failed">Review execution failed</strong>
              )}
            </button>
          ))}
          {!loading && !visible.length && (
            <div className="review-empty">
              <ShieldCheck size={27} />
              <h3>No reports in this view.</h3>
              <p>Saved project review reports will appear here.</p>
            </div>
          )}
        </aside>
        <article className="review-report-detail" aria-label="Chimera report details">
          {reading && !detail ? (
            <p role="status">Reading findings and journal…</p>
          ) : detail && Object.keys(report).length ? (
            <>
              <header>
                <span className="eyebrow">
                  {reviewLabel(report['source'])} · {reviewLabel(report['reviewStatus'])}
                </span>
                <h2>Review {String(report['id']).slice(0, 16)}</h2>
                <p>
                  {String(report['reviewedAt'])} · {reviewLabel(report['lifecycle'])}
                </p>
                <CopyButton text={String(report['id'])} label="Copy Chimera report ID" />
              </header>
              <dl className="review-report-facts">
                {[
                  ['Reviewer model', 'reviewerModel'],
                  ['Recorded session', 'sessionId'],
                  ['Reviewed agent', 'agentId'],
                  ['Cascade depth', 'cascadeDepth'],
                  ['Evidence status', 'evidenceStatus'],
                  ['Review duration (seconds)', 'durationSeconds'],
                ].map(([label, key]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>{String(report[key!] ?? 'Not reported')}</dd>
                  </div>
                ))}
              </dl>
              {Number(report['unparseableCount']) > 0 && (
                <p className="review-incomplete">
                  {String(report['unparseableCount'])} reported items were not parsed individually.
                  Review the full report below.
                </p>
              )}
              <div className="review-lifecycle-actions">
                {(reviewReportTransitions[String(report['lifecycle'])] ?? []).map((to) => (
                  <button
                    type="button"
                    className="button secondary small"
                    key={to}
                    disabled={busy}
                    onClick={() =>
                      setDecision({
                        kind: 'report',
                        id: String(report['id']),
                        from: String(report['lifecycle']),
                        to,
                        outcome: '',
                        reason: '',
                      })
                    }
                  >
                    {to === 'open'
                      ? 'Reopen report'
                      : to === 'actioned'
                        ? 'Mark report actioned'
                        : to === 'completed'
                          ? 'Complete report'
                          : 'Skip report'}
                  </button>
                ))}
              </div>
              <details>
                <summary>Reviewed files ({entries(report['files']).length})</summary>
                <div className="review-file-list">
                  {entries(report['files']).map((file) => (
                    <button
                      type="button"
                      className="button secondary small"
                      key={String(file['path'])}
                      onClick={() => openFile(String(file['path']))}
                    >
                      <FileCode2 size={13} />
                      {String(file['path'])} · {reviewLabel(file['status'])}
                    </button>
                  ))}
                </div>
              </details>
              {entries(report['evidenceChecks']).length > 0 && (
                <details>
                  <summary>
                    Claimed and observed checks ({entries(report['evidenceChecks']).length})
                  </summary>
                  {entries(report['evidenceChecks']).map((check, i) => (
                    <article className="review-evidence-check" key={i}>
                      <strong>
                        {reviewLabel(check['name'])} ·{' '}
                        {check['ok'] === true
                          ? 'Matched passing result'
                          : 'Passing claim not confirmed'}
                      </strong>
                      <p>
                        Claimed exit: {String(check['claimedExitCode'] ?? 'Not reported')} ·
                        Observed exit: {String(check['actualExitCode'] ?? 'Not reported')}
                      </p>
                      <code>{String(check['command'] ?? '')}</code>
                    </article>
                  ))}
                </details>
              )}
              <section className="review-findings">
                <header>
                  <div>
                    <h3>Findings ({findings.length})</h3>
                    <small>
                      {counts.open} open · {counts.resolved} resolved · {counts.ignored} ignored
                    </small>
                  </div>
                  <div>
                    <select
                      aria-label="Review finding severity"
                      value={severity}
                      onChange={(e) => setSeverity(e.target.value)}
                    >
                      <option value="">All severities</option>
                      {['critical', 'high', 'medium', 'low'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Review finding status"
                      value={findingStatus}
                      onChange={(e) => setFindingStatus(e.target.value)}
                    >
                      <option value="">All finding statuses</option>
                      {['active', 'triaged', 'in_progress', 'resolved', 'ignored'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </div>
                </header>
                {visibleFindings.map((row, i) => (
                  <ChimeraFinding
                    key={String(record(row['finding'])['id'] ?? i)}
                    row={row}
                    busy={busy}
                    onOpenFile={openFile}
                    onTransition={(finding, to) =>
                      setDecision({
                        kind: 'finding',
                        id: String(finding['id']),
                        from: String(finding['status']),
                        to,
                        outcome: '',
                        reason: '',
                      })
                    }
                  />
                ))}
                {!findings.length && <p>No individually parsed findings in this report.</p>}
                {findings.length > 0 && !visibleFindings.length && (
                  <p>No findings match these filters.</p>
                )}
              </section>
              {typeof report['rawText'] === 'string' && (
                <details className="review-full-report">
                  <summary>Full review report</summary>
                  <CopyButton text={report['rawText']} label="Copy full Chimera report" />
                  <MarkdownContent text={report['rawText']} />
                </details>
              )}
              <section className="review-journal">
                <h3>Activity journal</h3>
                <ReviewTimeline events={entries(detail['events'])} />
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void noteSubmit();
                  }}
                >
                  <label>
                    Append a review note
                    <textarea
                      aria-label="Chimera review note"
                      value={note.text}
                      disabled={note.busy || !note.ready}
                      maxLength={100000}
                      rows={4}
                      onChange={(e) => noteDraft.edit(e.target.value)}
                      placeholder="Record your investigation, evidence, or follow-up…"
                    />
                  </label>
                  <p role="status" aria-label="Review note draft status">
                    {!note.ready
                      ? 'Loading saved note draft…'
                      : note.saving
                        ? 'Saving note draft…'
                        : note.review
                          ? 'Review competing note drafts below.'
                          : note.dirty
                            ? 'Local note has unsaved changes.'
                            : 'Note draft saved on this device.'}
                  </p>
                  {note.review && (
                    <section
                      className="review-note-conflict"
                      aria-label="Review note draft conflict"
                    >
                      <h4>This note changed in another window</h4>
                      <p>
                        Compare both versions. Choosing a version only updates the local draft; it
                        does not record a report note.
                      </p>
                      <div className="review-note-versions">
                        <label>
                          Your local note
                          <textarea
                            aria-label="Your local review note"
                            readOnly
                            value={note.text}
                            rows={4}
                          />
                        </label>
                        <label>
                          Saved note
                          <textarea
                            aria-label="Saved review note"
                            readOnly
                            value={note.review.text}
                            rows={4}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={note.busy || note.saving}
                        onClick={() => {
                          void noteDraft.resolve('local');
                        }}
                      >
                        Keep my review note
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={note.busy || note.saving}
                        onClick={() => {
                          void noteDraft.resolve('saved');
                        }}
                      >
                        Use saved review note
                      </button>
                    </section>
                  )}
                  {note.error && (
                    <p className="composer-error" role="alert">
                      {note.error}
                    </p>
                  )}
                  <button
                    type="button"
                    className="button secondary"
                    disabled={note.busy || note.saving}
                    onClick={() => {
                      void noteDraft.load();
                    }}
                  >
                    Reload saved note
                  </button>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={
                      note.busy ||
                      note.saving ||
                      !note.ready ||
                      note.dirty ||
                      !!note.review ||
                      !note.text.trim()
                    }
                  >
                    {note.busy ? 'Recording review note…' : 'Record review note'}
                  </button>
                </form>
              </section>
              <details className="review-followup">
                <summary>Prepare a review follow-up</summary>
                <p>
                  Choose a conversation to review the request in its draft. Report tracking remains
                  under your explicit controls above.
                </p>
                <CopyButton text={reviewFollowup(report)} label="Copy Chimera follow-up" />
                {agents.length ? (
                  <>
                    <select
                      aria-label="Chimera follow-up conversation"
                      value={targetSession}
                      onChange={(e) => setTargetSession(e.target.value)}
                    >
                      <option value="">Choose a project conversation…</option>
                      {agents.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || !agents.some((item) => item.id === targetSession)}
                      onClick={() => {
                        setBusy(true);
                        void onPrepare(targetSession, reviewFollowup(report))
                          .catch((e) => setError(String(e)))
                          .finally(() => setBusy(false));
                      }}
                    >
                      Add review follow-up to draft
                    </button>
                  </>
                ) : (
                  <button type="button" className="button secondary" onClick={onNewSession}>
                    Create a project conversation
                  </button>
                )}
              </details>
            </>
          ) : (
            <div className="review-empty">
              <ShieldCheck size={34} />
              <h2>Inspect the evidence behind a review.</h2>
              <p>Select a report to read its findings, citations and activity.</p>
            </div>
          )}
        </article>
      </div>
      {decision && (
        <Modal
          onClose={() => {
            if (!busy) setDecision(null);
          }}
        >
          <section className="review-decision-dialog">
            <header>
              <h2 id="dialog-title">
                Record {decision.kind === 'report' ? 'report' : 'finding'} status
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Close review decision"
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {reviewLabel(decision.from)} → {reviewLabel(decision.to)}
            </p>
            {decision.kind === 'report' && decision.to === 'completed' && counts.open > 0 && (
              <p>
                {counts.open} findings are still open. Completing the report leaves their individual
                tracking states intact.
              </p>
            )}
            {decision.to === 'resolved' && (
              <label>
                Resolution outcome
                <select
                  aria-label="Review resolution outcome"
                  value={decision.outcome}
                  disabled={busy}
                  onChange={(e) => setDecision({ ...decision, outcome: e.target.value })}
                >
                  <option value="">Choose the observed outcome…</option>
                  {reviewOutcomes.map((value) => (
                    <option key={value} value={value}>
                      {value === 'wontfix' ? 'Will not fix' : reviewLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Reason{decision.to === 'resolved' ? ' (required)' : ''}
              <textarea
                aria-label="Review decision reason"
                rows={4}
                disabled={busy}
                value={decision.reason}
                onChange={(e) => setDecision({ ...decision, reason: e.target.value })}
              />
            </label>
            {error && (
              <p className="composer-error" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                Keep reviewing
              </button>
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  (decision.to === 'resolved' && (!decision.outcome || !decision.reason.trim()))
                }
                onClick={() => void applyDecision()}
              >
                {busy ? 'Recording decision…' : 'Confirm review status'}
              </button>
            </footer>
          </section>
        </Modal>
      )}
    </section>
  );
}
