import { FileCode2 } from 'lucide-react';
import { useState } from 'react';
import { reviewFindingTransitions, reviewLabel } from './chimera-model';
import { useDesktopText } from './desktop-i18n';
import { entries, record, sentenceStart } from './engine-values';
import { MarkdownContent } from './MarkdownContent';

export function ReviewTimeline({ events }: { events: Record<string, unknown>[] }) {
  const { t, i18n } = useDesktopText();
  // Engine values are named per language; unknown ones read as reviewLabel shows them.
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? sentenceStart(
          t(`reviews.value.${value}`, { defaultValue: reviewLabel(value) }),
          i18n.language,
        )
      : t('reviews.notReported');
  const [visible, setVisible] = useState(40);
  const ordered = [...events].reverse();
  return (
    <div className="review-timeline">
      {ordered.slice(0, visible).map((event, index) => (
        <article key={String(event['id'] ?? index)}>
          <header>
            <strong>{named(event['eventType'])}</strong>
            <time>{String(event['timestamp'] ?? '')}</time>
          </header>
          <small>
            {String(event['actorId'] ?? t('reviews.notReported'))} · {named(event['actorKind'])}
          </small>
          {event['toLifecycle'] || event['toStatus'] ? (
            <p>
              {named(event['fromLifecycle'] ?? event['fromStatus'])} →{' '}
              {named(event['toLifecycle'] ?? event['toStatus'])}
            </p>
          ) : null}
          {typeof event['reason'] === 'string' && (
            <p className="review-event-reason">{event['reason']}</p>
          )}
        </article>
      ))}
      {!ordered.length && <p>{t('reviews.noJournal')}</p>}
      {ordered.length > visible && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => setVisible((old) => old + 40)}
        >
          {t('reviews.olderEntries')}
        </button>
      )}
    </div>
  );
}
export function ChimeraFinding({
  row,
  busy,
  onTransition,
  onOpenFile,
}: {
  row: Record<string, unknown>;
  busy: boolean;
  onTransition: (finding: Record<string, unknown>, to: string) => void;
  onOpenFile: (path: string, line?: number) => void;
}) {
  const { t, i18n } = useDesktopText();
  // Engine values are named per language; unknown ones read as reviewLabel shows them.
  const named = (value: unknown) =>
    typeof value === 'string' && value
      ? sentenceStart(
          t(`reviews.value.${value}`, { defaultValue: reviewLabel(value) }),
          i18n.language,
        )
      : t('reviews.notReported');
  const finding = record(row['finding']),
    location = record(finding['location']),
    verification = record(finding['verification']),
    resolution = record(finding['resolution']);
  return (
    <article
      className={`review-finding review-severity-${finding['severity']}`}
      aria-label={String(finding['title'] ?? t('reviews.finding'))}
    >
      <header>
        <div className="review-finding-tags">
          <span>{named(finding['severity'])}</span>
          <span>{named(finding['status'])}</span>
          {typeof finding['category'] === 'string' && (
            <span>{reviewLabel(finding['category'])}</span>
          )}
          {typeof finding['confidence'] === 'string' && (
            <span>{t('reviews.confidence', { level: named(finding['confidence']) })}</span>
          )}
        </div>
        <small>{named(finding['source'])}</small>
      </header>
      <h3>{String(finding['title'])}</h3>
      {typeof location['file'] === 'string' && (
        <button
          type="button"
          className="review-file-link"
          onClick={() =>
            onOpenFile(
              String(location['file']),
              typeof location['line'] === 'number' ? location['line'] : undefined,
            )
          }
        >
          <FileCode2 size={13} />
          {location['file']}
          {typeof location['line'] === 'number' ? `:${location['line']}` : ''}
        </button>
      )}
      <MarkdownContent text={String(finding['description'] ?? '')} />
      {typeof finding['suggestedFix'] === 'string' && (
        <details>
          <summary>{t('reviews.suggested')}</summary>
          <MarkdownContent text={finding['suggestedFix']} />
        </details>
      )}
      <section className="review-citation">
        <strong>{t('reviews.citation', { status: named(verification['status']) })}</strong>
        <p>{reviewLabel(verification['reason'])}</p>
        {typeof verification['evidence'] === 'string' && <code>{verification['evidence']}</code>}
      </section>
      {Object.keys(resolution).length > 0 && (
        <section className="review-resolution">
          <strong>{t('reviews.recordedOutcome', { outcome: named(resolution['outcome']) })}</strong>
          <p>
            {String(resolution['resolvedBy'] ?? '')} · {String(resolution['resolvedAt'] ?? '')}
          </p>
          {typeof resolution['notes'] === 'string' && <p>{resolution['notes']}</p>}
          {typeof resolution['commitSha'] === 'string' && <code>{resolution['commitSha']}</code>}
        </section>
      )}
      <div className="review-finding-actions">
        {(reviewFindingTransitions[String(finding['status'])] ?? []).map((to) => (
          <button
            type="button"
            key={to}
            className="button secondary small"
            disabled={busy}
            onClick={() => onTransition(finding, to)}
          >
            {to === 'active'
              ? t('reviews.reopenFinding')
              : to === 'resolved'
                ? t('reviews.resolveFinding')
                : to === 'ignored'
                  ? t('reviews.ignoreFinding')
                  : to === 'triaged'
                    ? t('reviews.triageFinding')
                    : t('reviews.startFinding')}
          </button>
        ))}
      </div>
      <details>
        <summary>{t('reviews.history', { n: entries(row['events']).length })}</summary>
        <ReviewTimeline events={entries(row['events'])} />
      </details>
      <small className="review-record-id">
        {t('reviews.findingId', { id: String(finding['id']) })}
      </small>
    </article>
  );
}
