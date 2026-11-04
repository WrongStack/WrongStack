import { FileCode2, Sparkles } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-values';
import { techInterpretation, techVersion } from './techstack-model';
import { techWord } from './techstack-text';

export function TechEvidence({
  items,
  onOpenFile,
}: {
  items: Record<string, unknown>[];
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  return items.length ? (
    <ul className="tech-evidence">
      {items.map((item, index) => (
        <li key={index}>
          <header>
            <strong>{techWord(item['kind'], t)}</strong>
            <time>{String(item['retrievedAt'] ?? '')}</time>
          </header>
          {['manifest', 'lockfile'].includes(String(item['kind'])) ? (
            <button
              type="button"
              className="button secondary small"
              onClick={() => onOpenFile(String(item['source']))}
            >
              <FileCode2 size={13} />
              {String(item['source'])}
            </button>
          ) : /^https?:\/\//.test(String(item['source'])) ? (
            <a href={String(item['source'])} target="_blank" rel="noreferrer">
              {String(item['source'])}
            </a>
          ) : (
            <span>{String(item['source'] ?? '')}</span>
          )}
          {typeof item['detail'] === 'string' && <p>{item['detail']}</p>}
        </li>
      ))}
    </ul>
  ) : (
    <p className="field-help">{t('techDetail.noEvidence')}</p>
  );
}
export function TechFinding({
  finding,
  onOpenFile,
}: {
  finding: Record<string, unknown>;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  return (
    <article className={`tech-finding severity-${finding['severity']}`}>
      <header>
        <strong>{techWord(finding['type'], t)}</strong>
        <span>
          {techWord(finding['severity'], t)} · {techWord(finding['action'], t)}
        </span>
      </header>
      {techInterpretation(finding) && (
        <small>
          <Sparkles size={12} />
          {t('techDetail.interpretation')} ·{' '}
          {typeof finding['confidence'] === 'number'
            ? t('techDetail.confidence', { percent: Math.round(finding['confidence'] * 100) })
            : t('techDetail.noConfidence')}
        </small>
      )}
      <p>{String(finding['rationale'] ?? '')}</p>
      {typeof finding['breakingRisk'] === 'string' && (
        <p className="tech-breaking-risk">
          {t('techDetail.breakingRisk', { risk: finding['breakingRisk'] })}
        </p>
      )}
      <details>
        <summary>
          {t('techDetail.findingEvidence', { number: entries(finding['evidence']).length })}
        </summary>
        <TechEvidence items={entries(finding['evidence'])} onOpenFile={onOpenFile} />
      </details>
    </article>
  );
}
export function TechDependencyDetail({
  dependency,
  findings,
  canResearch,
  researching,
  researchNote,
  onResearch,
  onOpenFile,
}: {
  dependency: Record<string, unknown>;
  findings: Record<string, unknown>[];
  canResearch: boolean;
  researching: boolean;
  researchNote: string;
  onResearch: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const missing = t('techDetail.notReported');
  return (
    <article className="tech-dependency-detail" aria-label={t('techDetail.label')}>
      <header>
        <span className="eyebrow">
          {String(dependency['ecosystem'])} ·{' '}
          {dependency['direct'] === true ? t('techDetail.direct') : t('techDetail.transitive')} ·{' '}
          {techWord(dependency['scope'], t)}
        </span>
        <h2>{String(dependency['name'])}</h2>
        <span className={`tech-status status-${dependency['status']}`}>
          {techWord(dependency['status'], t)}
        </span>
        <p>
          {techVersion(dependency)}
          {dependency['latestStable'] && dependency['latestStable'] !== techVersion(dependency)
            ? ` → ${dependency['latestStable']}`
            : ''}
        </p>
      </header>
      <dl className="tech-version-grid">
        {(
          [
            'requested',
            'locked',
            'installed',
            'wanted',
            'resolvable',
            'latestStable',
            'license',
            'purl',
            'sourceType',
          ] as const
        ).map((key) => (
          <div key={key}>
            <dt>{t(`techDetail.field.${key}`)}</dt>
            <dd>{String(dependency[key] ?? missing)}</dd>
          </div>
        ))}
        <div>
          <dt>{t('techDetail.flags')}</dt>
          <dd>
            {[
              dependency['deprecated'] === true && t('techDetail.deprecated'),
              dependency['yanked'] === true && t('techDetail.yanked'),
            ]
              .filter(Boolean)
              .join(', ') ||
              (dependency['deprecated'] === false || dependency['yanked'] === false
                ? t('techDetail.noFlags')
                : missing)}
          </dd>
        </div>
      </dl>
      <section>
        <header className="tech-section-heading">
          <h3>{t('techDetail.findings', { number: findings.length })}</h3>
          <button
            type="button"
            className="button secondary small"
            disabled={!canResearch || researching}
            onClick={onResearch}
          >
            <Sparkles size={13} />
            {researching ? t('techDetail.researching') : t('techDetail.research')}
          </button>
        </header>
        {!canResearch && <p className="field-help">{t('techDetail.connectModel')}</p>}
        {researchNote && <p role="status">{researchNote}</p>}
        {findings.map((finding, index) => (
          <TechFinding
            key={String(finding['id'] ?? index)}
            finding={finding}
            onOpenFile={onOpenFile}
          />
        ))}
        {!findings.length && <p>{t('techDetail.noFindings')}</p>}
      </section>
      <section>
        <h3>{t('techDetail.evidence')}</h3>
        <TechEvidence items={entries(dependency['evidence'])} onOpenFile={onOpenFile} />
      </section>
    </article>
  );
}
