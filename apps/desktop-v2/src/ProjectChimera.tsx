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
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { dateTimeText, entries, record } from './engine-values';
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
  const { t, i18n } = useDesktopText();
  // Engine values are named per language; unknown ones read as reviewLabel shows them.
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? t(`reviews.value.${value}`, { defaultValue: reviewLabel(value) })
      : t('reviews.notReported');
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
      setNotice(t('reviews.noteRecorded'));
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
        throw Error(t('reviews.statusChanged'));
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
      setNotice(t('reviews.statusRecorded'));
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
    <section className="project-chimera" aria-label={t('reviews.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('reviews.title')}</h1>
          <p>{t('reviews.intro')}</p>
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
          {t('reviews.refresh')}
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
            aria-label={t('reviews.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('reviews.searchPlaceholder')}
          />
        </label>
        <select
          aria-label={t('reviews.lifecycleLabel')}
          value={lifecycle}
          disabled={busy}
          onChange={(e) => setLifecycle(e.target.value)}
        >
          <option value="">{t('reviews.allStatuses')}</option>
          {['open', 'actioned', 'completed', 'skipped'].map((value) => (
            <option key={value} value={value}>
              {named(value)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('reviews.sessionLabel')}
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
        >
          <option value="">{t('reviews.allSessions')}</option>
          {[...new Set(reports.map((item) => String(item['sessionId'])))].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label={t('reviews.windowLabel')}
          value={limit}
          disabled={busy}
          onChange={(e) => setLimit(e.target.value)}
        >
          {[50, 100, 200].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </div>
      <p className="field-help">{t('reviews.matching', { count: visible.length, limit })}</p>
      <div className="review-workspace-layout">
        <aside className="review-report-list" aria-label={t('reviews.catalogLabel')}>
          {loading && <p role="status">{t('reviews.reading')}</p>}
          {visible.map((item) => (
            <button
              type="button"
              aria-pressed={selected === item['reportId']}
              aria-label={t('reviews.openReview', { id: String(item['reportId']) })}
              key={String(item['reportId'])}
              disabled={busy}
              onClick={() => select(String(item['reportId']))}
            >
              <header>
                <strong>{String(item['reportId']).slice(0, 16)}</strong>
                <span>{named(item['lifecycleStatus'])}</span>
              </header>
              <p>{String(item['reviewerModel'] ?? t('reviews.noModel'))}</p>
              <small>{dateTimeText(item['reviewedAt'], i18n.language)}</small>
              <div className="review-report-counts">
                <strong>
                  {t('reviews.findingsCount', { count: Number(item['totalFindings']) })}
                </strong>
                {['critical', 'high', 'medium', 'low']
                  .filter((key) => Number(record(item['counts'])[key]) > 0)
                  .map((key) => (
                    <span key={key}>
                      {t('reviews.severityCount', {
                        n: String(record(item['counts'])[key]),
                        severity: named(key),
                      })}
                    </span>
                  ))}
              </div>
              <small>{String(item['sessionId'])}</small>
              {item['reviewStatus'] === 'failed' && (
                <strong className="review-failed">{t('reviews.executionFailed')}</strong>
              )}
            </button>
          ))}
          {!loading && !visible.length && (
            <div className="review-empty">
              <ShieldCheck size={27} />
              <h3>{t('reviews.noReports')}</h3>
              <p>{t('reviews.noReportsHelp')}</p>
            </div>
          )}
        </aside>
        <article className="review-report-detail" aria-label={t('reviews.detailLabel')}>
          {reading && !detail ? (
            <p role="status">{t('reviews.readingDetail')}</p>
          ) : detail && Object.keys(report).length ? (
            <>
              <header>
                <span className="eyebrow">
                  {named(report['source'])} · {named(report['reviewStatus'])}
                </span>
                <h2>{t('reviews.reviewTitle', { id: String(report['id']).slice(0, 16) })}</h2>
                <p>
                  {dateTimeText(report['reviewedAt'], i18n.language)} · {named(report['lifecycle'])}
                </p>
                <CopyButton text={String(report['id'])} label={t('reviews.copyId')} />
              </header>
              <dl className="review-report-facts">
                {[
                  'reviewerModel',
                  'sessionId',
                  'agentId',
                  'cascadeDepth',
                  'evidenceStatus',
                  'durationSeconds',
                ].map((key) => (
                  <div key={key}>
                    <dt>{t(`reviews.fact.${key}`)}</dt>
                    <dd>{String(report[key] ?? t('reviews.notReported'))}</dd>
                  </div>
                ))}
              </dl>
              {Number(report['unparseableCount']) > 0 && (
                <p className="review-incomplete">
                  {t('reviews.unparseable', { count: Number(report['unparseableCount']) })}
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
                      ? t('reviews.reopenReport')
                      : to === 'actioned'
                        ? t('reviews.actionReport')
                        : to === 'completed'
                          ? t('reviews.completeReport')
                          : t('reviews.skipReport')}
                  </button>
                ))}
              </div>
              <details>
                <summary>
                  {t('reviews.reviewedFiles', { n: entries(report['files']).length })}
                </summary>
                <div className="review-file-list">
                  {entries(report['files']).map((file) => (
                    <button
                      type="button"
                      className="button secondary small"
                      key={String(file['path'])}
                      onClick={() => openFile(String(file['path']))}
                    >
                      <FileCode2 size={13} />
                      {String(file['path'])} · {named(file['status'])}
                    </button>
                  ))}
                </div>
              </details>
              {entries(report['evidenceChecks']).length > 0 && (
                <details>
                  <summary>
                    {t('reviews.checks', { n: entries(report['evidenceChecks']).length })}
                  </summary>
                  {entries(report['evidenceChecks']).map((check, i) => (
                    <article className="review-evidence-check" key={i}>
                      <strong>
                        {reviewLabel(check['name'])} ·{' '}
                        {check['ok'] === true ? t('reviews.matched') : t('reviews.notConfirmed')}
                      </strong>
                      <p>
                        {t('reviews.exits', {
                          claimed: String(check['claimedExitCode'] ?? t('reviews.notReported')),
                          observed: String(check['actualExitCode'] ?? t('reviews.notReported')),
                        })}
                      </p>
                      <code>{String(check['command'] ?? '')}</code>
                    </article>
                  ))}
                </details>
              )}
              <section className="review-findings">
                <header>
                  <div>
                    <h3>{t('reviews.findings', { n: findings.length })}</h3>
                    <small>
                      {t('reviews.findingCounts', {
                        open: counts.open,
                        resolved: counts.resolved,
                        ignored: counts.ignored,
                      })}
                    </small>
                  </div>
                  <div>
                    <select
                      aria-label={t('reviews.severityLabel')}
                      value={severity}
                      onChange={(e) => setSeverity(e.target.value)}
                    >
                      <option value="">{t('reviews.allSeverities')}</option>
                      {['critical', 'high', 'medium', 'low'].map((value) => (
                        <option key={value} value={value}>
                          {named(value)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t('reviews.findingStatusLabel')}
                      value={findingStatus}
                      onChange={(e) => setFindingStatus(e.target.value)}
                    >
                      <option value="">{t('reviews.allFindingStatuses')}</option>
                      {['active', 'triaged', 'in_progress', 'resolved', 'ignored'].map((value) => (
                        <option key={value} value={value}>
                          {named(value)}
                        </option>
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
                {!findings.length && <p>{t('reviews.noParsed')}</p>}
                {findings.length > 0 && !visibleFindings.length && <p>{t('reviews.noMatch')}</p>}
              </section>
              {typeof report['rawText'] === 'string' && (
                <details className="review-full-report">
                  <summary>{t('reviews.fullReport')}</summary>
                  <CopyButton text={report['rawText']} label={t('reviews.copyFull')} />
                  <MarkdownContent text={report['rawText']} />
                </details>
              )}
              <section className="review-journal">
                <h3>{t('reviews.journal')}</h3>
                <ReviewTimeline events={entries(detail['events'])} />
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void noteSubmit();
                  }}
                >
                  <label>
                    {t('reviews.appendNote')}
                    <textarea
                      aria-label={t('reviews.noteLabel')}
                      value={note.text}
                      disabled={note.busy || !note.ready}
                      maxLength={100000}
                      rows={4}
                      onChange={(e) => noteDraft.edit(e.target.value)}
                      placeholder={t('reviews.notePlaceholder')}
                    />
                  </label>
                  <p role="status" aria-label={t('reviews.noteStatusLabel')}>
                    {!note.ready
                      ? t('reviews.note.loading')
                      : note.saving
                        ? t('reviews.note.saving')
                        : note.review
                          ? t('reviews.note.review')
                          : note.dirty
                            ? t('reviews.note.dirty')
                            : t('reviews.note.saved')}
                  </p>
                  {note.review && (
                    <section
                      className="review-note-conflict"
                      aria-label={t('reviews.conflictLabel')}
                    >
                      <h4>{t('reviews.conflictTitle')}</h4>
                      <p>{t('reviews.conflictHelp')}</p>
                      <div className="review-note-versions">
                        <label>
                          {t('reviews.yourNote')}
                          <textarea
                            aria-label={t('reviews.yourNoteLabel')}
                            readOnly
                            value={note.text}
                            rows={4}
                          />
                        </label>
                        <label>
                          {t('reviews.savedNote')}
                          <textarea
                            aria-label={t('reviews.savedNoteLabel')}
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
                        {t('reviews.keepMine')}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={note.busy || note.saving}
                        onClick={() => {
                          void noteDraft.resolve('saved');
                        }}
                      >
                        {t('reviews.useSaved')}
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
                    {t('reviews.reload')}
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
                    {note.busy ? t('reviews.recording') : t('reviews.record')}
                  </button>
                </form>
              </section>
              <details className="review-followup">
                <summary>{t('reviews.followup')}</summary>
                <p>{t('reviews.followupHelp')}</p>
                <CopyButton text={reviewFollowup(report)} label={t('reviews.copyFollowup')} />
                {agents.length ? (
                  <>
                    <select
                      aria-label={t('reviews.followupLabel')}
                      value={targetSession}
                      onChange={(e) => setTargetSession(e.target.value)}
                    >
                      <option value="">{t('reviews.chooseConversation')}</option>
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
                      {t('reviews.addFollowup')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="button secondary" onClick={onNewSession}>
                    {t('reviews.createConversation')}
                  </button>
                )}
              </details>
            </>
          ) : (
            <div className="review-empty">
              <ShieldCheck size={34} />
              <h2>{t('reviews.emptyTitle')}</h2>
              <p>{t('reviews.emptyHelp')}</p>
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
                {decision.kind === 'report'
                  ? t('reviews.decisionReport')
                  : t('reviews.decisionFinding')}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t('reviews.closeDecision')}
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              {named(decision.from)} → {named(decision.to)}
            </p>
            {decision.kind === 'report' && decision.to === 'completed' && counts.open > 0 && (
              <p>{t('reviews.stillOpen', { count: counts.open })}</p>
            )}
            {decision.to === 'resolved' && (
              <label>
                {t('reviews.outcome')}
                <select
                  aria-label={t('reviews.outcomeLabel')}
                  value={decision.outcome}
                  disabled={busy}
                  onChange={(e) => setDecision({ ...decision, outcome: e.target.value })}
                >
                  <option value="">{t('reviews.chooseOutcome')}</option>
                  {reviewOutcomes.map((value) => (
                    <option key={value} value={value}>
                      {value === 'wontfix' ? t('reviews.willNotFix') : named(value)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {decision.to === 'resolved' ? t('reviews.reasonRequired') : t('reviews.reason')}
              <textarea
                aria-label={t('reviews.reasonLabel')}
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
                {t('reviews.keepReviewing')}
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
                {busy ? t('reviews.recordingDecision') : t('reviews.confirm')}
              </button>
            </footer>
          </section>
        </Modal>
      )}
    </section>
  );
}
