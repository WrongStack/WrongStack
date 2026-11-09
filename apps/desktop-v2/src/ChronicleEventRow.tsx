import { ArrowRight } from 'lucide-react';
import { eventHeadline, eventTitle } from './chronicle-model';
import { useDesktopText } from './desktop-i18n';
import { displayDate, displayTime } from './display-dates';
import { record } from './engine-values';

export function ChronicleEventRow({
  event,
  selected,
  outcomeLabel,
  onSelect,
}: {
  event: Record<string, unknown>;
  selected: boolean;
  outcomeLabel: string;
  onSelect: () => void;
}) {
  const { t } = useDesktopText();
  const resource = record(event['resource']),
    scope = record(event['scope']),
    runtime = record(event['runtime']);
  const headline = eventHeadline(event);
  return (
    <button
      type="button"
      aria-label={t('chronicleView.inspect', { title: eventTitle(event) })}
      className={selected ? 'chronicle-event-selected' : ''}
      onClick={onSelect}
    >
      <span className={`chronicle-outcome outcome-${String(event['outcome'] ?? 'unknown')}`} />
      <time dateTime={String(event['occurredAt'])}>
        {displayTime(String(event['occurredAt']))}
        <small>{displayDate(String(event['occurredAt']))}</small>
      </time>
      <div>
        {headline.type && <span>{headline.type}</span>}
        <strong>{headline.title}</strong>
        <small>
          {String(
            resource['path'] ??
              resource['id'] ??
              runtime['modelId'] ??
              scope['agentId'] ??
              t('chronicleView.projectEvent'),
          )}
        </small>
      </div>
      <span className="chronicle-event-result">{outcomeLabel}</span>
      <ArrowRight size={13} />
    </button>
  );
}
