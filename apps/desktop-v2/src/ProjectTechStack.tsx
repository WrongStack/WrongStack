import { Boxes, Download, FileCode2, RefreshCw, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineHttp } from './engine-http';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { downloadSkillFile } from './skill-model';
import { TechDependencyDetail, TechFinding } from './TechStackEvidence';
import { TechStackRemediation } from './TechStackRemediation';
import { TechStackTrends } from './TechStackTrends';
import {
  techFilteredDependencies,
  techLabel,
  techRunning,
  techSummary,
  techVersion,
} from './techstack-model';
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
              data['cached'] === true
                ? 'Loaded cached research findings.'
                : 'Research completed for this dependency.',
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
    <section className="project-techstack" aria-label="Project TechStack workspace">
      <header className="studio-heading">
        <div>
          <h1>TechStack</h1>
          <p>See what the project uses, where versions come from, and what needs attention.</p>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={vm.loading}
          onClick={() => void vm.reload()}
        >
          <RefreshCw size={14} />
          Refresh TechStack
        </button>
      </header>
      <div className="tech-analysis-controls">
        <label>
          Analysis depth
          <select
            aria-label="TechStack analysis depth"
            value={depth}
            disabled={vm.busy || techRunning(vm.job)}
            onChange={(e) => setDepth(e.target.value)}
          >
            <option value="inventory">Local inventory · no network or model</option>
            <option value="enrich">Registry and advisory enrichment</option>
            <option value="full" disabled={!canResearch}>
              Enrichment and model research
            </option>
          </select>
        </label>
        {depth === 'full' && (
          <label>
            Research model
            <select
              aria-label="TechStack research model"
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
                  <option key={id}>{id}</option>
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
          {depth === 'inventory' ? 'Scan local dependencies' : 'Analyze dependencies'}
        </button>
      </div>
      {!canResearch && (
        <p className="field-help">
          Local inventory and registry enrichment are available. Connect a provider in WrongStack
          settings to enable model research.
        </p>
      )}
      {vm.error && (
        <p className="composer-error" role="alert">
          {vm.error}
        </p>
      )}
      {vm.job && (
        <section className="tech-job" aria-label="TechStack analysis job" role="status">
          <div>
            <strong>{techLabel(vm.job['status'])}</strong>
            <span>
              {techLabel(vm.job['depth'])}
              {vm.job['model'] ? ` · ${vm.job['model']}` : ''}
            </span>
            <small>
              {techLabel(progress['phase'])}
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
              aria-label="TechStack job progress"
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
              Cancel analysis
            </button>
          )}
        </section>
      )}
      {vm.loading && !snapshot ? (
        <p role="status">Reading the project dependency snapshot…</p>
      ) : snapshot ? (
        <>
          <div className="tech-stats">
            {[
              ['Dependencies', summary.total],
              ['Direct', summary.direct],
              ['Workspaces', summary.workspaces],
              ['Updates', summary.upgrades],
              ['Vulnerable', summary.vulnerable],
              ['Findings', summary.findings],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="tech-snapshot-meta">
            <span>
              Observed {String(snapshot['createdAt'])} · {techLabel(snapshot['coverage'])} coverage
              · adapter {String(snapshot['adapterVersion'])}
            </span>
            {vm.stale && (
              <strong>Snapshot is over 24 hours old. Scan again for current observations.</strong>
            )}
            <small>
              Missing registry versions and advisories are shown as unreported. Local inventory does
              not perform online checks.
            </small>
          </div>
          <nav className="tech-views" aria-label="TechStack views">
            {(['dependencies', 'workspaces', 'findings', 'trends', 'remediation'] as const).map(
              (name) => (
                <button
                  type="button"
                  key={name}
                  aria-current={view === name ? 'page' : undefined}
                  onClick={() => setView(name)}
                >
                  {name[0]!.toUpperCase() + name.slice(1)}
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
                    aria-label="Search dependencies"
                    placeholder="Find a package or version…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Dependency workspace"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                >
                  <option value="">All workspaces</option>
                  {workspaces.map((item) => (
                    <option key={String(item['id'])} value={String(item['id'])}>
                      {String(item['relativeRoot'] || '.')} · {String(item['ecosystem'])}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Dependency status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="">All statuses</option>
                  {[...new Set(dependencies.map((item) => String(item['status'])))]
                    .sort()
                    .map((name) => (
                      <option key={name} value={name}>
                        {techLabel(name)}
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Dependency relationship"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="">Direct and transitive</option>
                  <option value="direct">Direct only</option>
                  <option value="transitive">Transitive only</option>
                </select>
              </div>
              <p className="field-help">
                {visible.length} of {dependencies.length} observations
              </p>
              <div className="tech-dependencies-layout">
                <div className="tech-table-scroll">
                  <table className="tech-dependencies-table">
                    <thead>
                      <tr>
                        <th>Package</th>
                        <th>Observed</th>
                        <th>Latest stable</th>
                        <th>Status</th>
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
                                {item['direct'] === true ? 'direct' : 'transitive'} ·{' '}
                                {techLabel(item['scope'])}
                              </small>
                            </button>
                          </td>
                          <td>{techVersion(item)}</td>
                          <td>{String(item['latestStable'] ?? 'Not reported')}</td>
                          <td>
                            <span className={`tech-status status-${item['status']}`}>
                              {techLabel(item['status'])}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visible.length && <p>No dependencies match this view.</p>}
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
                    <h2>Every version has a source.</h2>
                    <p>
                      Select a package to inspect constraints, registry facts, findings and
                      evidence.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : view === 'workspaces' ? (
            <div className="tech-workspaces">
              {workspaces.map((item) => (
                <article key={String(item['id'])}>
                  <header>
                    <h2>{String(item['relativeRoot'] || 'Project root')}</h2>
                    <span>
                      {String(item['ecosystem'])} · {techLabel(item['coverage'])}
                    </span>
                  </header>
                  <p>
                    {String(item['packageManager'] ?? 'Package manager not reported')} ·{' '}
                    {typeof item['confidence'] === 'number'
                      ? `${Math.round(item['confidence'] * 100)}% detection confidence`
                      : ''}
                  </p>
                  <h3>Manifests and lockfiles</h3>
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
                    Inspect workspace dependencies
                  </button>
                </article>
              ))}
            </div>
          ) : view === 'findings' ? (
            <section>
              <header className="tech-section-heading">
                <h2>Findings and their sources</h2>
                <select
                  aria-label="Finding severity"
                  value={findingSeverity}
                  onChange={(e) => setFindingSeverity(e.target.value)}
                >
                  <option value="">All severities</option>
                  {['critical', 'high', 'medium', 'low', 'info'].map((name) => (
                    <option key={name}>{name}</option>
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
                        ] ?? 'Unknown dependency',
                      )}
                    </button>
                    <TechFinding finding={finding} onOpenFile={onOpenFile} />
                  </div>
                ))}
              {!findings.length && <p>No findings in this snapshot.</p>}
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
            <h3>Reports and software bill of materials</h3>
            <p>Reports use the selected saved snapshot and retain its observations and evidence.</p>
            <div className="tech-analysis-controls">
              <select
                aria-label="TechStack report format"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="md">Readable Markdown report</option>
                <option value="json">Complete JSON report</option>
                <option value="spdx">SPDX SBOM</option>
                <option value="cyclonedx">CycloneDX SBOM</option>
              </select>
              <button
                type="button"
                className="button secondary"
                disabled={exporting}
                onClick={() => void exportReport()}
              >
                <Download size={14} />
                {format === 'md' ? 'Read report' : 'Export report'}
              </button>
            </div>
            {report && (
              <details open>
                <summary>Readable report</summary>
                <CopyButton text={report} label="Copy TechStack Markdown report" />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => downloadSkillFile(report, 'techstack-report.md', 'text/markdown')}
                >
                  Save Markdown report
                </button>
                <MarkdownContent text={report} />
              </details>
            )}
          </section>
        </>
      ) : (
        <div className="tech-empty">
          <Boxes size={40} />
          <h2>Start with what is actually in the project.</h2>
          <p>
            Scan manifests and lockfiles locally, then choose registry enrichment or model research
            when needed.
          </p>
        </div>
      )}
    </section>
  );
}
