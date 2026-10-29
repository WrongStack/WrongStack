import { entries, record } from './engine-values';

export interface CompactionOutcome {
  before: number;
  after: number;
  saved: number;
  request: { before: number; after: number } | null;
  reductions: { phase: string; saved: number }[];
  quality: { ok: boolean; issues: string[] } | null;
  digest: string;
  digestTruncated: boolean;
}

/** A `context.compacted` reply; null when it is not one (e.g. an operation result). */
export function compactionOutcome(value: Record<string, unknown>): CompactionOutcome | null {
  if (typeof value['before'] !== 'number' || typeof value['after'] !== 'number') return null;
  const quality = record(value['quality']);
  return {
    before: value['before'],
    after: value['after'],
    saved: Number(value['saved'] ?? Math.max(0, value['before'] - value['after'])),
    request:
      typeof value['fullRequestTokensBefore'] === 'number' &&
      typeof value['fullRequestTokensAfter'] === 'number'
        ? { before: value['fullRequestTokensBefore'], after: value['fullRequestTokensAfter'] }
        : null,
    reductions: entries(value['reductions']).flatMap((row) =>
      typeof row['phase'] === 'string' && typeof row['saved'] === 'number'
        ? [{ phase: row['phase'], saved: row['saved'] }]
        : [],
    ),
    quality:
      typeof quality['ok'] === 'boolean'
        ? {
            ok: quality['ok'],
            issues: Array.isArray(quality['issues']) ? quality['issues'].map(String) : [],
          }
        : null,
    digest: typeof value['digest'] === 'string' ? value['digest'] : '',
    digestTruncated: value['digestTruncated'] === true,
  };
}

export const reductionLabels: Record<string, string> = {
  elision: 'Old tool output replaced with receipts',
  summary: 'Older turns summarized',
  selective: 'Turns selected and collapsed',
};
