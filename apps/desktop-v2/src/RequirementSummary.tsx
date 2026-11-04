import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import { isVibeIntake, readable, strings, text } from './requirement-values';

/** A requirement's original request, summary, recorded fields and lists. */
export function RequirementSummary({ detail }: { detail: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const original = text(detail['originalRequest']);
  const summary = text(detail['normalizedSummary']);
  return (
    <>
      <h4 className="requirement-original-heading">
        {t('req.original')} <CopyButton text={original} label={t('req.summary.originalCopy')} />
      </h4>
      <p className="requirement-original">{original}</p>
      {summary && summary !== original && (
        <>
          <h4>{t('req.summary.summary')}</h4>
          <p>{summary}</p>
        </>
      )}
      <dl className="requirement-metadata">
        {[
          [t('req.summary.businessGoal'), text(detail['businessGoal'])],
          [t('req.summary.expectedOutcome'), text(detail['expectedOutcome'])],
          [t('req.summary.scope'), text(detail['scopeNotes'])],
          [t('req.summary.requestedBy'), text(detail['requestedBy'])],
          [
            t('req.summary.priority'),
            text(detail['priority'])
              ? t(`req.priority.${text(detail['priority'])}`, {
                  defaultValue: readable(detail['priority']),
                })
              : t('req.notReported'),
          ],
          [
            t('req.summary.protocol'),
            isVibeIntake(detail) ? t('req.summary.vibe') : t('req.summary.standard'),
          ],
        ].map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value || t('req.notRecorded')}</dd>
          </div>
        ))}
      </dl>
      {[
        [t('req.summary.targetUsers'), detail['targetUsers']],
        [t('req.summary.constraints'), detail['constraints']],
        [t('req.summary.providedContext'), detail['providedContext']],
      ].map(
        ([name, value]) =>
          strings(value).length > 0 && (
            <div key={String(name)}>
              <h4>{String(name)}</h4>
              <ul>
                {strings(value).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ),
      )}
    </>
  );
}
