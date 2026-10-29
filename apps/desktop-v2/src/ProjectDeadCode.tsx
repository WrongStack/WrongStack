import { FileCode2, RefreshCw, ScanSearch, Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CopyButton } from './CopyButton';
import { DeadCodePlan, DeadCodeResult } from './DeadCodePlan';
import {
  deadCodeCategories,
  deadCodeLabel,
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
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-values';
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
    if (!beginDeadCodeWork(projectId, 'Scanning the project…')) return;
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
    if (!ids.length || !beginDeadCodeWork(projectId, 'Preparing the change preview…')) return;
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
    if (
      !work.plan ||
      !ids.length ||
      !beginDeadCodeWork(projectId, 'Applying cleanup and waiting for verification…')
    )
      return;
    setConfirm(false);
    try {
      const fresh = record(await http('/api/deadcode/preview', 'POST', { ids }));
      if (!sameDeadCodePlan(work.plan, fresh)) {
        update({ plan: fresh });
        throw Error('The preview changed. Review the new changes before applying.');
      }
      const result = record(
        await http('/api/deadcode/apply', 'POST', { ids, verify: verify ? 'typecheck' : 'none' }),
      );
      update({
        result,
        plan: null,
        selected: result['ok'] === true ? [] : work.selected,
        notice:
          result['rolledBack'] === true
            ? 'Verification failed; the engine rolled back the changes.'
            : 'The engine returned the cleanup result below.',
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
    if (!beginDeadCodeWork(projectId, 'Restoring the selected backup…')) return;
    try {
      const result = record(await http('/api/deadcode/undo', 'POST', { backupId: id, force }));
      const conflicts = Array.isArray(result['conflicts']) ? result['conflicts'].map(String) : [];
      const restored = Array.isArray(result['restored']) ? result['restored'].map(String) : [];
      const outcome = deadCodeRestoreOutcome(restored, conflicts);
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
    <section className="project-dead-code" aria-label="Project dead-code workspace">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">REVIEW FIRST, CLEAN UP WITH EVIDENCE</span>
          <h1>
            Dead Code<span className="heading-dot">.</span>
          </h1>
          <p>Inspect reachability, review exact diffs, verify changes and keep a path back.</p>
        </div>
        <ScanSearch size={30} />
      </header>
      <fieldset className="dead-code-scan-controls" disabled={!!work.busy}>
        <label>
          Report scope
          <input
            aria-label="Dead-code report scope"
            placeholder="All files, or comma-separated relative paths"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <small>Analysis stays project-wide. Paths filter the reported findings.</small>
        </label>
        <label className="dead-code-check">
          <input
            type="checkbox"
            checked={publicApi}
            onChange={(e) => setPublicApi(e.target.checked)}
          />
          Include unused public API exports
        </label>
        <button type="button" className="button primary" onClick={() => void scan()}>
          <RefreshCw size={14} />
          {work.report ? 'Rescan dead code' : 'Scan dead code'}
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
              ['Files', stats['files']],
              ['Entry points', stats['entryFiles']],
              ['Reachable', stats['reachableFiles']],
              ['Findings', findings.length],
              ['Mechanical fixes', findings.filter((item) => item['fix']).length],
              ['Cache hits', stats['cachedFiles']],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <small>{String(label)}</small>
                <strong>{String(value ?? 0)}</strong>
              </div>
            ))}
          </div>
          <p className="field-help">
            Showing {work.scanScope || 'the entire project'}
            {work.includePublicApi ? ' including unused public API exports' : ''}.{' '}
            {(Number(stats['durationMs']) / 1000).toFixed(1)} seconds ·{' '}
            {String(stats['parsedFiles'] ?? 0)} parsed · {String(stats['testFiles'] ?? 0)} test
            files
          </p>
          {Array.isArray(work.report['warnings']) && work.report['warnings'].length > 0 && (
            <details className="dead-code-warnings" open>
              <summary>Scan limitations ({work.report['warnings'].length})</summary>
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
                aria-label="Search dead-code findings"
                placeholder="Find a file, symbol or package…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setVisible(100);
                }}
              />
            </label>
            <select
              aria-label="Dead-code category"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setVisible(100);
              }}
            >
              <option value="">All categories</option>
              {deadCodeCategories.map((name) => (
                <option value={name} key={name}>
                  {deadCodeLabel(name)} (
                  {findings.filter((item) => item['category'] === name).length})
                </option>
              ))}
            </select>
            <select
              aria-label="Dead-code confidence"
              value={confidence}
              onChange={(e) => {
                setConfidence(e.target.value);
                setVisible(100);
              }}
            >
              <option value="high">High confidence only</option>
              <option value="medium">High and medium confidence</option>
              <option value="low">All confidence levels</option>
            </select>
            <label className="dead-code-check">
              <input
                type="checkbox"
                checked={onlyFixable}
                onChange={(e) => setOnlyFixable(e.target.checked)}
              />
              Mechanical fixes only
            </label>
          </div>
          <div className="dead-code-selection">
            <span>
              {filtered.length} visible findings · {selected.length} selected · {fixable.length}{' '}
              mechanically fixable
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
              Select filtered findings
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={!!work.busy || !selected.length}
              onClick={() => toggle(work.selected, false)}
            >
              Clear selection
            </button>
          </div>
          <div className="dead-code-findings">
            {filtered.slice(0, visible).map((item) => (
              <article key={String(item['id'])}>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Select finding ${item['id']}`}
                    disabled={!!work.busy}
                    checked={work.selected.includes(String(item['id']))}
                    onChange={(e) => toggle([String(item['id'])], e.target.checked)}
                  />
                  <strong>{String(item['name'] ?? item['file'])}</strong>
                  <span>{deadCodeLabel(item['category'])}</span>
                  <small>{deadCodeLabel(item['confidence'])} confidence</small>
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
                    ? `:${item['line']}${item['endLine'] ? `–${item['endLine']}` : ''}`
                    : ''}
                </button>
                <p>{String(item['reason'] ?? '')}</p>
                <small>
                  {item['package'] ? `Package ${item['package']} · ` : ''}
                  {deadCodeLabel(item['kind'])}
                  {item['typeOnly'] === true ? ' · type only' : ''}
                </small>
                <p className="field-help">
                  {item['fix']
                    ? `Mechanical action: ${deadCodeLabel(item['fix'])}`
                    : `Manual review: ${item['manualReason'] ?? 'no mechanical fix available'}`}
                </p>
              </article>
            ))}
            {!filtered.length && <p>No findings match this view.</p>}
            {filtered.length > visible && (
              <button
                type="button"
                className="button secondary"
                onClick={() => setVisible((old) => old + 100)}
              >
                Show next {Math.min(100, filtered.length - visible)} findings
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
                Preview selected fixes
              </button>
              <label className="dead-code-check">
                <input
                  type="checkbox"
                  checked={verify}
                  disabled={!!work.busy}
                  onChange={(e) => setVerify(e.target.checked)}
                />
                Run typecheck and roll back failed changes
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!!work.busy || !work.plan || !entries(work.plan['changes']).length}
                onClick={() => setConfirm(true)}
              >
                Review cleanup execution
              </button>
              {confirm && (
                <div className="dead-code-confirm">
                  <h3>Apply the reviewed cleanup?</h3>
                  <p>
                    The engine re-scans before changing files, creates a backup and{' '}
                    {verify
                      ? 'verifies the result with typecheck.'
                      : 'will skip typecheck as selected.'}
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setConfirm(false)}
                  >
                    Keep reviewing changes
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!!work.busy}
                    onClick={() => void apply()}
                  >
                    Apply reviewed fixes
                  </button>
                </div>
              )}
            </section>
          )}
          {work.plan && <DeadCodePlan plan={work.plan} onOpenFile={onOpenFile} />}
          {selected.length > 0 && (
            <details className="dead-code-handoff">
              <summary>Review selected findings with an agent</summary>
              <p>The request is added to a draft for review. It is not sent automatically.</p>
              <CopyButton
                text={deadCodeRequest(selected)}
                label="Copy selected dead-code findings"
              />
              {agents.length ? (
                <>
                  <select
                    aria-label="Dead-code target conversation"
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
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
                    disabled={handoff || !agents.some((item) => item.id === session)}
                    onClick={() => {
                      setHandoff(true);
                      void onPrepare(session, deadCodeRequest(selected))
                        .catch((e) => update({ error: String(e) }))
                        .finally(() => setHandoff(false));
                    }}
                  >
                    Add findings to conversation draft
                  </button>
                </>
              ) : (
                <button type="button" className="button secondary" onClick={onNewSession}>
                  Create a project conversation
                </button>
              )}
            </details>
          )}
        </>
      ) : (
        !work.busy && (
          <div className="dead-code-empty">
            <ScanSearch size={36} />
            <h2>Find the code your project no longer reaches.</h2>
            <p>
              Start a scan to inspect findings and their confidence before selecting any changes.
            </p>
          </div>
        )
      )}
      <section className="dead-code-backups" aria-label="Dead-code backups">
        <header>
          <h2>Recovery backups ({backups.length})</h2>
          <button
            type="button"
            className="button secondary small"
            disabled={!!work.busy}
            onClick={() => void loadBackups()}
          >
            Refresh cleanup backups
          </button>
        </header>
        {backupError && <p role="alert">{backupError}</p>}
        {backups.map((backup) => (
          <article key={String(backup['id'])}>
            <div>
              <strong>{String(backup['createdAt'])}</strong>
              <p>
                {String(backup['files'])} files ·{' '}
                {Array.isArray(backup['findingIds']) ? backup['findingIds'].length : 0} findings
              </p>
              <small>{String(backup['id'])}</small>
            </div>
            <button
              type="button"
              className="button secondary small"
              disabled={!!work.busy}
              onClick={() => setUndo({ id: String(backup['id']), conflicts: [] })}
            >
              Review restore backup
            </button>
          </article>
        ))}
        {!backups.length && !backupError && <p>No cleanup backups recorded.</p>}
        {undo && (
          <div className="dead-code-confirm">
            <h3>
              {undo.conflicts.length
                ? 'Files changed after cleanup'
                : 'Restore this cleanup backup?'}
            </h3>
            <p>
              {undo.conflicts.length
                ? 'Restoring with overwrite replaces the newer content in the following files.'
                : 'The engine restores backed-up files when their current contents match the cleanup result.'}
            </p>
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
              Keep current files
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!!work.busy}
              onClick={() => void restore(undo.id, undo.conflicts.length > 0)}
            >
              {undo.conflicts.length
                ? 'Overwrite conflicts from backup'
                : 'Restore selected cleanup backup'}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
