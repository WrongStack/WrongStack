import type { SessionSummary } from '../types/session.js';

export interface SessionFilterCriteria {
  since?: string | undefined;
  until?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  minTokens?: number | undefined;
  titleContains?: string | undefined;
}

export function compareSessionSummaries(a: SessionSummary, b: SessionSummary): number {
  const aActivity = a.lastActivityAt ?? a.endedAt ?? a.startedAt;
  const bActivity = b.lastActivityAt ?? b.endedAt ?? b.startedAt;
  if (aActivity < bActivity) return 1;
  if (aActivity > bActivity) return -1;
  if (a.startedAt < b.startedAt) return 1;
  if (a.startedAt > b.startedAt) return -1;
  return a.id.localeCompare(b.id);
}

export function matchesSessionFilter(
  summary: SessionSummary,
  criteria: SessionFilterCriteria,
): boolean {
  if (criteria.since && summary.startedAt < criteria.since) return false;
  if (criteria.until && summary.startedAt > criteria.until) return false;
  if (criteria.provider && summary.provider !== criteria.provider) return false;
  if (criteria.model && summary.model !== criteria.model) return false;
  if (criteria.minTokens !== undefined && summary.tokenTotal < criteria.minTokens) return false;
  if (criteria.titleContains) {
    const needle = criteria.titleContains.toLocaleLowerCase();
    if (!summary.title.toLocaleLowerCase().includes(needle)) return false;
  }
  return true;
}
