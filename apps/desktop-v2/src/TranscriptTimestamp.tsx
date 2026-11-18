import { useDesktopText } from './desktop-i18n';
import { displayDateTime, displayTime, timestampDate } from './display-dates';
import './transcript-timestamp.css';

/** Real recorded time only: old journals and invalid timestamps never become “now”. */
export function TranscriptTimestamp({ value }: { value: unknown }) {
  useDesktopText();
  const date = timestampDate(value);
  if (!date) return null;
  return (
    <time
      dateTime={date.toISOString()}
      title={displayDateTime(date)}
      className="transcript-timestamp"
    >
      {displayTime(date)}
    </time>
  );
}
