import { FileCode2, RefreshCw, ScanSearch, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { DeadCodePlan, DeadCodeResult, useDeadCodeLabel } from './DeadCodePlan';
import {
  deadCodeApplyBody,
  deadCodeCategories,
  deadCodeRequest,
  deadCodeRestoreOutcome,
  filterDeadCode,
  sameDeadCodePlan,
} from './dead-code-model';
import {
  beginDeadCodeWork,
  getDeadCodeWork,
  updateDeadCodeWork,
  useDeadCodeWork,
} from './dead-code-work';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { entries, record, sentenceStart } from './engine-values';
import type { Session } from './model';
import './project-dead-code.css';

export function ProjectDeadCode({
  http,
  projectId,
  sessions,
  onPrepare,
  onNewSession,
  onOpenFile,
}: {
  http: EngineHttp;
  projectId: string;
  sessions: Session[];
  onPrepare: (id: string, text: string) => Promise<boolean>;
  onNewSession: () => void;
  onOpenFile: (path: string, line?: number, endLine?: number) => void;
}) {
  const { t, i18n } = useDesktopText();
  const label = useDeadCodeLabel();
  const work = useDeadCodeWork(projectId);
  const update = (changes: Parameters<typeof updateDeadCodeWork>[1]) =>
    updateDeadCodeWork(projectId, changes);
  const [scope, setScope] = useState(work.scanScope);
  const [publicApi, setPublicApi] = useState(work.includePublicApi);
  const [category, setCategory] = useState('');
  const [confidence, setConfidence] = useState('medium');
  const [query, setQuery] = useState('');
  const [onlyFixable, setOnlyFixable] = useState(false);
  const [visible, setVisible] = useState(100);
  const [verify, setVerify] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [backups, setBackups] = useState<Record<string, unknown>[]>([]);
  const [backupError, setBackupError] = useState('');
  const [undo, setUndo] = useState<{ id: string; conflicts: string[] } | null>(null);
  const [session, setSession] = useState('');
  const [handoff, setHandoff] = useState(false);
  const loadBackups = useCallback(async () => {
    setBackupError('');
    try {
      setBackups(entries(record(await http('/api/deadcode/backups'))['backups']));
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : String(e));
    }
  }, [http]);
  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);
  const scan = async () => {
    if (!beginDeadCodeWork(projectId, t('deadCode.busy.scan'))) return;
    setConfirm(false);
    try {
      const report = record(
        await http('/api/deadcode/scan', 'POST', {
          paths: scope
            .split(',')
            .map((path) => path.trim())
            .filter(Boolean),
          includePublicApi: publicApi,
        }),
      );
      const found = entries(report['findings']);
      update({
        report,
        scanScope: scope,
        includePublicApi: publicApi,
        plan: null,
        selected: getDeadCodeWork(projectId).selected.filter((id) =>
          found.some((item) => item['id'] === id),
        ),
      });
      setVisible(100);
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ busy: '' });
    }
  };
  const findings = entries(work.report?.['findings']);
  const filtered = filterDeadCode(findings, category, confidence, query, onlyFixable);
  const selected = findings.filter((item) => work.selected.includes(String(item['id'])));
  const fixable = selected.filter((item) => typeof item['fix'] === 'string');
  const ids = fixable.map((item) => String(item['id']));
  const toggle = (list: string[], on: boolean) => {
    if (work.busy) return;
    const next = new Set(work.selected);
    for (const id of list) {
      if (on) next.add(id);
      else next.delete(id);
    }
    update({ selected: [...next], plan: null });
    setConfirm(false);
  };
  const preview = async () => {
    if (!ids.length || !beginDeadCodeWork(projectId, t('deadCode.busy.preview'))) return;
    setConfirm(false);
    try {
      update({ plan: record(await http('/api/deadcode/preview', 'POST', { ids })) });
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ busy: '' });
    }
  };
  const apply = async () => {
    if (!work.plan || !ids.length || !beginDeadCodeWork(projectId, t('deadCode.busy.apply')))
      return;
    setConfirm(false);
    try {
      const fresh = record(await http('/api/deadcode/preview', 'POST', { ids }));
      if (!sameDeadCodePlan(work.plan, fresh)) {
        update({ plan: fresh });
        throw Error(t('deadCode.previewChanged'));
      }
      const result = record(
        await http('/api/deadcode/apply', 'POST', deadCodeApplyBody(ids, verify, work.plan)),
      );
      if (result['stale'] === true) {
        update({ plan: record(result['plan']) });
        throw Error(t('deadCode.stale'));
      }
      update({
        result,
        plan: null,
        selected: result['ok'] === true ? [] : work.selected,
        notice:
          result['rolledBack'] === true
            ? t('deadCode.rolledBackNotice')
            : t('deadCode.resultNotice'),
      });
      await loadBackups();
      if (result['ok'] === true) {
        const report = record(
          await http('/api/deadcode/scan', 'POST', {
            paths: work.scanScope
              .split(',')
              .map((path) => path.trim())
              .filter(Boolean),
            includePublicApi: work.includePublicApi,
          }),
        );
        update({ report });
      }
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ busy: '' });
    }
  };
  const restore = async (id: string, force = false) => {
    if (!beginDeadCodeWork(projectId, t('deadCode.busy.restore'))) return;
    try {
      const result = record(await http('/api/deadcode/undo', 'POST', { backupId: id, force }));
      const conflicts = Array.isArray(result['conflicts']) ? result['conflicts'].map(String) : [];
      const restored = Array.isArray(result['restored']) ? result['restored'].map(String) : [];
      const outcome = deadCodeRestoreOutcome(restored, conflicts, (count, remaining) =>
        remaining
          ? t(count === 1 ? 'deadCode.restoredOneConflicts' : 'deadCode.restoredManyConflicts', {
              restored: count,
              remaining,
            })
          : t(count === 1 ? 'deadCode.restoredOne' : 'deadCode.restoredMany', { restored: count }),
      );
      setUndo(outcome.remaining.length ? { id, conflicts: outcome.remaining } : null);
      update({
        notice: outcome.notice,
        plan: null,
        result: null,
        report: null,
        selected: [],
      });
      await loadBackups();
    } catch (e) {
      update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      update({ busy: '' });
    }
  };
  const stats = record(work.report?.['stats']);
  const agents = sessions.filter((item) => item.kind === 'agent');
  return (
    <section className="project-dead-code" aria-label={t('deadCode.label')}>
      <header className="studio-heading">
        <div>
          <h1>{t('deadCode.title')}</h1>
          <p>{t('deadCode.intro')}</p>
        </div>
        <ScanSearch size={30} />
      </header>
      <fieldset className="dead-code-scan-controls" disabled={!!work.busy}>
        <label>
          {t('deadCode.scope')}
          <input
            aria-label={t('deadCode.scopeLabel')}
            placeholder={t('deadCode.scopePlaceholder')}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <small>{t('deadCode.scopeHint')}</small>
        </label>
        <label className="dead-code-check">
          <input
            type="checkbox"
            checked={publicApi}
            onChange={(e) => setPublicApi(e.target.checked)}
          />
          {t('deadCode.publicApi')}
        </label>
        <button type="button" className="button primary" onClick={() => void scan()}>
          <RefreshCw size={14} />
          {work.report ? t('deadCode.rescan') : t('deadCode.scan')}
        </button>
      </fieldset>
      {work.error && (
        <p role="alert" className="composer-error">
          {work.error}
        </p>
      )}
      {work.busy && <p role="status">{work.busy}</p>}
      {work.notice && <p role="status">{work.notice}</p>}
      {work.result && <DeadCodeResult result={work.result} />}
      {work.report ? (
        <>
          <div className="dead-code-stats">
            {[
              ['files', stats['files']],
              ['entryFiles', stats['entryFiles']],
              ['reachableFiles', stats['reachableFiles']],
              ['findings', findings.length],
              ['fixes', findings.filter((item) => item['fix']).length],
              ['cachedFiles', stats['cachedFiles']],
            ].map(([name, value]) => (
              <div key={String(name)}>
                <small>{t(`deadCode.stat.${String(name)}`)}</small>
                <strong>{String(value ?? 0)}</strong>
              </div>
            ))}
          </div>
          <p className="field-help">
            {t(work.includePublicApi ? 'deadCode.scopeLinePublic' : 'deadCode.scopeLine', {
              scope: work.scanScope || t('deadCode.entireProject'),
            })}{' '}
            {t('deadCode.scanFacts', {
              seconds: t('counts.seconds', {
                count: Number((Number(stats['durationMs']) / 1000).toFixed(1)),
              }),
              parsed: String(stats['parsedFiles'] ?? 0),
              tests: t('counts.testFiles', { count: Number(stats['testFiles'] ?? 0) }),
            })}
          </p>
          {Array.isArray(work.report['warnings']) && work.report['warnings'].length > 0 && (
            <details className="dead-code-warnings" open>
              <summary>{t('deadCode.warnings', { n: work.report['warnings'].length })}</summary>
              <ul>
                {work.report['warnings'].map((warning: unknown, i: number) => (
                  <li key={i}>{String(warning)}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="dead-code-filters">
            <label>
              <Search size={14} />
              <input
                aria-label={t('deadCode.search')}
                placeholder={t('deadCode.searchPlaceholder')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisible(100);
                }}
              />
            </label>
            <select
              aria-label={t('deadCode.categoryLabel')}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setVisible(100);
              }}
            >
              <option value="">{t('deadCode.allCategories')}</option>
              {deadCodeCategories.map((name) => (
                <option value={name} key={name}>
                  {`${label(name, true)} (${findings.filter((item) => item['category'] === name).length})`}
                </option>
              ))}
            </select>
            <select
              aria-label={t('deadCode.confidenceLabel')}
              value={confidence}
              onChange={(e) => {
                setConfidence(e.target.value);
                setVisible(100);
              }}
            >
              <option value="high">{t('deadCode.confidenceHigh')}</option>
              <option value="medium">{t('deadCode.confidenceMedium')}</option>
              <option value="low">{t('deadCode.confidenceAll')}</option>
            </select>
            <label className="dead-code-check">
              <input
                type="checkbox"
                checked={onlyFixable}
                onChange={(e) => setOnlyFixable(e.target.checked)}
              />
              {t('deadCode.onlyFixable')}
            </label>
          </div>
          <div className="dead-code-selection">
            <span>
              {t('deadCode.selection', {
                visible: t('deadCode.count.visible', { count: filtered.length }),
                selected: t('deadCode.count.selected', { count: selected.length }),
                fixable: t('deadCode.count.fixable', { count: fixable.length }),
              })}
            </span>
            <button
              type="button"
              className="button secondary small"
              disabled={!!work.busy}
              onClick={() =>
                toggle(
                  filtered.map((item) => String(item['id'])),
                  true,
                )
              }
            >
              {t('deadCode.selectFiltered')}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={!!work.busy || !selected.length}
              onClick={() => toggle(work.selected, false)}
            >
              {t('deadCode.clearSelection')}
            </button>
          </div>
          <div className="dead-code-findings">
            {filtered.slice(0, visible).map((item) => (
              <article key={String(item['id'])}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={t('deadCode.selectFinding', { id: item['id'] })}
                    disabled={!!work.busy}
                    checked={work.selected.includes(String(item['id']))}
                    onChange={(e) => toggle([String(item['id'])], e.target.checked)}
                  />
                  <strong>{String(item['name'] ?? item['file'])}</strong>
                  <span>{label(item['category'], true)}</span>
                  <small>
                    {sentenceStart(
                      t('deadCode.confidence', { level: label(item['confidence']) }),
                      i18n.language,
                    )}
                  </small>
                </label>
                <button
                  type="button"
                  className="dead-code-file-link"
                  onClick={() =>
                    onOpenFile(
                      String(item['file']),
                      typeof item['line'] === 'number' ? item['line'] : undefined,
                      typeof item['endLine'] === 'number' ? item['endLine'] : undefined,
                    )
                  }
                >
                  <FileCode2 size={13} />
                  {String(item['file'])}
                  {item['line']
                    ? `:${item['line']}${item['endLine'] && item['endLine'] !== item['line'] ? `–${item['endLine']}` : ''}`
                    : ''}
                </button>
                <p>{String(item['reason'] ?? '')}</p>
                <small>
                  {item['package'] ? `${t('deadCode.package', { name: item['package'] })} · ` : ''}
                  {label(item['kind'], true)}
                  {item['typeOnly'] === true ? ` · ${t('deadCode.typeOnly')}` : ''}
                </small>
                <p className="field-help">
                  {item['fix']
                    ? t('deadCode.mechanical', { action: label(item['fix']) })
                    : t('deadCode.manual', {
                        reason: item['manualReason'] ?? t('deadCode.noMechanical'),
                      })}
                </p>
              </article>
            ))}
            {!filtered.length && <p>{t('deadCode.noMatch')}</p>}
            {filtered.length > visible && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setVisible((old) => old + 100)}
              >
                {t('deadCode.showNext', { count: Math.min(100, filtered.length - visible) })}
              </button>
            )}
          </div>
          {selected.length > 0 && (
            <section className="dead-code-actions">
              <button
                type="button"
                className="button secondary"
                disabled={!!work.busy || !fixable.length}
                onClick={() => void preview()}
              >
                {t('deadCode.previewFixes')}
              </button>
              <label className="dead-code-check">
                <input
                  type="checkbox"
                  checked={verify}
                  disabled={!!work.busy}
                  onChange={(e) => setVerify(e.target.checked)}
                />
                {t('deadCode.verify')}
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!!work.busy || !work.plan || !entries(work.plan['changes']).length}
                onClick={() => setConfirm(true)}
              >
                {t('deadCode.reviewExecution')}
              </button>
              {confirm && (
                <div className="dead-code-confirm">
                  <h3>{t('deadCode.confirmTitle')}</h3>
                  <p>{verify ? t('deadCode.confirmVerify') : t('deadCode.confirmSkip')}</p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setConfirm(false)}
                  >
                    {t('deadCode.keepReviewing')}
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!!work.busy}
                    onClick={() => void apply()}
                  >
                    {t('deadCode.applyFixes')}
                  </button>
                </div>
              )}
            </section>
          )}
          {work.plan && <DeadCodePlan plan={work.plan} onOpenFile={onOpenFile} />}
          {selected.length > 0 && (
            <details className="dead-code-handoff">
              <summary>{t('deadCode.handoff')}</summary>
              <p>{t('deadCode.handoffHint')}</p>
              <CopyButton text={deadCodeRequest(selected)} label={t('deadCode.copy')} />
              {agents.length ? (
                <>
                  <select
                    aria-label={t('deadCode.target')}
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                  >
                    <option value="">{t('deadCode.chooseConversation')}</option>
                    {agents.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={handoff || !agents.some((item) => item.id === session)}
                    onClick={() => {
                      setHandoff(true);
                      void onPrepare(session, deadCodeRequest(selected))
                        .catch((e) => update({ error: String(e) }))
                        .finally(() => setHandoff(false));
                    }}
                  >
                    {t('deadCode.addToDraft')}
                  </button>
                </>
              ) : (
                <button type="button" className="button secondary" onClick={onNewSession}>
                  {t('deadCode.newConversation')}
                </button>
              )}
            </details>
          )}
        </>
      ) : (
        !work.busy && (
          <div className="dead-code-empty">
            <ScanSearch size={36} />
            <h2>{t('deadCode.emptyTitle')}</h2>
            <p>{t('deadCode.emptyHint')}</p>
          </div>
        )
      )}
      <section className="dead-code-backups" aria-label={t('deadCode.backupsLabel')}>
        <header>
          <h2>{t('deadCode.backups', { n: backups.length })}</h2>
          <button
            type="button"
            className="button secondary small"
            disabled={!!work.busy}
            onClick={() => void loadBackups()}
          >
            {t('deadCode.refreshBackups')}
          </button>
        </header>
        {backupError && <p role="alert">{backupError}</p>}
        {backups.map((backup) => (
          <article key={String(backup['id'])}>
            <div>
              <strong>{String(backup['createdAt'])}</strong>
              <p>
                {t('deadCode.backupFacts', {
                  files: t('counts.files', { count: Number(backup['files']) }),
                  findings: t('counts.findings', {
                    count: Array.isArray(backup['findingIds']) ? backup['findingIds'].length : 0,
                  }),
                })}
              </p>
              <small>{String(backup['id'])}</small>
            </div>
            <button
              type="button"
              className="button secondary small"
              disabled={!!work.busy}
              onClick={() => setUndo({ id: String(backup['id']), conflicts: [] })}
            >
              {t('deadCode.reviewRestore')}
            </button>
          </article>
        ))}
        {!backups.length && !backupError && <p>{t('deadCode.noBackups')}</p>}
        {undo && (
          <div className="dead-code-confirm">
            <h3>
              {undo.conflicts.length ? t('deadCode.conflictTitle') : t('deadCode.restoreTitle')}
            </h3>
            <p>{undo.conflicts.length ? t('deadCode.conflictBody') : t('deadCode.restoreBody')}</p>
            {undo.conflicts.length > 0 && (
              <ul>
                {undo.conflicts.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={!!work.busy}
              onClick={() => setUndo(null)}
            >
              {t('deadCode.keepFiles')}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!!work.busy}
              onClick={() => void restore(undo.id, undo.conflicts.length > 0)}
            >
              {undo.conflicts.length ? t('deadCode.overwrite') : t('deadCode.restore')}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
