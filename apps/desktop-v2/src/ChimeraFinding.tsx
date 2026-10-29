import { FileCode2 } from 'lucide-react';
import { useState } from 'react';
import { reviewFindingTransitions, reviewLabel } from './chimera-model';
import { entries, record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';

export function ReviewTimeline({ events }: { events: Record<string, unknown>[] }) {
  const [visible, setVisible] = useState(40);
  const ordered = [...events].reverse();
  return (
    <div className="review-timeline">
      {ordered.slice(0, visible).map((event, index) => (
        <article key={String(event['id'] ?? index)}>
          <header>
            <strong>{reviewLabel(event['eventType'])}</strong>
            <time>{String(event['timestamp'] ?? '')}</time>
          </header>
          <small>
            {String(event['actorId'] ?? 'Not reported')} · {reviewLabel(event['actorKind'])}
          </small>
          {event['toLifecycle'] || event['toStatus'] ? (
            <p>
              {reviewLabel(event['fromLifecycle'] ?? event['fromStatus'])} →{' '}
              {reviewLabel(event['toLifecycle'] ?? event['toStatus'])}
            </p>
          ) : null}
          {typeof event['reason'] === 'string' && (
            <p className="review-event-reason">{event['reason']}</p>
          )}
        </article>
      ))}
      {!ordered.length && <p>No journal entries recorded.</p>}
      {ordered.length > visible && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => setVisible((old) => old + 40)}
        >
          Show older journal entries
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
  const finding = record(row['finding']),
    location = record(finding['location']),
    verification = record(finding['verification']),
    resolution = record(finding['resolution']);
  return (
    <article
      className={`review-finding review-severity-${finding['severity']}`}
      aria-label={String(finding['title'] ?? 'Review finding')}
    >
      <header>
        <div className="review-finding-tags">
          <span>{reviewLabel(finding['severity'])}</span>
          <span>{reviewLabel(finding['status'])}</span>
          {typeof finding['category'] === 'string' && (
            <span>{reviewLabel(finding['category'])}</span>
          )}
          {typeof finding['confidence'] === 'string' && (
            <span>{reviewLabel(finding['confidence'])} reviewer confidence</span>
          )}
        </div>
        <small>{reviewLabel(finding['source'])}</small>
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
          <summary>Reviewer’s suggested change</summary>
          <MarkdownContent text={finding['suggestedFix']} />
        </details>
      )}
      <section className="review-citation">
        <strong>Disk citation: {reviewLabel(verification['status'])}</strong>
        <p>{reviewLabel(verification['reason'])}</p>
        {typeof verification['evidence'] === 'string' && <code>{verification['evidence']}</code>}
      </section>
      {Object.keys(resolution).length > 0 && (
        <section className="review-resolution">
          <strong>Recorded outcome: {reviewLabel(resolution['outcome'])}</strong>
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
              ? 'Reopen finding'
              : to === 'resolved'
                ? 'Record resolution'
                : to === 'ignored'
                  ? 'Ignore finding'
                  : to === 'triaged'
                    ? 'Mark triaged'
                    : 'Start finding work'}
          </button>
        ))}
      </div>
      <details>
        <summary>Finding history ({entries(row['events']).length})</summary>
        <ReviewTimeline events={entries(row['events'])} />
      </details>
      <small className="review-record-id">Finding {String(finding['id'])}</small>
    </article>
  );
}
