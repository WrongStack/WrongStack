import type {
  HistoryRetention,
  RequestResidency,
  RetentionClass,
} from '@wrongstack/core/utils/residency-labels';
import { RETENTION_CLASSES } from '@wrongstack/core/utils/residency-labels';
import { entries, record } from './engine-values';

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * The last request's cache layout from `context.debug`, or null when none was recorded or the
 * shape is not one this view understands (it is then not drawn rather than drawn wrongly).
 */
export function requestResidency(value: unknown): RequestResidency | null {
  const raw = record(value);
  const segments = entries(raw['segments']);
  if (
    !finite(raw['total']) ||
    typeof raw['verdict'] !== 'string' ||
    !segments.length ||
    !segments.every(
      (segment) =>
        typeof segment['kind'] === 'string' &&
        typeof segment['lane'] === 'string' &&
        finite(segment['tokens']),
    )
  )
    return null;
  return raw as unknown as RequestResidency;
}

/** What the next compaction keeps, or null when unavailable. */
export function historyRetention(value: unknown): HistoryRetention | null {
  const raw = record(value);
  const classes = record(raw['classes']);
  if (
    !finite(raw['total']) ||
    !RETENTION_CLASSES.every((name) => finite(record(classes[name])['tokens']))
  )
    return null;
  return raw as unknown as HistoryRetention;
}

/** Retention classes that hold anything, in display order. */
export function retentionRows(retention: HistoryRetention) {
  return RETENTION_CLASSES.map((name: RetentionClass) => ({
    name,
    ...retention.classes[name],
  })).filter((row) => row.messages > 0 || row.tokens > 0);
}

/** Share of `part` in `whole` as a whole percentage, 0 when there is nothing to divide. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
