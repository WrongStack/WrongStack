import { FileText } from 'lucide-react';
import { designReviewResult } from './design-review-result';
import { useDesktopText } from './desktop-i18n';
import { displayCount, displayDateTime, displayLocale } from './display-dates';
import type { ActivityRow } from './session-activity-model';
import './design-flow.css';

export function DesignReviewCard({
  row,
  projectRoot,
  onOpenFile,
}: {
  row: ActivityRow;
  projectRoot?: string | null | undefined;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useDesktopText();
  const result = designReviewResult(row, projectRoot);
  if (!result) return null;

  const { action, target, reference, path, viewports, fails, warns, score } = result;
  const title = t(`designReview.${action}`);
  const metrics =
    fails !== undefined && warns !== undefined
      ? t('designReview.findings', { fails: displayCount(fails), warns: displayCount(warns) })
      : score !== undefined
        ? t('designReview.fidelity', {
            score: score.toLocaleString(displayLocale(), { style: 'percent' }),
          })
        : t('designReview.unavailable');
  const time = row.finishedAt === undefined ? undefined : new Date(row.finishedAt);
  return (
    <section className="design-extraction-card design-review-card" aria-label={title}>
      <header>
        <strong>{title}</strong>
        {time && <time dateTime={time.toISOString()}>{displayDateTime(time)}</time>}
      </header>
      <dl>
        {target && (
          <div>
            <dt>{t('designReview.target')}</dt>
            <dd>{target}</dd>
          </div>
        )}
        {reference && (
          <div>
            <dt>{t('designReview.reference')}</dt>
            <dd>{reference}</dd>
          </div>
        )}
        {viewports !== undefined && (
          <div>
            <dt>{t('designReview.widths')}</dt>
            <dd>{viewports ? `${viewports} px` : t('designReview.noSharedWidths')}</dd>
          </div>
        )}
      </dl>
      {row.status === 'done' ? (
        <strong className="design-review-metrics" data-failed={fails !== undefined && fails > 0}>
          {metrics}
        </strong>
      ) : (
        <small>{t(`runLog.status.${row.status === 'info' ? 'recorded' : row.status}`)}</small>
      )}
      {path && (
        <div className="design-extraction-artifact">
          <code title={path}>{path}</code>
          <div className="design-flow-actions">
            <button
              type="button"
              className="button secondary small"
              onClick={() => onOpenFile(path)}
            >
              <FileText size={14} aria-hidden="true" /> {t('designReview.openReport')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
