import { Boxes, Download, FileCode2, RefreshCw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import type { EngineHttp } from './engine-http';
import { dateTimeText, entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { downloadSkillFile } from './skill-model';
import { TechDependencyDetail, TechFinding } from './TechStackEvidence';
import { TechStackRemediation } from './TechStackRemediation';
import { TechStackTrends } from './TechStackTrends';
import { techFilteredDependencies, techRunning, techSummary, techVersion } from './techstack-model';
import { techWord } from './techstack-text';
import { useTechStack } from './useTechStack';
import './project-techstack.css';

type View = 'dependencies' | 'workspaces' | 'findings' | 'trends' | 'remediation';
export function ProjectTechStack({
  http,
  projectId,
  events,
  onOpenFile,
}: {
  http: EngineHttp;
  projectId: string;
  events: Record<string, Record<string, unknown>>;
  onOpenFile: (path: string) => void;
}) {
  const { t, i18n } = useDesktopText();
  const word = (value: unknown) => techWord(value, t);
  const vm = useTechStack(http, projectId);
  const [view, setView] = useState<View>('dependencies');
  const [depth, setDepth] = useState('inventory');
  const [model, setModel] = useState('');
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');
  const [selected, setSelected] = useState('');
  const [findingSeverity, setFindingSeverity] = useState('');
  const [research, setResearch] = useState<
    Record<string, { findings: Record<string, unknown>[]; note: string }>
  >({});
  const [researching, setResearching] = useState('');
  const [report, setReport] = useState('');
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState('md');
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResearch({});
    setReport('');
    setResearching('');
  }, [vm.snapshot?.['id']]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const snapshot = vm.snapshot;
  const dependencies = entries(snapshot?.['dependencies']);
  const workspaces = entries(snapshot?.['workspaces']);
  const findings = entries(snapshot?.['findings']);
  const summary = techSummary(snapshot ?? {});
  const visible = techFilteredDependencies(snapshot ?? {}, query, workspace, status, scope);
  const detail = dependencies.find((item) => item['id'] === selected);
  const detailFindings = detail
    ? [
        ...findings.filter((item) => item['dependencyId'] === detail['id']),
        ...(research[selected]?.findings ?? []),
      ].filter(
        (item, index, rows) =>
          rows.findIndex((candidate) => candidate['id'] === item['id']) === index,
      )
    : [];
  const progress = record(vm.job?.['progress']);
  const failure = events['techstack.job.failed'];
  const canResearch = vm.models['available'] === true;
  const runResearch = async () => {
    if (!detail || researching) return;
    const own = generation.current,
      id = String(detail['id']);
    setResearching(id);
    vm.setError('');
    try {
      const data = record(
        await http(`/api/techstack/deps/${encodeURIComponent(id)}/research`, 'POST'),
      );
      if (own === generation.current)
        setResearch((old) => ({
          ...old,
          [id]: {
            findings: entries(data['findings']),
            note:
              data['cached'] === true ? t('techStack.cachedResearch') : t('techStack.researchDone'),
          },
        }));
    } catch (e) {
      if (own === generation.current) vm.setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (own === generation.current) setResearching('');
    }
  };
  const exportReport = async () => {
    if (!snapshot || exporting) return;
    const own = generation.current;
    setExporting(true);
    vm.setError('');
    try {
      const data = await http(
        `/api/techstack/reports/${encodeURIComponent(String(snapshot['id']))}?format=${format}`,
      );
      if (own !== generation.current) return;
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      if (format === 'md') setReport(text);
      else
        downloadSkillFile(
          text,
          `techstack-${format}-${String(snapshot['id'])
            .replace(/[^a-z0-9-]/gi, '')
            .slice(0, 80)}.json`,
          'application/json',
        );
    } catch (e) {
      if (own === generation.current) vm.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="project-techstack" aria-label={t('techStack.label')}>
      <header className="studio-heading">
        <div>
          <h1>TechStack</h1>
          <p>{t('techStack.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={vm.loading}
          onClick={() => void vm.reload()}
        >
          <RefreshCw size={14} />
          {t('techStack.refresh')}
        </button>
      </header>
      <div className="tech-analysis-controls">
        <label>
          {t('techStack.depth')}
          <select
            aria-label={t('techStack.depthLabel')}
            value={depth}
            disabled={vm.busy || techRunning(vm.job)}
            onChange={(e) => setDepth(e.target.value)}
          >
            <option value="inventory">{t('techStack.depthOption.inventory')}</option>
            <option value="enrich">{t('techStack.depthOption.enrich')}</option>
            <option value="full" disabled={!canResearch}>
              {t('techStack.depthOption.full')}
            </option>
          </select>
        </label>
        {depth === 'full' && (
          <label>
            {t('techStack.researchModel')}
            <select
              aria-label={t('techStack.researchModelLabel')}
              value={model || String(vm.models['model'] ?? '')}
              onChange={(e) => setModel(e.target.value)}
              disabled={vm.busy || techRunning(vm.job)}
            >
              {[
                ...new Set([
                  String(vm.models['model'] ?? ''),
                  ...entries(vm.models['candidates']).map((item) => String(item['id'])),
                ]),
              ]
                .filter(Boolean)
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="button primary"
          disabled={
            vm.loading || vm.busy || techRunning(vm.job) || (depth === 'full' && !canResearch)
          }
          onClick={() => void vm.start(depth, model || String(vm.models['model'] ?? ''))}
        >
          {depth === 'inventory' ? t('techStack.scan') : t('techStack.analyze')}
        </button>
      </div>
      {!canResearch && <p className="field-help">{t('techStack.noResearch')}</p>}
      {vm.error && (
        <p className="composer-error" role="alert">
          {vm.error}
        </p>
      )}
      {vm.job && (
        <section className="tech-job" aria-label={t('techStack.jobLabel')} role="status">
          <div>
            <strong>{word(vm.job['status'])}</strong>
            <span>
              {word(vm.job['depth'])}
              {vm.job['model'] ? ` · ${vm.job['model']}` : ''}
            </span>
            <small>
              {word(progress['phase'])}
              {typeof progress['completed'] === 'number' && typeof progress['total'] === 'number'
                ? ` · ${progress['completed']} / ${progress['total']}`
                : ''}
            </small>
            {typeof vm.job['error'] === 'string' && <p>{vm.job['error']}</p>}
            {failure &&
              failure['jobId'] === vm.job['id'] &&
              typeof failure['error'] === 'string' && <p>{failure['error']}</p>}
          </div>
          {Number(progress['total']) > 0 && (
            <progress
              aria-label={t('techStack.progress')}
              max={Number(progress['total'])}
              value={Number(progress['completed']) || 0}
            />
          )}
          {techRunning(vm.job) && (
            <button
              type="button"
              className="button secondary small"
              disabled={vm.busy}
              onClick={() => void vm.cancel()}
            >
              {t('techStack.cancel')}
            </button>
          )}
        </section>
      )}
      {vm.loading && !snapshot ? (
        <p role="status">{t('techStack.reading')}</p>
      ) : snapshot ? (
        <>
          <div className="tech-stats">
            {(
              [
                ['dependencies', summary.total],
                ['direct', summary.direct],
                ['workspaces', summary.workspaces],
                ['updates', summary.upgrades],
                ['vulnerable', summary.vulnerable],
                ['findings', summary.findings],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <small>{t(`techStack.stat.${label}`)}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="tech-snapshot-meta">
            <span>
              {t('techStack.observed', {
                at: dateTimeText(snapshot['createdAt'], i18n.language),
                coverage: word(snapshot['coverage']),
                adapter: String(snapshot['adapterVersion']),
              })}
            </span>
            {vm.stale && <strong>{t('techStack.stale')}</strong>}
            <small>{t('techStack.unreportedNote')}</small>
          </div>
          <nav className="tech-views" aria-label={t('techStack.views')}>
            {(['dependencies', 'workspaces', 'findings', 'trends', 'remediation'] as const).map(
              (name) => (
                <button
                  type="button"
                  key={name}
                  aria-current={view === name ? 'page' : undefined}
                  onClick={() => setView(name)}
                >
                  {t(`techStack.view.${name}`)}
                </button>
              ),
            )}
          </nav>
          {view === 'dependencies' ? (
            <>
              <div className="tech-filters">
                <label>
                  <Search size={14} />
                  <input
                    aria-label={t('techStack.search')}
                    placeholder={t('techStack.searchPlaceholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label={t('techStack.workspace')}
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                >
                  <option value="">{t('techStack.allWorkspaces')}</option>
                  {workspaces.map((item) => (
                    <option key={String(item['id'])} value={String(item['id'])}>
                      {String(item['relativeRoot'] || '.')} · {String(item['ecosystem'])}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t('techStack.status')}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">{t('techStack.allStatuses')}</option>
                  {[...new Set(dependencies.map((item) => String(item['status'])))]
                    .sort()
                    .map((name) => (
                      <option key={name} value={name}>
                        {word(name)}
                      </option>
                    ))}
                </select>
                <select
                  aria-label={t('techStack.relationship')}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">{t('techStack.both')}</option>
                  <option value="direct">{t('techStack.directOnly')}</option>
                  <option value="transitive">{t('techStack.transitiveOnly')}</option>
                </select>
              </div>
              <p className="field-help">
                {t('techStack.count', { visible: visible.length, total: dependencies.length })}
              </p>
              <div className="tech-dependencies-layout">
                <div className="tech-table-scroll">
                  <table className="tech-dependencies-table">
                    <thead>
                      <tr>
                        <th>{t('techStack.col.package')}</th>
                        <th>{t('techStack.col.observed')}</th>
                        <th>{t('techStack.col.latest')}</th>
                        <th>{t('techStack.col.status')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((item) => (
                        <tr key={String(item['id'])} aria-selected={selected === item['id']}>
                          <td>
                            <button type="button" onClick={() => setSelected(String(item['id']))}>
                              <strong>{String(item['name'])}</strong>
                              <small>
                                {String(item['ecosystem'])} ·{' '}
                                {item['direct'] === true
                                  ? t('techStack.directWord')
                                  : word('transitive')}{' '}
                                · {word(item['scope'])}
                              </small>
                            </button>
                          </td>
                          <td>{techVersion(item)}</td>
                          <td>{String(item['latestStable'] ?? t('techStack.notReported'))}</td>
                          <td>
                            <span className={`tech-status status-${item['status']}`}>
                              {word(item['status'])}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visible.length && <p>{t('techStack.noMatch')}</p>}
                </div>
                {detail ? (
                  <TechDependencyDetail
                    dependency={detail}
                    findings={detailFindings}
                    canResearch={canResearch}
                    researching={!!researching}
                    researchNote={research[selected]?.note ?? ''}
                    onResearch={() => void runResearch()}
                    onOpenFile={onOpenFile}
                  />
                ) : (
                  <div className="tech-empty">
                    <Boxes size={30} />
                    <h2>{t('techStack.emptyTitle')}</h2>
                    <p>{t('techStack.emptyBody')}</p>
                  </div>
                )}
              </div>
            </>
          ) : view === 'workspaces' ? (
            <div className="tech-workspaces">
              {workspaces.map((item) => (
                <article key={String(item['id'])}>
                  <header>
                    <h2>{String(item['relativeRoot'] || t('techStack.projectRoot'))}</h2>
                    <span>
                      {String(item['ecosystem'])} · {word(item['coverage'])}
                    </span>
                  </header>
                  <p>
                    {String(item['packageManager'] ?? t('techStack.noPackageManager'))} ·{' '}
                    {typeof item['confidence'] === 'number'
                      ? t('techStack.confidence', { percent: Math.round(item['confidence'] * 100) })
                      : ''}
                  </p>
                  <h3>{t('techStack.manifests')}</h3>
                  {['manifests', 'lockfiles']
                    .flatMap((key) => (Array.isArray(item[key]) ? (item[key] as string[]) : []))
                    .map((file, index) => (
                      <button
                        type="button"
                        className="button secondary small"
                        key={`${file}:${index}`}
                        onClick={() => onOpenFile(file)}
                      >
                        <FileCode2 size={13} />
                        {file}
                      </button>
                    ))}
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      setWorkspace(String(item['id']));
                      setView('dependencies');
                    }}
                  >
                    {t('techStack.inspectWorkspace')}
                  </button>
                </article>
              ))}
            </div>
          ) : view === 'findings' ? (
            <section>
              <header className="tech-section-heading">
                <h2>{t('techStack.findingsTitle')}</h2>
                <select
                  aria-label={t('techStack.severity')}
                  value={findingSeverity}
                  onChange={(e) => setFindingSeverity(e.target.value)}
                >
                  <option value="">{t('techStack.allSeverities')}</option>
                  {['critical', 'high', 'medium', 'low', 'info'].map((name) => (
                    <option key={name} value={name}>
                      {word(name)}
                    </option>
                  ))}
                </select>
              </header>
              {findings
                .filter((finding) => !findingSeverity || finding['severity'] === findingSeverity)
                .map((finding, index) => (
                  <div key={String(finding['id'] ?? index)}>
                    <button
                      type="button"
                      className="tech-finding-package"
                      onClick={() => {
                        setSelected(String(finding['dependencyId']));
                        setView('dependencies');
                      }}
                    >
                      {String(
                        dependencies.find((item) => item['id'] === finding['dependencyId'])?.[
                          'name'
                        ] ?? t('techStack.unknownDependency'),
                      )}
                    </button>
                    <TechFinding finding={finding} onOpenFile={onOpenFile} />
                  </div>
                ))}
              {!findings.length && <p>{t('techStack.noFindings')}</p>}
            </section>
          ) : view === 'trends' ? (
            <TechStackTrends http={http} snapshotId={String(snapshot['id'])} />
          ) : (
            <TechStackRemediation
              http={http}
              snapshotId={String(snapshot['id'])}
              onChanged={() => void vm.reload()}
            />
          )}
          <section className="tech-report-export">
            <h3>{t('techStack.reportsTitle')}</h3>
            <p>{t('techStack.reportsIntro')}</p>
            <div className="tech-analysis-controls">
              <select
                aria-label={t('techStack.format')}
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="md">{t('techStack.formatOption.md')}</option>
                <option value="json">{t('techStack.formatOption.json')}</option>
                <option value="spdx">{t('techStack.formatOption.spdx')}</option>
                <option value="cyclonedx">{t('techStack.formatOption.cyclonedx')}</option>
              </select>
              <button
                type="button"
                className="button secondary"
                disabled={exporting}
                onClick={() => void exportReport()}
              >
                <Download size={14} />
                {format === 'md' ? t('techStack.readReport') : t('techStack.exportReport')}
              </button>
            </div>
            {report && (
              <details open>
                <summary>{t('techStack.readable')}</summary>
                <CopyButton text={report} label={t('techStack.copyReport')} />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => downloadSkillFile(report, 'techstack-report.md', 'text/markdown')}
                >
                  {t('techStack.saveReport')}
                </button>
                <MarkdownContent text={report} />
              </details>
            )}
          </section>
        </>
      ) : (
        <div className="tech-empty">
          <Boxes size={40} />
          <h2>{t('techStack.startTitle')}</h2>
          <p>{t('techStack.startBody')}</p>
        </div>
      )}
    </section>
  );
}
